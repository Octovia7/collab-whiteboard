/** Production hardening: headers, CORS, rate limits, health, metrics, errors, logs, limits, shutdown, config. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { Op, ServerMessage } from '@whiteboard/shared';
import { query } from './db';
import { createBoard, DB_URL, ORIGIN, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

const servers: TestServer[] = [];
async function server(env: Record<string, string> = {}, port = 0, options: { logStream?: Writable } = {}): Promise<TestServer> {
  const s = await startServer(env, port, options);
  servers.push(s);
  return s;
}

beforeEach(resetDb);
afterEach(async () => {
  stopTabs();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

function socket(s: TestServer, boardId: string, cookie: string): NodeWebSocket {
  return new NodeWebSocket(`ws://127.0.0.1:${s.port}/ws?board=${boardId}`, { headers: { cookie, origin: ORIGIN } });
}

function upgradeStatus(ws: NodeWebSocket): Promise<number> {
  return new Promise((resolveStatus) => {
    ws.on('open', () => resolveStatus(101));
    ws.on('unexpected-response', (_req, res) => resolveStatus(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

describe('HTTP hardening', () => {
  it('sends secure headers and a request id', async () => {
    const s = await server();
    const res = await s.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows CORS only for the app origin, with credentials', async () => {
    const s = await server();
    const preflight = (origin: string) =>
      s.app.inject({ method: 'OPTIONS', url: '/api/boards', headers: { origin, 'access-control-request-method': 'POST' } });
    const ok = await preflight(ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await preflight('https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits login and signup per IP', async () => {
    const s = await server({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    const attempt = () => s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@test.local', password: 'password123' } });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt()).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect((await attempt()).json()).toEqual({ error: 'rate_limited' });
  });

  it('sets Secure on the session cookie when configured (always in production)', async () => {
    const s = await server({ COOKIE_SECURE: 'true' });
    const res = await s.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@test.local', name: 'a', password: 'password123' } });
    const cookie = res.cookies.find((c) => c.name === 'wb_session');
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
  });

  it('maps bad input to 4xx JSON errors, never a crash or a stack trace', async () => {
    const s = await server();
    const badJson = await s.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toEqual({ error: 'bad_request' });
    const huge = await s.app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@test.local', name: 'x'.repeat(100_000), password: 'p' } });
    expect(huge.statusCode).toBe(413);
    const missing = await s.app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found' });
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200); // still alive
  });

  it('/healthz and /readyz; readiness fails when Redis is unreachable', async () => {
    const s = await server();
    expect((await s.app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    expect((await s.app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ ok: true, postgres: true, redis: true });
    const noRedis = await server({ REDIS_URL: 'redis://127.0.0.1:1' });
    const ready = await noRedis.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ ok: false, postgres: true, redis: false });
    expect((await noRedis.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('exposes the system-design metrics, behind a token when one is set', async () => {
    const s = await server({ METRICS_TOKEN: 'metrics-token-1234567890' });
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const t = await tab(s.port, id, cookie, 'ada');
    t.store.submit([t.store.makeCreate({ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'b' })]);
    await waitFor(() => settled(t), 'ack');
    expect((await s.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const res = await s.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-1234567890' } });
    for (const name of ['op_relay_ms_bucket', 'op_commit_ms_bucket', 'ws_connections 1', 'rooms_loaded 1', 'ops_accepted_total 1', 'board_load_ms_count 1', 'snapshot_ms']) {
      expect(res.body).toContain(name);
    }
  });
});

describe('logging', () => {
  it('writes JSON lines with request/connection ids and never passwords, cookies or tokens', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        done();
      },
    });
    const s = await server({ LOG_LEVEL: 'debug' }, 0, { logStream: sink });
    const { cookie } = await signUp(s, 'ada@test.local');
    await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ada@test.local', password: 'password123' } });
    const id = await createBoard(s, cookie);
    const t = await tab(s.port, id, cookie, 'ada');
    stopTabs();
    await waitFor(() => lines.some((l) => l.includes('socket closed')), 'socket log');
    void t;

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.length).toBeGreaterThan(5);
    const token = cookie.split('=')[1] ?? '';
    for (const l of lines) {
      expect(l).not.toContain('password123');
      expect(l).not.toContain(token);
    }
    expect(parsed.filter((p) => p.msg === 'incoming request').every((p) => typeof p.reqId === 'string')).toBe(true);
    const wsLines = parsed.filter((p) => p.msg === 'socket opened' || p.msg === 'socket closed');
    expect(wsLines).toHaveLength(2);
    expect(wsLines.every((p) => typeof p.connId === 'string' && p.boardId === id)).toBe(true);
  });
});

describe('WebSocket limits', () => {
  it('refuses a sixth socket for the same user', async () => {
    const s = await server();
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const open: NodeWebSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const ws = socket(s, id, cookie);
      expect(await upgradeStatus(ws)).toBe(101);
      open.push(ws);
    }
    expect(await upgradeStatus(socket(s, id, cookie))).toBe(429);
    open[0]?.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = socket(s, id, cookie);
    expect(await upgradeStatus(again)).toBe(101);
    for (const ws of [...open, again]) ws.close();
  });

  it('closes a socket that floods messages', async () => {
    const s = await server({ WS_MSGS_PER_SEC: '5', WS_MSGS_BURST: '10' });
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const ws = socket(s, id, cookie);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ t: 'ping' }));
    expect(await closed).toBe(1008);
    expect(messages).toContainEqual(expect.objectContaining({ t: 'error', code: 'rate_limited' }));
  });

  it('throttles a user sending ops faster than the limit, without losing any', async () => {
    const s = await server({ WS_OPS_PER_SEC: '100', WS_OPS_BURST: '100' });
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const ws = socket(s, id, cookie);
    const acked = new Set<string>();
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'ack') m.opIds.forEach((o) => acked.add(o));
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', boardId: id, lastSeq: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    for (let b = 0; b < 3; b++) {
      const ops: Op[] = Array.from({ length: 100 }, (_, i) => {
        const n = b * 100 + i + 1;
        return { kind: 'create', opId: `ada:${n}`, stamp: { t: n, client: 'ada' }, shape: { id: `ada-${n}`, type: 'rect', x: n, y: 0, w: 1, h: 1, color: 'b', z: 'i0' } };
      });
      ws.send(JSON.stringify({ t: 'ops', ops }));
    }
    await waitFor(() => acked.size === 300, 'all 300 acks', 10_000);
    // 100 go through on the burst; the other 200 at 100 ops/s take about 2 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(await query<{ n: number }>(DB_URL, 'select count(*) as n from board_ops where board_id = $1', [id])).toEqual([{ n: 300 }]);
    const metrics = await s.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/ws_throttled_total [1-9]/);
    ws.close();
  });
});

describe('graceful shutdown', () => {
  it('flushes, snapshots, closes sockets with 1012, and clients come straight back', async () => {
    const first = await server();
    const { cookie } = await signUp(first, 'ada@test.local');
    const id = await createBoard(first, cookie);
    const t = await tab(first.port, id, cookie, 'ada');
    t.store.submit([t.store.makeCreate({ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'b' })]);
    await waitFor(() => settled(t), 'ack');
    const port = first.port;
    await first.shutdown();
    expect(t.sync.status).toBe('reconnecting');
    // The final snapshot was written during shutdown.
    expect(await query(DB_URL, 'select seq from board_snapshots where board_id = $1', [id])).toEqual([{ seq: 1 }]);

    const restarted = Date.now();
    await server({}, port);
    await waitFor(() => t.sync.status === 'connected', 'reconnect', 5_000);
    // 1012 means "come back now": no exponential backoff.
    expect(Date.now() - restarted).toBeLessThan(2_000);
  });
});

describe('configuration', () => {
  it('refuses to start in production with missing config, naming what is missing', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(import.meta.dirname, '../../packages/server'),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', JWT_SECRET: 'too-short' },
      encoding: 'utf8',
      timeout: 55_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid configuration');
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'ALLOWED_ORIGINS']) expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain('too-short');
  }, 60_000); // spawns a fresh Node + tsx process: slow on a loaded machine
});
