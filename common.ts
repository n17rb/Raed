import type { PoolClient } from 'pg';
import { pool, query, queryOne, type Queryable } from '../db/pool';
import { emitToAdmins, emitToUser } from '../realtime/io';
import { logError } from '../lib/logger';
import { getSetting } from '../settings/service';
import { notifyUser } from '../notifications/service';
import { getTripView, type Viewer } from './views';

export async function insertTripEvent(
  db: Queryable,
  tripId: string,
  eventType: string,
  actorId: string | null,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await query(
    db,
    'INSERT INTO trip_events (trip_id, event_type, actor_id, payload) VALUES ($1, $2, $3, $4::jsonb)',
    [tripId, eventType, actorId, JSON.stringify(payload)]
  );
}

/**
 * Closes the money side of a trip that ended without completion:
 * releases a reserved promo and finalizes the fare with only the fee (if any).
 */
export async function releaseTripHolds(client: PoolClient, tripId: string, feeFils: number): Promise<void> {
  await query(
    client,
    `UPDATE promo_redemptions SET status = 'RELEASED' WHERE trip_id = $1 AND status = 'RESERVED'`,
    [tripId]
  );
  await query(
    client,
    `UPDATE trip_fares
     SET discount_fils = 0, cancellation_fee_fils = $2, total_fils = $2,
         platform_commission_fils = 0, captain_earning_fils = $2, finalized_at = now()
     WHERE trip_id = $1 AND finalized_at IS NULL`,
    [tripId, feeFils]
  );
}

export async function tripViewFor(tripId: string, viewer: Viewer) {
  const support = await getSetting('support').catch(() => null);
  return getTripView(pool, tripId, viewer, { whatsappAllowed: support?.allowCaptainCustomerWhatsapp ?? true });
}

export interface TripPush {
  customer?: { title: string; body: string } | null;
  captain?: { title: string; body: string } | null;
}

/** Sends each participant their own view of the trip, plus optional push notifications. */
export async function emitTripUpdate(
  tripId: string,
  event: string,
  extra: Record<string, unknown> = {},
  push: TripPush = {}
): Promise<void> {
  try {
    const row = await queryOne<{ customer_id: string; captain_id: string | null; status: string }>(
      pool,
      'SELECT customer_id, captain_id, status FROM trips WHERE id = $1',
      [tripId]
    );
    if (!row) return;

    const customerView = await tripViewFor(tripId, { app: 'CUSTOMER', userId: row.customer_id });
    emitToUser(row.customer_id, event, { ...extra, trip: customerView });

    if (row.captain_id) {
      const captainView = await tripViewFor(tripId, { app: 'CAPTAIN', userId: row.captain_id });
      emitToUser(row.captain_id, event, { ...extra, trip: captainView });
    }
    emitToAdmins('trip:update', { tripId, status: row.status, event });

    if (push.customer) {
      void notifyUser(row.customer_id, {
        ...push.customer,
        data: { type: 'TRIP_UPDATE', tripId, status: row.status },
        app: 'CUSTOMER',
        channelId: 'trip-updates',
      });
    }
    if (push.captain && row.captain_id) {
      void notifyUser(row.captain_id, {
        ...push.captain,
        data: { type: 'TRIP_UPDATE', tripId, status: row.status },
        app: 'CAPTAIN',
        channelId: 'trip-updates',
      });
    }
  } catch (error) {
    logError('trip realtime emit failed', error, { tripId, event });
  }
}
