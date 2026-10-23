import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from './db';
import { createBoard, DB_URL, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

const servers: TestServer[] = [];
async function server(env: Record<string, string> = {}, port = 0): Promise<TestServer> {
  const s = await startServer(env, port);
  servers.push(s);
  return s;
}

beforeEach(resetDb);
afterEach(async () => {
  stopTabs();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
});

const rect = (x: number) => ({ type: 'rect' as const, x, y: 0, w: 10, h: 10, color: 'black' });
const opRows = (boardId: string) => query<{ seq: number; op_id: string }>(DB_URL, 'select seq, op_id from board_ops where board_id = $1 order by seq', [boardId]);
const snapRows = (boardId: string) => query<{ seq: string; shape_count: number }>(DB_URL, 'select seq, shape_count from board_snapshots where board_id = $1 order by seq', [boardId]);

describe('persistence', () => {
  it('acks only after the op is in Postgres, with a seq per op', async () => {
    const s = await server({ WB_FAULT_COMMIT_DELAY_MS: '300' });
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const t = await tab(s.port, id, cookie, 'ada');
    t.store.submit([t.store.makeCreate(rect(0)), t.store.makeCreate(rect(20))]);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.sync.unackedCount).toBe(2); // sent, not yet committed, so not acked
    expect(await opRows(id)).toEqual([]);
    await waitFor(() => settled(t), 'the ack');
    expect((await opRows(id)).map((r) => Number(r.seq))).toEqual([1, 2]);
  });

  it('a restarted server serves the same board, and seqs keep counting', async () => {
    const first = await server();
    const { cookie } = await signUp(first, 'ada@test.local');
    const id = await createBoard(first, cookie);
    const t = await tab(first.port, id, cookie, 'ada');
    for (let i = 0; i < 5; i++) t.store.submit([t.store.makeCreate(rect(i * 20))]);
    await waitFor(() => settled(t), 'acks');
    const before = t.store.snapshot();
    stopTabs();
    await first.close();

    const second = await server();
    const again = await tab(second.port, id, cookie, 'ada2');
    expect(again.store.snapshot()).toEqual(before);
    again.store.submit([again.store.makeCreate(rect(500))]);
    await waitFor(() => settled(again), 'ack');
    expect((await opRows(id)).map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('an op resent after a crash between commit and ack is not stored twice', async () => {
    // The ack is held after the commit; the server dies in that window.
    const first = await server({ WB_FAULT_ACK_DELAY_MS: '5000' });
    const { cookie } = await signUp(first, 'ada@test.local');
    const id = await createBoard(first, cookie);
    const t = await tab(first.port, id, cookie, 'ada');
    const op = t.store.makeCreate(rect(0));
    t.store.submit([op]);
    for (let i = 0; i < 100 && (await opRows(id)).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await opRows(id)).toHaveLength(1); // committed...
    expect(t.sync.unackedCount).toBe(1); // ...but never acked
    const port = first.port;
    await first.close();

    // Same port, so the client's automatic reconnect finds it and resends the op.
    await server({}, port);
    await waitFor(() => t.sync.status === 'connected' && settled(t), 'reconnect and ack', 15_000);
    expect((await opRows(id)).map((r) => r.op_id)).toEqual([op.opId]);
    expect(t.store.get(op.shape.id)).toBeDefined();
  });

  it('snapshots every N ops, prunes old ops, and loads from snapshot + tail', async () => {
    const first = await server({ SNAPSHOT_EVERY_OPS: '50' });
    const { cookie } = await signUp(first, 'ada@test.local');
    const id = await createBoard(first, cookie);
    const t = await tab(first.port, id, cookie, 'ada');
    // Four rounds of 50 ops, each fully acked, so a snapshot lands after each round.
    for (let round = 1; round <= 4; round++) {
      for (let i = 0; i < 50; i++) t.store.submit([t.store.makeCreate(rect((round * 50 + i) * 12))]);
      await waitFor(() => settled(t), `round ${round} acks`, 15_000);
      for (let i = 0; i < 200 && (await snapRows(id)).length < round; i++) await new Promise((r) => setTimeout(r, 20));
    }
    expect((await snapRows(id)).map((r) => Number(r.seq))).toEqual([50, 100, 150, 200]);
    // Each snapshot deletes the ops covered by the one before the previous: after the 4th
    // (seq 200, previous 150, before that 100), ops 1..100 are gone and 101..200 remain.
    const seqs = (await opRows(id)).map((o) => Number(o.seq));
    expect(Math.min(...seqs)).toBe(101);
    expect(Math.max(...seqs)).toBe(200);

    const before = t.store.snapshot();
    stopTabs();
    await first.close();
    const second = await server();
    const again = await tab(second.port, id, cookie, 'ada2');
    expect(again.store.snapshot()).toEqual(before);
    expect(again.store.visibleIn({ minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 })).toHaveLength(200);
  });

  it('unloads an idle room after a final snapshot', async () => {
    const s = await server({ ROOM_UNLOAD_MS: '50' });
    const { cookie } = await signUp(s, 'ada@test.local');
    const id = await createBoard(s, cookie);
    const t = await tab(s.port, id, cookie, 'ada');
    t.store.submit([t.store.makeCreate(rect(0))]);
    await waitFor(() => settled(t), 'ack');
    stopTabs();
    await waitFor(() => s.rooms.peek(id) === undefined, 'unload');
    expect((await snapRows(id)).map((r) => Number(r.seq))).toEqual([1]);
  });
});
