import type { BoardSnapshot, Op, Role } from '@whiteboard/shared';
import { bigint, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Tables from system-design.md, "Data model". */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const boards = pgTable('boards', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull().default('Untitled board'),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  /** NULL = link sharing off (milestone 8). */
  linkRole: text('link_role').$type<'viewer' | 'editor'>(),
  linkToken: text('link_token').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const boardMembers = pgTable(
  'board_members',
  {
    boardId: uuid('board_id')
      .notNull()
      .references(() => boards.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<Role>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] })],
);

export const boardOps = pgTable(
  'board_ops',
  {
    boardId: uuid('board_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    opId: text('op_id').notNull(),
    userId: uuid('user_id').notNull(),
    op: jsonb('op').$type<Op>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.boardId, t.seq] }),
    // A resent op hits this instead of being stored twice.
    unique('board_ops_board_op_unique').on(t.boardId, t.opId),
  ],
);

/** What a snapshot stores: the board plus who created each shape (needed to authorize appends). */
export interface SnapshotState {
  board: BoardSnapshot;
  creators: Record<string, string>;
  /**
   * Tombstone ages: shape id -> server commit time (epoch ms) of the op that set
   * `deleted: true`. Absent in snapshots written before milestone 7.
   */
  deletedAt?: Record<string, number>;
}

export const boardSnapshots = pgTable(
  'board_snapshots',
  {
    boardId: uuid('board_id').notNull(),
    /** Covers all ops with seq <= this. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    state: jsonb('state').$type<SnapshotState>().notNull(),
    shapeCount: integer('shape_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.boardId, t.seq] })],
);

