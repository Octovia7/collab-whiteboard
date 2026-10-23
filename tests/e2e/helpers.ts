import { expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { BoardSnapshot, Point, Shape } from '@whiteboard/shared';
import type { DebugHandle } from '../../packages/client/src/debug';

declare global {
  interface Window {
    __board?: DebugHandle;
  }
}

const opened: BrowserContext[] = [];

export const PASSWORD = 'password123';

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

let userCounter = 0;

/**
 * A new browser context (separate cookies and storage: a separate person) with a freshly
 * signed-up user. The context's request API shares its cookies, so the session applies to
 * pages opened in it.
 */
export async function newUser(browser: Browser, label = 'user'): Promise<{ context: BrowserContext; user: TestUser }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  opened.push(context);
  const email = `${label}-${Date.now().toString(36)}-${++userCounter}@e2e.test`;
  const res = await context.request.post('/api/auth/signup', { data: { email, name: label, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(201);
  const { user } = (await res.json()) as { user: TestUser };
  return { context, user };
}

/** A new, logged-out browser context. */
export async function freshContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  opened.push(context);
  return context;
}

export async function createBoard(context: BrowserContext, title = 'E2E board'): Promise<string> {
  const res = await context.request.post('/api/boards', { data: { title } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { board: { id: string } }).board.id;
}

export async function addMember(owner: BrowserContext, boardId: string, email: string, role: 'editor' | 'viewer'): Promise<void> {
  const res = await owner.request.post(`/api/boards/${boardId}/members`, { data: { email, role } });
  expect(res.status(), await res.text()).toBe(201);
}

/** Opens the board in a new page of `context` and waits for the server's welcome. */
export async function openBoardPage(context: BrowserContext, boardId: string): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  await page.goto(`/?board=${boardId}`);
  await page.waitForFunction(() => window.__board?.status() === 'connected');
  return page;
}

/**
 * `n` tabs on a new board, each a different signed-in user: the first owns the board, the
 * others are editors.
 */
export async function openTabs(browser: Browser, n: number) {
  const owner = await newUser(browser, 'owner');
  const boardId = await createBoard(owner.context);
  const pages = [await openBoardPage(owner.context, boardId)];
  for (let i = 1; i < n; i++) pages.push(await joinTab(browser, boardId, owner.context));
  return {
    boardId,
    owner: owner.context,
    pages,
    page(i: number): Page {
      const p = pages[i];
      if (!p) throw new Error(`no tab ${i}`);
      return p;
    },
  };
}

/** A new user, added to the board with `role` by the owner, opening it in a tab. */
export async function joinTab(browser: Browser, boardId: string, owner: BrowserContext, role: 'editor' | 'viewer' = 'editor'): Promise<Page> {
  const { context, user } = await newUser(browser, role);
  await addMember(owner, boardId, user.email, role);
  return openBoardPage(context, boardId);
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
