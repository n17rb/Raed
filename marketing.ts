import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { AppError, Errors } from '../../lib/errors';
import { likeEscape, pageOffset, pageQuerySchema, paged } from '../../lib/pagination';
import { readUpload } from '../../lib/multipart';
import { formatJod } from '../../pricing/pricing';
import { authOf, requirePermission } from '../../auth/guards';
import { audit, auditContext } from '../../audit/audit';
import { storeImage } from '../../media/service';
import { getSetting } from '../../settings/service';
import { invalidateContentCache } from '../../content/service';
import { deliverCampaign } from '../../notifications/service';
import { adminGetTicket, adminListTickets, adminReply, adminUpdateTicket } from '../../support/service';

const idParams = z.object({ id: z.string().uuid() });

const promoSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,24}$/),
  descriptionAr: z.string().trim().max(200).optional(),
  discountType: z.enum(['PERCENT', 'FIXED']),
  discountValue: z.number().int().positive(),
  maxDiscountFils: z.number().int().positive().nullable().optional(),
  minFareFils: z.number().int().min(0).default(0),
  categoryIds: z.array(z.string().uuid()).optional(),
  firstTripOnly: z.boolean().default(false),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  maxPerUser: z.number().int().positive().default(1),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().default(true),
});

const adFieldsSchema = z.object({
  titleAr: z.string().trim().min(1).max(80),
  descriptionAr: z.string().trim().max(200).optional(),
  actionType: z.enum(['NONE', 'URL', 'SCREEN', 'PROMO_CODE', 'DESTINATION']).default('NONE'),
  actionValue: z.string().trim().max(500).optional(),
  destinationLat: z.coerce.number().min(-90).max(90).optional(),
  destinationLng: z.coerce.number().min(-180).max(180).optional(),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  displaySeconds: z.coerce.number().int().min(3).max(30).default(6),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(true),
});

function adValues(fields: z.infer<typeof adFieldsSchema>) {
  const hasDestination = fields.destinationLat !== undefined && fields.destinationLng !== undefined;
  if (fields.actionType !== 'NONE' && !fields.actionValue && !hasDestination) {
    throw new AppError(400, 'ACTION_REQUIRED', 'حدد وجهة الإعلان (رابط أو كود أو موقع)');
  }
  return { hasDestination };
}

export const adminMarketingRoutes: FastifyPluginAsync = async (app) => {
  // ---------------- Promo codes ----------------

  app.get('/promo-codes', { preHandler: requirePermission('promo_codes.manage') }, async (request) => {
    const params = parseInput(pageQuerySchema, request.query);
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const total = await queryOne<{ count: number }>(
      pool,
      'SELECT count(*)::int AS count FROM promo_codes WHERE deleted_at IS NULL AND ($1::text IS NULL OR code ILIKE $1)',
      [q]
    );
    const rows = await query<Record<string, unknown>>(
      pool,
      `SELECT p.id, p.code::text AS code, p.description_ar AS "descriptionAr", p.discount_type AS "discountType", p.discount_value AS "discountValue",
              p.max_discount_fils AS "maxDiscountFils", p.min_fare_fils AS "minFareFils", p.category_ids AS "categoryIds",
              p.first_trip_only AS "firstTripOnly", p.max_redemptions AS "maxRedemptions", p.max_per_user AS "maxPerUser",
              p.redemptions_count AS "redemptionsCount", p.starts_at AS "startsAt", p.ends_at AS "endsAt", p.is_active AS "isActive",
              p.created_at AS "createdAt",
              (SELECT COALESCE(sum(discount_fils), 0)::bigint FROM promo_redemptions r WHERE r.promo_code_id = p.id AND r.status = 'APPLIED') AS "totalDiscountFils"
       FROM promo_codes p WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR p.code ILIKE $1)
       ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [q, limit, offset]
    );
    return paged(
      rows.map((row) => ({ ...row, totalDiscount: formatJod(Number(row.totalDiscountFils ?? 0)) })),
      total?.count ?? 0,
      params
    );
  });

  app.post('/promo-codes', { preHandler: requirePermission('promo_codes.manage') }, async (request, reply) => {
    const body = parseInput(promoSchema, request.body);
    if (body.discountType === 'PERCENT' && body.discountValue > 100) throw new AppError(400, 'INVALID_PERCENT', 'النسبة يجب ألا تتجاوز 100٪');
    const ctx = auditContext(request);
    const row = await withTransaction(async (client) => {
      const created = await queryOne<{ id: string }>(
        client,
        `INSERT INTO promo_codes (code, description_ar, discount_type, discount_value, max_discount_fils, min_fare_fils, category_ids,
           first_trip_only, max_redemptions, max_per_user, starts_at, ends_at, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),$12,$13,$14) RETURNING id`,
        [
          body.code,
          body.descriptionAr ?? null,
          body.discountType,
          body.discountValue,
          body.maxDiscountFils ?? null,
          body.minFareFils,
          body.categoryIds && body.categoryIds.length > 0 ? body.categoryIds : null,
          body.firstTripOnly,
          body.maxRedemptions ?? null,
          body.maxPerUser,
          body.startsAt ?? null,
          body.endsAt ?? null,
          body.isActive,
          ctx.actorId,
        ]
      );
      await audit(client, ctx, 'PROMO_CREATED', 'promo_code', created?.id ?? null, undefined, body);
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch('/promo-codes/:id', { preHandler: requirePermission('promo_codes.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(promoSchema.omit({ code: true }), request.body);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne(client, 'SELECT * FROM promo_codes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('الكود غير موجود');
      await client.query(
        `UPDATE promo_codes SET description_ar = $2, discount_type = $3, discount_value = $4, max_discount_fils = $5, min_fare_fils = $6,
           category_ids = $7, first_trip_only = $8, max_redemptions = $9, max_per_user = $10,
           starts_at = COALESCE($11::timestamptz, starts_at), ends_at = $12, is_active = $13
         WHERE id = $1`,
        [
          id,
          body.descriptionAr ?? null,
          body.discountType,
          body.discountValue,
          body.maxDiscountFils ?? null,
          body.minFareFils,
          body.categoryIds && body.categoryIds.length > 0 ? body.categoryIds : null,
          body.firstTripOnly,
          body.maxRedemptions ?? null,
          body.maxPerUser,
          body.startsAt ?? null,
          body.endsAt ?? null,
          body.isActive,
        ]
      );
      await audit(client, ctx, 'PROMO_UPDATED', 'promo_code', id, before, body);
    });
    return { ok: true };
  });

  app.post('/promo-codes/:id/archive', { preHandler: requirePermission('promo_codes.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne(client, 'SELECT code, is_active FROM promo_codes WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!before) throw Errors.notFound('الكود غير موجود');
      await client.query('UPDATE promo_codes SET deleted_at = now(), is_active = false WHERE id = $1', [id]);
      await audit(client, ctx, 'PROMO_ARCHIVED', 'promo_code', id, before, { archived: true });
    });
    return { ok: true };
  });

  // ---------------- Advertisements ----------------

  app.get('/advertisements', { preHandler: requirePermission('advertisements.manage') }, async (request) => {
    const params = parseInput(z.object({ archived: z.enum(['true', 'false']).default('false') }), request.query);
    const settings = await getSetting('advertisements');
    const rows = await query<Record<string, unknown>>(
      pool,
      `SELECT a.id, a.title_ar AS "titleAr", a.description_ar AS "descriptionAr", a.action_type AS "actionType", a.action_value AS "actionValue",
              ST_Y(a.destination_location::geometry) AS "destinationLat", ST_X(a.destination_location::geometry) AS "destinationLng",
              a.sort_order AS "sortOrder", a.display_seconds AS "displaySeconds", a.starts_at AS "startsAt", a.ends_at AS "endsAt",
              a.is_active AS "isActive", a.archived_at AS "archivedAt", a.created_at AS "createdAt",
              m.public_url AS "imageUrl", m.width, m.height,
              (a.is_active AND a.archived_at IS NULL AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())) AS live
       FROM advertisements a JOIN media_files m ON m.id = a.image_media_id
       WHERE ($1 = 'true') = (a.archived_at IS NOT NULL)
       ORDER BY a.sort_order, a.created_at DESC`,
      [params.archived]
    );
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(settings.bannerWidth, settings.bannerHeight);
    return {
      banner: {
        width: settings.bannerWidth,
        height: settings.bannerHeight,
        ratio: `${settings.bannerWidth / divisor} : ${settings.bannerHeight / divisor}`,
        rotationIntervalMs: settings.rotationIntervalMs,
        maxActive: settings.maxActive,
      },
      items: rows,
    };
  });

  /** multipart: text fields first, then "image" (must match the banner size exactly). */
  app.post('/advertisements', { preHandler: requirePermission('advertisements.manage') }, async (request, reply) => {
    const upload = await readUpload(request);
    const fields = parseInput(adFieldsSchema, upload.fields);
    const { hasDestination } = adValues(fields);
    const settings = await getSetting('advertisements');
    const ctx = auditContext(request);
    const media = await storeImage({
      buffer: upload.buffer,
      purpose: 'ADVERTISEMENT',
      uploadedBy: ctx.actorId,
      exactSize: { width: settings.bannerWidth, height: settings.bannerHeight },
    });
    const row = await withTransaction(async (client) => {
      const created = await queryOne<{ id: string }>(
        client,
        `INSERT INTO advertisements (title_ar, description_ar, image_media_id, action_type, action_value, destination_location,
           sort_order, display_seconds, starts_at, ends_at, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography END,
                 $9, $10, COALESCE($11::timestamptz, now()), $12, $13, $14)
         RETURNING id`,
        [
          fields.titleAr,
          fields.descriptionAr ?? null,
          media.id,
          fields.actionType,
          fields.actionValue ?? null,
          hasDestination,
          fields.destinationLng ?? null,
          fields.destinationLat ?? null,
          fields.sortOrder,
          fields.displaySeconds,
          fields.startsAt ?? null,
          fields.endsAt ?? null,
          fields.isActive,
          ctx.actorId,
        ]
      );
      await audit(client, ctx, 'AD_CREATED', 'advertisement', created?.id ?? null, undefined, { ...fields, mediaId: media.id });
      return created;
    });
    await invalidateContentCache();
    return reply.status(201).send({ id: row?.id, imageUrl: media.url });
  });

  app.patch('/advertisements/:id', { preHandler: requirePermission('advertisements.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const fields = parseInput(adFieldsSchema, request.body);
    const { hasDestination } = adValues(fields);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne(client, 'SELECT * FROM advertisements WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('الإعلان غير موجود');
      await client.query(
        `UPDATE advertisements SET title_ar = $2, description_ar = $3, action_type = $4, action_value = $5,
           destination_location = CASE WHEN $6::boolean THEN ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography END,
           sort_order = $9, display_seconds = $10, starts_at = COALESCE($11::timestamptz, starts_at), ends_at = $12, is_active = $13
         WHERE id = $1`,
        [
          id,
          fields.titleAr,
          fields.descriptionAr ?? null,
          fields.actionType,
          fields.actionValue ?? null,
          hasDestination,
          fields.destinationLng ?? null,
          fields.destinationLat ?? null,
          fields.sortOrder,
          fields.displaySeconds,
          fields.startsAt ?? null,
          fields.endsAt ?? null,
          fields.isActive,
        ]
      );
      await audit(client, ctx, 'AD_UPDATED', 'advertisement', id, before, fields);
    });
    await invalidateContentCache();
    return { ok: true };
  });

  app.post('/advertisements/:id/image', { preHandler: requirePermission('advertisements.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const upload = await readUpload(request);
    const settings = await getSetting('advertisements');
    const ctx = auditContext(request);
    const media = await storeImage({
      buffer: upload.buffer,
      purpose: 'ADVERTISEMENT',
      uploadedBy: ctx.actorId,
      exactSize: { width: settings.bannerWidth, height: settings.bannerHeight },
    });
    await withTransaction(async (client) => {
      const before = await queryOne<{ image_media_id: string }>(client, 'SELECT image_media_id FROM advertisements WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('الإعلان غير موجود');
      await client.query('UPDATE advertisements SET image_media_id = $2 WHERE id = $1', [id, media.id]);
      await client.query(
        `INSERT INTO media_replacements (entity_type, entity_id, field_name, previous_media_id, new_media_id, replaced_by)
         VALUES ('advertisement', $1, 'image', $2, $3, $4)`,
        [id, before.image_media_id, media.id, ctx.actorId]
      );
      await audit(client, ctx, 'AD_IMAGE_REPLACED', 'advertisement', id, before, { mediaId: media.id });
    });
    await invalidateContentCache();
    return { imageUrl: media.url };
  });

  app.post('/advertisements/:id/archive', { preHandler: requirePermission('advertisements.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ archived: z.boolean().default(true) }), request.body ?? {});
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne(client, 'SELECT archived_at, is_active FROM advertisements WHERE id = $1', [id]);
      if (!before) throw Errors.notFound('الإعلان غير موجود');
      await client.query(`UPDATE advertisements SET archived_at = CASE WHEN $2 THEN now() END WHERE id = $1`, [id, body.archived]);
      await audit(client, ctx, body.archived ? 'AD_ARCHIVED' : 'AD_RESTORED', 'advertisement', id, before, body);
    });
    await invalidateContentCache();
    return { ok: true };
  });

  // ---------------- Notifications & campaigns ----------------

  app.get('/notifications', { preHandler: requirePermission('notifications.send') }, async (request) => {
    const params = parseInput(pageQuerySchema, request.query);
    const { limit, offset } = pageOffset(params);
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count FROM notifications WHERE audience <> 'SYSTEM'`, []);
    const rows = await query(
      pool,
      `SELECT n.id, n.type, n.audience, n.title, n.body, n.status, n.scheduled_at AS "scheduledAt", n.sent_at AS "sentAt",
              n.recipient_count AS "recipientCount", p.code::text AS "promoCode", u.full_name AS "createdBy", n.created_at AS "createdAt",
              (SELECT count(*)::int FROM user_notifications un WHERE un.notification_id = n.id AND un.read_at IS NOT NULL) AS "readCount"
       FROM notifications n LEFT JOIN promo_codes p ON p.id = n.promo_code_id LEFT JOIN users u ON u.id = n.created_by
       WHERE n.audience <> 'SYSTEM'
       ORDER BY n.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return paged(rows, total?.count ?? 0, params);
  });

  app.get('/notifications/recipients', { preHandler: requirePermission('notifications.send') }, async (request) => {
    const params = parseInput(z.object({ role: z.enum(['CUSTOMER', 'CAPTAIN']), q: z.string().trim().min(1).max(60) }), request.query);
    const table = params.role === 'CUSTOMER' ? 'customers' : 'captains';
    return {
      items: await query(
        pool,
        `SELECT u.id, u.full_name AS name, u.phone FROM ${table} r JOIN users u ON u.id = r.user_id
         WHERE u.deleted_at IS NULL AND (u.full_name ILIKE $1 OR u.phone ILIKE $1) ORDER BY u.full_name LIMIT 20`,
        [`%${likeEscape(params.q)}%`]
      ),
    };
  });

  app.post('/notifications', { preHandler: requirePermission('notifications.send') }, async (request, reply) => {
    const body = parseInput(
      z.object({
        type: z.enum(['NOTIFICATION', 'PROMOTION', 'PROMO_CODE', 'ANNOUNCEMENT']),
        audience: z.enum(['ALL_CUSTOMERS', 'ALL_CAPTAINS', 'SELECTED_CUSTOMERS', 'SELECTED_CAPTAINS', 'INDIVIDUAL']),
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(500),
        promoCodeId: z.string().uuid().optional(),
        recipientIds: z.array(z.string().uuid()).max(5000).optional(),
        scheduledAt: z.string().datetime().optional(),
      }),
      request.body
    );
    if (body.audience.startsWith('SELECTED') || body.audience === 'INDIVIDUAL') {
      if (!body.recipientIds || body.recipientIds.length === 0) throw new AppError(400, 'RECIPIENTS_REQUIRED', 'اختر المستلمين');
    }
    if (body.type === 'PROMO_CODE' && !body.promoCodeId) throw new AppError(400, 'PROMO_REQUIRED', 'اختر كود الخصم');
    const ctx = auditContext(request);
    const scheduled = body.scheduledAt && new Date(body.scheduledAt).getTime() > Date.now() + 30_000;
    const row = await withTransaction(async (client) => {
      const created = await queryOne<{ id: string }>(
        client,
        `INSERT INTO notifications (type, audience, title, body, promo_code_id, recipient_ids, status, scheduled_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          body.type,
          body.audience,
          body.title,
          body.body,
          body.promoCodeId ?? null,
          body.recipientIds ?? null,
          scheduled ? 'SCHEDULED' : 'DRAFT',
          scheduled ? body.scheduledAt : null,
          ctx.actorId,
        ]
      );
      await audit(client, ctx, 'NOTIFICATION_CREATED', 'notification', created?.id ?? null, undefined, { ...body, recipientIds: body.recipientIds?.length });
      return created;
    });
    if (!row) throw new Error('Failed to create notification');
    if (!scheduled) {
      const result = await deliverCampaign(row.id);
      return reply.status(201).send({ id: row.id, status: 'SENT', ...result });
    }
    return reply.status(201).send({ id: row.id, status: 'SCHEDULED' });
  });

  app.post('/notifications/:id/cancel', { preHandler: requirePermission('notifications.send') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne<{ status: string }>(client, 'SELECT status FROM notifications WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('الإشعار غير موجود');
      if (before.status !== 'SCHEDULED') throw new AppError(409, 'CANNOT_CANCEL', 'لا يمكن إلغاء إشعار تم إرساله');
      await client.query(`UPDATE notifications SET status = 'CANCELLED' WHERE id = $1`, [id]);
      await audit(client, ctx, 'NOTIFICATION_CANCELLED', 'notification', id, before, { status: 'CANCELLED' });
    });
    return { ok: true };
  });

  // ---------------- Support tickets ----------------

  app.get('/support', { preHandler: requirePermission('support.handle') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ status: z.enum(['OPEN', 'PENDING_USER', 'RESOLVED', 'CLOSED']).optional() }), request.query);
    const result = await adminListTickets({ status: params.status, q: params.q, page: params.page, pageSize: params.pageSize });
    return paged(result.items, result.total, params);
  });

  app.get('/support/:id', { preHandler: requirePermission('support.handle') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    return adminGetTicket(id);
  });

  app.post('/support/:id/messages', { preHandler: requirePermission('support.handle') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    return adminReply(authOf(request).userId, id, request.body);
  });

  app.patch('/support/:id', { preHandler: requirePermission('support.handle') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({
        status: z.enum(['OPEN', 'PENDING_USER', 'RESOLVED', 'CLOSED']).optional(),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
        assignedAdminId: z.string().uuid().nullable().optional(),
      }),
      request.body
    );
    const ctx = auditContext(request);
    const result = await adminUpdateTicket(id, body);
    await audit(pool, ctx, 'TICKET_UPDATED', 'support_ticket', id, result.before, result.after);
    return { ok: true };
  });
};
