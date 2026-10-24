import type { FastifyBaseLogger } from 'fastify';
import type { Metrics } from '../metrics';
import type { Room } from '../ws/Room';
import type { OpWriter } from './OpWriter';
import type { Repo } from './repo';

/**
 * Periodic snapshots (system-design.md, "Snapshotter"): after `everyOps` ops, or `everyMs` of
 * activity, or when a room unloads. Loading a board then replays at most one snapshot's worth
 * of ops, however old the board is.
 *
 * A snapshot must never contain an op that isn't durable, or a crash could leave a snapshot
 * that includes an op the log doesn't. So the state is captured first (synchronously, at seq
 * S), then we wait until the OpWriter has committed everything appended so far (which covers
 * every op <= S), and only then write it.
 *
 * One snapshot per board at a time: an in-process flag per room, plus the Redis lock
 * `snap-lock:{boardId}` across servers (a server that doesn't get it skips this round).
 *
 * The snapshot is labelled with the room's watermark `upTo`: every op up to it is in the
 * state. The state may also hold later ops that arrived out of order; loading re-applies them
 * from the log, which LWW makes harmless.
 */
export type SnapshotLock = (boardId: string) => Promise<(() => Promise<void>) | null>;

export class Snapshotter {
  constructor(
    private readonly repo: Repo,
    private readonly writer: OpWriter,
    private readonly log: FastifyBaseLogger,
    private readonly everyOps: number,
    private readonly everyMs: number,
    private readonly metrics?: Metrics,
    /** Tombstones whose delete committed longer ago than this are removed at snapshot time. */
    private readonly tombstoneTtlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    /** Cross-server lock (Redis); none in single-process tests. */
    private readonly lock?: SnapshotLock,
  ) {}

  /** Called by the room after it accepts ops. */
  noteOps(room: Room, count: number): void {
    const s = room.snapshots;
    s.opsSince += count;
    if (s.opsSince >= this.everyOps) {
      void this.snapshot(room);
    } else if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = null;
        void this.snapshot(room);
      }, this.everyMs);
    }
  }

  /** Takes a snapshot now if anything changed since the last one. */
  async snapshot(room: Room): Promise<void> {
    const s = room.snapshots;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.running || room.upTo <= s.lastSeq) return;
    s.running = true;
    const started = performance.now();
    let release: (() => Promise<void>) | null = null;
    try {
      if (this.lock) {
        release = await this.lock(room.boardId).catch((err: unknown) => {
          this.log.warn({ err: { message: (err as Error).message }, boardId: room.boardId }, 'snapshot lock unavailable (Redis)');
          return null;
        });
        if (!release) {
          // Another server is snapshotting this board (or Redis is down): try again later.
          this.retryLater(room);
          return;
        }
      }
      // Tombstone GC (algorithms.md §4), before capturing, so the snapshot no longer has them.
      const collected = room.collectTombstones(this.now() - this.tombstoneTtlMs);
      if (collected > 0) {
        this.metrics?.tombstonesCollected.inc(collected);
        this.log.info({ boardId: room.boardId, collected }, 'tombstones collected');
      }
      const seq = room.upTo;
      const state = room.persistentState();
      const covered = s.opsSince;
      await this.writer.drain();
      // Keep the ops between the previous snapshot and this one (useful for catch-up from a
      // recent lastSeq); everything older is covered twice over and can go. One transaction.
      await this.repo.writeSnapshotAndPrune(room.boardId, seq, state, state.board.shapes.length, s.previousSeq);
      room.trimLog(s.previousSeq); // the catch-up log mirrors what Postgres still has
      s.previousSeq = s.lastSeq;
      s.lastSeq = seq;
      s.opsSince = Math.max(0, s.opsSince - covered);
      const ms = performance.now() - started;
      this.metrics?.snapshotMs.observe(ms);
      this.log.info({ boardId: room.boardId, seq, shapes: state.board.shapes.length, snapshot_ms: Math.round(ms) }, 'snapshot written');
    } catch (err) {
      this.log.error({ err, boardId: room.boardId }, 'snapshot failed; will retry on the next trigger');
    } finally {
      s.running = false;
      await release?.().catch(() => {}); // expires on its own after 30 s anyway
    }
    // Ops that arrived while we were writing may already be past the threshold.
    if (s.opsSince >= this.everyOps) void this.snapshot(room);
  }

  /** Schedules another attempt after `everyMs`, unless one is already scheduled. */
  private retryLater(room: Room): void {
    const s = room.snapshots;
    if (s.timer) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.snapshot(room);
    }, this.everyMs);
  }
}
