import { redis } from '../lib/redis';
import { haversineMeters, type LatLng } from '../lib/geo';
import { getRoute } from './routes';

export type EtaPhase = 'PICKUP' | 'DROPOFF';

interface EtaBase {
  distanceM: number;
  durationS: number;
  polyline: string | null;
}

const ROAD_FACTOR = 1.35;
const FALLBACK_SPEED_MPS = 35 / 3.6;
const key = (tripId: string, phase: EtaPhase) => `trip-eta:${tripId}:${phase}`;

/** One routing call per trip phase; later updates reuse its average speed. */
export async function setEtaBase(tripId: string, phase: EtaPhase, from: LatLng, to: LatLng): Promise<{ etaSeconds: number; polyline: string | null }> {
  const route = await getRoute(from, to);
  const base: EtaBase = { distanceM: route.distanceM, durationS: route.durationS, polyline: route.polyline };
  await redis.set(key(tripId, phase), JSON.stringify(base), 'EX', 3 * 3600).catch(() => undefined);
  return { etaSeconds: route.durationS, polyline: route.polyline };
}

export async function getEtaPolyline(tripId: string, phase: EtaPhase): Promise<string | null> {
  const cached = await redis.get(key(tripId, phase)).catch(() => null);
  if (!cached) return null;
  return (JSON.parse(cached) as EtaBase).polyline;
}

export async function estimateEta(tripId: string, phase: EtaPhase, from: LatLng, to: LatLng): Promise<number> {
  const cached = await redis.get(key(tripId, phase)).catch(() => null);
  if (!cached) return (await setEtaBase(tripId, phase, from, to)).etaSeconds;

  const base = JSON.parse(cached) as EtaBase;
  const speed = base.distanceM > 0 && base.durationS > 0 ? base.distanceM / base.durationS : FALLBACK_SPEED_MPS;
  const remainingM = haversineMeters(from, to) * ROAD_FACTOR;
  return Math.max(0, Math.round(remainingM / speed));
}

export async function clearEta(tripId: string): Promise<void> {
  await redis.del(key(tripId, 'PICKUP'), key(tripId, 'DROPOFF')).catch(() => undefined);
}
