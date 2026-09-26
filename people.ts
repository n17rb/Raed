import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { AppError, Errors } from '../../lib/errors';
import { likeEscape, pageOffset, pageQuerySchema, paged } from '../../lib/pagination';
import { readUpload } from '../../lib/multipart';
import { formatJod } from '../../pricing/pricing';
import { requirePermission } from '../../auth/guards';
import { revokeAllSessions } from '../../auth/sessions';
import { audit, auditContext } from '../../audit/audit';
import { mediaUrlById, storeImage } from '../../media/service';
import { notifyUser } from '../../notifications/service';
import { emitToUser } from '../../realtime/io';
import { DOCUMENT_LABELS_AR, assertValidVehicle, normalizePlate } from '../../captain/onboarding';

const idParams = z.object({ id: z.string().uuid() });

export const adminPeopleRoutes: FastifyPluginAsync = async (app) => {
  // ---------------- Customers ----------------

  app.get('/customers', { preHandler: requirePermission('customers.view') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED']).optional() }), request.query);
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const where = `WHERE u.deleted_at IS NULL AND ($1::text IS NULL OR u.full_name ILIKE $1 OR u.phone ILIKE $1)
                   AND ($2::text IS NULL OR u.status = $2)`;
    const total = await queryOne<{ count: number }>(
      pool,
      `SELECT count(*)::int AS count FROM customers c JOIN users u ON u.id = c.user_id ${where}`,
      [q, params.status ?? null]
    );
    const rows = await query<{
      id: string;
      full_name: string | null;
      phone: string | null;
      status: string;
      rating_avg: string;
      completed_trips: number;
      cancelled_trips: number;
      created_at: Date;
      last_login_at: Date | null;
    }>(
      pool,
      `SELECT u.id, u.full_name, u.phone, u.status, c.rating_avg, c.completed_trips, c.cancelled_trips, u.created_at, u.last_login_at
       FROM customers c JOIN users u ON u.id = c.user_id ${where}
       ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`,
      [q, params.status ?? null, limit, offset]
    );
    return paged(
      rows.map((row) => ({
        id: row.id,
        name: row.full_name,
        phone: row.phone,
        status: row.status,
        rating: Number(row.rating_avg),
        completedTrips: row.completed_trips,
        cancelledTrips: row.cancelled_trips,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
      })),
      total?.count ?? 0,
      params
    );
  });

  app.get('/customers/:id', { preHandler: requirePermission('customers.view') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await queryOne<{
      id: string;
      full_name: string | null;
      phone: string | null;
      status: string;
      status_reason: string | null;
      avatar_url: string | null;
      rating_avg: string;
      rating_count: number;
      completed_trips: number;
      cancelled_trips: number;
      created_at: Date;
      last_login_at: Date | null;
      wallet_id: string | null;
      balance_fils: number | null;
    }>(
      pool,
      `SELECT u.id, u.full_name, u.phone, u.status, u.status_reason, m.public_url AS avatar_url,
              c.rating_avg, c.rating_count, c.completed_trips, c.cancelled_trips, u.created_at, u.last_login_at,
              w.id AS wallet_id, w.balance_fils
       FROM customers c JOIN users u ON u.id = c.user_id
       LEFT JOIN media_files m ON m.id = u.avatar_media_id
       LEFT JOIN wallets w ON w.owner_user_id = u.id AND w.owner_type = 'CUSTOMER'
       WHERE u.id = $1`,
      [id]
    );
    if (!row) throw Errors.notFound('العميل غير موجود');
    const trips = await query<{ id: string; code: string; status: string; requested_at: Date; fare: number | null; dropoff_address: string }>(
      pool,
      `SELECT id, code, status, requested_at, COALESCE(final_fare_fils, estimated_fare_fils) AS fare, dropoff_address
       FROM trips WHERE customer_id = $1 ORDER BY requested_at DESC LIMIT 20`,
      [id]
    );
    return {
      id: row.id,
      name: row.full_name,
      phone: row.phone,
      status: row.status,
      statusReason: row.status_reason,
      avatarUrl: row.avatar_url,
      rating: Number(row.rating_avg),
      ratingCount: row.rating_count,
      completedTrips: row.completed_trips,
      cancelledTrips: row.cancelled_trips,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      wallet: row.wallet_id ? { id: row.wallet_id, balanceFils: row.balance_fils ?? 0, balance: formatJod(row.balance_fils ?? 0) } : null,
      recentTrips: trips.map((trip) => ({ ...trip, fareDisplay: trip.fare === null ? null : formatJod(trip.fare) })),
    };
  });

  app.post('/customers/:id/status', { preHandler: requirePermission('customers.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'BLOCKED']), reason: z.string().trim().max(300).optional() }), request.body);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string }>(client, 'SELECT status FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('العميل غير موجود');
      await client.query('UPDATE users SET status = $2, status_reason = $3 WHERE id = $1', [id, body.status, body.reason ?? null]);
      await audit(client, ctx, 'CUSTOMER_STATUS_CHANGED', 'user', id, before, body);
    });
    if (body.status !== 'ACTIVE') await revokeAllSessions(id, `STATUS_${body.status}`);
    return { ok: true };
  });

  // ---------------- Captains ----------------

  app.get('/captains', { preHandler: requirePermission('captains.view') }, async (request) => {
    const params = parseInput(
      pageQuerySchema.extend({
        status: z.enum(['PENDING_DOCUMENTS', 'PENDING_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
        availability: z.enum(['ONLINE', 'OFFLINE', 'ON_TRIP']).optional(),
      }),
      request.query
    );
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const where = `WHERE u.deleted_at IS NULL
                     AND ($1::text IS NULL OR u.full_name ILIKE $1 OR u.phone ILIKE $1 OR v.plate_number ILIKE $1)
                     AND ($2::text IS NULL OR c.status = $2)
                     AND ($3::text IS NULL OR c.availability = $3)`;
    const from = `FROM captains c JOIN users u ON u.id = c.user_id
                  LEFT JOIN LATERAL (SELECT * FROM vehicles vv WHERE vv.captain_id = c.user_id AND vv.deleted_at IS NULL ORDER BY vv.created_at DESC LIMIT 1) v ON true
                  LEFT JOIN vehicle_makes mk ON mk.id = v.make_id
                  LEFT JOIN vehicle_models vm ON vm.id = v.model_id
                  LEFT JOIN wallets w ON w.owner_user_id = c.user_id AND w.owner_type = 'CAPTAIN'`;
    const args = [q, params.status ?? null, params.availability ?? null];
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count ${from} ${where}`, args);
    const rows = await query<{
      id: string;
      full_name: string | null;
      phone: string | null;
      user_status: string;
      status: string;
      availability: string;
      rating_avg: string;
      completed_trips: number;
      plate_number: string | null;
      vehicle: string | null;
      balance_fils: number | null;
      created_at: Date;
    }>(
      pool,
      `SELECT c.user_id AS id, u.full_name, u.phone, u.status AS user_status, c.status, c.availability, c.rating_avg, c.completed_trips,
              v.plate_number, mk.name_en || ' ' || vm.name_en || ' ' || v.year AS vehicle, w.balance_fils, c.created_at
       ${from} ${where}
       ORDER BY CASE c.status WHEN 'PENDING_REVIEW' THEN 0 ELSE 1 END, c.created_at DESC
       LIMIT $4 OFFSET $5`,
      [...args, limit, offset]
    );
    return paged(
      rows.map((row) => ({
        id: row.id,
        name: row.full_name,
        phone: row.phone,
        userStatus: row.user_status,
        status: row.status,
        availability: row.availability,
        rating: Number(row.rating_avg),
        completedTrips: row.completed_trips,
        plateNumber: row.plate_number,
        vehicle: row.vehicle,
        balanceFils: row.balance_fils ?? 0,
        balance: formatJod(row.balance_fils ?? 0),
        createdAt: row.created_at,
      })),
      total?.count ?? 0,
      params
    );
  });

  app.get('/captains/:id', { preHandler: requirePermission('captains.view') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const captain = await queryOne<{
      id: string;
      full_name: string | null;
      phone: string | null;
      user_status: string;
      avatar_media_id: string | null;
      status: string;
      status_reason: string | null;
      availability: string;
      rating_avg: string;
      rating_count: number;
      completed_trips: number;
      offers_accepted: number;
      offers_rejected: number;
      approved_at: Date | null;
      created_at: Date;
      lat: number | null;
      lng: number | null;
      location_updated_at: Date | null;
      active_vehicle_id: string | null;
      wallet_id: string | null;
      balance_fils: number | null;
      negative_limit_fils: number | null;
    }>(
      pool,
      `SELECT c.user_id AS id, u.full_name, u.phone, u.status AS user_status, u.avatar_media_id, c.status, c.status_reason, c.availability,
              c.rating_avg, c.rating_count, c.completed_trips, c.offers_accepted, c.offers_rejected, c.approved_at, c.created_at,
              ST_Y(c.current_location::geometry) AS lat, ST_X(c.current_location::geometry) AS lng, c.location_updated_at,
              c.active_vehicle_id, w.id AS wallet_id, w.balance_fils, w.negative_limit_fils
       FROM captains c JOIN users u ON u.id = c.user_id
       LEFT JOIN wallets w ON w.owner_user_id = c.user_id AND w.owner_type = 'CAPTAIN'
       WHERE c.user_id = $1`,
      [id]
    );
    if (!captain) throw Errors.notFound('الكابتن غير موجود');

    const documents = await query<{
      id: string;
      type: string;
      status: string;
      media_id: string;
      rejection_reason: string | null;
      uploaded_at: Date;
      reviewed_at: Date | null;
    }>(
      pool,
      `SELECT id, type, status, media_id, rejection_reason, uploaded_at, reviewed_at
       FROM captain_documents WHERE captain_id = $1 AND superseded_by IS NULL ORDER BY type`,
      [id]
    );
    const vehicles = await query<{
      id: string;
      status: string;
      rejection_reason: string | null;
      year: number;
      plate_number: string;
      color_name_ar: string;
      color_hex: string;
      make_id: string;
      make: string;
      model_id: string;
      model: string;
      category_id: string;
      category: string;
      image_media_id: string | null;
      created_at: Date;
    }>(
      pool,
      `SELECT v.id, v.status, v.rejection_reason, v.year, v.plate_number, v.color_name_ar, v.color_hex,
              mk.id AS make_id, mk.name_en AS make, vm.id AS model_id, vm.name_en AS model,
              vc.id AS category_id, vc.name_ar AS category, v.image_media_id, v.created_at
       FROM vehicles v
       JOIN vehicle_makes mk ON mk.id = v.make_id
       JOIN vehicle_models vm ON vm.id = v.model_id
       JOIN vehicle_categories vc ON vc.id = v.category_id
       WHERE v.captain_id = $1 AND v.deleted_at IS NULL
       ORDER BY v.created_at DESC`,
      [id]
    );
    const vehicleDocs = vehicles.length
      ? await query<{
          id: string;
          vehicle_id: string;
          type: string;
          status: string;
          media_id: string;
          rejection_reason: string | null;
          uploaded_at: Date;
        }>(
          pool,
          `SELECT id, vehicle_id, type, status, media_id, rejection_reason, uploaded_at
           FROM vehicle_documents WHERE vehicle_id = ANY($1::uuid[]) AND superseded_by IS NULL ORDER BY type`,
          [vehicles.map((vehicle) => vehicle.id)]
        )
      : [];
    const trips = await query<{ id: string; code: string; status: string; requested_at: Date; fare: number | null }>(
      pool,
      `SELECT id, code, status, requested_at, COALESCE(final_fare_fils, estimated_fare_fils) AS fare
       FROM trips WHERE captain_id = $1 ORDER BY requested_at DESC LIMIT 20`,
      [id]
    );
    const ratings = await query<{ stars: number; comment: string | null; created_at: Date }>(
      pool,
      `SELECT stars, comment, created_at FROM ratings WHERE ratee_id = $1 AND direction = 'CUSTOMER_TO_CAPTAIN' ORDER BY created_at DESC LIMIT 20`,
      [id]
    );

    return {
      id: captain.id,
      name: captain.full_name,
      phone: captain.phone,
      userStatus: captain.user_status,
      avatarUrl: await mediaUrlById(captain.avatar_media_id),
      status: captain.status,
      statusReason: captain.status_reason,
      availability: captain.availability,
      rating: Number(captain.rating_avg),
      ratingCount: captain.rating_count,
      completedTrips: captain.completed_trips,
      offersAccepted: captain.offers_accepted,
      offersRejected: captain.offers_rejected,
      approvedAt: captain.approved_at,
      createdAt: captain.created_at,
      location: captain.lat !== null && captain.lng !== null ? { lat: captain.lat, lng: captain.lng, updatedAt: captain.location_updated_at } : null,
      activeVehicleId: captain.active_vehicle_id,
      wallet: captain.wallet_id
        ? {
            id: captain.wallet_id,
            balanceFils: captain.balance_fils ?? 0,
            balance: formatJod(captain.balance_fils ?? 0),
            negativeLimit: formatJod(captain.negative_limit_fils ?? 0),
          }
        : null,
      documents: await Promise.all(
        documents.map(async (doc) => ({
          id: doc.id,
          kind: 'captain',
          type: doc.type,
          label: DOCUMENT_LABELS_AR[doc.type] ?? doc.type,
          status: doc.status,
          rejectionReason: doc.rejection_reason,
          uploadedAt: doc.uploaded_at,
          reviewedAt: doc.reviewed_at,
          url: await mediaUrlById(doc.media_id),
        }))
      ),
      vehicles: await Promise.all(
        vehicles.map(async (vehicle) => ({
          id: vehicle.id,
          status: vehicle.status,
          rejectionReason: vehicle.rejection_reason,
          year: vehicle.year,
          plateNumber: vehicle.plate_number,
          color: { name: vehicle.color_name_ar, hex: vehicle.color_hex },
          make: { id: vehicle.make_id, name: vehicle.make },
          model: { id: vehicle.model_id, name: vehicle.model },
          category: { id: vehicle.category_id, name: vehicle.category },
          imageUrl: await mediaUrlById(vehicle.image_media_id),
          isActive: vehicle.id === captain.active_vehicle_id,
          documents: await Promise.all(
            vehicleDocs
              .filter((doc) => doc.vehicle_id === vehicle.id)
              .map(async (doc) => ({
                id: doc.id,
                kind: 'vehicle',
                type: doc.type,
                label: DOCUMENT_LABELS_AR[doc.type] ?? doc.type,
                status: doc.status,
                rejectionReason: doc.rejection_reason,
                uploadedAt: doc.uploaded_at,
                url: await mediaUrlById(doc.media_id),
              }))
          ),
        }))
      ),
      recentTrips: trips.map((trip) => ({ ...trip, fareDisplay: trip.fare === null ? null : formatJod(trip.fare) })),
      recentRatings: ratings,
    };
  });

  app.post('/captains/:id/documents/:kind/:docId', { preHandler: requirePermission('captains.approve') }, async (request) => {
    const params = parseInput(
      z.object({ id: z.string().uuid(), kind: z.enum(['captain', 'vehicle']), docId: z.string().uuid() }),
      request.params
    );
    const body = parseInput(
      z.object({ status: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().min(2).max(300).optional() }),
      request.body
    );
    if (body.status === 'REJECTED' && !body.reason) throw new AppError(400, 'REASON_REQUIRED', 'اكتب سبب الرفض');
    const ctx = auditContext(request);
    const table = params.kind === 'captain' ? 'captain_documents' : 'vehicle_documents';
    const ownerCheck =
      params.kind === 'captain'
        ? 'captain_id = $2'
        : 'vehicle_id IN (SELECT id FROM vehicles WHERE captain_id = $2)';
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string; type: string }>(
        client,
        `SELECT status, type FROM ${table} WHERE id = $1 AND ${ownerCheck} FOR UPDATE`,
        [params.docId, params.id]
      );
      if (!before) throw Errors.notFound('المستند غير موجود');
      await client.query(
        `UPDATE ${table} SET status = $2, rejection_reason = $3, reviewed_at = now(), reviewed_by = $4 WHERE id = $1`,
        [params.docId, body.status, body.status === 'REJECTED' ? body.reason : null, ctx.actorId]
      );
      await audit(client, ctx, 'DOCUMENT_REVIEWED', table, params.docId, before, body);
    });
    return { ok: true };
  });

  app.post('/captains/:id/review', { preHandler: requirePermission('captains.approve') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({
        action: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
        reason: z.string().trim().min(2).max(500).optional(),
      }),
      request.body
    );
    if (body.action !== 'APPROVE' && !body.reason) throw new AppError(400, 'REASON_REQUIRED', 'اكتب السبب ليظهر للكابتن');
    const ctx = auditContext(request);

    const result = await withTransaction(async (client) => {
      const captain = await queryOne<{ status: string }>(client, 'SELECT status FROM captains WHERE user_id = $1 FOR UPDATE', [id]);
      if (!captain) throw Errors.notFound('الكابتن غير موجود');
      const vehicle = await queryOne<{ id: string; status: string; image_media_id: string | null }>(
        client,
        `SELECT id, status, image_media_id FROM vehicles WHERE captain_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [id]
      );

      if (body.action === 'APPROVE') {
        if (!vehicle) throw new AppError(409, 'VEHICLE_REQUIRED', 'لا توجد سيارة مسجلة لهذا الكابتن');
        await client.query(
          `UPDATE captain_documents SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $2
           WHERE captain_id = $1 AND superseded_by IS NULL AND status = 'PENDING'`,
          [id, ctx.actorId]
        );
        await client.query(
          `UPDATE vehicle_documents SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $2
           WHERE vehicle_id = $1 AND superseded_by IS NULL AND status = 'PENDING'`,
          [vehicle.id, ctx.actorId]
        );
        await client.query(
          `UPDATE vehicles SET status = 'APPROVED', rejection_reason = NULL, reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
          [vehicle.id, ctx.actorId]
        );
        await client.query(
          `UPDATE captains SET status = 'APPROVED', status_reason = NULL, approved_at = now(), approved_by = $2, active_vehicle_id = $3
           WHERE user_id = $1`,
          [id, ctx.actorId, vehicle.id]
        );
      } else {
        const status = body.action === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED';
        await client.query(
          `UPDATE captains SET status = $2, status_reason = $3, availability = 'OFFLINE' WHERE user_id = $1`,
          [id, status, body.reason]
        );
        if (vehicle && vehicle.status !== 'APPROVED') {
          await client.query(`UPDATE vehicles SET status = $2, rejection_reason = $3, reviewed_at = now(), reviewed_by = $4 WHERE id = $1`, [
            vehicle.id,
            body.action === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED',
            body.reason,
            ctx.actorId,
          ]);
        }
      }
      await audit(client, ctx, `CAPTAIN_${body.action}`, 'captain', id, { status: captain.status }, body);
      return { vehicleHasImage: Boolean(vehicle?.image_media_id) };
    });

    const messages = {
      APPROVE: { title: 'تمت الموافقة على حسابك', body: 'مرحبًا بك في كباتن رايد، يمكنك الآن بدء استقبال الرحلات' },
      REJECT: { title: 'لم تتم الموافقة على طلبك', body: body.reason ?? '' },
      REQUEST_CHANGES: { title: 'مطلوب تعديل بياناتك', body: body.reason ?? '' },
    } as const;
    void notifyUser(id, { ...messages[body.action], inbox: true, app: 'CAPTAIN', data: { type: 'CAPTAIN_STATUS', action: body.action } });
    emitToUser(id, 'captain:status', { action: body.action, reason: body.reason ?? null });
    return { ok: true, warning: body.action === 'APPROVE' && !result.vehicleHasImage ? 'ارفع صورة السيارة المفرغة ليظهرها التطبيق للعملاء' : null };
  });

  app.post('/captains/:id/suspend', { preHandler: requirePermission('captains.suspend') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ reason: z.string().trim().min(2).max(300) }), request.body);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string; availability: string }>(
        client,
        'SELECT status, availability FROM captains WHERE user_id = $1 FOR UPDATE',
        [id]
      );
      if (!before) throw Errors.notFound('الكابتن غير موجود');
      if (before.availability === 'ON_TRIP') throw new AppError(409, 'ON_TRIP', 'الكابتن في رحلة الآن، أوقفه بعد انتهائها');
      await client.query(`UPDATE captains SET status = 'SUSPENDED', status_reason = $2, availability = 'OFFLINE' WHERE user_id = $1`, [id, body.reason]);
      await audit(client, ctx, 'CAPTAIN_SUSPENDED', 'captain', id, before, body);
    });
    await revokeAllSessions(id, 'SUSPENDED', 'CAPTAIN');
    void notifyUser(id, { title: 'تم إيقاف حسابك', body: body.reason, inbox: true, app: 'CAPTAIN' });
    return { ok: true };
  });

  app.post('/captains/:id/reactivate', { preHandler: requirePermission('captains.suspend') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string; active_vehicle_id: string | null }>(
        client,
        'SELECT status, active_vehicle_id FROM captains WHERE user_id = $1 FOR UPDATE',
        [id]
      );
      if (!before) throw Errors.notFound('الكابتن غير موجود');
      const next = before.active_vehicle_id ? 'APPROVED' : 'PENDING_REVIEW';
      await client.query(`UPDATE captains SET status = $2, status_reason = NULL WHERE user_id = $1`, [id, next]);
      await client.query(`UPDATE users SET status = 'ACTIVE', status_reason = NULL WHERE id = $1`, [id]);
      await audit(client, ctx, 'CAPTAIN_REACTIVATED', 'captain', id, before, { status: next });
    });
    void notifyUser(id, { title: 'تمت إعادة تفعيل حسابك', body: 'يمكنك العودة لاستقبال الرحلات', inbox: true, app: 'CAPTAIN' });
    return { ok: true };
  });

  // ---------------- Vehicles ----------------

  app.get('/vehicles', { preHandler: requirePermission('captains.view') }, async (request) => {
    const params = parseInput(
      pageQuerySchema.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'SUSPENDED']).optional() }),
      request.query
    );
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const from = `FROM vehicles v
                  JOIN users u ON u.id = v.captain_id
                  JOIN vehicle_makes mk ON mk.id = v.make_id
                  JOIN vehicle_models vm ON vm.id = v.model_id
                  JOIN vehicle_categories vc ON vc.id = v.category_id
                  LEFT JOIN media_files m ON m.id = v.image_media_id
                  WHERE v.deleted_at IS NULL
                    AND ($1::text IS NULL OR v.plate_number ILIKE $1 OR u.full_name ILIKE $1 OR mk.name_en ILIKE $1 OR vm.name_en ILIKE $1)
                    AND ($2::text IS NULL OR v.status = $2)`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count ${from}`, [q, params.status ?? null]);
    const rows = await query<{
      id: string;
      captain_id: string;
      captain_name: string | null;
      make: string;
      model: string;
      year: number;
      plate_number: string;
      color_name_ar: string;
      color_hex: string;
      category: string;
      status: string;
      image_url: string | null;
    }>(
      pool,
      `SELECT v.id, v.captain_id, u.full_name AS captain_name, mk.name_en AS make, vm.name_en AS model, v.year, v.plate_number,
              v.color_name_ar, v.color_hex, vc.name_ar AS category, v.status, m.public_url AS image_url
       ${from}
       ORDER BY v.created_at DESC LIMIT $3 OFFSET $4`,
      [q, params.status ?? null, limit, offset]
    );
    return paged(rows, total?.count ?? 0, params);
  });

  app.patch('/vehicles/:id', { preHandler: requirePermission('vehicles.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({
        makeId: z.string().uuid(),
        modelId: z.string().uuid(),
        year: z.number().int().min(1980).max(2100),
        categoryId: z.string().uuid(),
        colorNameAr: z.string().trim().min(2).max(30),
        colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        plateNumber: z.string().trim().min(2).max(20),
      }),
      request.body
    );
    const plate = normalizePlate(body.plateNumber);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<Record<string, unknown>>(
        client,
        'SELECT make_id, model_id, year, category_id, color_name_ar, color_hex, plate_number FROM vehicles WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id]
      );
      if (!before) throw Errors.notFound('السيارة غير موجودة');
      await assertValidVehicle(client, body);
      await client.query(
        `UPDATE vehicles SET make_id = $2, model_id = $3, year = $4, category_id = $5, color_name_ar = $6, color_hex = $7, plate_number = $8
         WHERE id = $1`,
        [id, body.makeId, body.modelId, body.year, body.categoryId, body.colorNameAr, body.colorHex.toUpperCase(), plate]
      );
      await audit(client, ctx, 'VEHICLE_UPDATED', 'vehicle', id, before, { ...body, plateNumber: plate });
    });
    return { ok: true };
  });

  /** The captain's own transparent car image shown to customers (plate number stays a separate layer). */
  app.post('/vehicles/:id/image', { preHandler: requirePermission('vehicles.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const upload = await readUpload(request);
    const ctx = auditContext(request);
    const exists = await queryOne<{ image_media_id: string | null }>(pool, 'SELECT image_media_id FROM vehicles WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!exists) throw Errors.notFound('السيارة غير موجودة');
    const media = await storeImage({ buffer: upload.buffer, purpose: 'VEHICLE_IMAGE', uploadedBy: ctx.actorId });
    await withTransaction(async (client) => {
      const before = await queryOne<{ image_media_id: string | null }>(client, 'SELECT image_media_id FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
      await client.query('UPDATE vehicles SET image_media_id = $2 WHERE id = $1', [id, media.id]);
      await client.query(
        `INSERT INTO media_replacements (entity_type, entity_id, field_name, previous_media_id, new_media_id, replaced_by)
         VALUES ('vehicle', $1, 'image', $2, $3, $4)`,
        [id, before?.image_media_id ?? null, media.id, ctx.actorId]
      );
      await audit(client, ctx, 'VEHICLE_IMAGE_UPLOADED', 'vehicle', id, before, { mediaId: media.id });
    });
    return { imageUrl: media.url };
  });

  app.post('/vehicles/:id/status', { preHandler: requirePermission('vehicles.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({ status: z.enum(['APPROVED', 'SUSPENDED', 'REJECTED', 'CHANGES_REQUESTED']), reason: z.string().trim().max(300).optional() }),
      request.body
    );
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string; captain_id: string }>(client, 'SELECT status, captain_id FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('السيارة غير موجودة');
      await client.query(`UPDATE vehicles SET status = $2, rejection_reason = $3, reviewed_at = now(), reviewed_by = $4 WHERE id = $1`, [
        id,
        body.status,
        body.reason ?? null,
        ctx.actorId,
      ]);
      if (body.status === 'APPROVED') {
        await client.query(`UPDATE captains SET active_vehicle_id = $2 WHERE user_id = $1 AND status = 'APPROVED'`, [before.captain_id, id]);
      }
      await audit(client, ctx, 'VEHICLE_STATUS_CHANGED', 'vehicle', id, before, body);
    });
    return { ok: true };
  });
};
