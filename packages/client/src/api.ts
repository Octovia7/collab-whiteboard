import type { Role } from '@whiteboard/shared';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface BoardSummary {
  id: string;
  title: string;
  role: Role;
  updatedAt: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** JSON over fetch; the session is an httpOnly cookie the browser sends by itself. */
async function request<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: 'network_error' };
  }
  const json = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  if (!res.ok) return { ok: false, status: res.status, error: String(json?.error ?? res.statusText) };
  return { ok: true, data: json as T };
}

export const api = {
  me: () => request<{ user: User }>('GET', '/api/me'),
  signup: (email: string, name: string, password: string) => request<{ user: User }>('POST', '/api/auth/signup', { email, name, password }),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => request<null>('POST', '/api/auth/logout'),
  listBoards: () => request<{ boards: BoardSummary[] }>('GET', '/api/boards'),
  createBoard: (title?: string) => request<{ board: BoardSummary }>('POST', '/api/boards', title ? { title } : {}),
  getBoard: (id: string) => request<{ board: BoardSummary }>('GET', `/api/boards/${encodeURIComponent(id)}`),
};
