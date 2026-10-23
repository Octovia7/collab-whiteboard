import { describe, expect, it } from 'vitest';
import type { Op, Point } from '@whiteboard/shared';
import { Camera } from '../canvas/Camera';
import { BoardStore } from '../store/BoardStore';
import { Selection } from '../store/Selection';
import { ToolController } from './ToolController';

function setup(zoom = 1) {
  const store = new BoardStore('me');
  const selection = new Selection();
  const camera = new Camera();
  camera.zoom = zoom;
  let clock = 0;
  const tools = new ToolController(store, selection, camera, () => {}, () => clock);
  const batches: Op[][] = [];
  store.events.on('submit', (e) => batches.push(e.ops));
  const e = { pointerId: 1, shiftKey: false };
  /** A pen or eraser gesture through `path`, `msPerStep` apart. */
  const stroke = (path: Point[], msPerStep = 10) => {
    const [first, ...rest] = path;
    if (!first) return;
    tools.pointerDown(first, e);
    for (const p of rest) {
      clock += msPerStep;
      tools.pointerMove(p, e);
    }
    tools.pointerUp(path[path.length - 1] ?? first, e);
  };
  return { store, selection, camera, tools, batches, stroke, advance: (ms: number) => (clock += ms) };
}

const line = (from: Point, to: Point, n: number): Point[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }));

const kinds = (batches: Op[][]) => batches.map((b) => b.map((op) => op.kind).join('+'));

describe('pen', () => {
  it('pen down sends create + chunk 0 together; points stream in 50 ms chunks; pen up sends simplified points', () => {
    const t = setup();
    t.tools.setTool('pen');
    // 20 moves, 10 ms apart: chunks every 50 ms, then the pen-up update.
    t.stroke(line({ x: 100, y: 100 }, { x: 300, y: 100 }, 20));
    expect(kinds(t.batches)).toEqual(['create+append', 'append', 'append', 'append', 'append', 'update']);
    const [create, chunk0] = t.batches[0] as [Op, Op];
    expect(create).toMatchObject({ kind: 'create', shape: { type: 'stroke', x: 100, y: 100 } });
    expect(create.kind === 'create' && create.shape.points).toBeUndefined(); // only pen-up writes points
    expect(chunk0).toMatchObject({ kind: 'append', chunk: 0, points: [0, 0] });
    const chunks = t.batches.flat().filter((op) => op.kind === 'append').map((op) => (op.kind === 'append' ? op.chunk : -1));
    expect(chunks).toEqual([0, 1, 2, 3, 4]);
    // A straight line simplifies to its two ends, relative to the pen-down point.
    const id = create.kind === 'create' ? create.shape.id : '';
    expect(t.store.get(id)?.points).toEqual([0, 0, 200, 0]);
    expect(t.store.strokePoints(id)).toEqual([0, 0, 200, 0]);
    expect(t.tools.tool).toBe('pen'); // stays on the pen for the next stroke
  });

  it('before pen-up, peers draw the chunks in order; a curve keeps its shape after simplification', () => {
    const t = setup();
    t.tools.setTool('pen');
    const arc = Array.from({ length: 40 }, (_, i) => ({ x: 200 + Math.cos((i / 39) * Math.PI) * 100, y: 200 - Math.sin((i / 39) * Math.PI) * 100 }));
    const [first, ...rest] = arc;
    t.tools.pointerDown(first as Point, { pointerId: 1, shiftKey: false });
    for (const p of rest) {
      t.advance(20);
      t.tools.pointerMove(p, { pointerId: 1, shiftKey: false });
    }
    const id = (t.batches[0]?.[0] as Op & { kind: 'create' }).shape.id;
    const streamed = t.store.strokePoints(id);
    expect(streamed.length).toBeGreaterThan(20); // drawn from chunks while the pen is down
    t.tools.pointerUp(arc[arc.length - 1] as Point, { pointerId: 1, shiftKey: false });
    const final = t.store.strokePoints(id);
    expect(final.length).toBeLessThan(streamed.length);
    expect(final.length).toBeGreaterThan(6); // an arc is not a line
  });

  it('ignores sub-pixel jitter, and a click leaves a one-point dot', () => {
    const t = setup(4);
    t.tools.setTool('pen');
    t.stroke([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0.1 }]); // < 1 screen px at zoom 4
    const id = (t.batches[0]?.[0] as Op & { kind: 'create' }).shape.id;
    expect(t.store.strokePoints(id)).toEqual([0, 0]);
  });

  it('is disabled for viewers', () => {
    const t = setup();
    t.tools.setReadOnly(true);
    t.tools.setTool('pen');
    t.stroke(line({ x: 0, y: 0 }, { x: 50, y: 50 }, 5));
    expect(t.batches).toEqual([]);
  });
});

describe('eraser', () => {
  it('deletes every stroke it touches, once each, and leaves other shapes alone', () => {
    const t = setup();
    t.tools.setTool('pen');
    t.stroke(line({ x: 100, y: 0 }, { x: 100, y: 200 }, 10)); // vertical at x=100
    t.stroke(line({ x: 200, y: 0 }, { x: 200, y: 200 }, 10)); // vertical at x=200
    t.stroke(line({ x: 400, y: 0 }, { x: 400, y: 200 }, 10)); // out of reach
    t.tools.setTool('rect');
    t.stroke([{ x: 140, y: 50 }, { x: 160, y: 150 }]);
    const ids = t.store.visibleIn({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }).map((s) => s.id);
    t.batches.length = 0;

    t.tools.setTool('eraser');
    t.stroke([{ x: 50, y: 100 }, { x: 250, y: 100 }, { x: 50, y: 100 }]); // back and forth across both
    const deletes = t.batches.flat().filter((op) => op.kind === 'update' && op.props.deleted === true);
    expect(deletes).toHaveLength(2);
    const remaining = t.store.visibleIn({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }).map((s) => s.type);
    expect(remaining).toEqual(['stroke', 'rect']); // the far stroke and the rectangle survive
    expect(ids).toHaveLength(4);
  });

  it('catches strokes crossed by one fast move (sweeps between pointer events)', () => {
    const t = setup();
    t.tools.setTool('pen');
    t.stroke(line({ x: 500, y: 0 }, { x: 500, y: 200 }, 10));
    t.tools.setTool('eraser');
    t.stroke([{ x: 0, y: 100 }, { x: 1000, y: 100 }]); // a single 1000 px jump
    expect(t.store.visibleIn({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 })).toEqual([]);
  });
});
