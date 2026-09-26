import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validation';
import { readUpload } from '../lib/multipart';
import { authOf, requireAuth } from '../auth/guards';
import { acceptOffer, getCurrentOffer, rejectOffer } from '../dispatch/engine';
import {
  cancelByCaptain,
  captainLocationSchema,
  completeTrip,
  getCaptainActiveTrip,
  getCaptainTrip,
  listCaptainRatings,
  markArrived,
  rateCustomer,
  setAvailability,
  startTrip,
  updateCaptainLocation,
} from '../captain/service';
import {
  CAPTAIN_DOCUMENT_TYPES,
  VEHICLE_DOCUMENT_TYPES,
  getOnboarding,
  uploadCaptainDocument,
  uploadVehicleDocument,
  upsertVehicle,
} from '../captain/onboarding';
import { listTripsFor } from '../trips/service';

const idParams = z.object({ id: z.string().uuid() });

export const captainRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth('CAPTAIN'));

  // ---------- Registration & verification ----------

  app.get('/onboarding', async (request) => getOnboarding(authOf(request).userId));

  app.post('/onboarding/documents', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request) => {
    const upload = await readUpload(request);
    const { type } = parseInput(z.object({ type: z.enum(CAPTAIN_DOCUMENT_TYPES) }), upload.fields);
    return uploadCaptainDocument(authOf(request).userId, type, upload.buffer);
  });

  app.post('/onboarding/vehicle', async (request) => {
    const body = parseInput(
      z.object({
        makeId: z.string().uuid(),
        modelId: z.string().uuid(),
        year: z.number().int().min(1980).max(2100),
        categoryId: z.string().uuid(),
        colorNameAr: z.string().trim().min(2).max(30),
        colorHex: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        plateNumber: z.string().trim().min(2).max(20),
      }),
      request.body
    );
    return upsertVehicle(authOf(request).userId, body);
  });

  app.post('/onboarding/vehicle/documents', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (request) => {
    const upload = await readUpload(request);
    const { type } = parseInput(z.object({ type: z.enum(VEHICLE_DOCUMENT_TYPES) }), upload.fields);
    return uploadVehicleDocument(authOf(request).userId, type, upload.buffer);
  });

  // ---------- Availability & location ----------

  app.post('/availability', async (request) => {
    const body = parseInput(z.object({ online: z.boolean(), location: captainLocationSchema.optional() }), request.body);
    return setAvailability(authOf(request).userId, body);
  });

  // REST fallback; the app normally sends locations over the socket.
  app.post('/location', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    await updateCaptainLocation(authOf(request).userId, request.body);
    return { ok: true };
  });

  // ---------- Trip offers ----------

  app.get('/offers/current', async (request) => ({ offer: await getCurrentOffer(authOf(request).userId) }));

  app.post('/offers/:id/accept', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return acceptOffer(authOf(request).userId, id);
  });

  app.post('/offers/:id/reject', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return rejectOffer(authOf(request).userId, id);
  });

  // ---------- Trips ----------

  app.get('/trips/active', async (request) => ({ trip: await getCaptainActiveTrip(authOf(request).userId) }));

  app.get('/trips', async (request) => {
    const params = parseInput(
      z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
      request.query
    );
    return listTripsFor('captain', authOf(request).userId, params.before ? new Date(params.before) : null, params.limit);
  });

  app.get('/trips/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return getCaptainTrip(authOf(request).userId, id);
  });

  app.post('/trips/:id/arrived', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return markArrived(authOf(request).userId, id);
  });

  app.post('/trips/:id/start', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return startTrip(authOf(request).userId, id);
  });

  app.post('/trips/:id/complete', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return completeTrip(authOf(request).userId, id);
  });

  app.post('/trips/:id/cancel', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ reason: z.string().trim().min(2).max(200) }), request.body);
    return cancelByCaptain(authOf(request).userId, id, body.reason);
  });

  app.post('/trips/:id/rating', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }), request.body);
    return rateCustomer(authOf(request).userId, id, body.stars, body.comment || null);
  });

  app.get('/ratings', async (request) => listCaptainRatings(authOf(request).userId, 30));
};
