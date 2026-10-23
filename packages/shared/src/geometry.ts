import type { Shape } from './types';

export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned bounding box (AABB) in world coordinates. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Two boxes overlap unless one is entirely left, right, above or below the other. Edges touching count. */
export function overlaps(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function expandBox(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

/**
 * Box spanned by (x, y) and (x + w, y + h). w and h may be negative: an arrow drawn up-left
 * has a negative w/h because (x, y) is its tail, and a box resized past its opposite edge
 * flips the same way.
 */
export function rectBounds(x: number, y: number, w: number, h: number): Box {
  return {
    minX: Math.min(x, x + w),
    minY: Math.min(y, y + h),
    maxX: Math.max(x, x + w),
    maxY: Math.max(y, y + h),
  };
}

/** Bounds of a shape's geometry, before line width. Strokes use their x/y/w/h box for now. */
export function shapeBounds(shape: Pick<Shape, 'x' | 'y' | 'w' | 'h'>): Box {
  return rectBounds(shape.x, shape.y, shape.w, shape.h);
}
