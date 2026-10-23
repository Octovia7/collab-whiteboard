/**
 * Milestone 5: accounts, persistence across restarts and crashes, roles, snapshot loading.
 * These tests kill and restart the server (tests/e2e/server.ts), so each one leaves a normal
 * server running when it finishes.
 */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { WebSocket as NodeWebSocket } from 'ws';
import { keyBetween } from '@whiteboard/shared';
import type { Op, ServerMessage } from '@whiteboard/shared';
import { query } from '../integration/db';
import {
  closeTabs,
  createBoard,
  drag,
  drawShape,
  expectConverged,
  freshContext,
  joinTab,
  newUser,
  openBoardPage,
  openTabs,
  outlinePoint,
  PASSWORD,
  shapeById,
  shapes,
  snapshot,
  unacked,
} from './helpers';
import { CLIENT_ORIGIN, E2E_DB_URL, killServer, restartServer, SERVER_PORT, serverLogLength, serverLogSince, startServer } from './server';

test.afterEach(closeTabs);

const opRows = (boardId: string) =>
  query<{ op_id: string; kind: string; shape_id: string | null }>(
    E2E_DB_URL,
    "select op_id, op->>'kind' as kind, op->'shape'->>'id' as shape_id from board_ops where board_id = $1",
    [boardId],
  );

const waitConnected = (page: Page) => page.waitForFunction(() => window.__board?.status() === 'connected', undefined, { timeout: 20_000 });

/** Opens a socket straight to the server (no proxy), as a logged-in context's user. */
async function rawSocket(context: BrowserContext, boardId: string): Promise<NodeWebSocket> {
  const session = (await context.cookies()).find((c) => c.name === 'wb_session');
  return new NodeWebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws?board=${boardId}`, {
    headers: { origin: CLIENT_ORIGIN, ...(session ? { cookie: `wb_session=${session.value}` } : {}) },
  });
}

function upgradeStatus(ws: NodeWebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

test('1. sign up, log in, log out; a logged-out user cannot open a board', async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/m5-login.png' });

  // Sign up through the UI.
  const email = `ui-${Date.now().toString(36)}@e2e.test`;
  await page.getByRole('button', { name: 'No account? Sign up' }).click();
  await page.getByLabel('Name').fill('Uma');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
  await page.screenshot({ path: 'test-results/screens/m5-boards.png' });

  // Create a board and draw on it.
  await page.getByRole('button', { name: 'New board' }).click();
  await waitConnected(page);
  const boardId = new URL(page.url()).searchParams.get('board') ?? '';
  expect(boardId).toMatch(/^[0-9a-f-]{36}$/);
  const rect = await drawShape(page, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  await expectConverged([page]);

  // Log out: back to the login page, and the board is gone from the tab.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(await page.evaluate(() => window.__board === undefined)).toBe(true);
  // Without a session the server refuses the socket outright.
  expect(await upgradeStatus(await rawSocket(context, boardId))).toBe(401);

  // A wrong password is refused; the right one returns to the same board.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email or password.');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await waitConnected(page);
  expect((await shapes(page)).map((s) => s.id)).toEqual([rect.id]);

  // A different, logged-out browser sees the login page, not the board.
  const stranger = await (await freshContext(browser)).newPage();
  await stranger.goto(`/?board=${boardId}`);
  await expect(stranger.getByRole('heading', { name: 'Log in' })).toBeVisible();
  expect(await stranger.evaluate(() => window.__board === undefined)).toBe(true);

  // A logged-in non-member gets "no access", and the server refuses their socket too.
  const outsider = await newUser(browser, 'outsider');
  const outsiderPage = await outsider.context.newPage();
  await outsiderPage.goto(`/?board=${boardId}`);
  await expect(outsiderPage.getByRole('alert')).toContainText("don't have access");
  expect(await upgradeStatus(await rawSocket(outsider.context, boardId))).toBe(403);
});

test('2. draw, restart the server, reload: the board is identical', async ({ browser }) => {
  const t = await openTabs(browser, 1);
  const page = t.page(0);
  const rect = await drawShape(page, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  await drawShape(page, 'Ellipse', { x: 560, y: 250 }, { x: 700, y: 380 });
  const arrow = await drawShape(page, 'Arrow', { x: 300, y: 500 }, { x: 520, y: 580 });
  await page.keyboard.press('Delete'); // the arrow (still selected) becomes a tombstone
  const grab = await outlinePoint(page, rect);
  await drag(page, grab, { x: grab.x + 40, y: grab.y + 30 });
  await page.getByRole('button', { name: 'Color #1971c2' }).click();
  const before = await expectConverged([page]);
  expect(before.shapes.find((s) => s.id === arrow.id)?.regs.deleted?.value).toBe(true);

  await restartServer(); // SIGKILL: no graceful flush or snapshot
  await page.reload();
  await waitConnected(page);
  expect(await snapshot(page)).toEqual(before);
});

test.describe('3. a crash between sending an edit and its ack loses nothing and duplicates nothing', () => {
  // Each test kills and cold-starts the server (tsx compile) twice; reconnect backoff adds a few seconds.
  test.describe.configure({ timeout: 120_000 });
  test.afterEach(async () => {
    await restartServer(); // back to a server without fault injection
  });

  test('killed before the commit: the client resends after reconnecting', async ({ browser }) => {
    await restartServer({ WB_FAULT_COMMIT_DELAY_MS: '5000' });
    const t = await openTabs(browser, 2);
    const [a, b] = [t.page(0), t.page(1)];
    const rect = await drawShape(a, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
    // The server has it (B got the broadcast) but hasn't committed or acked it.
    await expect.poll(async () => (await shapeById(b, rect.id)) !== undefined).toBe(true);
    expect(await unacked(a)).toBeGreaterThan(0);
    expect(await opRows(t.boardId)).toEqual([]);

    await killServer();
    await startServer();
    // No reload: the tabs reconnect on their own and A resends its pending ops.
    await waitConnected(a);
    await waitConnected(b);
    const snap = await expectConverged([a, b]);
    expect(snap.shapes.map((s) => s.id)).toEqual([rect.id]);
    const rows = await opRows(t.boardId);
    expect(rows.filter((r) => r.kind === 'create')).toEqual([expect.objectContaining({ shape_id: rect.id })]);

    // And it is really durable: a fresh load shows it.
    await a.reload();
    await waitConnected(a);
    expect((await shapes(a)).map((s) => s.id)).toEqual([rect.id]);
  });

  test('killed after the commit, before the ack: the resend is not stored twice', async ({ browser }) => {
    await restartServer({ WB_FAULT_ACK_DELAY_MS: '5000' });
    const t = await openTabs(browser, 1);
    const a = t.page(0);
    const ellipse = await drawShape(a, 'Ellipse', { x: 300, y: 250 }, { x: 460, y: 360 });
    // Committed (in Postgres) but not acked.
    await expect.poll(async () => (await opRows(t.boardId)).some((r) => r.shape_id === ellipse.id)).toBe(true);
    await expect.poll(() => unacked(a)).toBeGreaterThan(0);
    const committed = (await opRows(t.boardId)).map((r) => r.op_id).sort();

    await killServer();
    await startServer();
    await waitConnected(a);
    await expectConverged([a]);
    const rows = await opRows(t.boardId);
    // Every op the client resent was already stored: no new rows, and one create.
    expect(rows.map((r) => r.op_id).sort()).toEqual(committed);
    expect(rows.filter((r) => r.kind === 'create')).toHaveLength(1);
    expect((await shapes(a)).map((s) => s.id)).toEqual([ellipse.id]);
  });
});

test('4. viewers get a read-only UI and see edits live; the server rejects their ops; role changes apply live', async ({ browser }) => {
  const t = await openTabs(browser, 1);
  const owner = t.page(0);
  const rect = await drawShape(owner, 'Rectangle', { x: 300, y: 250 }, { x: 460, y: 360 });
  const viewer = await joinTab(browser, t.boardId, t.owner, 'viewer');

  // Read-only mode: badge shown, drawing tools, colors and actions disabled.
  await expect(viewer.getByText('View only')).toBeVisible();
  await expect.poll(() => viewer.evaluate(() => window.__board?.readOnly())).toBe(true);
  for (const name of ['Rectangle', 'Ellipse', 'Arrow', 'Front', 'Back', 'Delete']) {
    await expect(viewer.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await expect(viewer.getByRole('button', { name: 'Color #e03131' })).toBeDisabled();

  // Clicking a shape selects nothing (no handles); dragging and shortcuts change nothing.
  const grab = await outlinePoint(viewer, rect);
  await viewer.mouse.click(grab.x, grab.y);
  expect(await viewer.evaluate(() => window.__board?.selection())).toEqual([]);
  await drag(viewer, grab, { x: grab.x + 100, y: grab.y + 50 });
  await drag(viewer, { x: 600, y: 250 }, { x: 760, y: 380 });
  for (const key of ['r', 'o', 'a', 'Delete', ']']) await viewer.keyboard.press(key);
  expect(await viewer.evaluate(() => window.__board?.tool())).toBe('select');
  expect(await unacked(viewer)).toBe(0); // nothing was even sent
  expect(await shapes(viewer)).toEqual(await shapes(owner));
  await viewer.screenshot({ path: 'test-results/screens/m5-viewer.png' });

  // Pan and zoom still work.
  const cam = await viewer.evaluate(() => window.__board?.camera());
  await viewer.mouse.move(640, 400);
  await viewer.mouse.wheel(0, -300);
  await expect.poll(async () => (await viewer.evaluate(() => window.__board?.camera()))?.zoom).toBeGreaterThan(cam?.zoom ?? 1);
  await viewer.keyboard.down('Space');
  await drag(viewer, { x: 600, y: 400 }, { x: 700, y: 400 });
  await viewer.keyboard.up('Space');
  expect((await viewer.evaluate(() => window.__board?.camera()))?.x).not.toBe(cam?.x);

  // Live edits still reach the viewer.
  const ellipse = await drawShape(owner, 'Ellipse', { x: 600, y: 250 }, { x: 760, y: 380 });
  await expect.poll(async () => (await shapeById(viewer, ellipse.id))?.type).toBe('ellipse');

  // A modified client can't bypass the UI: an op sent on the viewer's own session is rejected.
  const viewerContext = viewer.context();
  const ws = await rawSocket(viewerContext, t.boardId);
  const replies: ServerMessage[] = [];
  ws.on('message', (d) => replies.push(JSON.parse(String(d)) as ServerMessage));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', boardId: t.boardId, lastSeq: 0 }));
  await expect.poll(() => replies.some((m) => m.t === 'welcome')).toBe(true);
  ws.send(JSON.stringify({ t: 'ops', ops: [{ kind: 'update', opId: 'hack:1', stamp: { t: 999, client: 'hack' }, id: rect.id, props: { x: 5000 } }] }));
  await expect.poll(() => replies.find((m) => m.t === 'reject')).toMatchObject({ opId: 'hack:1', reason: 'forbidden' });
  ws.close();
  expect((await shapeById(owner, rect.id))?.x).toBe(rect.x);

  // Promote: read-only mode ends live, on the same page and socket, and edits go through.
  const members = (await (await t.owner.request.get(`/api/boards/${t.boardId}/members`)).json()) as { members: { id: string; role: string }[] };
  const viewerId = members.members.find((m) => m.role === 'viewer')?.id;
  const clientBefore = await viewer.evaluate(() => window.__board?.clientId);
  const promote = await t.owner.request.patch(`/api/boards/${t.boardId}/members/${viewerId}`, { data: { role: 'editor' } });
  expect(promote.status()).toBe(204);
  await expect(viewer.getByText('View only')).toBeHidden();
  await expect(viewer.getByRole('button', { name: 'Rectangle', exact: true })).toBeEnabled();
  const arrow = await drawShape(viewer, 'Arrow', { x: 300, y: 500 }, { x: 520, y: 580 });
  await expect.poll(async () => (await shapeById(owner, arrow.id))?.type).toBe('arrow');
  expect(await viewer.evaluate(() => window.__board?.selection())).toEqual([arrow.id]);

  // Demote again: back to read-only live, and the selection is dropped.
  await t.owner.request.patch(`/api/boards/${t.boardId}/members/${viewerId}`, { data: { role: 'viewer' } });
  await expect(viewer.getByText('View only')).toBeVisible();
  expect(await viewer.evaluate(() => window.__board?.selection())).toEqual([]);
  await expect(viewer.getByRole('button', { name: 'Rectangle', exact: true })).toBeDisabled();
  await expectConverged([owner, viewer]);
  expect(await viewer.evaluate(() => window.__board?.clientId)).toBe(clientBefore);
});

test('5. a board with 2,000+ ops loads from snapshot + tail; load time is logged', async ({ browser }) => {
  const owner = await newUser(browser, 'loader');
  const boardId = await createBoard(owner.context, 'Big board');

  // Feed 2,100 ops through the real protocol: 1,000 creates, then 1,100 moves.
  const ws = await rawSocket(owner.context, boardId);
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)) as ServerMessage);
    waiters.splice(0).forEach((w) => w());
  });
  const next = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const check = () => {
        const i = inbox.findIndex(pred);
        if (i >= 0) resolve(inbox.splice(i, 1)[0] as ServerMessage);
        else waiters.push(check);
      };
      check();
    });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', boardId, lastSeq: 0 }));
  await next((m) => m.t === 'welcome');

  const ops: Op[] = [];
  let t = 0;
  let z = '';
  for (let i = 1; i <= 1000; i++) {
    z = keyBetween(z, '');
    const col = i % 40;
    const row = Math.floor(i / 40);
    ops.push({ kind: 'create', opId: `loader:${++t}`, stamp: { t, client: 'loader' }, shape: { id: `loader-${i}`, type: i % 2 ? 'rect' : 'ellipse', x: col * 70, y: row * 70, w: 50, h: 40, color: '#1971c2', z } });
  }
  for (let i = 0; i < 1100; i++) {
    const id = `loader-${(i % 1000) + 1}`;
    ops.push({ kind: 'update', opId: `loader:${++t}`, stamp: { t, client: 'loader' }, id, props: { color: i % 2 ? '#e03131' : '#2f9e44' } });
  }
  for (let i = 0; i < ops.length; i += 100) {
    const batch = ops.slice(i, i + 100);
    ws.send(JSON.stringify({ t: 'ops', ops: batch }));
    const last = batch[batch.length - 1]?.opId;
    await next((m) => m.t === 'ack' && m.opIds.includes(last ?? ''));
  }
  ws.close();
  const snaps = await query<{ seq: string }>(E2E_DB_URL, 'select seq from board_snapshots where board_id = $1 order by seq', [boardId]);
  expect(snaps.length).toBeGreaterThanOrEqual(3);

  // Cold start: the room is not in memory, so opening the board loads it from Postgres.
  await killServer();
  const logOffset = serverLogLength();
  await startServer();
  const started = Date.now();
  const page = await openBoardPage(owner.context, boardId);
  await expect.poll(async () => (await shapes(page)).length, { timeout: 30_000 }).toBe(1000);
  const openMs = Date.now() - started;
  await page.screenshot({ path: 'test-results/screens/m5-big-board.png' });

  const loaded = serverLogSince(logOffset).find((l) => l.msg === 'board loaded' && l.boardId === boardId);
  expect(loaded).toBeDefined();
  const loadMs = Number(loaded?.board_load_ms);
  const snapshotSeq = Number(loaded?.snapshotSeq);
  const tailOps = Number(loaded?.tailOps);
  // Loaded from a snapshot plus a short tail, not by replaying all 2,100 ops.
  expect(snapshotSeq).toBeGreaterThanOrEqual(1500);
  expect(tailOps).toBeGreaterThan(0);
  expect(tailOps).toBeLessThan(600);
  expect(snapshotSeq + tailOps).toBe(2100);

  const numbers = { ops: 2100, shapes: 1000, snapshotSeq, tailOps, board_load_ms: loadMs, browser_open_to_rendered_ms: openMs };
  console.log('LOAD NUMBERS', JSON.stringify(numbers));
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/load-numbers.json', JSON.stringify(numbers, null, 2));
});
