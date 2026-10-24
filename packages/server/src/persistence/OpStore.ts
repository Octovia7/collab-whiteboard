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
  append(ops: StoredOp[]): Promise<void>;
}

/** Milestone 4 stand-in: "commits" instantly to memory. Nothing survives a restart. */
export class MemoryOpStore implements OpStore {
  readonly ops: StoredOp[] = [];

  async append(ops: StoredOp[]): Promise<void> {
    this.ops.push(...ops);
  }
}
