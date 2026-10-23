import { describe, expect, it } from 'vitest';
import { Board } from './board';
import type { AppendOp, CreateOp, Shape, ShapeProps, Stamp, UpdateOp } from './types';

const st = (t: number, client: string): Stamp => ({ t, client });

function rect(id: string, extra: Partial<Shape> = {}): Shape {
  return { id, type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'black', z: 'i', ...extra };
}

let opCounter = 0;
const create = (shape: Shape, stamp: Stamp): CreateOp => ({ kind: 'create', opId: `op${++opCounter}`, stamp, shape });
const update = (id: string, props: Partial<ShapeProps>, stamp: Stamp): UpdateOp => ({
  kind: 'update',
  opId: `op${++opCounter}`,
  stamp,
  id,
  props,
});
const append = (id: string, chunk: number, points: number[], stamp: Stamp): AppendOp => ({
  kind: 'append',
  opId: `op${++opCounter}`,
  stamp,
  id,
  chunk,
  points,
});

describe('Board: LWW registers', () => {
  it('the later stamp wins whatever the arrival order (algorithms.md §3 example)', () => {
    const c = create(rect('s-1'), st(1, 'priya'));
    const a = update('s-1', { x: 300 }, st(5, 'rudraksh'));
    const b = update('s-1', { x: 500 }, st(5, 'priya'));

    const one = new Board();
    [c, a, b].forEach((op) => one.apply(op));
    const two = new Board();
    [c, b, a].forEach((op) => two.apply(op));

    expect(one.get('s-1')?.x).toBe(300);
    expect(two.get('s-1')?.x).toBe(300);
    expect(one.snapshot()).toEqual(two.snapshot());
  });

  it('updates to different properties both apply', () => {
    const b = new Board();
    b.apply(create(rect('s-1'), st(1, 'a')));
    b.apply(update('s-1', { x: 101, y: 50 }, st(2, 'a')));
    b.apply(update('s-1', { color: 'red' }, st(2, 'b')));
    expect(b.get('s-1')).toMatchObject({ x: 101, y: 50, color: 'red' });
  });

  it('ignores an older update', () => {
    const b = new Board();
    b.apply(create(rect('s-1'), st(1, 'a')));
    b.apply(update('s-1', { x: 9 }, st(5, 'a')));
    b.apply(update('s-1', { x: 1 }, st(3, 'b')));
    expect(b.get('s-1')?.x).toBe(9);
  });

  it('is idempotent: applying an op twice changes nothing', () => {
    const b = new Board();
    const ops = [create(rect('s-1'), st(1, 'a')), update('s-1', { x: 7 }, st(2, 'a'))];
    ops.forEach((op) => b.apply(op));
    const before = b.snapshot();
    ops.forEach((op) => b.apply(op));
    expect(b.snapshot()).toEqual(before);
  });

  it('a duplicate create does not reset newer values', () => {
    const b = new Board();
    const c = create(rect('s-1', { x: 0 }), st(1, 'a'));
    b.apply(c);
    b.apply(update('s-1', { x: 50 }, st(2, 'b')));
    b.apply(c);
    expect(b.get('s-1')?.x).toBe(50);
  });

  it('treats undefined props as absent (JSON drops them)', () => {
    const b = new Board();
    b.apply(create(rect('s-1', { text: 'hi' }), st(1, 'a')));
    b.apply(update('s-1', { text: undefined }, st(2, 'a')));
    expect(b.get('s-1')?.text).toBe('hi');
  });
});

describe('Board: tombstones', () => {
  it('delete hides the shape but keeps it in the map', () => {
    const b = new Board();
    b.apply(create(rect('s-1'), st(1, 'a')));
    b.apply(update('s-1', { deleted: true }, st(2, 'a')));
    expect(b.has('s-1')).toBe(true);
    expect(b.isVisible('s-1')).toBe(false);
  });

  it('keeps applying updates to deleted shapes, so an edit racing a delete converges', () => {
    const c = create(rect('s-1', { x: 0 }), st(1, 'a'));
    const del = update('s-1', { deleted: true }, st(2, 'priya'));
    const move = update('s-1', { x: 80 }, st(2, 'rudraksh'));

    const one = new Board();
    [c, del, move].forEach((op) => one.apply(op));
    const two = new Board();
    [c, move, del].forEach((op) => two.apply(op));

    expect(one.snapshot()).toEqual(two.snapshot());
    expect(one.isVisible('s-1')).toBe(false);
    expect(one.get('s-1')?.x).toBe(80);
  });

  it('undo of a delete restores the shape with a newer deleted:false', () => {
    const b = new Board();
    b.apply(create(rect('s-1'), st(1, 'a')));
    b.apply(update('s-1', { deleted: true }, st(2, 'a')));
    b.apply(update('s-1', { deleted: false }, st(3, 'a')));
    expect(b.isVisible('s-1')).toBe(true);
  });
});

describe('Board: ops before their create', () => {
  it('buffers updates and applies them when the create arrives', () => {
    const b = new Board();
    expect(b.apply(update('s-1', { x: 42 }, st(2, 'a')))).toBe(false);
    expect(b.has('s-1')).toBe(false);
    expect(b.bufferedCount).toBe(1);
    b.apply(create(rect('s-1', { x: 0 }), st(1, 'a')));
    expect(b.bufferedCount).toBe(0);
    expect(b.get('s-1')?.x).toBe(42);
  });

  it('buffers appends the same way', () => {
    const b = new Board();
    b.apply(append('k-1', 1, [3, 3], st(3, 'a')));
    b.apply(append('k-1', 0, [1, 1, 2, 2], st(2, 'a')));
    expect(b.bufferedCount).toBe(2);
    b.apply(create({ ...rect('k-1'), type: 'stroke' }, st(1, 'a')));
    expect(b.strokePoints('k-1')).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('caps the buffer, dropping the oldest op and reporting it', () => {
    const dropped: string[] = [];
    const b = new Board({ maxBuffered: 3, onBufferOverflow: (op) => dropped.push(op.opId) });
    const ops = [
      update('s-1', { x: 1 }, st(1, 'a')),
      update('s-2', { x: 2 }, st(2, 'a')),
      update('s-1', { x: 3 }, st(3, 'a')),
      update('s-2', { x: 4 }, st(4, 'a')),
      update('s-3', { x: 5 }, st(5, 'a')),
    ];
    ops.forEach((op) => b.apply(op));
    expect(b.bufferedCount).toBe(3);
    // Oldest overall goes first, even though s-1 still has a newer op waiting.
    expect(dropped).toEqual([ops[0]?.opId, ops[1]?.opId]);
    b.apply(create(rect('s-1', { x: 0 }), st(1, 'b')));
    expect(b.get('s-1')?.x).toBe(3);
    expect(b.bufferedCount).toBe(2);
  });

  it('loading a fresh snapshot clears the buffer', () => {
    const source = new Board();
    source.apply(create(rect('s-1'), st(1, 'a')));
    const b = new Board();
    b.apply(update('ghost-1', { x: 1 }, st(2, 'a')));
    expect(b.bufferedCount).toBe(1);
    b.loadSnapshot(source.snapshot());
    expect(b.bufferedCount).toBe(0);
    expect(b.ids()).toEqual(['s-1']);
    // The cleared op must not resurface if its create arrives later.
    b.apply(create(rect('ghost-1', { x: 0 }), st(1, 'a')));
    expect(b.get('ghost-1')?.x).toBe(0);
  });

  it('a buffered stale update still loses to the create', () => {
    const b = new Board();
    b.apply(update('s-1', { x: 1 }, st(1, 'a')));
    b.apply(create(rect('s-1', { x: 5 }), st(2, 'b')));
    expect(b.get('s-1')?.x).toBe(5);
  });
});

describe('Board: stroke chunks', () => {
  const stroke = (): CreateOp => create({ ...rect('k-1'), type: 'stroke' }, st(1, 'a'));

  it('concatenates chunks in chunk-number order, whatever the arrival order', () => {
    const b = new Board();
    b.apply(stroke());
    b.apply(append('k-1', 2, [5, 5], st(4, 'a')));
    b.apply(append('k-1', 0, [1, 1], st(2, 'a')));
    b.apply(append('k-1', 1, [3, 3], st(3, 'a')));
    expect(b.strokePoints('k-1')).toEqual([1, 1, 3, 3, 5, 5]);
  });

  it('a duplicate chunk changes nothing', () => {
    const b = new Board();
    b.apply(stroke());
    const a0 = append('k-1', 0, [1, 1], st(2, 'a'));
    b.apply(a0);
    const before = b.snapshot();
    b.apply(a0);
    expect(b.snapshot()).toEqual(before);
  });

  it('draws the pen-up points once set, even if chunks arrive later', () => {
    const b = new Board();
    b.apply(stroke());
    b.apply(append('k-1', 0, [0, 0, 1, 1], st(2, 'a')));
    b.apply(update('k-1', { points: [0, 0, 9, 9] }, st(4, 'a')));
    b.apply(append('k-1', 1, [2, 2], st(3, 'a')));
    expect(b.strokePoints('k-1')).toEqual([0, 0, 9, 9]);
  });

  it('two different writes to one chunk resolve deterministically by stamp', () => {
    const x = append('k-1', 0, [1, 1], st(2, 'a'));
    const y = append('k-1', 0, [7, 7], st(3, 'a'));
    const one = new Board();
    [stroke(), x, y].forEach((op) => one.apply(op));
    const two = new Board();
    [stroke(), y, x].forEach((op) => two.apply(op));
    expect(one.strokePoints('k-1')).toEqual([7, 7]);
    expect(one.snapshot()).toEqual(two.snapshot());
  });
});

describe('Board: snapshots', () => {
  it('round-trips through JSON', () => {
    const b = new Board();
    b.apply(create(rect('s-2'), st(1, 'a')));
    b.apply(create({ ...rect('k-1'), type: 'stroke' }, st(2, 'b')));
    b.apply(append('k-1', 0, [1, 2], st(3, 'b')));
    b.apply(update('s-2', { deleted: true }, st(4, 'a')));

    const json = JSON.parse(JSON.stringify(b.snapshot()));
    const copy = Board.fromSnapshot(json);
    expect(copy.snapshot()).toEqual(b.snapshot());
    expect(copy.isVisible('s-2')).toBe(false);
    expect(copy.strokePoints('k-1')).toEqual([1, 2]);
  });

  it('is canonical: insertion order does not matter', () => {
    const one = new Board();
    one.apply(create(rect('s-1'), st(1, 'a')));
    one.apply(create(rect('s-2'), st(1, 'b')));
    const two = new Board();
    two.apply(create(rect('s-2'), st(1, 'b')));
    two.apply(create(rect('s-1'), st(1, 'a')));
    expect(JSON.stringify(one.snapshot())).toBe(JSON.stringify(two.snapshot()));
  });
});
