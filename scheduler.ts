import { pool, query } from '../db/pool';
import { redis } from '../lib/redis';
import { logError, logInfo } from '../lib/logger';
import { getSetting } from '../settings/service';
import { emitToAdmins, emitToUser } from '../realtime/io';
import { dispatchSweep } from '../dispatch/engine';
import { expireRingingCalls } from '../calls/service';
import { deliverDueCampaigns } from '../notifications/service';

interface Job {
  name: string;
  everyMs: number;
  /** Only one API instance runs this job at a time (Redis lock). */
  singleton: boolean;
  run: () => Promise<void>;
}

/** Old GPS points are folded into trips.tracked_path, then removed (trips themselves are never deleted). */
async function archiveTripLocations(): Promise<void> {
  const settings = await getSetting('location');
  const trips = await query<{ id: string }>(
    pool,
    `SELECT id FROM trips
     WHERE locations_archived_at IS NULL
       AND status IN ('TRIP_COMPLETED', 'CANCELLED')
       AND COALESCE(completed_at, cancelled_at) < now() - make_interval(days => $1)
     LIMIT 200`,
    [settings.tripLocationRetentionDays]
  );
  for (const trip of trips) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE trips SET
           tracked_path = COALESCE(tracked_path, (
             SELECT CASE WHEN count(*) >= 2 THEN ST_MakeLine(location::geometry ORDER BY recorded_at)::geography END
             FROM trip_locations WHERE trip_id = $1)),
           locations_archived_at = now()
         WHERE id = $1`,
        [trip.id]
      );
      await client.query('DELETE FROM trip_locations WHERE trip_id = $1', [trip.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      logError('location archive failed', error, { tripId: trip.id });
    } finally {
      client.release();
    }
  }
  if (trips.length > 0) logInfo('trip locations archived', { trips: trips.length });
}

/** Captains whose app stopped sending locations are taken offline so they are not offered trips. */
async function offlineStaleCaptains(): Promise<void> {
  const rows = await query<{ user_id: string }>(
    pool,
    `UPDATE captains SET availability = 'OFFLINE'
     WHERE availability = 'ONLINE' AND (location_updated_at IS NULL OR location_updated_at < now() - interval '10 minutes')
       AND NOT EXISTS (SELECT 1 FROM trip_dispatch_offers o WHERE o.captain_id = captains.user_id AND o.response = 'PENDING')
     RETURNING user_id`
  );
  for (const row of rows) {
    emitToUser(row.user_id, 'captain:forced_offline', { reason: 'NO_LOCATION' });
    emitToAdmins('captain:availability', { captainId: row.user_id, availability: 'OFFLINE' });
  }
}

const JOBS: Job[] = [
  { name: 'dispatch', everyMs: 2000, singleton: false, run: dispatchSweep },
  { name: 'calls', everyMs: 15_000, singleton: true, run: expireRingingCalls },
  { name: 'campaigns', everyMs: 30_000, singleton: true, run: deliverDueCampaigns },
  { name: 'stale-captains', everyMs: 60_000, singleton: true, run: offlineStaleCaptains },
  { name: 'archive-locations', everyMs: 60 * 60_000, singleton: true, run: archiveTripLocations },
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

async function runJob(job: Job): Promise<void> {
  if (running.has(job.name)) return;
  running.add(job.name);
  try {
    if (job.singleton) {
      const lockKey = `job-lock:${job.name}`;
      const acquired = await redis.set(lockKey, '1', 'PX', Math.max(1000, job.everyMs - 500), 'NX').catch(() => null);
      if (acquired !== 'OK') return;
    }
    await job.run();
  } catch (error) {
    logError(`job ${job.name} failed`, error);
  } finally {
    running.delete(job.name);
  }
}

export function startJobs(): void {
  if (timers.length > 0) return;
  for (const job of JOBS) {
    const timer = setInterval(() => void runJob(job), job.everyMs);
    timer.unref();
    timers.push(timer);
  }
}

export function stopJobs(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}
