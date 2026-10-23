/** Server settings, all from environment variables with development defaults. */
export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  /** Origins allowed to open a WebSocket (cross-site WebSocket hijacking guard). */
  allowedOrigins: string[];
  /** Secure cookies need HTTPS; off for local development. */
  cookieSecure: boolean;
  bcryptCost: number;
  /** A room with no sockets is snapshotted and dropped from memory after this long. */
  roomUnloadMs: number;
  /** Take a snapshot after this many ops since the last one... */
  snapshotEveryOps: number;
  /** ...or after this long with unsnapshotted ops. */
  snapshotEveryMs: number;
  logger: boolean;
  /**
   * Fault injection for E2E tests (ignored when NODE_ENV=production): hold every commit, or
   * every ack after its commit, for this many ms, so a test can kill the server in the window.
   */
  faults: { commitDelayMs: number; ackDelayMs: number };
}

const DEV_JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? (production ? '' : DEV_JWT_SECRET);
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  const num = (name: string, fallback: number) => {
    const raw = env[name];
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  return {
    port: num('PORT', 3001),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? 'postgres://whiteboard:whiteboard@127.0.0.1:55432/whiteboard',
    jwtSecret,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    cookieSecure: production,
    bcryptCost: num('BCRYPT_COST', 12),
    roomUnloadMs: num('ROOM_UNLOAD_MS', 60_000),
    snapshotEveryOps: num('SNAPSHOT_EVERY_OPS', 500),
    snapshotEveryMs: num('SNAPSHOT_EVERY_MS', 60_000),
    logger: env.LOG !== 'off',
    faults: production
      ? { commitDelayMs: 0, ackDelayMs: 0 }
      : { commitDelayMs: num('WB_FAULT_COMMIT_DELAY_MS', 0), ackDelayMs: num('WB_FAULT_ACK_DELAY_MS', 0) },
  };
}
