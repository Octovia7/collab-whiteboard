import { LIMITS, rdp } from '@whiteboard/shared';
import type { Point, ShapeId } from '@whiteboard/shared';
import type { Camera } from '../canvas/Camera';
import { smoothPath } from '../canvas/draw/stroke';
import { LINE_WIDTH } from '../canvas/draw/style';
import type { Tool, ToolContext, ToolPointer } from './Tool';

/** Collect points for this long before sending them as one append (algorithms.md §7a). */
export const CHUNK_MS = 50;
/** RDP tolerance in screen pixels; divided by zoom for world units (§7b). */
export const SIMPLIFY_PX = 1;
/** Ignore pointer moves smaller than this (screen px): they add points, not shape. */
const MIN_STEP_PX = 1;

const round2 = (v: number) => Math.round(v * 100) / 100;

interface Drawing {
  id: ShapeId;
  pointerId: number;
  /** Pen-down point: the stroke's x/y. All points are relative to it. */
  origin: Point;
  nextChunk: number;
  /** Relative points already sent in chunks (including chunk 0's [0, 0]). */
  sent: number[];
  /** Relative points collected since the last chunk. */
  pending: number[];
  lastChunkAt: number;
  color: string;
}

/**
 * Freehand pen (algorithms.md §7):
 * - pen down: `create` the stroke with `points` unset, plus `append` chunk 0 with the first
 *   point, in one batch (so peers see a dot immediately);
 * - while moving: every 50 ms, send the new points as the next chunk; the not-yet-sent tail is
 *   drawn on the overlay, so the line follows the pointer at full frame rate;
 * - pen up: send the rest, then one LWW `update { points }` with the RDP-simplified list.
 * The pen stays selected after a stroke, as in other whiteboards.
 */
export class PenTool implements Tool {
  readonly cursor = 'crosshair';
  private drawing: Drawing | null = null;

  constructor(private readonly ctx: ToolContext) {}

  onPointerDown(p: Point, e: ToolPointer): void {
    const { store } = this.ctx;
    const origin = { x: round2(p.x), y: round2(p.y) };
    const color = this.ctx.color();
    const create = store.makeCreate({ type: 'stroke', x: origin.x, y: origin.y, w: 0, h: 0, color });
    const id = create.shape.id;
    store.submit([create, store.makeAppend(id, 0, [0, 0])]);
    this.ctx.selection.clear();
    this.drawing = { id, pointerId: e.pointerId, origin, nextChunk: 1, sent: [0, 0], pending: [], lastChunkAt: this.ctx.now(), color };
  }

  onPointerMove(p: Point, e: ToolPointer): void {
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    const rx = round2(p.x - d.origin.x);
    const ry = round2(p.y - d.origin.y);
    const last = d.pending.length >= 2 ? d.pending.slice(-2) : d.sent.slice(-2);
    const step = Math.hypot(rx - (last[0] as number), ry - (last[1] as number)) * this.ctx.camera.zoom;
    if (step < MIN_STEP_PX) return;
    d.pending.push(rx, ry);
    // Send a chunk every CHUNK_MS, or early if it's about to exceed the protocol's size limit.
    if (this.ctx.now() - d.lastChunkAt >= CHUNK_MS || d.pending.length >= (LIMITS.maxPointsPerAppend - 10) * 2) this.sendChunk(d);
    this.ctx.redrawOverlay();
  }

  onPointerUp(p: Point, e: ToolPointer): void {
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    this.onPointerMove(p, e);
    this.finish(d);
  }

  /** Tool switch, Escape or a lost pointer mid-stroke: keep what was drawn, as a finished stroke. */
  cancel(): void {
    const d = this.drawing;
    if (d) this.finish(d);
  }

  drawOverlay(ctx: CanvasRenderingContext2D, _camera: Camera): void {
    const d = this.drawing;
    if (!d || d.pending.length === 0) return;
    // The tail since the last chunk, joined to the last point already drawn by the scene.
    const tail = [...d.sent.slice(-2), ...d.pending];
    ctx.strokeStyle = d.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    smoothPath(ctx, tail, d.origin.x, d.origin.y);
    ctx.stroke();
  }

  private sendChunk(d: Drawing): void {
    if (d.pending.length === 0) return;
    const { store } = this.ctx;
    store.submit([store.makeAppend(d.id, d.nextChunk++, d.pending)]);
    d.sent.push(...d.pending);
    d.pending = [];
    d.lastChunkAt = this.ctx.now();
  }

  private finish(d: Drawing): void {
    this.drawing = null;
    this.sendChunk(d);
    const { store, camera } = this.ctx;
    // Pen up: the final, simplified list replaces the chunks for drawing (and storage).
    const simplified = rdp(d.sent, SIMPLIFY_PX / camera.zoom).map(round2);
    if (store.isVisible(d.id)) store.submit([store.makeUpdate(d.id, { points: simplified })]);
    this.ctx.redrawOverlay();
  }
}
