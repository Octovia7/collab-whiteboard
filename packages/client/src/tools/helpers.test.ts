import { describe, expect, it } from 'vitest';
import type { Shape } from '@whiteboard/shared';
import { hitTolerance } from './constants';
import { handleAt, handlesFor, resizeShape } from './handles';
import { keysAbove, keysBelow } from './reorder';
import { geometry } from './ShapeTool';

const rect: Shape = { id: 'a-1', type: 'rect', x: 0, y: 0, w: 100, h: 50, color: 'black', z: 'i' };
const arrow: Shape = { ...rect, id: 'a-2', type: 'arrow', x: 10, y: 10, w: 90, h: -10 };

describe('handles', () => {
  it('boxes get 8 handles, arrows their 2 endpoints, strokes none', () => {
    expect(handlesFor(rect).map((h) => h.id)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    expect(handlesFor(arrow)).toEqual([
      { id: 'tail', x: 10, y: 10 },
      { id: 'head', x: 100, y: 0 },
    ]);
    expect(handlesFor({ ...rect, type: 'stroke' })).toEqual([]);
  });

  it('the grab area is 8 screen px at any zoom', () => {
    expect(handleAt(rect, { x: 103.9, y: 50 }, 1)).toBe('se');
    expect(handleAt(rect, { x: 104.1, y: 50 }, 1)).toBeNull();
    // At zoom 4 the same 4 px half-size is only 1 world unit.
    expect(handleAt(rect, { x: 100.9, y: 50 }, 4)).toBe('se');
    expect(handleAt(rect, { x: 101.1, y: 50 }, 4)).toBeNull();
  });

  it('resizes from the original box and flips cleanly past the opposite edge', () => {
    expect(resizeShape(rect, 'se', { x: 150, y: 80 })).toEqual({ x: 0, y: 0, w: 150, h: 80 });
    expect(resizeShape(rect, 'w', { x: 20, y: 999 })).toEqual({ x: 20, y: 0, w: 80, h: 50 });
    expect(resizeShape(rect, 'e', { x: -30, y: 0 })).toEqual({ x: -30, y: 0, w: 30, h: 50 });
  });

  it('moves arrow endpoints independently', () => {
    expect(resizeShape(arrow, 'head', { x: 50, y: 60 })).toEqual({ x: 10, y: 10, w: 40, h: 50 });
    expect(resizeShape(arrow, 'tail', { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 100, h: 0 });
  });
});

describe('reorder keys', () => {
  it('keysAbove gives ascending keys above the top', () => {
    const keys = keysAbove('m', 3);
    expect(keys).toHaveLength(3);
    expect('m' < (keys[0] as string) && (keys[0] as string) < (keys[1] as string) && (keys[1] as string) < (keys[2] as string)).toBe(true);
  });

  it('keysBelow gives ascending keys below the bottom', () => {
    const keys = keysBelow('m', 3);
    expect((keys[0] as string) < (keys[1] as string) && (keys[1] as string) < (keys[2] as string) && (keys[2] as string) < 'm').toBe(true);
  });

  it('works on an empty board', () => {
    expect(keysAbove('', 1)).toEqual(['i']);
    expect(keysBelow('', 1)).toEqual(['i']);
  });
});

describe('shape tool geometry', () => {
  it('normalizes boxes but keeps arrow direction', () => {
    expect(geometry('rect', { x: 50, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 30 });
    expect(geometry('arrow', { x: 50, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 50, y: 50, w: -40, h: -30 });
  });

  it('hit tolerance is 6 screen px plus half the line', () => {
    expect(hitTolerance(1)).toBe(7);
    expect(hitTolerance(2)).toBe(4);
  });
});
