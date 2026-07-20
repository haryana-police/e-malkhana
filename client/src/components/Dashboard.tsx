import type {
  CaseRow,
  DashboardStats,
  MovementRow,
  AlertRow,
} from '../types';
import { RegisterTable } from './RegisterTable';

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
  onViewAll: () => void;
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
  onOpenScan, onOpenRegister, onChangeStatus, onDownloadReport, onViewAll,
}: Props) {
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
          <h1>Malkhana Overview</h1>
          <div className="sub">
            {stats.station} &nbsp;·&nbsp; As of {stats.asOf}
          </div>
        </div>
        {/* "+ Register New Case Property" button removed —
            registration now lives in the Case Property view. */}
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
        onViewAll={onViewAll}
      />

      <div className="panel">
        <div className="panel-head">
          <h2>Recent Movement Activity</h2>
          <span className="meta">Last 24 hours</span>
        </div>
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
            {movements.map(m => (
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
