import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../lib/validation';
import { AppError } from '../lib/errors';
import { normalizeJordanPhone, toLatinDigits } from '../lib/phone';
import { deviceSchema } from '../account/devices';
import { requestOtp } from '../auth/otp/service';
import { getProfile, loginAdminWithOtp, loginWithOtp, logout, updateName } from '../auth/service';
import { rotateSession } from '../auth/sessions';
import { authOf, requireAuth } from '../auth/guards';

const loginAppSchema = z.enum(['CUSTOMER', 'CAPTAIN']);

const codeSchema = z
  .string()
  .transform((value) => toLatinDigits(value).trim())
  .pipe(z.string().regex(/^\d{6}$/));

/** Admin dashboard codes are 4 digits. */
const adminCodeSchema = z
  .string()
  .transform((value) => toLatinDigits(value).trim())
  .pipe(z.string().regex(/^\d{4}$/, 'الرمز 4 أرقام'));

function requirePhone(raw: string): string {
  const phone = normalizeJordanPhone(raw);
  if (!phone) {
    throw new AppError(400, 'INVALID_PHONE', 'رقم الهاتف غير صحيح. اكتب رقمًا أردنيًا مثل 0791234567');
  }
  return phone;
}

function metaOf(request: FastifyRequest) {
  return {
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/otp/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
    const body = parseInput(z.object({ phone: z.string().min(6).max(24), app: loginAppSchema }), request.body);
    return requestOtp({ phone: requirePhone(body.phone), app: body.app, ip: request.ip });
  });

  app.post('/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const body = parseInput(
      z.object({
        phone: z.string().min(6).max(24),
        app: loginAppSchema,
        code: codeSchema,
        device: deviceSchema.optional(),
      }),
      request.body
    );
    return loginWithOtp({ phone: requirePhone(body.phone), app: body.app, code: body.code, device: body.device }, metaOf(request));
  });

  app.post('/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = parseInput(z.object({ refreshToken: z.string().min(20).max(200) }), request.body);
    const tokens = await rotateSession(body.refreshToken, metaOf(request));
    return { tokens };
  });

  app.post('/logout', { preHandler: requireAuth() }, async (request) => {
    await logout(authOf(request));
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth() }, async (request) => getProfile(authOf(request)));

  app.patch('/me', { preHandler: requireAuth('CUSTOMER', 'CAPTAIN') }, async (request) => {
    const body = parseInput(z.object({ fullName: z.string().trim().min(2).max(40) }), request.body);
    return updateName(authOf(request).userId, body.fullName);
  });

  // ---------------- Admin dashboard: phone + 4-digit OTP ----------------

  app.post('/admin/otp/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
    const body = parseInput(z.object({ phone: z.string().min(6).max(24) }), request.body);
    return requestOtp({ phone: requirePhone(body.phone), app: 'ADMIN', ip: request.ip });
  });

  app.post('/admin/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const body = parseInput(z.object({ phone: z.string().min(6).max(24), code: adminCodeSchema }), request.body);
    return loginAdminWithOtp({ phone: requirePhone(body.phone), code: body.code }, metaOf(request));
  });
};
