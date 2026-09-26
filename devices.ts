import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, queryOne } from '../db/pool';

export const deviceSchema = z
  .object({
    platform: z.enum(['ios', 'android', 'web']),
    pushToken: z.string().min(10).max(300).optional(),
    pushProvider: z.enum(['expo', 'fcm', 'apns', 'webpush']).optional(),
    appVersion: z.string().max(40).optional(),
    osVersion: z.string().max(40).optional(),
  })
  .strict();

export type DeviceInput = z.infer<typeof deviceSchema>;

/**
 * Registers or refreshes a device. A push token belongs to one user at a time,
 * so it is revoked from any other account that used the same phone before.
 */
export async function registerDevice(
  client: PoolClient,
  userId: string,
  app: 'CUSTOMER' | 'CAPTAIN' | 'ADMIN',
  device: DeviceInput | undefined
): Promise<string | null> {
  if (!device) return null;

  if (device.pushToken) {
    await query(
      client,
      `UPDATE user_devices SET revoked_at = now()
       WHERE push_token = $1 AND revoked_at IS NULL AND (user_id <> $2 OR app <> $3)`,
      [device.pushToken, userId, app]
    );
    const existing = await queryOne<{ id: string }>(
      client,
      'SELECT id FROM user_devices WHERE push_token = $1 AND revoked_at IS NULL',
      [device.pushToken]
    );
    if (existing) {
      await query(
        client,
        `UPDATE user_devices
         SET platform = $2, push_provider = $3, app_version = $4, os_version = $5, last_seen_at = now()
         WHERE id = $1`,
        [existing.id, device.platform, device.pushProvider ?? 'expo', device.appVersion ?? null, device.osVersion ?? null]
      );
      return existing.id;
    }
  }

  const row = await queryOne<{ id: string }>(
    client,
    `INSERT INTO user_devices (user_id, app, platform, push_provider, push_token, app_version, os_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      userId,
      app,
      device.platform,
      device.pushToken ? device.pushProvider ?? 'expo' : null,
      device.pushToken ?? null,
      device.appVersion ?? null,
      device.osVersion ?? null,
    ]
  );
  return row?.id ?? null;
}
