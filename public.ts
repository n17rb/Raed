import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validation';
import { readUpload } from '../lib/multipart';
import { Errors } from '../lib/errors';
import { toLatinDigits } from '../lib/phone';
import { latLngSchema } from '../lib/geo';
import { authOf, requireAuth } from '../auth/guards';
import { deviceSchema } from '../account/devices';
import {
  addFavoritePlace,
  listAvailablePromos,
  listNotifications,
  listRecentSearches,
  listSavedPlaces,
  markAllNotificationsRead,
  markNotificationRead,
  placeInputSchema,
  recordRecentSearch,
  removeSavedPlace,
  setFixedPlace,
  updateAvatar,
  upsertDevice,
} from '../account/service';
import {
  cancelWithdrawal,
  earningsSummary,
  getWalletSummary,
  listTransactions,
  listTransferProofs,
  listWithdrawals,
  requestWithdrawal,
  submitTransferProof,
  withdrawalSchema,
} from '../wallet/service';
import { listCategories, listModelYears, searchMakes, searchModels } from '../vehicles/catalog';
import { getPublicConfig, listActiveAdvertisements } from '../content/service';
import { autocomplete, nearbyPlaces, placeDetails, reverseGeocode } from '../maps/places';
import { getRoute } from '../maps/routes';
import { nearbyCaptains } from '../maps/nearby';
import { getMessages, markDelivered, markRead, sendMessage } from '../chat/service';
import { createTicket, getMyTicket, listMyTickets, sendUserMessage } from '../support/service';
import { iceServers, phoneCall } from '../calls/service';
import { getSharedTrip, sharePageHtml } from '../share/service';

const idParams = z.object({ id: z.string().uuid() });
const cursorQuery = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function appUser(request: FastifyRequest): { userId: string; app: 'CUSTOMER' | 'CAPTAIN' } {
  const auth = authOf(request);
  if (auth.app !== 'CUSTOMER' && auth.app !== 'CAPTAIN') throw Errors.forbidden();
  return { userId: auth.userId, app: auth.app };
}

function captainOnly(request: FastifyRequest): string {
  const auth = authOf(request);
  if (auth.app !== 'CAPTAIN') throw Errors.forbidden();
  return auth.userId;
}

/** Account, notifications, places, wallet (customer & captain). */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth('CUSTOMER', 'CAPTAIN'));

  app.post('/avatar', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request) => {
    const upload = await readUpload(request);
    return updateAvatar(appUser(request).userId, upload.buffer);
  });

  app.post('/devices', async (request) => {
    const user = appUser(request);
    return upsertDevice(user.userId, user.app, parseInput(deviceSchema, request.body));
  });

  app.get('/notifications', async (request) => {
    const params = parseInput(cursorQuery, request.query);
    return listNotifications(appUser(request).userId, params.before ? new Date(params.before) : null, params.limit);
  });

  app.post('/notifications/:id/read', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return markNotificationRead(appUser(request).userId, id);
  });

  app.post('/notifications/read-all', async (request) => markAllNotificationsRead(appUser(request).userId));

  app.get('/promo-codes', async (request) => ({ items: await listAvailablePromos(appUser(request).userId) }));

  app.get('/places/saved', async (request) => ({ items: await listSavedPlaces(appUser(request).userId) }));

  app.put('/places/saved/:kind', async (request) => {
    const { kind } = parseInput(z.object({ kind: z.enum(['HOME', 'WORK', 'UNIVERSITY']) }), request.params);
    return setFixedPlace(appUser(request).userId, kind, parseInput(placeInputSchema, request.body));
  });

  app.post('/places/saved', async (request, reply) => {
    return reply.status(201).send(await addFavoritePlace(appUser(request).userId, parseInput(placeInputSchema, request.body)));
  });

  app.delete('/places/saved/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return removeSavedPlace(appUser(request).userId, id);
  });

  app.get('/places/recent', async (request) => ({ items: await listRecentSearches(appUser(request).userId) }));

  app.post('/places/recent', async (request) => {
    const body = parseInput(
      z.object({
        title: z.string().trim().min(1).max(120),
        subtitle: z.string().trim().max(200).optional(),
        googlePlaceId: z.string().max(300).optional(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
      request.body
    );
    return recordRecentSearch(appUser(request).userId, body);
  });

  // ---------- Wallet ----------

  app.get('/wallet', async (request) => {
    const user = appUser(request);
    return getWalletSummary(user.userId, user.app);
  });

  app.get('/wallet/transactions', async (request) => {
    const user = appUser(request);
    const params = parseInput(cursorQuery, request.query);
    return listTransactions(user.userId, user.app, params.before ? new Date(params.before) : null, params.limit);
  });

  app.post('/wallet/transfer-proofs', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const captainId = captainOnly(request);
    const upload = await readUpload(request);
    const fields = parseInput(
      z.object({
        amountFils: z
          .string()
          .transform((value) => Number.parseInt(toLatinDigits(value), 10))
          .pipe(z.number().int().min(100).max(10_000_000)),
        referenceNumber: z.string().trim().max(60).optional(),
        transferredAt: z.string().datetime().optional(),
        note: z.string().trim().max(300).optional(),
      }),
      upload.fields
    );
    const proof = await submitTransferProof(captainId, {
      buffer: upload.buffer,
      amountFils: fields.amountFils,
      referenceNumber: fields.referenceNumber ?? null,
      transferredAt: fields.transferredAt ? new Date(fields.transferredAt) : null,
      note: fields.note ?? null,
    });
    return reply.status(201).send(proof);
  });

  app.get('/wallet/transfer-proofs', async (request) => ({ items: await listTransferProofs(captainOnly(request)) }));

  app.post('/wallet/withdrawals', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const captainId = captainOnly(request);
    return reply.status(201).send(await requestWithdrawal(captainId, parseInput(withdrawalSchema, request.body)));
  });

  app.get('/wallet/withdrawals', async (request) => ({ items: await listWithdrawals(captainOnly(request)) }));

  app.post('/wallet/withdrawals/:id/cancel', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return cancelWithdrawal(captainOnly(request), id);
  });

  app.get('/earnings', async (request) => {
    const { period } = parseInput(z.object({ period: z.enum(['today', 'week', 'month']).default('today') }), request.query);
    return earningsSummary(captainOnly(request), period);
  });
};

/** Vehicle catalog for captain registration and the dashboard. */
export const vehicleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth());

  app.get('/makes', async (request) => {
    const { q } = parseInput(z.object({ q: z.string().max(40).default('') }), request.query);
    return { items: await searchMakes(q) };
  });

  app.get('/models', async (request) => {
    const params = parseInput(z.object({ q: z.string().max(40).default(''), makeId: z.string().uuid().optional() }), request.query);
    return { items: await searchModels(params.q, params.makeId ?? null) };
  });

  app.get('/models/:id/years', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { years: await listModelYears(id) };
  });

  app.get('/categories', async () => ({ items: await listCategories() }));
};

/** Public config + advertisements. */
export const contentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/config', async () => getPublicConfig());
  app.get('/advertisements', { preHandler: requireAuth('CUSTOMER', 'CAPTAIN') }, async () => listActiveAdvertisements());
};

/** Google Places / Geocoding through the server (API keys never reach the apps for these calls). */
export const mapsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth());
  const sessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

  app.post('/autocomplete', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const body = parseInput(
      z.object({ input: z.string().trim().min(2).max(100), sessionToken: sessionTokenSchema.optional(), near: latLngSchema.optional() }),
      request.body
    );
    return autocomplete({ text: body.input, sessionToken: body.sessionToken, near: body.near });
  });

  app.get('/places/:placeId', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const { placeId } = parseInput(z.object({ placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/) }), request.params);
    const { sessionToken } = parseInput(z.object({ sessionToken: sessionTokenSchema.optional() }), request.query);
    return placeDetails(placeId, sessionToken);
  });

  app.post('/nearby', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    return nearbyPlaces(parseInput(latLngSchema, request.body));
  });

  app.post('/reverse-geocode', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    return reverseGeocode(parseInput(latLngSchema, request.body));
  });

  /** Road route preview (home screen line between the user and the chosen point). */
  app.post('/route', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = parseInput(z.object({ origin: latLngSchema, destination: latLngSchema }), request.body);
    const route = await getRoute(body.origin, body.destination);
    return { polyline: route.polyline, distanceM: route.distanceM, durationS: route.durationS, approximate: route.approximate };
  });

  /** Approximate positions of available captains around a point (no identities). */
  app.post('/nearby-captains', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = parseInput(latLngSchema.extend({ categoryId: z.string().uuid().optional() }), request.body);
    return { items: await nearbyCaptains(body, body.categoryId ?? null) };
  });
};

/** Customer ↔ captain chat, calls, support center. */
export const communicationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth('CUSTOMER', 'CAPTAIN'));

  app.get('/chats/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const auth = authOf(request);
    const result = await getMessages(auth, id);
    await markDelivered(auth, id);
    return result;
  });

  app.post('/chats/:id/messages', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    return sendMessage(authOf(request), { ...(request.body as object), tripId: id });
  });

  app.post('/chats/:id/read', async (request) => {
    const { id } = parseInput(idParams, request.params);
    await markRead(authOf(request), { tripId: id });
    return { ok: true };
  });

  app.get('/calls/ice-servers', async () => ({ iceServers: iceServers() }));

  app.post('/calls/phone', async (request) => {
    const body = parseInput(z.object({ tripId: z.string().uuid() }), request.body);
    return phoneCall(authOf(request), body.tripId);
  });

  app.get('/support/tickets', async (request) => ({ items: await listMyTickets(authOf(request)) }));

  app.post('/support/tickets', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    return reply.status(201).send(await createTicket(authOf(request), request.body));
  });

  app.get('/support/tickets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return getMyTicket(authOf(request), id);
  });

  app.post('/support/tickets/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { id } = parseInput(idParams, request.params);
    return sendUserMessage(authOf(request), id, request.body);
  });
};

/** Public trip-share page (no login). */
export const shareRoutes: FastifyPluginAsync = async (app) => {
  app.get('/share/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = parseInput(z.object({ token: z.string().max(80) }), request.params);
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(sharePageHtml(token));
  });

  app.get('/share/:token/data', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = parseInput(z.object({ token: z.string().max(80) }), request.params);
    return reply.header('Cache-Control', 'no-store').send(await getSharedTrip(token));
  });
};
