import type { FastifyBaseLogger } from 'fastify';
import type { OpStore, StoredOp } from './OpStore';
import type { Repo } from './repo';

const FLUSH_EVERY_MS = 50;
const FLUSH_AT_OPS = 200;
const MAX_RETRY_MS = 5_000;

interface Waiter {
  resolve: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Batched, durable op log (system-design.md, "OpWriter"). Ops from every room are buffered and
 * written with one multi-row INSERT every 50 ms or 200 ops, whichever comes first; each
 * `append` resolves only once its ops are committed, and the room acks only then.
 *
 * On a database error the batch is retried with backoff, forever: no acks go out meanwhile,
 * so clients keep the ops pending, and live relay to peers carries on. (The doc's "stop
 * accepting ops after 30 s" circuit breaker is not built yet.)
 */
export class OpWriter implements OpStore {
  private buffer: StoredOp[] = [];
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Flushes run one at a time, so a later batch never commits before an earlier one. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly repo: Repo,
    private readonly log: FastifyBaseLogger,
    private readonly commitDelayMs = 0,
  ) {}

  append(ops: StoredOp[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('OpWriter closed'));
    if (ops.length === 0) return Promise.resolve();
    this.buffer.push(...ops);
    const done = new Promise<void>((resolve) => this.waiters.push({ resolve }));
    if (this.buffer.length >= FLUSH_AT_OPS) this.flushNow();
    else this.timer ??= setTimeout(() => this.flushNow(), FLUSH_EVERY_MS);
    return done;
  }

  /** Resolves once everything appended so far is committed (the Snapshotter waits on this). */
  drain(): Promise<void> {
    if (this.buffer.length > 0) this.flushNow();
    return this.chain;
  }

  /** Graceful shutdown: commit what's buffered, then refuse new ops. */
  async close(): Promise<void> {
    await this.drain();
    this.closed = true;
  }

  private flushNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer;
    const waiters = this.waiters;
    this.buffer = [];
    this.waiters = [];
    if (batch.length === 0) return;
    this.chain = this.chain.then(async () => {
      await this.commit(batch);
      for (const w of waiters) w.resolve();
    });
  }

  private async commit(batch: StoredOp[]): Promise<void> {
    if (this.commitDelayMs > 0) await sleep(this.commitDelayMs); // fault injection (tests only)
    for (let attempt = 0; ; attempt++) {
      try {
        await this.repo.insertOps(batch);
        return;
      } catch (err) {
        const wait = Math.min(MAX_RETRY_MS, 100 * 2 ** attempt);
        this.log.error({ err, ops: batch.length, retryInMs: wait }, 'op batch insert failed; retrying');
        await sleep(wait);
      }
    }
  }
}
