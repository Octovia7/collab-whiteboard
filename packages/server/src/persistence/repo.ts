import type { Role } from '@whiteboard/shared';
import { and, asc, desc, eq, gt, inArray, isNull, lte, max } from 'drizzle-orm';
import type { Db } from '../db/client';
import { withRetry as retry } from '../errors';
import { boardMembers, boardOps, boardSnapshots, boards, users } from '../db/schema';
import type { SnapshotState } from '../db/schema';
import type { StoredOp } from './OpStore';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface BoardSummary {
  id: string;
  title: string;
  role: Role;
  updatedAt: string;
}

export interface LoadedBoard {
  snapshot: { seq: number; state: SnapshotState } | null;
  /** Ops after the snapshot, in seq order. */
  ops: StoredOp[];
}

const PG_UNIQUE_VIOLATION = '23505';
/** Drizzle wraps driver errors, so the Postgres code may be on the error or on its cause. */
const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: unknown } | null;
  return e?.code === PG_UNIQUE_VIOLATION || (e?.cause !== undefined && isUniqueViolation(e.cause));
};

/**
 * All SQL lives here, so routes and the sync pipeline never build queries themselves.
 * Reads and idempotent writes retry on transient errors (lost connection, timeout). The two
 * plain inserts (createUser, createBoard) do not: if the first attempt committed but the reply
 * was lost, a retry would misreport "email taken" or create a second board. They fail fast
 * with 503 and the user retries.
 */
export class Repo {
  constructor(private readonly db: Db) {}

  // ---- users ----

  /** Returns null if the email is taken. */
  async createUser(email: string, name: string, passwordHash: string): Promise<User | null> {
    try {
      const [row] = await this.db.insert(users).values({ email, name, passwordHash }).returning({ id: users.id, email: users.email, name: users.name });
      return row ?? null;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const [row] = await retry(() => this.db.select({ id: users.id, email: users.email, name: users.name, passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)));
    return row ?? null;
  }

  async findUserById(id: string): Promise<User | null> {
    const [row] = await retry(() => this.db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(users.id, id)));
    return row ?? null;
  }

  // ---- boards ----

  async createBoard(ownerId: string, title: string): Promise<BoardSummary> {
    return this.db.transaction(async (tx) => {
      const [board] = await tx.insert(boards).values({ ownerId, title }).returning();
      if (!board) throw new Error('board insert returned nothing');
      await tx.insert(boardMembers).values({ boardId: board.id, userId: ownerId, role: 'owner' });
      return { id: board.id, title: board.title, role: 'owner', updatedAt: board.updatedAt.toISOString() };
    });
  }

  /** Boards the user owns or is a member of, newest first. */
  async listBoards(userId: string): Promise<BoardSummary[]> {
    const rows = await retry(() =>
      this.db
        .select({ id: boards.id, title: boards.title, role: boardMembers.role, updatedAt: boards.updatedAt })
        .from(boardMembers)
        .innerJoin(boards, eq(boards.id, boardMembers.boardId))
        .where(and(eq(boardMembers.userId, userId), isNull(boards.deletedAt)))
        .orderBy(desc(boards.updatedAt)),
    );
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
  }

  /** The user's view of a board, or null if it doesn't exist, is deleted, or they aren't a member. */
  async getBoardForUser(boardId: string, userId: string): Promise<BoardSummary | null> {
    const [row] = await retry(() =>
      this.db
        .select({ id: boards.id, title: boards.title, role: boardMembers.role, updatedAt: boards.updatedAt })
        .from(boardMembers)
        .innerJoin(boards, eq(boards.id, boardMembers.boardId))
        .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId), isNull(boards.deletedAt))),
    );
    return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null;
  }

  async getRole(boardId: string, userId: string): Promise<Role | null> {
    return (await this.getBoardForUser(boardId, userId))?.role ?? null;
  }

  async renameBoard(boardId: string, title: string): Promise<void> {
    await retry(() => this.db.update(boards).set({ title, updatedAt: new Date() }).where(eq(boards.id, boardId)));
  }

  async softDeleteBoard(boardId: string): Promise<void> {
    await retry(() => this.db.update(boards).set({ deletedAt: new Date() }).where(eq(boards.id, boardId)));
  }

  async touchBoard(boardId: string): Promise<void> {
    await retry(() => this.db.update(boards).set({ updatedAt: new Date() }).where(eq(boards.id, boardId)));
  }

  // ---- members ----

  async listMembers(boardId: string): Promise<(User & { role: Role })[]> {
    return retry(() =>
      this.db
        .select({ id: users.id, email: users.email, name: users.name, role: boardMembers.role })
        .from(boardMembers)
        .innerJoin(users, eq(users.id, boardMembers.userId))
        .where(eq(boardMembers.boardId, boardId))
        .orderBy(asc(users.name)),
    );
  }

  /** Adds or updates a member; returns the user, or null if no account has that email. */
  async upsertMember(boardId: string, email: string, role: Role): Promise<User | null> {
    const user = await this.findUserByEmail(email);
    if (!user) return null;
    await retry(() =>
      this.db
        .insert(boardMembers)
        .values({ boardId, userId: user.id, role })
        .onConflictDoUpdate({ target: [boardMembers.boardId, boardMembers.userId], set: { role } }),
    );
    return { id: user.id, email: user.email, name: user.name };
  }

  async setRole(boardId: string, userId: string, role: Role): Promise<boolean> {
    const rows = await retry(() =>
      this.db
        .update(boardMembers)
        .set({ role })
        .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
        .returning({ userId: boardMembers.userId }),
    );
    return rows.length > 0;
  }

  async removeMember(boardId: string, userId: string): Promise<void> {
    await retry(() => this.db.delete(boardMembers).where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId))));
  }

  // ---- board state ----

  /** Latest snapshot plus the ops after it: everything needed to rebuild the room. */
  async loadBoard(boardId: string): Promise<LoadedBoard> {
    // One repeatable-read transaction, so a snapshot+prune can't land between the two queries.
    return retry(() =>
      this.db.transaction(
        async (tx) => {
          const [snap] = await tx
            .select({ seq: boardSnapshots.seq, state: boardSnapshots.state })
            .from(boardSnapshots)
            .where(eq(boardSnapshots.boardId, boardId))
            .orderBy(desc(boardSnapshots.seq))
            .limit(1);
          const after = snap?.seq ?? 0;
          const ops = await tx
            .select({ boardId: boardOps.boardId, seq: boardOps.seq, opId: boardOps.opId, userId: boardOps.userId, op: boardOps.op })
            .from(boardOps)
            .where(and(eq(boardOps.boardId, boardId), gt(boardOps.seq, after)))
            .orderBy(asc(boardOps.seq));
          return { snapshot: snap ?? null, ops };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
    );
  }

  /**
   * One multi-row insert. A resent op whose first copy was already stored (its ack was lost,
   * e.g. the server crashed between commit and ack) hits UNIQUE (board_id, op_id) and is
   * skipped: it is never stored twice.
   */
  async insertOps(rows: StoredOp[]): Promise<void> {
    if (rows.length === 0) return;
    await retry(() => this.db.insert(boardOps).values(rows).onConflictDoNothing({ target: [boardOps.boardId, boardOps.opId] }));
  }

  async countOps(boardId: string, opIds?: string[]): Promise<number> {
    const where = opIds ? and(eq(boardOps.boardId, boardId), inArray(boardOps.opId, opIds)) : eq(boardOps.boardId, boardId);
    return (await retry(() => this.db.select({ opId: boardOps.opId }).from(boardOps).where(where))).length;
  }

  /**
   * Writes a snapshot and drops the ops an older snapshot already covers, in one transaction:
   * both happen or neither does. Idempotent (ON CONFLICT DO NOTHING, then a delete), so it is
   * safe to retry.
   */
  async writeSnapshotAndPrune(boardId: string, seq: number, state: SnapshotState, shapeCount: number, pruneUpTo: number): Promise<void> {
    await retry(() =>
      this.db.transaction(async (tx) => {
        await tx.insert(boardSnapshots).values({ boardId, seq, state, shapeCount }).onConflictDoNothing();
        if (pruneUpTo > 0) await tx.delete(boardOps).where(and(eq(boardOps.boardId, boardId), lte(boardOps.seq, pruneUpTo)));
      }),
    );
  }

  async maxOpSeq(boardId: string): Promise<number> {
    const [row] = await retry(() => this.db.select({ seq: max(boardOps.seq) }).from(boardOps).where(eq(boardOps.boardId, boardId)));
    return row?.seq ?? 0;
  }
}
