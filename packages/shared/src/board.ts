import { compareStamps } from './clock';
import type { AppendOp, CreateOp, Op, PropKey, Reg, Shape, ShapeId, ShapeProps, Stamp, UpdateOp } from './types';

/** One streamed piece of a stroke. */
export interface Chunk {
  points: number[];
  stamp: Stamp;
}

type Registers = Partial<Record<PropKey, Reg<ShapeProps[PropKey]>>>;

interface StoredShape {
  regs: Registers;
  /** Appended stroke chunks keyed by the author's chunk number. Merge = union. */
  chunks: Map<number, Chunk>;
}

/** Canonical, JSON-safe form of the board: shapes sorted by id, registers by key, chunks by number. */
export interface BoardSnapshot {
  shapes: SnapshotShape[];
}

export interface SnapshotShape {
  id: ShapeId;
  regs: Registers;
  chunks: [number, Chunk][];
}

/** Max ops held per board while waiting for their create. */
export const DEFAULT_MAX_BUFFERED = 10_000;

export interface BoardOptions {
  /** Cap on buffered ops; beyond it the oldest is dropped. Default DEFAULT_MAX_BUFFERED. */
  maxBuffered?: number;
  /** Called with each op dropped by the cap. `shared` has no logger, so apps pass one (e.g. console.warn). */
  onBufferOverflow?: (dropped: UpdateOp | AppendOp) => void;
}

interface BufferedOp {
  op: UpdateOp | AppendOp;
  seq: number;
}

/**
 * The board as a state-based CRDT: a map of shapes, one LWW register per property.
 *
 * Every apply is commutative, associative and idempotent, so replicas that receive the
 * same ops in any order, with duplicates, end up identical (the convergence test checks
 * this). The board does not own a Lamport clock: callers `observe` each op's stamp
 * themselves, which keeps this class pure and easy to test.
 *
 * Values stored here are shared with the ops and snapshots they came from; treat
 * everything this class returns as read-only.
 */
export class Board {
  private shapes = new Map<ShapeId, StoredShape>();
  /** Updates/appends that arrived before their create. Applied when the create lands. */
  private buffered = new Map<ShapeId, BufferedOp[]>();
  private bufferedTotal = 0;
  /** Arrival counter, only used to find the oldest buffered op when the cap is hit. */
  private bufferSeq = 0;
  private readonly maxBuffered: number;
  private readonly onBufferOverflow: ((dropped: UpdateOp | AppendOp) => void) | undefined;

  constructor(options: BoardOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    this.onBufferOverflow = options.onBufferOverflow;
  }

  /** Returns true if the op reached a shape (it may still have lost every LWW comparison). */
  apply(op: Op): boolean {
    if (op.kind === 'create') {
      this.applyCreate(op);
      return true;
    }
    const shape = this.shapes.get(op.id);
    if (!shape) {
      this.buffer(op);
      return false;
    }
    if (op.kind === 'update') applyUpdate(shape, op);
    else applyAppend(shape, op);
    return true;
  }

  has(id: ShapeId): boolean {
    return this.shapes.has(id);
  }

  /** All shape ids, tombstones included. */
  ids(): ShapeId[] {
    return [...this.shapes.keys()];
  }

  /** Current values of a shape (tombstones included), or undefined if never created. */
  get(id: ShapeId): Shape | undefined {
    const shape = this.shapes.get(id);
    if (!shape) return undefined;
    const out: Partial<Record<PropKey, unknown>> = {};
    for (const key of Object.keys(shape.regs) as PropKey[]) out[key] = shape.regs[key]?.value;
    // Every stored shape went through a create, which writes all required props.
    return { id, ...out } as Shape;
  }

  /** One property's current value without materializing the whole shape (hot paths: sorting, culling). */
  prop<K extends PropKey>(id: ShapeId, key: K): ShapeProps[K] | undefined {
    return this.shapes.get(id)?.regs[key]?.value as ShapeProps[K] | undefined;
  }

  /** Tombstones stay in the map and keep receiving updates; the renderer just skips them. */
  isVisible(id: ShapeId): boolean {
    const shape = this.shapes.get(id);
    return shape !== undefined && shape.regs.deleted?.value !== true;
  }

  /**
   * Points to draw for a stroke. Once the pen-up update has set `points` (the RDP result),
   * that wins; until then, draw the streamed chunks in chunk-number order.
   */
  strokePoints(id: ShapeId): number[] | undefined {
    const shape = this.shapes.get(id);
    if (!shape) return undefined;
    const final = shape.regs.points;
    if (final) return final.value as number[];
    const ordered = [...shape.chunks.entries()].sort((a, b) => a[0] - b[0]);
    return ordered.flatMap(([, chunk]) => chunk.points);
  }

  /** Number of ops waiting for a create that hasn't arrived. */
  get bufferedCount(): number {
    return this.bufferedTotal;
  }

  /** Canonical form: two converged boards produce deep-equal snapshots. Buffered ops are not included. */
  snapshot(): BoardSnapshot {
    const ids = [...this.shapes.keys()].sort(compareStrings);
    return {
      shapes: ids.map((id) => {
        const shape = this.shapes.get(id) as StoredShape;
        const regs: Registers = {};
        for (const key of (Object.keys(shape.regs) as PropKey[]).sort(compareStrings)) regs[key] = shape.regs[key];
        const chunks = [...shape.chunks.entries()].sort((a, b) => a[0] - b[0]);
        return { id, regs, chunks };
      }),
    };
  }

  /** Builds a board from `snapshot()`. Takes ownership of the snapshot's objects. */
  static fromSnapshot(snapshot: BoardSnapshot, options?: BoardOptions): Board {
    const board = new Board(options);
    board.loadSnapshot(snapshot);
    return board;
  }

  /**
   * Replaces the whole state with a fresh snapshot (e.g. the server's, when a client is too
   * far behind for catch-up). Buffered ops are cleared: the snapshot either contains their
   * create, in which case the op has already been applied on the server, or the shape was
   * garbage-collected and the op can never apply.
   */
  loadSnapshot(snapshot: BoardSnapshot): void {
    this.shapes.clear();
    this.buffered.clear();
    this.bufferedTotal = 0;
    for (const s of snapshot.shapes) {
      this.shapes.set(s.id, { regs: { ...s.regs }, chunks: new Map(s.chunks) });
    }
  }

  /**
   * Out-of-order delivery (reconnect, offline replay): LWW doesn't care when an op is
   * applied, so holding it until the create arrives gives the same final state.
   * No time-based expiry: a replica that expired an op while another kept it would diverge
   * once the create arrived. The size cap only protects memory against a flood of ops for
   * shapes that will never exist; hitting it is a bug or abuse, hence the warning callback.
   */
  private buffer(op: UpdateOp | AppendOp): void {
    const entry = { op, seq: ++this.bufferSeq };
    const list = this.buffered.get(op.id);
    if (list) list.push(entry);
    else this.buffered.set(op.id, [entry]);
    this.bufferedTotal++;
    if (this.bufferedTotal > this.maxBuffered) this.dropOldestBuffered();
  }

  private dropOldestBuffered(): void {
    // Each list is in arrival order, so the oldest op overall is the oldest list head.
    // O(#ids), but this only runs when the cap is exceeded.
    let oldestId: ShapeId | undefined;
    let oldestSeq = Infinity;
    for (const [id, list] of this.buffered) {
      const head = list[0];
      if (head && head.seq < oldestSeq) {
        oldestSeq = head.seq;
        oldestId = id;
      }
    }
    if (oldestId === undefined) return;
    const list = this.buffered.get(oldestId) as BufferedOp[];
    const dropped = list.shift() as BufferedOp;
    if (list.length === 0) this.buffered.delete(oldestId);
    this.bufferedTotal--;
    this.onBufferOverflow?.(dropped.op);
  }

  private applyCreate(op: CreateOp): void {
    let shape = this.shapes.get(op.shape.id);
    if (!shape) {
      shape = { regs: {}, chunks: new Map() };
      this.shapes.set(op.shape.id, shape);
    }
    // A create is an LWW write of every property with the create's stamp. A duplicate
    // create then loses every comparison (equal stamps) and can't reset newer values.
    const { id: _id, ...props } = op.shape;
    writeProps(shape, props, op.stamp);

    const waiting = this.buffered.get(op.shape.id);
    if (waiting) {
      this.buffered.delete(op.shape.id);
      this.bufferedTotal -= waiting.length;
      for (const { op: w } of waiting) {
        if (w.kind === 'update') applyUpdate(shape, w);
        else applyAppend(shape, w);
      }
    }
  }
}

function applyUpdate(shape: StoredShape, op: UpdateOp): void {
  // Applied even when the shape is a tombstone: skipping would make replicas that saw the
  // update before the delete differ from ones that saw it after, which breaks undo-of-delete.
  writeProps(shape, op.props, op.stamp);
}

function applyAppend(shape: StoredShape, op: AppendOp): void {
  const existing = shape.chunks.get(op.chunk);
  // Only the stroke's author appends, so a chunk number is normally written once and a
  // repeat is just a duplicate. LWW on the stamp keeps the merge deterministic even if two
  // different writes for one chunk ever slipped past the server's author check.
  if (!existing || compareStamps(op.stamp, existing.stamp) > 0) {
    shape.chunks.set(op.chunk, { points: op.points, stamp: op.stamp });
  }
}

function writeProps(shape: StoredShape, props: Partial<ShapeProps>, stamp: Stamp): void {
  for (const key of Object.keys(props) as PropKey[]) {
    const value = props[key];
    // JSON drops undefined, so treat it as "not in this op" here too; otherwise a replica
    // that got the op in-process and one that got it over the wire would disagree.
    if (value === undefined) continue;
    const cur = shape.regs[key];
    if (!cur || compareStamps(stamp, cur.stamp) > 0) shape.regs[key] = { value, stamp };
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
