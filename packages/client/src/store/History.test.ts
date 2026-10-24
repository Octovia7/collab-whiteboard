import { describe, expect, it } from 'vitest';
import type { Op, Point, ShapeProps } from '@whiteboard/shared';
import { Camera } from '../canvas/Camera';
import { ToolController } from '../tools/ToolController';
import { BoardStore } from './BoardStore';
import { History } from './History';
import { Selection } from './Selection';

function setup() {
  const store = new BoardStore('me');
  const history = new History(store);
  const selection = new Selection();
  const tools = new ToolController(store, selection, new Camera(), () => {}, () => 0, history);
  const sent: Op[][] = [];
  store.events.on('submit', (e) => sent.push(e.ops));
  const e = { pointerId: 1, shiftKey: false };
  const drag = (from: Point, ...to: Point[]) => {
    tools.pointerDown(from, e);
    for (const p of to) tools.pointerMove(p, e);
    tools.pointerUp(to[to.length - 1] ?? from, e);
  };
  const drawRect = (from: Point, to: Point) => {
    tools.setTool('rect');
    drag(from, to);
    return selection.list()[0] as string;
  };
  let remoteT = 1000;
  /** An edit by someone else, arriving over the network. */
  const remote = (id: string, props: Partial<ShapeProps>) =>
    store.receive([{ kind: 'update', opId: `peer:${remoteT}`, stamp: { t: ++remoteT, client: 'peer' }, id, props }]);
  const key = (k: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
    tools.keyDown({ key: k, ctrlKey: mods.ctrl ?? false, metaKey: false, altKey: false, shiftKey: mods.shift ?? false });
  return { store, history, selection, tools, sent, drag, drawRect, remote, key };
}

describe('undo/redo', () => {
  it('undoing a create deletes the shape; redo brings it back', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.key('z', { ctrl: true });
    expect(t.store.isVisible(id)).toBe(false);
    t.key('z', { ctrl: true, shift: true });
    expect(t.store.isVisible(id)).toBe(true);
    t.key('z', { ctrl: true });
    t.key('y', { ctrl: true });
    expect(t.store.isVisible(id)).toBe(true);
  });

  it('one drag is one undo step, back to where it started', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.tools.setTool('select');
    t.drag({ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 80, y: 70 }, { x: 150, y: 120 });
    expect(t.store.get(id)).toMatchObject({ x: 100, y: 70 });
    t.tools.undo();
    expect(t.store.get(id)).toMatchObject({ x: 0, y: 0 });
    expect(t.store.isVisible(id)).toBe(true); // the create is a separate, earlier step
    t.tools.redo();
    expect(t.store.get(id)).toMatchObject({ x: 100, y: 70 });
  });

  it('undo sends ordinary updates with fresh stamps, so they sync like any edit', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.tools.setColor('#e03131');
    const before = t.store.clock.now;
    t.sent.length = 0;
    t.tools.undo();
    expect(t.sent).toEqual([[expect.objectContaining({ kind: 'update', id, props: { color: '#1e1e1e' } })]]);
    const op = t.sent[0]?.[0];
    expect(op?.stamp.t).toBeGreaterThan(before);
  });

  it('skips properties someone else changed after us, but undoes the rest of the step', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    // My step: move and resize via handle -> x, y, w, h all mine.
    t.tools.setTool('select');
    t.drag({ x: 100, y: 100 }, { x: 150, y: 160 }); // se handle: w/h
    t.drag({ x: 50, y: 50 }, { x: 70, y: 50 }); // move: x/y
    // Then a collaborator moves it horizontally.
    t.remote(id, { x: 500 });
    t.tools.undo(); // undo my move
    expect(t.store.get(id)?.x).toBe(500); // theirs: kept
    expect(t.store.get(id)?.y).toBe(0); // mine: undone
    t.tools.undo(); // undo my resize
    expect(t.store.get(id)).toMatchObject({ w: 100, h: 100 });
  });

  it('undoing a delete restores the shape', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.key('Delete');
    expect(t.store.isVisible(id)).toBe(false);
    t.tools.undo();
    expect(t.store.isVisible(id)).toBe(true);
  });

  it('only my own edits are on my stack', () => {
    const t = setup();
    const mine = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.store.receive([{ kind: 'create', opId: 'peer:1', stamp: { t: 900, client: 'peer' }, shape: { id: 'peer-1', type: 'rect', x: 0, y: 0, w: 5, h: 5, color: 'b', z: 'i9' } }]);
    t.tools.undo();
    expect(t.store.isVisible(mine)).toBe(false);
    t.tools.undo(); // nothing left: the peer's shape is untouched
    expect(t.store.isVisible('peer-1')).toBe(true);
    expect(t.history.canUndo).toBe(false);
  });

  it('a new action clears redo; an empty click records nothing', () => {
    const t = setup();
    t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.tools.undo();
    expect(t.history.canRedo).toBe(true);
    t.drawRect({ x: 200, y: 0 }, { x: 300, y: 100 });
    expect(t.history.canRedo).toBe(false);
    t.tools.setTool('select');
    const steps = t.sent.length;
    t.drag({ x: 900, y: 900 }); // click on empty space
    t.tools.undo();
    // The undo hit the second rectangle, not a phantom empty step.
    expect(t.sent.length).toBe(steps + 1);
  });

  it('when every property of a step was overwritten by others, undo moves on to the next step', () => {
    const t = setup();
    const id = t.drawRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    t.tools.setColor('#e03131');
    t.remote(id, { color: '#2f9e44' });
    t.tools.undo(); // the recolor is theirs now -> skipped; undoes the create instead
    expect(t.store.get(id)?.color).toBe('#2f9e44');
    expect(t.store.isVisible(id)).toBe(false);
  });

  it('is capped at 100 steps', () => {
    const t = setup();
    for (let i = 0; i < 120; i++) t.drawRect({ x: i * 10, y: 0 }, { x: i * 10 + 5, y: 5 });
    let undone = 0;
    while (t.history.canUndo) {
      t.tools.undo();
      undone++;
    }
    expect(undone).toBe(100);
  });
});
