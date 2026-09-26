import { env } from '../config/env';
import { pool, query } from '../db/pool';
import { logError, logWarn } from '../lib/logger';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android channel created by the apps: "default" or "trip-requests" (loud, captain app). */
  channelId?: 'default' | 'trip-requests' | 'trip-updates';
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  ttlSeconds?: number;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;

function isExpoToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

/** Sends through Expo Push (FCM on Android, APNs on iOS). Invalid tokens are revoked. */
export async function sendExpoPush(tokens: string[], message: PushMessage): Promise<{ sent: number; failed: number }> {
  const valid = [...new Set(tokens.filter(isExpoToken))];
  if (valid.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const invalidTokens: string[] = [];

  for (let index = 0; index < valid.length; index += CHUNK_SIZE) {
    const chunk = valid.slice(index, index + CHUNK_SIZE);
    const payload = chunk.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: message.sound === undefined ? 'default' : message.sound,
      channelId: message.channelId ?? 'default',
      priority: message.priority ?? 'high',
      ttl: message.ttlSeconds,
    }));

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      };
      if (env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        failed += chunk.length;
        logWarn('expo push rejected', { status: response.status });
        continue;
      }
      const body = (await response.json()) as { data?: ExpoTicket[] };
      (body.data ?? []).forEach((ticket, position) => {
        if (ticket.status === 'ok') {
          sent += 1;
        } else {
          failed += 1;
          if (ticket.details?.error === 'DeviceNotRegistered') {
            const token = chunk[position];
            if (token) invalidTokens.push(token);
          }
        }
      });
    } catch (error) {
      failed += chunk.length;
      logError('expo push failed', error);
    }
  }

  if (invalidTokens.length > 0) {
    await query(pool, 'UPDATE user_devices SET revoked_at = now() WHERE push_token = ANY($1::text[]) AND revoked_at IS NULL', [
      invalidTokens,
    ]).catch(() => undefined);
  }
  return { sent, failed };
}

export async function pushTokensFor(userIds: string[], app: 'CUSTOMER' | 'CAPTAIN' | null = null): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await query<{ push_token: string }>(
    pool,
    `SELECT push_token FROM user_devices
     WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL AND push_token IS NOT NULL
       AND ($2::text IS NULL OR app = $2)`,
    [userIds, app]
  );
  return rows.map((row) => row.push_token);
}
