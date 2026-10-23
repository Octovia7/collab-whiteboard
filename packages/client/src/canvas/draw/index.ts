import type { Shape } from '@whiteboard/shared';
import { drawArrow } from './arrow';
import { drawEllipse } from './ellipse';
import { drawRect } from './rect';
import { drawStroke } from './stroke';

/**
 * Draws one shape in world coordinates; the caller has already set the camera transform.
 * `strokePoints` (relative to the stroke's x/y) is only used for strokes.
 */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, strokePoints: readonly number[] = []): void {
  switch (s.type) {
    case 'rect':
      return drawRect(ctx, s);
    case 'ellipse':
      return drawEllipse(ctx, s);
    case 'arrow':
      return drawArrow(ctx, s);
    case 'stroke':
      return drawStroke(ctx, s, strokePoints);
    case 'note': // milestone 7: sticky note with text
      return;
    default: {
      // Compile error here if a new ShapeType is added without a drawer.
      const unknown: never = s.type;
      throw new Error(`no drawer for shape type ${String(unknown)}`);
    }
  }
}
