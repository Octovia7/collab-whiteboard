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
