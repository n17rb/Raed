import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';

export const loggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.code',
      '*.otp',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
};

let runtimeLogger: FastifyBaseLogger | null = null;

export function setRuntimeLogger(logger: FastifyBaseLogger): void {
  runtimeLogger = logger;
}

export function logError(message: string, error: unknown, context: Record<string, unknown> = {}): void {
  if (runtimeLogger) runtimeLogger.error({ err: error, ...context }, message);
  else console.error(message, error, context);
}

export function logWarn(message: string, context: Record<string, unknown> = {}): void {
  if (runtimeLogger) runtimeLogger.warn(context, message);
  else console.warn(message, context);
}

export function logInfo(message: string, context: Record<string, unknown> = {}): void {
  if (runtimeLogger) runtimeLogger.info(context, message);
  else console.log(message, context);
}
