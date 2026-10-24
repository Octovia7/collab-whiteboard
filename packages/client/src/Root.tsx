import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { BoardSummary, User } from './api';
import { App } from './App';
import { boardIdFromUrl, joinTokenFromUrl, openBoardList, replaceWithBoard } from './boardId';
import { AuthPage } from './ui/AuthPage';
import { BoardsPage } from './ui/BoardsPage';

type Auth = { kind: 'loading' } | { kind: 'anonymous' } | { kind: 'user'; user: User };

/**
 * Logged out -> login page (any ?board= or ?join= stays in the URL, so logging in returns to it).
 * Logged in -> a share link (?join=) joins its board and opens it; otherwise the board from
 * ?board=, if you're a member, or your board list.
 */
export function Root() {
  const [auth, setAuth] = useState<Auth>({ kind: 'loading' });
  const boardId = boardIdFromUrl();
  const joinToken = joinTokenFromUrl();

  useEffect(() => {
    void api.me().then((res) => setAuth(res.ok ? { kind: 'user', user: res.data.user } : { kind: 'anonymous' }));
  }, []);

  const logout = useCallback(async () => {
    await api.logout(); // a 401 here (already logged out elsewhere) is fine
    setAuth({ kind: 'anonymous' });
  }, []);
  const onLogout = useCallback(() => void logout(), [logout]);

  if (auth.kind === 'loading') return <main className="page">Loading…</main>;
  if (auth.kind === 'anonymous') return <AuthPage onAuthed={(user) => setAuth({ kind: 'user', user })} />;
  if (joinToken) return <JoinGate token={joinToken} />;
  if (!boardId) return <BoardsPage user={auth.user} onLogout={onLogout} />;
  return <BoardGate boardId={boardId} user={auth.user} onLogout={onLogout} />;
}

/** Follows a share link: joins the board with the link's role, then opens it. */
function JoinGate({ token }: { token: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api.join(token).then((res) => (res.ok ? replaceWithBoard(res.data.board.id) : setFailed(true)));
  }, [token]);

  if (!failed) return <main className="page">Joining board…</main>;
  return (
    <main className="page">
      <p role="alert">This link is invalid or was turned off. Ask the board's owner for a new one.</p>
      <button type="button" onClick={openBoardList}>
        Go to your boards
      </button>
    </main>
  );
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
