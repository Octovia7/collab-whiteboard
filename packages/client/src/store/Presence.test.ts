import { describe, expect, it } from 'vitest';
import { smoothPath } from '../canvas/draw/stroke';
import { PEER_COLORS, Presence, colorFor } from './Presence';

const me = { peerId: 'p0', userId: 'u-me', name: 'Me' };
const ada = { peerId: 'p1', userId: 'u-ada', name: 'Ada' };
const adaTab2 = { peerId: 'p2', userId: 'u-ada', name: 'Ada' };
const bob = { peerId: 'p3', userId: 'u-bob', name: 'Bob' };

describe('Presence', () => {
  it('colors are stable per user and come from the palette', () => {
    expect(colorFor('u-ada')).toBe(colorFor('u-ada'));
    expect(PEER_COLORS).toContain(colorFor('u-ada'));
    const spread = new Set(Array.from({ length: 50 }, (_, i) => colorFor(`user-${i}`)));
    expect(spread.size).toBeGreaterThan(5);
  });

  it('online list: me first, one entry per person however many tabs, updated on join/leave', () => {
    const p = new Presence();
    let changes = 0;
    p.events.on('peers', () => changes++);
    p.reset(me, [ada, adaTab2]);
    expect(p.online().map((u) => [u.name, u.isYou])).toEqual([
      ['Me', true],
      ['Ada', false],
    ]);
    p.join(bob);
    expect(p.online().map((u) => u.name)).toEqual(['Me', 'Ada', 'Bob']);
    p.leave('p1');
    expect(p.online().map((u) => u.name)).toEqual(['Me', 'Ada', 'Bob']); // Ada's other tab is still here
    p.leave('p2');
    expect(p.online().map((u) => u.name)).toEqual(['Me', 'Bob']);
    expect(changes).toBe(4);
    const snapshot = p.online();
    p.cursor('p3', 1, 1);
    expect(p.online()).toBe(snapshot); // cursor moves never touch what React renders
  });

  it('cursors appear in place, then ease 30% per frame toward the target and settle', () => {
    const p = new Presence();
    p.reset(me, [ada]);
    p.cursor('p1', 100, 100);
    expect(p.visible()[0]?.cursor).toEqual({ x: 100, y: 100 }); // no fly-in from 0,0
    p.cursor('p1', 200, 100);
    expect(p.step()).toBe(true);
    expect(p.visible()[0]?.cursor?.x).toBeCloseTo(130);
    let frames = 1;
    while (p.step()) frames++;
    expect(p.visible()[0]?.cursor).toEqual({ x: 200, y: 100 });
    expect(frames).toBeLessThan(40);
  });

  it('hides a cursor idle for 30 s and ignores messages for unknown peers', () => {
    let now = 0;
    const p = new Presence(() => now);
    p.reset(me, [ada]);
    p.cursor('p1', 5, 5);
    now = 31_000;
    expect(p.visible()[0]?.cursor).toBeNull();
    p.cursor('ghost', 1, 1);
    p.select('ghost', ['x-1']);
    expect(p.list().map((x) => x.peerId)).toEqual(['p1']);
  });
});

describe('smoothPath', () => {
  it('moves to the first point, curves through midpoints with real points as controls, ends at the last', () => {
    const calls: string[] = [];
    const rec = {
      moveTo: (x: number, y: number) => calls.push(`M ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`L ${x} ${y}`),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => calls.push(`Q ${cx} ${cy} ${x} ${y}`),
    };
    smoothPath(rec, [0, 0, 10, 0, 10, 10, 0, 10], 100, 200);
    expect(calls).toEqual(['M 100 200', 'Q 110 200 110 205', 'Q 110 210 105 210', 'L 100 210']);
  });
});
