import type { Shape } from '@whiteboard/shared';
import { LINE_WIDTH } from './style';

/** The parts of a 2D context the smoothing needs; tests pass a recorder. */
export type PathTarget = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'quadraticCurveTo'>;

/**
 * Smooth path through flat points [x1, y1, x2, y2, ...] offset by (ox, oy) (algorithms.md §7c):
 * a quadratic Bézier between the midpoints of neighbouring points, with each real point as the
 * control point. The curve passes near every point without the corners of straight segments.
 * Smoothing happens only here, at draw time: what's stored and synced is the plain point list,
 * so every client draws the identical curve.
 */
export function smoothPath(ctx: PathTarget, pts: readonly number[], ox: number, oy: number): void {
  const n = Math.floor(pts.length / 2);
  if (n === 0) return;
  const x = (i: number) => ox + (pts[2 * i] as number);
  const y = (i: number) => oy + (pts[2 * i + 1] as number);
  ctx.moveTo(x(0), y(0));
  for (let i = 1; i < n - 1; i++) {
    ctx.quadraticCurveTo(x(i), y(i), (x(i) + x(i + 1)) / 2, (y(i) + y(i + 1)) / 2);
  }
  if (n > 1) ctx.lineTo(x(n - 1), y(n - 1));
}

/** A freehand stroke: points are relative to its x/y (pen-down point). */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Shape, pts: readonly number[]): void {
  if (pts.length < 2) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length < 4) {
    // A single click with the pen: a dot the width of the line.
    ctx.beginPath();
    ctx.arc(s.x + (pts[0] as number), s.y + (pts[1] as number), LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  smoothPath(ctx, pts, s.x, s.y);
  ctx.stroke();
}
