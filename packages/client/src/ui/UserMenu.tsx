import type { User } from '../api';
import { Avatar } from './Avatar';

export function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <div className="user-menu">
      <span className="user-name" title={user.email}>
        <Avatar name={user.name} size={26} />
        <span className="user-name-text">{user.name}</span>
      </span>
      <button type="button" className="ghost-button" onClick={onLogout}>
        Log out
      </button>
    </div>
  );
}
