import { describe, expect, it } from 'vitest';
import { keyBetween } from '@whiteboard/shared';
import type { UpdateOp } from '@whiteboard/shared';
import { BoardStore } from './BoardStore';

const everywhere = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
const base = { type: 'rect' as const, w: 10, h: 10, color: 'black' };

describe('BoardStore', () => {
  it('creates shapes with clientId-counter ids, rising stamps, each on top of the last', () => {
    const s = new BoardStore('me');
    const a = s.create({ ...base, x: 0, y: 0 });
    const b = s.create({ ...base, x: 5, y: 5 });
    expect([a.shape.id, b.shape.id]).toEqual(['me-1', 'me-2']);
    expect(b.stamp.t).toBeGreaterThan(a.stamp.t);
    expect(a.shape.z < b.shape.z).toBe(true);
    expect(s.visibleIn(everywhere).map((x) => x.id)).toEqual(['me-1', 'me-2']);
  });

  it('a remote op pushes the clock forward, so the next local edit is later', () => {
    const s = new BoardStore('me');
    const { shape } = s.create({ ...base, x: 0, y: 0 });
    const remote: UpdateOp = { kind: 'update', opId: 'peer:1', stamp: { t: 50, client: 'peer' }, id: shape.id, props: { x: 9 } };
    s.apply(remote, 'remote');
    const mine = s.update(shape.id, { x: 1 });
    expect(mine.stamp.t).toBe(51);
    expect(s.get(shape.id)?.x).toBe(1);
  });

  it('visibleIn skips tombstones and shapes outside the box, with a margin for line width', () => {
    const s = new BoardStore('me');
    const near = s.create({ ...base, x: 0, y: 0 });
    const far = s.create({ ...base, x: 5000, y: 5000 });
    const edge = s.create({ ...base, x: 110, y: 0 }); // 10 units outside, inside the margin
    const gone = s.create({ ...base, x: 20, y: 20 });
    s.update(gone.shape.id, { deleted: true });
    const ids = s.visibleIn({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).map((x) => x.id);
    expect(ids).toEqual([near.shape.id, edge.shape.id]);
    expect(ids).not.toContain(far.shape.id);
  });

  it('draw order follows z after a reorder, with id breaking ties', () => {
    const s = new BoardStore('me');
    const a = s.create({ ...base, x: 0, y: 0 });
    const b = s.create({ ...base, x: 0, y: 0 });
    const c = s.create({ ...base, x: 0, y: 0, z: b.shape.z }); // same z as b
    s.update(a.shape.id, { z: keyBetween(s.topZ(), '') }); // bring a to front
    expect(s.visibleIn(everywhere).map((x) => x.id)).toEqual([b.shape.id, c.shape.id, a.shape.id]);
  });

  it('emits change for applied ops, not for ones still waiting for their create', () => {
    const s = new BoardStore('me');
    const seen: string[] = [];
    s.events.on('change', (e) => seen.push(`${e.origin}:${e.id}`));
    const early: UpdateOp = { kind: 'update', opId: 'p:2', stamp: { t: 2, client: 'p' }, id: 'p-1', props: { x: 3 } };
    s.apply(early, 'remote');
    expect(seen).toEqual([]);
    s.apply({ kind: 'create', opId: 'p:1', stamp: { t: 1, client: 'p' }, shape: { ...base, id: 'p-1', x: 0, y: 0, z: 'i' } }, 'remote');
    s.create({ ...base, x: 0, y: 0 });
    expect(seen).toEqual(['remote:p-1', 'local:me-1']);
    expect(s.get('p-1')?.x).toBe(3);
  });
});
