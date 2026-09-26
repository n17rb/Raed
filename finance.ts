import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, query, queryOne, withTransaction } from '../../db/pool';
import { parseInput } from '../../lib/validation';
import { AppError, Errors } from '../../lib/errors';
import { likeEscape, pageOffset, pageQuerySchema, paged } from '../../lib/pagination';
import { readUpload } from '../../lib/multipart';
import { formatJod } from '../../pricing/pricing';
import { requirePermission } from '../../auth/guards';
import { audit, auditContext } from '../../audit/audit';
import { mediaUrlById, storeImage } from '../../media/service';
import { notifyUser } from '../../notifications/service';
import { emitToUser } from '../../realtime/io';
import { postLedger } from '../../wallet/ledger';
import { TRANSACTION_LABELS_AR } from '../../wallet/service';

const idParams = z.object({ id: z.string().uuid() });

export const adminFinanceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/wallets', { preHandler: requirePermission('wallets.view') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ owner: z.enum(['CAPTAIN', 'CUSTOMER', 'PLATFORM']).default('CAPTAIN') }), request.query);
    const { limit, offset } = pageOffset(params);
    const q = params.q ? `%${likeEscape(params.q)}%` : null;
    const where = `WHERE w.owner_type = $1 AND ($2::text IS NULL OR u.full_name ILIKE $2 OR u.phone ILIKE $2)`;
    const from = `FROM wallets w LEFT JOIN users u ON u.id = w.owner_user_id`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count ${from} ${where}`, [params.owner, q]);
    const rows = await query<{
      id: string;
      owner_user_id: string | null;
      name: string | null;
      phone: string | null;
      balance_fils: number;
      negative_limit_fils: number;
      status: string;
      updated_at: Date;
    }>(
      pool,
      `SELECT w.id, w.owner_user_id, u.full_name AS name, u.phone, w.balance_fils, w.negative_limit_fils, w.status, w.updated_at
       ${from} ${where} ORDER BY w.balance_fils ASC LIMIT $3 OFFSET $4`,
      [params.owner, q, limit, offset]
    );
    return paged(
      rows.map((row) => ({
        id: row.id,
        ownerId: row.owner_user_id,
        name: row.name,
        phone: row.phone,
        balanceFils: row.balance_fils,
        balance: formatJod(row.balance_fils),
        negativeLimit: formatJod(row.negative_limit_fils),
        belowLimit: row.balance_fils < -row.negative_limit_fils,
        status: row.status,
        updatedAt: row.updated_at,
      })),
      total?.count ?? 0,
      params
    );
  });

  app.get('/transactions', { preHandler: requirePermission('wallets.view') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ walletId: z.string().uuid().optional(), type: z.string().max(40).optional() }), request.query);
    const { limit, offset } = pageOffset(params);
    const where = `WHERE ($1::uuid IS NULL OR t.wallet_id = $1) AND ($2::text IS NULL OR t.type = $2)`;
    const total = await queryOne<{ count: number }>(pool, `SELECT count(*)::int AS count FROM wallet_transactions t ${where}`, [
      params.walletId ?? null,
      params.type ?? null,
    ]);
    const rows = await query<{
      id: string;
      wallet_id: string;
      owner_type: string;
      owner_name: string | null;
      direction: string;
      amount_fils: number;
      balance_after_fils: number;
      type: string;
      description: string | null;
      trip_id: string | null;
      created_by_name: string | null;
      created_at: Date;
    }>(
      pool,
      `SELECT t.id, t.wallet_id, w.owner_type, u.full_name AS owner_name, t.direction, t.amount_fils, t.balance_after_fils, t.type,
              t.description, t.trip_id, cb.full_name AS created_by_name, t.created_at
       FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id
       LEFT JOIN users u ON u.id = w.owner_user_id LEFT JOIN users cb ON cb.id = t.created_by
       ${where} ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [params.walletId ?? null, params.type ?? null, limit, offset]
    );
    return paged(
      rows.map((row) => ({
        ...row,
        amount: formatJod(row.amount_fils),
        balanceAfter: formatJod(row.balance_after_fils),
        typeLabel: TRANSACTION_LABELS_AR[row.type] ?? row.type,
      })),
      total?.count ?? 0,
      params
    );
  });

  app.post('/wallets/:id/adjust', { preHandler: requirePermission('wallets.adjust') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({
        direction: z.enum(['CREDIT', 'DEBIT']),
        amountFils: z.number().int().min(1).max(10_000_000),
        reason: z.string().trim().min(3).max(500),
        idempotencyKey: z.string().min(8).max(64),
      }),
      request.body
    );
    const ctx = auditContext(request);
    const result = await withTransaction(async (client) => {
      const wallet = await queryOne<{ owner_user_id: string | null; owner_type: string; balance_fils: number }>(
        client,
        'SELECT owner_user_id, owner_type, balance_fils FROM wallets WHERE id = $1',
        [id]
      );
      if (!wallet) throw Errors.notFound('المحفظة غير موجودة');
      const txId = await postLedger(client, {
        walletId: id,
        direction: body.direction,
        amountFils: body.amountFils,
        type: 'ADMIN_ADJUSTMENT',
        description: body.reason,
        idempotencyKey: `admin-adjust:${body.idempotencyKey}`,
        createdBy: ctx.actorId,
      });
      await client.query(
        `INSERT INTO admin_adjustments (wallet_id, admin_user_id, direction, amount_fils, reason, wallet_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (wallet_transaction_id) DO NOTHING`,
        [id, ctx.actorId, body.direction, body.amountFils, body.reason, txId]
      );
      const after = await queryOne<{ balance_fils: number }>(client, 'SELECT balance_fils FROM wallets WHERE id = $1', [id]);
      await audit(client, ctx, 'WALLET_ADJUSTED', 'wallet', id, { balanceFils: wallet.balance_fils }, { ...body, balanceFils: after?.balance_fils });
      return { ownerId: wallet.owner_user_id, ownerType: wallet.owner_type, balanceFils: after?.balance_fils ?? 0 };
    });
    if (result.ownerId) {
      emitToUser(result.ownerId, 'wallet:updated', { balanceFils: result.balanceFils });
      void notifyUser(result.ownerId, {
        title: body.direction === 'CREDIT' ? 'تمت إضافة رصيد' : 'تم خصم رصيد',
        body: `${formatJod(body.amountFils)} د.أ · ${body.reason}`,
        inbox: true,
        app: result.ownerType === 'CAPTAIN' ? 'CAPTAIN' : 'CUSTOMER',
        data: { type: 'WALLET' },
      });
    }
    return { ok: true, balanceFils: result.balanceFils, balance: formatJod(result.balanceFils) };
  });

  app.patch('/wallets/:id', { preHandler: requirePermission('wallets.adjust') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(
      z.object({ negativeLimitFils: z.number().int().min(0).max(1_000_000).optional(), status: z.enum(['ACTIVE', 'FROZEN']).optional() }),
      request.body
    );
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const before = await queryOne(client, 'SELECT negative_limit_fils, status FROM wallets WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw Errors.notFound('المحفظة غير موجودة');
      await client.query(
        'UPDATE wallets SET negative_limit_fils = COALESCE($2, negative_limit_fils), status = COALESCE($3, status) WHERE id = $1',
        [id, body.negativeLimitFils ?? null, body.status ?? null]
      );
      await audit(client, ctx, 'WALLET_SETTINGS_CHANGED', 'wallet', id, before, body);
    });
    return { ok: true };
  });

  app.get('/payments', { preHandler: requirePermission('wallets.view') }, async (request) => {
    const params = parseInput(pageQuerySchema, request.query);
    const { limit, offset } = pageOffset(params);
    const total = await queryOne<{ count: number }>(pool, 'SELECT count(*)::int AS count FROM trip_payments', []);
    const rows = await query<{
      id: string;
      trip_id: string;
      code: string;
      customer_name: string | null;
      captain_name: string | null;
      method: string;
      amount_fils: number;
      status: string;
      commission_fils: number | null;
      collected_at: Date | null;
    }>(
      pool,
      `SELECT p.id, p.trip_id, t.code, cu.full_name AS customer_name, cap.full_name AS captain_name, p.method, p.amount_fils, p.status,
              ce.commission_fils, p.collected_at
       FROM trip_payments p JOIN trips t ON t.id = p.trip_id JOIN users cu ON cu.id = p.customer_id JOIN users cap ON cap.id = p.captain_id
       LEFT JOIN captain_earnings ce ON ce.trip_id = p.trip_id
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return paged(
      rows.map((row) => ({ ...row, amount: formatJod(row.amount_fils), commission: formatJod(row.commission_fils ?? 0) })),
      total?.count ?? 0,
      params
    );
  });

  // ---------------- Transfer proofs (captain top-ups) ----------------

  app.get('/transfer-proofs', { preHandler: requirePermission('transfers.review') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), request.query);
    const { limit, offset } = pageOffset(params);
    const total = await queryOne<{ count: number }>(pool, 'SELECT count(*)::int AS count FROM transfer_proofs WHERE ($1::text IS NULL OR status = $1)', [
      params.status ?? null,
    ]);
    const rows = await query<{
      id: string;
      captain_id: string;
      captain_name: string | null;
      captain_phone: string | null;
      amount_fils: number;
      media_id: string;
      reference_number: string | null;
      transferred_at: Date | null;
      note: string | null;
      status: string;
      rejection_reason: string | null;
      created_at: Date;
      reviewed_at: Date | null;
    }>(
      pool,
      `SELECT p.id, p.captain_id, u.full_name AS captain_name, u.phone AS captain_phone, p.amount_fils, p.media_id, p.reference_number,
              p.transferred_at, p.note, p.status, p.rejection_reason, p.created_at, p.reviewed_at
       FROM transfer_proofs p JOIN users u ON u.id = p.captain_id
       WHERE ($1::text IS NULL OR p.status = $1)
       ORDER BY CASE p.status WHEN 'PENDING' THEN 0 ELSE 1 END, p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [params.status ?? null, limit, offset]
    );
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        captainId: row.captain_id,
        captainName: row.captain_name,
        captainPhone: row.captain_phone,
        amountFils: row.amount_fils,
        amount: formatJod(row.amount_fils),
        imageUrl: await mediaUrlById(row.media_id),
        referenceNumber: row.reference_number,
        transferredAt: row.transferred_at,
        note: row.note,
        status: row.status,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
      }))
    );
    return paged(items, total?.count ?? 0, params);
  });

  app.post('/transfer-proofs/:id/approve', { preHandler: requirePermission('transfers.review') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ amountFils: z.number().int().min(1).max(10_000_000).optional() }), request.body ?? {});
    const ctx = auditContext(request);
    const result = await withTransaction(async (client) => {
      const proof = await queryOne<{ captain_id: string; wallet_id: string; amount_fils: number; status: string }>(
        client,
        'SELECT captain_id, wallet_id, amount_fils, status FROM transfer_proofs WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!proof) throw Errors.notFound('الحوالة غير موجودة');
      if (proof.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'تمت مراجعة هذه الحوالة مسبقًا');
      const amount = body.amountFils ?? proof.amount_fils;
      const txId = await postLedger(client, {
        walletId: proof.wallet_id,
        direction: 'CREDIT',
        amountFils: amount,
        type: 'TOP_UP_TRANSFER',
        referenceType: 'transfer_proof',
        referenceId: id,
        description: 'شحن رصيد بحوالة',
        idempotencyKey: `transfer:${id}`,
        createdBy: ctx.actorId,
      });
      await client.query(
        `UPDATE transfer_proofs SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(), wallet_transaction_id = $3, amount_fils = $4 WHERE id = $1`,
        [id, ctx.actorId, txId, amount]
      );
      await audit(client, ctx, 'TRANSFER_APPROVED', 'transfer_proof', id, { status: 'PENDING', amountFils: proof.amount_fils }, { amountFils: amount });
      return { captainId: proof.captain_id, amount };
    });
    emitToUser(result.captainId, 'wallet:updated', {});
    void notifyUser(result.captainId, {
      title: 'تم شحن رصيدك',
      body: `أضيف ${formatJod(result.amount)} د.أ إلى محفظتك`,
      inbox: true,
      app: 'CAPTAIN',
      data: { type: 'WALLET' },
    });
    return { ok: true };
  });

  app.post('/transfer-proofs/:id/reject', { preHandler: requirePermission('transfers.review') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ reason: z.string().trim().min(2).max(300) }), request.body);
    const ctx = auditContext(request);
    const captainId = await withTransaction(async (client) => {
      const proof = await queryOne<{ captain_id: string; status: string }>(client, 'SELECT captain_id, status FROM transfer_proofs WHERE id = $1 FOR UPDATE', [id]);
      if (!proof) throw Errors.notFound('الحوالة غير موجودة');
      if (proof.status !== 'PENDING') throw new AppError(409, 'ALREADY_REVIEWED', 'تمت مراجعة هذه الحوالة مسبقًا');
      await client.query(`UPDATE transfer_proofs SET status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3 WHERE id = $1`, [
        id,
        ctx.actorId,
        body.reason,
      ]);
      await audit(client, ctx, 'TRANSFER_REJECTED', 'transfer_proof', id, { status: 'PENDING' }, body);
      return proof.captain_id;
    });
    void notifyUser(captainId, { title: 'تم رفض الحوالة', body: body.reason, inbox: true, app: 'CAPTAIN', data: { type: 'WALLET' } });
    return { ok: true };
  });

  // ---------------- Withdrawals ----------------

  app.get('/withdrawals', { preHandler: requirePermission('withdrawals.review') }, async (request) => {
    const params = parseInput(pageQuerySchema.extend({ status: z.enum(['REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED']).optional() }), request.query);
    const { limit, offset } = pageOffset(params);
    const total = await queryOne<{ count: number }>(pool, 'SELECT count(*)::int AS count FROM withdrawals WHERE ($1::text IS NULL OR status = $1)', [
      params.status ?? null,
    ]);
    const rows = await query<{
      id: string;
      captain_id: string;
      captain_name: string | null;
      captain_phone: string | null;
      amount_fils: number;
      method: string;
      destination_details: Record<string, unknown>;
      status: string;
      rejection_reason: string | null;
      proof_media_id: string | null;
      created_at: Date;
      paid_at: Date | null;
    }>(
      pool,
      `SELECT w.id, w.captain_id, u.full_name AS captain_name, u.phone AS captain_phone, w.amount_fils, w.method, w.destination_details,
              w.status, w.rejection_reason, w.proof_media_id, w.created_at, w.paid_at
       FROM withdrawals w JOIN users u ON u.id = w.captain_id
       WHERE ($1::text IS NULL OR w.status = $1)
       ORDER BY CASE w.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, w.created_at DESC
       LIMIT $2 OFFSET $3`,
      [params.status ?? null, limit, offset]
    );
    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        captainId: row.captain_id,
        captainName: row.captain_name,
        captainPhone: row.captain_phone,
        amountFils: row.amount_fils,
        amount: formatJod(row.amount_fils),
        method: row.method,
        destination: row.destination_details,
        status: row.status,
        rejectionReason: row.rejection_reason,
        proofUrl: await mediaUrlById(row.proof_media_id),
        createdAt: row.created_at,
        paidAt: row.paid_at,
      }))
    );
    return paged(items, total?.count ?? 0, params);
  });

  app.post('/withdrawals/:id/approve', { preHandler: requirePermission('withdrawals.review') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    await withTransaction(async (client) => {
      const row = await queryOne<{ status: string }>(client, 'SELECT status FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw Errors.notFound('طلب السحب غير موجود');
      if (row.status !== 'REQUESTED') throw new AppError(409, 'INVALID_STATUS', 'لا يمكن الموافقة على هذا الطلب');
      await client.query(`UPDATE withdrawals SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, ctx.actorId]);
      await audit(client, ctx, 'WITHDRAWAL_APPROVED', 'withdrawal', id, row, { status: 'APPROVED' });
    });
    return { ok: true };
  });

  /** Marks a withdrawal as paid; optional multipart image of the bank/CliQ receipt. */
  app.post('/withdrawals/:id/paid', { preHandler: requirePermission('withdrawals.review') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const ctx = auditContext(request);
    let proofMediaId: string | null = null;
    if (request.isMultipart()) {
      const upload = await readUpload(request);
      proofMediaId = (await storeImage({ buffer: upload.buffer, purpose: 'TRANSFER_PROOF', uploadedBy: ctx.actorId })).id;
    }
    const captainId = await withTransaction(async (client) => {
      const row = await queryOne<{ status: string; captain_id: string; amount_fils: number }>(
        client,
        'SELECT status, captain_id, amount_fils FROM withdrawals WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!row) throw Errors.notFound('طلب السحب غير موجود');
      if (!['REQUESTED', 'APPROVED'].includes(row.status)) throw new AppError(409, 'INVALID_STATUS', 'لا يمكن تحديث هذا الطلب');
      await client.query(
        `UPDATE withdrawals SET status = 'PAID', paid_at = now(), proof_media_id = COALESCE($3, proof_media_id),
           reviewed_by = COALESCE(reviewed_by, $2), reviewed_at = COALESCE(reviewed_at, now()) WHERE id = $1`,
        [id, ctx.actorId, proofMediaId]
      );
      await audit(client, ctx, 'WITHDRAWAL_PAID', 'withdrawal', id, { status: row.status }, { status: 'PAID', proofMediaId });
      return row.captain_id;
    });
    void notifyUser(captainId, { title: 'تم تحويل أرباحك', body: 'تم تنفيذ طلب السحب بنجاح', inbox: true, app: 'CAPTAIN', data: { type: 'WALLET' } });
    return { ok: true };
  });

  app.post('/withdrawals/:id/reject', { preHandler: requirePermission('withdrawals.review') }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ reason: z.string().trim().min(2).max(300) }), request.body);
    const ctx = auditContext(request);
    const captainId = await withTransaction(async (client) => {
      const row = await queryOne<{ status: string; captain_id: string; wallet_id: string; amount_fils: number }>(
        client,
        'SELECT status, captain_id, wallet_id, amount_fils FROM withdrawals WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (!row) throw Errors.notFound('طلب السحب غير موجود');
      if (!['REQUESTED', 'APPROVED'].includes(row.status)) throw new AppError(409, 'INVALID_STATUS', 'لا يمكن رفض هذا الطلب');
      const reversalId = await postLedger(client, {
        walletId: row.wallet_id,
        direction: 'CREDIT',
        amountFils: row.amount_fils,
        type: 'WITHDRAWAL_REVERSAL',
        referenceType: 'withdrawal',
        referenceId: id,
        description: 'إرجاع مبلغ طلب سحب مرفوض',
        idempotencyKey: `withdrawal:${id}:reversal`,
        createdBy: ctx.actorId,
      });
      await client.query(
        `UPDATE withdrawals SET status = 'REJECTED', rejection_reason = $3, reversal_transaction_id = $4, reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
        [id, ctx.actorId, body.reason, reversalId]
      );
      await audit(client, ctx, 'WITHDRAWAL_REJECTED', 'withdrawal', id, { status: row.status }, body);
      return row.captain_id;
    });
    void notifyUser(captainId, { title: 'تم رفض طلب السحب', body: `${body.reason} · أعيد المبلغ لمحفظتك`, inbox: true, app: 'CAPTAIN', data: { type: 'WALLET' } });
    return { ok: true };
  });

  /** Used by the dashboard to create a unique key for each adjustment form submit. */
  app.get('/idempotency-key', { preHandler: requirePermission('wallets.adjust') }, async () => ({ key: randomUUID() }));
};
