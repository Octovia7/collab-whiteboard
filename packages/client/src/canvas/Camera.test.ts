import { describe, expect, it } from 'vitest';
import { Camera, MAX_ZOOM, MIN_ZOOM } from './Camera';

function cam(x: number, y: number, zoom: number): Camera {
  const c = new Camera();
  c.x = x;
  c.y = y;
  c.zoom = zoom;
  return c;
}

describe('Camera', () => {
  it('toWorld and toScreen are inverses', () => {
    const c = cam(120, -45, 2.5);
    const w = c.toWorld(300, 200);
    expect(w).toEqual({ x: 300 / 2.5 + 120, y: 200 / 2.5 - 45 });
    const s = c.toScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(300);
    expect(s.y).toBeCloseTo(200);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    for (const [x, y, zoom, sx, sy, factor] of [
      [0, 0, 1, 400, 300, 1.25],
      [-500, 220, 0.3, 17, 640, 3],
      [10, 10, 4, 0, 0, 0.5],
    ] as const) {
      const c = cam(x, y, zoom);
      const before = c.toWorld(sx, sy);
      c.zoomAt(sx, sy, factor);
      const after = c.toWorld(sx, sy);
      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.y).toBeCloseTo(before.y, 9);
      expect(c.zoom).toBeCloseTo(zoom * factor);
    }
  });

  it('clamps zoom and still keeps the anchor fixed at the limit', () => {
    const c = cam(0, 0, 1);
    const before = c.toWorld(200, 100);
    c.zoomAt(200, 100, 1000);
    expect(c.zoom).toBe(MAX_ZOOM);
    const after = c.toWorld(200, 100);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    c.zoomAt(200, 100, 1e-9);
    expect(c.zoom).toBe(MIN_ZOOM);
  });

  it('panBy moves the board with the pointer, scaled by zoom', () => {
    const c = cam(0, 0, 2);
    const grabbed = c.toWorld(100, 100);
    c.panBy(50, -20);
    // The world point that was under (100, 100) is now under (150, 80).
    const s = c.toScreen(grabbed.x, grabbed.y);
    expect(s).toEqual({ x: 150, y: 80 });
    expect(c.x).toBe(-25);
    expect(c.y).toBe(10);
  });

  it('viewport is the world rectangle on screen', () => {
    expect(cam(100, 50, 2).viewport(800, 600)).toEqual({ minX: 100, minY: 50, maxX: 500, maxY: 350 });
  });

  it('transform maps world to device pixels (algorithms.md §10 formula)', () => {
    const c = cam(30, -10, 1.5);
    const dpr = 2;
    const [a, b, cc, d, e, f] = c.transform(dpr);
    expect([b, cc]).toEqual([0, 0]);
    const wx = 77;
    const wy = 12;
    const screen = c.toScreen(wx, wy);
    expect(a * wx + e).toBeCloseTo(screen.x * dpr);
    expect(d * wy + f).toBeCloseTo(screen.y * dpr);
  });

  it('emits change on pan and zoom', () => {
    const c = new Camera();
    let n = 0;
    c.events.on('change', () => n++);
    c.panBy(1, 1);
    c.zoomAt(0, 0, 2);
    c.setZoomAt(0, 0, 1);
    expect(n).toBe(3);
  });
});
