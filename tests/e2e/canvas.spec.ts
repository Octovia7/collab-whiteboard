import { expect, test } from '@playwright/test';
import { camera, closeTabs, drag, drawShape, expectConverged, outlinePoint, openTabs, selection, shapeById, shapes, snapshot, toScreen, toWorld } from './helpers';

test.afterEach(closeTabs);

test('6. zoom keeps the world point under the cursor; pan moves the camera (milestone 2)', async ({ browser }) => {
  const page = (await openTabs(browser, 1)).page(0);
  const cursor = { x: 700, y: 450 };

  const before = await toWorld(page, cursor.x, cursor.y);
  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -400); // zoom in
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1.5);
  const after = await toWorld(page, cursor.x, cursor.y);
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y, 6);

  await page.mouse.move(200, 600);
  await page.mouse.wheel(0, 600); // zoom out somewhere else
  const anchor = await toWorld(page, 200, 600);
  await page.mouse.wheel(0, 200);
  const anchorAfter = await toWorld(page, 200, 600);
  expect(anchorAfter.x).toBeCloseTo(anchor.x, 6);
  expect(anchorAfter.y).toBeCloseTo(anchor.y, 6);

  // Space + drag pans: the board follows the pointer, so the camera moves by -delta / zoom.
  const cam = await camera(page);
  await page.keyboard.down('Space');
  await drag(page, { x: 600, y: 400 }, { x: 750, y: 340 });
  await page.keyboard.up('Space');
  const panned = await camera(page);
  expect(panned.x).toBeCloseTo(cam.x - 150 / cam.zoom, 6);
  expect(panned.y).toBeCloseTo(cam.y + 60 / cam.zoom, 6);
  expect(await shapes(page)).toEqual([]); // panning must not draw or select anything

  // Middle-button drag pans too.
  await page.mouse.move(500, 500);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(400, 500, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  expect((await camera(page)).x).toBeCloseTo(panned.x + 100 / cam.zoom, 6);
});

test('7. draw, select, move, resize, box-select, recolor, front/back and delete (milestone 3)', async ({ browser }) => {
  const page = (await openTabs(browser, 1)).page(0);

  // Draw one of each shape; each switches back to the select tool with the new shape selected.
  const rect = await drawShape(page, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  expect(await selection(page)).toEqual([rect.id]);
  await expect.poll(() => page.evaluate(() => window.__board?.tool())).toBe('select');
  await page.keyboard.press('o');
  await drag(page, { x: 520, y: 250 }, { x: 640, y: 350 });
  const ellipse = (await shapes(page)).find((s) => s.type === 'ellipse');
  await page.keyboard.press('a');
  await drag(page, { x: 300, y: 520 }, { x: 480, y: 600 });
  const arrow = (await shapes(page)).find((s) => s.type === 'arrow');
  if (!ellipse || !arrow) throw new Error('ellipse or arrow not drawn');
  expect(rect).toMatchObject({ w: 120, h: 80 });
  expect(arrow).toMatchObject({ w: 180, h: 80 });

  // Click empty space clears the selection; clicking the rectangle's outline selects it.
  await page.mouse.click(900, 650);
  expect(await selection(page)).toEqual([]);
  const edge = await outlinePoint(page, rect);
  await page.mouse.click(edge.x, edge.y);
  expect(await selection(page)).toEqual([rect.id]);
  // Clicking inside an unselected outline-only box does not select it.
  await page.mouse.click(900, 650);
  const centre = await toScreen(page, rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.mouse.click(centre.x, centre.y);
  expect(await selection(page)).toEqual([]);

  // Move: select, then drag from the middle of the selected box.
  await page.mouse.click(edge.x, edge.y);
  await drag(page, centre, { x: centre.x + 50, y: centre.y + 20 });
  const moved = await shapeById(page, rect.id);
  expect(moved).toMatchObject({ x: rect.x + 50, y: rect.y + 20, w: 120, h: 80 });

  // Resize: drag the south-east handle.
  if (!moved) throw new Error('rect missing');
  const se = await toScreen(page, moved.x + moved.w, moved.y + moved.h);
  await drag(page, se, { x: se.x + 30, y: se.y + 40 });
  expect(await shapeById(page, rect.id)).toMatchObject({ x: moved.x, y: moved.y, w: 150, h: 120 });

  // Box-select from empty space: picks the rectangle and ellipse (fully inside), not the arrow.
  await page.mouse.click(900, 650);
  await drag(page, { x: 250, y: 200 }, { x: 760, y: 480 });
  expect((await selection(page)).sort()).toEqual([rect.id, ellipse.id].sort());

  // Recolor applies to the whole selection.
  await page.getByRole('button', { name: 'Color #2f9e44' }).click();
  expect((await shapeById(page, rect.id))?.color).toBe('#2f9e44');
  expect((await shapeById(page, ellipse.id))?.color).toBe('#2f9e44');
  expect((await shapeById(page, arrow.id))?.color).not.toBe('#2f9e44');

  // Front / back: draw order is bottom-first.
  const order = async () => (await shapes(page)).map((s) => s.id);
  expect(await order()).toEqual([rect.id, ellipse.id, arrow.id]);
  await page.getByRole('button', { name: 'Front' }).click(); // rect + ellipse above the arrow
  expect(await order()).toEqual([arrow.id, rect.id, ellipse.id]);
  const arrowTail = await toScreen(page, arrow.x + arrow.w / 2, arrow.y + arrow.h / 2);
  await page.mouse.click(arrowTail.x, arrowTail.y);
  expect(await selection(page)).toEqual([arrow.id]);
  await page.keyboard.press(']');
  expect(await order()).toEqual([rect.id, ellipse.id, arrow.id]);
  await page.getByRole('button', { name: 'Back' }).click();
  expect(await order()).toEqual([arrow.id, rect.id, ellipse.id]);

  // Delete: the arrow disappears but stays in the state as a tombstone.
  await page.keyboard.press('Delete');
  expect(await order()).toEqual([rect.id, ellipse.id]);
  const snap = await snapshot(page);
  expect(snap.shapes.find((s) => s.id === arrow.id)?.regs.deleted?.value).toBe(true);
  await expectConverged([page]);
});
