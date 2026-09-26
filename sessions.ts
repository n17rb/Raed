import type { PoolClient } from 'pg';
import { env } from '../config/env';
import { pool, query, queryOne, withTransaction } from '../db/pool';
import { redis } from '../lib/redis';
import { randomToken, sha256Hex } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { accessTokenTtlSeconds, durationToMs, signAccessToken, type AppKind } from './tokens';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresAt: string;
}

export interface CreateSessionInput {
  userId: string;
  app: AppKind;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
}

const REVOKED_PREFIX = 'revoked-session:';

export async function createSession(
  client: PoolClient,
  input: CreateSessionInput
): Promise<{ sessionId: string; tokens: SessionTokens }> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + durationToMs(env.JWT_REFRESH_TTL));
  const row = await queryOne<{ id: string }>(
    client,
    `INSERT INTO refresh_tokens (user_id, device_id, app, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [input.userId, input.deviceId, input.app, sha256Hex(refreshToken), expiresAt, input.ip, input.userAgent]
  );
  if (!row) throw new Error('Failed to create session');

  const accessToken = await signAccessToken({ userId: input.userId, app: input.app, sessionId: row.id });
  return {
    sessionId: row.id,
    tokens: {
      accessToken,
      refreshToken,
      accessTokenExpiresIn: accessTokenTtlSeconds,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    },
  };
}

async function markRevoked(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const pipeline = redis.pipeline();
  for (const id of sessionIds) {
    pipeline.set(`${REVOKED_PREFIX}${id}`, '1', 'EX', accessTokenTtlSeconds + 60);
  }
  await pipeline.exec().catch(() => undefined);
}

export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await redis.exists(`${REVOKED_PREFIX}${sessionId}`)) === 1;
  } catch {
    const row = await queryOne<{ revoked: boolean }>(
      pool,
      `SELECT (revoked_at IS NOT NULL AND revoked_reason <> 'ROTATED') AS revoked FROM refresh_tokens WHERE id = $1`,
      [sessionId]
    );
    return row?.revoked ?? true;
  }
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  const rows = await query<{ id: string }>(
    pool,
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [sessionId, reason]
  );
  await markRevoked(rows.length > 0 ? rows.map((row) => row.id) : [sessionId]);
}

/** Ends every session of a user (suspension, password change). */
export async function revokeAllSessions(userId: string, reason: string, app: AppKind | null = null): Promise<void> {
  const rows = await query<{ id: string }>(
    pool,
    `SELECT id FROM refresh_tokens
     WHERE user_id = $1 AND ($2::text IS NULL OR app = $2)
       AND (revoked_at IS NULL OR (revoked_reason = 'ROTATED' AND created_at > now() - interval '1 day'))`,
    [userId, app]
  );
  await query(
    pool,
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR app = $3)`,
    [userId, reason, app]
  );
  await markRevoked(rows.map((row) => row.id));
}

type RotateOutcome =
  | { kind: 'ok'; tokens: SessionTokens }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'suspended' }
  | { kind: 'reused'; revokedIds: string[] };

export async function rotateSession(
  refreshToken: string,
  meta: { ip: string | null; userAgent: string | null }
): Promise<SessionTokens> {
  const outcome = await withTransaction<RotateOutcome>(async (client) => {
    const current = await queryOne<{
      id: string;
      user_id: string;
      app: AppKind;
      device_id: string | null;
      expires_at: Date;
      revoked_at: Date | null;
      revoked_reason: string | null;
      status: string;
    }>(
      client,
      `SELECT rt.id, rt.user_id, rt.app, rt.device_id, rt.expires_at, rt.revoked_at, rt.revoked_reason, u.status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt`,
      [sha256Hex(refreshToken)]
    );

    if (!current) return { kind: 'invalid' };

    if (current.revoked_at) {
      if (current.revoked_reason !== 'ROTATED') return { kind: 'invalid' };
      // A used refresh token was presented again: assume theft, end every session of this app.
      const revoked = await query<{ id: string }>(
        client,
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'REUSE_DETECTED'
         WHERE user_id = $1 AND app = $2 AND revoked_at IS NULL
         RETURNING id`,
        [current.user_id, current.app]
      );
      return { kind: 'reused', revokedIds: revoked.map((row) => row.id) };
    }
    if (current.expires_at.getTime() <= Date.now()) return { kind: 'expired' };
    if (current.status !== 'ACTIVE') return { kind: 'suspended' };

    const next = await createSession(client, {
      userId: current.user_id,
      app: current.app,
      deviceId: current.device_id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = now(), revoked_reason = 'ROTATED', replaced_by = $2, last_used_at = now()
       WHERE id = $1`,
      [current.id, next.sessionId]
    );
    return { kind: 'ok', tokens: next.tokens };
  });

  switch (outcome.kind) {
    case 'ok':
      return outcome.tokens;
    case 'reused':
      await markRevoked(outcome.revokedIds);
      throw new AppError(401, 'SESSION_REVOKED', 'تم إنهاء الجلسة لأسباب أمنية، سجّل الدخول مجددًا');
    case 'suspended':
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'تم إيقاف هذا الحساب، تواصل مع الدعم');
    default:
      throw new AppError(401, 'SESSION_INVALID', 'انتهت الجلسة، سجّل الدخول مجددًا');
  }
}
