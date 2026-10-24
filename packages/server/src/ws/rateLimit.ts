import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { closeSocket, openSocket, takeOpTokens } from '../redisState';

/**
 * Token bucket: holds up to `burst` tokens and refills at `perSec`. Taking n tokens succeeds
 * if they're there; otherwise the caller learns how long to wait. Allows short bursts (a
 * paste, a reconnect resend) while capping the sustained rate.
 *
 * Used per socket for the message limit, and as the fallback for the per-user op budget when
 * Redis is unreachable.
 */
export class TokenBucket {
  private tokens: number;
  private updated: number;

  constructor(
    private readonly perSec: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.updated = now();
  }

  /** Takes n tokens if available. Returns 0 on success, else the ms to wait before retrying. */
  take(n: number): number {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return 0;
    }
    return Math.ceil(((n - this.tokens) / this.perSec) * 1000);
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.updated) / 1000) * this.perSec);
    this.updated = t;
  }
}

/**
 * Per-user limits shared by all servers (system-design.md, "Security"): an op budget (Redis
 * token bucket `rl:ws:{userId}`) and a cap on open sockets (`sockets:{userId}`).
 */
export class UserLimits {
  /** Used only while Redis is unreachable, so a Redis blip throttles per server instead of not at all. */
  private readonly fallback = new Map<string, TokenBucket>();
  private lastWarn = 0;

  constructor(
    private readonly redis: Redis,
    private readonly opsPerSec: number,
    private readonly opsBurst: number,
    readonly maxSockets: number,
    /** A socket's entry expires this long after its server last refreshed it (a crashed server's sockets). */
    private readonly socketTtlMs: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Registers a socket; false if the user already has the maximum open. Throws if Redis is down (the upgrade then gets 503). */
  open(userId: string, connId: string): Promise<boolean> {
    return openSocket(this.redis, userId, connId, this.maxSockets, this.socketTtlMs);
  }

  close(userId: string, connId: string): void {
    // If this fails, the entry expires on its own once this server stops refreshing it.
    closeSocket(this.redis, userId, connId).catch(() => {});
  }

  /** Waits until the user may send `n` more ops (throttling, not rejecting). */
  async waitForOps(userId: string, n: number, onThrottled: () => void): Promise<void> {
    for (let wait = await this.take(userId, n); wait > 0; wait = await this.take(userId, n)) {
      onThrottled();
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async take(userId: string, n: number): Promise<number> {
    try {
      const wait = await takeOpTokens(this.redis, userId, n, this.opsPerSec, this.opsBurst);
      this.fallback.delete(userId);
      return wait;
    } catch (err) {
      const now = Date.now();
      if (now - this.lastWarn > 10_000) {
        this.lastWarn = now;
        this.log.warn({ err: { message: (err as Error).message } }, 'rate limit falling back to per-server buckets (Redis)');
      }
      let bucket = this.fallback.get(userId);
      if (!bucket) {
        bucket = new TokenBucket(this.opsPerSec, this.opsBurst);
        this.fallback.set(userId, bucket);
      }
      return bucket.take(n);
    }
  }
}
