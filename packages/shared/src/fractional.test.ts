import { describe, expect, it } from 'vitest';
import { compareDrawOrder, isValidKey, keyBetween } from './fractional';

/** Small deterministic PRNG so failures reproduce. */
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

function expectBetween(a: string, b: string): string {
  const k = keyBetween(a, b);
  expect(isValidKey(k), `"${k}" invalid`).toBe(true);
  if (a) expect(a < k, `"${a}" < "${k}"`).toBe(true);
  if (b) expect(k < b, `"${k}" < "${b}"`).toBe(true);
  return k;
}

describe('keyBetween', () => {
  it('matches the examples in algorithms.md §5', () => {
    expect(keyBetween('', '')).toBe('i');
    expect(keyBetween('i', '')).toBe('r');
    expect(keyBetween('i', 'r')).toBe('m');
    expect(keyBetween('i', 'j')).toBe('ii');
  });

  it('handles open bounds and tight gaps', () => {
    expectBetween('', 'i');
    expectBetween('', '1');
    expectBetween('', '01');
    expectBetween('z', '');
    expectBetween('zz', '');
    expectBetween('a', 'a1');
    expectBetween('a', 'a01');
    expectBetween('az', 'b');
    expectBetween('a5', 'b3');
    expectBetween('a5', 'b9');
  });

  it('rejects invalid input', () => {
    expect(() => keyBetween('a0', '')).toThrow();
    expect(() => keyBetween('', 'A')).toThrow();
    expect(() => keyBetween('b', 'a')).toThrow();
    expect(() => keyBetween('a', 'a')).toThrow();
  });

  it('never produces a key ending in 0, over many random inserts', () => {
    const next = rng(42);
    const keys: string[] = [];
    for (let n = 0; n < 2000; n++) {
      const i = Math.floor(next() * (keys.length + 1));
      const k = expectBetween(keys[i - 1] ?? '', keys[i] ?? '');
      keys.splice(i, 0, k);
    }
    for (let i = 1; i < keys.length; i++) expect((keys[i - 1] as string) < (keys[i] as string)).toBe(true);
  });

  it('keeps working when everyone inserts at the same spot (keys just grow)', () => {
    let lo = 'i';
    const hi = 'j';
    for (let n = 0; n < 200; n++) lo = expectBetween(lo, hi);
    let hi2 = 'j';
    for (let n = 0; n < 200; n++) hi2 = expectBetween('i', hi2);
  });

  it('bring-to-front and send-to-back keep working repeatedly', () => {
    let top = keyBetween('', '');
    let bottom = top;
    for (let n = 0; n < 200; n++) {
      top = expectBetween(top, '');
      bottom = expectBetween('', bottom);
    }
  });
});

describe('compareDrawOrder', () => {
  it('sorts by z, then id for equal z', () => {
    const shapes = [
      { id: 'b-1', z: 'm' },
      { id: 'a-1', z: 'm' },
      { id: 'c-1', z: 'i' },
    ];
    expect(shapes.sort(compareDrawOrder).map((s) => s.id)).toEqual(['c-1', 'a-1', 'b-1']);
  });
});
