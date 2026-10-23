import type { Op, Point, ShapeId } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import { LINE_WIDTH } from '../canvas/draw/style';
import type { Tool, ToolContext, ToolPointer } from './Tool';

/** Eraser radius in screen pixels (divided by zoom for world units). */
export const ERASER_PX = 8;

/**
 * Whole-stroke eraser (algorithms.md §7d): every stroke the eraser circle touches is deleted
 * (`update { deleted: true }`), live as the pointer moves. Partial erasing is out of scope for v1.
 * Other shape types are left alone. Between two pointer events the eraser is swept along the
 * segment joining them, so a fast flick still catches every stroke it crossed.
 */
export class EraserTool implements Tool {
  readonly cursor = 'none'; // the overlay draws the eraser circle instead
  private erasing: { pointerId: number; last: Point; erased: Set<ShapeId> } | null = null;
  private hover: Point | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onPointerDown(p: Point, e: ToolPointer): void {
    this.erasing = { pointerId: e.pointerId, last: p, erased: new Set() };
    this.ctx.selection.clear();
    this.hover = p;
    this.eraseAlong(p, p);
  }

  onPointerMove(p: Point, e: ToolPointer): void {
    this.hover = p;
    const er = this.erasing;
    if (er && e.pointerId === er.pointerId) {
      this.eraseAlong(er.last, p);
      er.last = p;
    }
    this.ctx.redrawOverlay();
  }

  onPointerUp(p: Point, e: ToolPointer): void {
    if (this.erasing?.pointerId !== e.pointerId) return;
    this.onPointerMove(p, e);
    this.erasing = null;
  }

  onPointerHover(p: Point | null): void {
    this.hover = p;
    this.ctx.redrawOverlay();
  }

  cancel(): void {
    this.erasing = null;
    this.hover = null;
    this.ctx.redrawOverlay();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera): void {
    if (!this.hover) return;
    const px = 1 / camera.zoom;
    ctx.beginPath();
    ctx.arc(this.hover.x, this.hover.y, ERASER_PX * px, 0, Math.PI * 2);
    ctx.fillStyle = 'rgb(255 255 255 / 60%)';
    ctx.fill();
    ctx.strokeStyle = '#868e96';
    ctx.lineWidth = 1.5 * px;
    ctx.stroke();
  }

  private eraseAlong(from: Point, to: Point): void {
    const er = this.erasing;
    if (!er) return;
    const { store, camera } = this.ctx;
    const radius = ERASER_PX / camera.zoom;
    const reach = radius + LINE_WIDTH / 2;
    // Sample every half radius along the move, so consecutive circles overlap.
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (radius / 2)));
    const ops: Op[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      for (const id of store.strokesNear(p, reach)) {
        if (er.erased.has(id)) continue;
        er.erased.add(id);
        ops.push(store.makeUpdate(id, { deleted: true }));
      }
    }
    store.submit(ops);
  }
}
