import { env } from '../config/env';
import { redis } from '../lib/redis';
import { AppError } from '../lib/errors';
import type { LatLng } from '../lib/geo';

function placesKey(): string {
  const key = env.GOOGLE_PLACES_API_KEY ?? env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new AppError(503, 'MAPS_NOT_CONFIGURED', 'البحث عن الأماكن غير مفعّل حاليًا');
  return key;
}

function geocodingKey(): string {
  const key = env.GOOGLE_MAPS_API_KEY ?? env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new AppError(503, 'MAPS_NOT_CONFIGURED', 'تحديد العنوان غير مفعّل حاليًا');
  return key;
}

const unavailable = () => new AppError(503, 'MAPS_UNAVAILABLE', 'تعذّر البحث حاليًا، حاول مرة أخرى');

interface AutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      distanceMeters?: number;
    };
  }>;
}

export interface PlaceSuggestion {
  placeId: string;
  title: string;
  subtitle: string | null;
  distanceM: number | null;
}

/** Google Places Autocomplete (New). The app debounces typing before calling this. */
export async function autocomplete(input: { text: string; sessionToken?: string | undefined; near?: LatLng | undefined }) {
  const text = input.text.trim();
  const cacheKey = `places:ac:${text.toLowerCase()}:${input.near ? `${input.near.lat.toFixed(2)},${input.near.lng.toFixed(2)}` : 'none'}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return { suggestions: JSON.parse(cached) as PlaceSuggestion[], attribution: 'Google' };

  const body: Record<string, unknown> = {
    input: text,
    languageCode: 'ar',
    regionCode: 'JO',
    includedRegionCodes: ['jo'],
  };
  if (input.sessionToken) body.sessionToken = input.sessionToken;
  if (input.near) {
    body.locationBias = { circle: { center: { latitude: input.near.lat, longitude: input.near.lng }, radius: 30000 } };
    body.origin = { latitude: input.near.lat, longitude: input.near.lng };
  }

  const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': placesKey() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response || !response.ok) throw unavailable();

  const data = (await response.json()) as AutocompleteResponse;
  const suggestions: PlaceSuggestion[] = [];
  for (const suggestion of data.suggestions ?? []) {
    const prediction = suggestion.placePrediction;
    if (!prediction?.placeId) continue;
    suggestions.push({
      placeId: prediction.placeId,
      title: prediction.structuredFormat?.mainText?.text ?? prediction.text?.text ?? '',
      subtitle: prediction.structuredFormat?.secondaryText?.text ?? null,
      distanceM: prediction.distanceMeters ?? null,
    });
  }
  await redis.set(cacheKey, JSON.stringify(suggestions), 'EX', 60).catch(() => undefined);
  return { suggestions, attribution: 'Google' };
}

interface PlaceDetailsResponse {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
}

export async function placeDetails(placeId: string, sessionToken?: string) {
  const cacheKey = `places:details:${placeId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as { placeId: string; title: string; address: string | null; lat: number; lng: number };

  const params = new URLSearchParams({ languageCode: 'ar' });
  if (sessionToken) params.set('sessionToken', sessionToken);
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${params.toString()}`, {
    headers: {
      'X-Goog-Api-Key': placesKey(),
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
    },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response) throw unavailable();
  if (response.status === 404) throw new AppError(404, 'PLACE_NOT_FOUND', 'المكان غير موجود');
  if (!response.ok) throw unavailable();

  const data = (await response.json()) as PlaceDetailsResponse;
  if (typeof data.location?.latitude !== 'number' || typeof data.location.longitude !== 'number') {
    throw new AppError(404, 'PLACE_NOT_FOUND', 'المكان غير موجود');
  }
  const result = {
    placeId: data.id ?? placeId,
    title: data.displayName?.text ?? data.formattedAddress ?? '',
    address: data.formattedAddress ?? null,
    lat: data.location.latitude,
    lng: data.location.longitude,
  };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400).catch(() => undefined);
  return result;
}

interface NearbyResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
}

/** Popular places around the user for the search screen. */
export async function nearbyPlaces(point: LatLng) {
  const cacheKey = `places:nearby:${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as { items: Array<{ placeId: string; title: string; address: string | null; lat: number; lng: number }> };

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': placesKey(),
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      languageCode: 'ar',
      regionCode: 'JO',
      maxResultCount: 10,
      rankPreference: 'POPULARITY',
      includedTypes: ['shopping_mall', 'university', 'hospital', 'restaurant', 'cafe', 'supermarket', 'tourist_attraction'],
      locationRestriction: { circle: { center: { latitude: point.lat, longitude: point.lng }, radius: 5000 } },
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response || !response.ok) throw unavailable();

  const data = (await response.json()) as NearbyResponse;
  const items = (data.places ?? [])
    .filter((place) => place.id && typeof place.location?.latitude === 'number' && typeof place.location.longitude === 'number')
    .map((place) => ({
      placeId: place.id as string,
      title: place.displayName?.text ?? place.formattedAddress ?? '',
      address: place.formattedAddress ?? null,
      lat: place.location?.latitude as number,
      lng: place.location?.longitude as number,
    }));
  const result = { items };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600).catch(() => undefined);
  return result;
}

interface GeocodeResponse {
  status?: string;
  results?: Array<{ formatted_address?: string; place_id?: string }>;
}

export async function reverseGeocode(point: LatLng) {
  const cacheKey = `geocode:${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached) as { address: string | null; placeId: string | null };

  const params = new URLSearchParams({
    latlng: `${point.lat},${point.lng}`,
    language: 'ar',
    key: geocodingKey(),
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response || !response.ok) throw unavailable();

  const data = (await response.json()) as GeocodeResponse;
  const first = data.results?.[0];
  const result = { address: first?.formatted_address ?? null, placeId: first?.place_id ?? null };
  await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400).catch(() => undefined);
  return result;
}
