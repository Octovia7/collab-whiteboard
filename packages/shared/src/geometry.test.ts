import { describe, expect, it } from 'vitest';
import {
  boxFromPoints,
  containsBox,
  distToSegment,
  expandBox,
  hitShape,
  overlaps,
  rectBounds,
  shapeBounds,
  strokeBounds,
} from './geometry';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
const pt = (x: number, y: number) => ({ x, y });

describe('overlaps / containsBox', () => {
  it('detects overlap, containment and separation', () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(2, 2, 3, 3))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(11, 0, 20, 10))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(0, -5, 10, -1))).toBe(false);
  });

  it('counts touching edges as overlapping', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(true);
  });

  it('containsBox needs the inner box fully inside', () => {
    expect(containsBox(box(0, 0, 10, 10), box(2, 2, 10, 10))).toBe(true);
    expect(containsBox(box(0, 0, 10, 10), box(2, 2, 11, 10))).toBe(false);
  });
});

describe('bounds', () => {
  it('normalizes negative width and height', () => {
    expect(rectBounds(10, 10, -4, -6)).toEqual(box(6, 4, 10, 10));
    expect(boxFromPoints(pt(5, 1), pt(2, 9))).toEqual(box(2, 1, 5, 9));
    expect(shapeBounds({ type: 'rect', x: 0, y: 0, w: 5, h: 3 })).toEqual(box(0, 0, 5, 3));
  });

  it('stroke bounds come from the relative points, offset by x/y, ignoring w/h', () => {
    expect(strokeBounds(100, 50, [0, 0, 10, -5, -3, 20])).toEqual(box(97, 45, 110, 70));
    expect(shapeBounds({ type: 'stroke', x: 100, y: 50, w: 999, h: 999 }, [0, 0, 10, -5])).toEqual(box(100, 45, 110, 50));
    expect(strokeBounds(7, 8, [])).toEqual(box(7, 8, 7, 8));
  });

  it('expandBox grows every side', () => {
    expect(expandBox(box(0, 0, 1, 1), 2)).toEqual(box(-2, -2, 3, 3));
  });
});

describe('distToSegment', () => {
  it('measures to the nearest point on the segment, clamped to its ends', () => {
    expect(distToSegment(pt(5, 3), pt(0, 0), pt(10, 0))).toBe(3);
    expect(distToSegment(pt(-3, 4), pt(0, 0), pt(10, 0))).toBe(5); // beyond the start: distance to the end point
    expect(distToSegment(pt(3, 4), pt(0, 0), pt(0, 0))).toBe(5); // zero-length segment
  });
});

describe('hitShape', () => {
  const rect = { type: 'rect' as const, x: 0, y: 0, w: 100, h: 50 };

  it('unfilled rect: hits near the outline only', () => {
    expect(hitShape(rect, pt(50, 1), 2)).toBe(true);
    expect(hitShape(rect, pt(103, 25), 4)).toBe(true);
    expect(hitShape(rect, pt(50, 25), 4)).toBe(false); // middle of an outline-only box
    expect(hitShape(rect, pt(50, -10), 4)).toBe(false);
  });

  it('ellipse: hits near the curve, not the centre or the box corners', () => {
    const e = { type: 'ellipse' as const, x: 0, y: 0, w: 100, h: 100 };
    expect(hitShape(e, pt(100, 50), 2)).toBe(true);
    expect(hitShape(e, pt(50 + 50 * Math.SQRT1_2, 50 + 50 * Math.SQRT1_2), 1)).toBe(true);
    expect(hitShape(e, pt(50, 50), 4)).toBe(false);
    expect(hitShape(e, pt(2, 2), 4)).toBe(false); // corner of the box is far from the curve
  });

  it('arrow: hits along the shaft, including a flipped (negative) arrow', () => {
    const a = { type: 'arrow' as const, x: 100, y: 100, w: -100, h: -100 };
    expect(hitShape(a, pt(50, 52), 3)).toBe(true);
    expect(hitShape(a, pt(50, 70), 3)).toBe(false);
  });

  it('stroke: hits along the relative polyline, moved by x/y', () => {
    const s = { type: 'stroke' as const, x: 1000, y: 1000, w: 0, h: 0 };
    const pts = [0, 0, 50, 0, 50, 50];
    expect(hitShape(s, pt(1025, 1002), 3, pts)).toBe(true);
    expect(hitShape(s, pt(1052, 1030), 3, pts)).toBe(true);
    expect(hitShape(s, pt(25, 2), 3, pts)).toBe(false); // the same spot without the offset
    expect(hitShape(s, pt(1001, 1001), 3, [0, 0])).toBe(true); // single-point stroke
  });

  it('note: filled, so the inside counts', () => {
    expect(hitShape({ type: 'note', x: 0, y: 0, w: 100, h: 100 }, pt(50, 50), 0)).toBe(true);
    expect(hitShape({ type: 'note', x: 0, y: 0, w: 100, h: 100 }, pt(105, 50), 4)).toBe(false);
  });
});
