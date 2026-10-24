/** Share links (system-design.md, "REST API"): turning them on and off, rotation, joining. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createBoard, resetDb, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

let s: TestServer;
beforeEach(async () => {
  await resetDb();
  s = await startServer();
});
afterEach(async () => {
  stopTabs();
  await s.close();
});

const call = (method: 'GET' | 'PUT' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  payload === undefined ? s.app.inject({ method, url, headers: { cookie } }) : s.app.inject({ method, url, headers: { cookie }, payload });
const setLink = async (boardId: string, cookie: string, role: 'viewer' | 'editor' | null) => {
  const res = await call('PUT', `/api/boards/${boardId}/link`, cookie, { role });
  expect(res.statusCode).toBe(200);
  return (res.json() as { link: { role: string; token: string } | null }).link;
};
const join = (token: string, cookie: string) => call('POST', `/api/join/${token}`, cookie);

describe('share links', () => {
  it('the owner turns a link on; anyone logged in who opens it becomes a member with its role', async () => {
    const owner = await signUp(s, 'owner@test.local');
    const guest = await signUp(s, 'guest@test.local');
    const boardId = await createBoard(s, owner.cookie);
    expect((await call('GET', `/api/boards/${boardId}/link`, owner.cookie)).json()).toEqual({ link: null });
    const link = await setLink(boardId, owner.cookie, 'editor');
    expect(link?.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect((await call('GET', `/api/boards/${boardId}/link`, owner.cookie)).json()).toEqual({ link });

    const res = await join(link?.token ?? '', guest.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ board: { id: boardId, role: 'editor' } });
    expect((await call('GET', `/api/boards/${boardId}`, guest.cookie)).statusCode).toBe(200);
  });

  it('changing the role or turning the link off invalidates the old token', async () => {
    const owner = await signUp(s, 'owner@test.local');
    const guest = await signUp(s, 'guest@test.local');
    const boardId = await createBoard(s, owner.cookie);
    const first = await setLink(boardId, owner.cookie, 'viewer');
    const second = await setLink(boardId, owner.cookie, 'editor');
    expect(second?.token).not.toBe(first?.token);
    expect((await join(first?.token ?? '', guest.cookie)).statusCode).toBe(404);
    expect(await setLink(boardId, owner.cookie, null)).toBeNull();
    expect((await join(second?.token ?? '', guest.cookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/boards/${boardId}`, guest.cookie)).statusCode).toBe(404);
  });

  it('only the owner manages the link; joining needs a session; bad tokens are 404', async () => {
    const owner = await signUp(s, 'owner@test.local');
    const editor = await signUp(s, 'editor@test.local');
    const boardId = await createBoard(s, owner.cookie);
    await addMember(s, owner.cookie, boardId, 'editor@test.local', 'editor');
    expect((await call('PUT', `/api/boards/${boardId}/link`, editor.cookie, { role: 'editor' })).statusCode).toBe(403);
    expect((await call('GET', `/api/boards/${boardId}/link`, editor.cookie)).statusCode).toBe(403);
    expect((await call('PUT', `/api/boards/${boardId}/link`, owner.cookie, { role: 'owner' })).statusCode).toBe(400);
    const link = await setLink(boardId, owner.cookie, 'viewer');
    expect((await s.app.inject({ method: 'POST', url: `/api/join/${link?.token}` })).statusCode).toBe(401);
    expect((await join('not-a-token', editor.cookie)).statusCode).toBe(404);
    expect((await join('A'.repeat(43), editor.cookie)).statusCode).toBe(404);
  });

  it('joining never lowers a role; an editor link raises a viewer, live on their open socket', async () => {
    const owner = await signUp(s, 'owner@test.local');
    const editor = await signUp(s, 'editor@test.local');
    const viewer = await signUp(s, 'viewer@test.local');
    const boardId = await createBoard(s, owner.cookie);
    await addMember(s, owner.cookie, boardId, 'editor@test.local', 'editor');
    await addMember(s, owner.cookie, boardId, 'viewer@test.local', 'viewer');

    const viewLink = await setLink(boardId, owner.cookie, 'viewer');
    expect((await join(viewLink?.token ?? '', editor.cookie)).json()).toMatchObject({ board: { role: 'editor' } });
    expect((await join(viewLink?.token ?? '', owner.cookie)).json()).toMatchObject({ board: { role: 'owner' } });

    const open = await tab(s.port, boardId, viewer.cookie, 'viewerTab');
    expect(open.sync.role).toBe('viewer');
    const editLink = await setLink(boardId, owner.cookie, 'editor');
    expect((await join(editLink?.token ?? '', viewer.cookie)).json()).toMatchObject({ board: { role: 'editor' } });
    await waitFor(() => open.sync.role === 'editor', 'the raised role to reach the open socket');
  });

  it('a link to a deleted board is dead', async () => {
    const owner = await signUp(s, 'owner@test.local');
    const guest = await signUp(s, 'guest@test.local');
    const boardId = await createBoard(s, owner.cookie);
    const link = await setLink(boardId, owner.cookie, 'editor');
    expect((await s.app.inject({ method: 'DELETE', url: `/api/boards/${boardId}`, headers: { cookie: owner.cookie } })).statusCode).toBe(204);
    expect((await join(link?.token ?? '', guest.cookie)).statusCode).toBe(404);
  });
});
