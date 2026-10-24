/**
 * The IndexedDB offline queue: unacked edits survive a reload or a closed tab and are sent
 * exactly once when the board is next opened online.
 *
 * There is no service worker, so a reload while offline can't load the app: the browser shows
 * its offline error page. The edits survive that in IndexedDB, and the next load of the board
 * (once online) restores and sends them.
 *
 * An outage here is Playwright's offline mode plus refusing the context's WebSockets. Offline
 * mode alone doesn't touch WebSockets, and during page.reload() it briefly fires `online` in
 * the old page, which then reconnects and sends its queue just before unloading: a harness
 * artifact a real outage doesn't have, and one that would let these tests pass without the
 * queue doing anything.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { query } from '../integration/db';
import { closeTabs, drawShape, expectConverged, joinTab, newUser, createBoard, openBoardPage, shapeById, shapes } from './helpers';
import { E2E_DB_URL } from './server';

test.afterEach(closeTabs);

const outages = new WeakMap<BrowserContext, { down: boolean }>();

/** Cuts the context's network: page loads fail, and no WebSocket can connect. */
async function goOffline(context: BrowserContext) {
  let state = outages.get(context);
  if (!state) {
    const s = { down: true };
    state = s;
    outages.set(context, s);
    await context.routeWebSocket(/\/ws/, (ws) => (s.down ? ws.close({ code: 1006 }) : ws.connectToServer()));
  }
  state.down = true;
  await context.setOffline(true);
}

async function goOnline(context: BrowserContext) {
  const state = outages.get(context);
  if (state) state.down = false;
  await context.setOffline(false);
}

const status = (page: Page) => page.evaluate(() => window.__board?.status());
const queueState = (page: Page) => page.evaluate(() => window.__board?.offlineQueue() ?? null);

/** Waits until the tab's queue has written `n` ops to IndexedDB. */
async function savedOps(page: Page, n: number) {
  await expect.poll(async () => (await queueState(page))?.saved).toBe(n);
}

/** Waits until every unacked op (a drawn shape is a create plus its drag updates) is saved. */
async function allSaved(page: Page) {
  const n = await page.evaluate(() => window.__board?.unacked() ?? -1);
  expect(n).toBeGreaterThan(0);
  await savedOps(page, n);
}

/** A reload while offline fails: no service worker, so the browser can't fetch the app. */
async function reloadOffline(page: Page) {
  await expect(page.reload()).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/);
}

/** Opens the board again in the same tab (same sessionStorage) and waits until it's connected. */
async function reopen(page: Page, boardId: string) {
  await page.goto(`/?board=${boardId}`);
  await page.waitForFunction(() => window.__board?.status() === 'connected');
}

/** How many times each shape was created on the server: exactly once means 1 each. */
async function createsPerShape(boardId: string, ids: string[]): Promise<Record<string, number>> {
  const rows = await query<{ id: string; n: string }>(
    E2E_DB_URL,
    `select op->'shape'->>'id' as id, count(*) as n from board_ops
      where board_id = $1 and op->>'kind' = 'create' and op->'shape'->>'id' = any($2) group by 1`,
    [boardId, ids],
  );
  return Object.fromEntries(ids.map((id) => [id, Number(rows.find((r) => r.id === id)?.n ?? 0)]));
}

/** One user with a board: `owner` is their context (shared IndexedDB and locks for their tabs). */
async function ownerAndObserver(browser: Parameters<typeof newUser>[0]) {
  const owner = await newUser(browser, 'owner');
  const boardId = await createBoard(owner.context);
  const observer = await joinTab(browser, boardId, owner.context);
  return { owner: owner.context, boardId, observer };
}

test('go offline, draw, reload while still offline, go online: the shape appears in the other tab', async ({ browser }) => {
  const { owner, boardId, observer } = await ownerAndObserver(browser);
  const tab = await openBoardPage(owner, boardId);
  const { tabId } = (await queueState(tab)) ?? { tabId: '' };

  await goOffline(owner);
  await expect.poll(() => status(tab)).toBe('offline');
  const rect = await drawShape(tab, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  await allSaved(tab);
  await reloadOffline(tab);
  expect(await shapeById(observer, rect.id)).toBeUndefined();

  await goOnline(owner);
  await reopen(tab, boardId);
  // The same tab found its own queue, and the edit reached the server from it.
  expect(await queueState(tab)).toMatchObject({ tabId, restored: 2 });
  await expect.poll(async () => (await shapeById(observer, rect.id))?.type).toBe('rect');
  await expectConverged([tab, observer]);
  await savedOps(tab, 0); // acked, so nothing is left saved
  expect(await createsPerShape(boardId, [rect.id])).toEqual({ [rect.id]: 1 });
});

test('two tabs on one board, both offline with different edits, both reload and come back: every edit arrives exactly once', async ({ browser }) => {
  const { owner, boardId, observer } = await ownerAndObserver(browser);
  const t1 = await openBoardPage(owner, boardId);
  const t2 = await openBoardPage(owner, boardId);
  const [q1, q2] = [await queueState(t1), await queueState(t2)];
  expect(q1?.tabId).not.toBe(q2?.tabId);

  await goOffline(owner); // both tabs (same browser) go offline
  await expect.poll(() => status(t1)).toBe('offline');
  await expect.poll(() => status(t2)).toBe('offline');
  const r1 = await drawShape(t1, 'Rectangle', { x: 200, y: 250 }, { x: 300, y: 330 });
  const r2 = await drawShape(t1, 'Arrow', { x: 200, y: 450 }, { x: 320, y: 500 });
  const e1 = await drawShape(t2, 'Ellipse', { x: 600, y: 250 }, { x: 700, y: 330 });
  await allSaved(t1);
  await allSaved(t2);
  await reloadOffline(t1);
  await reloadOffline(t2);

  await goOnline(owner);
  await reopen(t1, boardId);
  await reopen(t2, boardId);
  // Whichever tab loaded first took the other's queue too (its tab was gone at the time).
  const restored = ((await queueState(t1))?.restored ?? 0) + ((await queueState(t2))?.restored ?? 0);
  expect(restored).toBe(6);
  const ids = [r1.id, r2.id, e1.id];
  await expect.poll(async () => (await shapes(observer)).map((s) => s.id).sort()).toEqual([...ids].sort());
  await expectConverged([t1, t2, observer]);
  expect(await createsPerShape(boardId, ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
  expect(await shapes(observer)).toHaveLength(3);
  await savedOps(t1, 0);
  await savedOps(t2, 0);
});

test('closing an offline tab with unsent edits: a new tab on that board adopts and sends them', async ({ browser }) => {
  const { owner, boardId, observer } = await ownerAndObserver(browser);
  const closing = await openBoardPage(owner, boardId);
  const closedTabId = (await queueState(closing))?.tabId;

  await goOffline(owner);
  await expect.poll(() => status(closing)).toBe('offline');
  const rect = await drawShape(closing, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  const ellipse = await drawShape(closing, 'Ellipse', { x: 600, y: 250 }, { x: 700, y: 330 });
  await allSaved(closing);
  await closing.close();

  await goOnline(owner);
  const fresh = await openBoardPage(owner, boardId);
  const adopter = await queueState(fresh);
  expect(adopter?.tabId).not.toBe(closedTabId); // a different tab adopted them
  expect(adopter?.restored).toBe(4);
  await expect.poll(async () => (await shapes(observer)).map((s) => s.id).sort()).toEqual([rect.id, ellipse.id].sort());
  await expectConverged([fresh, observer]);
  expect(await createsPerShape(boardId, [rect.id, ellipse.id])).toEqual({ [rect.id]: 1, [ellipse.id]: 1 });
  await savedOps(fresh, 0);
});
