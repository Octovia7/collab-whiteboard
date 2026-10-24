import type { Op } from '@whiteboard/shared';

/**
 * Unacked ops survive a reload or a closed tab (system-design.md, "Offline queue").
 *
 * Each tab keeps its own queue, keyed by board + a tab ID from sessionStorage (it survives a
 * reload of the same tab, and differs between tabs), so two tabs on one board never overwrite
 * each other's queue. A live tab holds a Web Lock named after its queue for as long as it is
 * open; the browser releases it when the tab closes or reloads. So a queue whose lock can be
 * taken belongs to no open tab: it is orphaned, and the tab loading the board adopts it and
 * sends its ops. Sending an op twice is harmless (the server dedupes by opId), so the only
 * thing that matters is that no op is lost: an adopter writes the ops into its own queue
 * before deleting the orphan's.
 */

export interface QueueRecord {
  /** `${boardId}:${tabId}` */
  key: string;
  boardId: string;
  tabId: string;
  /** Who made these edits: another user logging in on this browser must not send them. */
  userId: string;
  ops: Op[];
}

/** Where queues are kept (IndexedDB in the browser, a Map in unit tests). */
export interface QueueStorage {
  list(boardId: string): Promise<QueueRecord[]>;
  put(record: QueueRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Takes an exclusive lock if nobody holds it; resolves to its release function, or null. */
export type TryLock = (name: string) => Promise<(() => void) | null>;

/** This tab's ID, kept across reloads of the same tab. */
export interface TabIdStore {
  get(): string | null;
  set(id: string): void;
}

export interface OpenOptions {
  boardId: string;
  userId: string;
  storage: QueueStorage;
  tryLock: TryLock;
  tabIds: TabIdStore;
  newTabId?: () => string;
}

const lockName = (boardId: string, tabId: string) => `wb-queue:${boardId}:${tabId}`;

export class OfflineQueue {
  private latest: Op[] | null = null;
  private saved = 0;
  private restored = 0;
  private writing = false;
  private closed = false;

  private constructor(
    private readonly storage: QueueStorage,
    private readonly record: Omit<QueueRecord, 'ops'>,
    private readonly release: () => void,
  ) {}

  /**
   * Takes this tab's lock, then collects the ops of every queue for this board that no open
   * tab owns: this tab's own (left by the reload) and those of closed tabs. Returns them in
   * stamp order, which puts every create before later edits of the same shape (an edit made
   * after seeing a create observed its stamp), so the server never sees an edit to a shape it
   * doesn't know yet.
   */
  static async open(o: OpenOptions): Promise<{ queue: OfflineQueue; restored: Op[] }> {
    const newTabId = o.newTabId ?? (() => crypto.randomUUID());
    let tabId = o.tabIds.get() ?? newTabId();
    let release = await o.tryLock(lockName(o.boardId, tabId));
    if (!release) {
      // Another open tab holds this ID: a duplicated tab copies sessionStorage. Become a new tab.
      tabId = newTabId();
      release = await o.tryLock(lockName(o.boardId, tabId));
      if (!release) throw new Error('offline queue: could not lock a fresh tab id');
    }
    o.tabIds.set(tabId);
    const queue = new OfflineQueue(o.storage, { key: `${o.boardId}:${tabId}`, boardId: o.boardId, tabId, userId: o.userId }, release);

    const restored = new Map<string, Op>();
    const adopted: { key: string; release: () => void }[] = [];
    try {
      for (const rec of await o.storage.list(o.boardId)) {
        // Our own record: our lock is held already. Anyone else's: adopt only if its tab is gone.
        const own = rec.tabId === tabId;
        const releaseOrphan = own ? () => {} : await o.tryLock(lockName(o.boardId, rec.tabId));
        if (!releaseOrphan) continue; // a live tab: it sends its own ops
        adopted.push({ key: rec.key, release: releaseOrphan });
        if (rec.userId !== o.userId) continue; // someone else's edits: dropped, never sent as us
        for (const op of rec.ops) restored.set(op.opId, op);
      }
      const ops = [...restored.values()].sort((a, b) => a.stamp.t - b.stamp.t || (a.stamp.client < b.stamp.client ? -1 : a.stamp.client > b.stamp.client ? 1 : 0));
      // Ours first, then delete the orphans: a crash in between leaves duplicates, never a loss.
      if (ops.length > 0) await o.storage.put({ ...queue.record, ops });
      queue.saved = ops.length;
      queue.restored = ops.length;
      for (const a of adopted) if (a.key !== queue.record.key || ops.length === 0) await o.storage.remove(a.key);
      return { queue, restored: ops };
    } catch (err) {
      // Unusable: let go of our lock too, or other tabs would think this tab still owns its queue.
      queue.close();
      throw err;
    } finally {
      for (const a of adopted) a.release();
    }
  }

  get tabId(): string {
    return this.record.tabId;
  }

  /** How many ops open() restored from this tab's own and orphaned queues. */
  get restoredCount(): number {
    return this.restored;
  }

  /** How many ops the last completed write saved (tests wait on it before a reload). */
  get savedCount(): number {
    return this.saved;
  }

  /**
   * Replaces the saved queue with `ops` (every unacked op). Write-behind: at most one write is
   * in flight, and the newest list is written when it finishes, so a burst of edits costs a
   * few writes, and the last state always lands. An empty list deletes the record.
   */
  save(ops: readonly Op[]): void {
    if (this.closed) return;
    this.latest = [...ops];
    if (!this.writing) void this.drain();
  }

  /** Resolves once everything passed to save() is written (tests and shutdown). */
  async flushed(): Promise<void> {
    while (this.writing) await new Promise((r) => setTimeout(r, 5));
  }

  /** Stops saving and releases the lock; the saved queue stays for the next load to adopt. */
  close(): void {
    this.closed = true;
    this.release();
  }

  private async drain(): Promise<void> {
    this.writing = true;
    try {
      while (this.latest) {
        const ops = this.latest;
        this.latest = null;
        try {
          if (ops.length === 0) await this.storage.remove(this.record.key);
          else await this.storage.put({ ...this.record, ops });
          this.saved = ops.length;
        } catch (err) {
          // Storage full or unavailable: the ops are still in memory and still being sent.
          console.warn('offline queue: save failed', err);
        }
      }
    } finally {
      this.writing = false;
    }
  }
}

// ---- Browser implementations ----

const DB_NAME = 'whiteboard-offline';
const STORE = 'queues';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Queues in IndexedDB, one record per board + tab, found by key prefix. */
export async function indexedDbStorage(): Promise<QueueStorage> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'key' });
  const db = await request(open);
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  // A put resolves when its transaction commits, not when the request succeeds: only then is
  // the record on disk.
  const commit = (mode: IDBTransactionMode, run: (s: IDBObjectStore) => void) =>
    new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      run(t.objectStore(STORE));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
    });
  return {
    // Keys are `${boardId}:${tabId}`, so one board's queues are a key range.
    list: (boardId) => request(tx('readonly').getAll(IDBKeyRange.bound(`${boardId}:`, `${boardId}:￿`))) as Promise<QueueRecord[]>,
    put: (record) => commit('readwrite', (s) => s.put(record)),
    remove: (key) => commit('readwrite', (s) => s.delete(key)),
  };
}

/**
 * navigator.locks with ifAvailable: the callback gets null when the lock is held elsewhere.
 * Otherwise we keep the lock until release() by returning a promise that only it resolves.
 */
export const webLock: TryLock = (name) =>
  new Promise((resolve, reject) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });

export const sessionTabIds: TabIdStore = {
  get: () => {
    try {
      return sessionStorage.getItem('wb-tab-id');
    } catch {
      return null;
    }
  },
  set: (id) => {
    try {
      sessionStorage.setItem('wb-tab-id', id);
    } catch {
      // No sessionStorage: every load is a new tab, whose old queue is adopted as an orphan.
    }
  },
};

/**
 * The browser queue for this board, or null where IndexedDB or Web Locks are missing or
 * broken (old browsers, some private modes): the app then works as before, minus surviving a
 * reload. Gives up after `timeoutMs` so a hung IndexedDB never keeps the board from loading.
 *
 * Opens of one board run one at a time (a waiting Web Lock), and one that was cancelled (the
 * component unmounted, as React's StrictMode does once in dev) or timed out closes its queue
 * before the next starts. Otherwise the next open would find this tab's lock still held and
 * leave the tab's own saved queue behind as if another tab owned it.
 */
export async function openBrowserQueue(
  boardId: string,
  userId: string,
  cancelled: () => boolean,
  timeoutMs = 3000,
): Promise<{ queue: OfflineQueue; restored: Op[] } | null> {
  if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined' || !('locks' in navigator)) return null;
  let timedOut = false;
  // (The async wrapper flattens the DOM typings' Promise<Promise<T>> for request().)
  const opening = (async () =>
    await navigator.locks.request(`wb-queue-open:${boardId}`, async () => {
      const result = await OfflineQueue.open({ boardId, userId, storage: await indexedDbStorage(), tryLock: webLock, tabIds: sessionTabIds });
      if (!cancelled() && !timedOut) return result;
      // Nobody will use it: release the lock now, so the saved ops can be adopted by the next open.
      result.queue.close();
      return null;
    }))();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([opening, timeout]);
    // The timer can fire between the open finishing and its promise settling: close that one.
    if (!result) void opening.then((r) => r?.queue.close(), () => {});
    return result;
  } catch (err) {
    console.warn('offline queue unavailable', err);
    return null;
  } finally {
    clearTimeout(timer);
    opening.catch(() => {}); // a late failure after the timeout has nobody else to report to
  }
}
