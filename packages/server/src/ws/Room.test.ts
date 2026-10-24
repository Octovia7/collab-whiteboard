import { describe, expect, it } from 'vitest';
import type { Op, Role, ServerMessage } from '@whiteboard/shared';
import { MemoryOpStore } from '../persistence/OpStore';
import type { OpStore, StoredOp } from '../persistence/OpStore';
import { Room } from './Room';
import type { Peer } from './Room';

const PRESENCE_TYPES = new Set(['peer-join', 'peer-leave', 'cursor', 'select', 'typing']);
let peerCounter = 0;

/** A fake socket. Presence messages land in `presence`, everything else in `inbox`. */
function peer(userId: string, role: Role = 'editor') {
  const inbox: ServerMessage[] = [];
  const presence: ServerMessage[] = [];
  const p = {
    peerId: `peer-${++peerCounter}`,
    userId,
    name: userId.toUpperCase(),
    role,
    lastSeen: 0,
    inbox,
    presence,
    closed: null as number | null,
    terminated: false,
    send: (m: ServerMessage) => void (PRESENCE_TYPES.has(m.t) ? presence : inbox).push(m),
    close: (code: number) => {
      p.closed = code;
    },
    terminate: () => {
      p.terminated = true;
    },
  };
  return p satisfies Peer;
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
    expect(welcome.t === 'welcome' && welcome.snapshot?.shapes.map((s) => s.id)).toEqual(['c-1']);
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

describe('Room: persistence and membership', () => {
  it('restores from a snapshot plus tail ops: same board, seq, creators, and dedupe', async () => {
    const store = new MemoryOpStore();
    const live = new Room('b', store);
    const a = peer('ua');
    live.join(a);
    await live.handleOps(a, [create('k-1', 1, 'stroke'), create('r-1', 2)]);
    const snapshot = { seq: live.currentSeq, state: live.persistentState() };
    await live.handleOps(a, [update('r-1', 3, 9)]);

    const restored = new Room('b', new MemoryOpStore());
    restored.restore(snapshot, store.ops.filter((o) => o.seq > snapshot.seq));
    expect(restored.snapshot()).toEqual(live.snapshot());
    expect(restored.currentSeq).toBe(3);

    const again = peer('ua');
    restored.join(again);
    // The stroke's creator survived the snapshot, so ua may still append and others may not.
    await restored.handleOps(again, [append('k-1', 4)]);
    expect(again.inbox.at(-1)).toEqual({ t: 'ack', opIds: ['op-a-4'], seq: 4 });
    const other = peer('ub');
    restored.join(other);
    await restored.handleOps(other, [append('k-1', 5)]);
    expect(other.inbox.at(-1)).toMatchObject({ t: 'reject', reason: 'not_author' });
    // A tail op resent after the restart is acked with its original seq, not re-stored.
    await restored.handleOps(again, [update('r-1', 3, 9)]);
    expect(again.inbox.at(-1)).toEqual({ t: 'ack', opIds: ['op-u-3'], seq: 3 });
  });

  it('setRole pushes the new role and applies it to the next batch', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua', 'viewer');
    room.join(a);
    room.setRole('ua', 'editor');
    expect(a.inbox.at(-1)).toEqual({ t: 'role', role: 'editor' });
    await room.handleOps(a, [create('c-1', 1)]);
    expect(a.inbox.at(-1)).toMatchObject({ t: 'ack' });
  });

  it('disconnect closes one user, or everyone', () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    room.disconnect('ub', 4003, 'removed_from_board');
    expect([a.closed, b.closed]).toEqual([null, 4003]);
    expect(room.peerCount).toBe(1);
    room.disconnect(null, 4004, 'board_deleted');
    expect(a.closed).toBe(4004);
    expect(room.peerCount).toBe(0);
  });
});

describe('Room: presence', () => {
  it('welcome lists who is already here; others hear peer-join and peer-leave', () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    const b = peer('ub');
    room.join(a);
    const welcome = room.join(b);
    expect(welcome).toMatchObject({ you: { peerId: b.peerId, userId: 'ub', name: 'UB' }, peers: [{ peerId: a.peerId, userId: 'ua', name: 'UA' }] });
    expect(a.presence).toEqual([{ t: 'peer-join', peer: { peerId: b.peerId, userId: 'ub', name: 'UB' } }]);
    room.leave(b);
    expect(a.presence.at(-1)).toEqual({ t: 'peer-leave', peerId: b.peerId });
    room.leave(b); // leaving twice announces once
    expect(a.presence.filter((m) => m.t === 'peer-leave')).toHaveLength(1);
  });

  it('relays cursors and selections to everyone else, viewers included, and never applies them', () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua', 'viewer');
    const b = peer('ub');
    room.join(a);
    room.join(b);
    room.relayPresence(a, { t: 'cursor', x: 10, y: 20 });
    room.relayPresence(a, { t: 'select', ids: ['x-1'] });
    room.relayPresence(a, { t: 'typing', id: 'x-1' });
    expect(b.presence.slice(-3)).toEqual([
      { t: 'cursor', peerId: a.peerId, x: 10, y: 20 },
      { t: 'select', peerId: a.peerId, ids: ['x-1'] },
      { t: 'typing', peerId: a.peerId, id: 'x-1' },
    ]);
    expect(a.presence.some((m) => m.t === 'cursor')).toBe(false); // not echoed back
    expect(room.snapshot().shapes).toEqual([]);
    expect(room.currentSeq).toBe(0);
  });

  it('sweep terminates peers silent since before the cutoff', () => {
    const room = new Room('b', new MemoryOpStore());
    const fresh = peer('ua');
    const stale = peer('ub');
    fresh.lastSeen = 100;
    stale.lastSeen = 10;
    room.join(fresh);
    room.join(stale);
    expect(room.sweep(50)).toBe(1);
    expect([fresh.terminated, stale.terminated]).toEqual([false, true]);
  });
});

describe('Room: catch-up and tombstone GC', () => {
  const del = (id: string, t: number): Op => ({ kind: 'update', opId: `op-d-${id}-${t}`, stamp: stamp(t), id, props: { deleted: true } });
  const undel = (id: string, t: number): Op => ({ kind: 'update', opId: `op-ud-${id}-${t}`, stamp: stamp(t), id, props: { deleted: false } });

  it('a client with lastSeq inside the log gets only the ops after it', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('c-1', 1), update('c-1', 2, 5), update('c-1', 3, 6)]);
    const back = peer('ua');
    const welcome = room.join(back, 1);
    expect(welcome).toMatchObject({ t: 'welcome', seq: 3, ops: [update('c-1', 2, 5), update('c-1', 3, 6)] });
    expect(welcome.t === 'welcome' && welcome.snapshot).toBeUndefined();
    expect(room.join(peer('ua'), 3)).toMatchObject({ ops: [] }); // up to date: nothing to send
  });

  it('first joins, lastSeq from the future, and lastSeq below the log floor get a snapshot', async () => {
    const room = new Room('b', new MemoryOpStore());
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('c-1', 1), update('c-1', 2, 5), update('c-1', 3, 6)]);
    expect(room.join(peer('x'), 0)).toHaveProperty('snapshot');
    expect(room.join(peer('x'), 99)).toHaveProperty('snapshot');
    room.trimLog(2); // a snapshot pruned ops <= 2
    expect(room.join(peer('x'), 1)).toHaveProperty('snapshot');
    expect(room.join(peer('x'), 2)).toMatchObject({ ops: [update('c-1', 3, 6)] });
  });

  it('caps the log; clients older than what was dropped get a snapshot', async () => {
    const room = new Room('b', new MemoryOpStore(), { maxLogOps: 2 });
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('c-1', 1), update('c-1', 2, 5), update('c-1', 3, 6), update('c-1', 4, 7)]);
    expect(room.catchUp(1)).toBeNull();
    expect(room.catchUp(2)).toEqual([update('c-1', 3, 6), update('c-1', 4, 7)]);
  });

  it('collects tombstones whose delete committed before the cutoff, and only those', async () => {
    let now = 1_000;
    const room = new Room('b', new MemoryOpStore(), { now: () => now });
    const a = peer('ua');
    room.join(a);
    await room.handleOps(a, [create('old-1', 1), create('new-1', 2), create('back-1', 3), create('live-1', 4)]);
    await room.handleOps(a, [del('old-1', 5), del('back-1', 6)]);
    now = 5_000;
    await room.handleOps(a, [del('new-1', 7), undel('back-1', 8)]);
    expect(room.collectTombstones(2_000)).toBe(1); // old-1 only: new-1 is too recent, back-1 was restored
    expect(room.snapshot().shapes.map((s) => s.id).sort()).toEqual(['back-1', 'live-1', 'new-1']);
    expect(room.persistentState().deletedAt).toEqual({ 'new-1': 5_000 });
    // A client from before the GC may still hold old-1: it gets a snapshot, not catch-up.
    expect(room.catchUp(7)).toBeNull();
    expect(room.catchUp(8)).toEqual([]);
    // An op for the collected shape is now unknown.
    a.inbox.length = 0;
    await room.handleOps(a, [update('old-1', 9, 1)]);
    expect(a.inbox).toEqual([expect.objectContaining({ t: 'reject', reason: 'unknown_shape', shape: null })]);
  });

  it('restores tombstone ages from snapshots and from board_ops.created_at', () => {
    const room = new Room('b', new MemoryOpStore(), { now: () => 50_000 });
    room.restore(
      {
        seq: 2,
        state: {
          board: { shapes: [{ id: 'a-1', regs: { deleted: { value: true, stamp: stamp(2) } }, chunks: [] }, { id: 'b-1', regs: { deleted: { value: true, stamp: stamp(2) } }, chunks: [] }] },
          creators: {},
          deletedAt: { 'a-1': 100 },
        },
      },
      [
        { boardId: 'b', seq: 3, opId: 'x', userId: 'u', op: create('c-1', 3), createdAt: new Date(200) },
        { boardId: 'b', seq: 4, opId: 'y', userId: 'u', op: del('c-1', 4), createdAt: new Date(300) },
      ],
    );
    // a-1 from the snapshot's ages, c-1 from created_at, b-1 (no recorded age) counted from now.
    expect(room.persistentState().deletedAt).toEqual({ 'a-1': 100, 'b-1': 50_000, 'c-1': 300 });
    expect(room.catchUp(3)).toEqual([del('c-1', 4)]);
  });
});
