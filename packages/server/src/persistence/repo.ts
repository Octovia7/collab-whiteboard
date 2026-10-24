import type { Role } from '@whiteboard/shared';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, max } from 'drizzle-orm';
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

export interface ShareLink {
  role: 'viewer' | 'editor';
  token: string;
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

  // ---- share links ----

  async getLink(boardId: string): Promise<ShareLink | null> {
    const [row] = await retry(() => this.db.select({ role: boards.linkRole, token: boards.linkToken }).from(boards).where(eq(boards.id, boardId)));
    return row?.role && row.token ? { role: row.role, token: row.token } : null;
  }

  /**
   * Turns link sharing on with `role` (a new 32-byte token every time, so changing the role or
   * re-enabling also invalidates any old link), or off with null. Not retried: a retry after a
   * lost reply would hand out a different token than the one stored.
   */
  async setLink(boardId: string, role: 'viewer' | 'editor' | null): Promise<ShareLink | null> {
    const token = role ? randomBytes(32).toString('base64url') : null;
    await this.db.update(boards).set({ linkRole: role, linkToken: token }).where(eq(boards.id, boardId));
    return role && token ? { role, token } : null;
  }

  /**
   * Joins the board a share link points to, in one transaction. A new member gets the link's
   * role; an existing viewer is raised to editor by an editor link; nobody is ever lowered,
   * and nobody becomes owner. Returns the board as the user now sees it, whether the role
   * changed, or null if the link is unknown, turned off, or its board deleted.
   */
  async joinByToken(token: string, userId: string): Promise<{ board: BoardSummary; changed: boolean } | null> {
    return this.db.transaction(async (tx) => {
      const [board] = await tx
        .select({ id: boards.id, role: boards.linkRole })
        .from(boards)
        .where(and(eq(boards.linkToken, token), isNotNull(boards.linkRole), isNull(boards.deletedAt)));
      if (!board?.role) return null;
      const [member] = await tx
        .select({ role: boardMembers.role })
        .from(boardMembers)
        .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, userId)));
      let changed = false;
      if (!member) {
        await tx.insert(boardMembers).values({ boardId: board.id, userId, role: board.role });
        changed = true;
      } else if (member.role === 'viewer' && board.role === 'editor') {
        await tx.update(boardMembers).set({ role: 'editor' }).where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, userId)));
        changed = true;
      }
      const [summary] = await tx
        .select({ id: boards.id, title: boards.title, role: boardMembers.role, updatedAt: boards.updatedAt })
        .from(boardMembers)
        .innerJoin(boards, eq(boards.id, boardMembers.boardId))
        .where(and(eq(boardMembers.boardId, board.id), eq(boardMembers.userId, userId)));
      if (!summary) throw new Error('membership missing after join');
      return { board: { ...summary, updatedAt: summary.updatedAt.toISOString() }, changed };
    });
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
            .select({ boardId: boardOps.boardId, seq: boardOps.seq, opId: boardOps.opId, userId: boardOps.userId, op: boardOps.op, createdAt: boardOps.createdAt })
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
   *
   * Any conflict is skipped, including the primary key (board_id, seq): that one means another
   * op already has this seq (a reset Redis counter racing an in-flight op). Returns those
   * opIds, which were not stored; the caller must not ack them. Safe to retry: a retry after a
   * lost reply finds every row already there.
   */
  async insertOps(rows: StoredOp[]): Promise<string[]> {
    if (rows.length === 0) return [];
    const inserted = await retry(() => this.db.insert(boardOps).values(rows).onConflictDoNothing().returning({ opId: boardOps.opId }));
    if (inserted.length === rows.length) return [];
    const done = new Set(inserted.map((r) => r.opId));
    const skipped = rows.filter((r) => !done.has(r.opId));
    // Skipped because the op is already stored (a resend): fine. Otherwise its seq was taken.
    // One batch holds ops of many boards, so look them up per board.
    const byBoard = new Map<string, StoredOp[]>();
    for (const r of skipped) byBoard.set(r.boardId, [...(byBoard.get(r.boardId) ?? []), r]);
    const notStored: string[] = [];
    for (const [boardId, ops] of byBoard) {
      const present = await this.opSeqs(boardId, ops.map((r) => r.opId));
      for (const r of ops) if (!present.has(r.opId)) notStored.push(r.opId);
    }
    return notStored;
  }

  /** Committed ops among `opIds`, with their seqs. */
  async opSeqs(boardId: string, opIds: string[]): Promise<Map<string, number>> {
    if (opIds.length === 0) return new Map();
    const rows = await retry(() =>
      this.db
        .select({ opId: boardOps.opId, seq: boardOps.seq })
        .from(boardOps)
        .where(and(eq(boardOps.boardId, boardId), inArray(boardOps.opId, opIds))),
    );
    return new Map(rows.map((r) => [r.opId, r.seq]));
  }

  /** Ops with afterSeq < seq <= toSeq, in seq order (gap filling); at most `limit`. */
  async opsInRange(boardId: string, afterSeq: number, toSeq: number, limit = 5000): Promise<StoredOp[]> {
    return retry(() =>
      this.db
        .select({ boardId: boardOps.boardId, seq: boardOps.seq, opId: boardOps.opId, userId: boardOps.userId, op: boardOps.op, createdAt: boardOps.createdAt })
        .from(boardOps)
        .where(and(eq(boardOps.boardId, boardId), gt(boardOps.seq, afterSeq), lte(boardOps.seq, toSeq)))
        .orderBy(asc(boardOps.seq))
        .limit(limit),
    );
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
