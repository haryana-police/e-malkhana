import type { AlertRow } from '../types';

interface Props {
  alerts: AlertRow[];
  onOpenSettings: (tab?: 'thresholds' | 'fields' | 'backup' | 'log') => void;
  active?: boolean;
}

interface Group {
  title: string;
  meta: string;
  rows: AlertRow[];
}

export function Alerts({ alerts, onOpenSettings, active }: Props) {
  // Group alerts by category, mirroring the original layout exactly.
  const groups: Group[] = [
    {
      title: 'FSL Report Overdue',
      meta: 'Threshold: 30 days',
      rows: alerts.filter(a => a.title.toLowerCase().includes('fsl')),
    },
    {
      title: 'Expert Opinion Overdue',
      meta: 'Threshold: 15 days',
      rows: alerts.filter(a => a.title.toLowerCase().includes('expert')),
    },
    {
      title: 'Court Orders / Disposal Pending',
      meta: '11 items',
      rows: alerts.filter(a => a.title.toLowerCase().includes('court')
                                || a.title.toLowerCase().includes('disposal')),
    },
    {
      title: 'Inspection Reminders',
      meta: 'Quarterly cycle',
      rows: alerts.filter(a => a.title.toLowerCase().includes('inspection')
                                || a.title.toLowerCase().includes('quarterly')),
    },
  ];

  return (
    <div className={`view${active ? ' active' : ''}`} id="view-alerts">
      <div className="page-head">
        <div>
          <h1>Alerts &amp; Compliance</h1>
          <div className="sub">
            Auto-generated daily · thresholds configurable per category
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => onOpenSettings('thresholds')}>Configure threshold</button>
        </div>
      </div>

      {groups.map((g, gi) => (
        <div key={gi} className="panel">
          <div className="panel-head">
            <h2>{g.title}</h2>
            <span className="meta">{g.meta}</span>
          </div>
          {g.rows.length === 0 ? (
            <div className="alert-row warn">
              <div className="alert-icon">i</div>
              <div className="alert-body">
                <div className="title">No active alerts in this category</div>
                <div className="desc">All items within threshold.</div>
              </div>
            </div>
          ) : g.rows.map((a, i) => (
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
      ))}
    </div>
  );
}
