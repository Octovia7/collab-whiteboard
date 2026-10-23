import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { BoardSnapshot, Point, Shape } from '@whiteboard/shared';
import type { DebugHandle } from '../../packages/client/src/debug';

declare global {
  interface Window {
    __board?: DebugHandle;
  }
}

/** A fresh board id per test, so tests never see each other's shapes. */
export function newBoardId(name: string): string {
  return `e2e-${name}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Opens a tab in its own browser context (separate storage, like a separate user) and waits for welcome. */
export async function openTab(browser: Browser, boardId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  opened.push(context);
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  await page.goto(`/?board=${boardId}`);
  await page.waitForFunction(() => window.__board?.status() === 'connected');
  return page;
}

export const shapes = (page: Page): Promise<Shape[]> => page.evaluate(readShapes);
export const snapshot = (page: Page): Promise<BoardSnapshot> => page.evaluate(readSnapshot);
export const selection = (page: Page): Promise<string[]> => page.evaluate(() => window.__board?.selection() ?? []);
export const camera = (page: Page) => page.evaluate(() => window.__board?.camera() ?? { x: NaN, y: NaN, zoom: NaN });
export const unacked = (page: Page): Promise<number> => page.evaluate(() => window.__board?.unacked() ?? -1);

// page.evaluate serializes the function, so these must not close over module scope.
function readShapes(): Shape[] {
  const b = window.__board;
  if (!b) throw new Error('window.__board missing: is this a dev build?');
  return b.shapes();
}
function readSnapshot(): BoardSnapshot {
  const b = window.__board;
  if (!b) throw new Error('window.__board missing');
  return b.snapshot();
}

export async function toScreen(page: Page, x: number, y: number): Promise<Point> {
  return page.evaluate(([wx, wy]) => window.__board?.toScreen(wx as number, wy as number) ?? { x: NaN, y: NaN }, [x, y]);
}

export async function toWorld(page: Page, x: number, y: number): Promise<Point> {
  return page.evaluate(([sx, sy]) => window.__board?.toWorld(sx as number, sy as number) ?? { x: NaN, y: NaN }, [x, y]);
}

/** Press, move in steps, release: a real pointer drag in screen coordinates. */
export async function drag(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Picks a toolbar tool and drags out a shape between two screen points; returns the new shape. */
export async function drawShape(page: Page, tool: 'Rectangle' | 'Ellipse' | 'Arrow', from: Point, to: Point): Promise<Shape> {
  const before = new Set((await shapes(page)).map((s) => s.id));
  await page.getByRole('button', { name: tool, exact: true }).click();
  await drag(page, from, to);
  const created = (await shapes(page)).filter((s) => !before.has(s.id));
  expect(created).toHaveLength(1);
  return created[0] as Shape;
}



export async function shapeById(page: Page, id: string): Promise<Shape | undefined> {
  return (await shapes(page)).find((s) => s.id === id);
}

/**
 * A screen point on a shape's outline that is clear of every resize handle. Unfilled shapes
 * are only hittable on their outline, and grabbing a handle (corners, edge midpoints, arrow
 * ends) of a selected shape would resize it instead of moving it.
 */
export async function outlinePoint(page: Page, s: Shape): Promise<Point> {
  const minX = Math.min(s.x, s.x + s.w);
  const minY = Math.min(s.y, s.y + s.h);
  const w = Math.abs(s.w);
  const h = Math.abs(s.h);
  switch (s.type) {
    case 'ellipse': {
      // The curve's upper-left 45-degree point: on the outline, away from the box handles.
      const a = (5 * Math.PI) / 4;
      return toScreen(page, minX + w / 2 + (w / 2) * Math.cos(a), minY + h / 2 + (h / 2) * Math.sin(a));
    }
    case 'arrow':
      return toScreen(page, s.x + s.w / 2, s.y + s.h / 2); // middle of the shaft
    default:
      return toScreen(page, minX, minY + h / 4); // left side, a quarter of the way down
  }
}

const opened: BrowserContext[] = [];

/** Closes every context opened with openTab; call from test.afterEach. */
export async function closeTabs(): Promise<void> {
  await Promise.all(opened.splice(0).map((c) => c.close()));
}

/**
 * Waits until every tab has no unacked ops and all full board snapshots (registers and
 * stamps, tombstones included) are identical, then returns that snapshot.
 */
export async function expectConverged(pages: Page[]): Promise<BoardSnapshot> {
  await expect
    .poll(
      async () => {
        const pending = await Promise.all(pages.map(unacked));
        if (pending.some((n) => n !== 0)) return `unacked: ${pending.join(',')}`;
        const snaps = await Promise.all(pages.map((p) => p.evaluate(readSnapshot)));
        const first = JSON.stringify(snaps[0]);
        return snaps.every((s) => JSON.stringify(s) === first) ? 'converged' : 'snapshots differ';
      },
      { timeout: 10_000, intervals: [50, 100, 200] },
    )
    .toBe('converged');
  return pages[0] ? snapshot(pages[0]) : { shapes: [] };
}
