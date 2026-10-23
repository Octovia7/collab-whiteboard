import {
  Board,
  LamportClock,
  boxFromPoints,
  compareDrawOrder,
  containsBox,
  createIdGenerator,
  expandBox,
  hitShape,
  keyBetween,
  shapeBounds,
} from '@whiteboard/shared';
import type { Box, CreateOp, Op, Point, Shape, ShapeId, ShapeProps, UpdateOp } from '@whiteboard/shared';
import { QuadTree } from '../canvas/QuadTree';
import { Emitter } from '../lib/Emitter';

export type Origin = 'local' | 'remote';

interface ZEntry {
  id: ShapeId;
  z: string;
}

export interface BoardStoreEvents extends Record<string, unknown> {
  /** After a batch of ops reached shapes. The renderer listens to mark itself dirty; React must not. */
  change: { ids: ShapeId[]; origin: Origin };
  /**
   * Every local batch, exactly as submitted. Sync (milestone 4) sends these; undo
   * (milestone 7) records them. One batch = one user action.
   */
  submit: { ops: Op[] };
}

/**
 * Culling margin in world units, so line width and arrowheads just outside a shape's
 * geometric box aren't clipped at the viewport edge. Over-including a few shapes is harmless.
 */
const CULL_MARGIN = 24;

/**
 * The browser's single source of truth: the shared LWW board, this tab's Lamport clock and
 * ID generator, and a quadtree of visible shapes for culling and hit testing.
 *
 * Writes: local edits only through `submit` (tools build ops with `makeCreate`/`makeUpdate`),
 * remote edits only through `receive`. Reads: `get`, `visibleIn`, `hitTest`, `insideBox`.
 */
export class BoardStore {
  readonly events = new Emitter<BoardStoreEvents>();
  readonly clock: LamportClock;
  private readonly board: Board;
  private readonly nextId: () => ShapeId;
  private readonly tree = new QuadTree();
  private opCount = 0;
  /** Rank of every shape id in (z, id) order; rebuilt lazily when z order may have changed. */
  private rank: Map<ShapeId, number> | null = null;
  /** Cached top/bottom of the z order; null = rescan on next use. */
  private zExtremes: { top: ZEntry | null; bottom: ZEntry | null } | null = null;

  constructor(readonly clientId: string) {
    this.clock = new LamportClock(clientId);
    this.nextId = createIdGenerator(clientId);
    this.board = new Board({
      onBufferOverflow: (op) => console.warn(`board buffer full: dropped op ${op.opId} for shape ${op.id}`),
    });
  }

  // ---- writes ----

  /** The single path for local edits: applies the batch now (optimistic) and announces it. */
  submit(ops: Op[]): void {
    if (ops.length === 0) return;
    // Local ops were stamped by this clock already, so no observe() here.
    this.applyAll(ops, 'local');
    this.events.emit('submit', { ops });
  }

  /** Ops from other users. Each pushes the clock forward so our next edit is stamped later. */
  receive(ops: Op[]): void {
    for (const op of ops) this.clock.observe(op.stamp);
    this.applyAll(ops, 'remote');
  }

  /** Builds (and stamps) a create, on top of everything unless `z` is given. Pass it to `submit`. */
  makeCreate(props: Omit<ShapeProps, 'z'> & { z?: string }): CreateOp {
    const shape: Shape = { ...props, id: this.nextId(), z: props.z ?? keyBetween(this.topZ(), '') };
    return { kind: 'create', opId: this.newOpId(), stamp: this.clock.tick(), shape };
  }

  /** Builds (and stamps) an update. Pass it to `submit`. */
  makeUpdate(id: ShapeId, props: Partial<ShapeProps>): UpdateOp {
    return { kind: 'update', opId: this.newOpId(), stamp: this.clock.tick(), id, props };
  }

  // ---- reads ----

  get(id: ShapeId): Shape | undefined {
    return this.board.get(id);
  }

  isVisible(id: ShapeId): boolean {
    return this.board.isVisible(id);
  }

  /** Bounds of a shape's geometry (no line width); strokes are measured from their points. */
  boundsOf(id: ShapeId): Box | undefined {
    const shape = this.board.get(id);
    if (!shape) return undefined;
    return shapeBounds(shape, shape.type === 'stroke' ? this.board.strokePoints(id) : undefined);
  }

  /** Visible shapes overlapping `box`, in draw order (bottom first). */
  visibleIn(box: Box): Shape[] {
    return this.sortByDrawOrder(this.tree.query(expandBox(box, CULL_MARGIN))).flatMap((id) => this.board.get(id) ?? []);
  }

  /**
   * The topmost visible shape under `p`. `tolerance` is in world units and should include half
   * the line width; callers derive it from a fixed screen-pixel size divided by zoom.
   */
  hitTest(p: Point, tolerance: number): ShapeId | null {
    const candidates = this.sortByDrawOrder(this.tree.query(expandBox(boxFromPoints(p, p), tolerance)));
    // Topmost first: the shape drawn last wins when several overlap.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const id = candidates[i] as ShapeId;
      const shape = this.board.get(id);
      if (!shape) continue;
      const points = shape.type === 'stroke' ? this.board.strokePoints(id) : undefined;
      if (hitShape(shape, p, tolerance, points)) return id;
    }
    return null;
  }

  /** Box selection: visible shapes whose bounds lie entirely inside `box` (algorithms.md §11c). */
  insideBox(box: Box): ShapeId[] {
    return this.sortByDrawOrder(this.tree.query(box).filter((id) => {
      const b = this.boundsOf(id);
      return b !== undefined && containsBox(box, b);
    }));
  }

  /** Highest z key, tombstones included, so "bring to front" also clears hidden shapes. */
  topZ(): string {
    return this.extremes().top?.z ?? '';
  }

  /** Lowest z key, tombstones included. */
  bottomZ(): string {
    return this.extremes().bottom?.z ?? '';
  }

  /** Sorts ids bottom-first by (z, id). */
  sortByDrawOrder(ids: ShapeId[]): ShapeId[] {
    this.ensureOrder();
    const rank = this.rank as Map<ShapeId, number>;
    return ids.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  }

  get size(): number {
    return this.board.ids().length;
  }

  // ---- internals ----

  private applyAll(ops: Op[], origin: Origin): void {
    const changed = new Set<ShapeId>();
    for (const op of ops) {
      if (!this.board.apply(op)) continue; // buffered until its create arrives
      const id = op.kind === 'create' ? op.shape.id : op.id;
      changed.add(id);
      // Only a create (new key in the order) or a z write can reorder; moves and recolors
      // during a drag must not trigger a full re-sort every frame.
      if (op.kind === 'create' || (op.kind === 'update' && op.props.z !== undefined)) {
        this.rank = null;
        this.noteZ(id);
      }
    }
    if (changed.size === 0) return;
    for (const id of changed) this.reindex(id);
    this.events.emit('change', { ids: [...changed], origin });
  }

  /** Keeps the quadtree in sync: only visible shapes are indexed, so tombstones cost nothing to query. */
  private reindex(id: ShapeId): void {
    const bounds = this.board.isVisible(id) ? this.boundsOf(id) : undefined;
    if (bounds) this.tree.set(id, bounds);
    else this.tree.remove(id);
  }

  /**
   * Top and bottom of the z order, kept up to date in O(1) per create or z write so that
   * creating a shape (which needs topZ) never sorts the whole board. Only when the current
   * top or bottom shape itself moves inward is a linear rescan needed.
   */
  private extremes(): { top: ZEntry | null; bottom: ZEntry | null } {
    if (!this.zExtremes) {
      let top: ZEntry | null = null;
      let bottom: ZEntry | null = null;
      for (const id of this.board.ids()) {
        const e = { id, z: this.board.prop(id, 'z') ?? '' };
        if (!top || compareDrawOrder(e, top) > 0) top = e;
        if (!bottom || compareDrawOrder(e, bottom) < 0) bottom = e;
      }
      this.zExtremes = { top, bottom };
    }
    return this.zExtremes;
  }

  private noteZ(id: ShapeId): void {
    const ex = this.zExtremes;
    if (!ex) return; // will be rescanned on demand
    // Use the board's merged value, not the op's: the op may have lost the LWW comparison.
    const e = { id, z: this.board.prop(id, 'z') ?? '' };
    if (ex.top?.id === id || ex.bottom?.id === id) {
      // The extreme shape itself changed: it may have moved inward, so rescan lazily.
      this.zExtremes = null;
      return;
    }
    if (!ex.top || compareDrawOrder(e, ex.top) > 0) ex.top = e;
    if (!ex.bottom || compareDrawOrder(e, ex.bottom) < 0) ex.bottom = e;
  }

  private ensureOrder(): void {
    if (this.rank) return;
    const entries = this.board.ids().map((id) => ({ id, z: this.board.prop(id, 'z') ?? '' }));
    const ordered = entries.sort(compareDrawOrder).map((e) => e.id);
    this.rank = new Map(ordered.map((id, i) => [id, i]));
  }

  private newOpId(): string {
    return `${this.clientId}:${++this.opCount}`;
  }
}
