import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BoardSummary, User } from '../api';
import { openBoard } from '../boardId';
import { UserMenu } from './UserMenu';

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
    <main className="page boards">
      <header>
        <h1>Your boards</h1>
        <UserMenu user={user} onLogout={onLogout} />
      </header>
      <button type="button" onClick={() => void create()}>
        New board
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {boards && boards.length === 0 && <p>No boards yet.</p>}
      <ul>
        {boards?.map((b) => (
          <li key={b.id}>
            <a href={`?board=${b.id}`}>{b.title}</a> <span className="role">{b.role}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
