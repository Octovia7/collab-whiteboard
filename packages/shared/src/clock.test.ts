import { describe, expect, it } from 'vitest';
import { LamportClock, compareStamps } from './clock';

describe('LamportClock', () => {
  it('tick adds 1 and stamps with the client id', () => {
    const c = new LamportClock('a');
    expect(c.tick()).toEqual({ t: 1, client: 'a' });
    expect(c.tick()).toEqual({ t: 2, client: 'a' });
  });

  it('observe moves the clock forward but never back', () => {
    const c = new LamportClock('a');
    c.observe({ t: 5, client: 'b' });
    expect(c.now).toBe(5);
    c.observe({ t: 3, client: 'b' });
    expect(c.now).toBe(5);
    expect(c.tick().t).toBe(6);
  });

  it('follows the worked example in algorithms.md §2', () => {
    const r = new LamportClock('rudraksh');
    const p = new LamportClock('priya');
    const m1 = r.tick();
    const m2 = r.tick();
    expect([m1.t, m2.t]).toEqual([1, 2]);
    p.observe(m1);
    p.observe(m2);
    const recolor = p.tick();
    expect(recolor).toEqual({ t: 3, client: 'priya' });
    // Priya had seen both moves, so her edit is later than both.
    expect(compareStamps(recolor, m2)).toBeGreaterThan(0);
    r.observe(recolor);
    // Concurrent edits: both stamp 4, the client id breaks the tie identically everywhere.
    const rx = r.tick();
    const px = p.tick();
    expect(rx.t).toBe(4);
    expect(px.t).toBe(4);
    expect(compareStamps(rx, px)).toBeGreaterThan(0);
    expect(compareStamps(px, rx)).toBeLessThan(0);
  });
});

describe('compareStamps', () => {
  it('orders by t first, then client', () => {
    expect(compareStamps({ t: 2, client: 'a' }, { t: 1, client: 'z' })).toBeGreaterThan(0);
    expect(compareStamps({ t: 1, client: 'b' }, { t: 1, client: 'a' })).toBeGreaterThan(0);
    expect(compareStamps({ t: 1, client: 'a' }, { t: 1, client: 'a' })).toBe(0);
  });

  it('is antisymmetric', () => {
    const stamps = [
      { t: 1, client: 'a' },
      { t: 1, client: 'b' },
      { t: 2, client: 'a' },
      { t: 10, client: 'A' },
    ];
    // `+ 0` turns -0 into 0, since toBe uses Object.is.
    for (const x of stamps) for (const y of stamps) expect(Math.sign(compareStamps(x, y))).toBe(-Math.sign(compareStamps(y, x)) + 0);
  });
});
