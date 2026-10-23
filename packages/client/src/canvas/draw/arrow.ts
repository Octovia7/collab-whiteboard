import type { Shape } from '@whiteboard/shared';
import { ARROW_HEAD, LINE_WIDTH } from './style';

/** Angle between the shaft and each arrowhead wing (about 26 degrees). */
const WING_ANGLE = 0.45;

/** Arrow from its tail (x, y) to its head (x + w, y + h); w and h are signed. */
export function drawArrow(ctx: CanvasRenderingContext2D, s: Shape): void {
  const hx = s.x + s.w;
  const hy = s.y + s.h;
  const len = Math.hypot(s.w, s.h);
  if (len === 0) return;
  // Short arrows get a proportionally smaller head so the wings don't overshoot the tail.
  const head = Math.min(ARROW_HEAD, len * 0.5);
  const angle = Math.atan2(s.h, s.w);

  ctx.strokeStyle = s.color;
  ctx.lineWidth = LINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.x, s.y);
  ctx.lineTo(hx, hy);
  // Wings point back along the shaft, rotated either side of it.
  ctx.moveTo(hx - head * Math.cos(angle - WING_ANGLE), hy - head * Math.sin(angle - WING_ANGLE));
  ctx.lineTo(hx, hy);
  ctx.lineTo(hx - head * Math.cos(angle + WING_ANGLE), hy - head * Math.sin(angle + WING_ANGLE));
  ctx.stroke();
}
