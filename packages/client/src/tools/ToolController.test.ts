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
  const key = (k: string) => tools.keyDown({ key: k, ctrlKey: false, metaKey: false, altKey: false });
  /** A full press-drag-release gesture in world coordinates. */
  const drag = (from: Point, ...to: Point[]) => {
    const e = { pointerId: 1, shiftKey: false };
    tools.pointerDown(from, e);
    for (const p of to) tools.pointerMove(p, e);
    tools.pointerUp(to[to.length - 1] ?? from, e);
  };
  const shiftClick = (p: Point) => {
    const e = { pointerId: 1, shiftKey: true };
    tools.pointerDown(p, e);
    tools.pointerUp(p, e);
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, selection, camera, tools, batches, key, drag, shiftClick, advance };
}

function drawRect(t: ReturnType<typeof setup>, from: Point, to: Point): string {
  t.tools.setTool('rect');
  t.drag(from, to);
  return t.selection.list()[0] as string;
}

describe('shape tools', () => {
  it('drag out a rectangle: created once, resized by updates, then selected with the select tool back', () => {
    const t = setup();
    t.tools.setTool('rect');
    t.drag({ x: 50, y: 50 }, { x: 70, y: 60 }, { x: 10, y: 20 });
    const id = t.selection.list()[0] as string;
    expect(t.store.get(id)).toMatchObject({ type: 'rect', x: 10, y: 20, w: 40, h: 30, color: '#1e1e1e' });
    expect(t.batches.map((b) => b.map((op) => op.kind))).toEqual([['create'], ['update']]);
    expect(t.tools.tool).toBe('select');
  });

  it('a click without a drag creates nothing', () => {
    const t = setup();
    t.tools.setTool('ellipse');
    t.drag({ x: 5, y: 5 }, { x: 6, y: 6 }); // under the 3 px threshold
    expect(t.store.size).toBe(0);
    expect(t.batches).toEqual([]);
  });

  it('the drag threshold is in screen pixels', () => {
    const t = setup(10);
    t.tools.setTool('rect');
    t.drag({ x: 0, y: 0 }, { x: 0.5, y: 0 }); // 5 screen px at zoom 10
    expect(t.store.size).toBe(1);
  });
});

describe('select tool', () => {
  it('click selects by outline; click on empty space clears', () => {
    const t = setup();
    const id = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 100 });
    t.selection.clear();
    t.drag({ x: 1, y: 50 });
    expect(t.selection.list()).toEqual([id]);
    t.drag({ x: 500, y: 500 });
    expect(t.selection.size).toBe(0);
  });

  it('drag moves the selection with absolute offsets from the drag start', () => {
    const t = setup();
    const a = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 100 });
    const b = drawRect(t, { x: 200, y: 0 }, { x: 300, y: 100 });
    t.shiftClick({ x: 1, y: 50 }); // add a; b is still selected
    expect(new Set(t.selection.list())).toEqual(new Set([a, b]));
    t.batches.length = 0;
    t.drag({ x: 1, y: 50 }, { x: 11, y: 55 }, { x: 31, y: 70 });
    expect(t.store.get(a)).toMatchObject({ x: 30, y: 20 });
    expect(t.store.get(b)).toMatchObject({ x: 230, y: 20 });
    // One batch per move, each covering both shapes.
    expect(t.batches.map((ops) => ops.length)).toEqual([2, 2]);
  });

  it('a selected unfilled box can be dragged from its middle', () => {
    const t = setup();
    const id = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 100 });
    t.drag({ x: 50, y: 50 }, { x: 60, y: 50 });
    expect(t.store.get(id)).toMatchObject({ x: 10, y: 0 });
  });

  it('a click (no drag) on a member of a multi-selection selects just it', () => {
    const t = setup();
    const a = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 100 });
    drawRect(t, { x: 200, y: 0 }, { x: 300, y: 100 });
    t.shiftClick({ x: 1, y: 50 });
    expect(t.selection.size).toBe(2);
    t.batches.length = 0;
    t.drag({ x: 1, y: 50 });
    expect(t.selection.list()).toEqual([a]);
    expect(t.batches).toEqual([]); // a click must not stamp any op
  });

  it('dragging a handle resizes, with the grab area in screen pixels', () => {
    const t = setup(2);
    const id = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 50 });
    // The se handle is at (100, 50); 1.5 world units = 3 screen px away at zoom 2: inside the 8 px square.
    t.drag({ x: 101.5, y: 51.5 }, { x: 150, y: 80 });
    expect(t.store.get(id)).toMatchObject({ x: 0, y: 0, w: 150, h: 80 });
  });

  it('box-select picks shapes fully inside; shift adds to the selection', () => {
    const t = setup();
    const a = drawRect(t, { x: 0, y: 0 }, { x: 50, y: 50 });
    const b = drawRect(t, { x: 100, y: 0 }, { x: 150, y: 50 });
    const c = drawRect(t, { x: 300, y: 0 }, { x: 350, y: 50 });
    t.selection.clear();
    t.drag({ x: -10, y: -10 }, { x: 160, y: 60 });
    expect(new Set(t.selection.list())).toEqual(new Set([a, b]));
    const e = { pointerId: 1, shiftKey: true };
    t.tools.pointerDown({ x: 290, y: -10 }, e);
    t.tools.pointerMove({ x: 400, y: 60 }, e);
    t.tools.pointerUp({ x: 400, y: 60 }, e);
    expect(new Set(t.selection.list())).toEqual(new Set([a, b, c]));
  });
});

describe('selection actions', () => {
  it('Delete turns the selection into tombstones in one batch', () => {
    const t = setup();
    const a = drawRect(t, { x: 0, y: 0 }, { x: 50, y: 50 });
    t.batches.length = 0;
    expect(t.key('Delete')).toBe(true);
    expect(t.store.isVisible(a)).toBe(false);
    expect(t.store.get(a)).toBeDefined(); // still in the map
    expect(t.batches).toEqual([[expect.objectContaining({ kind: 'update', props: { deleted: true } })]]);
    expect(t.selection.size).toBe(0);
  });

  it('recolor applies to the selection and to new shapes', () => {
    const t = setup();
    const a = drawRect(t, { x: 0, y: 0 }, { x: 50, y: 50 });
    t.tools.setColor('#e03131');
    expect(t.store.get(a)?.color).toBe('#e03131');
    t.selection.clear();
    const b = drawRect(t, { x: 100, y: 0 }, { x: 150, y: 50 });
    expect(t.store.get(b)?.color).toBe('#e03131');
  });

  it('bring to front / send to back change only the moved shapes, keeping their order', () => {
    const t = setup();
    const ids = [0, 1, 2, 3].map((i) => drawRect(t, { x: i * 10, y: 0 }, { x: i * 10 + 5, y: 5 }));
    const order = () => t.store.visibleIn({ minX: -1e3, minY: -1e3, maxX: 1e3, maxY: 1e3 }).map((s) => s.id);
    t.selection.set([ids[0] as string, ids[1] as string]);
    t.batches.length = 0;
    t.key(']');
    expect(order()).toEqual([ids[2], ids[3], ids[0], ids[1]]);
    expect(t.batches[0]?.map((op) => (op.kind === 'update' ? Object.keys(op.props) : []))).toEqual([['z'], ['z']]);
    t.selection.set([ids[3] as string]);
    t.key('[');
    expect(order()).toEqual([ids[3], ids[2], ids[0], ids[1]]);
  });

  it('tool shortcuts and Escape', () => {
    const t = setup();
    t.key('r');
    expect(t.tools.tool).toBe('rect');
    t.key('Escape');
    expect(t.tools.tool).toBe('select');
    expect(t.tools.keyDown({ key: 'r', ctrlKey: true, metaKey: false, altKey: false })).toBe(false); // leave Ctrl+R to the browser
  });
});

describe('read-only (viewer) mode', () => {
  it('ignores pointer input, tool switches, colors and edit shortcuts', () => {
    const t = setup();
    const id = drawRect(t, { x: 0, y: 0 }, { x: 100, y: 100 });
    t.tools.setReadOnly(true);
    expect(t.selection.size).toBe(0); // entering read-only clears the selection
    t.batches.length = 0;

    t.drag({ x: 1, y: 50 }, { x: 60, y: 80 }); // would select and move
    expect(t.selection.size).toBe(0);
    for (const k of ['r', 'o', 'a', 'Delete', ']', '[']) expect(t.key(k)).toBe(false);
    t.tools.setTool('rect');
    t.tools.setColor('#e03131');
    t.tools.deleteSelection();
    t.tools.bringToFront();
    expect(t.tools.tool).toBe('select');
    expect(t.batches).toEqual([]); // not a single op left the tools
    expect(t.store.get(id)).toMatchObject({ x: 0, y: 0, color: '#1e1e1e' });
  });

  it('cancels a gesture in progress when the role drops mid-drag, and switches back live', () => {
    const t = setup();
    t.tools.setTool('rect');
    const e = { pointerId: 1, shiftKey: false };
    t.tools.pointerDown({ x: 0, y: 0 }, e);
    t.tools.pointerMove({ x: 50, y: 50 }, e);
    const created = t.batches.length;
    t.tools.setReadOnly(true);
    t.tools.pointerMove({ x: 90, y: 90 }, e);
    t.tools.pointerUp({ x: 90, y: 90 }, e);
    expect(t.batches.length).toBe(created); // no further updates after the switch
    expect(t.tools.tool).toBe('select');

    t.tools.setReadOnly(false);
    const id = drawRect(t, { x: 200, y: 0 }, { x: 260, y: 60 });
    expect(t.store.get(id)).toBeDefined();
  });
});
