import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomDigits(length: number): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += randomInt(0, 10).toString();
  }
  return output;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------- Passwords (scrypt; same format as database/seeds/seed.mjs) ----------

const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_N = 2 ** 17;

function scryptAsync(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...options, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_DEFAULTS;
  const hash = await scryptAsync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nText, rText, pText, saltB64, hashB64] = parts;
  if (!nText || !rText || !pText || !saltB64 || !hashB64) return false;

  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isInteger(N) || N < 2 || N > MAX_N || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Used when an account does not exist, so response time stays the same. */
export const DUMMY_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64, 1).toString('base64')}`;
