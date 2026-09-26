import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

export type AppKind = 'CUSTOMER' | 'CAPTAIN' | 'ADMIN';
const APP_KINDS: readonly AppKind[] = ['CUSTOMER', 'CAPTAIN', 'ADMIN'];

const ISSUER = 'rayed-api';
const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export interface AccessClaims {
  userId: string;
  app: AppKind;
  sessionId: string;
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

export const accessTokenTtlSeconds = Math.floor(durationToMs(env.JWT_ACCESS_TTL) / 1000);

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ app: claims.app, sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(accessKey);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessKey, { issuer: ISSUER, algorithms: ['HS256'] });
  const app = payload.app;
  const sessionId = payload.sid;
  if (
    typeof payload.sub !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof app !== 'string' ||
    !APP_KINDS.includes(app as AppKind)
  ) {
    throw new Error('Invalid token claims');
  }
  return { userId: payload.sub, app: app as AppKind, sessionId };
}
