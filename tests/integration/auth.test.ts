import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { addMember, createBoard, ORIGIN, resetDb, settled, signUp, startServer, stopTabs, tab, waitFor } from './server';
import type { TestServer } from './server';

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(resetDb);
afterEach(stopTabs);

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: object) =>
  server.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });

/** Resolves with the HTTP status of a refused upgrade, or 101 if the socket opened. */
function upgradeStatus(boardId: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${server.port}/ws?board=${boardId}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

describe('accounts', () => {
  it('sign up, me, log out, log in', async () => {
    const { cookie } = await signUp(server, 'ada@test.local');
    expect((await inject('GET', '/api/me', cookie)).json()).toMatchObject({ user: { email: 'ada@test.local', name: 'ada' } });

    const logout = await inject('POST', '/api/auth/logout', cookie);
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.find((c) => c.name === 'wb_session')?.value).toBe('');

    const login = await inject('POST', '/api/auth/login', undefined, { email: 'ADA@test.local', password: 'password123' });
    expect(login.statusCode).toBe(200);
    const fresh = login.cookies.find((c) => c.name === 'wb_session');
    expect(fresh?.httpOnly).toBe(true);
    expect(fresh?.sameSite).toBe('Lax');
  });

  it('rejects bad credentials, duplicate emails and missing sessions', async () => {
    await signUp(server, 'ada@test.local');
    expect((await inject('POST', '/api/auth/login', undefined, { email: 'ada@test.local', password: 'wrong-password' })).statusCode).toBe(401);
    expect((await inject('POST', '/api/auth/login', undefined, { email: 'nobody@test.local', password: 'password123' })).json()).toEqual({ error: 'invalid_credentials' });
    expect((await inject('POST', '/api/auth/signup', undefined, { email: 'ada@test.local', name: 'x', password: 'password123' })).statusCode).toBe(409);
    expect((await inject('POST', '/api/auth/signup', undefined, { email: 'b@test.local', name: 'b', password: 'short' })).statusCode).toBe(400);
    expect((await inject('GET', '/api/me')).statusCode).toBe(401);
    expect((await inject('GET', '/api/me', 'wb_session=forged.token.here')).statusCode).toBe(401);
  });

  it('stores bcrypt hashes, never the password', async () => {
    const { user } = await signUp(server, 'ada@test.local');
    const row = await server.repo.findUserByEmail('ada@test.local');
    expect(row?.id).toBe(user.id);
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row?.passwordHash).not.toContain('password123');
  });
});

describe('boards and members', () => {
  it('lists my boards; non-members get 404', async () => {
    const ada = await signUp(server, 'ada@test.local');
    const bob = await signUp(server, 'bob@test.local');
    const id = await createBoard(server, ada.cookie);
    expect((await inject('GET', '/api/boards', ada.cookie)).json()).toMatchObject({ boards: [{ id, role: 'owner', title: 'Untitled board' }] });
    expect((await inject('GET', '/api/boards', bob.cookie)).json()).toEqual({ boards: [] });
    expect((await inject('GET', `/api/boards/${id}`, bob.cookie)).statusCode).toBe(404);
    await addMember(server, ada.cookie, id, 'bob@test.local', 'viewer');
    expect((await inject('GET', `/api/boards/${id}`, bob.cookie)).json()).toMatchObject({ board: { id, role: 'viewer' } });
    // Only the owner manages the board.
    expect((await inject('PATCH', `/api/boards/${id}`, bob.cookie, { title: 'mine now' })).statusCode).toBe(403);
    expect((await inject('POST', `/api/boards/${id}/members`, bob.cookie, { email: 'bob@test.local', role: 'editor' })).statusCode).toBe(403);
    expect((await inject('PATCH', `/api/boards/${id}/members/${ada.user.id}`, ada.cookie, { role: 'viewer' })).json()).toEqual({ error: 'cannot_change_owner' });
  });

  it('a deleted board disappears and its open sockets are closed', async () => {
    const ada = await signUp(server, 'ada@test.local');
    const id = await createBoard(server, ada.cookie);
    const t = await tab(server.port, id, ada.cookie, 'ada');
    expect((await inject('DELETE', `/api/boards/${id}`, ada.cookie)).statusCode).toBe(204);
    await waitFor(() => t.sync.status === 'disconnected', 'the socket to close');
    expect(t.sync.closeReason).toBe('board_deleted');
    expect((await inject('GET', '/api/boards', ada.cookie)).json()).toEqual({ boards: [] });
  });
});

describe('WebSocket upgrade', () => {
  it('needs a session, membership and an allowed Origin', async () => {
    const ada = await signUp(server, 'ada@test.local');
    const bob = await signUp(server, 'bob@test.local');
    const id = await createBoard(server, ada.cookie);
    expect(await upgradeStatus(id, { cookie: ada.cookie, origin: ORIGIN })).toBe(101);
    expect(await upgradeStatus(id, { origin: ORIGIN })).toBe(401); // logged out
    expect(await upgradeStatus(id, { cookie: bob.cookie, origin: ORIGIN })).toBe(403); // not a member
    expect(await upgradeStatus(id, { cookie: ada.cookie, origin: 'https://evil.example' })).toBe(403); // CSWSH
    expect(await upgradeStatus(id, { cookie: ada.cookie })).toBe(403); // no Origin at all
    expect(await upgradeStatus('not-a-uuid', { cookie: ada.cookie, origin: ORIGIN })).toBe(400);
  });

  it('viewers receive edits but their ops are rejected; a role change applies to the next batch', async () => {
    const ada = await signUp(server, 'ada@test.local');
    const bob = await signUp(server, 'bob@test.local');
    const id = await createBoard(server, ada.cookie);
    await addMember(server, ada.cookie, id, 'bob@test.local', 'viewer');
    const owner = await tab(server.port, id, ada.cookie, 'ada');
    const viewer = await tab(server.port, id, bob.cookie, 'bob');
    expect(viewer.sync.role).toBe('viewer');

    const shape = owner.store.makeCreate({ type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'black' });
    owner.store.submit([shape]);
    await waitFor(() => viewer.store.get(shape.shape.id) !== undefined, 'the viewer to see it live');

    viewer.store.submit([viewer.store.makeUpdate(shape.shape.id, { x: 500 })]);
    expect(viewer.store.get(shape.shape.id)?.x).toBe(500); // optimistic...
    await waitFor(() => viewer.store.get(shape.shape.id)?.x === 0 && settled(viewer), '...then rolled back');
    expect(owner.store.get(shape.shape.id)?.x).toBe(0);

    // Promote without reconnecting: the server pushes the role and checks it on the next batch.
    const patch = await inject('PATCH', `/api/boards/${id}/members/${bob.user.id}`, ada.cookie, { role: 'editor' });
    expect(patch.statusCode).toBe(204);
    await waitFor(() => viewer.sync.role === 'editor', 'the role push');
    viewer.store.submit([viewer.store.makeUpdate(shape.shape.id, { x: 77 })]);
    await waitFor(() => owner.store.get(shape.shape.id)?.x === 77 && settled(viewer), 'the edit to go through');

    // Demote again, then remove: the socket is closed for good.
    await inject('PATCH', `/api/boards/${id}/members/${bob.user.id}`, ada.cookie, { role: 'viewer' });
    await waitFor(() => viewer.sync.role === 'viewer', 'the demotion');
    await inject('DELETE', `/api/boards/${id}/members/${bob.user.id}`, ada.cookie);
    await waitFor(() => viewer.sync.status === 'disconnected', 'removal');
    expect(viewer.sync.closeReason).toBe('removed_from_board');
  });
});
