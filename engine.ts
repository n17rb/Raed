import { pool, query, queryOne, withTransaction } from '../db/pool';
import { AppError, Errors } from '../lib/errors';
import { logError } from '../lib/logger';
import { getSetting } from '../settings/service';
import { emitToAdmins, emitToUser } from '../realtime/io';
import { formatJod } from '../pricing/pricing';
import { setEtaBase } from '../maps/eta';
import { notifyUser } from '../notifications/service';
import { emitTripUpdate, insertTripEvent, releaseTripHolds, tripViewFor } from '../trips/common';

/** Every this many seconds of searching, the next (wider) radius step is allowed. */
const RADIUS_STEP_INTERVAL_S = 8;

const CANDIDATE_SQL = `
  SELECT c.user_id AS captain_id, v.id AS vehicle_id,
         round(ST_Distance(c.current_location, $1::geography))::int AS distance_m
  FROM captains c
  JOIN users u ON u.id = c.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
  JOIN vehicles v ON v.id = c.active_vehicle_id AND v.status = 'APPROVED' AND v.deleted_at IS NULL
  JOIN wallets w ON w.owner_user_id = c.user_id AND w.owner_type = 'CAPTAIN'
  WHERE c.availability = 'ONLINE'
    AND c.status = 'APPROVED'
    AND c.location_updated_at > now() - interval '90 seconds'
    AND v.category_id = $2
    AND w.balance_fils >= -w.negative_limit_fils
    AND ST_DWithin(c.current_location, $1::geography, $3)
    AND NOT EXISTS (SELECT 1 FROM trip_dispatch_offers po WHERE po.captain_id = c.user_id AND po.response = 'PENDING')
    AND NOT EXISTS (SELECT 1 FROM trip_dispatch_offers prev WHERE prev.trip_id = $4 AND prev.captain_id = c.user_id)
  ORDER BY c.current_location <-> $1::geography
  LIMIT 1
  FOR UPDATE OF c SKIP LOCKED
`;

type OfferOutcome =
  | { kind: 'offered'; offerId: string; captainId: string; customerId: string }
  | { kind: 'none' }
  | { kind: 'skipped' }
  | { kind: 'gave_up'; customerId: string };

/**
 * Offers a SEARCHING trip to the nearest suitable captain, one captain at a time.
 * The search radius widens with time: 2 km, then 4, 7, 10 km (from app settings).
 * The search runs inside PostgreSQL/PostGIS (GiST index), never in JavaScript.
 */
export async function offerNext(tripId: string): Promise<void> {
  const settings = await getSetting('dispatch');
  const radii = [...new Set([settings.initialRadiusM, ...settings.radiusStepsM])].sort((a, b) => a - b);

  const outcome = await withTransaction<OfferOutcome>(async (client) => {
    const trip = await queryOne<{
      status: string;
      customer_id: string;
      category_id: string;
      searching_at: Date | null;
      pickup: string;
    }>(
      client,
      `SELECT status, customer_id, category_id, searching_at, pickup_location AS pickup
       FROM trips WHERE id = $1 FOR UPDATE`,
      [tripId]
    );
    if (!trip || trip.status !== 'SEARCHING') return { kind: 'skipped' };

    const pending = await queryOne<{ one: number }>(
      client,
      `SELECT 1 AS one FROM trip_dispatch_offers WHERE trip_id = $1 AND response = 'PENDING'`,
      [tripId]
    );
    if (pending) return { kind: 'skipped' };

    const offersMade =
      (await queryOne<{ count: number }>(client, 'SELECT count(*)::int AS count FROM trip_dispatch_offers WHERE trip_id = $1', [tripId]))
        ?.count ?? 0;
    const searchingForS = trip.searching_at ? (Date.now() - trip.searching_at.getTime()) / 1000 : 0;

    if (offersMade >= settings.maxOffersPerTrip || searchingForS >= settings.maxSearchDurationS) {
      await client.query(`SELECT set_config('rayed.transition_reason', 'NO_CAPTAIN_FOUND', true)`);
      await query(
        client,
        `UPDATE trips SET status = 'CANCELLED', cancelled_by_role = 'SYSTEM', cancel_reason = 'NO_CAPTAIN_FOUND'
         WHERE id = $1`,
        [tripId]
      );
      await releaseTripHolds(client, tripId, 0);
      await insertTripEvent(client, tripId, 'NO_CAPTAIN_FOUND', null, {
        offersMade,
        searchedSeconds: Math.round(searchingForS),
      });
      return { kind: 'gave_up', customerId: trip.customer_id };
    }

    const stepIndex = Math.min(radii.length - 1, Math.floor(searchingForS / RADIUS_STEP_INTERVAL_S));
    const radius = radii[stepIndex] ?? settings.initialRadiusM;

    const candidate = await queryOne<{ captain_id: string; vehicle_id: string; distance_m: number }>(client, CANDIDATE_SQL, [
      trip.pickup,
      trip.category_id,
      radius,
      tripId,
    ]);
    if (!candidate) {
      await query(client, 'UPDATE trips SET search_radius_m = $2 WHERE id = $1', [tripId, radius]);
      return { kind: 'none' };
    }

    const offer = await queryOne<{ id: string }>(
      client,
      `INSERT INTO trip_dispatch_offers (trip_id, captain_id, distance_m, search_radius_m, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING id`,
      [tripId, candidate.captain_id, candidate.distance_m, radius, settings.offerTimeoutS]
    );
    if (!offer) throw new Error('Failed to create dispatch offer');

    await client.query(`SELECT set_config('rayed.transition_reason', 'OFFER_SENT', true)`);
    await query(
      client,
      `UPDATE trips
       SET status = 'DRIVER_ASSIGNED', captain_id = $2, vehicle_id = $3,
           search_radius_m = $4, search_attempts = search_attempts + 1
       WHERE id = $1`,
      [tripId, candidate.captain_id, candidate.vehicle_id, radius]
    );
    await insertTripEvent(client, tripId, 'OFFER_SENT', null, {
      offerId: offer.id,
      captainId: candidate.captain_id,
      distanceM: candidate.distance_m,
      radiusM: radius,
    });
    return { kind: 'offered', offerId: offer.id, captainId: candidate.captain_id, customerId: trip.customer_id };
  });

  if (outcome.kind === 'offered') {
    const offerView = await getOfferView(outcome.offerId);
    if (offerView) {
      emitToUser(outcome.captainId, 'trip:request', offerView);
      void notifyUser(outcome.captainId, {
        title: 'طلب رحلة جديد',
        body: `${offerView.pickup.address} ← ${offerView.dropoff.address} · ${offerView.fareDisplay ?? ''} د.أ`,
        data: { type: 'TRIP_REQUEST', offerId: offerView.offerId, tripId },
        app: 'CAPTAIN',
        channelId: 'trip-requests',
        ttlSeconds: offerView.secondsLeft,
      });
    }
    emitToAdmins('trip:update', { tripId, status: 'DRIVER_ASSIGNED', event: 'OFFER_SENT' });
  } else if (outcome.kind === 'gave_up') {
    await emitTripUpdate(
      tripId,
      'trip:cancelled',
      {
        cancelledBy: 'SYSTEM',
        reason: 'NO_CAPTAIN_FOUND',
        message: 'لم نجد كابتن متاحًا الآن، حاول مرة أخرى بعد قليل',
      },
      { customer: { title: 'لم نجد كابتن متاحًا', body: 'حاول مرة أخرى بعد قليل' } }
    );
  }
}

export async function getOfferView(offerId: string) {
  const row = await queryOne<{
    id: string;
    trip_id: string;
    captain_id: string;
    response: string;
    expires_at: Date;
    distance_m: number;
    pickup_address: string;
    pickup_lat: number;
    pickup_lng: number;
    dropoff_address: string;
    dropoff_lat: number;
    dropoff_lng: number;
    estimated_distance_m: number | null;
    estimated_duration_s: number | null;
    estimated_fare_fils: number | null;
    category_name: string;
    customer_name: string | null;
    customer_rating: string;
  }>(
    pool,
    `SELECT o.id, o.trip_id, o.captain_id, o.response, o.expires_at, o.distance_m,
            t.pickup_address, ST_Y(t.pickup_location::geometry) AS pickup_lat, ST_X(t.pickup_location::geometry) AS pickup_lng,
            t.dropoff_address, ST_Y(t.dropoff_location::geometry) AS dropoff_lat, ST_X(t.dropoff_location::geometry) AS dropoff_lng,
            t.estimated_distance_m, t.estimated_duration_s, t.estimated_fare_fils,
            vc.name_ar AS category_name, u.full_name AS customer_name, cs.rating_avg AS customer_rating
     FROM trip_dispatch_offers o
     JOIN trips t ON t.id = o.trip_id
     JOIN vehicle_categories vc ON vc.id = t.category_id
     JOIN users u ON u.id = t.customer_id
     JOIN customers cs ON cs.user_id = t.customer_id
     WHERE o.id = $1`,
    [offerId]
  );
  if (!row) return null;

  return {
    offerId: row.id,
    tripId: row.trip_id,
    status: row.response,
    expiresAt: row.expires_at,
    secondsLeft: Math.max(0, Math.round((row.expires_at.getTime() - Date.now()) / 1000)),
    distanceToPickupM: row.distance_m,
    pickup: { lat: row.pickup_lat, lng: row.pickup_lng, address: row.pickup_address },
    dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, address: row.dropoff_address },
    tripDistanceM: row.estimated_distance_m,
    tripDurationS: row.estimated_duration_s,
    fareFils: row.estimated_fare_fils,
    fareDisplay: row.estimated_fare_fils === null ? null : formatJod(row.estimated_fare_fils),
    category: row.category_name,
    customer: {
      firstName: (row.customer_name ?? '').split(' ')[0] || null,
      rating: Number(row.customer_rating),
    },
  };
}

export async function getCurrentOffer(captainId: string) {
  const row = await queryOne<{ id: string }>(
    pool,
    `SELECT id FROM trip_dispatch_offers
     WHERE captain_id = $1 AND response = 'PENDING' AND expires_at > now()
     LIMIT 1`,
    [captainId]
  );
  return row ? getOfferView(row.id) : null;
}

/**
 * Accepting is one atomic transaction: the offer row and trip row are locked, and
 * the unique index "one active trip per captain" makes a double accept impossible.
 */
export async function acceptOffer(captainId: string, offerId: string) {
  const accepted = await withTransaction(
    async (client) => {
      const offer = await queryOne<{ trip_id: string; captain_id: string; response: string; expires_at: Date }>(
        client,
        'SELECT trip_id, captain_id, response, expires_at FROM trip_dispatch_offers WHERE id = $1 FOR UPDATE',
        [offerId]
      );
      if (!offer || offer.captain_id !== captainId) throw Errors.notFound('الطلب غير موجود');
      if (offer.response !== 'PENDING') throw new AppError(409, 'OFFER_NOT_AVAILABLE', 'الطلب لم يعد متاحًا');
      if (offer.expires_at.getTime() <= Date.now()) throw new AppError(409, 'OFFER_EXPIRED', 'انتهت مهلة قبول الطلب');

      const trip = await queryOne<{
        status: string;
        captain_id: string | null;
        customer_id: string;
        pickup_lat: number;
        pickup_lng: number;
      }>(
        client,
        `SELECT status, captain_id, customer_id,
                ST_Y(pickup_location::geometry) AS pickup_lat, ST_X(pickup_location::geometry) AS pickup_lng
         FROM trips WHERE id = $1 FOR UPDATE`,
        [offer.trip_id]
      );
      if (!trip || trip.status !== 'DRIVER_ASSIGNED' || trip.captain_id !== captainId) {
        throw new AppError(409, 'OFFER_NOT_AVAILABLE', 'الطلب لم يعد متاحًا');
      }

      await query(client, `UPDATE trip_dispatch_offers SET response = 'ACCEPTED', responded_at = now() WHERE id = $1`, [offerId]);
      await query(client, `UPDATE trips SET status = 'DRIVER_ACCEPTED' WHERE id = $1`, [offer.trip_id]);
      await query(client, `UPDATE trips SET status = 'DRIVER_ARRIVING' WHERE id = $1`, [offer.trip_id]);

      const captain = await queryOne<{ lat: number | null; lng: number | null }>(
        client,
        `UPDATE captains SET availability = 'ON_TRIP', offers_accepted = offers_accepted + 1
         WHERE user_id = $1
         RETURNING ST_Y(current_location::geometry) AS lat, ST_X(current_location::geometry) AS lng`,
        [captainId]
      );
      await query(
        client,
        `INSERT INTO chat_rooms (trip_id, customer_id, captain_id) VALUES ($1, $2, $3) ON CONFLICT (trip_id) DO NOTHING`,
        [offer.trip_id, trip.customer_id, captainId]
      );
      await insertTripEvent(client, offer.trip_id, 'CAPTAIN_ACCEPTED', captainId, { offerId });

      return {
        tripId: offer.trip_id,
        pickup: { lat: trip.pickup_lat, lng: trip.pickup_lng },
        captainLocation: captain && captain.lat !== null && captain.lng !== null ? { lat: captain.lat, lng: captain.lng } : null,
      };
    },
    { actorId: captainId, reason: 'CAPTAIN_ACCEPTED' }
  );

  let etaSeconds: number | null = null;
  let approachPolyline: string | null = null;
  if (accepted.captainLocation) {
    const eta = await setEtaBase(accepted.tripId, 'PICKUP', accepted.captainLocation, accepted.pickup).catch(() => null);
    etaSeconds = eta?.etaSeconds ?? null;
    approachPolyline = eta?.polyline ?? null;
  }

  const minutes = etaSeconds === null ? null : Math.max(1, Math.round(etaSeconds / 60));
  await emitTripUpdate(
    accepted.tripId,
    'trip:accepted',
    { etaSeconds, approachPolyline },
    {
      customer: {
        title: 'الكابتن في الطريق إليك',
        body: minutes === null ? 'تم قبول رحلتك' : `الوصول خلال ${minutes} دقائق`,
      },
    }
  );

  const view = await tripViewFor(accepted.tripId, { app: 'CAPTAIN', userId: captainId });
  return { trip: view, etaSeconds, approachPolyline };
}

export async function rejectOffer(captainId: string, offerId: string) {
  const tripId = await withTransaction(
    async (client) => {
      const offer = await queryOne<{ trip_id: string; captain_id: string; response: string }>(
        client,
        'SELECT trip_id, captain_id, response FROM trip_dispatch_offers WHERE id = $1 FOR UPDATE',
        [offerId]
      );
      if (!offer || offer.captain_id !== captainId) throw Errors.notFound('الطلب غير موجود');
      if (offer.response !== 'PENDING') return null;

      await query(client, `UPDATE trip_dispatch_offers SET response = 'REJECTED', responded_at = now() WHERE id = $1`, [offerId]);
      await query(
        client,
        `UPDATE trips SET status = 'SEARCHING' WHERE id = $1 AND status = 'DRIVER_ASSIGNED' AND captain_id = $2`,
        [offer.trip_id, captainId]
      );
      await query(client, 'UPDATE captains SET offers_rejected = offers_rejected + 1 WHERE user_id = $1', [captainId]);
      await insertTripEvent(client, offer.trip_id, 'CAPTAIN_REJECTED', captainId, { offerId });
      return offer.trip_id;
    },
    { actorId: captainId, reason: 'CAPTAIN_REJECTED' }
  );

  if (tripId) await offerNext(tripId).catch((error) => logError('redispatch failed', error, { tripId }));
  return { ok: true };
}

/** Expires unanswered offers and keeps searching trips moving. Safe with several API instances. */
export async function dispatchSweep(): Promise<void> {
  const expired = await withTransaction(
    async (client) => {
      const offers = await query<{ id: string; trip_id: string; captain_id: string }>(
        client,
        `SELECT id, trip_id, captain_id FROM trip_dispatch_offers
         WHERE response = 'PENDING' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT 50
         FOR UPDATE SKIP LOCKED`
      );
      for (const offer of offers) {
        await query(client, `UPDATE trip_dispatch_offers SET response = 'EXPIRED', responded_at = now() WHERE id = $1`, [offer.id]);
        await query(
          client,
          `UPDATE trips SET status = 'SEARCHING' WHERE id = $1 AND status = 'DRIVER_ASSIGNED' AND captain_id = $2`,
          [offer.trip_id, offer.captain_id]
        );
        await query(client, 'UPDATE captains SET offers_rejected = offers_rejected + 1 WHERE user_id = $1', [offer.captain_id]);
      }
      return offers;
    },
    { reason: 'OFFER_EXPIRED' }
  );

  for (const offer of expired) {
    emitToUser(offer.captain_id, 'trip:offer_expired', { offerId: offer.id, tripId: offer.trip_id });
  }

  const searching = await query<{ id: string }>(
    pool,
    `SELECT t.id FROM trips t
     WHERE t.status = 'SEARCHING'
       AND NOT EXISTS (SELECT 1 FROM trip_dispatch_offers o WHERE o.trip_id = t.id AND o.response = 'PENDING')
     ORDER BY t.requested_at
     LIMIT 100`
  );
  for (const trip of searching) {
    await offerNext(trip.id).catch((error) => logError('dispatch retry failed', error, { tripId: trip.id }));
  }
}
