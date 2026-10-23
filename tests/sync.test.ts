/**
 * End-to-end sync: the real server (Fastify + ws) on a random port, and real SyncClients using
 * Node 22's built-in WebSocket. "Two tabs editing one board", minus the browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ServerMessage } from '@whiteboard/shared';
import { buildApp } from '../packages/server/src/app';
import { BoardStore } from '../packages/client/src/store/BoardStore';
import { SyncClient } from '../packages/client/src/sync/SyncClient';

let app: ReturnType<typeof buildApp>['app'];
let rooms: ReturnType<typeof buildApp>['rooms'];
let base = '';
const started: SyncClient[] = [];

beforeAll(async () => {
  ({ app, rooms } = buildApp({ logger: false }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
});

afterAll(async () => {
  for (const s of started) s.stop();
  await app.close();
});

async function waitFor(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function client(boardId: string, clientId: string) {
  const store = new BoardStore(clientId);
  const sync = new SyncClient(store, { url: `${base}?board=${boardId}`, boardId, flushMs: 5 });
  started.push(sync);
  sync.start();
  await waitFor(() => sync.status === 'connected', `${clientId} to connect`);
  return { store, sync };
}

const rect = { type: 'rect' as const, x: 0, y: 0, w: 50, h: 50, color: 'black' };
const settled = (...cs: { sync: SyncClient }[]) => cs.every((c) => c.sync.unackedCount === 0);
const snap = (c: { store: BoardStore }) => c.store.visibleIn({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 });

/** Opens a raw socket and collects what the server sends until it closes. */
function raw(url: string, send: string[]): Promise<{ messages: ServerMessage[]; code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: ServerMessage[] = [];
    ws.onopen = () => send.forEach((m) => ws.send(m));
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = (e) => resolve({ messages, code: e.code });
    ws.onerror = () => reject(new Error('socket error'));
  });
}

describe('sync through the real server', () => {
  it('an edit in one tab appears in the other, and both get acked', async () => {
    const a = await client('two-tabs', 'tabA');
    const b = await client('two-tabs', 'tabB');
    const op = a.store.makeCreate(rect);
    a.store.submit([op]);
    await waitFor(() => b.store.get(op.shape.id) !== undefined, 'B to see the shape');
    b.store.submit([b.store.makeUpdate(op.shape.id, { x: 200 })]);
    await waitFor(() => a.store.get(op.shape.id)?.x === 200, 'A to see the move');
    await waitFor(() => settled(a, b), 'acks');
    expect(snap(a)).toEqual(snap(b));
  });

  it('a late joiner gets the board as a snapshot, and its clock moves past it', async () => {
    const a = await client('late', 'early');
    for (let i = 0; i < 5; i++) a.store.submit([a.store.makeCreate({ ...rect, x: i * 60 })]);
    await waitFor(() => settled(a), 'acks');
    const c = await client('late', 'late');
    expect(snap(c)).toEqual(snap(a));
    expect(snap(c)).toHaveLength(5);
    expect(c.store.makeUpdate('x-1', { x: 1 }).stamp.t).toBeGreaterThan(a.store.clock.now);
  });

  it('concurrent edits to the same shapes converge on every client', async () => {
    const clients = [await client('stress', 's1'), await client('stress', 's2'), await client('stress', 's3')];
    const first = clients[0] as Awaited<ReturnType<typeof client>>;
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
      if (round % 8 === 0) await new Promise((r) => setTimeout(r, 3)); // let some batches interleave
    }
    await waitFor(() => settled(...clients), 'all acks');
    await new Promise((r) => setTimeout(r, 50)); // last broadcasts in flight
    const all = clients.map((c) => ids.map((id) => c.store.get(id)));
    expect(all[1]).toEqual(all[0]);
    expect(all[2]).toEqual(all[0]);
  });

  it('a rejected op is rolled back to the server’s version', async () => {
    const a = await client('reject', 'owner');
    const b = await client('reject', 'other');
    const stroke = a.store.makeCreate({ type: 'stroke', x: 0, y: 0, w: 0, h: 0, color: 'black' });
    a.store.submit([stroke, { kind: 'append', opId: 'owner:chunk0', stamp: a.store.clock.tick(), id: stroke.shape.id, chunk: 0, points: [0, 0] }]);
    await waitFor(() => b.store.get(stroke.shape.id) !== undefined && settled(a), 'B to see the stroke');
    await new Promise((r) => setTimeout(r, 30));
    // B tries to append to A's stroke: applied optimistically, then rejected (not_author).
    b.store.submit([{ kind: 'append', opId: 'other:x', stamp: b.store.clock.tick(), id: stroke.shape.id, chunk: 1, points: [9, 9] }]);
    expect(b.store.boundsOf(stroke.shape.id)?.maxX).toBe(9);
    await waitFor(() => b.store.boundsOf(stroke.shape.id)?.maxX === 0, 'B to roll back');
    expect(b.sync.unackedCount).toBe(0);
  });

  it('after a reject, still-pending edits to the same shape survive the rollback', async () => {
    const a = await client('reject-then-edit', 'author');
    const b = await client('reject-then-edit', 'editor');
    const stroke = a.store.makeCreate({ type: 'stroke', x: 0, y: 0, w: 0, h: 0, color: 'black' });
    a.store.submit([stroke]);
    await waitFor(() => b.store.get(stroke.shape.id) !== undefined && settled(a), 'B to see the stroke');
    // Edit A: B appends to A's stroke (rejected, not_author). Edit B: B recolors it (allowed).
    // Same batch, so the reject (carrying the server's pre-recolor shape) arrives before B's ack.
    const appendOp = { kind: 'append' as const, opId: 'editor:bad', stamp: b.store.clock.tick(), id: stroke.shape.id, chunk: 0, points: [5, 5] };
    b.store.submit([appendOp]);
    b.store.submit([b.store.makeUpdate(stroke.shape.id, { color: 'red' })]);
    await waitFor(() => settled(b), 'the reject and the ack');
    const server = rooms.get('reject-then-edit').snapshot();
    expect(b.store.snapshot()).toEqual(server);
    expect(b.store.get(stroke.shape.id)?.color).toBe('red');
  });

  it('closes the socket with an error on malformed messages or ops before hello', async () => {
    const bad = await raw(`${base}?board=errs`, ['{nope']);
    expect(bad.messages).toEqual([expect.objectContaining({ t: 'error', code: 'bad_message' })]);
    expect(bad.code).toBe(1008);
    const early = await raw(`${base}?board=errs`, [JSON.stringify({ t: 'ping' }), JSON.stringify({ t: 'ops', ops: [{ kind: 'update', opId: 'x', stamp: { t: 1, client: 'c' }, id: 'c-1', props: { x: 1 } }] })]);
    expect(early.messages).toEqual([expect.objectContaining({ t: 'error', code: 'hello_first' })]);
  });

  it('refuses the upgrade without a valid board id', async () => {
    await expect(raw(`${base}?board=bad%20id`, [])).rejects.toThrow();
  });
});
