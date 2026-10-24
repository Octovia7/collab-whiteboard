/**
 * End-to-end sync through the real server (Fastify + ws + Postgres) with real SyncClients in
 * Node: "two tabs editing one board", minus the browser.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import type { ServerMessage } from '@whiteboard/shared';
import { addMember, createBoard, ORIGIN, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

let server: TestServer;
let owner: { cookie: string; user: { id: string } };
let editor: { cookie: string; user: { id: string } };

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDb();
  owner = await signUp(server, 'owner@test.local');
  editor = await signUp(server, 'editor@test.local');
});
afterEach(stopTabs);

async function sharedBoard(): Promise<string> {
  const boardId = await createBoard(server, owner.cookie);
  await addMember(server, owner.cookie, boardId, 'editor@test.local', 'editor');
  return boardId;
}

const rect = { type: 'rect' as const, x: 0, y: 0, w: 50, h: 50, color: 'black' };
const all = { minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 };

/** Opens a raw socket and collects what the server sends until it closes. */
function raw(boardId: string, cookie: string, send: string[]): Promise<{ messages: ServerMessage[]; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${server.port}/ws?board=${boardId}`, { headers: { cookie, origin: ORIGIN } });
    const messages: ServerMessage[] = [];
    ws.on('open', () => send.forEach((m) => ws.send(m)));
    ws.on('message', (d) => messages.push(JSON.parse(String(d)) as ServerMessage));
    ws.on('close', (code) => resolve({ messages, code }));
    ws.on('error', reject);
  });
}

describe('sync through the real server', () => {
  it('an edit in one tab appears in the other, and both get acked', async () => {
    const boardId = await sharedBoard();
    const a = await tab(server.port, boardId, owner.cookie, 'tabA');
    const b = await tab(server.port, boardId, editor.cookie, 'tabB');
    const op = a.store.makeCreate(rect);
    a.store.submit([op]);
    await waitFor(() => b.store.get(op.shape.id) !== undefined, 'B to see the shape');
    b.store.submit([b.store.makeUpdate(op.shape.id, { x: 200 })]);
    await waitFor(() => a.store.get(op.shape.id)?.x === 200, 'A to see the move');
    await waitFor(() => settled(a, b), 'acks');
    expect(a.store.visibleIn(all)).toEqual(b.store.visibleIn(all));
  });

  it('a late joiner gets the board as a snapshot, and its clock moves past it', async () => {
    const boardId = await sharedBoard();
    const a = await tab(server.port, boardId, owner.cookie, 'early');
    for (let i = 0; i < 5; i++) a.store.submit([a.store.makeCreate({ ...rect, x: i * 60 })]);
    await waitFor(() => settled(a), 'acks');
    const c = await tab(server.port, boardId, editor.cookie, 'late');
    expect(c.store.visibleIn(all)).toEqual(a.store.visibleIn(all));
    expect(c.store.visibleIn(all)).toHaveLength(5);
    expect(c.store.makeUpdate('x-1', { x: 1 }).stamp.t).toBeGreaterThan(a.store.clock.now);
  });

  it('concurrent edits to the same shapes converge on every client', async () => {
    const boardId = await sharedBoard();
    const clients = [
      await tab(server.port, boardId, owner.cookie, 's1'),
      await tab(server.port, boardId, editor.cookie, 's2'),
      await tab(server.port, boardId, owner.cookie, 's3'),
    ];
    const first = clients[0] as (typeof clients)[number];
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const op = first.store.makeCreate({ ...rect, x: i * 60 });
      first.store.submit([op]);
      ids.push(op.shape.id);
    }
    await waitFor(() => clients.every((c) => ids.every((id) => c.store.get(id))), 'everyone to see the shapes');
    let n = 0;
    for (let round = 0; round < 40; round++) {
      for (const c of clients) {
        const id = ids[(round + n++) % ids.length] as string;
        const props = n % 7 === 0 ? { deleted: n % 2 === 0 } : n % 3 === 0 ? { color: `c${n}` } : { x: n, y: round };
        c.store.submit([c.store.makeUpdate(id, props)]);
      }
      if (round % 8 === 0) await new Promise((r) => setTimeout(r, 3));
    }
    await waitFor(() => settled(...clients), 'all acks');
    await new Promise((r) => setTimeout(r, 100)); // last broadcasts in flight
    const states = clients.map((c) => c.store.snapshot());
    expect(states[1]).toEqual(states[0]);
    expect(states[2]).toEqual(states[0]);
  });

  it('a rejected op is rolled back to the server’s version', async () => {
    const boardId = await sharedBoard();
    const a = await tab(server.port, boardId, owner.cookie, 'owner');
    const b = await tab(server.port, boardId, editor.cookie, 'other');
    const stroke = a.store.makeCreate({ type: 'stroke', x: 0, y: 0, w: 0, h: 0, color: 'black' });
    a.store.submit([stroke, { kind: 'append', opId: 'owner:chunk0', stamp: a.store.clock.tick(), id: stroke.shape.id, chunk: 0, points: [0, 0] }]);
    await waitFor(() => b.store.boundsOf(stroke.shape.id)?.maxX === 0 && settled(a), 'B to see the stroke');
    // B appends to A's stroke: applied optimistically, then rejected (not_author).
    b.store.submit([{ kind: 'append', opId: 'other:x', stamp: b.store.clock.tick(), id: stroke.shape.id, chunk: 1, points: [9, 9] }]);
    expect(b.store.boundsOf(stroke.shape.id)?.maxX).toBe(9);
    await waitFor(() => b.store.boundsOf(stroke.shape.id)?.maxX === 0, 'B to roll back');
    expect(b.sync.unackedCount).toBe(0);
  });

  it('after a reject, still-pending edits to the same shape survive the rollback', async () => {
    const boardId = await sharedBoard();
    const a = await tab(server.port, boardId, owner.cookie, 'author');
    const b = await tab(server.port, boardId, editor.cookie, 'editor');
    const stroke = a.store.makeCreate({ type: 'stroke', x: 0, y: 0, w: 0, h: 0, color: 'black' });
    a.store.submit([stroke]);
    await waitFor(() => b.store.get(stroke.shape.id) !== undefined && settled(a), 'B to see the stroke');
    // Edit A: B appends to A's stroke (rejected, not_author). Edit B: B recolors it (allowed).
    // Same batch, so the reject (carrying the server's pre-recolor shape) arrives before B's ack.
    b.store.submit([{ kind: 'append', opId: 'editor:bad', stamp: b.store.clock.tick(), id: stroke.shape.id, chunk: 0, points: [5, 5] }]);
    b.store.submit([b.store.makeUpdate(stroke.shape.id, { color: 'red' })]);
    await waitFor(() => settled(b), 'the reject and the ack');
    const room = server.rooms.peek(boardId);
    expect(b.store.snapshot()).toEqual(room?.snapshot());
    expect(b.store.get(stroke.shape.id)?.color).toBe('red');
  });

  it('closes the socket with an error on malformed messages or ops before hello', async () => {
    const boardId = await sharedBoard();
    const bad = await raw(boardId, owner.cookie, ['{nope']);
    expect(bad.messages).toEqual([expect.objectContaining({ t: 'error', code: 'bad_message' })]);
    expect(bad.code).toBe(1008);
    const early = await raw(boardId, owner.cookie, [
      JSON.stringify({ t: 'ping' }),
      JSON.stringify({ t: 'ops', ops: [{ kind: 'update', opId: 'x', stamp: { t: 1, client: 'c' }, id: 'c-1', props: { x: 1 } }] }),
    ]);
    // The ping is answered with a pong; then the early ops get the error.
    expect(early.messages.filter((m) => m.t !== 'pong')).toEqual([expect.objectContaining({ t: 'error', code: 'hello_first' })]);
  });
});
