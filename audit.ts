import type { FastifyRequest } from 'fastify';
import { query, type Queryable } from '../db/pool';

export interface AuditEntry {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await query(
    db,
    `INSERT INTO audit_logs
       (actor_id, actor_role, action, entity_type, entity_id, before_data, after_data, ip_address, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      entry.actorId,
      entry.actorRole,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
    ]
  );
}

/** Who did it, from where: used by admin routes for every sensitive action. */
export interface AuditContext {
  actorId: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export function auditContext(request: FastifyRequest): AuditContext {
  if (!request.auth) throw new Error('auditContext requires an authenticated request');
  return {
    actorId: request.auth.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export async function audit(
  db: Queryable,
  ctx: AuditContext,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown
): Promise<void> {
  await writeAudit(db, {
    actorId: ctx.actorId,
    actorRole: 'ADMIN',
    action,
    entityType,
    entityId,
    before,
    after,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}
