import type { Role } from '@whiteboard/shared';
import { CLOSE } from '@whiteboard/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Metrics } from '../metrics';
import type { OpWriter } from '../persistence/OpWriter';
import type { Repo } from '../persistence/repo';
import type { Snapshotter } from '../persistence/Snapshotter';
import { listOnline, putOnline, readSeq, refreshSockets, removeOnline, reserveSeqs } from '../redisState';
import type { RedisBus, BoardMessage } from './RedisBus';
import { Room, peerInfo } from './Room';
import type { Peer, PresenceEvent, RoomObserver } from './Room';

export interface RoomManagerDeps {
  repo: Repo;
  writer: OpWriter;
  snapshotter: Snapshotter;
  redis: Redis;
  bus: RedisBus;
  log: FastifyBaseLogger;
  unloadAfterMs: number;
  ackDelayMs?: number;
  metrics?: Metrics;
  /** Drop peers silent for this long (no ops, presence or heartbeat)... */
  presenceTimeoutMs?: number;
  /** ...checking this often. */
  presenceSweepMs?: number;
  /** Gap filler: poll Postgres this often; give a missing seq up as a hole after this long. */
  gapPollMs?: number;
  holeAfterMs?: number;
  /** Open sockets on this server, for refreshing their entries in `sockets:{userId}`. */
  liveSockets?: () => { userId: string; connId: string }[];
}

/** How long a joining client may wait for this server to catch up to what it already saw. */
const JOIN_WAIT_MS = 6_000;

/**
 * boardId -> Room. A room is loaded on first use from the latest snapshot plus the ops after
 * it, and unloaded (after a final snapshot) once nobody has been connected for `unloadAfterMs`,
 * so a page refresh doesn't pay for a reload. Rooms for the same board on different servers
 * stay in sync through RedisBus.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** Shared by concurrent joins, so a board is never loaded twice. */
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly observer: RoomObserver | undefined;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly offPaused: () => void;

  constructor(private readonly deps: RoomManagerDeps) {
    const timeout = deps.presenceTimeoutMs ?? 15_000;
    // Heartbeat sweep (algorithms.md §8), every few seconds: drop our own silent sockets,
    // refresh our entries in Redis, and remove other servers' entries that stopped being
    // refreshed (their server crashed), announcing their peer-leave.
    this.sweepTimer = setInterval(() => void this.sweep(timeout), deps.presenceSweepMs ?? 5_000);
    this.sweepTimer.unref(); // never keeps the process alive on its own
    const m = deps.metrics;
    this.observer = m && {
      relayed: (ms) => m.opRelayMs.observe(ms),
      committed: (ms) => m.opCommitMs.observe(ms),
      accepted: (n) => m.opsAccepted.inc(n),
      rejected: (reason) => m.opsRejected.inc({ reason }),
      gapFilled: (n) => m.gapOpsFilled.inc(n),
      holesSkipped: (n) => m.holesSkipped.inc(n),
    };
    // Saving paused/resumed (Postgres failing for 30 s, then back): tell every local socket.
    this.offPaused = deps.writer.onPausedChange((paused) => {
      m?.savingPaused.set(paused ? 1 : 0);
      for (const room of this.rooms.values()) room.broadcast({ t: 'saving', paused });
    });
  }

  get size(): number {
    return this.rooms.size;
  }

  /** The loaded room, if any (no load). */
  peek(boardId: string): Room | undefined {
    return this.rooms.get(boardId);
  }

  async join(boardId: string, peer: Peer, lastSeq = 0): Promise<Room> {
    const room = await this.get(boardId);
    const timer = this.unloadTimers.get(boardId);
    if (timer) clearTimeout(timer);
    this.unloadTimers.delete(boardId);
    // The client may have seen more on another server (it reconnected here). Catch up to it
    // first, or its next edit to a shape this server hasn't heard of yet would be rejected.
    if (lastSeq > room.upTo) await room.waitForWatermark(lastSeq, JOIN_WAIT_MS);
    const remote = await this.remotePeers(boardId, room);
    const welcome = room.join(peer, lastSeq, remote);
    if (welcome.t === 'welcome') {
      if (welcome.ops) {
        this.deps.metrics?.catchupOps.observe(welcome.ops.length);
        this.deps.metrics?.welcomes.inc({ kind: 'catchup' });
      } else {
        this.deps.metrics?.welcomes.inc({ kind: 'snapshot' });
      }
    }
    peer.send(welcome);
    if (this.deps.writer.paused) peer.send({ t: 'saving', paused: true });
    putOnline(this.deps.redis, boardId, [peerInfo(peer)], this.deps.bus.serverId).catch((err: unknown) =>
      this.deps.log.warn({ err: { message: (err as Error).message } }, 'could not add peer to the online list'),
    );
    return room;
  }

  leave(room: Room, peer: Peer): void {
    room.leave(peer);
    removeOnline(this.deps.redis, room.boardId, peer.peerId).catch(() => {}); // else swept after 15 s
    if (room.peerCount > 0 || this.rooms.get(room.boardId) !== room) return;
    const timer = setTimeout(() => void this.unload(room), this.deps.unloadAfterMs);
    this.unloadTimers.set(room.boardId, timer);
  }

  /** A role change over REST: applied here, and on every other server through Redis. */
  setRole(boardId: string, userId: string, role: Role): void {
    this.rooms.get(boardId)?.setRole(userId, role);
    this.deps.bus.publishBoard(boardId, { type: 'role', userId, role });
  }

  removeMember(boardId: string, userId: string): void {
    this.rooms.get(boardId)?.disconnect(userId, CLOSE.removedFromBoard, 'removed_from_board');
    this.deps.bus.publishBoard(boardId, { type: 'removed', userId });
  }

  async deleteBoard(boardId: string): Promise<void> {
    this.deps.bus.publishBoard(boardId, { type: 'deleted' });
    await this.closeDeleted(boardId);
  }

  /** Graceful shutdown: snapshot every loaded room. */
  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.offPaused();
    for (const timer of this.unloadTimers.values()) clearTimeout(timer);
    this.unloadTimers.clear();
    await Promise.all([...this.rooms.values()].map((room) => this.unload(room)));
  }

  private async closeDeleted(boardId: string): Promise<void> {
    const room = this.rooms.get(boardId);
    if (!room) return;
    room.disconnect(null, CLOSE.boardDeleted, 'board_deleted');
    await this.unload(room);
  }

  /** Peers connected to other servers, from the shared online list (empty if Redis is down). */
  private async remotePeers(boardId: string, room: Room) {
    try {
      const local = new Set(room.localPeers().map((p) => p.peerId));
      const fresh = Date.now() - (this.deps.presenceTimeoutMs ?? 15_000);
      return (await listOnline(this.deps.redis, boardId))
        .filter((e) => !local.has(e.peerId) && e.lastSeen >= fresh)
        .map(({ peerId, userId, name }) => ({ peerId, userId, name }));
    } catch {
      return []; // presence is best effort; they show up as soon as they move
    }
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
    const { repo, writer, snapshotter, log, redis, bus } = this.deps;
    const room = new Room(boardId, writer, {
      onAccepted: (r, n) => snapshotter.noteOps(r, n),
      ackDelayMs: this.deps.ackDelayMs ?? 0,
      observer: this.observer,
      reserveSeqs: (n, floor) => reserveSeqs(redis, boardId, n, floor),
      publish: (event) => bus.publishBoard(boardId, event),
      publishPresence: (event) => bus.publishPresence(boardId, event),
      fetchOps: (after, to) => repo.opsInRange(boardId, after, to),
      findDurable: (opIds) => repo.opSeqs(boardId, opIds),
      isPaused: () => writer.paused,
      gapPollMs: this.deps.gapPollMs,
      holeAfterMs: this.deps.holeAfterMs,
    });
    // Subscribe before reading Postgres, holding messages until the room is restored: an op
    // published in between is then either in what we read or in the buffer (or both, which is
    // fine: applying twice is a no-op).
    let buffered: { kind: 'board'; msg: BoardMessage }[] | null = [];
    const presence = (msg: PresenceEvent) => room.deliverPresence(msg);
    const board = (msg: BoardMessage) => {
      if (buffered) buffered.push({ kind: 'board', msg });
      else this.onBoardMessage(room, msg);
    };
    await bus.subscribeBoard(boardId, { board, presence });
    let loaded: { snapshotSeq: number; tailOps: number };
    try {
      const saved = await repo.loadBoard(boardId);
      loaded = { snapshotSeq: saved.snapshot?.seq ?? 0, tailOps: saved.ops.length };
      room.restore(saved.snapshot, saved.ops);
      // Seqs handed out but not in what we read yet (in flight to Postgres on another server,
      // or holes) are gaps: the room fills them from Postgres or skips them after 5 s.
      room.noteSeqExists(await readSeq(redis, boardId));
      for (const b of buffered) this.onBoardMessage(room, b.msg);
      buffered = null;
    } catch (err) {
      await bus.unsubscribeBoard(boardId);
      room.dispose();
      throw err;
    }
    this.rooms.set(boardId, room);
    const loadMs = performance.now() - started;
    this.deps.metrics?.boardLoadMs.observe(loadMs);
    this.deps.metrics?.roomsLoaded.set(this.rooms.size);
    log.info(
      {
        boardId,
        board_load_ms: Math.round(loadMs * 10) / 10,
        ...loaded,
        shapes: room.shapeCount,
        upTo: room.upTo,
      },
      'board loaded',
    );
    return room;
  }

  private onBoardMessage(room: Room, msg: BoardMessage): void {
    switch (msg.type) {
      case 'ops':
        room.receiveRemote(msg.userId, msg.ops);
        return;
      case 'skip':
        room.skip(msg.seqs);
        return;
      case 'role':
        room.setRole(msg.userId, msg.role);
        return;
      case 'removed':
        room.disconnect(msg.userId, CLOSE.removedFromBoard, 'removed_from_board');
        return;
      case 'deleted':
        void this.closeDeleted(room.boardId);
        return;
    }
  }

  private async unload(room: Room): Promise<void> {
    this.unloadTimers.delete(room.boardId);
    if (this.rooms.get(room.boardId) !== room) return;
    await this.deps.snapshotter.snapshot(room);
    // Someone may have joined while the snapshot was being written; keep the room then.
    if (room.peerCount > 0) return;
    this.rooms.delete(room.boardId);
    room.dispose();
    // A snapshot retry (the lock was busy) has nothing left to do: the lock holder covers it.
    if (room.snapshots.timer) clearTimeout(room.snapshots.timer);
    room.snapshots.timer = null;
    await this.deps.bus.unsubscribeBoard(room.boardId);
    this.deps.metrics?.roomsLoaded.set(this.rooms.size);
    this.deps.log.info({ boardId: room.boardId }, 'board unloaded');
  }

  private async sweep(timeoutMs: number): Promise<void> {
    const cutoff = performance.now() - timeoutMs;
    let dropped = 0;
    for (const room of this.rooms.values()) dropped += room.sweep(cutoff);
    if (dropped > 0) {
      this.deps.metrics?.heartbeatTimeouts.inc(dropped);
      this.deps.log.info({ dropped }, 'dropped silent peers');
    }
    const { redis, bus } = this.deps;
    try {
      await refreshSockets(redis, this.deps.liveSockets?.() ?? [], timeoutMs);
      const staleBefore = Date.now() - timeoutMs;
      for (const room of this.rooms.values()) {
        await putOnline(redis, room.boardId, room.localPeers().map(peerInfo), bus.serverId);
        for (const entry of await listOnline(redis, room.boardId)) {
          if (entry.serverId === bus.serverId || entry.lastSeen >= staleBefore) continue;
          // Only the server whose HDEL wins announces the leave, so it's announced once.
          if (!(await removeOnline(redis, room.boardId, entry.peerId))) continue;
          const leave: PresenceEvent = { type: 'leave', peerId: entry.peerId };
          room.deliverPresence(leave);
          bus.publishPresence(room.boardId, leave);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err: { message: (err as Error).message } }, 'presence sweep failed (Redis)');
    }
  }
}
