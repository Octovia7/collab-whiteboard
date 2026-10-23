import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbUrl } from '../integration/db';

/**
 * The E2E server runs as a plain `node` process the tests control, so they can SIGKILL it
 * (a real crash: no graceful flush or snapshot) and start it again on the same port.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER_PORT = 3101;
export const CLIENT_ORIGIN = 'http://127.0.0.1:5199';
export const E2E_DB_URL = dbUrl('whiteboard_e2e');
export const SERVER_LOG = resolve(ROOT, 'test-results/e2e-server.log');
const PID_FILE = resolve(ROOT, 'test-results/e2e-server.pid');
const HEALTH = `http://127.0.0.1:${SERVER_PORT}/api/health`;

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(HEALTH)).ok;
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

/** Starts the server (with optional extra env, e.g. fault injection) and waits for /api/health. */
export async function startServer(env: Record<string, string> = {}): Promise<void> {
  if (await healthy()) throw new Error(`something is already serving on port ${SERVER_PORT}`);
  mkdirSync(dirname(SERVER_LOG), { recursive: true });
  const log = openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: resolve(ROOT, 'packages/server'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(SERVER_PORT),
      DATABASE_URL: E2E_DB_URL,
      ALLOWED_ORIGINS: CLIENT_ORIGIN,
      BCRYPT_COST: '4', // fast sign-ups in tests; production uses 12
      JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
      ...env,
    },
    stdio: ['ignore', log, log],
  });
  if (!child.pid) throw new Error('failed to spawn the server');
  writeFileSync(PID_FILE, String(child.pid));
  await until(healthy, 'the server to become healthy');
}

/** SIGKILL: the process dies instantly, mid-whatever it was doing. */
export async function killServer(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await until(async () => !(await healthy()), 'the server to stop');
}

export async function restartServer(env: Record<string, string> = {}): Promise<void> {
  await killServer();
  await startServer(env);
}

/** Server log lines (pino JSON) written since `offset` characters into the log file. */
export function serverLogSince(offset: number): Record<string, unknown>[] {
  const text = existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8').slice(offset) : '';
  return text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function serverLogLength(): number {
  return existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8').length : 0;
}
