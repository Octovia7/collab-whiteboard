import type { Shape } from '@whiteboard/shared';
import { LINE_WIDTH } from './style';

export function drawRect(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.strokeStyle = s.color;
  ctx.lineWidth = LINE_WIDTH;
  // strokeRect accepts negative w/h, so a flipped box needs no normalizing.
  ctx.strokeRect(s.x, s.y, s.w, s.h);
}
