import { describe, expect, it } from 'vitest';
import { createIdGenerator } from './ids';

describe('createIdGenerator', () => {
  it('produces clientId-counter, counting from 1', () => {
    const next = createIdGenerator('k3f9a');
    expect([next(), next(), next()]).toEqual(['k3f9a-1', 'k3f9a-2', 'k3f9a-3']);
  });

  it('never clashes between clients', () => {
    const a = createIdGenerator('a');
    const b = createIdGenerator('b');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(a());
      ids.add(b());
    }
    expect(ids.size).toBe(200);
  });
});
