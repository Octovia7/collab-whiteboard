import { useCallback, useSyncExternalStore } from 'react';
import type { ConnectionStatus, SyncClient } from '../sync/SyncClient';

const LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline: edits will sync when you reconnect',
  disconnected: 'Disconnected',
};

const FINAL_REASONS: Record<string, string> = {
  board_deleted: 'This board was deleted',
  removed_from_board: 'You were removed from this board',
  logged_out: 'You were logged out',
};

/** Connection status and role: UI-level events React may subscribe to. */
export function ConnectionBadge({ sync, boardId }: { sync: SyncClient; boardId: string }) {
  const onStatus = useCallback((notify: () => void) => sync.events.on('status', notify), [sync]);
  const onRole = useCallback((notify: () => void) => sync.events.on('role', notify), [sync]);
  const status = useSyncExternalStore(onStatus, () => sync.status);
  const onSaving = useCallback((notify: () => void) => sync.events.on('saving', notify), [sync]);
  const role = useSyncExternalStore(onRole, () => sync.role);
  const paused = useSyncExternalStore(onSaving, () => sync.savingPaused);
  const label =
    status === 'disconnected'
      ? (FINAL_REASONS[sync.closeReason ?? ''] ?? LABELS.disconnected)
      : status === 'connected' && paused
        ? 'Saving paused: your edits are kept and will be saved when the server recovers'
        : LABELS[status];
  return (
    <div className={`connection ${status}${paused ? ' paused' : ''}`} role="status" title={`board ${boardId}`}>
      <span className="dot" />
      {label}
      {role === 'viewer' && <span className="view-only">View only</span>}
    </div>
  );
}
