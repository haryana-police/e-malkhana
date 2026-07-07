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
  /** Manual refresh — re-fetch dashboard/cases/alerts from the API. */
  onRefresh?: () => void;
  /** Whether the refresh call is in flight (drives the spinner). */
  refreshing?: boolean;
  /** When the last refresh finished — shown as a subtle timestamp next to the button. */
  lastRefreshedAt?: Date | null;
}

export function Letterhead({ officer, user, onLogout, onMenuToggle, menuOpen, onHome, onRefresh, refreshing, lastRefreshedAt }: Props) {
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
        {/* Manual refresh — belt-and-suspenders for the rare case where the
            automatic reload on (re)login / write misses a beat (cold-start
            race, stale browser tab, sibling-tab edits).  Pure SVG so we
            don't pull in an icon library. */}
        {onRefresh && user && (
          <div className="letterhead-refresh" title={
            refreshing ? 'Refreshing…' :
            lastRefreshedAt ? `Last refreshed ${lastRefreshedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}` :
            'Refresh from server'
          }>
            <button
              type="button"
              className={`btn ghost icon-only${refreshing ? ' is-loading' : ''}`}
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh data from server"
              aria-busy={refreshing}
            >
              <svg
                className="refresh-icon"
                width="15" height="15" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
              >
                {/* 270° arc + arrowhead — turns into a circle when spinning */}
                <path d="M21 12a9 9 0 1 1-3.51-7.13" />
                <polyline points="21 4 21 9 16 9" />
              </svg>
            </button>
            {lastRefreshedAt && !refreshing && (
              <span className="refresh-stamp">
                {lastRefreshedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
              </span>
            )}
          </div>
        )}
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
