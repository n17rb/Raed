import { env } from './config/env';
import { pool } from './db/pool';
import { redis } from './lib/redis';
import { buildApp } from './app';
import { closeRealtime, initRealtime } from './realtime/io';
import { tripViewFor } from './trips/common';
import { updateCaptainLocation } from './captain/service';
import { markRead, sendMessage, typing } from './chat/service';
import { handleCallEvent } from './calls/service';
import { userTyping } from './support/service';
import { startJobs, stopJobs } from './jobs/scheduler';
import { ensureBootstrapAdmin } from './auth/bootstrap';

if (env.MIGRATE_ON_BOOT) {
  // Useful on hosting plans without a pre-deploy step. Safe with several instances (advisory lock).
  const { runMigrations } = await import('@rayed/database/scripts/migrate.mjs');
  await runMigrations();
}

await ensureBootstrapAdmin((message) => console.log(message));

if (process.env.ALLOW_DEMO_SEED === 'true' && process.env.DEMO_ADMIN_PHONE) {
  // Demo data for testing (idempotent). Remove ALLOW_DEMO_SEED before the public launch.
  const { seed } = await import('@rayed/database/seeds/seed.mjs');
  await seed().catch((error: unknown) => console.error('demo seed failed:', error instanceof Error ? error.message : error));
}

const app = await buildApp();

initRealtime(app, {
  canAccessTrip: (auth, tripId) => tripViewFor(tripId, { app: auth.app, userId: auth.userId }),
  onCaptainLocation: (captainId, payload) => updateCaptainLocation(captainId, payload),
  onChatSend: (auth, payload) => sendMessage(auth, payload),
  onChatTyping: (auth, payload) => typing(auth, payload),
  onChatRead: (auth, payload) => markRead(auth, payload),
  onCallEvent: (auth, event, payload) => handleCallEvent(auth, event, payload),
  onSupportTyping: (auth, payload) => userTyping(auth, payload),
});

if (env.NODE_ENV === 'production' && env.OTP_PROVIDER === 'demo') {
  app.log.warn('DEMO OTP is enabled in production (ALLOW_DEMO_OTP=true). Turn it off before the public launch.');
}
if (!env.GOOGLE_MAPS_API_KEY) {
  app.log.warn('GOOGLE_MAPS_API_KEY is not set: routes and prices use straight-line estimates.');
}

const port = env.PORT ?? env.API_PORT;
await app.listen({ host: '0.0.0.0', port });
startJobs();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    stopJobs();
    await closeRealtime();
    await app.close();
    await pool.end();
    await redis.quit();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
