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

/** True if `inner` lies entirely inside `outer` (edges may touch). */
export function containsBox(outer: Box, inner: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function expandBox(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

/** The box with corners a and b, whichever way round they are. */
export function boxFromPoints(a: Point, b: Point): Box {
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

/**
 * Box spanned by (x, y) and (x + w, y + h). w and h may be negative: an arrow drawn up-left
 * has a negative w/h because (x, y) is its tail.
 */
export function rectBounds(x: number, y: number, w: number, h: number): Box {
  return boxFromPoints({ x, y }, { x: x + w, y: y + h });
}

/**
 * Stroke points are offsets from the stroke's pen-down point (x, y), so moving a stroke is a
 * plain {x, y} update. Its box is always computed from the points, never stored.
 */
export function strokeBounds(x: number, y: number, points: readonly number[]): Box {
  if (points.length < 2) return { minX: x, minY: y, maxX: x, maxY: y };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const px = points[i] as number;
    const py = points[i + 1] as number;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return { minX: x + minX, minY: y + minY, maxX: x + maxX, maxY: y + maxY };
}

type Geometry = Pick<Shape, 'type' | 'x' | 'y' | 'w' | 'h'>;

/**
 * Bounds of a shape's geometry, before line width. Strokes need their points (from
 * Board.strokePoints, which picks the pen-up list or the streamed chunks).
 */
export function shapeBounds(shape: Geometry, strokePoints: readonly number[] = []): Box {
  if (shape.type === 'stroke') return strokeBounds(shape.x, shape.y, strokePoints);
  return rectBounds(shape.x, shape.y, shape.w, shape.h);
}

/** Distance from p to the segment a-b (not the infinite line, as in RDP): clamp to the ends. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // Project p onto the line as a fraction t of the segment, then clamp to [0, 1].
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance from p to the outline of the box (0 on the edge, positive inside and outside). */
function distToBoxOutline(p: Point, b: Box): number {
  const inside = p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
  if (inside) return Math.min(p.x - b.minX, b.maxX - p.x, p.y - b.minY, b.maxY - p.y);
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

/**
 * Approximate distance from p to the outline of the ellipse inscribed in box b.
 * d = ((px-cx)/rx)^2 + ((py-cy)/ry)^2 under a square root is 1 on the outline, so the ray from
 * the centre through p meets the outline at |p - c| / d; the gap along that ray is
 * |p - c| * |1 - 1/d|. Exact for circles, slightly off on very flat ellipses: fine for clicking.
 */
function distToEllipseOutline(p: Point, b: Box): number {
  const rx = (b.maxX - b.minX) / 2;
  const ry = (b.maxY - b.minY) / 2;
  const cx = b.minX + rx;
  const cy = b.minY + ry;
  // A flat ellipse is a line segment.
  if (rx === 0 || ry === 0) return distToSegment(p, { x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY });
  const fromCentre = Math.hypot(p.x - cx, p.y - cy);
  const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
  if (d === 0) return Math.min(rx, ry);
  return fromCentre * Math.abs(1 - 1 / d);
}

/** Distance from p to a polyline given as relative [x1, y1, x2, y2, ...] offset by (ox, oy). */
function distToPolyline(p: Point, ox: number, oy: number, points: readonly number[]): number {
  if (points.length < 2) return Math.hypot(p.x - ox, p.y - oy);
  let best = Infinity;
  let prev = { x: ox + (points[0] as number), y: oy + (points[1] as number) };
  if (points.length < 4) return Math.hypot(p.x - prev.x, p.y - prev.y);
  for (let i = 2; i + 1 < points.length; i += 2) {
    const cur = { x: ox + (points[i] as number), y: oy + (points[i + 1] as number) };
    best = Math.min(best, distToSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}

/**
 * Exact hit test (algorithms.md §11c) for a candidate the quadtree returned.
 * `tolerance` is in world units and should already include half the line width.
 * Rects, ellipses, arrows and strokes are unfilled, so only their outline is hittable;
 * notes are filled, so anywhere inside counts.
 */
export function hitShape(shape: Geometry, p: Point, tolerance: number, strokePoints: readonly number[] = []): boolean {
  switch (shape.type) {
    case 'rect':
      return distToBoxOutline(p, shapeBounds(shape)) <= tolerance;
    case 'ellipse':
      return distToEllipseOutline(p, shapeBounds(shape)) <= tolerance;
    case 'arrow':
      return distToSegment(p, { x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }) <= tolerance;
    case 'stroke':
      return distToPolyline(p, shape.x, shape.y, strokePoints) <= tolerance;
    case 'note':
      return containsBox(expandBox(shapeBounds(shape), tolerance), { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
    default: {
      const unknown: never = shape.type;
      throw new Error(`no hit test for shape type ${String(unknown)}`);
    }
  }
}
