import { z } from 'zod';

export interface LatLng {
  lat: number;
  lng: number;
}

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const SERVICE_BOUNDS = {
  JORDAN: { minLat: 29.18, maxLat: 33.38, minLng: 34.88, maxLng: 39.31 },
  KARAK: { minLat: 30.85, maxLat: 31.45, minLng: 35.45, maxLng: 36.1 },
} as const;

export type ServiceAreaMode = keyof typeof SERVICE_BOUNDS;

export function isInsideServiceArea(point: LatLng, mode: ServiceAreaMode): boolean {
  const bounds = SERVICE_BOUNDS[mode];
  return point.lat >= bounds.minLat && point.lat <= bounds.maxLat && point.lng >= bounds.minLng && point.lng <= bounds.maxLng;
}
