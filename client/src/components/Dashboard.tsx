import type {
  CaseRow,
  DashboardStats,
  MovementRow,
  AlertRow,
  CaseStatus,
} from '../types';
import { RegisterTable } from './RegisterTable';
import {
  FilterButton, FilterPanel, parseDMY,
  type SectionOpt,
} from './FiltersBar';
import { api } from '../api';
import { useState, useMemo, useEffect } from 'react';

interface Props {
  stats: DashboardStats;
  movements: MovementRow[];
  alerts: AlertRow[];
  totalCases: number;
  cases: CaseRow[];
  onStatClick: (target: 'all' | 'pending' | 'expert' | 'fsl' | 'transfer' | 'inspection') => void;
  onOpenTag: (c: CaseRow) => void;
  onOpenTimeline: (fir: string) => void;
  onOpenScan: () => void;
  onOpenRegister: () => void;
  onChangeStatus: (c: CaseRow) => void;
  onDownloadReport: (format: 'xlsx' | 'pdf' | 'html') => void;
}

type TileId = 'all' | 'pending' | 'expert' | 'fsl' | 'transfer' | 'inspection';

interface TileSpec {
  id: TileId;
  label: string;
  value: string;
  foot: string;
  urgent?: boolean;
  hint: string;   // visible hint on hover
}

export function Dashboard({
  stats, movements, alerts, totalCases, cases,
  onStatClick, onOpenTag, onOpenTimeline,
  onOpenScan, onOpenRegister, onChangeStatus, onDownloadReport,
}: Props) {
  const MOVE_PAGE_SIZE = 5;
  const [movePage, setMovePage] = useState(1);

  // ---- filter state (shared with Case Property via FiltersBar) ----
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selSections, setSelSections] = useState<string[]>([]);
  const [selStatuses, setSelStatuses] = useState<CaseStatus[]>([]);

  // distinct sections present in the data (Section-wise filter options)
  const sectionOptions: SectionOpt[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cases) {
      if (c.section && !map.has(c.section)) map.set(c.section, c.sectionName || c.section);
    }
    return Array.from(map.entries()).map(([letter, name]) => ({
      letter,
      name,
      label: `${letter.replace('PART ', '')} · ${name}`,
    }));
  }, [cases]);

  const filtered = useMemo(() => {
    let out = cases;
    if (selSections.length) out = out.filter(c => selSections.includes(c.section));
    if (selStatuses.length) out = out.filter(c => selStatuses.includes(c.status));
    const from = parseDMY(dateFrom);
    const to = parseDMY(dateTo);
    if (from || to) {
      out = out.filter(c => {
        if (!c.firDate) return false;
        const t = Date.parse(c.firDate + 'T00:00:00');
        if (isNaN(t)) return false;
        if (from && t < Date.parse(from + 'T00:00:00')) return false;
        if (to && t > Date.parse(to + 'T23:59:59')) return false;
        return true;
      });
    }
    return out;
  }, [cases, selSections, selStatuses, dateFrom, dateTo]);

  // "Recent Movement Activity" should follow the active filter too — fetch
  // movements for just the filtered case ids whenever the set changes.
  const [filteredMovements, setFilteredMovements] = useState<MovementRow[]>(movements);
  useEffect(() => {
    let alive = true;
    const ids = filtered.map(c => c.id);
    // No filter (or no cases): reuse the station-wide recent movements from
    // the boot payload so we don't double-fetch.
    if (ids.length === cases.length || ids.length === 0) {
      setFilteredMovements(movements);
      return;
    }
    api.movementsFor(ids, 50)
      .then(rows => { if (alive) setFilteredMovements(rows); })
      .catch(() => { if (alive) setFilteredMovements(movements); });
    return () => { alive = false; };
  }, [filtered, cases.length, movements]);

  // Stat tiles recompute from the filtered set so every number on the
  // dashboard reflects the active date/section/status filter.
  const num = (s: CaseStatus) => filtered.filter(c => c.status === s).length;
  const filteredStats = {
    totalProperty: filtered.length,
    pendingDisposal: filtered.filter(c => c.status !== 'Disposed').length,
    expertPending: num('Expert Opinion Pending'),
    withFSL: num('With FSL'),
    transfers: num('Transfer'),
  };

  const activeCount =
    ((dateFrom || dateTo) ? 1 : 0) +
    (selSections.length ? 1 : 0) +
    (selStatuses.length ? 1 : 0);

  const dateText =
    dateFrom && dateTo ? `${dateFrom} → ${dateTo}`
      : dateFrom ? `from ${dateFrom}`
        : dateTo ? `until ${dateTo}` : '';

  function clearAll() {
    setDateFrom(''); setDateTo(''); setSelSections([]); setSelStatuses([]);
    setShowFilters(false);
  }
  function toggleSection(letter: string) {
    setSelSections(p => p.includes(letter) ? p.filter(x => x !== letter) : [...p, letter]);
  }
  function toggleStatus(s: CaseStatus) {
    setSelStatuses(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  }

  const filterButton = (
    <FilterButton activeCount={activeCount} open={showFilters} onToggle={() => setShowFilters(o => !o)} />
  );
  const filterPanel = showFilters && (
    <FilterPanel
      dateFrom={dateFrom} setDateFrom={setDateFrom}
      dateTo={dateTo} setDateTo={setDateTo}
      sectionOptions={sectionOptions}
      selSections={selSections} toggleSection={toggleSection}
      selStatuses={selStatuses} toggleStatus={toggleStatus}
      onClearAll={clearAll}
    />
  );

  const moveTotalPages = Math.max(1, Math.ceil(filteredMovements.length / MOVE_PAGE_SIZE));
  const moveSafePage = Math.min(movePage, moveTotalPages);
  const moveShown = filteredMovements.slice((moveSafePage - 1) * MOVE_PAGE_SIZE, moveSafePage * MOVE_PAGE_SIZE);
  const tiles: TileSpec[] = [
    { id: 'all',        label: 'Total Case Property',     value: String(filteredStats.totalProperty), foot: 'Across all sections', hint: 'Open the full Case Property register' },
    { id: 'pending',    label: 'Pending Disposal',        value: String(filteredStats.pendingDisposal), foot: 'All stages except Disposed', urgent: true, hint: 'Show all cases except those with status "Disposed"' },
    { id: 'expert',     label: 'Expert Opinion Pending',  value: String(filteredStats.expertPending),   foot: 'Viscera / chemical samples', hint: 'Show only cases with status "Expert Opinion Pending"' },
    { id: 'fsl',        label: 'With FSL',                value: String(filteredStats.withFSL),         foot: 'Sent, report awaited', hint: 'Show only cases with status "With F. S. L."' },
    { id: 'transfer',   label: 'Transfer',               value: String(filteredStats.transfers ?? 0),  foot: 'In transit between locations', hint: 'Show only cases currently marked "Transfer"' },
    { id: 'inspection', label: 'Inspection Due',          value: stats.inspectionDue,           foot: 'Quarterly malkhana check', urgent: true, hint: 'Open the Alerts page' },
  ];

  return (
    <div className="view active" id="view-dashboard">
      <div className="page-head">
        <div>
          <h1>Malkhana Dashboard</h1>
          <div className="sub">
            {stats.station} &nbsp;·&nbsp; As of {stats.asOf}
          </div>
        </div>
        <div className="dash-head-actions">
          <button className="btn scan-btn" type="button" onClick={onOpenScan}>
            Scan QR
          </button>
        </div>
      </div>

      {/* Active-filter summary chips */}
      {activeCount > 0 && (
        <div className="section-banner" style={{ background: 'rgba(140,122,84,0.10)', borderColor: 'var(--khaki)' }}>
          Filters active:{' '}
          {dateText && (
            <span className="cfp-chip">Date: <b>{dateText}</b>
              <button className="section-banner-clear" onClick={() => { setDateFrom(''); setDateTo(''); }}>×</button>
            </span>
          )}
          {selSections.map(sec => {
            const o = sectionOptions.find(x => x.letter === sec);
            return (
              <span key={sec} className="cfp-chip">{o ? o.label : sec}
                <button className="section-banner-clear" onClick={() => toggleSection(sec)}>×</button>
              </span>
            );
          })}
          {selStatuses.map(st => (
            <span key={st} className="cfp-chip">{st}
              <button className="section-banner-clear" onClick={() => toggleStatus(st)}>×</button>
            </span>
          ))}
          <button className="section-banner-clear" onClick={clearAll}>Clear all</button>
        </div>
      )}

      <div className="stat-row">
        {tiles.map(t => (
          <button
            key={t.id}
            type="button"
            className={`stat-tile clickable${t.urgent ? ' urgent' : ''}`}
            title={t.hint}
            onClick={() => onStatClick(t.id)}
          >
            <div className="label">{t.label}</div>
            <div className={`value${t.urgent ? ' urgent' : ''}`}>{t.value}</div>
            <div className="foot">{t.foot}</div>
            <div className="stat-tile-arrow" aria-hidden="true">→</div>
          </button>
        ))}
      </div>

      {/* Case Property Register — embedded on the dashboard (compact: shows
          the 8 most recent items + a "View full register →" link).  Shown
          right after the stat tiles so the register is prominent at the top;
          Recent Movement Activity + Priority Alerts sit at the bottom. */}
      <RegisterTable
        cases={filtered}
        compact
        filterButton={filterButton}
        filterPanel={filterPanel}
        onOpenTag={onOpenTag}
        onOpenTimeline={onOpenTimeline}
        onOpenScan={onOpenScan}
        onOpenRegister={onOpenRegister}
        onChangeStatus={onChangeStatus}
        onDownloadReport={onDownloadReport}
      />

      <div className="panel">
        <div className="panel-head">
          <h2>Recent Movement Activity</h2>
        </div>
        {moveTotalPages > 1 && (
          <div className="rt-pager">
            <button className="pg-btn" disabled={moveSafePage === 1} onClick={() => setMovePage(p => Math.max(1, p - 1))} title="Previous">‹ Prev</button>
            {Array.from({ length: moveTotalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === moveTotalPages || (p >= moveSafePage - 2 && p <= moveSafePage + 2))
              .map((p, idx, arr) => (
                <span key={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {idx > 0 && p !== arr[idx - 1] + 1 && <span className="pg-ellipsis">…</span>}
                  <button className={`pg-btn${p === moveSafePage ? ' active' : ''}`} onClick={() => setMovePage(p)}>{p}</button>
                </span>
              ))}
            <button className="pg-btn" disabled={moveSafePage === moveTotalPages} onClick={() => setMovePage(p => Math.min(moveTotalPages, p + 1))} title="Next">Next ›</button>
            <span className="pg-info">Page {moveSafePage} of {moveTotalPages} · {filteredMovements.length} entries</span>
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>FIR / DD No.</th>
              <th>Item</th>
              <th>Movement</th>
              <th>By</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {moveShown.map(m => (
              <tr key={m.fir + m.time}>
                <td className="fir">{m.fir}</td>
                <td>{m.item}</td>
                <td>{m.movement}</td>
                <td>{m.by}</td>
                <td>{m.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Priority Alerts</h2>
          <span className="meta">
            <a
              href="#"
              onClick={e => { e.preventDefault(); onStatClick('inspection'); }}
              style={{ color: 'var(--ink-navy)' }}
            >
              View all →
            </a>
          </span>
        </div>
        {alerts.map((a, i) => (
          <div key={i} className={`alert-row${a.level === 'warn' ? ' warn' : ''}`}>
            <div className="alert-icon">{a.level === 'warn' ? 'i' : '!'}</div>
            <div className="alert-body">
              <div className="title">{a.title}</div>
              <div className="desc">{a.desc}</div>
            </div>
            <div className="alert-days">{a.days}</div>
          </div>
        ))}
      </div>

      {/* Reference data: kept for internal use (no UI shown) */}
      <span style={{ display: 'none' }} data-total={totalCases}></span>
    </div>
  );
}
