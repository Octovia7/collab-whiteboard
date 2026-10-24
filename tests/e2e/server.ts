import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbUrl, E2E_REDIS_URL } from '../integration/db';

/**
 * The E2E servers run the production bundle (packages/server/dist, from `pnpm build:e2e`) as
 * plain `node` processes the tests control, so they can SIGKILL one (a real crash: no graceful
 * flush or snapshot) and start it again on the same port.
 *
 * Two servers share the database and Redis, like two instances behind a load balancer.
 * Server 1 (:3101) is behind the Vite dev server on :5199 (the default baseURL), server 2
 * (:3102) behind :5200; a tab picks its server by which origin it opens. Cookies don't
 * depend on the port, so one login works on both.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export type ServerNo = 1 | 2;
export const SERVER_PORTS: Record<ServerNo, number> = { 1: 3101, 2: 3102 };
export const CLIENT_ORIGINS: Record<ServerNo, string> = { 1: 'http://127.0.0.1:5199', 2: 'http://127.0.0.1:5200' };
export const SERVER_PORT = SERVER_PORTS[1];
export const CLIENT_ORIGIN = CLIENT_ORIGINS[1];
export const E2E_DB_URL = dbUrl('whiteboard_e2e');
export const SERVER_LOG = resolve(ROOT, 'test-results/e2e-server.log');
const logFile = (n: ServerNo) => (n === 1 ? SERVER_LOG : resolve(ROOT, `test-results/e2e-server-${n}.log`));
const pidFile = (n: ServerNo) => resolve(ROOT, n === 1 ? 'test-results/e2e-server.pid' : `test-results/e2e-server-${n}.pid`);
const health = (n: ServerNo) => `http://127.0.0.1:${SERVER_PORTS[n]}/readyz`;
export const SERVER_BUNDLE = resolve(ROOT, 'packages/server/dist/index.js');
export const CLIENT_BUILD = resolve(ROOT, 'packages/client/dist-e2e/index.html');

async function healthy(n: ServerNo): Promise<boolean> {
  try {
    return (await fetch(health(n))).ok;
  } catch {
    return false;
  }
}

async function until(cond: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Starts a server (with optional extra env, e.g. fault injection) and waits for /readyz. */
export async function startServer(env: Record<string, string> = {}, n: ServerNo = 1): Promise<void> {
  if (await healthy(n)) throw new Error(`something is already serving on port ${SERVER_PORTS[n]}`);
  if (!existsSync(SERVER_BUNDLE)) throw new Error('no server bundle: run `pnpm build:e2e` (or `pnpm test:e2e`, which builds first)');
  mkdirSync(dirname(logFile(n)), { recursive: true });
  const log = openSync(logFile(n), 'a');
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: resolve(ROOT, 'packages/server'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // The bundle can't find drizzle/ relative to itself (the Docker image sets this too).
      MIGRATIONS_DIR: resolve(ROOT, 'packages/server/drizzle'),
      PORT: String(SERVER_PORTS[n]),
      SERVER_ID: `e2e-${n}`,
      DATABASE_URL: E2E_DB_URL,
      REDIS_URL: E2E_REDIS_URL,
      ALLOWED_ORIGINS: Object.values(CLIENT_ORIGINS).join(','),
      BCRYPT_COST: '4', // fast sign-ups in tests; production uses 12
      AUTH_RATE_LIMIT_PER_MIN: '1000', // every test context signs up a user from 127.0.0.1
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
      ...env,
    },
    stdio: ['ignore', log, log],
    // Detached: the server outlives whichever process started it. A test restarts it from its
    // Playwright worker, and Playwright replaces a worker after a failing test; a server tied
    // to the old worker died with it and took every later test down. It's stopped by PID instead.
    detached: true,
    windowsHide: true,
  });
  if (!child.pid) throw new Error('failed to spawn the server');
  writeFileSync(pidFile(n), String(child.pid));
  // A server that dies on startup fails right away (its reason is in the log), instead of after
  // the whole wait. The wait is generous for a machine short of memory.
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));
  try {
    await until(async () => {
      if (exited !== null) throw new Error(`server ${n} exited with code ${exited} during startup; see ${logFile(n)}`);
      return healthy(n);
    }, `server ${n} to become healthy`, 60_000);
  } finally {
    child.unref(); // don't keep the starting process alive for it
  }
}

/** SIGKILL: the process dies instantly, mid-whatever it was doing. */
export async function killServer(n: ServerNo = 1): Promise<void> {
  if (!existsSync(pidFile(n))) return;
  const pid = Number(readFileSync(pidFile(n), 'utf8'));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await until(async () => !(await healthy(n)), `server ${n} to stop`);
}

export async function restartServer(env: Record<string, string> = {}, n: ServerNo = 1): Promise<void> {
  await killServer(n);
  await startServer(env, n);
}

/** Server log lines (pino JSON) written since `offset` characters into the log file. */
export function serverLogSince(offset: number, n: ServerNo = 1): Record<string, unknown>[] {
  const text = existsSync(logFile(n)) ? readFileSync(logFile(n), 'utf8').slice(offset) : '';
  return text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function serverLogLength(n: ServerNo = 1): number {
  return existsSync(logFile(n)) ? readFileSync(logFile(n), 'utf8').length : 0;
}
