import { Redis } from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  connectTimeout: 5000,
});

redis.on('error', (error) => {
  console.error(JSON.stringify({ level: 'error', msg: 'redis error', error: error.message }));
});
