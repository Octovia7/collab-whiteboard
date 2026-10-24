import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rateLimit';

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

// UserLimits keeps its state in Redis: see tests/integration/redis.test.ts.
