/**
 * WebSocket protocol (system-design.md, "WebSocket protocol"). Every message is JSON with a
 * `t` field and is validated with these schemas on arrival. The server never trusts identity
 * from the client: userId comes from the socket, so no client message carries one.
 */
import { z } from 'zod';
import type { BoardSnapshot, SnapshotShape } from './board';
import { isValidKey } from './fractional';
import type { Op } from './types';

/** Limits from system-design.md, "Sizes and limits". */
export const LIMITS = {
  maxMessageBytes: 256 * 1024,
  maxOpsPerBatch: 100,
  maxPointsPerAppend: 2000,
  maxTextLength: 10_000,
  /** Shapes one presence `select` message may name. */
  maxSelectedIds: 1000,
} as const;

/**
 * Presence (algorithms.md §8): ephemeral, never persisted. Clients send their cursor at most
 * 20 times a second and a heartbeat when otherwise idle; a peer not heard from for 15 s is dropped.
 */
export const PRESENCE = {
  cursorIntervalMs: 50,
  heartbeatMs: 5_000,
  timeoutMs: 15_000,
} as const;

/** Coordinates beyond this are almost certainly bugs or abuse (and would inflate the quadtree). */
const MAX_COORD = 1e9;

const coord = z.number().finite().min(-MAX_COORD).max(MAX_COORD);
const clientId = z.string().regex(/^\w{1,40}$/);
const shapeId = z.string().regex(/^\w{1,40}-\d{1,15}$/, 'shape ids are clientId-counter');
const opId = z.string().min(1).max(100);
export const boardIdSchema = z.string().regex(/^[\w-]{1,64}$/);

const stamp = z.object({
  t: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  client: clientId,
});

const points = z
  .array(coord)
  .max(LIMITS.maxPointsPerAppend * 2)
  .refine((p) => p.length % 2 === 0, 'points must be [x, y] pairs');

/** Every property a client may write. `type` is set by the create and never changes. */
const props = {
  x: coord,
  y: coord,
  w: coord,
  h: coord,
  color: z.string().min(1).max(32),
  z: z.string().max(200).refine(isValidKey, 'invalid fractional key'),
  points,
  text: z.string().max(LIMITS.maxTextLength),
  deleted: z.boolean(),
};

const shape = z.object({
  id: shapeId,
  type: z.enum(['rect', 'ellipse', 'arrow', 'stroke', 'note']),
  x: props.x,
  y: props.y,
  w: props.w,
  h: props.h,
  color: props.color,
  z: props.z,
  points: props.points.optional(),
  text: props.text.optional(),
  deleted: props.deleted.optional(),
});

const updateProps = z
  .object(props)
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'update changes nothing');

export const opSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), opId, stamp, shape }),
  z.object({ kind: z.literal('update'), opId, stamp, id: shapeId, props: updateProps }),
  z.object({
    kind: z.literal('append'),
    opId,
    stamp,
    id: shapeId,
    chunk: z.number().int().min(0).max(1_000_000),
    points,
  }),
]);

// ---- client -> server ----

export type ClientMessage =
  | { t: 'hello'; boardId: string; lastSeq: number }
  | { t: 'ops'; ops: Op[] }
  /** My pointer, in world coordinates. */
  | { t: 'cursor'; x: number; y: number }
  /** My current selection. */
  | { t: 'select'; ids: string[] }
  /** I'm editing this note's text (null: stopped). Drives the "someone is typing" soft lock. */
  | { t: 'typing'; id: string | null }
  /** Heartbeat when nothing else was sent for a while. */
  | { t: 'ping' };

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), boardId: boardIdSchema, lastSeq: z.number().int().min(0) }),
  z.object({ t: z.literal('ops'), ops: z.array(opSchema).min(1).max(LIMITS.maxOpsPerBatch) }),
  z.object({ t: z.literal('cursor'), x: coord, y: coord }),
  z.object({ t: z.literal('select'), ids: z.array(shapeId).max(LIMITS.maxSelectedIds) }),
  z.object({ t: z.literal('typing'), id: shapeId.nullable() }),
  z.object({ t: z.literal('ping') }),
]);

// ---- server -> client ----

export type Role = 'owner' | 'editor' | 'viewer';

/**
 * Someone connected to the board. `peerId` identifies one connection (one tab): the same user
 * in two tabs has two cursors. Online lists group by `userId`.
 */
export interface PeerInfo {
  peerId: string;
  userId: string;
  name: string;
}

export type ServerMessage =
  /**
   * Reply to hello. Exactly one of `snapshot` (the whole board) or `ops` (catch-up: every op
   * after the client's lastSeq, applied on top of the board it already has).
   *
   * `upTo` on welcome, ops and ack is the server's watermark: every op with seq <= upTo has
   * been delivered to this socket (system-design.md, "The upTo watermark"). Ops themselves
   * arrive in any seq order; clients store the latest upTo as their lastSeq.
   */
  | ({ t: 'welcome'; you: PeerInfo; role: Role; peers: PeerInfo[]; upTo: number } & ({ snapshot: BoardSnapshot; ops?: undefined } | { ops: Op[]; snapshot?: undefined }))
  | { t: 'ops'; ops: Op[]; upTo: number }
  | { t: 'ack'; opIds: string[]; upTo: number }
  /**
   * Postgres has been failing long enough that this server stopped accepting ops (paused), or
   * it recovered. Batches sent while paused are dropped unapplied; resend them on resume.
   */
  | { t: 'saving'; paused: boolean }
  /** `shape` is the server's current registers for rollback, or null if it has no such shape. */
  | { t: 'reject'; opId: string; reason: string; shape: SnapshotShape | null }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-leave'; peerId: string }
  | { t: 'cursor'; peerId: string; x: number; y: number }
  | { t: 'select'; peerId: string; ids: string[] }
  | { t: 'typing'; peerId: string; id: string | null }
  /** Your role on this board changed; it applies to your next batch (no reconnect needed). */
  | { t: 'role'; role: Role }
  /** Reply to a client's ping, so a client can tell a dead connection from a quiet one. */
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string };

/**
 * WebSocket close codes the server uses after accepting a socket. The client must not
 * reconnect after these; any other close (network drop, server restart) is retried.
 * (Auth failures happen earlier, as HTTP 401/403 on the upgrade, so there is no socket.)
 */
export const CLOSE = {
  policyViolation: 1008,
  /** The session was logged out (in any tab, on any server). */
  loggedOut: 4001,
  removedFromBoard: 4003,
  boardDeleted: 4004,
} as const;
export const FINAL_CLOSE_CODES: readonly number[] = Object.values(CLOSE);

/** Graceful server shutdown: reconnect right away (with a little jitter) instead of backing off. */
export const SERVICE_RESTART = 1012;

/** The server can't sequence ops right now (Redis unreachable): reconnect with backoff and resend. */
export const TRY_AGAIN_LATER = 1013;

/** No message (not even a heartbeat) for PRESENCE.timeoutMs: probably a dead connection. Retried. */
export const HEARTBEAT_TIMEOUT = 4000;

// The server is trusted for board content, so snapshots get a structural check only:
// deep-validating 10,000 shapes on every join would cost more than it protects.
const snapshotSchema = z.custom<BoardSnapshot>(
  (v) => typeof v === 'object' && v !== null && Array.isArray((v as { shapes?: unknown }).shapes),
  'invalid snapshot',
);
const snapshotShapeSchema = z.custom<SnapshotShape>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string',
  'invalid shape',
);
const upTo = z.number().int().min(0);
const role = z.enum(['owner', 'editor', 'viewer']);
const peer = z.object({ peerId: z.string(), userId: z.string(), name: z.string().max(200) });

// A plain union, not discriminatedUnion: `welcome` has two shapes (snapshot or catch-up ops).
export const serverMessageSchema = z.union([
  // Two strict variants: exactly one of snapshot / ops (strict rejects a welcome carrying both).
  z.object({ t: z.literal('welcome'), you: peer, role, peers: z.array(peer), upTo, snapshot: snapshotSchema }).strict(),
  z.object({ t: z.literal('welcome'), you: peer, role, peers: z.array(peer), upTo, ops: z.array(opSchema) }).strict(),
  z.object({ t: z.literal('peer-join'), peer }),
  z.object({ t: z.literal('peer-leave'), peerId: z.string() }),
  z.object({ t: z.literal('cursor'), peerId: z.string(), x: coord, y: coord }),
  z.object({ t: z.literal('select'), peerId: z.string(), ids: z.array(z.string()).max(LIMITS.maxSelectedIds) }),
  z.object({ t: z.literal('typing'), peerId: z.string(), id: z.string().nullable() }),
  z.object({ t: z.literal('ops'), ops: z.array(opSchema), upTo }),
  z.object({ t: z.literal('ack'), opIds: z.array(z.string()), upTo }),
  z.object({ t: z.literal('saving'), paused: z.boolean() }),
  z.object({ t: z.literal('reject'), opId: z.string(), reason: z.string(), shape: snapshotShapeSchema.nullable() }),
  z.object({ t: z.literal('role'), role }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
]);

// Compile-time guarantee that whatever the schemas accept fits the hand-written types.
type Assert<T extends true> = T;
export type _ClientSchemaFits = Assert<z.infer<typeof clientMessageSchema> extends ClientMessage ? true : false>;
export type _ServerSchemaFits = Assert<z.infer<typeof serverMessageSchema> extends ServerMessage ? true : false>;

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid message' };
  }
  return { ok: true, msg: result.data };
}

/** Parses and validates a raw message from a client. Unknown fields are stripped. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith<ClientMessage>(clientMessageSchema, raw);
}

/** Parses and validates a raw message from the server. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith<ServerMessage>(serverMessageSchema, raw);
}
