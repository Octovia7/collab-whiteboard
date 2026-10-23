import { describe, expect, it } from 'vitest';
import { expandBox, overlaps, rectBounds, shapeBounds } from './geometry';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

describe('overlaps', () => {
  it('detects overlap, containment and separation', () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(2, 2, 3, 3))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(11, 0, 20, 10))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(0, -5, 10, -1))).toBe(false);
  });

  it('counts touching edges as overlapping', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(true);
  });
});

describe('rectBounds / shapeBounds', () => {
  it('normalizes negative width and height', () => {
    expect(rectBounds(10, 10, -4, -6)).toEqual(box(6, 4, 10, 10));
    expect(shapeBounds({ x: 0, y: 0, w: 5, h: 3 })).toEqual(box(0, 0, 5, 3));
  });

  it('expandBox grows every side', () => {
    expect(expandBox(box(0, 0, 1, 1), 2)).toEqual(box(-2, -2, 3, 3));
  });
});
