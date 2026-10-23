import { describe, expect, it } from 'vitest';
import type { Op, Role, ServerMessage } from '@whiteboard/shared';
import { MemoryOpStore } from '../persistence/OpStore';
import type { OpStore, StoredOp } from '../persistence/OpStore';
import { Room } from './Room';
import type { Peer } from './Room';

function peer(userId: string, role: Role = 'editor'): Peer & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return { userId, role, inbox, send: (m) => inbox.push(m) };
}

const stamp = (t: number) => ({ t, client: 'c' });
const create = (id: string, t: number, type: 'rect' | 'stroke' = 'rect'): Op => ({
  kind: 'create',
  opId: `op-${id}-${t}`,
  stamp: stamp(t),
  shape: { id, type, x: 0, y: 0, w: 1, h: 1, color: 'black', z: 'i0' },
});
const update = (id: string, t: number, x: number): Op => ({ kind: 'update', opId: `op-u-${t}`, stamp: stamp(t), id, props: { x } });
const append = (id: string, t: number): Op => ({ kind: 'append', opId: `op-a-${t}`, stamp: stamp(t), id, chunk: 0, points: [1, 1] });

const kinds = (inbox: ServerMessage[]) => inbox.map((m) => m.t);

describe('Room', () => {
  it('welcomes with the current board and seq', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('c-1', 1)]);
    const welcome = room.join(peer('ub'));
    expect(welcome).toMatchObject({ t: 'welcome', seq: 1, role: 'editor', you: { userId: 'ub' } });
    expect(welcome.t === 'welcome' && welcome.snapshot.shapes.map((s) => s.id)).toEqual(['c-1']);
  });

  it('assigns seqs, broadcasts to others, stores with the socket userId, and acks the sender', async () => {
    const store = new MemoryOpStore();
    const room = new Room('b', store);
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    await room.handleOps(a, [create('c-1', 1), update('c-1', 2, 5)]);
    expect(b.inbox).toEqual([{ t: 'ops', ops: [create('c-1', 1), update('c-1', 2, 5)], seq: 2 }]);
    expect(a.inbox).toEqual([{ t: 'ack', opIds: ['op-c-1-1', 'op-u-2'], seq: 2 }]);
    expect(store.ops.map((o) => [o.seq, o.userId])).toEqual([
      [1, 'ua'],
      [2, 'ua'],
    ]);
  });

  it('broadcasts before the commit but acks only after it (rule 8)', async () => {
    let commit: () => void = () => {};
    const slowStore: OpStore = { append: (_ops: StoredOp[]) => new Promise<void>((r) => (commit = r)) };
    const room = new Room('b', slowStore);
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    const done = room.handleOps(a, [create('c-1', 1)]);
    await Promise.resolve();
    expect(kinds(b.inbox)).toEqual(['ops']); // peers already have it
    expect(a.inbox).toEqual([]); // sender not acked yet
    commit();
    await done;
    expect(kinds(a.inbox)).toEqual(['ack']);
  });

  it('a resent op is acked with its original seq, not stored or broadcast twice', async () => {
    const store = new MemoryOpStore();
    const room = new Room('b', store);
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    await room.handleOps(a, [create('c-1', 1)]);
    await room.handleOps(a, [update('c-1', 2, 5)]);
    a.inbox.length = 0;
    b.inbox.length = 0;
    await room.handleOps(a, [create('c-1', 1)]);
    expect(a.inbox).toEqual([{ t: 'ack', opIds: ['op-c-1-1'], seq: 1 }]);
    expect(b.inbox).toEqual([]);
    expect(store.ops).toHaveLength(2);
  });

  it('rejects updates and appends to unknown shapes (the server never buffers)', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [update('ghost-1', 2, 5), append('ghost-1', 3)]);
    expect(a.inbox).toEqual([
      { t: 'reject', opId: 'op-u-2', reason: 'unknown_shape', shape: null },
      { t: 'reject', opId: 'op-a-3', reason: 'unknown_shape', shape: null },
    ]);
    expect(room.currentSeq).toBe(0);
  });

  it('only the stroke creator may append, and only to strokes', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    await room.handleOps(a, [create('k-1', 1, 'stroke'), create('r-1', 2)]);
    b.inbox.length = 0;
    await room.handleOps(b, [append('k-1', 3)]);
    expect(b.inbox).toEqual([expect.objectContaining({ t: 'reject', reason: 'not_author', shape: expect.objectContaining({ id: 'k-1' }) })]);
    a.inbox.length = 0;
    await room.handleOps(a, [append('r-1', 4), append('k-1', 5)]);
    expect(a.inbox).toEqual([
      expect.objectContaining({ t: 'reject', opId: 'op-a-4', reason: 'not_a_stroke' }),
      { t: 'ack', opIds: ['op-a-5'], seq: 3 },
    ]);
  });

  it('rejects a create that reuses another user’s shape id', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    await room.handleOps(a, [create('c-1', 1)]);
    b.inbox.length = 0;
    await room.handleOps(b, [{ ...create('c-1', 9), opId: 'forged' }]);
    expect(b.inbox).toEqual([expect.objectContaining({ t: 'reject', opId: 'forged', reason: 'id_taken' })]);
  });

  it('checks the role on every batch', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('c-1', 1)]);
    a.role = 'viewer'; // demoted while connected
    a.inbox.length = 0;
    await room.handleOps(a, [update('c-1', 2, 5)]);
    expect(a.inbox).toEqual([expect.objectContaining({ t: 'reject', reason: 'forbidden' })]);
    expect(room.currentSeq).toBe(1);
  });
});
