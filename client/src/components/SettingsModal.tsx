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
  // Per-field validation errors shown inline beneath each input (key = AlertConfig field name).
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof AlertConfig, string>>>({});
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [logFilter, setLogFilter] = useState('');
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMsg(null);
      setFieldErrors({});
      api.alertConfig().then(setCfg).catch(e => setMsg({ kind: 'error', text: (e as Error).message }));
      // load log when tab opened
      api.audit({ limit: 200 }).then(setLog).catch(e => setLogError((e as Error).message));
    }
  }, [open, tab]);

  if (!open) return null;

  // Mirror the backend rules. Keep these in sync with server/server.js
  // PATCH /api/alerts/config validation. Positive integers only (1–3650 days),
  // and lastInspection must be a real YYYY-MM-DD date when provided.
  function validate(c: AlertConfig): Partial<Record<keyof AlertConfig, string>> {
    const errs: Partial<Record<keyof AlertConfig, string>> = {};
    for (const k of ['fslDays', 'expertDays', 'courtDays', 'inspectionCycleDays'] as const) {
      const v = c[k];
      if (!Number.isInteger(v) || v < 1 || v > 3650) {
        errs[k] = 'Must be a whole number 1–3650';
      }
    }
    if (c.lastInspection !== undefined && c.lastInspection !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(c.lastInspection)
          || Number.isNaN(new Date(c.lastInspection).getTime())) {
        errs.lastInspection = 'Pick a valid date';
      }
    }
    return errs;
  }

  function set<K extends keyof AlertConfig>(k: K, v: number | string) {
    if (!cfg) return;
    setCfg({ ...cfg, [k]: v });
    // Clear the field error as soon as the user edits the value
    setFieldErrors(prev => {
      if (!prev[k]) return prev;
      const { [k]: _drop, ...rest } = prev;
      return rest;
    });
  }

  async function save() {
    if (!cfg) return;
    const errs = validate(cfg);
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setMsg({ kind: 'error', text: 'Please fix the highlighted fields and try again.' });
      return;
    }
    setFieldErrors({});
    setBusy(true); setMsg(null);
    try {
      const next = await api.updateAlerts(cfg);
      setCfg(next);
      onUpdated(next);
      setMsg({ kind: 'ok', text: 'Saved · alert scan re-ran.' });
      // refresh log so the change appears immediately
      api.audit({ limit: 200 }).then(setLog).catch(() => {});
    } catch (e) {
      // Server returned 400 with a per-field error map? Surface it inline.
      const err = e as Error & { body?: { fields?: Record<string, string> }, status?: number };
      if (err?.body?.fields) {
        setFieldErrors(err.body.fields as Partial<Record<keyof AlertConfig, string>>);
        setMsg({ kind: 'error', text: 'Server rejected: please fix the highlighted fields.' });
      } else {
        setFieldErrors({});
        setMsg({ kind: 'error', text: (e as Error).message });
      }
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
                <input type="number" min={1} max={3650} step={1} value={cfg.fslDays}
                  aria-invalid={!!fieldErrors.fslDays} aria-describedby={fieldErrors.fslDays ? 'err-fslDays' : undefined}
                  onChange={e => set('fslDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
                {fieldErrors.fslDays && <div id="err-fslDays" className="field-error" role="alert">{fieldErrors.fslDays}</div>}
              </div>
              <div className="settings-row">
                <label>
                  Expert opinion overdue
                  <div className="help">Number of days before an Expert Opinion case is flagged.</div>
                </label>
                <input type="number" min={1} max={3650} step={1} value={cfg.expertDays}
                  aria-invalid={!!fieldErrors.expertDays} aria-describedby={fieldErrors.expertDays ? 'err-expertDays' : undefined}
                  onChange={e => set('expertDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
                {fieldErrors.expertDays && <div id="err-expertDays" className="field-error" role="alert">{fieldErrors.expertDays}</div>}
              </div>
              <div className="settings-row">
                <label>
                  Court-order / disposal overdue
                  <div className="help">Number of days before a case awaiting court order is flagged.</div>
                </label>
                <input type="number" min={1} max={3650} step={1} value={cfg.courtDays}
                  aria-invalid={!!fieldErrors.courtDays} aria-describedby={fieldErrors.courtDays ? 'err-courtDays' : undefined}
                  onChange={e => set('courtDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
                {fieldErrors.courtDays && <div id="err-courtDays" className="field-error" role="alert">{fieldErrors.courtDays}</div>}
              </div>
              <div className="settings-row">
                <label>
                  Quarterly inspection cycle
                  <div className="help">Cycle length for the next-due inspection alert.</div>
                </label>
                <input type="number" min={1} max={3650} step={1} value={cfg.inspectionCycleDays}
                  aria-invalid={!!fieldErrors.inspectionCycleDays} aria-describedby={fieldErrors.inspectionCycleDays ? 'err-inspectionCycleDays' : undefined}
                  onChange={e => set('inspectionCycleDays', Number(e.target.value))} />
                <span className="settings-unit">days</span>
                {fieldErrors.inspectionCycleDays && <div id="err-inspectionCycleDays" className="field-error" role="alert">{fieldErrors.inspectionCycleDays}</div>}
              </div>
              <div className="settings-row">
                <label>
                  Last inspection
                  <div className="help">Date of the most-recent quarterly inspection.</div>
                </label>
                <input type="date" value={cfg.lastInspection}
                  aria-invalid={!!fieldErrors.lastInspection} aria-describedby={fieldErrors.lastInspection ? 'err-lastInspection' : undefined}
                  onChange={e => set('lastInspection', e.target.value)} />
                {fieldErrors.lastInspection && <div id="err-lastInspection" className="field-error" role="alert">{fieldErrors.lastInspection}</div>}
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
