import { boardIdSchema } from '@whiteboard/shared';

/**
 * The board to join comes from `?board=` in the URL. Without one (or with an invalid one),
 * a new random board id is put into the URL, so copying the URL into another tab or browser
 * opens the same board. Boards are created and shared over REST from milestone 5.
 */
export function boardIdFromUrl(): string {
  const url = new URL(window.location.href);
  const parsed = boardIdSchema.safeParse(url.searchParams.get('board'));
  if (parsed.success) return parsed.data;
  const id = crypto.randomUUID().slice(0, 8);
  url.searchParams.set('board', id);
  window.history.replaceState(null, '', url);
  return id;
}

export function socketUrl(boardId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Same origin: Vite proxies /ws to the server in dev, so cookies (milestone 5) just work.
  return `${proto}//${window.location.host}/ws?board=${encodeURIComponent(boardId)}`;
}
