import pg from 'pg';
import { env } from '../config/env';
import { AppError } from '../lib/errors';

// BIGINT columns (amounts in fils, counts) are returned as numbers.
// All values stay far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  application_name: 'rayed-api',
});

pool.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', msg: 'postgres pool error', error: error.message }));
});

export type Queryable = pg.Pool | pg.PoolClient;

interface MappedError {
  status: number;
  code: string;
  message: string;
}

const CONSTRAINT_ERRORS: Record<string, MappedError> = {
  ratings_once_per_direction: { status: 409, code: 'ALREADY_RATED', message: 'تم تقييم هذه الرحلة مسبقًا' },
  trips_one_active_per_customer: { status: 409, code: 'ACTIVE_TRIP_EXISTS', message: 'لديك رحلة جارية بالفعل' },
  trips_one_active_per_captain: { status: 409, code: 'CAPTAIN_BUSY', message: 'الكابتن في رحلة أخرى' },
  trip_dispatch_offers_one_pending_per_trip: { status: 409, code: 'OFFER_PENDING', message: 'يوجد عرض قائم لهذه الرحلة' },
  trip_dispatch_offers_one_pending_per_captain: { status: 409, code: 'CAPTAIN_HAS_OFFER', message: 'لدى الكابتن عرض قائم' },
  vehicles_plate_active_key: { status: 409, code: 'PLATE_EXISTS', message: 'رقم اللوحة مسجّل مسبقًا' },
  users_phone_active_key: { status: 409, code: 'PHONE_EXISTS', message: 'رقم الهاتف مسجّل مسبقًا' },
  admins_email_active_key: { status: 409, code: 'EMAIL_EXISTS', message: 'البريد الإلكتروني مسجّل مسبقًا' },
  promo_codes_code_active_key: { status: 409, code: 'PROMO_CODE_EXISTS', message: 'الكود موجود مسبقًا' },
  promo_codes_capacity: { status: 409, code: 'PROMO_CODE_EXHAUSTED', message: 'انتهى عدد استخدامات الكود' },
  vehicle_makes_name_key: { status: 409, code: 'MAKE_EXISTS', message: 'الشركة موجودة مسبقًا' },
  vehicle_models_name_key: { status: 409, code: 'MODEL_EXISTS', message: 'الموديل موجود مسبقًا' },
  vehicle_years_model_year_key: { status: 409, code: 'YEAR_EXISTS', message: 'السنة موجودة مسبقًا' },
  vehicle_categories_code_key: { status: 409, code: 'CATEGORY_EXISTS', message: 'رمز الفئة موجود مسبقًا' },
  roles_code_key: { status: 409, code: 'ROLE_EXISTS', message: 'رمز الدور موجود مسبقًا' },
};

const RAISED_ERRORS: Array<MappedError & { prefix: string }> = [
  { prefix: 'INVALID_TRIP_TRANSITION', status: 409, code: 'INVALID_TRIP_TRANSITION', message: 'لا يمكن تنفيذ هذا الإجراء في حالة الرحلة الحالية' },
  { prefix: 'INVALID_TRIP_INITIAL_STATUS', status: 409, code: 'INVALID_TRIP_TRANSITION', message: 'حالة الرحلة غير صحيحة' },
  { prefix: 'TRIP_FINALIZED', status: 409, code: 'TRIP_FINALIZED', message: 'الرحلة منتهية ولا يمكن تعديلها' },
  { prefix: 'TRIP_FARE_FINALIZED', status: 409, code: 'TRIP_FARE_FINALIZED', message: 'تم اعتماد سعر الرحلة ولا يمكن تعديله' },
  { prefix: 'TRIP_NOT_COMPLETED', status: 409, code: 'TRIP_NOT_COMPLETED', message: 'لا يمكن تقييم الرحلة قبل انتهائها' },
  { prefix: 'INSUFFICIENT_BALANCE', status: 409, code: 'INSUFFICIENT_BALANCE', message: 'الرصيد غير كافٍ' },
  { prefix: 'WALLET_FROZEN', status: 409, code: 'WALLET_FROZEN', message: 'المحفظة مجمّدة، تواصل مع الدعم' },
  { prefix: 'IMMUTABLE_RECORD', status: 409, code: 'IMMUTABLE_RECORD', message: 'لا يمكن تعديل أو حذف هذا السجل' },
];

export function mapDbError(error: unknown): unknown {
  if (error instanceof AppError || !(error instanceof Error)) return error;
  const pgError = error as Error & { code?: string; constraint?: string };

  if (pgError.constraint) {
    const mapped = CONSTRAINT_ERRORS[pgError.constraint];
    if (mapped) return new AppError(mapped.status, mapped.code, mapped.message);
  }
  for (const raised of RAISED_ERRORS) {
    if (pgError.message.startsWith(raised.prefix)) {
      return new AppError(raised.status, raised.code, raised.message);
    }
  }
  if (pgError.code === '40P01' || pgError.code === '40001') {
    return new AppError(409, 'CONCURRENT_UPDATE', 'تم تحديث البيانات للتو، حاول مرة أخرى');
  }
  if (pgError.code === '57014') {
    return new AppError(503, 'DATABASE_TIMEOUT', 'الخدمة مشغولة حاليًا، حاول مرة أخرى');
  }
  if (pgError.code === '23505') {
    return new AppError(409, 'CONFLICT', 'البيانات موجودة مسبقًا');
  }
  if (pgError.code === '23503') {
    return new AppError(409, 'IN_USE', 'لا يمكن تنفيذ العملية لأن العنصر مرتبط ببيانات أخرى');
  }
  return error;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  try {
    const result = await db.query<T>(text, params);
    return result.rows;
  } catch (error) {
    throw mapDbError(error);
  }
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

export interface TransactionOptions {
  actorId?: string | null;
  reason?: string | null;
}

/**
 * Runs fn inside a transaction. The actor id and reason are visible to
 * database triggers (trip status history).
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.actorId) {
      await client.query(`SELECT set_config('rayed.actor_id', $1, true)`, [options.actorId]);
    }
    if (options.reason) {
      await client.query(`SELECT set_config('rayed.transition_reason', $1, true)`, [options.reason]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw mapDbError(error);
  } finally {
    client.release();
  }
}
