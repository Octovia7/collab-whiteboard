/** The board to open comes from `?board=<uuid>`; without it the app shows the board list. */
export function boardIdFromUrl(): string | null {
  const id = new URL(window.location.href).searchParams.get('board');
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function openBoard(id: string): void {
  window.location.search = `?board=${encodeURIComponent(id)}`;
}

export function openBoardList(): void {
  window.location.search = '';
}

export function socketUrl(boardId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Same origin: Vite proxies /ws to the server in dev, so the session cookie is sent.
  return `${proto}//${window.location.host}/ws?board=${encodeURIComponent(boardId)}`;
}

/** A share link is `/?join=<token>` (43 base64url characters). */
export function joinTokenFromUrl(): string | null {
  const token = new URL(window.location.href).searchParams.get('join');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function shareUrl(token: string): string {
  return `${window.location.origin}/?join=${encodeURIComponent(token)}`;
}

/** Opens a board, replacing the current history entry (used after following a share link). */
export function replaceWithBoard(id: string): void {
  window.location.replace(`?board=${encodeURIComponent(id)}`);
}
