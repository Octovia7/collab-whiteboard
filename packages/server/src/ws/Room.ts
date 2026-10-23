import { Board } from '@whiteboard/shared';
import type { BoardSnapshot, Op, Role, ServerMessage, ShapeId } from '@whiteboard/shared';
import type { OpStore } from '../persistence/OpStore';

/** One connected socket, as the room sees it. */
export interface Peer {
  readonly userId: string;
  /** Mutable: role changes reach open sockets (milestone 5). */
  role: Role;
  /** Must be a no-op once the socket has closed. */
  send(msg: ServerMessage): void;
}

interface Accepted {
  seq: number;
  /** Resolves once the op is durable; a resent duplicate waits on the original's commit. */
  committed: Promise<void>;
}

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

  constructor(
    readonly boardId: string,
    private readonly store: OpStore,
  ) {}

  get peerCount(): number {
    return this.peers.size;
  }

  get currentSeq(): number {
    return this.seq;
  }

  /** The room's current board (milestone 5's Snapshotter persists this). */
  snapshot(): BoardSnapshot {
    return this.board.snapshot();
  }

  /** Adds a peer and returns its welcome: the full board and the seq it covers. */
  join(peer: Peer): ServerMessage {
    this.peers.add(peer);
    return { t: 'welcome', you: { userId: peer.userId }, role: peer.role, peers: [], snapshot: this.board.snapshot(), seq: this.seq };
  }

  leave(peer: Peer): void {
    this.peers.delete(peer);
  }

  async handleOps(from: Peer, ops: Op[]): Promise<void> {
    // Checked on every batch, not just at connect: roles can change while a socket is open.
    if (from.role === 'viewer') {
      for (const op of ops) from.send({ t: 'reject', opId: op.opId, reason: 'forbidden', shape: this.currentShape(op) });
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

      const committed = this.store.append(
        fresh.map(({ op, seq }) => ({ boardId: this.boardId, seq, opId: op.opId, userId: from.userId, op })),
      );
      for (const { op, seq } of fresh) this.accepted.set(op.opId, { seq, committed });
      waits.push(committed);
    }

    if (ackIds.length === 0) return;
    // If persisting fails, no ack is sent: the client keeps the ops pending and resends them.
    await Promise.all(waits);
    from.send({ t: 'ack', opIds: ackIds, seq: ackSeq });
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
