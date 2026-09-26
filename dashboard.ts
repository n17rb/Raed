import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { formatJod } from '../../pricing/pricing';
import { requirePermission } from '../../auth/guards';

export const adminDashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/dashboard', { preHandler: requirePermission('dashboard.view') }, async () => {
    const stats = await queryOne<Record<string, number>>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM trips WHERE status IN ('DRIVER_ACCEPTED','DRIVER_ARRIVING','DRIVER_ARRIVED','TRIP_STARTED')) AS active_trips,
         (SELECT count(*)::int FROM trips WHERE status IN ('REQUESTED','SEARCHING','DRIVER_ASSIGNED')) AS searching_trips,
         (SELECT count(*)::int FROM captains WHERE availability IN ('ONLINE','ON_TRIP')) AS online_captains,
         (SELECT count(*)::int FROM captains WHERE availability = 'OFFLINE' AND status = 'APPROVED') AS offline_captains,
         (SELECT count(*)::int FROM customers) AS customers,
         (SELECT count(*)::int FROM captains WHERE status = 'APPROVED') AS approved_captains,
         (SELECT count(*)::int FROM trips) AS total_trips,
         (SELECT count(*)::int FROM trips WHERE status = 'TRIP_COMPLETED') AS completed_trips,
         (SELECT count(*)::int FROM trips WHERE status = 'CANCELLED') AS cancelled_trips,
         (SELECT COALESCE(sum(total_fils),0)::bigint FROM trip_fares tf JOIN trips t ON t.id = tf.trip_id WHERE t.status = 'TRIP_COMPLETED') AS gross_fils,
         (SELECT COALESCE(sum(commission_fils),0)::bigint FROM captain_earnings) AS commission_fils,
         (SELECT COALESCE(sum(net_fils),0)::bigint FROM captain_earnings) AS captain_earnings_fils,
         (SELECT count(*)::int FROM captains WHERE status = 'PENDING_REVIEW') AS pending_approvals,
         (SELECT count(*)::int FROM withdrawals WHERE status IN ('REQUESTED','APPROVED')) AS pending_withdrawals,
         (SELECT count(*)::int FROM transfer_proofs WHERE status = 'PENDING') AS pending_transfers,
         (SELECT count(*)::int FROM support_tickets WHERE status IN ('OPEN','PENDING_USER')) AS open_tickets,
         (SELECT count(*)::int FROM trips WHERE requested_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Amman') AT TIME ZONE 'Asia/Amman') AS trips_today,
         (SELECT COALESCE(sum(commission_fils),0)::bigint FROM captain_earnings WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Amman') AT TIME ZONE 'Asia/Amman') AS commission_today_fils`
    );
    const s = stats ?? {};
    return {
      activeTrips: s.active_trips ?? 0,
      searchingTrips: s.searching_trips ?? 0,
      onlineCaptains: s.online_captains ?? 0,
      offlineCaptains: s.offline_captains ?? 0,
      customers: s.customers ?? 0,
      approvedCaptains: s.approved_captains ?? 0,
      totalTrips: s.total_trips ?? 0,
      completedTrips: s.completed_trips ?? 0,
      cancelledTrips: s.cancelled_trips ?? 0,
      tripsToday: s.trips_today ?? 0,
      revenue: { grossFils: s.gross_fils ?? 0, gross: formatJod(s.gross_fils ?? 0), commissionFils: s.commission_fils ?? 0, commission: formatJod(s.commission_fils ?? 0), commissionToday: formatJod(s.commission_today_fils ?? 0) },
      captainEarnings: { fils: s.captain_earnings_fils ?? 0, display: formatJod(s.captain_earnings_fils ?? 0) },
      pendingApprovals: s.pending_approvals ?? 0,
      pendingWithdrawals: s.pending_withdrawals ?? 0,
      pendingTransfers: s.pending_transfers ?? 0,
      openTickets: s.open_tickets ?? 0,
    };
  });

  app.get('/reports', { preHandler: requirePermission('reports.view') }, async (request) => {
    const params = parseInput(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      request.query
    );
    const to = params.to ?? new Date().toISOString().slice(0, 10);
    const from = params.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const daily = await query<{
      day: string;
      requested: number;
      completed: number;
      cancelled: number;
      gross: number;
      commission: number;
    }>(
      pool,
      `WITH days AS (
         SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              count(t.id)::int AS requested,
              count(t.id) FILTER (WHERE t.status = 'TRIP_COMPLETED')::int AS completed,
              count(t.id) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
              COALESCE(sum(t.final_fare_fils) FILTER (WHERE t.status = 'TRIP_COMPLETED'), 0)::bigint AS gross,
              COALESCE(sum(ce.commission_fils), 0)::bigint AS commission
       FROM days d
       LEFT JOIN trips t ON (t.requested_at AT TIME ZONE 'Asia/Amman')::date = d.day
       LEFT JOIN captain_earnings ce ON ce.trip_id = t.id
       GROUP BY d.day ORDER BY d.day`,
      [from, to]
    );
    const byCategory = await query<{ name: string; trips: number; gross: number }>(
      pool,
      `SELECT vc.name_ar AS name, count(*)::int AS trips, COALESCE(sum(t.final_fare_fils), 0)::bigint AS gross
       FROM trips t JOIN vehicle_categories vc ON vc.id = t.category_id
       WHERE t.status = 'TRIP_COMPLETED' AND (t.requested_at AT TIME ZONE 'Asia/Amman')::date BETWEEN $1::date AND $2::date
       GROUP BY vc.name_ar ORDER BY trips DESC`,
      [from, to]
    );
    const cancelReasons = await query<{ reason: string; count: number }>(
      pool,
      `SELECT COALESCE(cancelled_by_role, 'UNKNOWN') || ':' || COALESCE(cancel_reason, '-') AS reason, count(*)::int AS count
       FROM trips WHERE status = 'CANCELLED' AND (requested_at AT TIME ZONE 'Asia/Amman')::date BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
      [from, to]
    );
    const topCaptains = await query<{ id: string; name: string | null; trips: number; net: number; rating: string }>(
      pool,
      `SELECT c.user_id AS id, u.full_name AS name, count(ce.id)::int AS trips, COALESCE(sum(ce.net_fils),0)::bigint AS net, c.rating_avg AS rating
       FROM captain_earnings ce JOIN captains c ON c.user_id = ce.captain_id JOIN users u ON u.id = c.user_id
       WHERE (ce.created_at AT TIME ZONE 'Asia/Amman')::date BETWEEN $1::date AND $2::date
       GROUP BY c.user_id, u.full_name, c.rating_avg ORDER BY trips DESC LIMIT 10`,
      [from, to]
    );
    return {
      from,
      to,
      daily: daily.map((row) => ({ ...row, grossDisplay: formatJod(row.gross), commissionDisplay: formatJod(row.commission) })),
      byCategory: byCategory.map((row) => ({ ...row, grossDisplay: formatJod(row.gross) })),
      cancelReasons,
      topCaptains: topCaptains.map((row) => ({ ...row, rating: Number(row.rating), netDisplay: formatJod(row.net) })),
    };
  });

  app.get('/live', { preHandler: requirePermission('live_map.view') }, async () => {
    const captains = await query<{
      id: string;
      name: string | null;
      phone: string | null;
      availability: string;
      lat: number;
      lng: number;
      heading: number | null;
      updated_at: Date;
      plate_number: string | null;
      model: string | null;
      category: string | null;
    }>(
      pool,
      `SELECT c.user_id AS id, u.full_name AS name, u.phone, c.availability,
              ST_Y(c.current_location::geometry) AS lat, ST_X(c.current_location::geometry) AS lng,
              c.current_heading AS heading, c.location_updated_at AS updated_at,
              v.plate_number, mk.name_en || ' ' || vm.name_en AS model, vc.name_ar AS category
       FROM captains c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN vehicles v ON v.id = c.active_vehicle_id
       LEFT JOIN vehicle_makes mk ON mk.id = v.make_id
       LEFT JOIN vehicle_models vm ON vm.id = v.model_id
       LEFT JOIN vehicle_categories vc ON vc.id = v.category_id
       WHERE c.availability IN ('ONLINE', 'ON_TRIP') AND c.current_location IS NOT NULL`
    );
    const trips = await query<{
      id: string;
      code: string;
      status: string;
      captain_id: string | null;
      customer_name: string | null;
      pickup_lat: number;
      pickup_lng: number;
      pickup_address: string;
      dropoff_lat: number;
      dropoff_lng: number;
      dropoff_address: string;
      route_polyline: string | null;
      requested_at: Date;
    }>(
      pool,
      `SELECT t.id, t.code, t.status, t.captain_id, u.full_name AS customer_name,
              ST_Y(t.pickup_location::geometry) AS pickup_lat, ST_X(t.pickup_location::geometry) AS pickup_lng, t.pickup_address,
              ST_Y(t.dropoff_location::geometry) AS dropoff_lat, ST_X(t.dropoff_location::geometry) AS dropoff_lng, t.dropoff_address,
              t.route_polyline, t.requested_at
       FROM trips t JOIN users u ON u.id = t.customer_id
       WHERE t.status NOT IN ('TRIP_COMPLETED', 'CANCELLED')
       ORDER BY t.requested_at DESC`
    );
    return {
      captains: captains.map((row) => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        availability: row.availability,
        location: { lat: row.lat, lng: row.lng, heading: row.heading },
        updatedAt: row.updated_at,
        vehicle: row.plate_number ? { plateNumber: row.plate_number, model: row.model, category: row.category } : null,
      })),
      trips: trips.map((row) => ({
        id: row.id,
        code: row.code,
        status: row.status,
        captainId: row.captain_id,
        customerName: row.customer_name,
        pickup: { lat: row.pickup_lat, lng: row.pickup_lng, address: row.pickup_address },
        dropoff: { lat: row.dropoff_lat, lng: row.dropoff_lng, address: row.dropoff_address },
        polyline: row.route_polyline,
        requestedAt: row.requested_at,
      })),
    };
  });
};
