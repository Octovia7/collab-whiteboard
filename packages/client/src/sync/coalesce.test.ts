import { describe, expect, it } from 'vitest';
import { Board } from '@whiteboard/shared';
import type { CreateOp, Op, ShapeProps, UpdateOp } from '@whiteboard/shared';
import { enqueueCoalesced } from './coalesce';

const stamp = (t: number, client = 'a') => ({ t, client });
const upd = (t: number, props: Partial<ShapeProps>, id = 's-1', client = 'a'): UpdateOp => ({
  kind: 'update',
  opId: `${client}:${t}`,
  stamp: stamp(t, client),
  id,
  props,
});
const create: CreateOp = {
  kind: 'create',
  opId: 'a:0',
  stamp: stamp(1),
  shape: { id: 's-1', type: 'rect', x: 0, y: 0, w: 1, h: 1, color: 'black', z: 'i0' },
};

describe('enqueueCoalesced', () => {
  it('drops an earlier update entirely covered by a later one', () => {
    const outbox: Op[] = [];
    enqueueCoalesced(outbox, upd(2, { x: 101 }));
    enqueueCoalesced(outbox, upd(3, { x: 104 }));
    expect(outbox).toEqual([upd(3, { x: 104 })]);
  });

  it('keeps the uncovered props of the earlier update, with their original stamp', () => {
    const outbox: Op[] = [];
    enqueueCoalesced(outbox, upd(2, { x: 1, y: 1 }));
    enqueueCoalesced(outbox, upd(3, { x: 2 }));
    expect(outbox).toEqual([upd(2, { y: 1 }), upd(3, { x: 2 })]);
  });

  it('never touches other shapes, creates or appends', () => {
    const outbox: Op[] = [create, upd(2, { x: 1 }, 's-2')];
    enqueueCoalesced(outbox, upd(3, { x: 9, color: 'red' }));
    expect(outbox).toEqual([create, upd(2, { x: 1 }, 's-2'), upd(3, { x: 9, color: 'red' })]);
  });

  it('a peer receiving the coalesced outbox converges with the author, under interleaved remote writes', () => {
    // Randomized: the author makes many updates while a remote client writes the same props
    // with stamps that fall between the author's. The author applied every op locally; the peer
    // only gets the coalesced outbox. Both also get all the remote writes. They must match.
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const keys = ['x', 'y', 'color'] as const;
    for (let trial = 0; trial < 300; trial++) {
      const author = new Board();
      const peer = new Board();
      author.apply(create);
      peer.apply(create);
      const outbox: Op[] = [];
      const remote: UpdateOp[] = [];
      let t = 1;
      for (let i = 0; i < 12; i++) {
        t += 1 + Math.floor(rand() * 2);
        const props: Partial<ShapeProps> = {};
        for (const k of keys) if (rand() < 0.5) (props as Record<string, unknown>)[k] = k === 'color' ? `c${i}` : i;
        if (Object.keys(props).length === 0) props.x = i;
        const op = upd(t, props);
        author.apply(op);
        enqueueCoalesced(outbox, op);
        if (rand() < 0.5) remote.push(upd(t - 1, { [keys[Math.floor(rand() * 3)] as string]: -i }, 's-1', 'b'));
      }
      for (const op of [...outbox, ...remote]) peer.apply(op);
      for (const op of remote) author.apply(op);
      expect(peer.snapshot(), `trial ${trial}`).toEqual(author.snapshot());
    }
  });

  it('(why not merge under the newest stamp) a naive merge diverges', () => {
    const author = new Board();
    const peer = new Board();
    author.apply(create);
    peer.apply(create);
    const a = upd(5, { x: 1, y: 1 });
    const b = upd(7, { x: 2 });
    author.apply(a);
    author.apply(b);
    peer.apply(upd(7, { x: 2, y: 1 })); // naive: y re-sent under stamp 7
    const remote = upd(6, { y: 42 }, 's-1', 'b');
    author.apply(remote);
    peer.apply(remote);
    expect(author.get('s-1')?.y).toBe(42); // 6 beats the author's y@5
    expect(peer.get('s-1')?.y).toBe(1); // but loses to the peer's y@7
  });
});
