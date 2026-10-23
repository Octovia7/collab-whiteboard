import { rectBounds } from '@whiteboard/shared';
import type { Point, Shape, ShapeProps } from '@whiteboard/shared';
import { HANDLE_PX } from './constants';

export type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type HandleId = BoxHandle | 'tail' | 'head';

export interface Handle {
  id: HandleId;
  x: number;
  y: number;
}

/**
 * Resize handles for a single selected shape. Boxes get the usual eight; arrows get their two
 * endpoints, since resizing an arrow's bounding box would also bend its direction; strokes get
 * none (no resizing in v1).
 */
export function handlesFor(shape: Shape): Handle[] {
  switch (shape.type) {
    case 'arrow':
      return [
        { id: 'tail', x: shape.x, y: shape.y },
        { id: 'head', x: shape.x + shape.w, y: shape.y + shape.h },
      ];
    case 'stroke':
      return [];
    case 'rect':
    case 'ellipse':
    case 'note': {
      const b = rectBounds(shape.x, shape.y, shape.w, shape.h);
      const mx = (b.minX + b.maxX) / 2;
      const my = (b.minY + b.maxY) / 2;
      return [
        { id: 'nw', x: b.minX, y: b.minY },
        { id: 'n', x: mx, y: b.minY },
        { id: 'ne', x: b.maxX, y: b.minY },
        { id: 'e', x: b.maxX, y: my },
        { id: 'se', x: b.maxX, y: b.maxY },
        { id: 's', x: mx, y: b.maxY },
        { id: 'sw', x: b.minX, y: b.maxY },
        { id: 'w', x: b.minX, y: my },
      ];
    }
  }
}

/** The handle under world point p, if any. The grab area is the drawn HANDLE_PX square. */
export function handleAt(shape: Shape, p: Point, zoom: number): HandleId | null {
  const half = HANDLE_PX / 2 / zoom;
  // Last drawn wins, matching what's visually on top when handles overlap on tiny shapes.
  const hs = handlesFor(shape);
  for (let i = hs.length - 1; i >= 0; i--) {
    const h = hs[i] as Handle;
    if (Math.abs(p.x - h.x) <= half && Math.abs(p.y - h.y) <= half) return h.id;
  }
  return null;
}

/**
 * New geometry when `handle` of the shape as it was at drag start (`orig`) is dragged to p.
 * Always computed from the original, never incrementally, so rounding can't accumulate.
 * Boxes are re-normalized, so dragging an edge past the opposite one flips the box cleanly.
 */
export function resizeShape(orig: Shape, handle: HandleId, p: Point): Pick<ShapeProps, 'x' | 'y' | 'w' | 'h'> {
  if (handle === 'tail') {
    const hx = orig.x + orig.w;
    const hy = orig.y + orig.h;
    return { x: p.x, y: p.y, w: hx - p.x, h: hy - p.y };
  }
  if (handle === 'head') return { x: orig.x, y: orig.y, w: p.x - orig.x, h: p.y - orig.y };

  const b = rectBounds(orig.x, orig.y, orig.w, orig.h);
  let { minX, minY, maxX, maxY } = b;
  if (handle.includes('w')) minX = p.x;
  if (handle.includes('e')) maxX = p.x;
  if (handle.includes('n')) minY = p.y;
  if (handle.includes('s')) maxY = p.y;
  const n = rectBounds(minX, minY, maxX - minX, maxY - minY);
  return { x: n.minX, y: n.minY, w: n.maxX - n.minX, h: n.maxY - n.minY };
}
