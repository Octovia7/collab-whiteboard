import type { FastifyBaseLogger } from 'fastify';
import type { OpStore, StoredOp } from './OpStore';
import type { Repo } from './repo';

const FLUSH_EVERY_MS = 50;
const FLUSH_AT_OPS = 200;
const MAX_RETRY_MS = 5_000;

interface Waiter {
  ops: StoredOp[];
  resolve: (notStored: string[]) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface OpWriterOptions {
  /** Fault injection (tests only): wait this long before each commit. */
  commitDelayMs?: number;
  /** After this long of failing commits, saving is "paused" (system-design.md, "Postgres slow or down"). */
  pauseAfterMs?: number;
}

/**
 * Batched, durable op log (system-design.md, "OpWriter"). Ops from every room are buffered and
 * written with one multi-row INSERT every 50 ms or 200 ops, whichever comes first; each
 * `append` resolves only once its ops are committed, and the room acks only then.
 *
 * On a database error the batch is retried with backoff, forever: no acks go out meanwhile,
 * so clients keep the ops pending, and live relay to peers carries on. Once commits have been
 * failing for `pauseAfterMs` (30 s), the writer reports `paused`: rooms then stop accepting
 * ops and clients show "Saving paused". The first commit that succeeds reports `resumed`.
 */
export class OpWriter implements OpStore {
  private readonly listeners = new Set<(paused: boolean) => void>();
  /** Fault injection (tests only, via the fault control route): every commit attempt fails. */
  readonly faults = { failCommits: false };
  private buffer: StoredOp[] = [];
  private waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Flushes run one at a time, so a later batch never commits before an earlier one. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  /** performance.now() of the first failure in the current run of failures. */
  private failingSince: number | null = null;
  private pausedFlag = false;
  private readonly commitDelayMs: number;
  private readonly pauseAfterMs: number;

  constructor(
    private readonly repo: Repo,
    private readonly log: FastifyBaseLogger,
    options: OpWriterOptions = {},
  ) {
    this.commitDelayMs = options.commitDelayMs ?? 0;
    this.pauseAfterMs = options.pauseAfterMs ?? 30_000;
  }

  /** Called with true when saving pauses and false when it resumes. Returns an unsubscribe function. */
  onPausedChange(fn: (paused: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True while commits have been failing for longer than `pauseAfterMs`. */
  get paused(): boolean {
    return this.pausedFlag;
  }

  append(ops: StoredOp[]): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error('OpWriter closed'));
    if (ops.length === 0) return Promise.resolve([]);
    this.buffer.push(...ops);
    const done = new Promise<string[]>((resolve) => this.waiters.push({ ops, resolve }));
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
      const notStored = new Set(await this.commit(batch));
      for (const w of waiters) w.resolve(w.ops.filter((o) => notStored.has(o.opId)).map((o) => o.opId));
    });
  }

  /** Commits the batch, retrying until it succeeds; returns the opIds whose seq was taken. */
  private async commit(batch: StoredOp[]): Promise<string[]> {
    if (this.commitDelayMs > 0) await sleep(this.commitDelayMs); // fault injection (tests only)
    // The outage clock starts when the batch's first attempt starts, not at its first failure:
    // with Postgres frozen (not refusing), one attempt can hang for the query timeout times its
    // retries (~60 s) before failing. The watchdog pauses saving if the batch is still not
    // committed after pauseAfterMs, failed or not (found by the chaos test: a 40 s freeze never
    // showed "Saving paused").
    const firstAttemptAt = performance.now();
    const watchdog = setTimeout(() => this.failed(firstAttemptAt), this.pauseAfterMs);
    try {
      return await this.commitWithRetry(batch, firstAttemptAt);
    } finally {
      clearTimeout(watchdog);
    }
  }

  private async commitWithRetry(batch: StoredOp[], firstAttemptAt: number): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.faults.failCommits) throw new Error('fault injection: commit failed');
        const notStored = await this.repo.insertOps(batch);
        this.succeeded();
        if (notStored.length > 0) this.log.warn({ notStored: notStored.length }, 'ops not stored: seq already taken; their clients will resend');
        return notStored;
      } catch (err) {
        this.failed(firstAttemptAt);
        const wait = Math.min(MAX_RETRY_MS, 100 * 2 ** attempt);
        this.log.error({ err, ops: batch.length, retryInMs: wait }, 'op batch insert failed; retrying');
        // Wake up in time to notice the pause threshold even mid-backoff.
        await sleep(this.pausedFlag ? wait : Math.min(wait, Math.max(50, this.untilPause())));
      }
    }
  }

  private untilPause(): number {
    return this.failingSince === null ? this.pauseAfterMs : this.failingSince + this.pauseAfterMs - performance.now();
  }

  /** Commits have been failing (or hanging) since `since`; pause once that's pauseAfterMs ago. */
  private failed(since: number): void {
    this.failingSince ??= since;
    if (!this.pausedFlag && this.untilPause() <= 0) {
      this.pausedFlag = true;
      this.log.error({ failingForMs: Math.round(performance.now() - this.failingSince) }, 'saving paused: Postgres keeps failing');
      for (const fn of this.listeners) fn(true);
    }
  }

  private succeeded(): void {
    this.failingSince = null;
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    this.log.info('saving resumed');
    for (const fn of this.listeners) fn(false);
  }
}
