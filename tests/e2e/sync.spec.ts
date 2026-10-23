import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  drag,
  drawShape,
  expectConverged,
  outlinePoint,
  closeTabs,
  newBoardId,
  openTab,
  shapeById,
  shapes,
  toScreen,
} from './helpers';

test.afterEach(closeTabs);

const SCREENS = 'test-results/screens';

async function screenshots(pages: Page[], name: string): Promise<void> {
  for (const [i, page] of pages.entries()) {
    await page.screenshot({ path: `${SCREENS}/${name}-tab${String.fromCharCode(65 + i)}.png` });
  }
}

test('1. a shape drawn in tab A appears in tab B, and the reverse', async ({ browser }) => {
  const board = newBoardId('draw');
  const a = await openTab(browser, board);
  const b = await openTab(browser, board);

  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  await expect.poll(async () => (await shapeById(b, rect.id))?.type).toBe('rect');

  const ellipse = await drawShape(b, 'Ellipse', { x: 600, y: 250 }, { x: 760, y: 380 });
  await expect.poll(async () => (await shapeById(a, ellipse.id))?.type).toBe('ellipse');

  const snap = await expectConverged([a, b]);
  expect(snap.shapes.map((s) => s.id).sort()).toEqual([rect.id, ellipse.id].sort());
  await screenshots([a, b], 'test1');
});

test('2. move, recolor and delete sync both ways', async ({ browser }) => {
  const board = newBoardId('edit');
  const a = await openTab(browser, board);
  const b = await openTab(browser, board);
  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  const ellipse = await drawShape(a, 'Ellipse', { x: 600, y: 250 }, { x: 760, y: 380 });
  await expectConverged([a, b]);

  // A moves the rectangle (grab its outline, drag 100 px right).
  const grabA = await outlinePoint(a, rect);
  await drag(a, grabA, { x: grabA.x + 100, y: grabA.y + 40 });
  await expect.poll(async () => (await shapeById(b, rect.id))?.x).toBe(rect.x + 100);

  // B recolors the ellipse: select it by its outline, then pick red.
  const ellipseInB = await shapeById(b, ellipse.id);
  if (!ellipseInB) throw new Error('ellipse missing in B');
  const grabB = await outlinePoint(b, ellipseInB);
  await b.mouse.click(grabB.x, grabB.y);
  await expect.poll(() => b.evaluate(() => window.__board?.selection())).toEqual([ellipse.id]);
  await b.getByRole('button', { name: 'Color #e03131' }).click();
  await expect.poll(async () => (await shapeById(a, ellipse.id))?.color).toBe('#e03131');

  // B moves the rectangle back; A sees it.
  const rectInB = await shapeById(b, rect.id);
  if (!rectInB) throw new Error('rect missing in B');
  const grab = await outlinePoint(b, rectInB);
  await drag(b, grab, { x: grab.x - 100, y: grab.y - 40 });
  await expect.poll(async () => (await shapeById(a, rect.id))?.x).toBe(rect.x);

  // A deletes the ellipse, B deletes the rectangle.
  const ellipseInA = await shapeById(a, ellipse.id);
  if (!ellipseInA) throw new Error('ellipse missing in A');
  const e = await outlinePoint(a, ellipseInA);
  await a.mouse.click(e.x, e.y);
  await a.keyboard.press('Delete');
  await expect.poll(async () => (await shapeById(b, ellipse.id)) === undefined).toBe(true);
  const r = await outlinePoint(b, rectInB);
  await b.mouse.click(r.x, r.y);
  await b.keyboard.press('Delete');
  await expect.poll(async () => (await shapes(a)).length).toBe(0);

  const snap = await expectConverged([a, b]);
  // Deleted shapes remain as tombstones in the state.
  expect(snap.shapes).toHaveLength(2);
});

test('3. both tabs drag the same shape at the same time; both boards end identical', async ({ browser }) => {
  const board = newBoardId('concurrent-drag');
  const a = await openTab(browser, board);
  const b = await openTab(browser, board);
  const rect = await drawShape(a, 'Rectangle', { x: 400, y: 300 }, { x: 560, y: 420 });
  await expectConverged([a, b]);

  const startA = await outlinePoint(a, rect);
  const startB = await outlinePoint(b, rect);
  await a.mouse.move(startA.x, startA.y);
  await a.mouse.down();
  await b.mouse.move(startB.x, startB.y);
  await b.mouse.down();
  // Interleave the two drags step by step, in opposite directions.
  for (let i = 1; i <= 15; i++) {
    await a.mouse.move(startA.x + i * 12, startA.y + i * 4);
    await b.mouse.move(startB.x - i * 10, startB.y + i * 8);
  }
  await a.mouse.up();
  await b.mouse.up();

  const snap = await expectConverged([a, b]);
  const finalA = await shapeById(a, rect.id);
  const finalB = await shapeById(b, rect.id);
  expect(finalA).toEqual(finalB);
  // Both were moves, so the size is untouched...
  expect(finalA).toMatchObject({ w: rect.w, h: rect.h });
  // ...and the position is exactly one drag's drop point (x and y travel in the same op,
  // so they always come from the same winner), chosen identically on both screens.
  const dropA = { x: rect.x + 180, y: rect.y + 60 };
  const dropB = { x: rect.x - 150, y: rect.y + 120 };
  expect([dropA, dropB]).toContainEqual({ x: finalA?.x, y: finalA?.y });
  expect(snap.shapes).toHaveLength(1);
  await screenshots([a, b], 'test3');
});

test('4. one tab deletes a shape while the other drags it: deleted in both', async ({ browser }) => {
  const board = newBoardId('delete-vs-drag');
  const a = await openTab(browser, board);
  const b = await openTab(browser, board);
  const rect = await drawShape(a, 'Rectangle', { x: 400, y: 300 }, { x: 560, y: 420 });
  await expectConverged([a, b]);

  // B starts dragging.
  const start = await outlinePoint(b, rect);
  await b.mouse.move(start.x, start.y);
  await b.mouse.down();
  for (let i = 1; i <= 5; i++) await b.mouse.move(start.x + i * 10, start.y);

  // A (where the rectangle is still selected from drawing it) deletes it mid-drag.
  await expect.poll(() => a.evaluate(() => window.__board?.selection())).toEqual([rect.id]);
  await a.keyboard.press('Delete');

  // B keeps dragging, then lets go.
  for (let i = 6; i <= 12; i++) await b.mouse.move(start.x + i * 10, start.y);
  await b.mouse.up();

  const snap = await expectConverged([a, b]);
  expect(await shapes(a)).toEqual([]);
  expect(await shapes(b)).toEqual([]);
  expect(snap.shapes[0]?.regs.deleted?.value).toBe(true);
});

test('5. a third tab joining late gets an identical board', async ({ browser }) => {
  const board = newBoardId('late-join');
  const a = await openTab(browser, board);
  const b = await openTab(browser, board);
  await drawShape(a, 'Rectangle', { x: 200, y: 200 }, { x: 320, y: 300 });
  const ellipse = await drawShape(b, 'Ellipse', { x: 500, y: 200 }, { x: 640, y: 320 });
  await drawShape(a, 'Arrow', { x: 200, y: 450 }, { x: 420, y: 520 });
  const grab = await outlinePoint(b, ellipse);
  await drag(b, grab, { x: grab.x + 60, y: grab.y + 30 });
  await expect.poll(async () => (await shapeById(b, ellipse.id))?.x).toBe(ellipse.x + 60);
  await a.keyboard.press('Delete'); // deletes the arrow A just drew (still selected)
  const before = await expectConverged([a, b]);

  const c = await openTab(browser, board);
  const after = await expectConverged([a, b, c]);
  expect(after).toEqual(before);
  expect(await shapes(c)).toEqual(await shapes(a));
  expect((await shapes(c)).map((s) => s.type)).toEqual(['rect', 'ellipse']);
});

test('screen coordinates line up with world coordinates (sanity check for the helpers)', async ({ browser }) => {
  const a = await openTab(browser, newBoardId('coords'));
  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  const corner = await toScreen(a, rect.x, rect.y);
  expect(corner.x).toBeCloseTo(300);
  expect(corner.y).toBeCloseTo(250);
});
