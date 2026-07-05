import type { Officer, User } from '../types';

interface Props {
  officer: Officer;
  user?: User | null;
  onLogout?: () => void;
}

export function Letterhead({ officer, user, onLogout }: Props) {
  // Prefer the logged-in MM, fall back to the design's "RS" chip
  const initials = user?.initials ?? officer.initials;
  const name     = user?.name     ?? officer.name;
  const rank     = user?.designation
    ? `${user.rank} · ${user.designation}`
    : officer.rank;

  return (
    <div className="letterhead">
      <div className="letterhead-left">
        <div className="emblem">HP</div>
        <div className="letterhead-title">
          <div className="line1">Haryana Police · Digital Records</div>
          <div className="line2">e-Malkhana</div>
        </div>
      </div>
      <div className="letterhead-right">
        <div className="officer-chip" title={user ? `Signed in as ${user.id}` : undefined}>
          <div className="officer-avatar">{initials}</div>
          <div>
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
            <span>Sign out</span>
          </button>
        )}
      </div>
    </div>
  );
}
