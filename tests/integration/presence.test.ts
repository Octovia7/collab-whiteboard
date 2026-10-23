/** Presence through the real server: join/leave, cursors, selections, heartbeat timeout. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { ServerMessage } from '@whiteboard/shared';
import { query } from './db';
import { addMember, createBoard, DB_URL, ORIGIN, resetDb, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

const servers: TestServer[] = [];
beforeEach(resetDb);
afterEach(async () => {
  stopTabs();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

async function setup(env: Record<string, string> = {}) {
  const s = await startServer(env);
  servers.push(s);
  const ada = await signUp(s, 'ada@test.local');
  const bob = await signUp(s, 'bob@test.local');
  const boardId = await createBoard(s, ada.cookie);
  await addMember(s, ada.cookie, boardId, 'bob@test.local', 'viewer');
  return { s, ada, bob, boardId };
}

describe('presence', () => {
  it('welcome lists who is here; joins and leaves are announced with names', async () => {
    const { s, ada, bob, boardId } = await setup();
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const b = await tab(s.port, boardId, bob.cookie, 'bobtab');
    expect(b.presence.online().map((u) => [u.name, u.isYou])).toEqual([
      ['bob', true],
      ['ada', false],
    ]);
    await waitFor(() => a.presence.online().length === 2, 'ada to see bob join');
    b.sync.stop();
    await waitFor(() => a.presence.online().length === 1, 'ada to see bob leave');
  });

  it('relays cursors and selections (viewers too), and never stores them', async () => {
    const { s, ada, bob, boardId } = await setup();
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const b = await tab(s.port, boardId, bob.cookie, 'bobtab'); // a viewer
    b.sync.sendCursor(123.456, -7);
    await waitFor(() => a.presence.list()[0]?.target !== null && a.presence.list()[0]?.target !== undefined, "bob's cursor");
    expect(a.presence.list()[0]?.target).toEqual({ x: 123.46, y: -7 }); // rounded to 2 decimals
    const shape = a.store.makeCreate({ type: 'rect', x: 0, y: 0, w: 5, h: 5, color: 'b' });
    a.store.submit([shape]);
    a.sync.sendSelection([shape.shape.id]);
    await waitFor(() => b.presence.list()[0]?.selection[0] === shape.shape.id, "ada's selection");
    await new Promise((r) => setTimeout(r, 200));
    const rows = await query<{ n: number }>(DB_URL, "select count(*) as n from board_ops where op::text like '%cursor%' or op::text like '%select%'");
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('throttles cursors to 20/s, always delivering the final position', async () => {
    const { s, ada, bob, boardId } = await setup();
    const a = await tab(s.port, boardId, ada.cookie, 'adatab');
    const raw = new NodeWebSocket(`ws://127.0.0.1:${s.port}/ws?board=${boardId}`, { headers: { cookie: bob.cookie, origin: ORIGIN } });
    const cursors: ServerMessage[] = [];
    raw.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'cursor') cursors.push(m);
    });
    await new Promise((r) => raw.once('open', r));
    raw.send(JSON.stringify({ t: 'hello', boardId, lastSeq: 0 }));
    await new Promise((r) => setTimeout(r, 300));
    // 100 moves as fast as timers allow (5 ms asked; ~15 ms on Windows).
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      a.sync.sendCursor(i, i);
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, 200));
    // At most one per 50 ms (plus the first), far fewer than the 100 moves.
    expect(cursors.length).toBeLessThanOrEqual(Math.ceil(elapsed / 50) + 2);
    expect(cursors.length).toBeLessThan(100);
    expect(cursors.at(-1)).toMatchObject({ x: 99, y: 99 });
    raw.close();
  });

  it('drops a socket that stops sending (no heartbeat) and tells everyone', async () => {
    const { s, ada, bob, boardId } = await setup({ PRESENCE_TIMEOUT_MS: '1000', PRESENCE_SWEEP_MS: '200' });
    // Ada's client heartbeats well inside the (shortened) timeout, as it does in production (5 s vs 15 s).
    const a = await tab(s.port, boardId, ada.cookie, 'adatab', { heartbeatMs: 300 });
    // A raw client that says hello and then goes silent (a closed laptop lid).
    const silent = new NodeWebSocket(`ws://127.0.0.1:${s.port}/ws?board=${boardId}`, { headers: { cookie: bob.cookie, origin: ORIGIN } });
    const closed = new Promise<number>((r) => silent.once('close', (code) => r(code)));
    await new Promise((r) => silent.once('open', r));
    silent.send(JSON.stringify({ t: 'hello', boardId, lastSeq: 0 }));
    await waitFor(() => a.presence.online().length === 2, 'the silent peer to join');
    await waitFor(() => a.presence.online().length === 1, 'the silent peer to be dropped', 5_000);
    expect(await closed).toBe(1006); // terminated, no close handshake
    // The SyncClient's own heartbeat keeps Ada connected through the same sweeps.
    expect(a.sync.status).toBe('connected');
    const metrics = await s.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/heartbeat_timeouts_total [1-9]/);
  });
});
