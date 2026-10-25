import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Member, ShareLink } from '../api';
import { shareUrl } from '../boardId';
import { Avatar } from './Avatar';

type InviteRole = 'editor' | 'viewer';

const ERRORS: Record<string, string> = {
  user_not_found: 'No account uses that email. They need to sign up first, or use the link.',
  cannot_change_owner: "The owner's role can't be changed.",
  invalid_input: 'Check the email address.',
};

/**
 * Owner-only sharing (system-design.md, "REST API"): invite by email with a role, change or
 * remove members, and a share link that anyone logged in can use to join with its role.
 * Changing the link's role or turning it off makes a new token, so old links stop working.
 * Role changes and removals reach the member's open tabs immediately (server side).
 */
export function ShareDialog({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [link, setLinkState] = useState<ShareLink | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const [m, l] = await Promise.all([api.listMembers(boardId), api.getLink(boardId)]);
    if (m.ok) setMembers(m.data.members);
    if (l.ok) setLinkState(l.data.link);
    if (!m.ok || !l.ok) setError('Could not load sharing settings.');
  }, [boardId]);

  useEffect(() => {
    void reload();
    dialog.current?.focus();
  }, [reload]);

  const fail = (code: string) => setError(ERRORS[code] ?? 'Something went wrong. Try again.');

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await api.addMember(boardId, email.trim(), role);
    if (!res.ok) return fail(res.error);
    setEmail('');
    await reload();
  };

  const changeRole = async (userId: string, next: InviteRole) => {
    setError(null);
    const res = await api.setMemberRole(boardId, userId, next);
    if (!res.ok) return fail(res.error);
    await reload();
  };

  const remove = async (userId: string) => {
    setError(null);
    const res = await api.removeMember(boardId, userId);
    if (!res.ok) return fail(res.error);
    await reload();
  };

  const setLink = async (next: InviteRole | null) => {
    setError(null);
    setCopied(false);
    const res = await api.setLink(boardId, next);
    if (!res.ok) return fail(res.error);
    setLinkState(res.data.link);
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(shareUrl(link.token));
      setCopied(true);
    } catch {
      setError('Could not copy: select the link and copy it yourself.');
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="dialog share-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Share board"
        tabIndex={-1}
        // Keys typed here are for the dialog, not the board's shortcuts.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <header>
          <div>
            <h2>Share board</h2>
            <p className="muted">Invite people by email, or turn on a link anyone can join with.</p>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>
            Close
          </button>
        </header>

        <form onSubmit={(e) => void invite(e)} className="invite">
          <input type="email" required placeholder="Email address" aria-label="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Invite as" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button type="submit" className="primary-button">
            Invite
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <h3 className="section-title">People with access</h3>
        <ul className="members" aria-label="Members">
          {members?.map((m) => (
            <li key={m.id}>
              <Avatar name={m.name} size={32} />
              <span className="member-name">
                {m.name} <span className="member-email">{m.email}</span>
              </span>
              {m.role === 'owner' ? (
                <span className="role">owner</span>
              ) : (
                <>
                  <select aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => void changeRole(m.id, e.target.value as InviteRole)}>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button type="button" className="link" onClick={() => void remove(m.id)} aria-label={`Remove ${m.name}`}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        <h3 className="section-title">Share link</h3>
        <section className="share-link" aria-label="Share link">
          <label className="toggle">
            <input type="checkbox" checked={link !== null} onChange={(e) => void setLink(e.target.checked ? 'viewer' : null)} />
            Anyone with the link can join as
          </label>
          <select aria-label="Link role" value={link?.role ?? 'viewer'} disabled={!link} onChange={(e) => void setLink(e.target.value as InviteRole)}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          {link && (
            <div className="link-row">
              <input readOnly aria-label="Share link URL" value={shareUrl(link.token)} onFocus={(e) => e.target.select()} />
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" onClick={() => void setLink(link.role)} title="Make a new link; the old one stops working">
                Reset link
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
