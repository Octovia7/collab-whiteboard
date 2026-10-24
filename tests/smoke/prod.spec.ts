/**
 * Production smoke test: sign up, create a board, draw, reload, the shape is still there.
 * Runs against the real production stack (nginx + bundled server + Postgres + Redis), so it can
 * only use the UI and pixels: the production build exposes no debug handle.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Whether the scene canvas has a dark (non-background) pixel at screen point (x, y). */
async function inkAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([sx, sy]) => {
      const canvas = document.querySelector('.board canvas');
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      // Look in a small square: the outline is ~2 px wide.
      const d = ctx.getImageData(Math.round((sx as number) * dpr) - 3, Math.round((sy as number) * dpr) - 3, 7, 7).data;
      for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 100 && (d[i + 1] ?? 255) < 100 && (d[i + 2] ?? 255) < 100) return true;
      return false;
    },
    [x, y],
  );
}

test('sign up, draw, reload: the shape persists on the production stack', async ({ page, context }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    // The logged-out first load asks GET /api/me and gets the expected 401; Chrome logs that
    // as a console error. Anything else (CSP violations, script errors) fails the test.
    if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push(m.text());
  });
  const unauthorized: string[] = [];
  page.on('response', (r) => {
    if (r.status() === 401) unauthorized.push(new URL(r.url()).pathname);
  });
  page.on('pageerror', (e) => problems.push(e.message));

  // Security headers from nginx, and internal endpoints not exposed publicly.
  const home = await page.goto('/');
  expect(home?.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(home?.headers()['x-frame-options']).toBe('DENY');
  expect((await page.request.get('/metrics')).status()).toBe(404);
  expect((await page.request.get('/readyz')).status()).toBe(404);

  // Sign up through the UI.
  await page.getByRole('button', { name: 'No account? Sign up' }).click();
  await page.getByLabel('Name').fill('Smoke');
  await page.getByLabel('Email').fill(`smoke-${Date.now().toString(36)}@example.com`);
  await page.getByLabel('Password').fill('a-long-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();

  const session = (await context.cookies()).find((c) => c.name === 'wb_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });

  // New board, draw a rectangle.
  await page.getByRole('button', { name: 'New board' }).click();
  await expect(page.getByRole('status')).toContainText('Connected');
  expect(await inkAt(page, 300, 300)).toBe(false);
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(460, 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => inkAt(page, 300, 350)).toBe(true); // left edge
  // The offline queue opened under the production CSP (it saves unacked ops as they're made).
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toContain('whiteboard-offline');

  // A freehand stroke with the pen, below the rectangle.
  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await page.mouse.move(300, 550);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(300 + i * 10, 550 + Math.sin(i / 5) * 30);
  await page.mouse.up();
  await expect.poll(() => inkAt(page, 300, 550)).toBe(true);
  await page.waitForTimeout(1000); // let the acks arrive (they follow the Postgres commit)

  // Reload: the shape comes back from the server.
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Connected');
  await expect.poll(() => inkAt(page, 300, 350)).toBe(true);
  await expect.poll(() => inkAt(page, 460, 350)).toBe(true); // right edge
  expect(await inkAt(page, 380, 350)).toBe(false); // unfilled inside
  await expect.poll(() => inkAt(page, 300, 550)).toBe(true); // the pen stroke came back too
  await page.screenshot({ path: 'test-results/screens/prod-smoke.png' });

  expect(problems).toEqual([]);
  expect([...new Set(unauthorized)]).toEqual(['/api/me']); // only the logged-out session check
});
