import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnvFile = path.resolve(here, '../../../../.env');
if (existsSync(rootEnvFile)) {
  loadDotenv({ path: rootEnvFile });
}

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const csv = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    PORT: z.coerce.number().int().positive().optional(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    ADMIN_PUBLIC_URL: optionalText,
    CORS_ORIGINS: csv,
    MIGRATE_ON_BOOT: booleanFlag,

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: booleanFlag,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: z.string().min(1),

    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().regex(/^\d+[smhd]$/).default('15m'),
    JWT_REFRESH_TTL: z.string().regex(/^\d+[smhd]$/).default('30d'),

    OTP_PROVIDER: z.enum(['demo', 'sms', 'whatsapp']).default('demo'),
    DEMO_OTP_CODE: optionalText,
    // 4-digit demo code for the admin dashboard (admins sign in with phone + 4-digit OTP).
    DEMO_ADMIN_OTP_CODE: optionalText,
    // Temporary switch for testing on Render before WhatsApp/SMS is ready.
    ALLOW_DEMO_OTP: booleanFlag,

    WHATSAPP_ACCESS_TOKEN: optionalText,
    WHATSAPP_PHONE_NUMBER_ID: optionalText,
    WHATSAPP_TEMPLATE_NAME: optionalText,
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('ar'),

    TWILIO_ACCOUNT_SID: optionalText,
    TWILIO_AUTH_TOKEN: optionalText,
    TWILIO_FROM_NUMBER: optionalText,

    // Server keys for Google Routes / Geocoding and Places (New).
    GOOGLE_MAPS_API_KEY: optionalText,
    GOOGLE_PLACES_API_KEY: optionalText,
    // Browser key (restricted to the API domain) for the public trip-share page map.
    GOOGLE_MAPS_WEB_KEY: optionalText,

    // S3-compatible object storage (e.g. Cloudflare R2).
    STORAGE_ENDPOINT: optionalText,
    STORAGE_REGION: z.string().default('auto'),
    STORAGE_BUCKET_PUBLIC: optionalText,
    STORAGE_BUCKET_PRIVATE: optionalText,
    STORAGE_ACCESS_KEY: optionalText,
    STORAGE_SECRET_KEY: optionalText,
    STORAGE_PUBLIC_URL: optionalText,

    // Push notifications through Expo (FCM for Android / APNs for iOS are configured in EAS).
    EXPO_ACCESS_TOKEN: optionalText,

    // Internet calls (WebRTC)
    STUN_URLS: z
      .string()
      .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
      .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
    TURN_URLS: csv,
    TURN_USERNAME: optionalText,
    TURN_PASSWORD: optionalText,

    // Phone number of the first super admin (created once when no admin with a phone exists).
    BOOTSTRAP_SUPER_ADMIN_PHONE: optionalText,
    BOOTSTRAP_SUPER_ADMIN_NAME: optionalText,
  })
  .superRefine((value, ctx) => {
    if (value.OTP_PROVIDER === 'demo') {
      if (!/^\d{6}$/.test(value.DEMO_OTP_CODE ?? '')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEMO_OTP_CODE'], message: 'must be 6 digits when OTP_PROVIDER=demo' });
      }
      if (!/^\d{4}$/.test(value.DEMO_ADMIN_OTP_CODE ?? '')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEMO_ADMIN_OTP_CODE'], message: 'must be 4 digits when OTP_PROVIDER=demo' });
      }
      if (value.NODE_ENV === 'production' && !value.ALLOW_DEMO_OTP) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OTP_PROVIDER'], message: 'demo OTP in production requires ALLOW_DEMO_OTP=true' });
      }
    }
    if (value.OTP_PROVIDER === 'whatsapp') {
      for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_NAME'] as const) {
        if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when OTP_PROVIDER=whatsapp' });
      }
    }
    if (value.OTP_PROVIDER === 'sms') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'] as const) {
        if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when OTP_PROVIDER=sms' });
      }
    }
    const storageKeys = [
      'STORAGE_ENDPOINT',
      'STORAGE_BUCKET_PUBLIC',
      'STORAGE_BUCKET_PRIVATE',
      'STORAGE_ACCESS_KEY',
      'STORAGE_SECRET_KEY',
      'STORAGE_PUBLIC_URL',
    ] as const;
    const setCount = storageKeys.filter((key) => Boolean(value[key])).length;
    if (setCount > 0 && setCount < storageKeys.length) {
      for (const key of storageKeys) {
        if (!value[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'all STORAGE_* values are required together' });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  console.error(`Invalid environment variables:\n${problems}`);
  process.exit(1);
}

const data = parsed.data;
const origins = new Set(data.CORS_ORIGINS);
if (data.ADMIN_PUBLIC_URL) origins.add(data.ADMIN_PUBLIC_URL.replace(/\/+$/, ''));

export const env = { ...data, CORS_ORIGINS: [...origins] };
export type Env = typeof env;
export const isProduction = env.NODE_ENV === 'production';
