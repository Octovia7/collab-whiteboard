import type { Shape } from '@whiteboard/shared';
import { LINE_WIDTH } from './style';

/** The ellipse inscribed in the shape's x/y/w/h box. */
export function drawEllipse(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.strokeStyle = s.color;
  ctx.lineWidth = LINE_WIDTH;
  ctx.beginPath();
  ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w) / 2, Math.abs(s.h) / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}
