import { describe, expect, it } from 'vitest';
import { Emitter } from './Emitter';

describe('Emitter', () => {
  it('delivers payloads to subscribers until they unsubscribe', () => {
    const e = new Emitter<{ ping: number }>();
    const got: number[] = [];
    const off = e.on('ping', (n) => got.push(n));
    e.emit('ping', 1);
    off();
    e.emit('ping', 2);
    expect(got).toEqual([1]);
  });
});
