import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { AppError, Errors } from '../../lib/errors';
import { likeEscape, pageOffset, pageQuerySchema, paged } from '../../lib/pagination';
import { formatJod } from '../../pricing/pricing';
import { requirePermission, getAdminPermissions } from '../../auth/guards';
import { audit, auditContext } from '../../audit/audit';
import { emitToUser } from '../../realtime/io';
import { clearEta } from '../../maps/eta';
import { ACTIVE_STATUSES, TRIP_STATUSES, type TripStatus } from '../../trips/state-machine';
import { emitTripUpdate, insertTripEvent, releaseTripHolds, tripViewFor } from '../../trips/common';

const idParams = z.object({ id: z.string().uuid() });

export const adminTripRoutes: FastifyPluginAsync = async (app) => {
  app.get('/trips', { preHandler: requirePermission('trips.view') }, async (request) => {
    const params = parseInput(
      pageQuerySchema.extend({
        status: z.enum(TRIP_STATUSES).optional(),
        active: z.enum(['true', 'false']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        customerId: z.string().uuid().optional(),
        captainId: z.string().uuid().optional(),
      }),
      request.query
    );
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const args = [
      q,
      params.status ?? null,
      params.active === 'true' ? [...ACTIVE_STATUSES] : null,
      params.from ?? null,
      params.to ?? null,
      params.customerId ?? null,
      params.captainId ?? null,
    ];
    const where = `WHERE ($1::text IS NULL OR t.code ILIKE $1 OR cu.full_name ILIKE $1 OR cu.phone ILIKE $1 OR cap.full_name ILIKE $1 OR cap.phone ILIKE $1)
      AND ($2::text IS NULL OR t.status = $2)
      AND ($3::text[] IS NULL OR t.status = ANY($3::text[]))
      AND ($4::date IS NULL OR (t.requested_at AT TIME ZONE 'Asia/Amman')::date >= $4::date)
      AND ($5::date IS NULL OR (t.requested_at AT TIME ZONE 'Asia/Amman')::date <= $5::date)
      AND ($6::uuid IS NULL OR t.customer_id = $6)
      AND ($7::uuid IS NULL OR t.captain_id = $7)`;
    const from = `FROM trips t JOIN users cu ON cu.id = t.customer_id LEFT JOIN users cap ON cap.id = t.captain_id
                  JOIN vehicle_categories vc ON vc.id = t.category_id`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count ${from} ${where}`, args);
    const rows = await query<{
      id: string;
      code: string;
      status: TripStatus;
      customer_name: string | null;
      customer_phone: string | null;
      captain_name: string | null;
      category: string;
      pickup_address: string;
      dropoff_address: string;
      fare: number | null;
      requested_at: Date;
    }>(
      pool,
      `SELECT t.id, t.code, t.status, cu.full_name AS customer_name, cu.phone AS customer_phone, cap.full_name AS captain_name,
              vc.name_ar AS category, t.pickup_address, t.dropoff_address,
              COALESCE(t.final_fare_fils, t.estimated_fare_fils) AS fare, t.requested_at
       ${from} ${where}
       ORDER BY t.requested_at DESC LIMIT $8 OFFSET $9`,
      [...args, limit, offset]
    );
    return paged(
      rows.map((row) => ({ ...row, fareDisplay: row.fare === null ? null : formatJod(row.fare) })),
      total?.count ?? 0,
      params
    );
  });

  app.get('/trips/:id', { preHandler: requirePermission('trips.view') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const view = await tripViewFor(id, { app: 'ADMIN', userId: request.auth?.userId ?? '' });
    if (!view) throw Errors.notFound('الرحلة غير موجودة');
    const [history, events, offers, fare] = await Promise.all([
      query(pool, `SELECT from_status AS "from", to_status AS "to", reason, changed_by AS "changedBy", created_at AS "at" FROM trip_status_history WHERE trip_id = $1 ORDER BY id`, [id]),
      query(pool, `SELECT event_type AS type, actor_id AS "actorId", payload, created_at AS "at" FROM trip_events WHERE trip_id = $1 ORDER BY id`, [id]),
      query(
        pool,
        `SELECT o.id, o.captain_id AS "captainId", u.full_name AS "captainName", o.distance_m AS "distanceM", o.search_radius_m AS "radiusM",
                o.response, o.offered_at AS "offeredAt", o.responded_at AS "respondedAt"
         FROM trip_dispatch_offers o JOIN users u ON u.id = o.captain_id WHERE o.trip_id = $1 ORDER BY o.offered_at`,
        [id]
      ),
      queryOne(pool, 'SELECT * FROM trip_fares WHERE trip_id = $1', [id]),
    ]);
    const permissions = await getAdminPermissions(request.auth?.userId ?? '');
    const chat = permissions.has('chats.view')
      ? await query(
          pool,
          `SELECT m.id, m.sender_id AS "senderId", u.full_name AS "senderName", m.body, m.delivered_at AS "deliveredAt", m.read_at AS "readAt", m.created_at AS "createdAt"
           FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id JOIN users u ON u.id = m.sender_id
           WHERE r.trip_id = $1 ORDER BY m.created_at`,
          [id]
        )
      : null;
    if (chat && chat.length > 0) await audit(pool, auditContext(request), 'CHAT_VIEWED', 'trip', id, undefined, undefined);
    const path = await query<{ lat: number; lng: number }>(
      pool,
      `SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM trip_locations WHERE trip_id = $1 ORDER BY recorded_at LIMIT 5000`,
      [id]
    );
    return { trip: view, history, events, offers, fare, chat, path };
  });

  app.post('/trips/:id/cancel', { preHandler: requirePermission('trips.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ reason: z.string().trim().min(2).max(300) }), request.body);
    const ctx = auditContext(request);
    const result = await withTransaction(
      async (client) => {
        const trip = await queryOne<{ status: TripStatus; captain_id: string | null }>(client, 'SELECT status, captain_id FROM trips WHERE id = $1 FOR UPDATE', [id]);
        if (!trip) throw Errors.notFound('الرحلة غير موجودة');
        if (!ACTIVE_STATUSES.includes(trip.status)) throw new AppError(409, 'TRIP_ENDED', 'الرحلة منتهية');
        const offers = await query<{ captain_id: string }>(
          client,
          `UPDATE trip_dispatch_offers SET response = 'CANCELLED', responded_at = now() WHERE trip_id = $1 AND response = 'PENDING' RETURNING captain_id`,
          [id]
        );
        await client.query(
          `UPDATE trips SET status = 'CANCELLED', cancelled_by_role = 'ADMIN', cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
          [id, ctx.actorId, body.reason]
        );
        await releaseTripHolds(client, id, 0);
        if (trip.captain_id && trip.status !== 'DRIVER_ASSIGNED') {
          await client.query(`UPDATE captains SET availability = 'ONLINE' WHERE user_id = $1 AND availability = 'ON_TRIP'`, [trip.captain_id]);
        }
        await client.query('UPDATE chat_rooms SET closed_at = now() WHERE trip_id = $1 AND closed_at IS NULL', [id]);
        await insertTripEvent(client, id, 'CANCELLED_BY_ADMIN', ctx.actorId, { reason: body.reason });
        await audit(client, ctx, 'TRIP_CANCELLED', 'trip', id, { status: trip.status }, body);
        return { withdrawn: offers.map((offer) => offer.captain_id) };
      },
      { actorId: ctx.actorId, reason: 'ADMIN_CANCELLED' }
    );
    for (const captainId of result.withdrawn) emitToUser(captainId, 'trip:offer_withdrawn', { tripId: id });
    await clearEta(id);
    await emitTripUpdate(
      id,
      'trip:cancelled',
      { cancelledBy: 'ADMIN', message: 'تم إلغاء الرحلة من قبل الإدارة' },
      {
        customer: { title: 'تم إلغاء الرحلة', body: 'ألغت الإدارة الرحلة، تواصل مع الدعم لأي استفسار' },
        captain: { title: 'تم إلغاء الرحلة', body: 'ألغت الإدارة الرحلة' },
      }
    );
    return { ok: true };
  });

  // ---------------- Trip chats ----------------

  app.get('/chats', { preHandler: requirePermission('chats.view') }, async (request) => {
    const params = parseInput(pageQuerySchema, request.query);
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const where = `WHERE ($1::text IS NULL OR t.code ILIKE $1 OR cu.full_name ILIKE $1 OR cap.full_name ILIKE $1)`;
    const from = `FROM chat_rooms r JOIN trips t ON t.id = r.trip_id JOIN users cu ON cu.id = r.customer_id JOIN users cap ON cap.id = r.captain_id`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count ${from} ${where}`, [q]);
    const rows = await query(
      pool,
      `SELECT r.trip_id AS "tripId", t.code, t.status, cu.full_name AS "customerName", cap.full_name AS "captainName",
              (SELECT count(*)::int FROM chat_messages m WHERE m.room_id = r.id) AS messages,
              (SELECT max(m.created_at) FROM chat_messages m WHERE m.room_id = r.id) AS "lastMessageAt",
              r.created_at AS "createdAt"
       ${from} ${where}
       ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [q, limit, offset]
    );
    return paged(rows, total?.count ?? 0, params);
  });

  app.get('/chats/:id', { preHandler: requirePermission('chats.view') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    // Reading private conversations is always recorded.
    await audit(pool, auditContext(request), 'CHAT_VIEWED', 'trip', id, undefined, undefined);
    return {
      items: await query(
        pool,
        `SELECT m.id, m.sender_id AS "senderId", u.full_name AS "senderName",
                CASE WHEN m.sender_id = r.customer_id THEN 'CUSTOMER' ELSE 'CAPTAIN' END AS role,
                m.body, m.delivered_at AS "deliveredAt", m.read_at AS "readAt", m.created_at AS "createdAt"
         FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id JOIN users u ON u.id = m.sender_id
         WHERE r.trip_id = $1 ORDER BY m.created_at`,
        [id]
      ),
    };
  });
};
