import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env';
import { loggerOptions, setRuntimeLogger } from './lib/logger';
import { redis } from './lib/redis';
import { AppError } from './lib/errors';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { tripRoutes } from './routes/trips';
import { captainRoutes } from './routes/captain';
import { accountRoutes, communicationRoutes, contentRoutes, mapsRoutes, shareRoutes, vehicleRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function buildApp() {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => randomUUID(),
    bodyLimit: 1_048_576,
  });

  setRuntimeLogger(app.log);
  app.decorateRequest('auth', null);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Mobile apps send no Origin header; browsers must be on the allow list.
      if (!origin || env.CORS_ORIGINS.includes(origin)) callback(null, true);
      else callback(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'rate-limit:',
    skipOnError: true,
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20, fieldSize: 5000 },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler<Error & { statusCode?: number; validation?: unknown; code?: string }>((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, 'request failed');
      }
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id },
      });
    }
    if (error instanceof ZodError || error.validation) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'البيانات المدخلة غير صحيحة', requestId: request.id },
      });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({
        error: { code: 'TOO_MANY_REQUESTS', message: 'محاولات كثيرة، حاول بعد قليل', requestId: request.id },
      });
    }
    if (status === 413 || error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({
        error: { code: 'FILE_TOO_LARGE', message: 'حجم الملف أكبر من 10 ميجابايت', requestId: request.id },
      });
    }
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: 'BAD_REQUEST', message: 'طلب غير صالح', requestId: request.id },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع، حاول مرة أخرى', requestId: request.id },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود', requestId: request.id } })
  );

  await app.register(healthRoutes);
  await app.register(shareRoutes);
  await app.register(contentRoutes, { prefix: '/api/v1' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(accountRoutes, { prefix: '/api/v1/me' });
  await app.register(communicationRoutes, { prefix: '/api/v1' });
  await app.register(tripRoutes, { prefix: '/api/v1/trips' });
  await app.register(captainRoutes, { prefix: '/api/v1/captain' });
  await app.register(vehicleRoutes, { prefix: '/api/v1/vehicles' });
  await app.register(mapsRoutes, { prefix: '/api/v1/maps' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });

  return app;
}
