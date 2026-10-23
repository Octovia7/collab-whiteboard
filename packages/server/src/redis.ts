import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';

/**
 * Shared Redis connection. Today it backs /readyz; milestone 8 adds pub/sub between servers,
 * the INCR seq counter and the snapshot lock on top of it.
 *
 * Every command has a timeout and limited retries, and reconnects back off up to 5 s, so a
 * Redis outage makes /readyz fail fast instead of hanging requests.
 */
export function connectRedis(url: string, log: FastifyBaseLogger): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 2,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  let lastWarn = 0;
  // Without an 'error' listener ioredis would crash the process on connection errors.
  redis.on('error', (err) => {
    const now = Date.now();
    if (now - lastWarn > 10_000) {
      lastWarn = now;
      log.warn({ err: { message: err.message } }, 'redis connection error');
    }
  });
  redis.connect().catch(() => {}); // failures are retried by retryStrategy and logged above
  return redis;
}
