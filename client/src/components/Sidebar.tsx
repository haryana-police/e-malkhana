import { useEffect, useState } from 'react';
import type { RackItem, ViewName } from '../types';
import { api } from '../api';

interface Props {
  active: ViewName;
  onNav: (v: ViewName) => void;
  racks: RackItem[];
  onRacksChange: (racks: RackItem[]) => void;
  onOpenSettings: () => void;
  onOpenSectionsManager: () => void;
  activeSection: string | null;
  onSectionFilter: (letter: string | null) => void;
  user?: { id: string; name: string } | null;
  onLogout?: () => void;
}

const navItems: { view: ViewName; label: string }[] = [
  { view: 'dashboard',     label: 'Dashboard' },
  { view: 'caseproperty',  label: 'Case Property' },
  { view: 'movements',     label: 'Movements' },
  { view: 'alerts',        label: 'Alerts & Compliance' },
];

export function Sidebar({ active, onNav, racks, onRacksChange, onOpenSettings, onOpenSectionsManager, activeSection, onSectionFilter, user, onLogout }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(racks.map(r => [r.letter, r.name]))
  );
  useEffect(() => {
    setDraft(Object.fromEntries(racks.map(r => [r.letter, r.name])));
  }, [racks]);

  async function commit(letter: string) {
    const name = (draft[letter] ?? '').trim();
    if (!name || name === racks.find(r => r.letter === letter)?.name) return;
    try {
      const updated = await api.renameSection(letter, name);
      onRacksChange(racks.map(r => r.letter === updated.letter ? { ...r, name: updated.name } : r));
    } catch (e) {
      setDraft(d => ({ ...d, [letter]: racks.find(r => r.letter === letter)?.name ?? '' }));
      console.error(e);
    }
  }

  function onRackClick(letter: string) {
    // First click: switch to Case Property + filter by this section
    onNav('caseproperty');
    onSectionFilter(activeSection === letter ? null : letter);
  }

  return (
    <div className="sidebar">
      <div>
        <div className="side-section-label">Navigate</div>
        <div className="nav-list">
          {navItems.map(item => (
            <div
              key={item.view}
              className={`nav-item${active === item.view ? ' active' : ''}`}
              data-view={item.view}
              onClick={() => { onNav(item.view); onSectionFilter(null); }}
            >
              <span className="dot"></span>{item.label}
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="side-section-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Malkhana Sections</span>
          <span
            onClick={onOpenSettings}
            style={{ cursor: 'pointer', color: 'var(--paper-dark)' }}
            title="Configure alert thresholds"
          >⚙</span>
        </div>
        <div className="rack-list">
          {racks.map(r => {
            const isActive = activeSection === r.letter;
            return (
              <div
                key={r.letter}
                className={`rack-row${isActive ? ' active' : ''}`}
                style={{ cursor: 'pointer' }}
                onClick={() => onRackClick(r.letter)}
                title={`Show only Part ${r.letter} cases in Case Property`}
              >
                <div className="rack-letter">{r.letter}</div>
                <input
                  className="rack-name-input"
                  value={draft[r.letter] ?? r.name}
                  onChange={e => setDraft(d => ({ ...d, [r.letter]: e.target.value }))}
                  onBlur={() => commit(r.letter)}
                  onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  onClick={e => e.stopPropagation()}      // don't trigger row filter when editing
                />
                <span
                  className="rack-count"
                  onClick={e => { e.stopPropagation(); onRackClick(r.letter); }}
                  style={{ cursor: 'pointer' }}
                  title={`Filter to Part ${r.letter}`}
                >{r.count}</span>
              </div>
            );
          })}
        </div>
        <div className="rack-hint">
          Section names are editable per station. Click a row or count to filter
          the Case Property list to that section.
        </div>

        <button
          className="system-setting-btn"
          onClick={onOpenSectionsManager}
          title="Open the system settings for Malkhana sections"
        >
          <span className="system-setting-icon">⚙</span>
          <span className="system-setting-text">
            <span className="lbl">System Setting</span>
            <span className="desc">Edit Malkhana Sections</span>
          </span>
        </button>

        {user && onLogout && (
          <button
            className="sidebar-logout-btn"
            onClick={onLogout}
            title={`Sign out ${user.id}`}
            aria-label="Sign out"
          >
            <span className="sidebar-logout-icon" aria-hidden="true">⎋</span>
            <span className="sidebar-logout-text">
              <span className="lbl">Sign out</span>
              <span className="desc">End session · {user.id}</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
