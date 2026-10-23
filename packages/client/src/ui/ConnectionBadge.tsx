import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionStatus, SyncClient } from '../sync/SyncClient';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  // Automatic reconnect arrives in milestone 7.
  disconnected: 'Offline: reload to reconnect',
};

/** Connection status: one of the few UI-level events React subscribes to. */
export function ConnectionBadge({ sync, boardId }: { sync: SyncClient; boardId: string }) {
  const subscribe = useCallback((notify: () => void) => sync.events.on('status', notify), [sync]);
  const status = useSyncExternalStore(subscribe, () => sync.status);
  return (
    <div className={`connection ${status}`} role="status">
      <span className="dot" />
      {LABELS[status]} · board <code>{boardId}</code>
    </div>
  );
}
