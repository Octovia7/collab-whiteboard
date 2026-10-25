import { useCallback, useSyncExternalStore } from 'react';
import type { Presence } from '../store/Presence';
import { Avatar } from './Avatar';

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
          <Avatar name={u.name} color={u.color} size={28} />
          {/* Names are in the tooltip and for screen readers; the avatars carry the color. */}
          <span className="visually-hidden">{u.isYou ? 'You' : u.name}</span>
        </li>
      ))}
    </ul>
  );
}
