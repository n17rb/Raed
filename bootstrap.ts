import { env } from '../config/env';
import { pool, queryOne, withTransaction } from '../db/pool';
import { normalizeJordanPhone } from '../lib/phone';
import { writeAudit } from '../audit/audit';

/**
 * Creates the first SUPER_ADMIN from BOOTSTRAP_SUPER_ADMIN_PHONE (and optional _NAME),
 * only when no active admin has a phone number yet. Admins sign in with phone + 4-digit OTP.
 * Runs on every boot and does nothing afterwards.
 */
export async function ensureBootstrapAdmin(log: (message: string) => void): Promise<void> {
  const raw = env.BOOTSTRAP_SUPER_ADMIN_PHONE;
  if (!raw) return;
  const phone = normalizeJordanPhone(raw);
  if (!phone) {
    log('BOOTSTRAP_SUPER_ADMIN_PHONE is not a valid Jordanian mobile number — first admin not created');
    return;
  }
  const name = env.BOOTSTRAP_SUPER_ADMIN_NAME?.trim() || 'المدير العام';

  const existing = await queryOne<{ one: number }>(pool, 'SELECT 1 AS one FROM admins WHERE deleted_at IS NULL AND phone IS NOT NULL LIMIT 1');
  if (existing) return;

  const created = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(7260926)');
    const again = await queryOne<{ one: number }>(client, 'SELECT 1 AS one FROM admins WHERE deleted_at IS NULL AND phone IS NOT NULL LIMIT 1');
    if (again) return false;
    const user = await queryOne<{ id: string }>(client, `INSERT INTO users (full_name) VALUES ($1) RETURNING id`, [name]);
    if (!user) throw new Error('Failed to create user');
    await client.query(`INSERT INTO admins (user_id, phone, must_change_password) VALUES ($1, $2, false)`, [user.id, phone]);
    await client.query(`INSERT INTO admin_roles (admin_user_id, role_id) SELECT $1, id FROM roles WHERE code = 'SUPER_ADMIN'`, [user.id]);
    await writeAudit(client, {
      actorId: user.id,
      actorRole: 'SYSTEM',
      action: 'SUPER_ADMIN_BOOTSTRAPPED',
      entityType: 'admin',
      entityId: user.id,
      after: { phone, name },
    });
    return true;
  });
  if (created) log(`First super admin created for ${phone}. Sign in to the dashboard with this number and the OTP code.`);
}
