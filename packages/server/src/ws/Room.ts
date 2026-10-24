import { Board } from '@whiteboard/shared';
import type { BoardSnapshot, Op, PeerInfo, Role, ServerMessage, ShapeId } from '@whiteboard/shared';
import type { SnapshotState } from '../db/schema';
import type { OpStore, StoredOp } from '../persistence/OpStore';

/** One connected socket, as the room sees it. */
export interface Peer {
  /** Identifies this connection (one tab); presence is per connection. */
  readonly peerId: string;
  readonly userId: string;
  readonly name: string;
  /** performance.now() of the last message from this socket (heartbeat sweep). */
  lastSeen: number;
  /** Mutable: a role change reaches open sockets on their next batch (setRole). */
  role: Role;
  /** Must be a no-op once the socket has closed. */
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
  /** Drops a socket that stopped answering (no close handshake: the other end may be gone). */
  terminate(): void;
}

export const peerInfo = (p: Peer): PeerInfo => ({ peerId: p.peerId, userId: p.userId, name: p.name });

/** Timings and counts the room reports (metrics.ts). */
export interface RoomObserver {
  relayed(ms: number): void;
  committed(ms: number): void;
  accepted(count: number): void;
  rejected(reason: string): void;
  /** Missing seqs read from Postgres (a lost or late pub/sub message). */
  gapFilled?(count: number): void;
  /** Missing seqs given up on after `holeAfterMs` (their server crashed before publishing). */
  holesSkipped?(count: number): void;
}

/** What a room tells other servers about (RedisBus `board:{id}`). */
export type BoardEvent = { type: 'ops'; userId: string; ops: { seq: number; op: Op }[] } | { type: 'skip'; seqs: number[] };

/** Presence a room tells other servers about (RedisBus `presence:{id}`). */
export type PresenceEvent =
  | { type: 'join'; peer: PeerInfo }
  | { type: 'leave'; peerId: string }
  | { type: 'cursor'; peerId: string; x: number; y: number }
  | { type: 'select'; peerId: string; ids: string[] }
  | { type: 'typing'; peerId: string; id: string | null };

/** The server can't sequence ops (Redis unreachable): the socket is closed with 1013 and the client retries. */
export class SequencingUnavailable extends Error {
  constructor(cause: unknown) {
    super('cannot reserve seqs', { cause });
    this.name = 'SequencingUnavailable';
  }
}

export interface RoomOptions {
  /** Called after ops are accepted (local or from other servers), so the Snapshotter can count them. */
  onAccepted?: (room: Room, count: number) => void;
  /** Wall-clock time (epoch ms), for tombstone ages. Injected in tests. */
  now?: () => number;
  /** Catch-up log cap: beyond this, the oldest ops are dropped (clients that far behind get a snapshot). */
  maxLogOps?: number;
  observer?: RoomObserver;
  /** Fault injection (tests only): wait this long between commit and ack. */
  ackDelayMs?: number;
  /**
   * Reserves `n` consecutive seqs and returns the last one; never returns one at or below
   * `floor` (the highest seq this room knows). Redis in production; a local counter by default.
   */
  reserveSeqs?: (n: number, floor: number) => Promise<number>;
  /** Tells other servers (Redis pub/sub). */
  publish?: (event: BoardEvent) => void;
  publishPresence?: (event: PresenceEvent) => void;
  /** Ops in Postgres with afterSeq < seq <= toSeq, for filling gaps. */
  fetchOps?: (afterSeq: number, toSeq: number) => Promise<StoredOp[]>;
  /** Which of these opIds are committed in Postgres, with their seq. */
  findDurable?: (opIds: string[]) => Promise<Map<string, number>>;
  /** True while saving is paused (Postgres failing): incoming batches are dropped unapplied. */
  isPaused?: () => boolean;
  /** How often missing seqs are looked up in Postgres. */
  gapPollMs?: number;
  /** A seq missing this long is a hole: the watermark moves past it. */
  holeAfterMs?: number;
  /** How long a resend of an op known only from another server waits for it to be committed. */
  foreignWaitMs?: number;
}

/**
 * An op this room has applied. `committed` is set for ops this server sequenced: it resolves
 * once the op is durable (a resend waits on it) and rejects if it couldn't be stored. Ops from
 * other servers have none: their durability is checked in Postgres when someone resends them.
 */
interface Accepted {
  seq: number;
  committed?: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One board in server memory: its LWW state, connected peers and the op pipeline
 * (system-design.md, "Op pipeline"):
 *
 *   authorize -> validate -> reserve seqs -> apply -> deliver + publish -> persist -> ack sender
 *
 * Peers (here and, through Redis, on other servers) get the ops right after the in-memory
 * apply; the sender's ack waits for the commit, so "acked" always means "durable"
 * (CLAUDE.md rule 8) without peers feeling DB latency.
 *
 * With several servers, ops reach a room in any seq order. They are delivered at once anyway
 * (LWW converges in any order); only the watermark `upTo` waits for gaps to fill
 * (system-design.md, "Gap detection").
 */
export class Room {
  /** The server never buffers ops for unknown shapes: they are rejected before apply. */
  private readonly board = new Board();
  /**
   * Watermark: every seq <= upTo has been applied and delivered to this room's sockets (or was
   * given up on as a hole). Sent to clients as `upTo`; clients use it as their lastSeq.
   */
  private watermark = 0;
  /** Highest seq this room knows exists (reserved here, received, or read from Redis). */
  private maxSeq = 0;
  /** Seqs above the watermark already applied (or announced as skipped). */
  private readonly received = new Set<number>();
  /** When each missing seq (above the watermark, not received) was first noticed. */
  private readonly missingSince = new Map<number, number>();
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watermarkWaiters: { seq: number; resolve: () => void }[] = [];
  private disposed = false;
  /** Seqs handed out by the default (single-process) sequencer. */
  private localCounter = 0;
  /** opId -> its seq, so a resent op is acked again instead of stored and broadcast twice. */
  private readonly accepted = new Map<string, Accepted>();
  /** Who created each shape: only a stroke's creator may append to it. */
  private readonly creators = new Map<ShapeId, string>();
  private readonly peers = new Set<Peer>();
  /**
   * Recent ops in seq order, for lastSeq catch-up (algorithms.md §12b). It mirrors the op log
   * kept in Postgres: everything after the previous snapshot. `logFloor` is the seq just before
   * the first entry: a client whose lastSeq is at or above it can be caught up from here.
   */
  private log: { seq: number; op: Op }[] = [];
  private logFloor = 0;
  /**
   * Seq at which tombstones were last garbage-collected. A client from before that may still
   * hold a removed tombstone that no op will ever mention again, so it needs a snapshot.
   */
  private gcSeq = 0;
  /** Tombstone ages: shape id -> commit time (epoch ms) of the op whose `deleted: true` won. */
  private readonly deletedAt = new Map<ShapeId, number>();
  /** Snapshot bookkeeping, owned by the Snapshotter. */
  readonly snapshots = { lastSeq: 0, previousSeq: 0, opsSince: 0, running: false, timer: null as ReturnType<typeof setTimeout> | null };

  constructor(
    readonly boardId: string,
    private readonly store: OpStore,
    private readonly options: RoomOptions = {},
  ) {}

  /**
   * Rebuilds the room from its latest snapshot plus the ops logged after it. Tail ops are
   * already durable, so a client resending one of them gets acked without a second insert.
   * The tail may have gaps (holes, or ops another server hasn't committed yet): the watermark
   * stops at the first one and the gap filler takes it from there.
   */
  restore(snapshot: { seq: number; state: SnapshotState } | null, tail: StoredOp[]): void {
    const now = this.now();
    if (snapshot) {
      this.board.loadSnapshot(snapshot.state.board);
      for (const [id, user] of Object.entries(snapshot.state.creators)) this.creators.set(id, user);
      for (const [id, at] of Object.entries(snapshot.state.deletedAt ?? {})) this.deletedAt.set(id, at);
      // Tombstones from older snapshots without ages: count their age from now (never too early).
      for (const s of snapshot.state.board.shapes) {
        if (s.regs.deleted?.value === true && !this.deletedAt.has(s.id)) this.deletedAt.set(s.id, now);
      }
      this.watermark = snapshot.seq;
      this.maxSeq = snapshot.seq;
      this.snapshots.lastSeq = snapshot.seq;
      this.logFloor = snapshot.seq;
      this.gcSeq = snapshot.seq; // GC may have happened at that snapshot
    }
    const durable = Promise.resolve();
    for (const row of tail) {
      if (row.seq <= this.watermark) continue;
      this.board.apply(row.op);
      if (row.op.kind === 'create' && !this.creators.has(row.op.shape.id)) this.creators.set(row.op.shape.id, row.userId);
      this.trackDeletion(row.op, row.createdAt?.getTime() ?? now);
      this.accepted.set(row.opId, { seq: row.seq, committed: durable });
      this.insertLog(row.seq, row.op);
      this.markReceived(row.seq);
    }
    this.localCounter = this.maxSeq;
    this.snapshots.opsSince = tail.length;
  }

  /** The highest seq known to exist elsewhere (the Redis counter): anything up to it we lack is a gap. */
  noteSeqExists(seq: number): void {
    if (seq <= this.maxSeq) return;
    this.maxSeq = seq;
    this.advance();
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** Watermark: every op with seq <= upTo is in this room's board and was delivered to its sockets. */
  get upTo(): number {
    return this.watermark;
  }

  get shapeCount(): number {
    return this.board.ids().length;
  }

  /** This server's sockets. */
  localPeers(): Peer[] {
    return [...this.peers];
  }

  /** The room's current board. */
  snapshot(): BoardSnapshot {
    return this.board.snapshot();
  }

  /** What the Snapshotter persists: the board, shape creators and tombstone ages. */
  persistentState(): SnapshotState {
    return { board: this.board.snapshot(), creators: Object.fromEntries(this.creators), deletedAt: Object.fromEntries(this.deletedAt) };
  }

  /**
   * Adds a peer and returns its welcome (algorithms.md §12b). A client that already has the
   * board up to `lastSeq` gets just the ops after it, if this room still has them all
   * (catch-up); a new client, or one too far behind, gets the whole board as a snapshot.
   * `remotePeers` are the peers connected to other servers. Everyone hears `peer-join`.
   */
  join(peer: Peer, lastSeq = 0, remotePeers: PeerInfo[] = []): ServerMessage {
    const others = [...[...this.peers].map(peerInfo), ...remotePeers];
    for (const p of this.peers) p.send({ t: 'peer-join', peer: peerInfo(peer) });
    this.options.publishPresence?.({ type: 'join', peer: peerInfo(peer) });
    this.peers.add(peer);
    const base = { t: 'welcome' as const, you: peerInfo(peer), role: peer.role, peers: others, upTo: this.watermark };
    const ops = this.catchUp(lastSeq);
    return ops ? { ...base, ops } : { ...base, snapshot: this.board.snapshot() };
  }

  /**
   * The ops after `lastSeq`, or null if a snapshot is needed: a first join (0), a lastSeq
   * from before the log's floor (pruned, or too old), from before the last tombstone GC, or
   * ahead of this room's watermark (this server lacks ops the client saw).
   *
   * The log holds everything this room applied, including ops above the watermark (out of
   * order): sending those too is harmless, LWW applies them idempotently.
   */
  catchUp(lastSeq: number): Op[] | null {
    if (lastSeq <= 0 || lastSeq > this.watermark || lastSeq < this.logFloor || lastSeq < this.gcSeq) return null;
    // The log is in seq order: binary-search the first entry after lastSeq.
    let lo = 0;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.log[mid] as { seq: number }).seq <= lastSeq) lo = mid + 1;
      else hi = mid;
    }
    return this.log.slice(lo).map((e) => e.op);
  }

  /**
   * Resolves once the watermark reaches `seq` (missing ops read from Postgres meanwhile), or
   * after `timeoutMs`. Used before welcoming a client that saw more on another server.
   */
  async waitForWatermark(seq: number, timeoutMs: number): Promise<void> {
    if (seq <= this.watermark) return;
    this.noteSeqExists(seq);
    this.scheduleGapCheck(0);
    await new Promise<void>((resolve) => {
      const waiter = { seq, resolve };
      this.watermarkWaiters.push(waiter);
      setTimeout(() => {
        const i = this.watermarkWaiters.indexOf(waiter);
        if (i >= 0) this.watermarkWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
    });
  }

  /** After a snapshot pruned Postgres up to `seq`, drop the same ops from the catch-up log. */
  trimLog(seq: number): void {
    if (seq <= this.logFloor) return;
    this.log = this.log.filter((e) => e.seq > seq);
    this.logFloor = seq;
  }

  /**
   * Tombstone GC (algorithms.md §4): permanently removes tombstones whose delete committed
   * before `cutoff` (epoch ms). Server-side only, at snapshot time: the next snapshot no longer
   * has them, and clients from before now are sent a snapshot instead of catch-up. Removing is
   * authoritative (not an op), which is safe because nobody can still need the shape: a client
   * that later sends an op for it gets `unknown_shape` and drops it locally.
   */
  collectTombstones(cutoff: number): number {
    let removed = 0;
    for (const [id, at] of this.deletedAt) {
      if (at >= cutoff || this.board.prop(id, 'deleted') !== true) continue;
      this.board.replaceShape(id, null);
      this.creators.delete(id);
      this.deletedAt.delete(id);
      removed++;
    }
    if (removed > 0) this.gcSeq = this.maxSeq;
    return removed;
  }

  leave(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    for (const p of this.peers) p.send({ t: 'peer-leave', peerId: peer.peerId });
    this.options.publishPresence?.({ type: 'leave', peerId: peer.peerId });
  }

  /**
   * Relays a cursor, selection or typing state to everyone else in the room, and to other
   * servers. Presence is ephemeral: never applied to the board, never persisted, allowed for
   * viewers too (CLAUDE.md rule 9).
   */
  relayPresence(
    from: Peer,
    msg: { t: 'cursor'; x: number; y: number } | { t: 'select'; ids: string[] } | { t: 'typing'; id: string | null },
  ): void {
    const event: PresenceEvent =
      msg.t === 'cursor'
        ? { type: 'cursor', peerId: from.peerId, x: msg.x, y: msg.y }
        : msg.t === 'select'
          ? { type: 'select', peerId: from.peerId, ids: msg.ids }
          : { type: 'typing', peerId: from.peerId, id: msg.id };
    this.deliverPresence(event, from);
    this.options.publishPresence?.(event);
  }

  /** Presence from another server (or our own sweep): delivered to every local socket. */
  deliverPresence(event: PresenceEvent, except?: Peer): void {
    const out: ServerMessage =
      event.type === 'join'
        ? { t: 'peer-join', peer: event.peer }
        : event.type === 'leave'
          ? { t: 'peer-leave', peerId: event.peerId }
          : event.type === 'cursor'
            ? { t: 'cursor', peerId: event.peerId, x: event.x, y: event.y }
            : event.type === 'select'
              ? { t: 'select', peerId: event.peerId, ids: event.ids }
              : { t: 'typing', peerId: event.peerId, id: event.id };
    for (const p of this.peers) if (p !== except) p.send(out);
  }

  /** Sends a message to every local socket (e.g. `saving`). */
  broadcast(msg: ServerMessage): void {
    for (const p of this.peers) p.send(msg);
  }

  /** Terminates peers silent since before `cutoff`; their socket's close then announces `peer-leave`. */
  sweep(cutoff: number): number {
    let dropped = 0;
    for (const p of this.peers) {
      if (p.lastSeen >= cutoff) continue;
      p.terminate();
      dropped++;
    }
    return dropped;
  }

  /** A role change takes effect on the user's open sockets immediately: their next batch is checked against it. */
  setRole(userId: string, role: Role): void {
    for (const peer of this.peers) {
      if (peer.userId !== userId) continue;
      peer.role = role;
      peer.send({ t: 'role', role });
    }
  }

  /** Closes a user's sockets (removed from the board), or everyone's (board deleted). */
  disconnect(userId: string | null, code: number, reason: string): void {
    for (const peer of [...this.peers]) {
      if (userId !== null && peer.userId !== userId) continue;
      peer.send({ t: 'error', code: reason, message: reason.replace(/_/g, ' ') });
      peer.close(code, reason);
      this.leave(peer);
    }
  }

  /** Stops the gap filler and releases watermark waiters (room unloaded). */
  dispose(): void {
    this.disposed = true;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
    for (const w of this.watermarkWaiters.splice(0)) w.resolve();
  }

  /** The whole pipeline, waiting for the ack too (tests and simple callers). */
  async handleOps(from: Peer, ops: Op[]): Promise<void> {
    const { acked } = await this.receive(from, ops);
    await acked;
  }

  /**
   * Runs a batch through the pipeline. Resolves once the batch is applied, delivered and
   * published (so the next batch from the same socket applies after it); `acked` resolves once
   * the sender's ack has gone out, after the commit. Throws SequencingUnavailable if seqs can't
   * be reserved: nothing was applied, and the client will resend.
   */
  async receive(from: Peer, ops: Op[]): Promise<{ acked: Promise<void> }> {
    const started = performance.now();
    const observer = this.options.observer;
    const none = { acked: Promise.resolve() };
    // Checked on every batch, not just at connect: roles can change while a socket is open.
    if (from.role === 'viewer') {
      for (const op of ops) {
        observer?.rejected('forbidden');
        from.send({ t: 'reject', opId: op.opId, reason: 'forbidden', shape: this.currentShape(op) });
      }
      return none;
    }
    // Saving paused: neither apply nor answer. The client keeps the batch pending and resends
    // it when `saving { paused: false }` arrives.
    if (this.options.isPaused?.()) return none;

    const acks: { opId: string; durable: Promise<void> }[] = [];
    const candidates: Op[] = [];
    const foreign: Op[] = [];
    for (const op of ops) {
      const prior = this.accepted.get(op.opId);
      if (!prior) candidates.push(op);
      // A resend (lost ack, reconnect): don't apply, store or broadcast it again; ack it once
      // the original is durable.
      else if (prior.committed) acks.push({ opId: op.opId, durable: prior.committed });
      else foreign.push(op);
    }
    if (foreign.length > 0) {
      // Known only from another server: ack once it's in Postgres. If it never shows up, that
      // server died before committing it; then it's processed as new (applying it again is
      // idempotent) and gets a fresh seq.
      const durable = await this.waitDurable(foreign.map((o) => o.opId));
      for (const op of foreign) {
        if (durable.has(op.opId)) {
          acks.push({ opId: op.opId, durable: Promise.resolve() });
        } else {
          this.accepted.delete(op.opId);
          candidates.push(op);
        }
      }
    }

    const fresh: { op: Op; seq: number }[] = [];
    if (candidates.length > 0) {
      let last: number;
      try {
        last = await this.reserve(candidates.length);
      } catch (err) {
        throw new SequencingUnavailable(err);
      }
      const first = last - candidates.length + 1;
      const skipped: number[] = [];
      candidates.forEach((op, i) => {
        const seq = first + i;
        // Validated here, after the await and in batch order: an update may target a shape
        // created earlier in the same batch, and other batches may have been applied while we
        // waited for the seqs. A rejected op's seq is announced as skipped, so no watermark
        // waits for it.
        const reason = this.accepted.has(op.opId) ? 'duplicate' : this.validate(op, from.userId);
        if (reason) {
          if (reason !== 'duplicate') this.reject(from, op, reason);
          skipped.push(seq);
          this.markReceived(seq); // a hole we know about: no need to wait for it
          return;
        }
        this.applyOp(op, seq, from.userId, this.now());
        fresh.push({ op, seq });
      });
      if (skipped.length > 0) this.options.publish?.({ type: 'skip', seqs: skipped });
    }

    if (fresh.length > 0) {
      const msg: ServerMessage = { t: 'ops', ops: fresh.map((f) => f.op), upTo: this.watermark };
      for (const peer of this.peers) if (peer !== from) peer.send(msg);
      this.options.publish?.({ type: 'ops', userId: from.userId, ops: fresh });
      observer?.relayed(performance.now() - started);
      observer?.accepted(fresh.length);

      const stored = this.store.append(fresh.map(({ op, seq }) => ({ boardId: this.boardId, seq, opId: op.opId, userId: from.userId, op })));
      for (const { op, seq } of fresh) {
        // A seq collision (see OpWriter) means this op isn't stored: no ack, the client resends.
        const committed = stored.then((notStored) => {
          if (notStored.includes(op.opId)) throw new Error(`op ${op.opId} was not stored (seq ${seq} taken)`);
        });
        committed.catch(() => {}); // awaited by the ack below; this keeps it from being "unhandled"
        this.accepted.set(op.opId, { seq, committed });
        acks.push({ opId: op.opId, durable: committed });
      }
      this.options.onAccepted?.(this, fresh.length);
    }

    if (acks.length === 0) return none;
    return { acked: this.ackWhenDurable(from, acks, fresh.length > 0 ? started : null) };
  }

  /** Ops sequenced by another server, from Redis or read from Postgres to fill a gap. */
  receiveRemote(userId: string, entries: { seq: number; op: Op }[], committedAt?: number): void {
    const now = committedAt ?? this.now();
    const fresh: Op[] = [];
    for (const { seq, op } of entries) {
      if (!this.accepted.has(op.opId)) {
        this.applyOp(op, seq, userId, now);
        fresh.push(op);
      } else {
        this.markReceived(seq);
      }
    }
    if (fresh.length === 0) return;
    // Delivered right away, whatever their seqs: LWW doesn't care about order. Only the
    // watermark (upTo) waits for missing seqs.
    const msg: ServerMessage = { t: 'ops', ops: fresh, upTo: this.watermark };
    for (const peer of this.peers) peer.send(msg);
    this.options.onAccepted?.(this, fresh.length);
  }

  /** Seqs another server reserved but will never use (its ops failed validation). */
  skip(seqs: number[]): void {
    for (const seq of seqs) this.markReceived(seq);
  }

  // ---- internals ----

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private reserve(n: number): Promise<number> {
    if (this.options.reserveSeqs) return this.options.reserveSeqs(n, this.maxSeq);
    this.localCounter = Math.max(this.localCounter, this.maxSeq) + n;
    return Promise.resolve(this.localCounter);
  }

  /**
   * Applies an op under `seq`. It's recorded as accepted at once (a duplicate later in the same
   * batch is then skipped); for our own ops the caller adds the `committed` promise right after.
   */
  private applyOp(op: Op, seq: number, userId: string, at: number): void {
    this.board.apply(op);
    if (op.kind === 'create' && !this.creators.has(op.shape.id)) this.creators.set(op.shape.id, userId);
    this.trackDeletion(op, at);
    this.insertLog(seq, op);
    this.accepted.set(op.opId, { seq });
    this.markReceived(seq);
  }

  private reject(from: Peer, op: Op, reason: string): void {
    this.options.observer?.rejected(reason);
    from.send({ t: 'reject', opId: op.opId, reason, shape: this.currentShape(op) });
  }

  private async ackWhenDurable(from: Peer, acks: { opId: string; durable: Promise<void> }[], started: number | null): Promise<void> {
    const results = await Promise.allSettled(acks.map((a) => a.durable));
    if (this.options.ackDelayMs) await sleep(this.options.ackDelayMs); // fault injection (tests only)
    const ok: string[] = [];
    results.forEach((r, i) => {
      const { opId } = acks[i] as { opId: string };
      if (r.status === 'fulfilled') ok.push(opId);
      // Not stored: forget it, so the client's resend is processed as new (with a new seq).
      else if (this.accepted.get(opId)?.committed === acks[i]?.durable) this.accepted.delete(opId);
    });
    // Any op not acked stays pending on the client, which resends it.
    if (ok.length === 0) return;
    from.send({ t: 'ack', opIds: ok, upTo: this.watermark });
    if (started !== null) this.options.observer?.committed(performance.now() - started);
  }

  /** Polls Postgres for opIds sequenced elsewhere until all are committed or `foreignWaitMs` passes. */
  private async waitDurable(opIds: string[]): Promise<Map<string, number>> {
    const find = this.options.findDurable;
    if (!find) return new Map();
    const deadline = performance.now() + (this.options.foreignWaitMs ?? 5_000);
    for (;;) {
      const found = await find(opIds);
      if (found.size === opIds.length || performance.now() >= deadline) return found;
      await sleep(100);
    }
  }

  /** Keeps the log in seq order; ops usually arrive in order, so this scans from the end. */
  private insertLog(seq: number, op: Op): void {
    let i = this.log.length;
    while (i > 0 && (this.log[i - 1] as { seq: number }).seq > seq) i--;
    this.log.splice(i, 0, { seq, op });
    const max = this.options.maxLogOps ?? 20_000;
    if (this.log.length > max) {
      const dropped = this.log.splice(0, this.log.length - max);
      this.logFloor = (dropped[dropped.length - 1] as { seq: number }).seq;
    }
  }

  /** `seq` is applied (or known never to come): move the watermark over every contiguous seq. */
  private markReceived(seq: number): void {
    if (seq > this.maxSeq) this.maxSeq = seq;
    if (seq <= this.watermark) return;
    this.received.add(seq);
    this.missingSince.delete(seq);
    this.advance();
  }

  private advance(): void {
    while (this.received.has(this.watermark + 1)) {
      this.received.delete(this.watermark + 1);
      this.watermark++;
    }
    for (let i = this.watermarkWaiters.length - 1; i >= 0; i--) {
      const w = this.watermarkWaiters[i] as { seq: number; resolve: () => void };
      if (w.seq <= this.watermark) {
        this.watermarkWaiters.splice(i, 1);
        w.resolve();
      }
    }
    if (this.maxSeq > this.watermark) this.scheduleGapCheck();
  }

  private scheduleGapCheck(delay = this.options.gapPollMs ?? 250): void {
    if (this.disposed || !this.options.fetchOps) return;
    if (this.gapTimer) {
      if (delay > 0) return;
      clearTimeout(this.gapTimer); // run now instead
    }
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      void this.checkGaps();
    }, delay);
  }

  /**
   * Gap filler: seqs between the watermark and the highest known seq that we don't have are
   * read from Postgres (a lost pub/sub message, or a room that loaded while they were in
   * flight). Ones still missing after `holeAfterMs` are holes: a server reserved them and died
   * before publishing, so no op will ever come; the watermark moves past them.
   */
  private async checkGaps(): Promise<void> {
    const fetch = this.options.fetchOps;
    if (this.disposed || !fetch || this.maxSeq <= this.watermark) return;
    const now = performance.now();
    const from = this.watermark;
    const to = this.maxSeq;
    for (let s = from + 1; s <= to; s++) if (!this.received.has(s) && !this.missingSince.has(s)) this.missingSince.set(s, now);
    try {
      const rows = (await fetch(from, to)).filter((r) => !this.received.has(r.seq) && r.seq > this.watermark);
      let filled = 0;
      for (const row of rows) {
        if (this.received.has(row.seq) || row.seq <= this.watermark) continue;
        this.receiveRemote(row.userId, [{ seq: row.seq, op: row.op }], row.createdAt?.getTime());
        filled++;
      }
      if (filled > 0) this.options.observer?.gapFilled?.(filled);
    } catch {
      // Postgres unreachable: try again next round; holes still age below.
    }
    const holeAfter = this.options.holeAfterMs ?? 5_000;
    let skipped = 0;
    for (;;) {
      const next = this.watermark + 1;
      if (next > this.maxSeq || this.received.has(next)) break;
      const since = this.missingSince.get(next);
      if (since === undefined || performance.now() - since < holeAfter) break;
      skipped++;
      this.markReceived(next);
    }
    if (skipped > 0) this.options.observer?.holesSkipped?.(skipped);
    if (this.maxSeq > this.watermark) this.scheduleGapCheck();
  }

  /**
   * Keeps tombstone ages in step with the board: after an op touches `deleted`, the shape's age
   * is the commit time of whichever op's `deleted: true` won the LWW comparison; undeleting
   * clears it.
   */
  private trackDeletion(op: Op, at: number): void {
    if (op.kind === 'create') {
      if (op.shape.deleted === undefined) return;
    } else if (op.kind !== 'update' || op.props.deleted === undefined) {
      return;
    }
    const id = op.kind === 'create' ? op.shape.id : op.id;
    if (this.board.prop(id, 'deleted') !== true) {
      this.deletedAt.delete(id);
      return;
    }
    const winner = this.board.propStamp(id, 'deleted');
    if (winner && winner.t === op.stamp.t && winner.client === op.stamp.client) this.deletedAt.set(id, at);
  }

  /** Returns a reject reason, or null if the op may be applied. */
  private validate(op: Op, userId: string): string | null {
    switch (op.kind) {
      case 'create': {
        // Shape ids are client-generated; a different user reusing one is a forged create.
        const creator = this.creators.get(op.shape.id);
        return creator !== undefined && creator !== userId ? 'id_taken' : null;
      }
      case 'update':
        return this.board.has(op.id) ? null : 'unknown_shape';
      case 'append':
        if (!this.board.has(op.id)) return 'unknown_shape';
        if (this.board.prop(op.id, 'type') !== 'stroke') return 'not_a_stroke';
        return this.creators.get(op.id) === userId ? null : 'not_author';
    }
  }

  private currentShape(op: Op) {
    return this.board.snapshotShape(op.kind === 'create' ? op.shape.id : op.id) ?? null;
  }
}
