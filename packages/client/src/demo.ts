import type { ShapeType } from '@whiteboard/shared';
import type { BoardStore } from './store/BoardStore';

const TYPES: ShapeType[] = ['rect', 'ellipse', 'arrow'];
const COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5'];
const CELL = 140;

/**
 * Fills the board with a grid of shapes so the renderer and camera have something to show
 * before the tools exist (milestone 3). `?demo=N` sets the count; large N stress-tests culling.
 */
export function seedDemo(store: BoardStore, count: number): void {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const type = TYPES[i % TYPES.length] as ShapeType;
    const size = 60 + ((i * 37) % 50);
    // One submit per shape: makeCreate reads topZ, so each create must land before the next.
    store.submit([
      store.makeCreate({
        type,
        x: col * CELL,
        y: row * CELL,
        w: size,
        // Alternate arrow directions so negative w/h get exercised too.
        h: type === 'arrow' && i % 2 === 0 ? -size * 0.6 : size * 0.7,
        color: COLORS[i % COLORS.length] as string,
      }),
    ]);
  }
}

export function demoCountFromUrl(): number {
  const raw = new URLSearchParams(window.location.search).get('demo');
  // Off by default now that boards are shared: opt in with ?demo=N on an empty board.
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 50_000) : 0;
}
