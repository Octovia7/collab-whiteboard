/** An error with a known HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// node-postgres / network error codes that mean "the database is (briefly) unreachable",
// as opposed to a bug or a constraint violation.
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08001',
  '08003',
  '08004',
  '08006',
]);
const TRANSIENT_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection timeout/i,
  /query read timeout/i,
  // ioredis, while Redis is unreachable
  /connection is closed/i,
  /max retries per request/i,
  /command timed out/i,
  /stream isn't writeable/i,
];

/**
 * True for errors worth retrying: lost or refused connections, timeouts, shutdowns.
 * Drizzle wraps driver errors, so the whole `cause` chain is checked.
 */
export function isTransient(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const { code, message, cause } = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    if (typeof message === 'string' && TRANSIENT_MESSAGES.some((re) => re.test(message))) return true;
    e = cause;
  }
  return false;
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
}

/**
 * Retries `fn` on transient errors with exponential backoff and jitter. Only for operations
 * that are safe to repeat (reads, upserts, ON CONFLICT DO NOTHING inserts, idempotent updates).
 */
export async function withRetry<T>(fn: () => Promise<T>, { retries = 3, baseMs = 100, maxMs = 2000 }: RetryOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      // Full jitter: many servers retrying at once don't all hit the database together.
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
  }
}
