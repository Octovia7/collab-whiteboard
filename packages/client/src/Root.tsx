import { useEffect, useState } from 'react';
import { api } from './api';
import type { BoardSummary, User } from './api';
import { App } from './App';
import { boardIdFromUrl, openBoardList } from './boardId';
import { AuthPage } from './ui/AuthPage';
import { BoardsPage } from './ui/BoardsPage';

type Auth = { kind: 'loading' } | { kind: 'anonymous' } | { kind: 'user'; user: User };

/**
 * Logged out -> login page (any ?board= stays in the URL, so logging in returns to it).
 * Logged in -> the board from ?board=, if you're a member, or your board list.
 */
export function Root() {
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });
  const boardId = boardIdFromUrl();

  useEffect(() => {
    void api.me().then((res) => setAuth(res.ok ? { kind: 'user', user: res.data.user } : { kind: 'anonymous' }));
  }, []);

  const logout = async () => {
    await api.logout();
    setAuth({ kind: 'anonymous' });
  };

  if (auth.kind === 'loading') return <main className="page">Loading…</main>;
  if (auth.kind === 'anonymous') return <AuthPage onAuthed={(user) => setAuth({ kind: 'user', user })} />;
  if (!boardId) return <BoardsPage user={auth.user} onLogout={() => void logout()} />;
  return <BoardGate boardId={boardId} user={auth.user} onLogout={() => void logout()} />;
}

/** Checks membership over REST before opening the socket, so a non-member sees a message, not a reconnect loop. */
function BoardGate({ boardId, user, onLogout }: { boardId: string; user: User; onLogout: () => void }) {
  const [board, setBoard] = useState<BoardSummary | null | 'missing'>(null);

  useEffect(() => {
    void api.getBoard(boardId).then((res) => setBoard(res.ok ? res.data.board : 'missing'));
  }, [boardId]);

  if (board === null) return <main className="page">Loading board…</main>;
  if (board === 'missing') {
    return (
      <main className="page">
        <p role="alert">This board doesn't exist, or you don't have access to it.</p>
        <button type="button" onClick={openBoardList}>
          Back to your boards
        </button>
      </main>
    );
  }
  return <App board={board} user={user} onLogout={onLogout} />;
}
