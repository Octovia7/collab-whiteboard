import { describe, expect, it } from 'vitest';
import { compareDrawOrder, keyBetween } from '@whiteboard/shared';
import type { Op, ShapeProps, UpdateOp } from '@whiteboard/shared';
import { BoardStore } from './BoardStore';

const everywhere = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
const base = { type: 'rect' as const, w: 10, h: 10, color: 'black' };

function add(s: BoardStore, props: Omit<ShapeProps, 'z'> & { z?: string }): string {
  const op = s.makeCreate(props);
  s.submit([op]);
  return op.shape.id;
}

const visibleIds = (s: BoardStore) => s.visibleIn(everywhere).map((x) => x.id);

describe('BoardStore: writes', () => {
  it('creates shapes with clientId-counter ids, rising stamps, each on top of the last', () => {
    const s = new BoardStore('me');
    const a = s.makeCreate({ ...base, x: 0, y: 0 });
    s.submit([a]);
    const b = s.makeCreate({ ...base, x: 5, y: 5 });
    s.submit([b]);
    expect([a.shape.id, b.shape.id]).toEqual(['me-1', 'me-2']);
    expect(b.stamp.t).toBeGreaterThan(a.stamp.t);
    expect(a.shape.z < b.shape.z).toBe(true);
    expect(visibleIds(s)).toEqual(['me-1', 'me-2']);
  });

  it('submit is the one local path: it applies the batch and announces it', () => {
    const s = new BoardStore('me');
    const batches: Op[][] = [];
    s.events.on('submit', (e) => batches.push(e.ops));
    const id = add(s, { ...base, x: 0, y: 0 });
    const move = s.makeUpdate(id, { x: 7 });
    s.submit([move]);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([move]);
    expect(s.get(id)?.x).toBe(7);
  });

  it('receive pushes the clock forward, so the next local edit is later', () => {
    const s = new BoardStore('me');
    const id = add(s, { ...base, x: 0, y: 0 });
    const remote: UpdateOp = { kind: 'update', opId: 'peer:1', stamp: { t: 50, client: 'peer' }, id, props: { x: 9 } };
    let submits = 0;
    s.events.on('submit', () => submits++);
    s.receive([remote]);
    expect(submits).toBe(0); // remote ops are never re-announced as local edits
    const mine = s.makeUpdate(id, { x: 1 });
    expect(mine.stamp.t).toBe(51);
    s.submit([mine]);
    expect(s.get(id)?.x).toBe(1);
  });

  it('emits one change per batch, and none for ops still waiting for their create', () => {
    const s = new BoardStore('me');
    const seen: string[] = [];
    s.events.on('change', (e) => seen.push(`${e.origin}:${e.ids.join(',')}`));
    const early: UpdateOp = { kind: 'update', opId: 'p:2', stamp: { t: 2, client: 'p' }, id: 'p-1', props: { x: 3 } };
    s.receive([early]);
    expect(seen).toEqual([]);
    s.receive([{ kind: 'create', opId: 'p:1', stamp: { t: 1, client: 'p' }, shape: { ...base, id: 'p-1', x: 0, y: 0, z: 'i0' } }]);
    const a = s.makeCreate({ ...base, x: 0, y: 0 });
    const b = s.makeCreate({ ...base, x: 0, y: 0 });
    s.submit([a, b]);
    expect(seen).toEqual(['remote:p-1', `local:${a.shape.id},${b.shape.id}`]);
    expect(s.get('p-1')?.x).toBe(3);
  });
});

describe('BoardStore: spatial index', () => {
  it('visibleIn skips tombstones and far shapes, with a margin for line width', () => {
    const s = new BoardStore('me');
    const near = add(s, { ...base, x: 0, y: 0 });
    add(s, { ...base, x: 5000, y: 5000 });
    const edge = add(s, { ...base, x: 110, y: 0 }); // 10 units outside, inside the margin
    const gone = add(s, { ...base, x: 20, y: 20 });
    s.submit([s.makeUpdate(gone, { deleted: true })]);
    expect(s.visibleIn({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).map((x) => x.id)).toEqual([near, edge]);
  });

  it('follows moves, deletes and undeletes (local and remote)', () => {
    const s = new BoardStore('me');
    const id = add(s, { ...base, x: 0, y: 0 });
    const far = { minX: 9000, minY: 9000, maxX: 9100, maxY: 9100 };
    s.submit([s.makeUpdate(id, { x: 9050, y: 9050 })]);
    expect(s.visibleIn(far).map((x) => x.id)).toEqual([id]);
    s.receive([{ kind: 'update', opId: 'p:1', stamp: { t: 100, client: 'p' }, id, props: { deleted: true } }]);
    expect(s.visibleIn(far)).toEqual([]);
    expect(s.hitTest({ x: 9050, y: 9055 }, 3)).toBeNull();
    s.submit([s.makeUpdate(id, { deleted: false })]);
    expect(s.visibleIn(far).map((x) => x.id)).toEqual([id]);
  });

  it('hitTest returns the topmost shape whose outline is under the point', () => {
    const s = new BoardStore('me');
    const below = add(s, { ...base, x: 0, y: 0, w: 100, h: 100 });
    const above = add(s, { ...base, x: 0, y: 0, w: 100, h: 50 });
    expect(s.hitTest({ x: 1, y: 25 }, 3)).toBe(above); // both left edges are here; above wins
    expect(s.hitTest({ x: 50, y: 99 }, 3)).toBe(below); // only the lower box's bottom edge
    expect(s.hitTest({ x: 50, y: 75 }, 3)).toBeNull(); // inside, but unfilled
  });

  it('insideBox selects only shapes fully inside', () => {
    const s = new BoardStore('me');
    const inside = add(s, { ...base, x: 10, y: 10 });
    add(s, { ...base, x: 95, y: 10 }); // pokes out to x = 105
    expect(s.insideBox({ minX: 0, minY: 0, maxX: 100, maxY: 100 })).toEqual([inside]);
  });

  it('measures strokes from their relative points, so moving x/y moves the whole stroke', () => {
    const s = new BoardStore('me');
    const op = s.makeCreate({ type: 'stroke', x: 100, y: 100, w: 0, h: 0, color: 'black' });
    s.submit([op, { kind: 'append', opId: 'me:x', stamp: s.clock.tick(), id: op.shape.id, chunk: 0, points: [0, 0, 40, 30] }]);
    expect(s.boundsOf(op.shape.id)).toEqual({ minX: 100, minY: 100, maxX: 140, maxY: 130 });
    expect(s.hitTest({ x: 120, y: 115 }, 2)).toBe(op.shape.id);
    s.submit([s.makeUpdate(op.shape.id, { x: 500 })]);
    expect(s.hitTest({ x: 520, y: 115 }, 2)).toBe(op.shape.id);
    expect(s.hitTest({ x: 120, y: 115 }, 2)).toBeNull();
  });
});

describe('BoardStore: z order', () => {
  it('draw order follows z after a reorder, with id breaking ties', () => {
    const s = new BoardStore('me');
    const a = add(s, { ...base, x: 0, y: 0 });
    const bOp = s.makeCreate({ ...base, x: 0, y: 0 });
    s.submit([bOp]);
    const c = add(s, { ...base, x: 0, y: 0, z: bOp.shape.z }); // same z as b
    s.submit([s.makeUpdate(a, { z: keyBetween(s.topZ(), '') })]); // bring a to front
    expect(visibleIds(s)).toEqual([bOp.shape.id, c, a]);
  });

  it('topZ/bottomZ stay correct through creates and reorders (vs brute force)', () => {
    const s = new BoardStore('me');
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(add(s, { ...base, x: i, y: 0 }));
    const brute = () => {
      const all = ids.map((id) => ({ id, z: s.get(id)?.z ?? '' })).sort(compareDrawOrder);
      return [all[0]?.z, all[all.length - 1]?.z];
    };
    // Deterministic shuffle of reorders, including moving the current top and bottom inward.
    for (let i = 0; i < 60; i++) {
      const id = ids[(i * 7) % ids.length] as string;
      const z = i % 3 === 0 ? keyBetween(s.topZ(), '') : i % 3 === 1 ? keyBetween('', s.bottomZ()) : keyBetween(s.bottomZ(), s.topZ());
      s.submit([s.makeUpdate(id, { z })]);
      expect([s.bottomZ(), s.topZ()]).toEqual(brute());
    }
  });
});
