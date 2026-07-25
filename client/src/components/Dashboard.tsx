import type {
  CaseRow,
  DashboardStats,
  MovementRow,
  AlertRow,
  CaseStatus,
} from '../types';
import { RegisterTable } from './RegisterTable';
import { useState, useMemo, useRef } from 'react';

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

// ---- date helpers (DD-MM-YYYY <-> YYYY-MM-DD) -------------------------
function parseDMY(s: string): string | null {
  const m = String(s || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function toDMY(s: string): string {
  // accepts yyyy-mm-dd (from native date input) -> dd-mm-yyyy
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}
function isValidDMY(s: string): boolean {
  return s.trim() === '' || parseDMY(s) !== null;
}

// ---- inline SVGs (outline style matching the design system) ----------
function FunnelIcon() {
  return (
    <svg className="fb-ico" viewBox="0 0 24 24" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

// ---- a single DD-MM-YYYY date field with a calendar trigger ----------
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const dateRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="date-field">
      <input
        type="text"
        className={`date-input${value && !isValidDMY(value) ? ' invalid' : ''}`}
        placeholder="dd-mm-yyyy"
        value={value}
        inputMode="numeric"
        onChange={e => onChange(e.target.value)}
        aria-label="Date (dd-mm-yyyy)"
      />
      <button
        type="button"
        className="date-cal"
        aria-label="Pick date"
        onClick={() => {
          const el = dateRef.current;
          if (!el) return;
          if (typeof el.showPicker === 'function') el.showPicker();
          else el.click();
        }}
      >
        <CalendarIcon />
      </button>
      <input
        ref={dateRef}
        type="date"
        className="date-hidden"
        value={parseDMY(value) ?? ''}
        onChange={e => onChange(e.target.value ? toDMY(e.target.value) : '')}
      />
    </div>
  );
}

const ALL_STATUSES: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana', 'With FSL',
  'In Court', 'Disposed', 'Transfer',
];

export function Dashboard({
  stats, movements, alerts, totalCases, cases,
  onStatClick, onOpenTag, onOpenTimeline,
  onOpenScan, onOpenRegister, onChangeStatus, onDownloadReport,
}: Props) {
  const MOVE_PAGE_SIZE = 5;
  const [movePage, setMovePage] = useState(1);

  // ---- filter state ----
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selSections, setSelSections] = useState<string[]>([]);
  const [selStatuses, setSelStatuses] = useState<CaseStatus[]>([]);

  // distinct sections present in the data (Section-wise filter options)
  const sectionOptions = useMemo(() => {
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
  }
  function toggleSection(letter: string) {
    setSelSections(p => p.includes(letter) ? p.filter(x => x !== letter) : [...p, letter]);
  }
  function toggleStatus(s: CaseStatus) {
    setSelStatuses(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  }

  const moveTotalPages = Math.max(1, Math.ceil(movements.length / MOVE_PAGE_SIZE));
  const moveSafePage = Math.min(movePage, moveTotalPages);
  const moveShown = movements.slice((moveSafePage - 1) * MOVE_PAGE_SIZE, moveSafePage * MOVE_PAGE_SIZE);
  const tiles: TileSpec[] = [
    { id: 'all',        label: 'Total Case Property',     value: String(stats.totalProperty), foot: 'Across all sections', hint: 'Open the full Case Property register' },
    { id: 'pending',    label: 'Pending Disposal',        value: String(stats.pendingDisposal), foot: 'All stages except Disposed', urgent: true, hint: 'Show all cases except those with status "Disposed"' },
    { id: 'expert',     label: 'Expert Opinion Pending',  value: String(stats.expertPending),   foot: 'Viscera / chemical samples', hint: 'Show only cases with status "Expert Opinion Pending"' },
    { id: 'fsl',        label: 'With FSL',                value: String(stats.withFSL),         foot: 'Sent, report awaited', hint: 'Show only cases with status "With F. S. L."' },
    { id: 'transfer',   label: 'Transfer',               value: String(stats.transfers ?? 0),  foot: 'In transit between locations', hint: 'Show only cases currently marked "Transfer"' },
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
          <button
            type="button"
            className={`filter-btn${showFilters || activeCount ? ' active' : ''}`}
            onClick={() => setShowFilters(o => !o)}
            title="Filter the dashboard (date-wise, section-wise, status-wise)"
          >
            <FunnelIcon />
            <span>Filters</span>
            {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
          </button>
          <button className="btn scan-btn" type="button" onClick={onOpenScan}>
            Scan QR
          </button>
        </div>
      </div>

      {/* ===== Filter panel (date-wise · section-wise · status-wise) ===== */}
      {showFilters && (
        <div className="filter-pop">
          <div className="filter-grid">
            <div className="filter-col">
              <h4>Date-wise (FIR/DD date)</h4>
              <div className="date-range">
                <DateField value={dateFrom} onChange={setDateFrom} />
                <span className="date-dash">–</span>
                <DateField value={dateTo} onChange={setDateTo} />
              </div>
              <div className="f-range-text">
                {dateText ? `Range: ${dateText}` : 'All dates'}
              </div>
            </div>

            <div className="filter-col">
              <h4>Section-wise</h4>
              <div className="f-chips">
                {sectionOptions.map(o => (
                  <button
                    key={o.letter}
                    type="button"
                    className={`f-chip${selSections.includes(o.letter) ? ' on' : ''}`}
                    onClick={() => toggleSection(o.letter)}
                  >
                    {o.label}
                  </button>
                ))}
                {sectionOptions.length === 0 && <span className="f-empty">No sections</span>}
              </div>
            </div>

            <div className="filter-col">
              <h4>Status-wise</h4>
              <div className="f-chips">
                {ALL_STATUSES.map(s => (
                  <button
                    key={s}
                    type="button"
                    className={`f-chip${selStatuses.includes(s) ? ' on' : ''}`}
                    onClick={() => toggleStatus(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="filter-actions">
            <button type="button" className="btn small ghost" onClick={clearAll}>Clear all</button>
            <button type="button" className="btn small" onClick={() => setShowFilters(false)}>Done</button>
          </div>
        </div>
      )}

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
            <span className="pg-info">Page {moveSafePage} of {moveTotalPages} · {movements.length} entries</span>
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
