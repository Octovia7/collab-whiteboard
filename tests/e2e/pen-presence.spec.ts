/** Milestone 6: freehand pen (streaming, RDP, smoothing), eraser, presence. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Point } from '@whiteboard/shared';
import { closeTabs, drag, drawShape, expectConverged, joinTab, openTabs, outlinePoint, shapeById, shapes, toScreen, toWorld } from './helpers';

test.afterEach(closeTabs);

const SCREENS = 'test-results/screens';
const strokePoints = (page: Page, id: string) => page.evaluate((sid) => window.__board?.strokePoints(sid) ?? [], id);
const peers = (page: Page) => page.evaluate(() => window.__board?.peers() ?? []);
const online = (page: Page) => page.evaluate(() => window.__board?.online() ?? []);

/** Presses at the first point and moves through the rest, `ms` apart, without releasing. */
async function penDown(page: Page, path: Point[], ms = 16): Promise<void> {
  const [first, ...rest] = path;
  if (!first) return;
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of rest) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(ms);
  }
}

/** A wavy path across the screen. */
const wave = (x0: number, y0: number, length: number, n: number): Point[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (length * i) / n, y: y0 + Math.sin((i / n) * Math.PI * 3) * 40 }));

async function newestStroke(page: Page) {
  const all = await shapes(page);
  const s = all.filter((x) => x.type === 'stroke').at(-1);
  if (!s) throw new Error('no stroke');
  return s;
}

test('pen: points stream to the other tab while drawing; pen-up replaces them with a simplified list', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  await a.getByRole('button', { name: 'Pen', exact: true }).click();
  const path = wave(250, 350, 600, 60);

  await penDown(a, path.slice(0, 31));
  const stroke = await newestStroke(a);
  // Still drawing: B already shows the line growing, from the streamed chunks.
  await expect.poll(async () => (await strokePoints(b, stroke.id)).length).toBeGreaterThan(20);
  expect(stroke.points).toBeUndefined(); // not finished yet
  for (const p of path.slice(31)) {
    await a.mouse.move(p.x, p.y);
    await a.waitForTimeout(16);
  }
  const streamed = (await strokePoints(a, stroke.id)).length;
  await a.mouse.up();

  await expectConverged([a, b]);
  const finalA = await shapeById(a, stroke.id);
  const finalB = await shapeById(b, stroke.id);
  expect(finalA?.points).toBeDefined();
  expect(finalB?.points).toEqual(finalA?.points);
  // RDP kept the shape (a wave is not a line) with fewer points than were streamed.
  const finalCount = (finalA?.points?.length ?? 0) / 2;
  expect(finalCount).toBeGreaterThan(5);
  expect(finalCount * 2).toBeLessThan(streamed);
  expect(await a.evaluate(() => window.__board?.tool())).toBe('pen');
  for (const [i, page] of [a, b].entries()) await page.screenshot({ path: `${SCREENS}/m6-pen-tab${'AB'[i]}.png` });
});

test('pen: a straight line simplifies to its two ends', async ({ browser }) => {
  const a = (await openTabs(browser, 1)).page(0);
  await a.keyboard.press('p');
  const from = { x: 300, y: 400 };
  await penDown(a, Array.from({ length: 41 }, (_, i) => ({ x: from.x + i * 10, y: from.y })), 5);
  await a.mouse.up();
  const stroke = await newestStroke(a);
  await expect.poll(async () => (await shapeById(a, stroke.id))?.points).toEqual([0, 0, 400, 0]);
});

test('eraser: deletes the strokes it touches in both tabs, leaves other shapes', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  await a.keyboard.press('p');
  for (const x of [400, 500, 900]) {
    await penDown(a, Array.from({ length: 11 }, (_, i) => ({ x, y: 250 + i * 25 })), 5);
    await a.mouse.up();
  }
  const rect = await drawShape(a, 'Rectangle', { x: 600, y: 300 }, { x: 700, y: 400 });
  await expectConverged([a, b]);
  expect((await shapes(b)).map((s) => s.type)).toEqual(['stroke', 'stroke', 'stroke', 'rect']);

  // B sweeps the eraser across the first two strokes and over the rectangle's edge.
  await b.getByRole('button', { name: 'Eraser', exact: true }).click();
  await drag(b, { x: 350, y: 375 }, { x: 650, y: 375 }, 4);
  await expectConverged([a, b]);
  const left = await shapes(a);
  expect(left.map((s) => s.type)).toEqual(['stroke', 'rect']);
  expect(left.find((s) => s.type === 'rect')?.id).toBe(rect.id);
  for (const [i, page] of [a, b].entries()) await page.screenshot({ path: `${SCREENS}/m6-eraser-tab${'AB'[i]}.png` });
});

test('strokes can be selected, moved and recolored but not resized', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  await a.keyboard.press('p');
  await penDown(a, wave(300, 300, 300, 30), 5);
  await a.mouse.up();
  const stroke = await newestStroke(a);
  await expectConverged([a, b]);
  const pointsBefore = await strokePoints(a, stroke.id);

  // Select by clicking on the line itself (strokes are hittable along their path).
  await a.keyboard.press('v');
  const onLine = await toScreen(a, stroke.x + (pointsBefore[20] as number), stroke.y + (pointsBefore[21] as number));
  await a.mouse.click(onLine.x, onLine.y);
  expect(await a.evaluate(() => window.__board?.selection())).toEqual([stroke.id]);
  await drag(a, onLine, { x: onLine.x + 80, y: onLine.y + 60 });
  await a.getByRole('button', { name: 'Color #1971c2' }).click();
  await expect.poll(async () => (await shapeById(b, stroke.id))?.x).toBeCloseTo(stroke.x + 80, 1);
  // Moving only changed x/y: the relative points are untouched.
  expect(await strokePoints(b, stroke.id)).toEqual(pointsBefore);
  // The recolor goes out in a later batch than the move, so wait for it too.
  await expect.poll(async () => (await shapeById(b, stroke.id))?.color).toBe('#1971c2');
  await expectConverged([a, b]);
});

test('presence: live cursors with names, remote selections, online list, and leaving', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 300 }, { x: 460, y: 400 });
  await a.keyboard.press('Escape'); // clear A's selection for now

  // Online list: both see two people, themselves first.
  await expect.poll(async () => (await online(b)).map((u) => [u.name, u.isYou])).toEqual([
    ['editor', true],
    ['owner', false],
  ]);
  await expect(b.getByRole('list', { name: 'Online' })).toContainText('owner');

  // A moves the mouse: B sees A's cursor at the same world point.
  await a.mouse.move(700, 450, { steps: 5 });
  const world = await toWorld(a, 700, 450);
  await expect.poll(async () => (await peers(b))[0]?.target).toEqual({ x: Math.round(world.x * 100) / 100, y: Math.round(world.y * 100) / 100 });
  expect((await peers(b))[0]?.name).toBe('owner');

  // A selects the rectangle: B sees it as A's selection.
  const edge = await outlinePoint(a, rect);
  await a.mouse.click(edge.x, edge.y);
  await expect.poll(async () => (await peers(b))[0]?.selection).toEqual([rect.id]);
  await a.mouse.move(640, 420);
  await b.waitForTimeout(400); // cursor easing settles
  await b.screenshot({ path: `${SCREENS}/m6-presence-tabB.png` });

  // A leaves: B's online list drops them.
  await a.close();
  await expect.poll(async () => (await online(b)).length).toBe(1);
  expect(await peers(b)).toEqual([]);
});

test('viewers: pen and eraser disabled, but their cursor is visible to others', async ({ browser }) => {
  const t = await openTabs(browser, 1);
  const owner = t.page(0);
  const viewer = await joinTab(browser, t.boardId, t.owner, 'viewer');
  await expect(viewer.getByRole('button', { name: 'Pen', exact: true })).toBeDisabled();
  await expect(viewer.getByRole('button', { name: 'Eraser', exact: true })).toBeDisabled();
  await viewer.keyboard.press('p');
  expect(await viewer.evaluate(() => window.__board?.tool())).toBe('select');
  await viewer.mouse.move(500, 500, { steps: 3 });
  await expect.poll(async () => (await peers(owner))[0]?.target).not.toBeNull();
  expect((await peers(owner))[0]?.name).toBe('viewer');
});
