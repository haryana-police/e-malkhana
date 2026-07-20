import { useEffect, useState } from 'react';
import type { RackItem, ViewName } from '../types';
import { api } from '../api';

interface Props {
  active: ViewName;
  onNav: (v: ViewName) => void;
  racks: RackItem[];
  onRacksChange: (racks: RackItem[]) => void;
  onOpenSettings: (tab?: 'thresholds' | 'fields' | 'backup' | 'log') => void;
  onOpenSettingsFull: () => void;
  onOpenSectionsManager: () => void;
  onOpenItemTypeManager: () => void;
  activeSection: string | null;
  onSectionFilter: (letter: string | null) => void;
  user?: { id: string; name: string } | null;
  onLogout?: () => void;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

const navItems: { view: ViewName; label: string }[] = [
  { view: 'dashboard',     label: 'Case Property' },
  { view: 'templates',     label: 'Templates' },
  { view: 'alerts',        label: 'Alerts & Compliance' },
];

export function Sidebar({ active, onNav, racks, onRacksChange, onOpenSettings, onOpenSettingsFull, onOpenSectionsManager, onOpenItemTypeManager, activeSection, onSectionFilter, user, onLogout, mobileOpen, onCloseMobile }: Props) {
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

  // Live Activity-log entry count for the System Setting card badge.
  const [auditCount, setAuditCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.audit({ limit: 1 })
      .then(rows => { if (alive) setAuditCount(rows?.length ?? 0); })
      .catch(() => { if (alive) setAuditCount(null); });
    return () => { alive = false; };
  }, []);

  return (
    <div className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}>
      <div>
        <div className="side-section-label">
          <span>Navigate</span>
          {onCloseMobile && (
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={onCloseMobile}
              aria-label="Close navigation"
              title="Close"
            >×</button>
          )}
        </div>
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
          <span>Malkhana Locations</span>
          <span
            onClick={() => onOpenSettingsFull()}
            style={{ cursor: 'pointer', color: 'var(--paper-dark)' }}
            title="Open System Setting"
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

        <div className="system-setting-card">
          <div className="system-setting-head">
            <span className="system-setting-title">System Setting</span>
          </div>
          <div className="system-setting-list">
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => onOpenSettings('fields')}
            >Item Type Fields</button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => onOpenSettings('backup')}
            >Backup &amp; Restore</button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => onOpenSettings('log')}
            >Activity log
              {auditCount != null && <span className="sys-setting-count">{auditCount}</span>}
            </button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => onOpenSectionsManager()}
            >Malkhana Locations</button>
          </div>
        </div>

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
