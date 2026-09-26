import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction, type Queryable } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { AppError, Errors } from '../../lib/errors';
import { normalizeJordanPhone } from '../../lib/phone';
import { pageOffset, pageQuerySchema, paged } from '../../lib/pagination';
import { getAdminPermissions, invalidateAdminPermissions, isSuperAdmin, requirePermission } from '../../auth/guards';
import { revokeAllSessions } from '../../auth/sessions';
import { audit, auditContext } from '../../audit/audit';
import { SETTING_KEYS, invalidateSetting, isSettingKey, settingSchemas, type SettingKey } from '../../settings/service';
import { invalidateContentCache } from '../../content/service';

const idParams = z.object({ id: z.string().uuid() });

/** Extra permission needed to change a setting (on top of settings.manage). */
const SETTING_PERMISSION: Partial<Record<SettingKey, string>> = {
  pricing: 'pricing.manage',
  cancellation: 'pricing.manage',
  captain_wallet: 'wallets.adjust',
  otp: 'security.manage',
};

export const adminSystemRoutes: FastifyPluginAsync = async (app) => {
  // ---------------- App settings ----------------

  app.get('/settings', { preHandler: requirePermission('settings.manage') }, async () => {
    const rows = await query<{ key: string; value: unknown; is_public: boolean; description_ar: string; updated_at: Date; updated_by_name: string | null }>(
      pool,
      `SELECT s.key, s.value, s.is_public, s.description_ar, s.updated_at, u.full_name AS updated_by_name
       FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.key`
    );
    return {
      items: rows
        .filter((row) => SETTING_KEYS.includes(row.key as SettingKey))
        .map((row) => ({
          key: row.key,
          value: row.value,
          isPublic: row.is_public,
          description: row.description_ar,
          updatedAt: row.updated_at,
          updatedBy: row.updated_by_name,
          requiresPermission: SETTING_PERMISSION[row.key as SettingKey] ?? null,
        })),
    };
  });

  app.put('/settings/:key', { preHandler: requirePermission('settings.manage') }, async (request) => {
    const { key } = parseInput(z.object({ key: z.string() }), request.params);
    if (!isSettingKey(key)) throw Errors.notFound('الإعداد غير موجود');
    const ctx = auditContext(request);
    const extra = SETTING_PERMISSION[key];
    if (extra) {
      const permissions = await getAdminPermissions(ctx.actorId);
      if (!permissions.has(extra)) throw Errors.forbidden('هذا الإعداد يحتاج صلاحية إضافية');
    }
    const value = parseInput(settingSchemas[key], (request.body as { value?: unknown } | null)?.value);
    await withTransaction(async (client) => {
      const before = await queryOne<{ value: unknown }>(client, 'SELECT value FROM app_settings WHERE key = $1 FOR UPDATE', [key]);
      if (!before) throw Errors.notFound('الإعداد غير موجود');
      await client.query('UPDATE app_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1', [key, JSON.stringify(value), ctx.actorId]);
      await audit(client, ctx, 'SETTING_CHANGED', 'app_setting', key, before.value, value);
    });
    await invalidateSetting(key);
    await invalidateContentCache();
    return { ok: true, value };
  });

  // ---------------- Roles & permissions ----------------

  app.get('/permissions', { preHandler: requirePermission('admins.manage') }, async () => ({
    items: await query(pool, `SELECT code, group_name AS "group", description_ar AS description FROM permissions ORDER BY group_name, code`),
  }));

  app.get('/roles', { preHandler: requirePermission('admins.manage') }, async () => ({
    items: await query(
      pool,
      `SELECT r.id, r.code, r.name_ar AS "nameAr", r.name_en AS "nameEn", r.is_system AS "isSystem",
              COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
              (SELECT count(*)::int FROM admin_roles ar JOIN admins a ON a.user_id = ar.admin_user_id AND a.deleted_at IS NULL WHERE ar.role_id = r.id) AS "adminsCount"
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.deleted_at IS NULL GROUP BY r.id ORDER BY r.is_system DESC, r.code`
    ),
  }));

  const roleSchema = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z_]{3,30}$/),
    nameAr: z.string().trim().min(2).max(40),
    nameEn: z.string().trim().min(2).max(40),
    permissions: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(100),
  });

  async function assertCanGrant(actorId: string, permissions: string[]) {
    const mine = await getAdminPermissions(actorId);
    const superAdmin = await isSuperAdmin(actorId);
    for (const permission of permissions) {
      if (!mine.has(permission) && !superAdmin) throw Errors.forbidden('لا يمكنك منح صلاحية لا تملكها');
      if (permission === 'security.manage' && !superAdmin) throw Errors.forbidden('صلاحيات الأمان يمنحها المدير العام فقط');
    }
  }

  app.post('/roles', { preHandler: requirePermission('admins.manage') }, async (request, reply) => {
    const body = parseInput(roleSchema, request.body);
    const ctx = auditContext(request);
    await assertCanGrant(ctx.actorId, body.permissions);
    const row = await withTransaction(async (client) => {
      const created = await queryOne<{ id: string }>(client, 'INSERT INTO roles (code, name_ar, name_en) VALUES ($1, $2, $3) RETURNING id', [
        body.code,
        body.nameAr,
        body.nameEn,
      ]);
      if (!created) throw new Error('Failed to create role');
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_code, granted_by) SELECT $1, p, $3 FROM unnest($2::text[]) p`,
        [created.id, body.permissions, ctx.actorId]
      );
      await audit(client, ctx, 'ROLE_CREATED', 'role', created.id, undefined, body);
      return created;
    });
    return reply.status(201).send(row);
  });

  app.put('/roles/:id', { preHandler: requirePermission('admins.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(roleSchema.omit({ code: true }), request.body);
    const ctx = auditContext(request);
    await assertCanGrant(ctx.actorId, body.permissions);
    await withTransaction(async (client) => {
      const role = await queryOne<{ code: string }>(client, 'SELECT code FROM roles WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!role) throw Errors.notFound('الدور غير موجود');
      if (role.code === 'SUPER_ADMIN') throw Errors.forbidden('لا يمكن تعديل دور المدير العام');
      const before = await query<{ permission_code: string }>(client, 'SELECT permission_code FROM role_permissions WHERE role_id = $1', [id]);
      await client.query('UPDATE roles SET name_ar = $2, name_en = $3 WHERE id = $1', [id, body.nameAr, body.nameEn]);
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_code, granted_by) SELECT $1, p, $3 FROM unnest($2::text[]) p`,
        [id, body.permissions, ctx.actorId]
      );
      await audit(client, ctx, 'ROLE_UPDATED', 'role', id, before.map((row) => row.permission_code), body);
    });
    await invalidateAdminPermissions();
    return { ok: true };
  });

  // ---------------- Admin accounts ----------------

  app.get('/admins', { preHandler: requirePermission('admins.manage') }, async () => ({
    items: await query(
      pool,
      `SELECT a.user_id AS id, a.phone, u.full_name AS name, u.status, a.last_login_at AS "lastLoginAt", a.created_at AS "createdAt",
              a.deleted_at AS "deletedAt",
              COALESCE(json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name_ar)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM admins a JOIN users u ON u.id = a.user_id
       LEFT JOIN admin_roles ar ON ar.admin_user_id = a.user_id LEFT JOIN roles r ON r.id = ar.role_id
       GROUP BY a.user_id, a.phone, u.full_name, u.status ORDER BY a.deleted_at NULLS FIRST, a.created_at`
    ),
  }));

  async function assertCanManageRoles(actorId: string, roleIds: string[]) {
    const superAdmin = await isSuperAdmin(actorId);
    const roles = await query<{ id: string; code: string }>(pool, 'SELECT id, code FROM roles WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [roleIds]);
    if (roles.length !== roleIds.length) throw new AppError(400, 'INVALID_ROLE', 'دور غير صالح');
    if (roles.some((role) => role.code === 'SUPER_ADMIN') && !superAdmin) throw Errors.forbidden('فقط المدير العام يمنح دور المدير العام');
  }

  async function assertTargetEditable(actorId: string, targetId: string) {
    if (targetId === actorId) return;
    if ((await isSuperAdmin(targetId)) && !(await isSuperAdmin(actorId))) {
      throw Errors.forbidden('لا يمكنك تعديل حساب المدير العام');
    }
  }

  const phoneSchema = z
    .string()
    .trim()
    .min(6)
    .max(24)
    .transform((value, ctx) => {
      const phone = normalizeJordanPhone(value);
      if (!phone) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'رقم الهاتف غير صحيح. اكتب رقمًا أردنيًا مثل 0791234567' });
        return z.NEVER;
      }
      return phone;
    });

  async function assertPhoneFree(client: Queryable, phone: string, exceptId: string | null) {
    const taken = await queryOne<{ user_id: string }>(
      client,
      'SELECT user_id FROM admins WHERE phone = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR user_id <> $2)',
      [phone, exceptId]
    );
    if (taken) throw new AppError(409, 'PHONE_TAKEN', 'هذا الرقم مسجّل لمشرف آخر');
  }

  /** Admins sign in with their phone number and a 4-digit OTP — no passwords. */
  app.post('/admins', { preHandler: requirePermission('admins.manage') }, async (request, reply) => {
    const body = parseInput(
      z.object({
        phone: phoneSchema,
        fullName: z.string().trim().min(2).max(60),
        roleIds: z.array(z.string().uuid()).min(1).max(10),
      }),
      request.body
    );
    const ctx = auditContext(request);
    await assertCanManageRoles(ctx.actorId, body.roleIds);
    const row = await withTransaction(async (client) => {
      await assertPhoneFree(client, body.phone, null);
      const user = await queryOne<{ id: string }>(client, 'INSERT INTO users (full_name) VALUES ($1) RETURNING id', [body.fullName]);
      if (!user) throw new Error('Failed to create user');
      await client.query('INSERT INTO admins (user_id, phone, must_change_password) VALUES ($1, $2, false)', [user.id, body.phone]);
      await client.query(`INSERT INTO admin_roles (admin_user_id, role_id, assigned_by) SELECT $1, r, $3 FROM unnest($2::uuid[]) r`, [
        user.id,
        body.roleIds,
        ctx.actorId,
      ]);
      await audit(client, ctx, 'ADMIN_CREATED', 'admin', user.id, undefined, { phone: body.phone, fullName: body.fullName, roleIds: body.roleIds });
      return user;
    });
    return reply.status(201).send(row);
  });

  /** Change an admin's name or phone. Changing the phone signs them out everywhere. */
  app.patch('/admins/:id', { preHandler: requirePermission('admins.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ phone: phoneSchema.optional(), fullName: z.string().trim().min(2).max(60).optional() }), request.body);
    const ctx = auditContext(request);
    await assertTargetEditable(ctx.actorId, id);
    const phoneChanged = await withTransaction(async (client) => {
      const before = await queryOne<{ phone: string | null; full_name: string | null }>(
        client,
        'SELECT a.phone, u.full_name FROM admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1 AND a.deleted_at IS NULL FOR UPDATE OF a',
        [id]
      );
      if (!before) throw Errors.notFound('المشرف غير موجود');
      if (body.phone && body.phone !== before.phone) {
        await assertPhoneFree(client, body.phone, id);
        await client.query('UPDATE admins SET phone = $2 WHERE user_id = $1', [id, body.phone]);
      }
      if (body.fullName) await client.query('UPDATE users SET full_name = $2 WHERE id = $1', [id, body.fullName]);
      await audit(client, ctx, 'ADMIN_UPDATED', 'admin', id, { phone: before.phone, fullName: before.full_name }, body);
      return Boolean(body.phone && body.phone !== before.phone);
    });
    if (phoneChanged) await revokeAllSessions(id, 'PHONE_CHANGED', 'ADMIN');
    return { ok: true };
  });

  app.put('/admins/:id/roles', { preHandler: requirePermission('admins.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ roleIds: z.array(z.string().uuid()).min(1).max(10) }), request.body);
    const ctx = auditContext(request);
    if (id === ctx.actorId) throw Errors.forbidden('لا يمكنك تعديل صلاحياتك بنفسك');
    await assertTargetEditable(ctx.actorId, id);
    await assertCanManageRoles(ctx.actorId, body.roleIds);
    await withTransaction(async (client) => {
      const before = await query<{ role_id: string }>(client, 'SELECT role_id FROM admin_roles WHERE admin_user_id = $1', [id]);
      await client.query('DELETE FROM admin_roles WHERE admin_user_id = $1', [id]);
      await client.query(`INSERT INTO admin_roles (admin_user_id, role_id, assigned_by) SELECT $1, r, $3 FROM unnest($2::uuid[]) r`, [
        id,
        body.roleIds,
        ctx.actorId,
      ]);
      await audit(client, ctx, 'ADMIN_ROLES_CHANGED', 'admin', id, before.map((row) => row.role_id), body.roleIds);
    });
    await invalidateAdminPermissions(id);
    return { ok: true };
  });

  app.post('/admins/:id/deactivate', { preHandler: requirePermission('admins.manage') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    if (id === ctx.actorId) throw Errors.forbidden('لا يمكنك إيقاف حسابك');
    await assertTargetEditable(ctx.actorId, id);
    await withTransaction(async (client) => {
      const updated = await query(client, 'UPDATE admins SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL RETURNING user_id', [id]);
      if (updated.length === 0) throw Errors.notFound('المشرف غير موجود');
      await audit(client, ctx, 'ADMIN_DEACTIVATED', 'admin', id);
    });
    await invalidateAdminPermissions(id);
    await revokeAllSessions(id, 'DEACTIVATED', 'ADMIN');
    return { ok: true };
  });

  // ---------------- Audit log ----------------

  app.get('/audit-logs', { preHandler: requirePermission('audit_logs.view') }, async (request) => {
    const params = parseInput(
      pageQuerySchema.extend({ action: z.string().max(60).optional(), entityType: z.string().max(60).optional(), actorId: z.string().uuid().optional() }),
      request.query
    );
    const { limit, offset } = pageOffset(params);
    const args = [params.action ?? null, params.entityType ?? null, params.actorId ?? null];
    const where = `WHERE ($1::text IS NULL OR l.action = $1) AND ($2::text IS NULL OR l.entity_type = $2) AND ($3::uuid IS NULL OR l.actor_id = $3)`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count FROM audit_logs l ${where}`, args);
    const rows = await query(
      pool,
      `SELECT l.id, l.actor_id AS "actorId", u.full_name AS "actorName", l.actor_role AS "actorRole", l.action, l.entity_type AS "entityType",
              l.entity_id AS "entityId", l.before_data AS before, l.after_data AS after, host(l.ip_address) AS ip, l.created_at AS "createdAt"
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
       ${where} ORDER BY l.id DESC LIMIT $4 OFFSET $5`,
      [...args, limit, offset]
    );
    return paged(rows, total?.count ?? 0, params);
  });
};
