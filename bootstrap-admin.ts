import { pool } from '../db/pool';
import { redis } from '../lib/redis';
import { ensureBootstrapAdmin } from '../auth/bootstrap';

/**
 * Creates the first SUPER_ADMIN (only when no admin exists yet).
 * The API also does this automatically on boot when the BOOTSTRAP_* variables are set.
 */
try {
  await ensureBootstrapAdmin((message) => console.log(message));
  console.log('Done.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
  await redis.quit();
}
