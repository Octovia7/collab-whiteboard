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

const info = (p: Peer): PeerInfo => ({ peerId: p.peerId, userId: p.userId, name: p.name });

/** Timings and counts the room reports (metrics.ts). */
export interface RoomObserver {
  relayed(ms: number): void;
  committed(ms: number): void;
  accepted(count: number): void;
  rejected(reason: string): void;
}

export interface RoomOptions {
  /** Called after ops are accepted, so the Snapshotter can count them. */
  onAccepted?: (room: Room, count: number) => void;
  observer?: RoomObserver;
  /** Fault injection (tests only): wait this long between commit and ack. */
  ackDelayMs?: number;
}

interface Accepted {
  seq: number;
  /** Resolves once the op is durable; a resent duplicate waits on the original's commit. */
  committed: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One board in server memory: its LWW state, connected peers and the op pipeline
 * (system-design.md, "Op pipeline"):
 *
 *   authorize -> validate -> assign seq -> apply -> broadcast to peers -> persist -> ack sender
 *
 * Peers get the ops right after the in-memory apply; the sender's ack waits for the commit,
 * so "acked" always means "durable" (CLAUDE.md rule 8) without peers feeling DB latency.
 */
export class Room {
  /** The server never buffers ops for unknown shapes: they are rejected before apply. */
  private readonly board = new Board();
  private seq = 0;
  /** opId -> its seq, so a resent op is acked again instead of stored and broadcast twice. */
  private readonly accepted = new Map<string, Accepted>();
  /** Who created each shape: only a stroke's creator may append to it. */
  private readonly creators = new Map<ShapeId, string>();
  private readonly peers = new Set<Peer>();
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
   */
  restore(snapshot: { seq: number; state: SnapshotState } | null, tail: StoredOp[]): void {
    if (snapshot) {
      this.board.loadSnapshot(snapshot.state.board);
      for (const [id, user] of Object.entries(snapshot.state.creators)) this.creators.set(id, user);
      this.seq = snapshot.seq;
      this.snapshots.lastSeq = snapshot.seq;
    }
    const durable = Promise.resolve();
    for (const row of tail) {
      this.board.apply(row.op);
      if (row.op.kind === 'create' && !this.creators.has(row.op.shape.id)) this.creators.set(row.op.shape.id, row.userId);
      this.accepted.set(row.opId, { seq: row.seq, committed: durable });
      this.seq = Math.max(this.seq, row.seq);
    }
    this.snapshots.opsSince = tail.length;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get shapeCount(): number {
    return this.board.ids().length;
  }

  /** The room's current board. */
  snapshot(): BoardSnapshot {
    return this.board.snapshot();
  }

  /** What the Snapshotter persists: the board plus shape creators. */
  persistentState(): SnapshotState {
    return { board: this.board.snapshot(), creators: Object.fromEntries(this.creators) };
  }

  /**
   * Adds a peer and returns its welcome: the full board, the seq it covers, and who else is
   * here. Everyone else hears `peer-join`.
   */
  join(peer: Peer): ServerMessage {
    const others = [...this.peers].map(info);
    for (const p of this.peers) p.send({ t: 'peer-join', peer: info(peer) });
    this.peers.add(peer);
    return { t: 'welcome', you: info(peer), role: peer.role, peers: others, snapshot: this.board.snapshot(), seq: this.seq };
  }

  leave(peer: Peer): void {
    if (!this.peers.delete(peer)) return;
    for (const p of this.peers) p.send({ t: 'peer-leave', peerId: peer.peerId });
  }

  /**
   * Relays a cursor or selection to everyone else in the room. Presence is ephemeral: never
   * applied to the board, never persisted, allowed for viewers too (CLAUDE.md rule 9).
   */
  relayPresence(from: Peer, msg: { t: 'cursor'; x: number; y: number } | { t: 'select'; ids: string[] }): void {
    const out: ServerMessage = msg.t === 'cursor' ? { t: 'cursor', peerId: from.peerId, x: msg.x, y: msg.y } : { t: 'select', peerId: from.peerId, ids: msg.ids };
    for (const p of this.peers) if (p !== from) p.send(out);
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

  async handleOps(from: Peer, ops: Op[]): Promise<void> {
    // Checked on every batch, not just at connect: roles can change while a socket is open.
    const started = performance.now();
    const observer = this.options.observer;
    if (from.role === 'viewer') {
      for (const op of ops) {
        observer?.rejected('forbidden');
        from.send({ t: 'reject', opId: op.opId, reason: 'forbidden', shape: this.currentShape(op) });
      }
      return;
    }

    const fresh: { op: Op; seq: number }[] = [];
    const ackIds: string[] = [];
    const waits: Promise<void>[] = [];
    let ackSeq = 0;

    for (const op of ops) {
      const prior = this.accepted.get(op.opId);
      if (prior) {
        // A resend (lost ack, reconnect): don't apply, store or broadcast it again,
        // just ack with the original seq once the original is durable.
        ackIds.push(op.opId);
        ackSeq = Math.max(ackSeq, prior.seq);
        waits.push(prior.committed);
        continue;
      }
      const reason = this.validate(op, from.userId);
      if (reason) {
        observer?.rejected(reason);
        from.send({ t: 'reject', opId: op.opId, reason, shape: this.currentShape(op) });
        continue;
      }
      const seq = ++this.seq;
      this.board.apply(op);
      if (op.kind === 'create' && !this.creators.has(op.shape.id)) this.creators.set(op.shape.id, from.userId);
      fresh.push({ op, seq });
      ackIds.push(op.opId);
      ackSeq = Math.max(ackSeq, seq);
    }

    if (fresh.length > 0) {
      const last = (fresh[fresh.length - 1] as { seq: number }).seq;
      const msg: ServerMessage = { t: 'ops', ops: fresh.map((f) => f.op), seq: last };
      for (const peer of this.peers) if (peer !== from) peer.send(msg);
      observer?.relayed(performance.now() - started);
      observer?.accepted(fresh.length);

      const committed = this.store.append(
        fresh.map(({ op, seq }) => ({ boardId: this.boardId, seq, opId: op.opId, userId: from.userId, op })),
      );
      for (const { op, seq } of fresh) this.accepted.set(op.opId, { seq, committed });
      waits.push(committed);
      this.options.onAccepted?.(this, fresh.length);
    }

    if (ackIds.length === 0) return;
    // If persisting fails, no ack is sent: the client keeps the ops pending and resends them.
    await Promise.all(waits);
    if (this.options.ackDelayMs) await sleep(this.options.ackDelayMs); // fault injection (tests only)
    from.send({ t: 'ack', opIds: ackIds, seq: ackSeq });
    if (fresh.length > 0) observer?.committed(performance.now() - started);
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
