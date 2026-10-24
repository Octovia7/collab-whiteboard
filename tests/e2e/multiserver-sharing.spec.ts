/**
 * Milestone 8 in real browsers: two servers sharing Postgres and Redis (tabs on :5199 talk to
 * server 1, tabs on :5200 to server 2), share links and the sharing dialog, live role changes
 * across servers, logout everywhere, and "Saving paused".
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { closeTabs, createBoard, drag, drawShape, expectConverged, newUser, outlinePoint, shapeById, shapes } from './helpers';
import { CLIENT_ORIGINS, restartServer, SERVER_PORTS } from './server';
import type { ServerNo } from './server';

test.afterEach(closeTabs);

const SCREENS = 'test-results/screens';

/** Opens a board in a new tab of `context`, served through server `n`, and waits for its welcome. */
async function openOn(context: BrowserContext, boardId: string, n: ServerNo): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  await page.goto(`${CLIENT_ORIGINS[n]}/?board=${boardId}`);
  await page.waitForFunction(() => window.__board?.status() === 'connected');
  return page;
}

const role = (page: Page) => page.evaluate(() => window.__board?.role());
const status = (page: Page) => page.evaluate(() => window.__board?.status());

test('tabs on different servers edit one board together and see each other', async ({ browser }) => {
  const owner = await newUser(browser, 'owner');
  const boardId = await createBoard(owner.context);
  const guest = await newUser(browser, 'guest');
  await owner.context.request.post(`/api/boards/${boardId}/members`, { data: { email: guest.user.email, role: 'editor' } });
  const a = await openOn(owner.context, boardId, 1);
  const b = await openOn(guest.context, boardId, 2);

  // The online list is shared through Redis: each tab lists the other person.
  await expect(a.getByRole('list', { name: 'Online' })).toContainText('guest');
  await expect(b.getByRole('list', { name: 'Online' })).toContainText('owner');

  const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  await expect.poll(async () => (await shapeById(b, rect.id))?.type).toBe('rect');
  const grab = await outlinePoint(b, rect);
  await drag(b, grab, { x: grab.x + 200, y: grab.y + 100 });
  await expect.poll(async () => (await shapeById(a, rect.id))?.x).toBe(rect.x + 200);
  const ellipse = await drawShape(b, 'Ellipse', { x: 600, y: 450 }, { x: 720, y: 530 });
  await expect.poll(async () => (await shapeById(a, ellipse.id))?.type).toBe('ellipse');
  await expectConverged([a, b]);

  // A live cursor crosses servers too.
  await a.mouse.move(500, 400);
  await a.mouse.move(520, 410, { steps: 3 });
  await expect.poll(() => b.evaluate(() => window.__board?.peers().some((p) => p.target !== null))).toBe(true);
  await b.screenshot({ path: `${SCREENS}/m8-two-servers-tabB.png` });
});

test('share link: the owner turns it on in the dialog; a new user opens it on the other server and edits', async ({ browser }) => {
  const owner = await newUser(browser, 'owner');
  const boardId = await createBoard(owner.context);
  const a = await openOn(owner.context, boardId, 1);

  await a.getByRole('button', { name: 'Share' }).click();
  const dialog = a.getByRole('dialog', { name: 'Share board' });
  // The checkbox and role reflect the server's answer, so wait for each change to land.
  const toggle = dialog.getByRole('checkbox');
  await toggle.click();
  await expect(toggle).toBeChecked();
  await dialog.getByLabel('Link role').selectOption('editor');
  await expect(dialog.getByLabel('Link role')).toHaveValue('editor'); // a new token comes with it
  const url = dialog.getByLabel('Share link URL');
  await expect(url).toHaveValue(/\?join=[A-Za-z0-9_-]{43}$/);
  const link = new URL(await url.inputValue());
  await a.screenshot({ path: `${SCREENS}/m8-share-dialog.png` });

  // A brand-new person opens the link through server 2: joined as editor, straight onto the board.
  const guest = await newUser(browser, 'guest');
  const g = await guest.context.newPage();
  await g.goto(`${CLIENT_ORIGINS[2]}/${link.search}`);
  await g.waitForFunction(() => window.__board?.status() === 'connected');
  expect(new URL(g.url()).searchParams.get('board')).toBe(boardId);
  expect(await role(g)).toBe('editor');
  const rect = await drawShape(g, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
  await expect.poll(async () => (await shapeById(a, rect.id))?.type).toBe('rect');

  // Resetting the link makes a new token: the old URL no longer works for anyone else.
  await dialog.getByRole('button', { name: 'Reset link' }).click();
  await expect(url).not.toHaveValue(link.href);
  const late = await newUser(browser, 'late');
  const l = await late.context.newPage();
  await l.goto(`${CLIENT_ORIGINS[1]}/${link.search}`);
  await expect(l.getByRole('alert')).toContainText('This link is invalid or was turned off');
});

test('invite, change role and remove from the dialog: the member’s tab on the other server follows live', async ({ browser }) => {
  const owner = await newUser(browser, 'owner');
  const boardId = await createBoard(owner.context);
  const member = await newUser(browser, 'member');
  const a = await openOn(owner.context, boardId, 1);

  await a.getByRole('button', { name: 'Share' }).click();
  const dialog = a.getByRole('dialog', { name: 'Share board' });
  await dialog.getByLabel('Email address').fill(member.user.email);
  await dialog.getByLabel('Invite as').selectOption('editor');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByRole('list', { name: 'Members' })).toContainText(member.user.email);

  const m = await openOn(member.context, boardId, 2);
  expect(await role(m)).toBe('editor');
  await dialog.getByLabel('Role of member').selectOption('viewer');
  await expect.poll(() => role(m)).toBe('viewer'); // pushed through Redis to server 2
  await expect(m.getByRole('status')).toContainText('View only');

  await dialog.getByRole('button', { name: 'Remove member' }).click();
  await expect.poll(() => status(m)).toBe('disconnected');
  await expect(m.getByRole('status')).toContainText('You were removed from this board');
});

test('logging out in one tab closes the session in a tab on the other server', async ({ browser }) => {
  const user = await newUser(browser, 'user');
  const boardId = await createBoard(user.context);
  const one = await openOn(user.context, boardId, 1);
  const two = await openOn(user.context, boardId, 2);

  await one.getByRole('button', { name: 'Log out' }).click();
  await expect(one.getByRole('heading', { name: 'Log in' })).toBeVisible();
  // Tab two never clicked anything: its socket was closed by server 2 (4001), and it went to the login page.
  await expect(two.getByRole('heading', { name: 'Log in' })).toBeVisible();
  // The old token is refused even if someone kept a copy of it.
  expect((await user.context.request.get('/api/me')).status()).toBe(401);
});

test.describe('saving paused', () => {
  test.describe.configure({ timeout: 120_000 });
  test.afterEach(async () => {
    await restartServer({}, 1);
  });

  test('when Postgres keeps failing, the tab shows "Saving paused", keeps its edits, and saves them on recovery', async ({ browser }) => {
    await restartServer({ SAVE_PAUSE_AFTER_MS: '1000', WB_FAULT_CONTROL: '1' }, 1);
    const owner = await newUser(browser, 'owner');
    const boardId = await createBoard(owner.context);
    const guest = await newUser(browser, 'guest');
    await owner.context.request.post(`/api/boards/${boardId}/members`, { data: { email: guest.user.email, role: 'editor' } });
    const a = await openOn(owner.context, boardId, 1);
    const b = await openOn(guest.context, boardId, 2);
    const faults = (failCommits: boolean) => owner.context.request.post(`http://127.0.0.1:${SERVER_PORTS[1]}/api/__test/faults`, { data: { failCommits } });

    expect((await faults(true)).ok()).toBe(true);
    const first = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 420, y: 330 });
    await expect.poll(async () => (await shapeById(b, first.id))?.type).toBe('rect'); // live relay goes on
    await expect(a.getByRole('status')).toContainText('Saving paused', { timeout: 10_000 });
    const second = await drawShape(a, 'Ellipse', { x: 600, y: 250 }, { x: 720, y: 330 });
    await a.screenshot({ path: `${SCREENS}/m8-saving-paused.png` });
    expect(await shapeById(b, second.id)).toBeUndefined(); // not accepted while paused
    expect(await a.evaluate(() => window.__board?.unacked())).toBeGreaterThan(0);

    expect((await faults(false)).ok()).toBe(true);
    await expect(a.getByRole('status')).toHaveText(/Connected/, { timeout: 15_000 });
    await expect.poll(async () => (await shapeById(b, second.id))?.type, { timeout: 10_000 }).toBe('ellipse');
    await expectConverged([a, b]);
    await a.reload();
    await a.waitForFunction(() => window.__board?.status() === 'connected');
    expect((await shapes(a)).map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
  });
});
