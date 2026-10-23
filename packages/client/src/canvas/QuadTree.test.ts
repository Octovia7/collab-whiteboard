import { describe, expect, it } from 'vitest';
import { overlaps } from '@whiteboard/shared';
import type { Box } from '@whiteboard/shared';
import { QuadTree } from './QuadTree';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBox(r: () => number, spread: number, maxSize: number): Box {
  const x = (r() - 0.5) * spread;
  const y = (r() - 0.5) * spread;
  return { minX: x, minY: y, maxX: x + r() * maxSize, maxY: y + r() * maxSize };
}

const sorted = (ids: string[]) => [...ids].sort();

describe('QuadTree', () => {
  it('matches a brute-force scan across inserts, moves and removes', () => {
    const r = rng(7);
    const tree = new QuadTree();
    const truth = new Map<string, Box>();
    for (let i = 0; i < 3000; i++) {
      const id = `s-${i}`;
      const b = randomBox(r, 20_000, 400);
      tree.set(id, b);
      truth.set(id, b);
    }
    // Move a third, remove a sixth.
    for (let i = 0; i < 3000; i += 3) {
      const b = randomBox(r, 20_000, 400);
      tree.set(`s-${i}`, b);
      truth.set(`s-${i}`, b);
    }
    for (let i = 1; i < 3000; i += 6) {
      tree.remove(`s-${i}`);
      truth.delete(`s-${i}`);
    }
    expect(tree.size).toBe(truth.size);
    for (let q = 0; q < 200; q++) {
      const query = randomBox(r, 22_000, 3000);
      const expected = [...truth].filter(([, b]) => overlaps(b, query)).map(([id]) => id);
      expect(sorted(tree.query(query))).toEqual(sorted(expected));
    }
  });

  it('keeps boxes that straddle a split line findable', () => {
    const tree = new QuadTree(1000);
    for (let i = 0; i < 40; i++) tree.set(`small-${i}`, { minX: 10 + i, minY: 10, maxX: 11 + i, maxY: 11 });
    tree.set('straddle', { minX: -5, minY: -5, maxX: 5, maxY: 5 });
    expect(tree.query({ minX: -1, minY: -1, maxX: 1, maxY: 1 })).toEqual(['straddle']);
  });

  it('grows the root when a shape lands outside it', () => {
    const tree = new QuadTree(100);
    tree.set('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.set('far', { minX: 5000, minY: -9000, maxX: 5010, maxY: -8990 });
    expect(sorted(tree.query({ minX: -1e5, minY: -1e5, maxX: 1e5, maxY: 1e5 }))).toEqual(['a', 'far']);
    expect(tree.query({ minX: 4999, minY: -8995, maxX: 5001, maxY: -8994 })).toEqual(['far']);
  });

  it('survives many identical boxes (depth cap stops endless splitting)', () => {
    const tree = new QuadTree();
    for (let i = 0; i < 500; i++) tree.set(`dup-${i}`, { minX: 1, minY: 1, maxX: 2, maxY: 2 });
    expect(tree.query({ minX: 0, minY: 0, maxX: 3, maxY: 3 })).toHaveLength(500);
  });

  it('remove of an unknown id is a no-op', () => {
    const tree = new QuadTree();
    tree.remove('nope');
    expect(tree.size).toBe(0);
  });
});
