/**
 * Token bucket: holds up to `burst` tokens and refills at `perSec`. Taking n tokens succeeds
 * if they're there; otherwise the caller learns how long to wait. Allows short bursts (a
 * paste, a reconnect resend) while capping the sustained rate.
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

/** Per-user op budgets, shared by all of a user's sockets on this server (Redis-backed in milestone 8). */
export class UserLimits {
  private readonly buckets = new Map<string, { bucket: TokenBucket; sockets: number }>();

  constructor(
    private readonly opsPerSec: number,
    private readonly opsBurst: number,
    readonly maxSockets: number,
  ) {}

  /** Registers a socket; false if the user already has the maximum open. */
  open(userId: string): boolean {
    const entry = this.buckets.get(userId) ?? { bucket: new TokenBucket(this.opsPerSec, this.opsBurst), sockets: 0 };
    if (entry.sockets >= this.maxSockets) return false;
    entry.sockets++;
    this.buckets.set(userId, entry);
    return true;
  }

  close(userId: string): void {
    const entry = this.buckets.get(userId);
    if (!entry) return;
    entry.sockets--;
    if (entry.sockets <= 0) this.buckets.delete(userId);
  }

  /** Waits until the user may send `n` more ops (throttling, not rejecting). */
  async waitForOps(userId: string, n: number, onThrottled: () => void): Promise<void> {
    const entry = this.buckets.get(userId);
    if (!entry) return;
    for (let wait = entry.bucket.take(n); wait > 0; wait = entry.bucket.take(n)) {
      onThrottled();
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
