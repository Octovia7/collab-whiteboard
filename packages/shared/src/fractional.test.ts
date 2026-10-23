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

function expectStrictlyAscending(keys: string[]): void {
  for (let i = 1; i < keys.length; i++) {
    expect((keys[i - 1] as string) < (keys[i] as string), `"${keys[i - 1]}" < "${keys[i]}" at ${i}`).toBe(true);
  }
}

describe('keyBetween: format', () => {
  it('starts at i0 and counts up and down through the integer part', () => {
    expect(keyBetween('', '')).toBe('i0');
    expect(keyBetween('i0', '')).toBe('i1');
    expect(keyBetween('', 'i0')).toBe('hz');
    expect(keyBetween('i0', 'i5')).toBe('i1');
  });

  it('moves to a longer integer when one length runs out', () => {
    expect(keyBetween('iz', '')).toBe('j00');
    expect(keyBetween('jzz', '')).toBe('k000');
    expect(keyBetween('', 'h0')).toBe('gzz');
    expect(keyBetween('gzz', '')).toBe('h0');
    expect(keyBetween('hz', '')).toBe('i0');
  });

  it('uses a fraction only between adjacent integers or within one', () => {
    expect(keyBetween('i0', 'i1')).toBe('i0i');
    expect(keyBetween('i0', 'i0i')).toBe('i09');
    expect(keyBetween('i0i', 'i1')).toBe('i0r');
    expect(keyBetween('', 'i0i')).toBe('i0'); // the bare integer is already smaller
    expect(keyBetween('i0i', '')).toBe('i1'); // a bigger integer beats any fraction
    expect(keyBetween('i4', 'i5k')).toBe('i5');
  });

  it('validates keys', () => {
    expect(isValidKey('i0')).toBe(true);
    expect(isValidKey('j00k')).toBe(true);
    expect(isValidKey('i')).toBe(false); // head says 1 digit, none given
    expect(isValidKey('j0')).toBe(false); // head says 2 digits
    expect(isValidKey('i0k0')).toBe(false); // fraction ends in 0
    expect(isValidKey('I0')).toBe(false);
    expect(() => keyBetween('i0k0', '')).toThrow();
    expect(() => keyBetween('', 'A')).toThrow();
    expect(() => keyBetween('i2', 'i1')).toThrow();
    expect(() => keyBetween('i1', 'i1')).toThrow();
  });
});

describe('keyBetween: growth', () => {
  it('20,000 inserts on top stay at 4 characters (the old midpoint-only keys reached 3,334)', () => {
    const keys = [keyBetween('', '')];
    for (let i = 1; i < 20_000; i++) keys.push(keyBetween(keys[i - 1] as string, ''));
    expect((keys[keys.length - 1] as string).length).toBe(4);
    expect(Math.max(...keys.map((k) => k.length))).toBe(4);
    expectStrictlyAscending(keys);
  });

  it('20,000 inserts at the bottom stay at 4 characters', () => {
    const keys = [keyBetween('', '')];
    for (let i = 1; i < 20_000; i++) keys.push(keyBetween('', keys[i - 1] as string));
    expect(Math.max(...keys.map((k) => k.length))).toBe(4);
    expectStrictlyAscending(keys.reverse());
  });

  it('inserts between neighbours stay ordered; repeated inserts at one spot grow slowly', () => {
    // Worst case: always insert right after the same key. Only the fraction grows, about one
    // character per 6 inserts, which is inherent to any fractional index without rebalancing.
    let hi = 'i1';
    for (let n = 0; n < 300; n++) hi = expectBetween('i0', hi);
    expect(hi.length).toBeLessThanOrEqual(2 + Math.ceil(300 / 5));
    let lo = 'i0';
    for (let n = 0; n < 300; n++) lo = expectBetween(lo, 'i1');
    // Alternating sides of a gap is the friendly case: it halves the gap each time.
    let a = 'i0';
    let b = 'i1';
    for (let n = 0; n < 300; n++) {
      const k = expectBetween(a, b);
      if (n % 2 === 0) a = k;
      else b = k;
    }
  });
});

describe('keyBetween: ordering stays correct', () => {
  it('under thousands of random top, bottom and between inserts', () => {
    const next = rng(42);
    const keys: string[] = [];
    for (let n = 0; n < 5000; n++) {
      const r = next();
      let i: number;
      if (r < 0.3) i = keys.length; // top
      else if (r < 0.5) i = 0; // bottom
      else i = Math.floor(next() * (keys.length + 1)); // between random neighbours
      const k = expectBetween(keys[i - 1] ?? '', keys[i] ?? '');
      keys.splice(i, 0, k);
    }
    expectStrictlyAscending(keys);
    // The integer part keeps the common cases short.
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(20);
  });

  it('bring-to-front and send-to-back alternate freely', () => {
    let top = keyBetween('', '');
    let bottom = top;
    for (let n = 0; n < 2000; n++) {
      top = expectBetween(top, '');
      bottom = expectBetween('', bottom);
    }
    expect(bottom < top).toBe(true);
  });
});

describe('compareDrawOrder', () => {
  it('sorts by z, then id for equal z', () => {
    const shapes = [
      { id: 'b-1', z: 'i5' },
      { id: 'a-1', z: 'i5' },
      { id: 'c-1', z: 'i0' },
    ];
    expect(shapes.sort(compareDrawOrder).map((s) => s.id)).toEqual(['c-1', 'a-1', 'b-1']);
  });
});
