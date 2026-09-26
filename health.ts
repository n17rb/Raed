import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/pool';
import { redis } from '../lib/redis';

const startedAt = Date.now();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function check(fn: () => Promise<unknown>): Promise<'ok' | 'down'> {
  try {
    await withTimeout(fn(), 2000);
    return 'ok';
  } catch {
    return 'down';
  }
}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { config: { rateLimit: false } }, async () => ({ name: 'Rayed API', status: 'ok' }));

  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    const [database, cache] = await Promise.all([check(() => pool.query('SELECT 1')), check(() => redis.ping())]);
    const healthy = database === 'ok' && cache === 'ok';
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      api: 'ok',
      database,
      redis: cache,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  });
};
