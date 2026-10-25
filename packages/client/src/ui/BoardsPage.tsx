import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BoardSummary, User } from '../api';
import { openBoard } from '../boardId';
import { BoardIcon, Logo, PlusIcon } from './icons';
import { UserMenu } from './UserMenu';

/** "3 min ago", "yesterday", or a date: when a board was last changed. */
function updatedAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The boards you own or were invited to, newest first, plus "New board". */
export function BoardsPage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.listBoards().then((res) => (res.ok ? setBoards(res.data.boards) : setError('Could not load your boards.')));
  }, []);

  const create = async () => {
    const res = await api.createBoard();
    if (res.ok) openBoard(res.data.board.id);
    else setError('Could not create a board.');
  };

  return (
    <div className="boards-page">
      <nav className="top-bar">
        <div className="brand">
          <Logo size={28} />
          <span className="brand-name">Whiteboard</span>
        </div>
        <UserMenu user={user} onLogout={onLogout} />
      </nav>
      <main className="boards-main">
        <header className="boards-header">
          <div>
            <h1>Your boards</h1>
            <p className="muted">Boards you own or were invited to, most recently changed first.</p>
          </div>
          <button type="button" className="primary-button" onClick={() => void create()}>
            <PlusIcon />
            New board
          </button>
        </header>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {boards && boards.length === 0 && (
          <div className="empty-state">
            <BoardIcon />
            <p>No boards yet. Create one, then share it to draw together.</p>
          </div>
        )}
        <ul className="board-grid">
          {boards?.map((b) => (
            <li key={b.id}>
              <a className="board-card" href={`?board=${b.id}`}>
                <span className="board-card-preview" aria-hidden="true">
                  <BoardIcon />
                </span>
                <span className="board-card-title">{b.title}</span>
                <span className="board-card-meta">
                  <span className={`role-badge ${b.role}`}>{b.role}</span>
                  <span className="muted">Updated {updatedAgo(b.updatedAt)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
