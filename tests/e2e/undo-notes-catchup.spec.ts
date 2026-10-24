/** Milestone 7: undo/redo, sticky notes, lastSeq catch-up, too-far-behind snapshots, tombstone GC. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { query } from '../integration/db';
import { closeTabs, drag, drawShape, expectConverged, joinTab, openTabs, outlinePoint, shapeById, shapes, snapshot, toScreen } from './helpers';
import { E2E_DB_URL, restartServer } from './server';

test.afterEach(closeTabs);

const SCREENS = 'test-results/screens';
const undo = (page: Page) => page.keyboard.press('Control+z');
const redo = (page: Page) => page.keyboard.press('Control+Shift+z');
const lastWelcome = (page: Page) => page.evaluate(() => window.__board?.lastWelcome() ?? null);
const status = (page: Page) => page.evaluate(() => window.__board?.status());

test.describe('undo / redo', () => {
  test('only your own edits are undone', async ({ browser }) => {
    const t = await openTabs(browser, 2);
    const [a, b] = [t.page(0), t.page(1)];
    const mine = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    const theirs = await drawShape(b, 'Ellipse', { x: 600, y: 250 }, { x: 720, y: 330 });
    await expectConverged([a, b]);
    await undo(a);
    await expectConverged([a, b]);
    expect((await shapes(b)).map((s) => s.id)).toEqual([theirs.id]);
    expect(await shapeById(a, mine.id)).toBeUndefined();
    await redo(a);
    await expect.poll(async () => (await shapes(b)).map((s) => s.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  test('one drag is one undo step', async ({ browser }) => {
    const t = await openTabs(browser, 2);
    const [a, b] = [t.page(0), t.page(1)];
    const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    const grab = await outlinePoint(a, rect);
    await drag(a, grab, { x: grab.x + 250, y: grab.y + 150 }, 25); // 25 pointer moves
    await expect.poll(async () => (await shapeById(b, rect.id))?.x).toBe(rect.x + 250);
    await undo(a); // one press undoes the whole drag
    await expect.poll(async () => (await shapeById(b, rect.id))?.x).toBe(rect.x);
    expect(await shapeById(b, rect.id)).toMatchObject({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    await expectConverged([a, b]);
  });

  test("undo skips properties someone else changed after you, and undoes the rest", async ({ browser }) => {
    const t = await openTabs(browser, 2);
    const [a, b] = [t.page(0), t.page(1)];
    const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    // A resizes from the north-west handle: one step changing x, y, w and h.
    const nw = await toScreen(a, rect.x, rect.y);
    await drag(a, nw, { x: nw.x - 40, y: nw.y - 30 });
    const resized = await shapeById(a, rect.id);
    expect(resized).toMatchObject({ w: rect.w + 40, h: rect.h + 30 });
    await expectConverged([a, b]);
    // B then moves it: x and y are B's now.
    const inB = await shapeById(b, rect.id);
    if (!inB) throw new Error('rect missing in B');
    const grab = await outlinePoint(b, inB);
    await drag(b, grab, { x: grab.x + 200, y: grab.y + 100 });
    await expectConverged([a, b]);
    const moved = await shapeById(a, rect.id);
    // A undoes the resize: w and h go back; x and y stay where B put them.
    await undo(a);
    await expectConverged([a, b]);
    expect(await shapeById(b, rect.id)).toMatchObject({ x: moved?.x, y: moved?.y, w: rect.w, h: rect.h });
  });

  test('undo of a delete restores the shape in every tab', async ({ browser }) => {
    const t = await openTabs(browser, 3);
    const [a, b, c] = [t.page(0), t.page(1), t.page(2)];
    const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    await a.keyboard.press('Delete');
    await expectConverged([a, b, c]);
    expect(await shapes(c)).toEqual([]);
    await undo(a);
    await expectConverged([a, b, c]);
    for (const page of [a, b, c]) expect((await shapes(page)).map((s) => s.id)).toEqual([rect.id]);
  });
});

test('sticky notes: create, type, text syncs on blur; other tabs see "is typing" and are soft-locked', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  await a.keyboard.press('n');
  await a.mouse.click(400, 300);
  const editor = a.getByLabel('Note text');
  await expect(editor).toBeFocused();
  const noteId = await a.evaluate(() => window.__board?.editingNote());
  if (!noteId) throw new Error('no note being edited');
  await expect.poll(async () => (await shapeById(b, noteId))?.type).toBe('note');
  await editor.pressSequentially('Hello from the owner', { delay: 10 });

  // B: the note is being typed in by "owner", its text hasn't synced yet, and B can't open it.
  await expect.poll(() => b.evaluate((id) => window.__board?.typingIn(id), noteId)).toBe('owner');
  expect((await shapeById(b, noteId))?.text).toBe('');
  const note = await shapeById(b, noteId);
  if (!note) throw new Error('note missing in B');
  const inside = await toScreen(b, note.x + note.w / 2, note.y + note.h / 2);
  await b.mouse.dblclick(inside.x, inside.y);
  expect(await b.evaluate(() => window.__board?.editingNote())).toBeNull();
  await expect(b.getByLabel('Note text')).toHaveCount(0);
  await b.screenshot({ path: `${SCREENS}/m7-note-typing-tabB.png` });

  // A leaves the note (blur): the text arrives in B as one update, and the lock lifts.
  await a.keyboard.press('Escape');
  await expect.poll(async () => (await shapeById(b, noteId))?.text).toBe('Hello from the owner');
  await expect.poll(() => b.evaluate((id) => window.__board?.typingIn(id), noteId)).toBeNull();
  await b.mouse.dblclick(inside.x, inside.y);
  await expect(b.getByLabel('Note text')).toBeFocused();
  await b.getByLabel('Note text').press('End');
  await b.getByLabel('Note text').pressSequentially(' and the editor', { delay: 10 });
  await b.keyboard.press('Escape');
  await expect.poll(async () => (await shapeById(a, noteId))?.text).toBe('Hello from the owner and the editor');
  await expectConverged([a, b]);
  await a.screenshot({ path: `${SCREENS}/m7-note-tabA.png` });
});

test('lastSeq catch-up: an offline tab catches up without reloading, and its offline edits sync', async ({ browser }) => {
  const t = await openTabs(browser, 2);
  const [a, b] = [t.page(0), t.page(1)];
  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  await expectConverged([a, b]);
  await b.evaluate(() => {
    (window as unknown as { __notReloaded: boolean }).__notReloaded = true;
  });

  await b.context().setOffline(true);
  await expect.poll(() => status(b)).toBe('offline');
  await expect(b.getByRole('status')).toContainText('Offline');
  // A keeps working; B draws while offline (applied locally, queued).
  const grab = await outlinePoint(a, rect);
  await drag(a, grab, { x: grab.x + 100, y: grab.y });
  const aEllipse = await drawShape(a, 'Ellipse', { x: 600, y: 250 }, { x: 720, y: 330 });
  const bArrow = await drawShape(b, 'Arrow', { x: 300, y: 500 }, { x: 500, y: 560 });
  expect(await b.evaluate(() => window.__board?.unacked())).toBeGreaterThan(0);

  await b.context().setOffline(false);
  await expect.poll(() => status(b), { timeout: 15_000 }).toBe('connected');
  const welcome = await lastWelcome(b);
  expect(welcome?.kind).toBe('ops'); // caught up from lastSeq, not a full snapshot
  expect(welcome?.ops).toBeGreaterThan(0);
  expect(await b.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);
  await expect.poll(async () => (await shapeById(a, bArrow.id))?.type).toBe('arrow');
  await expectConverged([a, b]);
  expect((await shapes(b)).map((s) => s.id).sort()).toEqual([rect.id, aEllipse.id, bArrow.id].sort());
  expect((await shapeById(b, rect.id))?.x).toBe(rect.x + 100);
});

test.describe('server-side history limits', () => {
  test.describe.configure({ timeout: 120_000 });
  test.afterEach(async () => {
    await restartServer();
  });

  test('too far behind: the server sends a snapshot and the client reapplies its pending edits', async ({ browser }) => {
    await restartServer({ SNAPSHOT_EVERY_OPS: '5' });
    const t = await openTabs(browser, 2);
    const [a, b] = [t.page(0), t.page(1)];
    await drawShape(a, 'Rectangle', { x: 200, y: 200 }, { x: 260, y: 240 });
    await expectConverged([a, b]);
    await b.context().setOffline(true);
    await expect.poll(() => status(b)).toBe('offline');
    // A makes enough ops for several snapshots: the op log is pruned past B's lastSeq.
    for (let i = 0; i < 8; i++) {
      await drawShape(a, 'Rectangle', { x: 300 + i * 70, y: 300 }, { x: 350 + i * 70, y: 340 });
      await a.waitForTimeout(150);
    }
    const bNote = await drawShape(b, 'Ellipse', { x: 300, y: 500 }, { x: 400, y: 560 });
    await b.context().setOffline(false);
    await expect.poll(() => status(b), { timeout: 15_000 }).toBe('connected');
    expect((await lastWelcome(b))?.kind).toBe('snapshot');
    await expect.poll(async () => (await shapeById(a, bNote.id))?.type).toBe('ellipse');
    await expectConverged([a, b]);
    expect(await shapes(b)).toHaveLength(10);
  });

  test('tombstones older than the cutoff are removed at snapshot time; recent ones stay', async ({ browser }) => {
    await restartServer({ TOMBSTONE_TTL_MS: '2000', SNAPSHOT_EVERY_MS: '300' });
    const t = await openTabs(browser, 1);
    const a = t.page(0);
    const old = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    await a.keyboard.press('Delete');
    await a.waitForTimeout(2500); // past the cutoff
    const recent = await drawShape(a, 'Ellipse', { x: 600, y: 250 }, { x: 720, y: 330 });
    await a.keyboard.press('Delete');
    await expectConverged([a]);
    // The next timed snapshot collects the old tombstone only.
    await expect
      .poll(
        async () => {
          const [row] = await query<{ state: { board: { shapes: { id: string }[] } } }>(
            E2E_DB_URL,
            'select state from board_snapshots where board_id = $1 order by seq desc limit 1',
            [t.boardId],
          );
          const ids = row?.state.board.shapes.map((s) => s.id) ?? [];
          return { old: ids.includes(old.id), recent: ids.includes(recent.id) };
        },
        { timeout: 10_000 },
      )
      .toEqual({ old: false, recent: true });
    // Someone joining now never receives the collected tombstone.
    const late = await joinTab(browser, t.boardId, t.owner);
    const lateIds = (await snapshot(late)).shapes.map((s) => s.id);
    expect(lateIds).not.toContain(old.id);
    expect(lateIds).toContain(recent.id);
  });
});
