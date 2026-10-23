import type { FastifyBaseLogger } from 'fastify';
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
 * One snapshot per room at a time via an in-process flag; with several servers this becomes
 * the Redis lock `snap-lock:{boardId}` (milestone 8). Tombstone GC is deferred to milestone 7.
 */
export class Snapshotter {
  constructor(
    private readonly repo: Repo,
    private readonly writer: OpWriter,
    private readonly log: FastifyBaseLogger,
    private readonly everyOps: number,
    private readonly everyMs: number,
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
    if (s.running || room.currentSeq <= s.lastSeq) return;
    s.running = true;
    const started = performance.now();
    try {
      const seq = room.currentSeq;
      const state = room.persistentState();
      const covered = s.opsSince;
      await this.writer.drain();
      await this.repo.writeSnapshot(room.boardId, seq, state, state.board.shapes.length);
      // Keep the ops between the previous snapshot and this one (useful for catch-up from a
      // recent lastSeq); everything older is covered twice over and can go.
      await this.repo.deleteOpsUpTo(room.boardId, s.previousSeq);
      s.previousSeq = s.lastSeq;
      s.lastSeq = seq;
      s.opsSince = Math.max(0, s.opsSince - covered);
      this.log.info({ boardId: room.boardId, seq, shapes: state.board.shapes.length, snapshot_ms: Math.round(performance.now() - started) }, 'snapshot written');
    } catch (err) {
      this.log.error({ err, boardId: room.boardId }, 'snapshot failed; will retry on the next trigger');
    } finally {
      s.running = false;
    }
    // Ops that arrived while we were writing may already be past the threshold.
    if (s.opsSince >= this.everyOps) void this.snapshot(room);
  }
}
