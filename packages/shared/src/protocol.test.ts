import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from './protocol';

const stamp = { t: 1, client: 'abc' };
const shape = { id: 'abc-1', type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'red', z: 'i0' };
const ok = (m: unknown) => parseClientMessage(JSON.stringify(m)).ok;

describe('client messages', () => {
  it('accepts hello, ops and ping', () => {
    expect(ok({ t: 'hello', boardId: 'board-1', lastSeq: 0 })).toBe(true);
    expect(ok({ t: 'ping' })).toBe(true);
    expect(
      ok({
        t: 'ops',
        ops: [
          { kind: 'create', opId: 'abc:1', stamp, shape },
          { kind: 'update', opId: 'abc:2', stamp: { t: 2, client: 'abc' }, id: 'abc-1', props: { x: 5, deleted: true } },
          { kind: 'append', opId: 'abc:3', stamp: { t: 3, client: 'abc' }, id: 'abc-1', chunk: 0, points: [1, 2, 3, 4] },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(parseClientMessage('not json')).toEqual({ ok: false, error: 'invalid JSON' });
    expect(ok({ t: 'nope' })).toBe(false);
    expect(ok({ t: 'hello', boardId: 'bad board!', lastSeq: 0 })).toBe(false);
    expect(ok({ t: 'ops', ops: [] })).toBe(false);
  });

  it('enforces op limits and value checks', () => {
    const op = (o: object) => ok({ t: 'ops', ops: [o] });
    const update = (props: object) => op({ kind: 'update', opId: 'a:1', stamp, id: 'abc-1', props });
    expect(update({ x: Infinity })).toBe(false); // JSON turns it into null, which is not a number
    expect(update({ x: 1e12 })).toBe(false); // beyond the coordinate bound
    expect(update({ z: 'i0k0' })).toBe(false); // invalid fractional key
    expect(update({ type: 'ellipse' })).toBe(false); // type can't change; stripped, leaving an empty update
    expect(update({})).toBe(false);
    expect(update({ text: 'x'.repeat(10_001) })).toBe(false);
    expect(op({ kind: 'create', opId: 'a:1', stamp, shape: { ...shape, id: 'no-counter-x' } })).toBe(false);
    expect(op({ kind: 'append', opId: 'a:1', stamp, id: 'abc-1', chunk: 0, points: [1, 2, 3] })).toBe(false);
    expect(op({ kind: 'append', opId: 'a:1', stamp, id: 'abc-1', chunk: 0, points: new Array(4002).fill(1) })).toBe(false);
    expect(op({ kind: 'update', opId: 'a:1', stamp: { t: 0, client: 'abc' }, id: 'abc-1', props: { x: 1 } })).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ kind: 'update', opId: `a:${i}`, stamp, id: 'abc-1', props: { x: i } }));
    expect(ok({ t: 'ops', ops: many })).toBe(false);
  });

  it('strips unknown fields, so a client cannot smuggle in a userId', () => {
    const parsed = parseClientMessage(JSON.stringify({ t: 'hello', boardId: 'b', lastSeq: 0, userId: 'admin' }));
    expect(parsed).toEqual({ ok: true, msg: { t: 'hello', boardId: 'b', lastSeq: 0 } });
  });
});

describe('server messages', () => {
  it('parses each type', () => {
    const okS = (m: unknown) => parseServerMessage(JSON.stringify(m)).ok;
    expect(okS({ t: 'welcome', you: { userId: 'u' }, role: 'editor', peers: [], snapshot: { shapes: [] }, seq: 0 })).toBe(true);
    expect(okS({ t: 'ack', opIds: ['a:1'], seq: 3 })).toBe(true);
    expect(okS({ t: 'reject', opId: 'a:1', reason: 'unknown_shape', shape: null })).toBe(true);
    expect(okS({ t: 'error', code: 'bad_message', message: 'x' })).toBe(true);
    expect(okS({ t: 'role', role: 'viewer' })).toBe(true);
    expect(okS({ t: 'role', role: 'admin' })).toBe(false);
    expect(okS({ t: 'welcome', you: { userId: 'u' }, role: 'editor', peers: [], snapshot: null, seq: 0 })).toBe(false);
  });
});
