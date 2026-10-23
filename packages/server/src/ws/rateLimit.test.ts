import { describe, expect, it } from 'vitest';
import { TokenBucket, UserLimits } from './rateLimit';

describe('TokenBucket', () => {
  it('allows a burst, then refills at the steady rate', () => {
    let now = 0;
    const b = new TokenBucket(100, 300, () => now);
    expect(b.take(300)).toBe(0); // the whole burst at once
    expect(b.take(50)).toBe(500); // empty: 50 tokens at 100/s = 500 ms
    now += 500;
    expect(b.take(50)).toBe(0);
    now += 10_000;
    expect(b.take(301)).toBeGreaterThan(0); // refill never exceeds the burst size
    expect(b.take(300)).toBe(0);
  });
});

describe('UserLimits', () => {
  it('caps open sockets per user, and frees slots on close', () => {
    const l = new UserLimits(200, 1000, 2);
    expect([l.open('u'), l.open('u'), l.open('u')]).toEqual([true, true, false]);
    expect(l.open('other')).toBe(true);
    l.close('u');
    expect(l.open('u')).toBe(true);
  });

  it('throttles instead of rejecting: waits until the budget allows the batch', async () => {
    const l = new UserLimits(1000, 100, 5);
    l.open('u');
    let throttled = 0;
    const started = performance.now();
    await l.waitForOps('u', 100, () => throttled++); // the burst
    await l.waitForOps('u', 50, () => throttled++); // must wait ~50 ms
    expect(throttled).toBeGreaterThan(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  });
});
