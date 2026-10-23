import type { Shape } from '@whiteboard/shared';
import { drawArrow } from './arrow';
import { drawEllipse } from './ellipse';
import { drawRect } from './rect';

/** Draws one shape in world coordinates; the caller has already set the camera transform. */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  switch (s.type) {
    case 'rect':
      return drawRect(ctx, s);
    case 'ellipse':
      return drawEllipse(ctx, s);
    case 'arrow':
      return drawArrow(ctx, s);
    case 'stroke': // milestone 6: chunks / pen-up points, Bezier smoothing
    case 'note': // milestone 7: sticky note with text
      return;
    default: {
      // Compile error here if a new ShapeType is added without a drawer.
      const unknown: never = s.type;
      throw new Error(`no drawer for shape type ${String(unknown)}`);
    }
  }
}
