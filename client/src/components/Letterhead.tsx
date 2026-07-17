import type { Officer, User } from '../types';

interface Props {
  officer: Officer;
  user?: User | null;
  onLogout?: () => void;
  /** Show the hamburger button (mobile). When undefined the button is hidden. */
  onMenuToggle?: () => void;
  /** Whether the mobile drawer is currently open — controls the icon. */
  menuOpen?: boolean;
  /** Click on the emblem / title — navigate home (dashboard). */
  onHome?: () => void;
}

export function Letterhead({ officer, user, onLogout, onMenuToggle, menuOpen, onHome }: Props) {
  // Prefer the logged-in MM, fall back to the design's "RS" chip
  const initials = user?.initials ?? officer.initials;
  const name     = user?.name     ?? officer.name;
  const rank     = user?.designation
    ? `${user.rank} · ${user.designation}`
    : officer.rank;

  // The logo + title block is a clickable "home" affordance when onHome is wired.
  const homeClick = onHome
    ? { role: 'button', tabIndex: 0, onClick: onHome, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onHome(); } } }
    : {};

  return (
    <div className="letterhead">
      <div className="letterhead-left">
        {onMenuToggle && (
          <button
            type="button"
            className="letterhead-menu"
            onClick={onMenuToggle}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={!!menuOpen}
            title={menuOpen ? 'Close menu' : 'Open menu'}
          >
            <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span>
          </button>
        )}
        <div className="letterhead-home" {...homeClick} title="Go to Dashboard">
          <div className="emblem">HP</div>
          <div className="letterhead-title">
            <div className="line1">Haryana Police · Digital Records</div>
            <div className="line2">e-Malkhana</div>
          </div>
        </div>
      </div>
      <div className="letterhead-right">
        <div className="officer-chip" title={user ? `Signed in as ${user.id}` : undefined}>
          <div className="officer-avatar">{initials}</div>
          <div className="officer-meta">
            <div className="name">{name}</div>
            <div className="rank">{rank}</div>
          </div>
        </div>
        {user && onLogout && (
          <button
            className="btn logout-btn"
            onClick={onLogout}
            title={`Sign out ${user.id}`}
            aria-label="Sign out"
          >
            <span className="logout-icon" aria-hidden="true">⎋</span>
            <span className="logout-btn-label">Sign out</span>
          </button>
        )}
      </div>
    </div>
  );
}
