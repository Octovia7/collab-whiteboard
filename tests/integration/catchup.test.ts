/** lastSeq catch-up, too-far-behind snapshots, and tombstone GC through the real server. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { BoardStore } from '../../packages/client/src/store/BoardStore';
import { Presence } from '../../packages/client/src/store/Presence';
import { SyncClient } from '../../packages/client/src/sync/SyncClient';
import { query } from './db';
import { addMember, createBoard, DB_URL, ORIGIN, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

const servers: TestServer[] = [];
const extraClients: SyncClient[] = [];
beforeEach(resetDb);
afterEach(async () => {
  stopTabs();
  for (const c of extraClients.splice(0)) c.stop();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

async function setup(env: Record<string, string> = {}) {
  const s = await startServer(env);
  servers.push(s);
  const ada = await signUp(s, 'ada@test.local');
  const bob = await signUp(s, 'bob@test.local');
  const boardId = await createBoard(s, ada.cookie);
  await addMember(s, ada.cookie, boardId, 'bob@test.local', 'editor');
  return { s, ada, bob, boardId };
}

/**
 * A tab whose network the test controls: `drop()` kills its socket and keeps it offline
 * (reconnect attempts go to a dead port) until `restore()`.
 */
async function droppableTab(port: number, boardId: string, cookie: string, clientId: string) {
  const sockets: NodeWebSocket[] = [];
  let offline = false;
  const Impl = class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(offline ? 'ws://127.0.0.1:1/ws' : url, { headers: { cookie, origin: ORIGIN } });
      sockets.push(this);
    }
  } as unknown as typeof WebSocket;
  const store = new BoardStore(clientId);
  const sync = new SyncClient(store, { url: `ws://127.0.0.1:${port}/ws?board=${boardId}`, boardId, flushMs: 5, WebSocketImpl: Impl, presence: new Presence() });
  extraClients.push(sync);
  sync.start();
  await waitFor(() => sync.status === 'connected', `${clientId} to connect`);
  return {
    store,
    sync,
    drop: () => {
      offline = true;
      sockets.at(-1)?.terminate();
    },
    restore: () => {
      offline = false;
    },
  };
}

const rect = (x: number) => ({ type: 'rect' as const, x, y: 0, w: 10, h: 10, color: 'b' });

describe('lastSeq catch-up', () => {
  it('a reconnecting client gets only the ops it missed, keeps its board, and sends its own offline edits', async () => {
    const { s, ada, bob, boardId } = await setup();
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const b = await droppableTab(s.port, boardId, bob.cookie, 'bobtab');
    const first = a.store.makeCreate(rect(0));
    a.store.submit([first]);
    await waitFor(() => b.store.get(first.shape.id) !== undefined && settled(a), 'b to have the first shape');
    expect(b.sync.lastWelcome).toEqual({ kind: 'snapshot', ops: 0 }); // first join

    b.drop();
    await waitFor(() => b.sync.status !== 'connected', 'b to notice the drop');
    // While B is away: A edits, and B edits locally.
    a.store.submit([a.store.makeUpdate(first.shape.id, { x: 50 }), a.store.makeCreate(rect(100))]);
    const mine = b.store.makeCreate(rect(300));
    b.store.submit([mine]);
    await waitFor(() => settled(a), 'a acked');
    b.restore();

    await waitFor(() => b.sync.status === 'connected' && settled(b), 'b back and acked', 15_000);
    expect(b.sync.lastWelcome).toEqual({ kind: 'ops', ops: 2 }); // exactly what it missed
    await waitFor(() => a.store.get(mine.shape.id) !== undefined, "a to see b's offline edit");
    await new Promise((r) => setTimeout(r, 100));
    expect(b.store.snapshot()).toEqual(a.store.snapshot());
    const metrics = await s.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/welcomes_total\{kind="catchup"\} [1-9]/);
  });

  it('a client too far behind (log pruned past its lastSeq) gets a snapshot and reapplies its pending edits', async () => {
    const { s, ada, bob, boardId } = await setup({ SNAPSHOT_EVERY_OPS: '5' });
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const b = await droppableTab(s.port, boardId, bob.cookie, 'bobtab');
    const base = a.store.makeCreate(rect(0));
    a.store.submit([base]);
    await waitFor(() => b.store.get(base.shape.id) !== undefined && settled(a), 'b to have the shape');

    b.drop();
    await waitFor(() => b.sync.status !== 'connected', 'b to notice the drop');
    const mine = b.store.makeCreate(rect(500));
    b.store.submit([mine]);
    // Three rounds of 6 creates, each acked: three snapshots, the log pruned well past B's
    // lastSeq. (Creates, because updates to the same property would be merged in the outbox.)
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 6; i++) a.store.submit([a.store.makeCreate(rect(1000 + round * 100 + i * 12))]);
      await waitFor(() => settled(a), 'a acked');
      await new Promise((r) => setTimeout(r, 150));
    }
    const room = s.rooms.peek(boardId);
    expect(room?.catchUp(1)).toBeNull(); // the server can no longer catch B up from lastSeq 1
    b.restore();
    await waitFor(() => b.sync.status === 'connected' && settled(b), 'b back and acked', 15_000);
    expect(b.sync.lastWelcome).toEqual({ kind: 'snapshot', ops: 0 });
    expect(b.store.visibleIn({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toHaveLength(20); // 1 + 18 + B's own
    await waitFor(() => a.store.get(mine.shape.id) !== undefined, "a to see b's pending edit");
    await new Promise((r) => setTimeout(r, 100));
    expect(b.store.snapshot()).toEqual(a.store.snapshot());
  });
});

describe('tombstone GC', () => {
  it('removes tombstones older than the TTL at snapshot time; recent ones stay', async () => {
    const { s, ada, boardId } = await setup({ TOMBSTONE_TTL_MS: '1000', SNAPSHOT_EVERY_MS: '200', SNAPSHOT_EVERY_OPS: '1000' });
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const old = a.store.makeCreate(rect(0));
    const kept = a.store.makeCreate(rect(50));
    a.store.submit([old, kept]);
    a.store.submit([a.store.makeUpdate(old.shape.id, { deleted: true })]);
    await waitFor(() => settled(a), 'acked');
    await new Promise((r) => setTimeout(r, 1300)); // old's delete is now past the TTL
    a.store.submit([a.store.makeUpdate(kept.shape.id, { deleted: true })]); // recent delete
    await waitFor(() => settled(a), 'acked');
    // The next timed snapshot runs the GC.
    await waitFor(() => !(s.rooms.peek(boardId)?.snapshot().shapes.some((x) => x.id === old.shape.id) ?? true), 'gc', 5_000);
    await new Promise((r) => setTimeout(r, 300));
    const [latest] = await query<{ state: { board: { shapes: { id: string }[] } } }>(
      DB_URL,
      'select state from board_snapshots where board_id = $1 order by seq desc limit 1',
      [boardId],
    );
    const ids = latest?.state.board.shapes.map((x) => x.id) ?? [];
    expect(ids).not.toContain(old.shape.id);
    expect(ids).toContain(kept.shape.id); // deleted, but too recently to collect
    // A new tab never sees the collected tombstone.
    const fresh = await tab(s.port, boardId, ada.cookie, 'freshtab');
    expect(fresh.store.get(old.shape.id)).toBeUndefined();
    expect(fresh.store.get(kept.shape.id)?.deleted).toBe(true);
    const metrics = await s.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/tombstones_collected_total 1/);
  });
});
