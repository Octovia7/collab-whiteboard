import type { User } from '../api';

export function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <div className="user-menu">
      <span className="user-name">{user.name}</span>
      <button type="button" onClick={onLogout}>
        Log out
      </button>
    </div>
  );
}
