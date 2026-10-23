import { describe, expect, it } from 'vitest';
import {
  boxFromPoints,
  containsBox,
  distToSegment,
  expandBox,
  hitShape,
  overlaps,
  rdp,
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

describe('rdp', () => {
  const wobbly = (n: number, amp: number) => Array.from({ length: n }, (_, i) => [i, Math.sin(i * 1.7) * amp]).flat();

  it('collapses a nearly straight line to its two ends (algorithms.md §7b example)', () => {
    // Amplitude 0.4: even measured from the slightly tilted end-to-end line, nothing strays past 1.
    expect(rdp(wobbly(100, 0.4), 1)).toEqual([0, 0, 99, Math.sin(99 * 1.7) * 0.4]);
  });

  it('keeps the tip of a V: 3 points', () => {
    const v: number[] = [];
    for (let i = 0; i <= 50; i++) v.push(i, i < 25 ? i : 50 - i);
    expect(rdp(v, 1)).toEqual([0, 0, 25, 25, 50, 0]);
  });

  it('returns short inputs unchanged and drops a dangling odd value', () => {
    expect(rdp([], 1)).toEqual([]);
    expect(rdp([1, 2], 1)).toEqual([1, 2]);
    expect(rdp([1, 2, 3, 4, 5], 1)).toEqual([1, 2, 3, 4]);
  });

  it('every dropped point is within epsilon of the line through its kept neighbours; output is a subsequence', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 50; trial++) {
      const pts: number[] = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < 300; i++) {
        x += rand() * 4 - 1;
        y += rand() * 4 - 2;
        pts.push(x, y);
      }
      const eps = 0.5 + rand() * 3;
      const out = rdp(pts, eps);
      // Subsequence, ends kept: record which input index each output point came from.
      expect(out.slice(0, 2)).toEqual(pts.slice(0, 2));
      expect(out.slice(-2)).toEqual(pts.slice(-2));
      const keptIdx: number[] = [];
      let j = 0;
      for (let i = 0; i < out.length; i += 2) {
        while (j < pts.length && (pts[j] !== out[i] || pts[j + 1] !== out[i + 1])) j += 2;
        expect(j < pts.length, 'output point not found in order').toBe(true);
        keptIdx.push(j / 2);
        j += 2;
      }
      // RDP's guarantee: each dropped point is within epsilon of the (infinite) line through the
      // two kept points around it. Not the segment: a stroke that doubles back can project past it.
      for (let k = 0; k + 1 < keptIdx.length; k++) {
        const a = keptIdx[k] as number;
        const b = keptIdx[k + 1] as number;
        const ax = pts[2 * a] as number;
        const ay = pts[2 * a + 1] as number;
        const dx = (pts[2 * b] as number) - ax;
        const dy = (pts[2 * b + 1] as number) - ay;
        const len = Math.hypot(dx, dy);
        for (let i = a + 1; i < b; i++) {
          const px = (pts[2 * i] as number) - ax;
          const py = (pts[2 * i + 1] as number) - ay;
          const d = len === 0 ? Math.hypot(px, py) : Math.abs(dy * px - dx * py) / len;
          expect(d).toBeLessThanOrEqual(eps + 1e-9);
        }
      }
    }
  });

  it('handles a 20,000-point worst case without blowing the stack', () => {
    // A spiral: almost every point is a split point.
    const pts: number[] = [];
    for (let i = 0; i < 20_000; i++) pts.push(Math.cos(i / 50) * i, Math.sin(i / 50) * i);
    const out = rdp(pts, 0.01);
    expect(out.length).toBeGreaterThan(1000);
  });
});
