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
  | { t: 'ping' };

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), boardId: boardIdSchema, lastSeq: z.number().int().min(0) }),
  z.object({ t: z.literal('ops'), ops: z.array(opSchema).min(1).max(LIMITS.maxOpsPerBatch) }),
  z.object({ t: z.literal('ping') }),
]);

// ---- server -> client ----

export type Role = 'owner' | 'editor' | 'viewer';

export type ServerMessage =
  | { t: 'welcome'; you: { userId: string }; role: Role; peers: { userId: string }[]; snapshot: BoardSnapshot; seq: number }
  | { t: 'ops'; ops: Op[]; seq: number }
  | { t: 'ack'; opIds: string[]; seq: number }
  /** `shape` is the server's current registers for rollback, or null if it has no such shape. */
  | { t: 'reject'; opId: string; reason: string; shape: SnapshotShape | null }
  | { t: 'error'; code: string; message: string };

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
const seq = z.number().int().min(0);
const role = z.enum(['owner', 'editor', 'viewer']);
const user = z.object({ userId: z.string() });

export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), you: user, role, peers: z.array(user), snapshot: snapshotSchema, seq }),
  z.object({ t: z.literal('ops'), ops: z.array(opSchema), seq }),
  z.object({ t: z.literal('ack'), opIds: z.array(z.string()), seq }),
  z.object({ t: z.literal('reject'), opId: z.string(), reason: z.string(), shape: snapshotShapeSchema.nullable() }),
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
