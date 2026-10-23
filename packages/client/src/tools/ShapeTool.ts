import type { Point, ShapeId, ShapeProps } from '@whiteboard/shared';
import { DRAG_THRESHOLD_PX } from './constants';
import type { Tool, ToolContext, ToolPointer } from './Tool';

type DrawnType = 'rect' | 'ellipse' | 'arrow';

/**
 * Rectangle, ellipse and arrow tools: press, drag out the shape, release.
 * The shape is created only once the pointer has moved past the drag threshold, so a stray
 * click doesn't leave an invisible zero-size shape (or a tombstone) on everyone's board.
 * Every move after that is a real update through submit, so the preview is the shape itself.
 */
export class ShapeTool implements Tool {
  readonly cursor = 'crosshair';
  private drag: { start: Point; pointerId: number; id: ShapeId | null } | null = null;

  constructor(
    private readonly type: DrawnType,
    private readonly ctx: ToolContext,
  ) {}

  onPointerDown(p: Point, e: ToolPointer): void {
    this.drag = { start: p, pointerId: e.pointerId, id: null };
    this.ctx.selection.clear();
  }

  onPointerMove(p: Point, e: ToolPointer): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { store, camera } = this.ctx;
    const geom = geometry(this.type, drag.start, p);
    if (drag.id === null) {
      const screenDist = Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * camera.zoom;
      if (screenDist < DRAG_THRESHOLD_PX) return;
      const op = store.makeCreate({ type: this.type, color: this.ctx.color(), ...geom });
      drag.id = op.shape.id;
      store.submit([op]);
    } else {
      store.submit([store.makeUpdate(drag.id, geom)]);
    }
  }

  onPointerUp(_p: Point, e: ToolPointer): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (drag.id === null) return;
    // Like most whiteboards: after drawing, select the new shape and go back to the select tool.
    this.ctx.selection.set([drag.id]);
    this.ctx.setTool('select');
  }

  cancel(): void {
    this.drag = null;
  }
}

/**
 * Arrows keep their direction: (x, y) is the tail and w/h may be negative.
 * Boxes are stored normalized (positive w/h) so resize handles map to fixed corners.
 */
export function geometry(type: DrawnType, start: Point, p: Point): Pick<ShapeProps, 'x' | 'y' | 'w' | 'h'> {
  if (type === 'arrow') return { x: start.x, y: start.y, w: p.x - start.x, h: p.y - start.y };
  return { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
}
