import type { PoolClient } from 'pg';
import { query, queryOne } from '../db/pool';

export type LedgerType =
  | 'TRIP_EARNING'
  | 'TRIP_COMMISSION'
  | 'TRIP_PAYMENT'
  | 'TOP_UP_TRANSFER'
  | 'ADMIN_ADJUSTMENT'
  | 'WITHDRAWAL'
  | 'WITHDRAWAL_REVERSAL'
  | 'PROMO_CREDIT'
  | 'CANCELLATION_FEE'
  | 'REFUND'
  | 'REVERSAL';

export async function getWalletId(
  client: PoolClient,
  ownerType: 'CUSTOMER' | 'CAPTAIN' | 'PLATFORM',
  userId: string | null
): Promise<string> {
  if (ownerType === 'PLATFORM') {
    await query(
      client,
      `INSERT INTO wallets (owner_type, negative_limit_fils) VALUES ('PLATFORM', 1000000000)
       ON CONFLICT (owner_type) WHERE owner_type = 'PLATFORM' DO NOTHING`
    );
    const row = await queryOne<{ id: string }>(client, `SELECT id FROM wallets WHERE owner_type = 'PLATFORM'`);
    if (!row) throw new Error('Platform wallet missing');
    return row.id;
  }

  await query(
    client,
    `INSERT INTO wallets (owner_user_id, owner_type) VALUES ($1, $2)
     ON CONFLICT (owner_user_id, owner_type) WHERE owner_user_id IS NOT NULL DO NOTHING`,
    [userId, ownerType]
  );
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM wallets WHERE owner_user_id = $1 AND owner_type = $2',
    [userId, ownerType]
  );
  if (!row) throw new Error(`${ownerType} wallet missing`);
  return row.id;
}

export interface LedgerEntry {
  walletId: string;
  direction: 'CREDIT' | 'DEBIT';
  amountFils: number;
  type: LedgerType;
  tripId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  description: string;
  idempotencyKey: string;
  createdBy?: string | null;
}

/** Posts one immutable ledger line. Posting the same idempotency key twice is a no-op. */
export async function postLedger(client: PoolClient, entry: LedgerEntry): Promise<string> {
  if (!Number.isInteger(entry.amountFils) || entry.amountFils <= 0) {
    throw new Error('Ledger amount must be a positive integer');
  }
  const existing = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM wallet_transactions WHERE idempotency_key = $1',
    [entry.idempotencyKey]
  );
  if (existing) return existing.id;

  const row = await queryOne<{ id: string }>(
    client,
    `INSERT INTO wallet_transactions
       (wallet_id, direction, amount_fils, type, trip_id, reference_type, reference_id, description, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      entry.walletId,
      entry.direction,
      entry.amountFils,
      entry.type,
      entry.tripId ?? null,
      entry.referenceType ?? null,
      entry.referenceId ?? null,
      entry.description,
      entry.idempotencyKey,
      entry.createdBy ?? null,
    ]
  );
  if (!row) throw new Error('Failed to post ledger entry');
  return row.id;
}
