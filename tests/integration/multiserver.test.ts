/**
 * Milestone 8: two real server processes' worth of app (two buildApp instances on two ports)
 * sharing Postgres and Redis, with real SyncClients in Node. Covers pub/sub between servers,
 * the upTo watermark and gap filling, presence and membership changes across servers,
 * cross-server limits, logout everywhere, and "Saving paused".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { BoardStore } from '../../packages/client/src/store/BoardStore';
import { Presence } from '../../packages/client/src/store/Presence';
import { SyncClient } from '../../packages/client/src/sync/SyncClient';
import { putOnline } from '../../packages/server/src/redisState';
import { query } from './db';
import { addMember, createBoard, DB_URL, ORIGIN, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

const servers: TestServer[] = [];
const extra: SyncClient[] = [];
async function server(env: Record<string, string> = {}): Promise<TestServer> {
  const s = await startServer(env);
  servers.push(s);
  return s;
}

beforeEach(resetDb);
afterEach(async () => {
  stopTabs();
  for (const c of extra.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

const rect = { type: 'rect' as const, x: 0, y: 0, w: 50, h: 50, color: 'black' };

/** Owner and editor on one board, created through server `s`. */
async function sharedBoard(s: TestServer) {
  const owner = await signUp(s, 'owner@test.local');
  const editor = await signUp(s, 'editor@test.local');
  const boardId = await createBoard(s, owner.cookie);
  await addMember(s, owner.cookie, boardId, 'editor@test.local', 'editor');
  return { owner, editor, boardId };
}

function upgradeStatus(s: TestServer, boardId: string, cookie: string): Promise<{ status: number; ws: NodeWebSocket }> {
  const ws = new NodeWebSocket(`ws://127.0.0.1:${s.port}/ws?board=${boardId}`, { headers: { cookie, origin: ORIGIN } });
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ status: 101, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0, ws }));
    ws.on('error', () => {});
  });
}

const metric = async (s: TestServer, name: string) => {
  const body = (await s.app.inject({ method: 'GET', url: '/metrics' })).body;
  const line = body.split('\n').find((l) => l.startsWith(`${name} `));
  return line ? Number(line.split(' ')[1]) : 0;
};

describe('two servers, one board', () => {
  it('edits and presence flow both ways between tabs on different servers', async () => {
    const [a, b] = [await server(), await server()];
    const { owner, editor, boardId } = await sharedBoard(a);
    const onA = await tab(a.port, boardId, owner.cookie, 'onA');
    const onB = await tab(b.port, boardId, editor.cookie, 'onB');
    // B's welcome listed A's tab (from the shared online list), and A heard B join.
    expect(onB.presence.visible().map((p) => p.userId)).toContain(owner.user.id);
    await waitFor(() => onA.presence.visible().some((p) => p.userId === editor.user.id), 'A to see B join');

    const shape = onA.store.makeCreate(rect);
    onA.store.submit([shape]);
    await waitFor(() => onB.store.get(shape.shape.id) !== undefined, 'B to get the shape from A');
    onB.store.submit([onB.store.makeUpdate(shape.shape.id, { x: 300 })]);
    await waitFor(() => onA.store.get(shape.shape.id)?.x === 300, 'A to get the move from B');
    await waitFor(() => settled(onA, onB), 'acks');
    expect(onA.store.snapshot()).toEqual(onB.store.snapshot());
    // Both servers agree on the watermark the clients store.
    expect(onA.sync.seq).toBe(2);
    expect(onB.sync.seq).toBe(2);

    onA.sync.sendCursor(10, 20);
    await waitFor(() => onB.presence.visible().some((p) => p.target?.x === 10), 'the cursor to cross servers');
    onA.sync.stop();
    await waitFor(() => !onB.presence.visible().some((p) => p.userId === owner.user.id), 'peer-leave to cross servers');
  });

  it('a dropped pub/sub message never delays later edits; the watermark waits until Postgres has the op', async () => {
    // A commits slowly, so for ~800 ms the dropped op is in no message and not in Postgres.
    const a = await server({ WB_FAULT_COMMIT_DELAY_MS: '800' });
    const b = await server();
    const { owner, editor, boardId } = await sharedBoard(a);
    const onB = await tab(b.port, boardId, editor.cookie, 'onB');
    const onA = await tab(a.port, boardId, owner.cookie, 'onA');
    let dropped = 0;
    b.bus.faults.dropIncoming = (channel, msg) => {
      if (dropped > 0 || channel !== `board:${boardId}` || (msg as { type?: string }).type !== 'ops') return false;
      dropped++;
      return true; // as if Redis lost the first ops message A publishes
    };

    const lost = onA.store.makeCreate(rect);
    onA.store.submit([lost]); // seq 1: never reaches B through Redis
    await new Promise((r) => setTimeout(r, 50));
    const later = onA.store.makeCreate({ ...rect, x: 200 });
    const sentAt = performance.now();
    onA.store.submit([later]); // seq 2: published normally
    await waitFor(() => onB.store.get(later.shape.id) !== undefined, 'the later edit to reach B');
    const latency = performance.now() - sentAt;
    expect(dropped).toBe(1);
    expect(latency).toBeLessThan(400); // not held back behind the missing seq 1
    expect(onB.store.get(lost.shape.id)).toBeUndefined();
    expect(onB.sync.seq).toBe(0); // the watermark stays below the gap

    // Once A's commit lands (~800 ms), B's gap filler reads seq 1 from Postgres.
    await waitFor(() => onB.store.get(lost.shape.id) !== undefined, 'B to fill the gap from Postgres', 5000);
    await waitFor(() => onB.sync.seq === 2, 'the watermark to move past the filled gap');
    expect(await metric(b, 'gap_ops_filled_total')).toBe(1);
    await waitFor(() => settled(onA), 'acks');
    expect(onB.store.snapshot()).toEqual(onA.store.snapshot());
  });

  it('a client reconnecting to a server that is behind is caught up before its welcome', async () => {
    const [a, b] = [await server(), await server()];
    const { owner, editor, boardId } = await sharedBoard(a);
    await tab(b.port, boardId, editor.cookie, 'keepsBLoaded'); // B's room is loaded...
    b.bus.faults.dropIncoming = (channel) => channel === `board:${boardId}`; // ...but hears nothing from A

    // One client whose next connection goes wherever `target` says (a load balancer switching it).
    let target = a.port;
    const sockets: NodeWebSocket[] = [];
    const Impl = class extends NodeWebSocket {
      constructor() {
        super(`ws://127.0.0.1:${target}/ws?board=${boardId}`, { headers: { cookie: owner.cookie, origin: ORIGIN } });
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;
    const store = new BoardStore('mover');
    const sync = new SyncClient(store, { url: 'ignored', boardId, flushMs: 5, WebSocketImpl: Impl, presence: new Presence() });
    extra.push(sync);
    sync.start();
    await waitFor(() => sync.status === 'connected', 'connect to A');
    const shape = store.makeCreate(rect);
    store.submit([shape]);
    await waitFor(() => sync.unackedCount === 0 && sync.seq === 1, 'the create to be acked on A');

    target = b.port;
    sockets.at(-1)?.close(); // the connection drops; the reconnect lands on B
    await waitFor(() => sync.status === 'connected' && sockets.length === 2, 'reconnect to B', 5000);
    // B read seq 1 from Postgres before welcoming, so this was a catch-up, not a snapshot.
    expect(sync.lastWelcome?.kind).toBe('ops');
    store.submit([store.makeUpdate(shape.shape.id, { x: 123 })]);
    await waitFor(() => sync.unackedCount === 0, 'the edit to be acked on B (not rejected as unknown_shape)');
    expect(store.get(shape.shape.id)?.x).toBe(123);
    const rows = await query<{ n: string }>(DB_URL, 'select count(*) as n from board_ops where board_id = $1', [boardId]);
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it("removes a crashed server's peers from the online list after the timeout", async () => {
    const b = await server({ PRESENCE_TIMEOUT_MS: '1000', PRESENCE_SWEEP_MS: '200' });
    const { editor, boardId } = await sharedBoard(b);
    // A peer of a server that died: its entry is never refreshed again.
    await putOnline(b.redis, boardId, [{ peerId: 'ghost', userId: 'someone', name: 'Ghost' }], 'dead-server');
    const onB = await tab(b.port, boardId, editor.cookie, 'onB');
    expect(onB.presence.visible().map((p) => p.peerId)).toContain('ghost');
    await waitFor(() => !onB.presence.visible().some((p) => p.peerId === 'ghost'), 'the ghost to be swept', 4000);
  });

  it('role changes and removals made on one server reach sockets on the other', async () => {
    const [a, b] = [await server(), await server()];
    const { owner, editor, boardId } = await sharedBoard(a);
    const onA = await tab(a.port, boardId, owner.cookie, 'onA');
    const onB = await tab(b.port, boardId, editor.cookie, 'onB');
    const shape = onA.store.makeCreate(rect);
    onA.store.submit([shape]);
    await waitFor(() => onB.store.get(shape.shape.id) !== undefined, 'B to have the shape');

    const patch = await a.app.inject({
      method: 'PATCH',
      url: `/api/boards/${boardId}/members/${editor.user.id}`,
      headers: { cookie: owner.cookie },
      payload: { role: 'viewer' },
    });
    expect(patch.statusCode).toBe(204);
    await waitFor(() => onB.sync.role === 'viewer', 'the role change to reach B');
    onB.store.submit([onB.store.makeUpdate(shape.shape.id, { x: 999 })]);
    await waitFor(() => onB.sync.unackedCount === 0, 'the forbidden edit to be rejected');
    expect(onA.store.get(shape.shape.id)?.x).toBe(0);

    const del = await a.app.inject({ method: 'DELETE', url: `/api/boards/${boardId}/members/${editor.user.id}`, headers: { cookie: owner.cookie } });
    expect(del.statusCode).toBe(204);
    await waitFor(() => onB.sync.status === 'disconnected', 'B to be closed');
    expect(onB.sync.closeReason).toBe('removed_from_board');
  });
});

describe('limits across servers', () => {
  it('counts open sockets per user across servers', async () => {
    const [a, b] = [await server(), await server()];
    const { owner, boardId } = await sharedBoard(a);
    const open: NodeWebSocket[] = [];
    for (const s of [a, a, a, b, b]) {
      const { status, ws } = await upgradeStatus(s, boardId, owner.cookie);
      expect(status).toBe(101);
      open.push(ws);
    }
    expect((await upgradeStatus(a, boardId, owner.cookie)).status).toBe(429);
    expect((await upgradeStatus(b, boardId, owner.cookie)).status).toBe(429);
    open[0]?.close();
    await waitFor(() => false, 'nothing', 200).catch(() => {});
    const again = await upgradeStatus(b, boardId, owner.cookie);
    expect(again.status).toBe(101);
    for (const ws of [...open, again.ws]) ws.close();
  });

  it("shares one op budget between a user's sockets on different servers", async () => {
    const env = { WS_OPS_PER_SEC: '100', WS_OPS_BURST: '100' };
    const [a, b] = [await server(env), await server(env)];
    const { owner, boardId } = await sharedBoard(a);
    const onA = await tab(a.port, boardId, owner.cookie, 'onA');
    const onB = await tab(b.port, boardId, owner.cookie, 'onB');
    onA.store.submit(Array.from({ length: 100 }, (_, i) => onA.store.makeCreate({ ...rect, x: i })));
    await waitFor(() => settled(onA), 'the burst on A');
    const started = performance.now();
    onB.store.submit(Array.from({ length: 60 }, (_, i) => onB.store.makeCreate({ ...rect, y: i })));
    await waitFor(() => settled(onB), 'B, throttled', 5000);
    // A used the whole burst, so B's 60 ops wait for ~600 ms of refill at 100/s.
    expect(performance.now() - started).toBeGreaterThan(400);
    expect(await metric(b, 'ws_throttled_total')).toBeGreaterThan(0);
  });

  it('rate-limits login per IP across servers', async () => {
    const env = { AUTH_RATE_LIMIT_PER_MIN: '3' };
    const [a, b] = [await server(env), await server(env)];
    const attempt = (s: TestServer) =>
      s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@test.local', password: 'wrong-password' } });
    const statuses = [(await attempt(a)).statusCode, (await attempt(b)).statusCode, (await attempt(a)).statusCode, (await attempt(b)).statusCode];
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe('sessions', () => {
  it('logout closes that session’s sockets on every server and revokes the token; other sessions stay', async () => {
    const [a, b] = [await server(), await server()];
    const { owner, boardId } = await sharedBoard(a);
    const login = await a.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@test.local', password: 'password123' } });
    const other = `wb_session=${login.cookies.find((c) => c.name === 'wb_session')?.value}`;
    const s1a = await tab(a.port, boardId, owner.cookie, 's1a');
    const s1b = await tab(b.port, boardId, owner.cookie, 's1b');
    const s2b = await tab(b.port, boardId, other, 's2b');

    const out = await a.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: owner.cookie } });
    expect(out.statusCode).toBe(204);
    await waitFor(() => s1a.sync.status === 'disconnected' && s1b.sync.status === 'disconnected', 'both sockets of the session to close');
    expect([s1a.sync.closeReason, s1b.sync.closeReason]).toEqual(['logged_out', 'logged_out']);
    expect(s2b.sync.status).toBe('connected');

    // The token itself is dead everywhere, on REST and on the upgrade.
    expect((await b.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: owner.cookie } })).statusCode).toBe(401);
    expect((await upgradeStatus(b, boardId, owner.cookie)).status).toBe(401);
    expect((await b.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: other } })).statusCode).toBe(200);
  });

  it('fails closed: without Redis, REST and the upgrade answer 503 instead of trusting the session', async () => {
    const healthy = await server();
    const { owner, boardId } = await sharedBoard(healthy);
    const blind = await server({ REDIS_URL: 'redis://127.0.0.1:1/1' }); // nothing listens there
    const me = await blind.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: owner.cookie } });
    expect(me.statusCode).toBe(503);
    expect((await upgradeStatus(blind, boardId, owner.cookie)).status).toBe(503);
  });
});

describe('saving paused', () => {
  it('after failing commits for SAVE_PAUSE_AFTER_MS, clients are told; new batches wait; everything lands after recovery', async () => {
    const s = await server({ SAVE_PAUSE_AFTER_MS: '500', WB_FAULT_CONTROL: '1' });
    const { owner, editor, boardId } = await sharedBoard(s);
    const author = await tab(s.port, boardId, owner.cookie, 'author');
    const peer = await tab(s.port, boardId, editor.cookie, 'peer');
    const faults = (failCommits: boolean) => s.app.inject({ method: 'POST', url: '/api/__test/faults', payload: { failCommits } });

    expect((await faults(true)).statusCode).toBe(200);
    const before = author.store.makeCreate(rect);
    author.store.submit([before]);
    // Live relay carries on while Postgres fails; the author just isn't acked.
    await waitFor(() => peer.store.get(before.shape.id) !== undefined, 'live relay during the outage');
    await waitFor(() => author.sync.savingPaused && peer.sync.savingPaused, 'saving paused to be announced', 3000);
    expect(author.sync.unackedCount).toBe(1);

    const during = author.store.makeCreate({ ...rect, x: 400 });
    author.store.submit([during]); // dropped by the server while paused
    await new Promise((r) => setTimeout(r, 300));
    expect(peer.store.get(during.shape.id)).toBeUndefined();
    expect(author.store.get(during.shape.id)).toBeDefined(); // still on the author's screen

    expect((await faults(false)).statusCode).toBe(200);
    await waitFor(() => !author.sync.savingPaused, 'saving resumed', 8000);
    await waitFor(() => settled(author), 'everything acked after the resend', 8000);
    await waitFor(() => peer.store.get(during.shape.id) !== undefined, 'the paused edit to reach the peer');
    const rows = await query<{ op_id: string }>(DB_URL, 'select op_id from board_ops where board_id = $1', [boardId]);
    expect(rows.map((r) => r.op_id).sort()).toEqual([before.opId, during.opId].sort());
  });

  it('the fault control route does not exist unless enabled', async () => {
    const s = await server();
    expect((await s.app.inject({ method: 'POST', url: '/api/__test/faults', payload: { failCommits: true } })).statusCode).toBe(404);
  });
});
