import { useEffect, useRef, useState } from 'react';
import type { RackItem, ViewName } from '../types';
import { api } from '../api';

interface Props {
  active: ViewName;
  onNav: (v: ViewName) => void;
  racks: RackItem[];
  onRacksChange: (racks: RackItem[]) => void;
  onOpenSettings: (tab?: 'thresholds' | 'fields' | 'backup' | 'log' | 'movements' | 'movementTypes') => void;
  onOpenSettingsFull: () => void;
  onOpenSectionsManager: () => void;
  onOpenItemTypeManager: () => void;
  activeSection: string | null;
  onSectionFilter: (letter: string | null) => void;
  user?: { id: string; name: string } | null;
  onLogout?: () => void;
  mobileOpen?: boolean;
    onCloseMobile?: () => void;
    onSettingsRoute?: boolean;
    onOpenSectionsManagerPage?: () => void;
  }

const navItems: { view: ViewName; label: string }[] = [
  { view: 'dashboard',     label: 'Case Property' },
  { view: 'templates',     label: 'Templates' },
  { view: 'alerts',        label: 'Alerts & Compliance' },
];

// Icon glyphs used by the collapsed mini-rail (desktop only).
const navIcons: Record<string, string> = {
  dashboard: '▦',
  templates: '▤',
  alerts:    '🔔',
};

export function Sidebar({ active, onNav, racks, onRacksChange, onOpenSettings, onOpenSettingsFull, onOpenSectionsManager, onOpenSectionsManagerPage, onOpenItemTypeManager, activeSection, onSectionFilter, user, onLogout, mobileOpen, onCloseMobile, onSettingsRoute }: Props) {
  // Live Activity-log entry count for the System Setting card badge.
  const [auditCount, setAuditCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.audit({ limit: 1 })
      .then(rows => { if (alive) setAuditCount(rows?.length ?? 0); })
      .catch(() => { if (alive) setAuditCount(null); });
    return () => { alive = false; };
  }, []);

  // ---- Mini-rail collapse / hover-expand (desktop ≥769px only) ----------
  // pinned    = user locked the sidebar permanently open (classic view).
  // collapsed = sidebar is in rail mode (64px icon buttons).
  // hoverOpen = mouse is over the rail → temporarily show the full detail
  //             view as an overlay (negative margin keeps layout at 64px so
  //             the dashboard content does NOT reflow on hover).
  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('emk.sidebar.pinned') === '1'; } catch { return false; }
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('emk.sidebar.pinned') !== '1'
          && localStorage.getItem('emk.sidebar.rail') === '1';
    } catch { return false; }
  });
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverT = useRef<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem('emk.sidebar.rail', collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);
  useEffect(() => () => { if (hoverT.current) window.clearTimeout(hoverT.current); }, []);

  const isDesktop = () => window.matchMedia('(min-width: 769px)').matches;

  /** Collapse to the icon rail after any navigation click (desktop, unpinned). */
  function collapseAfterNav() {
    if (!pinned && isDesktop()) { setCollapsed(true); setHoverOpen(false); }
  }

  function togglePin() {
    setPinned(p => {
      const next = !p;
      try { localStorage.setItem('emk.sidebar.pinned', next ? '1' : '0'); } catch { /* ignore */ }
      if (next) { setCollapsed(false); setHoverOpen(false); }   // pin ⇒ stay open
      else      { setCollapsed(true);  setHoverOpen(false); }   // unpin ⇒ show rail
      return next;
    });
  }

  function onRailEnter() {
    if (!collapsed) return;
    if (hoverT.current) { window.clearTimeout(hoverT.current); hoverT.current = null; }
    setHoverOpen(true);
  }
  function onRailLeave() {
    if (!collapsed) return;
    if (hoverT.current) window.clearTimeout(hoverT.current);
    hoverT.current = window.setTimeout(() => setHoverOpen(false), 300);
  }

  function onRackClick(letter: string) {
    // First click: switch to Case Property + filter by this section
    onNav('caseproperty');
    onSectionFilter(activeSection === letter ? null : letter);
    collapseAfterNav();
  }

  // Rail (icon-only) markup renders only when collapsed, not hover-expanded,
  // and NOT while the mobile drawer is open (drawer always shows full view).
  const rail = collapsed && !hoverOpen && !mobileOpen;

  const rootClass =
    `sidebar${mobileOpen ? ' mobile-open' : ''}` +
    `${collapsed ? ' rail-mode' : ''}` +
    `${rail ? ' rail' : ''}` +
    `${collapsed && hoverOpen ? ' hover-open' : ''}`;

  if (rail) {
    return (
      <div className={rootClass} onMouseEnter={onRailEnter} onMouseLeave={onRailLeave}>
        <button
          type="button"
          className="rail-btn rail-pin"
          onClick={togglePin}
          title="Pin sidebar open"
          aria-label="Pin sidebar open"
        >»</button>

        <div className="rail-group">
          {navItems.map(item => (
            <button
              key={item.view}
              type="button"
              className={`rail-btn${active === item.view ? ' active' : ''}`}
              title={item.label}
              onClick={() => { onNav(item.view); onSectionFilter(null); }}
            >
              <span aria-hidden="true">{navIcons[item.view]}</span>
            </button>
          ))}
        </div>

        <div className="rail-group">
          {racks.map(r => (
            <button
              key={r.letter}
              type="button"
              className={`rail-btn rail-rack${activeSection === r.letter ? ' active' : ''}`}
              title={`${r.name} (${r.count})`}
              onClick={() => onRackClick(r.letter)}
            >
              <span className="rail-letter">{r.letter}</span>
              <span className="rail-count">{r.count}</span>
            </button>
          ))}
        </div>

        <div className="rail-group rail-bottom">
          <button
            type="button"
            className="rail-btn"
            title="System Setting"
            onClick={() => onOpenSettingsFull()}
          >⚙</button>
          {user && onLogout && (
            <button
              type="button"
              className="rail-btn rail-logout"
              title={`Sign out ${user.id}`}
              onClick={onLogout}
            >⎋</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={rootClass} onMouseEnter={onRailEnter} onMouseLeave={onRailLeave}>
      <div>
        <div className="side-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Navigate</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="sidebar-pin-btn"
              onClick={togglePin}
              title={pinned
                ? 'Unpin — sidebar will collapse to an icon rail after you navigate'
                : 'Pin sidebar open (stop auto-collapse)'}
              aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
            >{pinned ? '«' : '📌'}</button>
            {onCloseMobile && (
              <button
                type="button"
                className="sidebar-close-btn"
                onClick={onCloseMobile}
                aria-label="Close navigation"
                title="Close"
              >×</button>
            )}
          </span>
        </div>
        <div className="nav-list">
          {navItems.map(item => (
            <div
              key={item.view}
              className={`nav-item${active === item.view ? ' active' : ''}`}
              data-view={item.view}
              onClick={() => { onNav(item.view); onSectionFilter(null); collapseAfterNav(); }}
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
            onClick={() => { onOpenSettingsFull(); collapseAfterNav(); }}
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
                <span
                  className="rack-name"
                  title={`Part ${r.letter} — ${r.name} (rename via Malkhana Locations in System Setting)`}
                >{r.name}</span>
                <span className="rack-count" title={`Filter to Part ${r.letter}`}>{r.count}</span>
              </div>
            );
          })}
        </div>
        <div className="rack-hint">
          Section names are editable per station (via Malkhana Locations in System
          Setting). Click a row or count to filter the Case Property list to that section.
        </div>

        <div className="system-setting-card">
          <div className="system-setting-head">
            <span className="system-setting-title">System Setting</span>
          </div>
          <div className="system-setting-list">
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => { onOpenSettings('fields'); collapseAfterNav(); }}
            >Item Type Fields</button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => { onOpenSettings('backup'); collapseAfterNav(); }}
            >Backup &amp; Restore</button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => { onOpenSettings('log'); collapseAfterNav(); }}
            >Activity log
              {auditCount != null && <span className="sys-setting-count">{auditCount}</span>}
            </button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => { onOpenSettings('movementTypes'); collapseAfterNav(); }}
              title="Configure the Move-to-status vocabulary"
            >Movement Types</button>
            <button
              type="button"
              className="sys-setting-item"
              onClick={() => { (onOpenSectionsManagerPage ? onOpenSectionsManagerPage() : onOpenSectionsManager()); collapseAfterNav(); }}
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
