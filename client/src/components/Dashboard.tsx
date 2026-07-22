import type {
  CaseRow,
  DashboardStats,
  MovementRow,
  AlertRow,
} from '../types';
import { RegisterTable } from './RegisterTable';
import { useState } from 'react';
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
  onDownloadReport: (format: 'xlsx' | 'pdf') => void;
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
  const moveTotalPages = Math.max(1, Math.ceil(movements.length / MOVE_PAGE_SIZE));
  const moveSafePage = Math.min(movePage, moveTotalPages);
  const moveShown = movements.slice((moveSafePage - 1) * MOVE_PAGE_SIZE, moveSafePage * MOVE_PAGE_SIZE);
  const tiles: TileSpec[] = [
    { id: 'all',        label: 'Total Case Property',     value: String(stats.totalProperty), foot: 'Across all sections', hint: 'Open the full Case Property register' },
    { id: 'pending',    label: 'Pending Disposal',        value: String(stats.pendingDisposal), foot: 'All stages except Disposed', urgent: true, hint: 'Show all cases except those with status "Disposed"' },
    { id: 'expert',     label: 'Expert Opinion Pending',  value: String(stats.expertPending),   foot: 'Viscera / chemical samples', hint: 'Show only cases with status "Expert Opinion Pending"' },
    { id: 'fsl',        label: 'With FSL',                value: String(stats.withFSL),         foot: 'Sent, report awaited', hint: 'Show only cases with status "With FSL"' },
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
        <button className="btn scan-btn" type="button" onClick={onOpenScan}>
          Scan QR
        </button>
      </div>

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
        cases={cases}
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
