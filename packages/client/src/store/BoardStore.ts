import {
  Board,
  LamportClock,
  compareDrawOrder,
  createIdGenerator,
  expandBox,
  keyBetween,
  overlaps,
  shapeBounds,
} from '@whiteboard/shared';
import type { Box, CreateOp, Op, Shape, ShapeId, ShapeProps, UpdateOp } from '@whiteboard/shared';
import { Emitter } from '../lib/Emitter';

export type Origin = 'local' | 'remote';

export interface BoardStoreEvents extends Record<string, unknown> {
  /** Fired after any op reaches a shape. The renderer listens to mark itself dirty; React must not. */
  change: { id: ShapeId; origin: Origin };
}

/**
 * Culling margin in world units, so line width and arrowheads just outside a shape's
 * x/y/w/h box aren't clipped at the viewport edge. Over-including a few shapes is harmless.
 */
const CULL_MARGIN = 24;

/**
 * The browser's single source of truth: the shared LWW board plus this tab's Lamport
 * clock and ID generator. Tools write through `create`/`update`; the renderer reads
 * through `visibleIn`. Sync (milestone 4) will feed remote ops into `apply(op, 'remote')`
 * and send the ops that `create`/`update` return.
 */
export class BoardStore {
  readonly events = new Emitter<BoardStoreEvents>();
  readonly clock: LamportClock;
  private readonly board: Board;
  private readonly nextId: () => ShapeId;
  private opCount = 0;
  /** All shape ids in (z, id) order; rebuilt lazily after any change. */
  private drawOrder: ShapeId[] | null = null;

  constructor(readonly clientId: string) {
    this.clock = new LamportClock(clientId);
    this.nextId = createIdGenerator(clientId);
    this.board = new Board({
      onBufferOverflow: (op) => console.warn(`board buffer full: dropped op ${op.opId} for shape ${op.id}`),
    });
  }

  apply(op: Op, origin: Origin): void {
    // Local ops were stamped by this clock already; remote ones must push it forward so our
    // next edit is stamped later than everything we've seen.
    if (origin === 'remote') this.clock.observe(op.stamp);
    const reached = this.board.apply(op);
    if (!reached) return;
    this.drawOrder = null;
    this.events.emit('change', { id: op.kind === 'create' ? op.shape.id : op.id, origin });
  }

  /** Create a shape locally, on top of everything unless `z` is given. Returns the op to send. */
  create(props: Omit<ShapeProps, 'z'> & { z?: string }): CreateOp {
    const shape: Shape = { ...props, id: this.nextId(), z: props.z ?? keyBetween(this.topZ(), '') };
    const op: CreateOp = { kind: 'create', opId: this.newOpId(), stamp: this.clock.tick(), shape };
    this.apply(op, 'local');
    return op;
  }

  /** Change some properties locally. Returns the op to send. */
  update(id: ShapeId, props: Partial<ShapeProps>): UpdateOp {
    const op: UpdateOp = { kind: 'update', opId: this.newOpId(), stamp: this.clock.tick(), id, props };
    this.apply(op, 'local');
    return op;
  }

  get(id: ShapeId): Shape | undefined {
    return this.board.get(id);
  }

  /**
   * Visible (non-tombstone) shapes overlapping `box`, in draw order (bottom first).
   * Linear scan for now; milestone 3 replaces it with a quadtree query.
   */
  visibleIn(box: Box): Shape[] {
    const out: Shape[] = [];
    for (const id of this.sortedIds()) {
      if (!this.board.isVisible(id)) continue;
      const shape = this.board.get(id);
      if (!shape) continue;
      if (overlaps(expandBox(shapeBounds(shape), CULL_MARGIN), box)) out.push(shape);
    }
    return out;
  }

  /** Highest z key on the board, tombstones included, so "bring to front" also clears hidden shapes. */
  topZ(): string {
    const ids = this.sortedIds();
    const top = ids[ids.length - 1];
    return top === undefined ? '' : (this.board.prop(top, 'z') ?? '');
  }

  get size(): number {
    return this.board.ids().length;
  }

  private sortedIds(): ShapeId[] {
    if (!this.drawOrder) {
      const entries = this.board.ids().map((id) => ({ id, z: this.board.prop(id, 'z') ?? '' }));
      this.drawOrder = entries.sort(compareDrawOrder).map((e) => e.id);
    }
    return this.drawOrder;
  }

  private newOpId(): string {
    return `${this.clientId}:${++this.opCount}`;
  }
}
