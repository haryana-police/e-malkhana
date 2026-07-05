import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AlertConfig, AuditEntry } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onUpdated: (cfg: AlertConfig) => void;
  onOpenSectionsManager?: () => void;
}

const ACTION_LABELS: Record<string, { label: string; tone: 'good' | 'warn' | 'info' | 'critical' }> = {
  'case.create':     { label: 'REGISTERED', tone: 'good' },
  'case.status':     { label: 'STATUS',     tone: 'info' },
  'movement.record': { label: 'MOVED',      tone: 'info' },
  'movement.log':    { label: 'LOG',        tone: 'info' },
  'scan.read':       { label: 'SCAN',       tone: 'info' },
  'scan.record':     { label: 'SCAN+MOVE',  tone: 'info' },
  'section.rename':  { label: 'SECTION',    tone: 'good' },
  'alerts.config':   { label: 'THRESHOLD',  tone: 'warn' },
  'file.upload':     { label: 'UPLOAD',     tone: 'info' },
  'login':           { label: 'LOGIN',      tone: 'good' },
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

export function SettingsModal({ open, onClose, onUpdated, onOpenSectionsManager }: Props) {
  const [tab, setTab] = useState<'thresholds' | 'log'>('thresholds');
  const [cfg, setCfg] = useState<AlertConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [logFilter, setLogFilter] = useState('');
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMsg(null);
      api.alertConfig().then(setCfg).catch(e => setMsg({ kind: 'error', text: (e as Error).message }));
      // load log when tab opened
      api.audit({ limit: 200 }).then(setLog).catch(e => setLogError((e as Error).message));
    }
  }, [open, tab]);

  if (!open) return null;

  function set<K extends keyof AlertConfig>(k: K, v: number | string) {
    if (!cfg) return;
    setCfg({ ...cfg, [k]: v });
  }

  async function save() {
    if (!cfg) return;
    setBusy(true); setMsg(null);
    try {
      const next = await api.updateAlerts(cfg);
      setCfg(next);
      onUpdated(next);
      setMsg({ kind: 'ok', text: 'Saved · alert scan re-ran.' });
      // refresh log so the change appears immediately
      api.audit({ limit: 200 }).then(setLog).catch(() => {});
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    api.alertConfig().then(setCfg).catch(() => {});
  }

  function refreshLog() {
    setLogError(null);
    api.audit({ limit: 200 }).then(setLog).catch(e => setLogError((e as Error).message));
  }

  const filteredLog = (log ?? []).filter(e => {
    if (!logFilter) return true;
    const f = logFilter.toLowerCase();
    return e.userId.toLowerCase().includes(f)
        || e.userName.toLowerCase().includes(f)
        || e.action.toLowerCase().includes(f)
        || e.target.toLowerCase().includes(f)
        || e.details.toLowerCase().includes(f);
  });

  // Summary counts per user (for the top-of-log strip)
  const userSummary: Record<string, number> = {};
  for (const e of (log ?? [])) userSummary[e.userId] = (userSummary[e.userId] || 0) + 1;

  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card audit-card">
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <h3>System Setting</h3>
        <div className="sub">
          Configure alert thresholds and review who made what changes —
          <b> every action is logged with the MM Login ID</b>.
        </div>

        <div className="audit-tabs">
          <button
            className={`audit-tab${tab === 'thresholds' ? ' active' : ''}`}
            onClick={() => setTab('thresholds')}
          >⚙ Alert thresholds</button>
          <button
            className={`audit-tab${tab === 'log' ? ' active' : ''}`}
            onClick={() => setTab('log')}
          >📜 Activity log <span className="audit-tab-count">{(log ?? []).length}</span></button>
          {onOpenSectionsManager && (
            <button
              className="audit-tab"
              type="button"
              onClick={() => { onOpenSectionsManager(); }}
              style={{ marginLeft: 'auto' }}
            >✏ Edit Malkhana Sections</button>
          )}
        </div>

        {tab === 'thresholds' && cfg && (
          <>
            <div className="settings-list">
              <div className="settings-row">
                <label>
                  FSL report overdue
                  <div className="help">Number of days before an FSL case triggers an alert.</div>
                </label>
                <input type="number" min={1} value={cfg.fslDays} onChange={e => set('fslDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
              </div>
              <div className="settings-row">
                <label>
                  Expert opinion overdue
                  <div className="help">Number of days before an Expert Opinion case is flagged.</div>
                </label>
                <input type="number" min={1} value={cfg.expertDays} onChange={e => set('expertDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
              </div>
              <div className="settings-row">
                <label>
                  Court-order / disposal overdue
                  <div className="help">Number of days before a case awaiting court order is flagged.</div>
                </label>
                <input type="number" min={1} value={cfg.courtDays} onChange={e => set('courtDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
              </div>
              <div className="settings-row">
                <label>
                  Quarterly inspection cycle
                  <div className="help">Cycle length for the next-due inspection alert.</div>
                </label>
                <input type="number" min={1} value={cfg.inspectionCycleDays} onChange={e => set('inspectionCycleDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
              </div>
              <div className="settings-row">
                <label>
                  Last inspection
                  <div className="help">Date of the most-recent quarterly inspection.</div>
                </label>
                <input type="date" value={cfg.lastInspection} onChange={e => set('lastInspection', e.target.value)} />
              </div>
            </div>
            {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}
            <div className="form-actions">
              <button className="btn ghost" onClick={reset} disabled={busy}>Reset</button>
              <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
              <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </>
        )}

        {tab === 'log' && (
          <>
            {Object.keys(userSummary).length > 0 && (
              <div className="audit-summary">
                <div className="audit-summary-label">Activity by MM Login ID</div>
                <div className="audit-summary-chips">
                  {Object.entries(userSummary).map(([uid, n]) => (
                    <button
                      key={uid}
                      className={`audit-chip${logFilter.toUpperCase() === uid ? ' active' : ''}`}
                      onClick={() => setLogFilter(logFilter.toUpperCase() === uid ? '' : uid)}
                    >
                      <span className="chip-id">{uid}</span>
                      <span className="chip-n">{n}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="scan-bar">
              <span className="scan-label">Filter</span>
              <input
                placeholder="Filter by MM id, name, action, target, details…"
                value={logFilter}
                onChange={e => setLogFilter(e.target.value)}
              />
              <button className="btn ghost small" onClick={refreshLog}>↻ Refresh</button>
            </div>

            {logError && <div className="form-msg show error">{logError}</div>}

            <div className="audit-list">
              {log === null
                ? <div className="sub" style={{ padding: 14 }}>Loading…</div>
                : filteredLog.length === 0
                  ? <div className="sub" style={{ padding: 14, textAlign: 'center' }}>
                      {log.length === 0
                        ? 'No activity yet. Once any MM updates a case, the change will be logged here with their ID.'
                        : 'No entries match the current filter.'}
                    </div>
                  : filteredLog.map(e => {
                      const meta = ACTION_LABELS[e.action] || { label: e.action.toUpperCase(), tone: 'info' };
                      return (
                        <div key={e.id} className={`audit-row tone-${meta.tone}`}>
                          <div className="audit-row-left">
                            <span className={`audit-action tone-${meta.tone}`}>{meta.label}</span>
                            <span className="audit-target">{e.target || '—'}</span>
                          </div>
                          <div className="audit-row-right">
                            <span className="audit-detail">{e.details}</span>
                          </div>
                          <div className="audit-row-foot">
                            <span className="audit-user">
                              <span className="audit-user-id">{e.userId}</span>
                              <span className="audit-user-name">{e.userName}</span>
                            </span>
                            <span className="audit-time">{fmtTime(e.timestamp)}</span>
                          </div>
                        </div>
                      );
                    })
              }
            </div>

            <div className="form-actions">
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn" onClick={refreshLog}>Refresh log</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
