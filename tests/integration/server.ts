import type { AddressInfo } from 'node:net';
import type { Writable } from 'node:stream';
import { WebSocket as NodeWebSocket } from 'ws';
import { buildApp } from '../../packages/server/src/app';
import type { App } from '../../packages/server/src/app';
import { loadConfig } from '../../packages/server/src/config';
import { BoardStore } from '../../packages/client/src/store/BoardStore';
import { Presence } from '../../packages/client/src/store/Presence';
import { SyncClient } from '../../packages/client/src/sync/SyncClient';
import type { SyncOptions } from '../../packages/client/src/sync/SyncClient';
import type { Op } from '@whiteboard/shared';
import { TEST_REDIS_URL, dbUrl, flushRedis, truncateAll } from './db';

export const DB_URL = dbUrl('whiteboard_test');
export const ORIGIN = 'http://test.local';

export interface TestServer extends App {
  base: string;
  port: number;
  close(): Promise<void>;
}

/** A real server on a random port (or a given one, to "restart" on the same address). */
export async function startServer(env: Record<string, string> = {}, port = 0, options: { logStream?: Writable } = {}): Promise<TestServer> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    REDIS_URL: TEST_REDIS_URL,
    LOG_LEVEL: 'silent',
    BCRYPT_COST: '4', // fast hashing in tests; production uses 12
    AUTH_RATE_LIMIT_PER_MIN: '1000', // tests sign up many users from one IP; the limit has its own test
    ALLOWED_ORIGINS: ORIGIN,
    ...env,
  });
  const built = await buildApp(config, options);
  await built.app.listen({ port, host: '127.0.0.1' });
  const actual = (built.app.server.address() as AddressInfo).port;
  return { ...built, port: actual, base: `http://127.0.0.1:${actual}`, close: () => built.app.close() };
}

export const resetDb = async () => {
  await truncateAll(DB_URL);
  await flushRedis(TEST_REDIS_URL);
};

/** Signs up a user and returns its session cookie. */
export async function signUp(server: TestServer, email: string) {
  const res = await server.app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, name: email.split('@')[0] ?? 'user', password: 'password123' },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'wb_session');
  if (!cookie) throw new Error('no session cookie');
  return { user: (res.json() as { user: { id: string } }).user, cookie: `wb_session=${cookie.value}` };
}

export async function createBoard(server: TestServer, cookie: string): Promise<string> {
  const res = await server.app.inject({ method: 'POST', url: '/api/boards', headers: { cookie }, payload: {} });
  if (res.statusCode !== 201) throw new Error(`create board failed: ${res.statusCode}`);
  return (res.json() as { board: { id: string } }).board.id;
}

export async function addMember(server: TestServer, ownerCookie: string, boardId: string, email: string, role: 'editor' | 'viewer') {
  const res = await server.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/members`,
    headers: { cookie: ownerCookie },
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(`add member failed: ${res.statusCode} ${res.body}`);
}

/** The `ws` client with our cookie and Origin; browser-compatible enough for SyncClient. */
export function cookieWebSocket(cookie: string): typeof WebSocket {
  return class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin: ORIGIN } });
    }
  } as unknown as typeof WebSocket;
}

export async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const started: SyncClient[] = [];

/** A signed-in tab: BoardStore + SyncClient connected to the server on `port`. */
export async function tab(
  port: number,
  boardId: string,
  cookie: string,
  clientId: string,
  { restored, ...options }: { heartbeatMs?: number; queue?: SyncOptions['queue']; restored?: Op[] } = {},
) {
  const store = new BoardStore(clientId);
  const presence = new Presence();
  const sync = new SyncClient(store, {
    url: `ws://127.0.0.1:${port}/ws?board=${boardId}`,
    boardId,
    flushMs: 5,
    ...options,
    WebSocketImpl: cookieWebSocket(cookie),
    presence,
  });
  started.push(sync);
  // As the app does: ops from the offline queue are restored before connecting.
  if (restored) sync.restore(restored);
  sync.start();
  await waitFor(() => sync.status === 'connected', `${clientId} to connect`);
  return { store, sync, presence };
}

export function stopTabs(): void {
  for (const s of started.splice(0)) s.stop();
}

export const settled = (...cs: { sync: SyncClient }[]) => cs.every((c) => c.sync.unackedCount === 0);
