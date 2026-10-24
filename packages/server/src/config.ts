import { z } from 'zod';

/**
 * All server configuration comes from environment variables, validated here at startup.
 * The server refuses to start with missing or invalid config (index.ts prints the issues).
 * Development and test get convenient defaults; production gets none for anything that
 * matters (database, Redis, JWT secret, allowed origins). See .env.example.
 */

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const origins = z
  .string()
  .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean))
  .pipe(z.array(z.string().url()).min(1, 'at least one origin'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(0, 65535).default(3001),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgres:// URL'),
  REDIS_URL: z.string().url().refine((u) => /^rediss?:\/\//.test(u), 'must be a redis:// URL'),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Origins allowed to call the API (CORS) and open WebSockets (CSWSH guard). */
  ALLOWED_ORIGINS: origins,
  /** Secure cookies need HTTPS (browsers also accept them on http://localhost). */
  COOKIE_SECURE: bool.optional(),
  /** Behind a reverse proxy (nginx): take the client IP from X-Forwarded-For, for rate limits and logs. */
  TRUST_PROXY: bool.default('false'),
  BCRYPT_COST: int(4, 15).default(12),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ROOM_UNLOAD_MS: int(0).default(60_000),
  SNAPSHOT_EVERY_OPS: int(1).default(500),
  SNAPSHOT_EVERY_MS: int(1).default(60_000),
  /** Login and signup attempts per IP per minute. */
  AUTH_RATE_LIMIT_PER_MIN: int(1).default(10),
  /** system-design.md, "Sizes and limits": ops per user per second (throttled, then disconnected). */
  WS_OPS_PER_SEC: int(1).default(200),
  WS_OPS_BURST: int(100).default(1000),
  WS_MSGS_PER_SEC: int(1).default(50),
  WS_MSGS_BURST: int(1).default(200),
  WS_MAX_SOCKETS_PER_USER: int(1).default(5),
  /** Presence: drop a socket after this long without any message (clients send a heartbeat every 5 s). */
  PRESENCE_TIMEOUT_MS: int(1000).default(15_000),
  PRESENCE_SWEEP_MS: int(100).default(5_000),
  /** Tombstones older than this (since their delete committed) are removed at snapshot time. */
  TOMBSTONE_TTL_MS: int(0).default(24 * 60 * 60 * 1000),
  /** If set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Where the SQL migrations are; defaults to packages/server/drizzle. */
  MIGRATIONS_DIR: z.string().min(1).optional(),
  // Fault injection for E2E tests; rejected outright in production.
  WB_FAULT_COMMIT_DELAY_MS: int(0).default(0),
  WB_FAULT_ACK_DELAY_MS: int(0).default(0),
});

const DEV_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgres://whiteboard:whiteboard@127.0.0.1:55432/whiteboard',
  REDIS_URL: 'redis://127.0.0.1:56379',
  JWT_SECRET: 'dev-only-secret-change-me-dev-only-secret',
  ALLOWED_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174',
};

export interface Config {
  production: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  bcryptCost: number;
  logLevel: string;
  roomUnloadMs: number;
  snapshotEveryOps: number;
  snapshotEveryMs: number;
  authRateLimitPerMin: number;
  ws: { opsPerSec: number; opsBurst: number; msgsPerSec: number; msgsBurst: number; maxSocketsPerUser: number };
  presence: { timeoutMs: number; sweepMs: number };
  tombstoneTtlMs: number;
  metricsToken: string | undefined;
  migrationsDir: string | undefined;
  /** Fault injection for E2E tests; always zero in production. */
  faults: { commitDelayMs: number; ackDelayMs: number };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const production = env.NODE_ENV === 'production';
  // Empty strings count as unset, so `FOO=` in an env file doesn't sneak past validation.
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(production ? given : { ...DEV_DEFAULTS, ...given });
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  const c = parsed.data;
  if (production && (c.WB_FAULT_COMMIT_DELAY_MS > 0 || c.WB_FAULT_ACK_DELAY_MS > 0)) {
    throw new ConfigError(['WB_FAULT_*: fault injection is not allowed in production']);
  }
  if (production && c.JWT_SECRET === DEV_DEFAULTS.JWT_SECRET) {
    throw new ConfigError(['JWT_SECRET: the development secret must not be used in production']);
  }
  return {
    production,
    port: c.PORT,
    host: c.HOST,
    databaseUrl: c.DATABASE_URL,
    redisUrl: c.REDIS_URL,
    jwtSecret: c.JWT_SECRET,
    allowedOrigins: c.ALLOWED_ORIGINS,
    cookieSecure: c.COOKIE_SECURE ?? production,
    trustProxy: c.TRUST_PROXY,
    bcryptCost: c.BCRYPT_COST,
    logLevel: c.LOG_LEVEL,
    roomUnloadMs: c.ROOM_UNLOAD_MS,
    snapshotEveryOps: c.SNAPSHOT_EVERY_OPS,
    snapshotEveryMs: c.SNAPSHOT_EVERY_MS,
    authRateLimitPerMin: c.AUTH_RATE_LIMIT_PER_MIN,
    ws: {
      opsPerSec: c.WS_OPS_PER_SEC,
      opsBurst: c.WS_OPS_BURST,
      msgsPerSec: c.WS_MSGS_PER_SEC,
      msgsBurst: c.WS_MSGS_BURST,
      maxSocketsPerUser: c.WS_MAX_SOCKETS_PER_USER,
    },
    presence: { timeoutMs: c.PRESENCE_TIMEOUT_MS, sweepMs: c.PRESENCE_SWEEP_MS },
    tombstoneTtlMs: c.TOMBSTONE_TTL_MS,
    metricsToken: c.METRICS_TOKEN,
    migrationsDir: c.MIGRATIONS_DIR,
    faults: { commitDelayMs: c.WB_FAULT_COMMIT_DELAY_MS, ackDelayMs: c.WB_FAULT_ACK_DELAY_MS },
  };
}
