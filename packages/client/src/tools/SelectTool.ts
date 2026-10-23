import { boxFromPoints, containsBox } from '@whiteboard/shared';
import type { Box, Op, Point, Shape, ShapeId } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import { DRAG_THRESHOLD_PX, SELECTION_COLOR, hitTolerance } from './constants';
import { handleAt, resizeShape } from './handles';
import type { HandleId } from './handles';
import type { Tool, ToolContext, ToolPointer } from './Tool';

type Mode =
  | { kind: 'idle' }
  | {
      kind: 'move';
      pointerId: number;
      start: Point;
      origins: Map<ShapeId, Point>;
      moved: boolean;
      /** Shape pressed without shift: if the press turns out to be a click, select just it. */
      clicked: ShapeId | null;
    }
  | { kind: 'resize'; pointerId: number; orig: Shape; handle: HandleId }
  | { kind: 'box'; pointerId: number; start: Point; current: Point; additive: boolean; base: ShapeId[] };

/**
 * Select tool: click to select, shift-click to toggle, drag to move, drag a handle to resize
 * (single selection only), drag on empty space to box-select.
 * Unfilled shapes are only hittable on their outline, but once selected they can be dragged
 * from anywhere inside their bounds, as in other whiteboards.
 */
export class SelectTool implements Tool {
  readonly cursor = 'default';
  private mode: Mode = { kind: 'idle' };

  constructor(private readonly ctx: ToolContext) {}

  onPointerDown(p: Point, e: ToolPointer): void {
    const { store, selection, camera } = this.ctx;

    const single = this.singleSelected();
    if (single) {
      const handle = handleAt(single, p, camera.zoom);
      if (handle) {
        this.mode = { kind: 'resize', pointerId: e.pointerId, orig: single, handle };
        return;
      }
    }

    const hit = store.hitTest(p, hitTolerance(camera.zoom)) ?? this.selectedUnder(p);
    if (hit) {
      let clicked: ShapeId | null = null;
      if (e.shiftKey) {
        selection.toggle(hit);
        if (!selection.has(hit)) return; // toggled off: nothing to drag
      } else if (!selection.has(hit)) {
        selection.set([hit]);
      } else {
        clicked = hit;
      }
      this.mode = { kind: 'move', pointerId: e.pointerId, start: p, origins: this.selectionOrigins(), moved: false, clicked };
      return;
    }

    if (!e.shiftKey) selection.clear();
    this.mode = { kind: 'box', pointerId: e.pointerId, start: p, current: p, additive: e.shiftKey, base: [...selection.list()] };
  }

  onPointerMove(p: Point, e: ToolPointer): void {
    const mode = this.mode;
    if (mode.kind === 'idle' || e.pointerId !== mode.pointerId) return;
    const { store, camera } = this.ctx;

    if (mode.kind === 'move') {
      if (!mode.moved) {
        const screenDist = Math.hypot(p.x - mode.start.x, p.y - mode.start.y) * camera.zoom;
        if (screenDist < DRAG_THRESHOLD_PX) return;
        mode.moved = true;
      }
      // Offsets from the drag start, not the previous move, so every update is absolute and a
      // lost or reordered intermediate update can't leave the shapes off by a delta.
      const dx = p.x - mode.start.x;
      const dy = p.y - mode.start.y;
      const ops: Op[] = [];
      for (const [id, o] of mode.origins) {
        if (store.isVisible(id)) ops.push(store.makeUpdate(id, { x: o.x + dx, y: o.y + dy }));
      }
      store.submit(ops);
    } else if (mode.kind === 'resize') {
      if (!store.isVisible(mode.orig.id)) return; // deleted by someone else mid-drag
      store.submit([store.makeUpdate(mode.orig.id, resizeShape(mode.orig, mode.handle, p))]);
    } else {
      mode.current = p;
      this.ctx.redrawOverlay();
    }
  }

  onPointerUp(_p: Point, e: ToolPointer): void {
    const mode = this.mode;
    if (mode.kind === 'idle' || e.pointerId !== mode.pointerId) return;
    this.mode = { kind: 'idle' };
    if (mode.kind === 'move' && !mode.moved && mode.clicked) {
      this.ctx.selection.set([mode.clicked]);
    } else if (mode.kind === 'box') {
      const inside = this.ctx.store.insideBox(boxFromPoints(mode.start, mode.current));
      this.ctx.selection.set(mode.additive ? [...mode.base, ...inside] : inside);
      this.ctx.redrawOverlay();
    }
  }

  cancel(): void {
    if (this.mode.kind === 'box') this.ctx.redrawOverlay();
    this.mode = { kind: 'idle' };
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (this.mode.kind !== 'box') return;
    const b = boxFromPoints(this.mode.start, this.mode.current);
    ctx.fillStyle = 'rgb(77 171 247 / 8%)';
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 1 / camera.zoom;
    ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }

  private singleSelected(): Shape | null {
    const ids = this.ctx.selection.list();
    if (ids.length !== 1) return null;
    const id = ids[0] as ShapeId;
    return this.ctx.store.isVisible(id) ? (this.ctx.store.get(id) ?? null) : null;
  }

  /** Topmost selected shape whose bounds contain p: lets you drag an outline-only box by its middle. */
  private selectedUnder(p: Point): ShapeId | null {
    const { store, selection } = this.ctx;
    const point: Box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    const ids = store.sortByDrawOrder([...selection.list()]);
    for (let i = ids.length - 1; i >= 0; i--) {
      const b = store.boundsOf(ids[i] as ShapeId);
      if (b && containsBox(b, point)) return ids[i] as ShapeId;
    }
    return null;
  }

  private selectionOrigins(): Map<ShapeId, Point> {
    const origins = new Map<ShapeId, Point>();
    for (const id of this.ctx.selection.list()) {
      const s = this.ctx.store.get(id);
      if (s) origins.set(id, { x: s.x, y: s.y });
    }
    return origins;
  }
}
