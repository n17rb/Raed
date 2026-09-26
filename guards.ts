import type { FastifyRequest } from 'fastify';
import { pool, query } from '../db/pool';
import { redis } from '../lib/redis';
import { Errors } from '../lib/errors';
import { verifyAccessToken, type AccessClaims, type AppKind } from './tokens';
import { isSessionRevoked } from './sessions';

export type AuthContext = AccessClaims;

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SESSION_EXPIRED = 'انتهت الجلسة، سجّل الدخول مجددًا';

export async function authenticateToken(token: string): Promise<AccessClaims> {
  let claims: AccessClaims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    throw Errors.unauthorized(SESSION_EXPIRED);
  }
  if (await isSessionRevoked(claims.sessionId)) {
    throw Errors.unauthorized(SESSION_EXPIRED);
  }
  return claims;
}

export function requireAuth(...apps: AppKind[]) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw Errors.unauthorized();
    }
    const claims = await authenticateToken(header.slice(7).trim());
    if (apps.length > 0 && !apps.includes(claims.app)) {
      throw Errors.forbidden();
    }
    request.auth = claims;
  };
}

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw Errors.unauthorized();
  return request.auth;
}

const PERMISSIONS_CACHE_SECONDS = 60;
const permissionsKey = (userId: string) => `admin-permissions:${userId}`;

export async function getAdminPermissions(userId: string): Promise<Set<string>> {
  const cached = await redis.get(permissionsKey(userId)).catch(() => null);
  if (cached) {
    return new Set(JSON.parse(cached) as string[]);
  }
  const rows = await query<{ permission_code: string }>(
    pool,
    `SELECT DISTINCT rp.permission_code
     FROM admins a
     JOIN users u ON u.id = a.user_id AND u.status = 'ACTIVE'
     JOIN admin_roles ar ON ar.admin_user_id = a.user_id
     JOIN roles r ON r.id = ar.role_id AND r.deleted_at IS NULL
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE a.user_id = $1 AND a.deleted_at IS NULL`,
    [userId]
  );
  const codes = rows.map((row) => row.permission_code);
  await redis.set(permissionsKey(userId), JSON.stringify(codes), 'EX', PERMISSIONS_CACHE_SECONDS).catch(() => undefined);
  return new Set(codes);
}

export async function invalidateAdminPermissions(userId?: string): Promise<void> {
  if (userId) {
    await redis.del(permissionsKey(userId)).catch(() => undefined);
    return;
  }
  const keys = await redis.keys('admin-permissions:*').catch(() => [] as string[]);
  if (keys.length > 0) await redis.del(...keys).catch(() => undefined);
}

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    pool,
    `SELECT 1 AS one FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
     WHERE ar.admin_user_id = $1 AND r.code = 'SUPER_ADMIN' AND r.deleted_at IS NULL`,
    [userId]
  );
  return rows.length > 0;
}

export function requirePermission(code: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const auth = request.auth;
    if (!auth || auth.app !== 'ADMIN') {
      throw Errors.forbidden();
    }
    const permissions = await getAdminPermissions(auth.userId);
    if (!permissions.has(code)) {
      throw Errors.forbidden();
    }
  };
}
