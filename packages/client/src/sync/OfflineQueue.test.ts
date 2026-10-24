import type { Op } from '@whiteboard/shared';
import { describe, expect, it } from 'vitest';
import { OfflineQueue } from './OfflineQueue';
import type { QueueRecord, QueueStorage, TabIdStore, TryLock } from './OfflineQueue';

/** IndexedDB stand-in. Records are deep-copied in and out, as structured clone does. */
class MemoryStorage implements QueueStorage {
  readonly records = new Map<string, QueueRecord>();
  writes = 0;
  list(boardId: string) {
    return Promise.resolve([...this.records.values()].filter((r) => r.boardId === boardId).map((r) => structuredClone(r)));
  }
  async put(record: QueueRecord) {
    this.writes++;
    await Promise.resolve();
    this.records.set(record.key, structuredClone(record));
  }
  async remove(key: string) {
    this.writes++;
    await Promise.resolve();
    this.records.delete(key);
  }
}

/** navigator.locks stand-in: a set of held names. */
class Locks {
  readonly held = new Set<string>();
  readonly tryLock: TryLock = (name) => {
    if (this.held.has(name)) return Promise.resolve(null);
    this.held.add(name);
    return Promise.resolve(() => this.held.delete(name));
  };
}

/** One tab's sessionStorage. */
const tabIds = (initial: string | null = null): TabIdStore & { value: string | null } => ({
  value: initial,
  get() {
    return this.value;
  },
  set(id) {
    this.value = id;
  },
});

const op = (n: number, client = 'c1', t = n): Op => ({
  kind: 'create',
  opId: `${client}:${n}`,
  stamp: { t, client },
  shape: { id: `${client}-${n}`, type: 'rect', x: 0, y: 0, w: 1, h: 1, z: 'i0', color: '#000', deleted: false },
});

function env() {
  const storage = new MemoryStorage();
  const locks = new Locks();
  let ids = 0;
  const open = (tab: TabIdStore, userId = 'u1', boardId = 'b1') =>
    OfflineQueue.open({ boardId, userId, storage, tryLock: locks.tryLock, tabIds: tab, newTabId: () => `tab${++ids}` });
  return { storage, locks, open };
}

describe('OfflineQueue', () => {
  it('saves unacked ops and gives them back to the same tab after a reload', async () => {
    const { open, storage } = env();
    const tab = tabIds();
    const first = await open(tab);
    expect(first.restored).toEqual([]);
    first.queue.save([op(1), op(2)]);
    await first.queue.flushed();
    first.queue.close(); // the page unloads: the browser releases its locks

    const second = await open(tab);
    expect(second.queue.tabId).toBe(first.queue.tabId);
    expect(second.restored.map((o) => o.opId)).toEqual(['c1:1', 'c1:2']);
    expect([...storage.records.keys()]).toEqual([`b1:${first.queue.tabId}`]);
  });

  it('an empty save deletes the record', async () => {
    const { open, storage } = env();
    const { queue } = await open(tabIds());
    queue.save([op(1)]);
    await queue.flushed();
    queue.save([]);
    await queue.flushed();
    expect(storage.records.size).toBe(0);
  });

  it('writes at most one at a time, and the newest state always lands', async () => {
    const { open, storage } = env();
    const { queue } = await open(tabIds());
    for (let i = 1; i <= 50; i++) queue.save(Array.from({ length: i }, (_, k) => op(k + 1)));
    await queue.flushed();
    expect(storage.writes).toBeLessThan(5);
    expect([...storage.records.values()][0]?.ops).toHaveLength(50);
  });

  it("two open tabs on one board keep separate queues and never take each other's", async () => {
    const { open, storage } = env();
    const a = await open(tabIds());
    const b = await open(tabIds());
    expect(a.queue.tabId).not.toBe(b.queue.tabId);
    a.queue.save([op(1, 'ca')]);
    b.queue.save([op(1, 'cb')]);
    await Promise.all([a.queue.flushed(), b.queue.flushed()]);
    expect(storage.records.size).toBe(2);
    // A third tab opening now adopts nothing: both owners are alive.
    const c = await open(tabIds());
    expect(c.restored).toEqual([]);
    expect(storage.records.size).toBe(2);
  });

  it("adopts the queue of a closed tab, moving its ops into its own before deleting the orphan's", async () => {
    const { open, storage } = env();
    const closed = await open(tabIds());
    closed.queue.save([op(1, 'old'), op(2, 'old')]);
    await closed.queue.flushed();
    closed.queue.close();

    const fresh = await open(tabIds());
    expect(fresh.restored.map((o) => o.opId)).toEqual(['old:1', 'old:2']);
    expect([...storage.records.keys()]).toEqual([`b1:${fresh.queue.tabId}`]);
    expect(storage.records.get(`b1:${fresh.queue.tabId}`)?.ops).toHaveLength(2);
  });

  it("a duplicated tab (same sessionStorage id while the original is open) becomes a new tab", async () => {
    const { open } = env();
    const original = tabIds();
    const a = await open(original);
    a.queue.save([op(1)]);
    await a.queue.flushed();
    const copy = tabIds(original.value);
    const b = await open(copy);
    expect(b.queue.tabId).not.toBe(a.queue.tabId);
    expect(copy.value).toBe(b.queue.tabId);
    expect(b.restored).toEqual([]); // a's queue stays a's
  });

  it("discards queues saved by a different user, never sending them as the new one", async () => {
    const { open, storage } = env();
    const tab = tabIds();
    const alice = await open(tab, 'alice');
    alice.queue.save([op(1, 'a')]);
    await alice.queue.flushed();
    alice.queue.close();
    const bob = await open(tab, 'bob');
    expect(bob.restored).toEqual([]);
    expect(storage.records.size).toBe(0);
  });

  it('only looks at queues for this board', async () => {
    const { open, storage } = env();
    const other = await open(tabIds(), 'u1', 'b2');
    other.queue.save([op(1)]);
    await other.queue.flushed();
    other.queue.close();
    const here = await open(tabIds(), 'u1', 'b1');
    expect(here.restored).toEqual([]);
    expect(storage.records.size).toBe(1);
  });

  it('returns adopted ops in stamp order with duplicates removed', async () => {
    const { open, storage } = env();
    // Two orphans that share an op (an adopter crashed between writing its own and deleting).
    storage.records.set('b1:x', { key: 'b1:x', boardId: 'b1', tabId: 'x', userId: 'u1', ops: [op(5, 'cx', 5), op(9, 'cx', 9)] });
    storage.records.set('b1:y', { key: 'b1:y', boardId: 'b1', tabId: 'y', userId: 'u1', ops: [op(5, 'cx', 5), op(2, 'cy', 7)] });
    const { restored } = await open(tabIds());
    expect(restored.map((o) => o.opId)).toEqual(['cx:5', 'cy:2', 'cx:9']);
  });

  it('a storage failure while opening releases this tab’s lock', async () => {
    const { storage, locks } = env();
    storage.list = () => Promise.reject(new Error('IndexedDB broke'));
    await expect(OfflineQueue.open({ boardId: 'b1', userId: 'u1', storage, tryLock: locks.tryLock, tabIds: tabIds() })).rejects.toThrow('IndexedDB broke');
    expect(locks.held.size).toBe(0);
  });

  it('releases the locks of adopted orphans, and stops saving after close', async () => {
    const { open, storage, locks } = env();
    storage.records.set('b1:x', { key: 'b1:x', boardId: 'b1', tabId: 'x', userId: 'u1', ops: [op(1)] });
    const { queue } = await open(tabIds());
    expect([...locks.held]).toEqual([`wb-queue:b1:${queue.tabId}`]);
    queue.close();
    expect(locks.held.size).toBe(0);
    queue.save([op(2)]);
    await queue.flushed();
    expect(storage.records.get(`b1:${queue.tabId}`)?.ops.map((o) => o.opId)).toEqual(['c1:1']);
  });
});
