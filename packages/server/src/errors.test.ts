import { describe, expect, it } from 'vitest';
import { isTransient, withRetry } from './errors';

describe('isTransient', () => {
  it('recognises lost connections and timeouts, including wrapped ones', () => {
    expect(isTransient(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransient(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isTransient(Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('y'), { code: '57P01' }) }))).toBe(true);
  });

  it('does not retry bugs or constraint violations', () => {
    expect(isTransient(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isTransient(new TypeError('undefined is not a function'))).toBe(false);
    expect(isTransient(null)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries transient failures, then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return 'ok';
      },
      { baseMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget, and never retries non-transient errors', async () => {
    let calls = 0;
    const transient = () => {
      calls++;
      return Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    };
    await expect(withRetry(transient, { retries: 2, baseMs: 1 })).rejects.toThrow('down');
    expect(calls).toBe(3);

    calls = 0;
    const bug = () => {
      calls++;
      return Promise.reject(new Error('bug'));
    };
    await expect(withRetry(bug, { baseMs: 1 })).rejects.toThrow('bug');
    expect(calls).toBe(1);
  });
});
