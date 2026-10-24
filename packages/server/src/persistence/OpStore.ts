import type { Op } from '@whiteboard/shared';

export interface StoredOp {
  boardId: string;
  seq: number;
  opId: string;
  /** From the socket, never from the client (CLAUDE.md conventions). */
  userId: string;
  op: Op;
  /** Commit time, when read back from board_ops.created_at (tombstone ages). */
  createdAt?: Date;
}

/**
 * Where accepted ops are made durable. The room acks a batch only after `append` resolves
 * (CLAUDE.md rule 8). Milestone 5 implements this with batched Postgres inserts (OpWriter).
 */
export interface OpStore {
  /**
   * Resolves once the ops are committed, with the opIds that could not be stored because
   * their seq was already taken by another op (a reset Redis counter racing an in-flight op).
   * Those are not acked; their authors resend them and they get new seqs.
   */
  append(ops: StoredOp[]): Promise<string[]>;
}

/** In-memory stand-in for unit tests: "commits" instantly. Nothing survives a restart. */
export class MemoryOpStore implements OpStore {
  readonly ops: StoredOp[] = [];

  async append(ops: StoredOp[]): Promise<string[]> {
    this.ops.push(...ops);
    return [];
  }
}
