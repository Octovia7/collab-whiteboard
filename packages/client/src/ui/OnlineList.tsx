import { useCallback, useSyncExternalStore } from 'react';
import type { Presence } from '../store/Presence';

/**
 * Who's on this board: one entry per person (however many tabs), you first, in the color
 * their cursor uses. Re-renders only when people join or leave, never on cursor movement.
 */
export function OnlineList({ presence }: { presence: Presence }) {
  const subscribe = useCallback((notify: () => void) => presence.events.on('peers', notify), [presence]);
  const users = useSyncExternalStore(subscribe, () => presence.online());
  return (
    <ul className="online" aria-label="Online">
      {users.map((u) => (
        <li key={u.userId} title={u.isYou ? `${u.name} (you)` : u.name} style={{ borderColor: u.color }}>
          <span className="dot" style={{ background: u.color }} />
          {u.isYou ? 'You' : u.name}
        </li>
      ))}
    </ul>
  );
}
