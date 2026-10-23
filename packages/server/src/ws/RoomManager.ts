import type { Role } from '@whiteboard/shared';
import { CLOSE } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from '../metrics';
import type { OpStore } from '../persistence/OpStore';
import type { Repo } from '../persistence/repo';
import type { Snapshotter } from '../persistence/Snapshotter';
import { Room } from './Room';
import type { Peer, RoomObserver } from './Room';

export interface RoomManagerDeps {
  repo: Repo;
  store: OpStore;
  snapshotter: Snapshotter;
  log: FastifyBaseLogger;
  unloadAfterMs: number;
  ackDelayMs?: number;
  metrics?: Metrics;
  /** Drop peers silent for this long (no ops, presence or heartbeat)... */
  presenceTimeoutMs?: number;
  /** ...checking this often. */
  presenceSweepMs?: number;
}

/**
 * boardId -> Room. A room is loaded on first use from the latest snapshot plus the ops after
 * it, and unloaded (after a final snapshot) once nobody has been connected for `unloadAfterMs`,
 * so a page refresh doesn't pay for a reload.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** Shared by concurrent joins, so a board is never loaded twice. */
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly observer: RoomObserver | undefined;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RoomManagerDeps) {
    const timeout = deps.presenceTimeoutMs ?? 15_000;
    // Heartbeat sweep (algorithms.md §8): a closed laptop lid sends no goodbye, so peers we
    // haven't heard from are dropped, and everyone else gets `peer-leave`.
    this.sweepTimer = setInterval(() => {
      const cutoff = performance.now() - timeout;
      let dropped = 0;
      for (const room of this.rooms.values()) dropped += room.sweep(cutoff);
      if (dropped > 0) {
        deps.metrics?.heartbeatTimeouts.inc(dropped);
        deps.log.info({ dropped }, 'dropped silent peers');
      }
    }, deps.presenceSweepMs ?? 5_000);
    this.sweepTimer.unref(); // never keeps the process alive on its own
    const m = deps.metrics;
    this.observer = m && {
      relayed: (ms) => m.opRelayMs.observe(ms),
      committed: (ms) => m.opCommitMs.observe(ms),
      accepted: (n) => m.opsAccepted.inc(n),
      rejected: (reason) => m.opsRejected.inc({ reason }),
    };
  }

  get size(): number {
    return this.rooms.size;
  }

  /** The loaded room, if any (no load). */
  peek(boardId: string): Room | undefined {
    return this.rooms.get(boardId);
  }

  async join(boardId: string, peer: Peer): Promise<Room> {
    const room = await this.get(boardId);
    const timer = this.unloadTimers.get(boardId);
    if (timer) clearTimeout(timer);
    this.unloadTimers.delete(boardId);
    peer.send(room.join(peer));
    return room;
  }

  leave(room: Room, peer: Peer): void {
    room.leave(peer);
    if (room.peerCount > 0 || this.rooms.get(room.boardId) !== room) return;
    const timer = setTimeout(() => void this.unload(room), this.deps.unloadAfterMs);
    this.unloadTimers.set(room.boardId, timer);
  }

  setRole(boardId: string, userId: string, role: Role): void {
    this.rooms.get(boardId)?.setRole(userId, role);
  }

  removeMember(boardId: string, userId: string): void {
    this.rooms.get(boardId)?.disconnect(userId, CLOSE.removedFromBoard, 'removed_from_board');
  }

  async deleteBoard(boardId: string): Promise<void> {
    const room = this.rooms.get(boardId);
    if (!room) return;
    room.disconnect(null, CLOSE.boardDeleted, 'board_deleted');
    await this.unload(room);
  }

  /** Graceful shutdown: snapshot every loaded room. */
  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const timer of this.unloadTimers.values()) clearTimeout(timer);
    this.unloadTimers.clear();
    await Promise.all([...this.rooms.values()].map((room) => this.unload(room)));
  }

  private get(boardId: string): Promise<Room> {
    const loaded = this.rooms.get(boardId);
    if (loaded) return Promise.resolve(loaded);
    let pending = this.loading.get(boardId);
    if (!pending) {
      pending = this.load(boardId).finally(() => this.loading.delete(boardId));
      this.loading.set(boardId, pending);
    }
    return pending;
  }

  private async load(boardId: string): Promise<Room> {
    const started = performance.now();
    const { repo, store, snapshotter, log } = this.deps;
    const saved = await repo.loadBoard(boardId);
    const room = new Room(boardId, store, {
      onAccepted: (r, n) => snapshotter.noteOps(r, n),
      ackDelayMs: this.deps.ackDelayMs ?? 0,
      observer: this.observer,
    });
    room.restore(saved.snapshot, saved.ops);
    // Seqs keep counting from the highest one ever assigned, so no seq is reused after a restart.
    const loggedMax = await repo.maxOpSeq(boardId);
    if (loggedMax > room.currentSeq) throw new Error(`board ${boardId}: log ahead of restored state`);
    this.rooms.set(boardId, room);
    const loadMs = performance.now() - started;
    this.deps.metrics?.boardLoadMs.observe(loadMs);
    this.deps.metrics?.roomsLoaded.set(this.rooms.size);
    log.info(
      {
        boardId,
        board_load_ms: Math.round(loadMs * 10) / 10,
        snapshotSeq: saved.snapshot?.seq ?? 0,
        tailOps: saved.ops.length,
        shapes: room.shapeCount,
      },
      'board loaded',
    );
    return room;
  }

  private async unload(room: Room): Promise<void> {
    this.unloadTimers.delete(room.boardId);
    if (this.rooms.get(room.boardId) !== room) return;
    await this.deps.snapshotter.snapshot(room);
    // Someone may have joined while the snapshot was being written; keep the room then.
    if (room.peerCount > 0) return;
    this.rooms.delete(room.boardId);
    this.deps.metrics?.roomsLoaded.set(this.rooms.size);
    this.deps.log.info({ boardId: room.boardId }, 'board unloaded');
  }
}
