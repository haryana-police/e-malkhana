import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { AlertConfig, AuditEntry, CaseRow, CaseStatus, CategoryFieldDef, CategoryOfItem, MovementLogRow, MovementType } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onUpdated: (cfg: AlertConfig) => void;
  onOpenSectionsManager?: () => void;
  onOpenItemTypeManager?: () => void;
  initialTab?: 'thresholds' | 'fields' | 'backup' | 'log' | 'movements' | 'movementTypes';
  // When true, show ONLY the requested part (no tab bar). Used when the
  // user clicks a specific System Setting part from the sidebar, so they
  // land on that one part instead of the whole settings surface.
  single?: boolean;
  // When true, render as a full inline PAGE (no overlay / dimmed backdrop).
  // Used by the /settings route. The focused "Configure threshold" popup
  // from the Alerts screen still uses the modal (single=true, asPage=false).
  asPage?: boolean;
}

// Title shown in the focused (single-part) header strip.
const FOCUS_TITLE: Record<string, string> = {
  thresholds: 'Alert Thresholds',
  fields: 'Item Type Fields',
  backup: 'Backup & Restore',
  log: 'Activity log',
  movements: 'Movement Logs',
  movementTypes: 'Movement Types',
};

const ACTION_LABELS: Record<string, { label: string; tone: 'good' | 'warn' | 'info' | 'critical' }> = {
  'case.create':     { label: 'REGISTERED', tone: 'good' },
  'case.status':     { label: 'STATUS',     tone: 'info' },
  'movement.record': { label: 'MOVED',      tone: 'info' },
  'movement.log':    { label: 'LOG',        tone: 'info' },
  'movement.create': { label: 'NEW LOG',    tone: 'info' },
  'movement.update': { label: 'EDIT LOG',   tone: 'warn' },
  'movement.delete': { label: 'DEL LOG',    tone: 'critical' },
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

export function SettingsModal({ open, onClose, onUpdated, onOpenSectionsManager, onOpenItemTypeManager, initialTab, single, asPage = false }: Props) {
  const [tab, setTab] = useState<'thresholds' | 'fields' | 'log' | 'backup' | 'movements' | 'movementTypes'>('thresholds');
  const [cfg, setCfg] = useState<AlertConfig | null>(null);
  const [backup, setBackup] = useState<any>(null);
  const [backupLog, setBackupLog] = useState<any[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  // Per-field validation errors shown inline beneath each input (key = AlertConfig field name).
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof AlertConfig, string>>>({});
  const [log, setLog] = useState<AuditEntry[] | null>(null);
  const [logFilter, setLogFilter] = useState('');
  const [logError, setLogError] = useState<string | null>(null);

  useEffect(() => {
    if (open || asPage) {
      setMsg(null);
      setFieldErrors({});
      api.alertConfig().then(setCfg).catch(e => setMsg({ kind: 'error', text: (e as Error).message }));
      // load log when tab opened
      api.audit({ limit: 200 }).then(setLog).catch(e => setLogError((e as Error).message));
      // load backup status / log when backup tab opened
      if (tab === 'backup') {
        api.backupStatus().then(setBackup).catch(e => setBackupMsg({ kind: 'error', text: (e as Error).message }));
        api.backupLog(20).then(setBackupLog).catch(() => {});
      }
    }
  }, [open, asPage, tab]);

  // Jump to the tab requested by the caller (e.g. a sidebar deep-link)
  // whenever the modal is (re)opened with an `initialTab`.  In single-part
  // mode we focus that one part and hide the tab bar (see `showTabs`).
  useEffect(() => {
    if ((open || asPage) && initialTab) setTab(initialTab);
  }, [open, asPage, initialTab]);
  const showTabs = !single;
  const activeTab = single && initialTab ? initialTab : tab;

  if (!open && !asPage) return null;

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
    // Police station name — same 3–80 char rule the server enforces.
    // Skipped in focused "Configure threshold" mode, where the station
    // field isn't shown and we only touch the day-count thresholds.
    if (!single) {
      const s = (c.station || '').trim();
      if (s.length < 3 || s.length > 80) {
        errs.station = 'Station name must be 3–80 characters';
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

  // Drop 'anonymous' system-trace entries — they carry no real MM Login ID
  // and only add noise to the activity log (see also the user chips below).
  const visibleLog = (log ?? []).filter(e => (e.userId || '').toLowerCase() !== 'anonymous');

  const filteredLog = visibleLog.filter(e => {
    if (!logFilter) return true;
    const f = logFilter.toLowerCase();
    return e.userId.toLowerCase().includes(f)
        || e.userName.toLowerCase().includes(f)
        || e.action.toLowerCase().includes(f)
        || e.target.toLowerCase().includes(f)
        || e.details.toLowerCase().includes(f);
  });

  // Summary counts per user (for the top-of-log strip) — excludes anonymous.
  const userSummary: Record<string, number> = {};
  for (const e of visibleLog) userSummary[e.userId] = (userSummary[e.userId] || 0) + 1;

  const content = (
    <>
      {showTabs ? (
        <>
          <h3>System Setting</h3>
          <div className="sub">
            Configure thresholds, per-item-type registration fields, backups, and review
            who made what changes — <b>every action is logged with the MM Login ID</b>.
          </div>

          <div className="audit-tabs">
            <button
              className={`audit-tab${tab === 'fields' ? ' active' : ''}`}
              onClick={() => setTab('fields')}
            >Item Type Fields</button>
            {onOpenItemTypeManager && (
              <button
                className="audit-tab"
                type="button"
                onClick={() => { onOpenItemTypeManager(); }}
                style={{ marginLeft: 0 }}
              >Item Types</button>
            )}
            <button
              className={`audit-tab${tab === 'backup' ? ' active' : ''}`}
              onClick={() => setTab('backup')}
            >Backup &amp; Restore</button>
            <button
              className={`audit-tab${tab === 'log' ? ' active' : ''}`}
              onClick={() => setTab('log')}
            >Activity log <span className="audit-tab-count">{visibleLog.length}</span></button>
            <button
              className={`audit-tab${tab === 'movements' ? ' active' : ''}`}
              onClick={() => setTab('movements')}
            >Movement Logs</button>
            <button
              className={`audit-tab${tab === 'movementTypes' ? ' active' : ''}`}
              onClick={() => setTab('movementTypes')}
              title="Configure the Move-to-status vocabulary"
            >Movement Types</button>
            {onOpenSectionsManager && (
              <button
                className="audit-tab"
                type="button"
                onClick={() => { onOpenSectionsManager(); }}
                style={{ marginLeft: 'auto' }}
              >Edit Malkhana Sections</button>
            )}
          </div>
        </>
      ) : (
        <div className="settings-focus-head">
          <span className="settings-focus-eyebrow">System Setting</span>
          <h3 className="settings-focus-title">{FOCUS_TITLE[activeTab] ?? 'Settings'}</h3>
        </div>
      )}

      {tab === 'thresholds' && cfg && (
        <>
          <div className="settings-list">
            {single && (
              <div className="sub" style={{ marginBottom: 12 }}>
                Set the day-count thresholds that drive the <b>Alerts &amp; Compliance</b> report.
                Changes apply on save and re-run the alert scan immediately.
              </div>
            )}
            {!single && (
            <div className="settings-row">
              <label>
                Police Station name
                <div className="help">
                  Shown in the dashboard subheader and on every report letterhead
                  (e.g.&nbsp;<i>PS Sector-5, Panchkula</i>).  3–80 characters.
                </div>
              </label>
              <input
                type="text"
                maxLength={80}
                value={cfg.station || ''}
                placeholder="PS Sector-5, Panchkula"
                aria-invalid={!!fieldErrors.station}
                aria-describedby={fieldErrors.station ? 'err-station' : undefined}
                onChange={e => set('station', e.target.value)}
                style={{ minWidth: 240 }}
              />
              {fieldErrors.station && (
                <div id="err-station" className="field-error" role="alert">{fieldErrors.station}</div>
              )}
            </div>
            )}
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
            {!single && (
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
            )}
          </div>
          {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}
          <div className="form-actions">
            <button className="btn ghost" onClick={reset} disabled={busy}>Reset</button>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
            <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}

      {activeTab === 'fields' && (
        <ItemTypeFieldsManager />
      )}

      {activeTab === 'backup' && (
        <BackupTabContent
          backup={backup}
          backupLog={backupLog}
          busy={backupBusy}
          msg={backupMsg}
          onRun={async () => {
            setBackupBusy(true); setBackupMsg(null);
            try {
              const r = await api.backupRun();
              setBackupMsg({
                kind: r.ok ? 'ok' : 'error',
                text: r.ok ? `Backup uploaded: ${r.fileName || 'success'}` : `Backup failed: ${r.error || 'unknown'}`,
              });
              // refresh status + log
              api.backupStatus().then(setBackup).catch(() => {});
              api.backupLog(20).then(setBackupLog).catch(() => {});
            } catch (e) {
              setBackupMsg({ kind: 'error', text: (e as Error).message });
            } finally {
              setBackupBusy(false);
            }
          }}
        />
      )}
      {activeTab === 'log' && (
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
          </div>

          {logError && <div className="form-msg show error">{logError}</div>}

          <div className="audit-list">
            {log === null
              ? <div className="sub" style={{ padding: 14 }}>Loading…</div>
              : filteredLog.length === 0
                ? <div className="sub" style={{ padding: 14, textAlign: 'center' }}>
                    {visibleLog.length === 0
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
          </div>
        </>
      )}

      {activeTab === 'movements' && (
        <MovementLogsManager />
      )}

      {activeTab === 'movementTypes' && (
        <MovementTypesManager />
      )}
    </>
  );

  if (asPage) {
    return (
      <div className="ss-page-wrap">
        <div className="ss-page-card">
          <button className="ss-page-back" onClick={onClose} aria-label="Back">← Back</button>
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="overlay open overlay-fs" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card audit-card">
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        {content}
      </div>
    </div>
  );
}

// =============================================================
// Backup tab — shows the latest backup status, the configured
// schedule, and a "Run backup now" button.  The actual backup is
// performed by `server/scripts/backup-to-drive.js` (Node) or
// `server/scripts/backup-to-drive.sh` (bash), driven by the daily
// Windows Task Scheduler entry "e-Malkhana Daily Backup".
//
// The Node script is also spawned by POST /api/backups/run when the
// admin clicks "Run backup now".
// =============================================================
function BackupTabContent({ backup, backupLog, busy, msg, onRun }: {
  backup: any;
  backupLog: any[];
  busy: boolean;
  msg: { kind: 'ok' | 'error'; text: string } | null;
  onRun: () => void;
}) {
  const last = backup?.last;
  const lastClass = !last ? ''
    : last.status === 'success' ? 'backup-status-ok'
    : last.status === 'failed'  ? 'backup-status-fail'
    : 'backup-status-run';
  const fmtTime = (iso: string) => iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      })
    : '—';
  const folderUrl: string = backup?.folderUrl || 'https://drive.google.com/drive/folders/1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b';
  const folderId = folderUrl.split('/folders/')[1] || '';
  const account = backup?.account || 'asppanipat01@gmail.com';
  const retentionDays = backup?.retentionDays ?? 10;
  const schedule = backup?.schedule || 'Windows Task Scheduler (daily 02:00)';
  return (
    <div>
      <div className="sub" style={{ marginBottom: 12 }}>
        Daily backup of the full case register (PostgreSQL). A gzipped
        <code> pg_dump</code> of every table is uploaded to Google Drive as
        <code> backup-YYYY-MM-DD-HHMM.sql.gz</code>. Files older than
        <b> {retentionDays} days</b> are auto-pruned. Configure retention via
        <code> BACKUP_RETENTION_DAYS</code>. See <code>docs/BACKUP_DAILY.md</code> for setup.
      </div>

      <div className="backup-card">
        <div className="row">
          <div>
            <div className="k">Last backup</div>
            <div className={`v ${lastClass}`} style={{ fontSize: 14 }}>
              {last ? `${fmtTime(last.timestamp || last.finishedAt)} — ${
                last.status === 'success' ? 'Success' :
                last.status === 'failed'  ? 'Failed'  :
                last.status === 'running' ? 'Running…' : 'Unknown'
              }` : 'No backups yet'}
            </div>
            {last?.fileName && (
              <div className="v" style={{ fontSize: 11, color: 'var(--slate-soft)' }}>
                📄{' '}
                <a
                  href={last.fileUrl || `${folderUrl}/${last.fileName}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--ink-navy)' }}
                >
                  {last.fileName}
                </a>
              </div>
            )}
            {last?.error && <div className="v" style={{ fontSize: 11, color: 'var(--seal-red)' }}>{last.error}</div>}
          </div>
          <div style={{ flex: '0 0 auto' }}>
            <button className="btn" onClick={onRun} disabled={busy}>
              {busy ? 'Running…' : '▶ Run backup now'}
            </button>
          </div>
        </div>
        <div className="row">
          <div>
            <div className="k">Schedule</div>
            <div className="v" style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12 }}>{schedule}</div>
          </div>
          <div>
            <div className="k">Transport</div>
            <div className="v">Google Drive</div>
          </div>
          <div>
            <div className="k">Account</div>
            <div className="v" style={{ fontSize: 12 }}>{account}</div>
          </div>
          <div>
            <div className="k">Total runs</div>
            <div className="v">{backup?.totalRuns ?? 0}</div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <div>
            <div className="k">Drive folder</div>
            <div className="v" style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>
              <a href={folderUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--ink-navy)' }}>
                📁 {folderId || 'e-Malkhana Backups'} ↗
              </a>
            </div>
          </div>
        </div>
        {msg && <div className={`form-msg show ${msg.kind}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>

      <h3 style={{ fontFamily: 'Rajdhani, sans-serif', color: 'var(--ink-navy)', fontSize: 14, margin: '12px 0 8px' }}>
        Recent runs <span className="audit-tab-count">{backupLog.length}</span>
      </h3>
      {backupLog.length === 0 ? (
        <div className="sub">No backup attempts recorded yet. The first daily run will populate this table.</div>
      ) : (
        <table className="audit-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>File</th>
              <th>Size</th>
              <th>Duration</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {backupLog.map((e: any) => (
              <tr key={e.id}>
                <td className="fir">{fmtTime(e.timestamp || e.finishedAt)}</td>
                <td>
                  <span className={`stamp ${
                    e.status === 'success' ? 'malkhana' :
                    e.status === 'failed'  ? 'disposed' :
                    'expert'
                  }`}>{e.status}</span>
                </td>
                <td style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>
                  {e.fileName
                    ? <a href={e.fileUrl || `${folderUrl}/${e.fileName}`} target="_blank" rel="noreferrer" style={{ color: 'var(--ink-navy)' }}>{e.fileName}</a>
                    : '—'}
                </td>
                <td style={{ fontSize: 11.5, color: 'var(--slate-soft)' }}>
                  {e.sizeBytes ? `${(e.sizeBytes / 1024).toFixed(1)} KB` : '—'}
                </td>
                <td style={{ fontSize: 11.5, color: 'var(--slate-soft)' }}>
                  {e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td style={{ fontSize: 11.5, color: 'var(--slate-soft)' }}>
                  {e.error ? <span style={{ color: 'var(--seal-red)' }}>{e.error}</span> : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// =============================================================
// Item Type Fields manager — the spec's "Form Builder".  Lets an admin
          // configure, per Malkhana section (Narcotics / Weapons / Cash & Documents /
          // Vehicle / Biological), the popup fields that appear when an MM registers
          // an item of that type.  Add / edit / delete / reorder without coding.
          // =============================================================
          // Item Type Fields — now a full Category-of-Item MANAGER.
          // The "Category of Item" master is DB-backed (item_categories),
          // so the admin can: add / edit / delete a category AND add /
          // edit / delete / reorder the columns (fields) inside each
          // category.  Register -> New Case Property reads the SAME table,
          // so edits show up live at registration.
          // =============================================================
          function ItemTypeFieldsManager() {
          const [cats, setCats]         = useState<CategoryOfItem[]>([]);
          const [loading, setLoading]   = useState(false);
          const [busy, setBusy]         = useState(false);
          const [msg, setMsg]           = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

          // which category tab is active (by id)
          const [tab, setTab]           = useState<string>('');

          // category editor (add new / edit existing).  null = closed.
          const [catDraft, setCatDraft] = useState<{ id?: string; label: string; sectionLetter: string; subTypeLabel: string; subTypeControl: 'select' | 'radio'; subTypes: string[]; } | null>(null);

          // field editor (add / edit) for the active category.  null = closed.
          const [fieldDraft, setFieldDraft] = useState<{ key?: string; label: string; type: 'text'|'number'|'select'|'date'|'time'; options: string; unit: string; placeholder: string; required: boolean; } | null>(null);

          const active = cats.find(c => c.id === tab);

          async function reload() {
            try { const list = await api.itemCategories(); setCats(list); }
            catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
          }
          useEffect(() => {
            setLoading(true); setMsg(null);
            api.itemCategories().then(list => { setCats(list); if (!tab && list[0]) setTab(list[0].id); })
              .catch(e => setMsg({ kind: 'error', text: (e as Error).message }))
              .finally(() => setLoading(false));
          }, []); // eslint-disable-line react-hooks/exhaustive-deps

          // ---------- category CRUD ----------
          function openAddCat() {
            setCatDraft({ label: '', sectionLetter: 'A', subTypeLabel: '', subTypeControl: 'select', subTypes: [] });
          }
          function openEditCat(c: CategoryOfItem) {
            setCatDraft({ id: c.id, label: c.label, sectionLetter: c.sectionLetter,
              subTypeLabel: c.subTypeLabel || '', subTypeControl: c.subTypeControl || 'select',
              subTypes: [...(c.subTypes || [])] });
          }
          // --- sub-type helpers (operate on catDraft.subTypes, save on Save) ---
          function addSubType() {
            setCatDraft(d => d ? { ...d, subTypes: [...d.subTypes, ''] } : d);
          }
          function moveSubType(idx: number, dir: -1 | 1) {
            setCatDraft(d => {
              if (!d) return d;
              const arr = [...d.subTypes];
              const ni = idx + dir;
              if (ni < 0 || ni >= arr.length) return d;
              [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
              return { ...d, subTypes: arr };
            });
          }
          function patchSubType(idx: number, value: string) {
            setCatDraft(d => {
              if (!d) return d;
              const arr = [...d.subTypes];
              arr[idx] = value;
              return { ...d, subTypes: arr };
            });
          }
          function deleteSubType(idx: number) {
            setCatDraft(d => d ? { ...d, subTypes: d.subTypes.filter((_, i) => i !== idx) } : d);
          }
          async function saveCat() {
            if (!catDraft) return;
            const id = catDraft.id || slug(catDraft.label);
            // Clean sub-types: trim + drop empty + dedupe (preserving first occurrence order)
            const seen = new Set<string>();
            const cleanSubs = catDraft.subTypes.map(s => s.trim()).filter(s => {
              if (!s) return false;
              const k = s.toLowerCase();
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
            const payload: any = {
              id,
              label: catDraft.label.trim(),
              sectionLetter: catDraft.sectionLetter,
              subTypeLabel: catDraft.subTypeLabel.trim() || null,
              subTypeControl: catDraft.subTypeControl,
              subTypes: cleanSubs,
            };
            setBusy(true); setMsg(null);
            try {
              await api.upsertItemCategory(payload);
              await reload();
              if (!catDraft.id) setTab(id);
              setCatDraft(null);
              setMsg({ kind: 'ok', text: `Saved category "${payload.label}".` });
            } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }
          async function deleteCat(c: CategoryOfItem) {
            if (!confirm(`Delete category "${c.label}"? This also removes its columns.`)) return;
            setBusy(true); setMsg(null);
            try {
              await api.deleteItemCategory(c.id);
              await reload();
              if (tab === c.id) setTab(cats.find(x => x.id !== c.id)?.id || '');
              setMsg({ kind: 'ok', text: `Deleted "${c.label}".` });
            } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }

          // Move the active category up/down within the same section.
          // Reorders by swapping sortOrder with the neighbour and persists.
          async function moveCat(c: CategoryOfItem, dir: -1 | 1) {
            // Build the ordered list of categories in the SAME section as `c`,
            // using the persisted sort_order (fall back to the displayed order).
            const inSection = cats
              .filter(x => x.sectionLetter === c.sectionLetter)
              .slice()
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
            const i = inSection.findIndex(x => x.id === c.id);
            const ni = i + dir;
            if (i < 0 || ni < 0 || ni >= inSection.length) return;
            const a = inSection[i];
            const b = inSection[ni];
            // Swap by re-stamping both with a clean (10-spaced) sort_order so the
            // unique value avoids any drift from previous edits.
            const newOrderA = ni * 10;
            const newOrderB = i * 10;
            setBusy(true); setMsg(null);
            try {
              await Promise.all([
                api.upsertItemCategory({ id: a.id, sortOrder: newOrderA }),
                api.upsertItemCategory({ id: b.id, sortOrder: newOrderB }),
              ]);
              await reload();
              setMsg({ kind: 'ok', text: `Moved "${a.label}" ${dir === -1 ? 'up' : 'down'}.` });
            } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }

          // ---------- field (column) CRUD for the active category ----------
          function openAddField() { setFieldDraft({ label: '', type: 'text', options: '', unit: '', placeholder: '', required: false }); }
          function openEditField(f: CategoryFieldDef) {
            setFieldDraft({ key: f.key, label: f.label, type: f.type, options: (f.options || []).join(', '), unit: f.unit || '', placeholder: f.placeholder || '', required: !!f.required });
          }
          async function saveField() {
            if (!active || !fieldDraft) return;
            const key = fieldDraft.key || slug(fieldDraft.label);
            const options = fieldDraft.type === 'select'
              ? fieldDraft.options.split(',').map(s => s.trim()).filter(Boolean) : undefined;
            const trimmedLabel = fieldDraft.label.trim();
            if (!trimmedLabel) { setMsg({ kind: 'error', text: 'Column label is required.' }); return; }
            const trimmedUnit = fieldDraft.unit.trim();
            const trimmedPlaceholder = fieldDraft.placeholder.trim();
            const fields = [...(active.fields || [])];
            const idx = fields.findIndex(f => f.key === key);
            const newField: CategoryFieldDef = {
              key, label: trimmedLabel, type: fieldDraft.type, options,
              placeholder: trimmedPlaceholder || undefined,
              unit: trimmedUnit || undefined,
              required: fieldDraft.required || undefined,
            };
            if (idx >= 0) fields[idx] = newField; else fields.push(newField);
            setBusy(true); setMsg(null);
            try {
              await api.upsertItemCategory({ id: active.id, fields });
              await reload();
              setFieldDraft(null);
              setMsg({ kind: 'ok', text: `Saved column "${newField.label}" for "${active.label}".` });
            } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }
          async function deleteField(f: CategoryFieldDef) {
            if (!active) return;
            if (!confirm(`Delete column "${f.label}" from "${active.label}"?`)) return;
            const fields = (active.fields || []).filter(x => x.key !== f.key);
            setBusy(true); setMsg(null);
            try {
              await api.upsertItemCategory({ id: active.id, fields });
              await reload();
              setMsg({ kind: 'ok', text: `Deleted column "${f.label}".` });
            } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }
          async function moveField(f: CategoryFieldDef, dir: -1 | 1) {
            if (!active) return;
            const fields = [...(active.fields || [])];
            const i = fields.findIndex(x => x.key === f.key);
            const ni = i + dir;
            if (i < 0 || ni < 0 || ni >= fields.length) return;
            [fields[i], fields[ni]] = [fields[ni], fields[i]];
            setBusy(true);
            try { await api.upsertItemCategory({ id: active.id, fields }); await reload(); }
            catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            finally { setBusy(false); }
          }

          function slug(s: string) {
            return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cat';
          }

          return (
          <div>
          <div className="sub" style={{ marginBottom: 12 }}>
            <b>Category of Item</b> master — add a category, rename it, or delete it. Inside each
            category, add / edit / remove / reorder the <b>columns</b> (fields) the MM fills at
            registration. Changes apply immediately to new registrations.
          </div>

          {/* category tabs */}
          <div className="itemtype-tabs">
            {cats.map(c => (
              <button key={c.id} type="button"
                className={`itemtype-tab${tab === c.id ? ' active' : ''}`}
                onClick={() => setTab(c.id)} disabled={busy}>
                <span className="itemtype-tab-name">{c.label}</span>
              </button>
            ))}
            <button type="button" className="itemtype-tab add-tab" onClick={openAddCat} disabled={busy} title="Add a new category">+ Add category</button>
          </div>

          {loading && <div className="sub" style={{ padding: 12 }}>Loading categories…</div>}

          {!loading && active && (
            <>
              {/* edit / delete / reorder the active category */}
              <div className="itemtype-section-head">
                <b>{active.label}</b>
                <span className="itemtype-count">{(active.fields || []).length} column{(active.fields || []).length === 1 ? '' : 's'}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {(() => {
                    // Same-section neighbours for ↑↓ enable/disable state.
                    const inSection = cats
                      .filter(x => x.sectionLetter === active.sectionLetter)
                      .slice()
                      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
                    const i = inSection.findIndex(x => x.id === active.id);
                    const atTop = i <= 0;
                    const atBottom = i < 0 || i >= inSection.length - 1;
                    return (
                      <>
                        <button type="button" className="icon-btn tiny" title="Move category up" onClick={() => moveCat(active, -1)} disabled={busy || atTop}>↑</button>
                        <button type="button" className="icon-btn tiny" title="Move category down" onClick={() => moveCat(active, 1)} disabled={busy || atBottom}>↓</button>
                        <button type="button" className="icon-btn tiny" title="Edit category" onClick={() => openEditCat(active)} disabled={busy}>✎</button>
                        <button type="button" className="icon-btn tiny" title="Delete category"
                          onClick={() => deleteCat(active)} disabled={busy}
                          style={{ color: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}>×</button>
                      </>
                    );
                  })()}
                </span>
              </div>

              <div className="itemtype-row" style={{ background: 'rgba(162,62,44,0.04)', marginBottom: 8 }}>
                <div className="itemtype-row-name">
                  <span style={{ fontSize: 12, color: 'var(--slate-soft)' }}>Sub-Type label</span>
                  <input value={active.subTypeLabel || '—'} disabled readOnly />
                  <span style={{ fontSize: 12, color: 'var(--slate-soft)' }}>Sub-Types ({(active.subTypes || []).join(', ') || '—'}) · Section {active.sectionLetter}</span>
                </div>
              </div>

              <div className="itemtype-list">
                {(active.fields || []).length === 0 && !fieldDraft && (
                  <div className="sub" style={{ padding: 16, textAlign: 'center' }}>No columns yet — add the first one below.</div>
                )}
                {(active.fields || []).map((f, i) => (
                  <div key={f.key} className="itemtype-row">
                    <div className="itemtype-row-name">
                      <input value={f.label} disabled readOnly />
                      <span className="itemtype-case-badge">{f.type}{f.unit ? ` · ${f.unit}` : ''}{f.options ? ` · ${(f.options).join(' / ')}` : ''}{f.required ? ' · REQUIRED' : ''}</span>
                      {f.placeholder && <span style={{ fontSize: 12, color: 'var(--slate-soft)' }}>placeholder: {f.placeholder}</span>}
                    </div>
                    <div className="itemtype-row-actions">
                      <button type="button" className="icon-btn" title="Move up" onClick={() => moveField(f, -1)} disabled={busy || i === 0}>↑</button>
                      <button type="button" className="icon-btn" title="Move down" onClick={() => moveField(f, 1)} disabled={busy || i === (active.fields || []).length - 1}>↓</button>
                      <button type="button" className="icon-btn" title="Edit" onClick={() => openEditField(f)} disabled={busy}>✎</button>
                      <button type="button" className="icon-btn" title="Delete" onClick={() => deleteField(f)} disabled={busy}
                        style={{ color: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}>×</button>
                    </div>
                  </div>
                ))}
              </div>

              {fieldDraft && (
                <div className="itemtype-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                  <div className="sub" style={{ margin: 0 }}>{fieldDraft.key ? 'Edit column' : `+ Add column to ${active.label}`}</div>
                  <input value={fieldDraft.label} onChange={e => setFieldDraft(d => d && { ...d, label: e.target.value })} placeholder="Column label e.g. Gross Weight" />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <select value={fieldDraft.type} onChange={e => setFieldDraft(d => d && { ...d, type: e.target.value as any })}>
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                      <option value="select">Select (dropdown)</option>
                      <option value="date">Date</option>
                      <option value="time">Time</option>
                    </select>
                    <input value={fieldDraft.unit} onChange={e => setFieldDraft(d => d && { ...d, unit: e.target.value })} placeholder="Unit e.g. g/kg, Rs., ml" />
                  </div>
                  {fieldDraft.type === 'select' && (
                    <input value={fieldDraft.options} onChange={e => setFieldDraft(d => d && { ...d, options: e.target.value })} placeholder="Comma-separated options e.g. Cash, Fake Currency, Papers" />
                  )}
                  <input value={fieldDraft.placeholder} onChange={e => setFieldDraft(d => d && { ...d, placeholder: e.target.value })} placeholder="Placeholder hint (optional) e.g. e.g. 250 g / 1.2 kg" />
                  <label className="itemtype-check" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--slate-soft)' }}>
                    <input type="checkbox" checked={fieldDraft.required} onChange={e => setFieldDraft(d => d && { ...d, required: e.target.checked })} />
                    <span>Make this column <b style={{ color: 'var(--ink)' }}>required</b> at registration</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" type="button" onClick={saveField} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
                    <button className="btn ghost" type="button" onClick={() => setFieldDraft(null)} disabled={busy}>Cancel</button>
                  </div>
                </div>
              )}

              {!fieldDraft && (
                <div className="itemtype-add">
                  <div className="sub" style={{ margin: 0, flex: '0 0 auto', paddingRight: 8 }}>+ Add column to {active.label}</div>
                  <button className="btn" type="button" onClick={openAddField} disabled={busy}>Add</button>
                </div>
              )}
            </>
          )}

          {/* category add / edit sheet */}
          {catDraft && (
            <div className="itemtype-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 12 }}>
              <div className="sub" style={{ margin: 0 }}>{catDraft.id ? 'Edit category' : 'Add new category'}</div>
              <input value={catDraft.label} onChange={e => setCatDraft(d => d && { ...d, label: e.target.value })} placeholder="Category label e.g. Explosives" />
              <label className="sub" style={{ margin: 0 }}>Malkhana Section</label>
              <select value={catDraft.sectionLetter} onChange={e => setCatDraft(d => d && { ...d, sectionLetter: e.target.value })}>
                {SECTION_LETTERS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <input value={catDraft.subTypeLabel} onChange={e => setCatDraft(d => d && { ...d, subTypeLabel: e.target.value })} placeholder="Sub-Type label (optional) e.g. Explosive Type" />
              <select value={catDraft.subTypeControl} onChange={e => setCatDraft(d => d && { ...d, subTypeControl: e.target.value as any })}>
                <option value="select">Sub-Type as dropdown</option>
                <option value="radio">Sub-Type as radio</option>
              </select>

              {/* Sub-Types: row-by-row editor (add / edit / delete / reorder) */}
              <div style={{ borderTop: '1px dashed rgba(0,0,0,0.12)', paddingTop: 8, marginTop: 4 }}>
                <div className="sub" style={{ margin: 0, marginBottom: 6 }}>Sub-Types ({catDraft.subTypes.length})</div>
                {catDraft.subTypes.length === 0 && (
                  <div className="sub" style={{ fontSize: 12, padding: '4px 0', color: 'var(--slate-soft)' }}>No sub-types yet — leave empty if this category doesn't need a Type field.</div>
                )}
                {catDraft.subTypes.map((s, i) => (
                  <div key={i} className="itemtype-row" style={{ padding: '4px 6px' }}>
                    <div className="itemtype-row-name" style={{ gap: 6 }}>
                      <span style={{ minWidth: 22, color: 'var(--slate-soft)', fontSize: 11 }}>#{i + 1}</span>
                      <input value={s} onChange={e => patchSubType(i, e.target.value)} placeholder={`Sub-Type ${i + 1} e.g. Heroin`} />
                    </div>
                    <div className="itemtype-row-actions">
                      <button type="button" className="icon-btn" title="Move up" disabled={i === 0} onClick={() => moveSubType(i, -1)}>↑</button>
                      <button type="button" className="icon-btn" title="Move down" disabled={i === catDraft.subTypes.length - 1} onClick={() => moveSubType(i, 1)}>↓</button>
                      <button type="button" className="icon-btn" title="Delete sub-type" onClick={() => deleteSubType(i)}
                        style={{ color: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}>×</button>
                    </div>
                  </div>
                ))}
                <button type="button" className="btn ghost small" onClick={addSubType} disabled={busy} style={{ marginTop: 6 }}>+ Add sub-type</button>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn" type="button" onClick={saveCat} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
                <button className="btn ghost" type="button" onClick={() => setCatDraft(null)} disabled={busy}>Cancel</button>
              </div>
            </div>
          )}

          {msg && <div className={`form-msg show ${msg.kind}`} style={{ marginTop: 8 }}>{msg.text}</div>}
          </div>
          );
          }
          const SECTION_LETTERS = ['A', 'B', 'C', 'D', 'E'];

// =============================================================
// Movement Logs manager — add, edit, and remove rows from the
// persisted movement log.  The same rows are read by the case
// timeline (`CasePropertyDetail`) and the register's Last
// Movement Date column, so a change here reflects everywhere
// immediately.  Uses the System-Settings-only
// /api/movement-logs CRUD endpoints (the case-detail flow is
// unchanged).  Every write is recorded in the audit log under
// the signed-in MM's ID.
// =============================================================
type MovementDraft = {
  caseId: string;
  fromLocation: string;
  toLocation: string;
  movedBy: string;
  timestamp: string;     // datetime-local string (YYYY-MM-DDTHH:MM)
  purpose: string;
  docRef: string;
  status: string;        // optional case status set by this movement (e.g. 'In Malkhana')
};

// Status options for the movement's optional "Set case status" column.
const MOVEMENT_STATUSES: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed', 'Transfer',
];

function emptyMovementDraft(): MovementDraft {
  return {
    caseId: '',
    fromLocation: '',
    toLocation: '',
    movedBy: '',
    timestamp: '',
    purpose: '',
    docRef: '',
    status: '',
  };
}

function toLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local needs YYYY-MM-DDTHH:MM in LOCAL time, not UTC.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function fmtMovementTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

function MovementLogsManager() {
  const [rows, setRows]       = useState<MovementLogRow[] | null>(null);
  const [cases, setCases]     = useState<CaseRow[]>([]);
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [filter, setFilter]   = useState('');
  const [editing, setEditing] = useState<{ id: number; draft: MovementDraft } | null>(null);
  const [creating, setCreating] = useState<MovementDraft | null>(null);

  async function reload() {
    try {
      const [list, caseList] = await Promise.all([api.movementLogs(), api.cases()]);
      setRows(list);
      setCases(caseList);
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }
  useEffect(() => { reload(); }, []);

  const filtered = (rows || []).filter(r => {
    if (!filter.trim()) return true;
    const f = filter.toLowerCase();
    return (r.caseId || '').toLowerCase().includes(f)
        || (r.fromLocation || '').toLowerCase().includes(f)
        || (r.toLocation || '').toLowerCase().includes(f)
        || (r.movedBy || '').toLowerCase().includes(f)
        || (r.purpose || '').toLowerCase().includes(f)
        || (r.docRef || '').toLowerCase().includes(f);
  });

  function startCreate() {
    setCreating(emptyMovementDraft());
    setEditing(null);
    setMsg(null);
  }
  function startEdit(r: MovementLogRow) {
    setEditing({ id: r.id, draft: {
      caseId: r.caseId,
      fromLocation: r.fromLocation || '',
      toLocation: r.toLocation || '',
      movedBy: r.movedBy || '',
      timestamp: toLocalInput(r.timestamp),
      purpose: r.purpose || '',
      docRef: r.docRef || '',
      status: r.status || '',
    } });
    setCreating(null);
    setMsg(null);
  }
  function cancelDraft() {
    setCreating(null);
    setEditing(null);
  }
  function patchDraft(d: MovementDraft, field: keyof MovementDraft, value: string): MovementDraft {
    return { ...d, [field]: value };
  }
  function validate(d: MovementDraft): string | null {
    if (!d.caseId.trim())   return 'Case is required.';
    if (!d.toLocation.trim()) return 'To location is required.';
    if (!d.movedBy.trim())    return 'Moved by is required.';
    if (d.timestamp) {
      const t = new Date(d.timestamp);
      if (Number.isNaN(t.getTime())) return 'Timestamp must be a valid date and time.';
    }
    return null;
  }
  async function saveCreate() {
    if (!creating) return;
    const err = validate(creating);
    if (err) { setMsg({ kind: 'error', text: err }); return; }
    setBusy(true); setMsg(null);
    try {
      const ts = fromLocalInput(creating.timestamp);
      const created = await api.createMovementLog({
        caseId: creating.caseId.trim(),
        fromLocation: creating.fromLocation.trim(),
        toLocation: creating.toLocation.trim(),
        movedBy: creating.movedBy.trim(),
        purpose: creating.purpose.trim(),
        docRef: creating.docRef.trim(),
        ...(creating.status.trim() ? { status: creating.status.trim() } : {}),
        ...(ts ? { timestamp: ts } : {}),
      });
      setRows(prev => prev ? [created, ...prev] : [created]);
      setCreating(null);
      setMsg({ kind: 'ok', text: `Logged movement #${created.id}.` });
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  async function saveEdit() {
    if (!editing) return;
    const err = validate(editing.draft);
    if (err) { setMsg({ kind: 'error', text: err }); return; }
    setBusy(true); setMsg(null);
    try {
      const ts = fromLocalInput(editing.draft.timestamp);
      const updated = await api.updateMovementLog(editing.id, {
        caseId: editing.draft.caseId.trim(),
        fromLocation: editing.draft.fromLocation.trim(),
        toLocation: editing.draft.toLocation.trim(),
        movedBy: editing.draft.movedBy.trim(),
        purpose: editing.draft.purpose.trim(),
        docRef: editing.draft.docRef.trim(),
        ...(editing.draft.status.trim() ? { status: editing.draft.status.trim() } : {}),
        ...(ts ? { timestamp: ts } : {}),
      });
      setRows(prev => prev ? prev.map(r => r.id === updated.id ? updated : r) : [updated]);
      setEditing(null);
      setMsg({ kind: 'ok', text: `Updated movement #${updated.id}.` });
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  }
  async function removeRow(r: MovementLogRow) {
    if (!confirm(`Delete movement #${r.id} (${r.fromLocation || 'New'} → ${r.toLocation || '—'}) for case ${r.caseId}? This is permanent and will also be removed from the case timeline.`)) return;
    setBusy(true); setMsg(null);
    try {
      await api.deleteMovementLog(r.id);
      setRows(prev => prev ? prev.filter(x => x.id !== r.id) : prev);
      setMsg({ kind: 'ok', text: `Deleted movement #${r.id}.` });
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  // Render the form used by both create and edit.
  function renderForm(d: MovementDraft, onChange: (next: MovementDraft) => void) {
    return (
      <div className="itemtype-add" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, marginTop: 8 }}>
        <div className="sub" style={{ margin: 0 }}>Movement details</div>
        <label className="sub" style={{ margin: 0 }}>Case</label>
        <select value={d.caseId} onChange={e => onChange(patchDraft(d, 'caseId', e.target.value))}>
          <option value="">— pick a case —</option>
          {cases.map(c => (
            <option key={c.id} value={c.id}>{c.id} · {c.itemType}</option>
          ))}
        </select>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label className="sub" style={{ margin: 0 }}>From</label>
            <input value={d.fromLocation} onChange={e => onChange(patchDraft(d, 'fromLocation', e.target.value))} placeholder="Previous location (optional — auto-fills if blank)" />
          </div>
          <div>
            <label className="sub" style={{ margin: 0 }}>To</label>
            <input value={d.toLocation} onChange={e => onChange(patchDraft(d, 'toLocation', e.target.value))} placeholder="e.g. Malkhana — Part B" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>
            <label className="sub" style={{ margin: 0 }}>Moved By</label>
            <input value={d.movedBy} onChange={e => onChange(patchDraft(d, 'movedBy', e.target.value))} placeholder="Officer name" />
          </div>
          <div>
            <label className="sub" style={{ margin: 0 }}>Timestamp</label>
            <input type="datetime-local" value={d.timestamp} onChange={e => onChange(patchDraft(d, 'timestamp', e.target.value))} />
          </div>
        </div>
        <label className="sub" style={{ margin: 0 }}>Purpose</label>
        <input value={d.purpose} onChange={e => onChange(patchDraft(d, 'purpose', e.target.value))} placeholder="e.g. Seizure check-in, FSL dispatch" />
        <label className="sub" style={{ margin: 0 }}>Set case status (optional)</label>
        <select value={d.status} onChange={e => onChange(patchDraft(d, 'status', e.target.value))}>
          <option value="">— no change —</option>
          {MOVEMENT_STATUSES.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <label className="sub" style={{ margin: 0 }}>Doc Ref</label>
        <input value={d.docRef} onChange={e => onChange(patchDraft(d, 'docRef', e.target.value))} placeholder="e.g. SM-2026-0214" />
      </div>
    );
  }

  return (
    <div>
      <div className="sub" style={{ marginBottom: 12 }}>
        Add, edit, or remove <b>movement log rows</b> for any case. Changes apply immediately to the case timeline, the register's Last Movement Date column, and the dashboard's recent activity. Every change is recorded in the <b>Activity log</b> with the signed-in MM's ID.
      </div>

      <div className="scan-bar">
        <span className="scan-label">Filter</span>
        <input
          placeholder="Filter by case, location, officer, purpose, or doc ref…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button className="btn" type="button" onClick={startCreate} disabled={busy || !!editing}>+ Add log</button>
        <button className="btn ghost" type="button" onClick={reload} disabled={busy}>Refresh</button>
      </div>

      {creating && (
        <>
          {renderForm(creating, setCreating)}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="btn" type="button" onClick={saveCreate} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn ghost" type="button" onClick={cancelDraft} disabled={busy}>Cancel</button>
          </div>
        </>
      )}

      {editing && (
        <>
          <div className="sub" style={{ margin: '8px 0 0' }}>Editing movement #{editing.id}</div>
          {renderForm(editing.draft, (next) => setEditing({ ...editing, draft: next }))}
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="btn" type="button" onClick={saveEdit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn ghost" type="button" onClick={cancelDraft} disabled={busy}>Cancel</button>
          </div>
        </>
      )}

      {msg && <div className={`form-msg show ${msg.kind}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="audit-list" style={{ marginTop: 10 }}>
        {rows === null
          ? <div className="sub" style={{ padding: 14 }}>Loading movement logs…</div>
          : filtered.length === 0
            ? <div className="sub" style={{ padding: 14, textAlign: 'center' }}>
                {rows.length === 0
                  ? 'No movement logs yet. Use “Add log” above to create the first one.'
                  : 'No movement logs match the current filter.'}
              </div>
            : filtered.map(r => {
                const isEditing = editing?.id === r.id;
                return (
                  <div key={r.id} className="audit-row tone-info">
                    <div className="audit-row-left">
                      <span className="audit-action tone-info">#{r.id}</span>
                      <span className="audit-target">{r.caseId}</span>
                    </div>
                    <div className="audit-row-right">
                      <span className="audit-detail">
                        <b>{r.fromLocation && r.fromLocation !== '—' ? r.fromLocation : 'New'}</b>
                        <span style={{ color: 'var(--slate-soft)', margin: '0 6px' }}>→</span>
                        <b>{r.toLocation || '—'}</b>
                        {r.purpose ? <> · <i>{r.purpose}</i></> : null}
                        {r.docRef ? <> · doc: {r.docRef}</> : null}
                      </span>
                    </div>
                    <div className="audit-row-foot">
                      <span className="audit-user">
                        <span className="audit-user-name">by {r.movedBy || '—'}</span>
                      </span>
                      <span className="audit-time">{fmtMovementTime(r.timestamp)}</span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        <button type="button" className="icon-btn tiny" disabled={busy || isEditing || !!creating} onClick={() => startEdit(r)}>✎</button>
                        <button type="button" className="icon-btn tiny" disabled={busy || isEditing} title="Delete"
                          onClick={() => removeRow(r)}
                          style={{ color: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}>×</button>
                      </span>
                    </div>
                  </div>
                );
              })
        }
      </div>

      <div className="form-actions">
        <button className="btn ghost" onClick={reload} disabled={busy}>Refresh</button>
      </div>
    </div>
  );
}


// =============================================================================
// Movement Types manager — admin CRUD for the "Move to status" vocabulary.
// Drives the Change Status dropdown, the Register filter, the Dashboard
// tiles, and the validation gate on every case PATCH.  Admins can add,
// rename, reorder, soft-delete, and tweak default location / purpose /
// allowed-next statuses here.  The seven seeded rows are flagged
// `isSystem` and cannot be deleted (only renamed + deactivated).
// =============================================================================
function MovementTypesManager() {
  const [rows, setRows]           = useState<MovementType[] | null>(null);
  const [caseCounts, setCaseCounts] = useState<Record<string, number>>({});
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy]           = useState(false);
  const [msg, setMsg]             = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [editing, setEditing]     = useState<{ id: number; draft: MovementTypeDraft } | null>(null);
  const [creating, setCreating]   = useState<MovementTypeDraft | null>(null);
  const [delTarget, setDelTarget] = useState<MovementType | null>(null);

  function reload() {
    setBusy(true);
    Promise.all([
      api.movementTypes('all'),
      api.cases().catch(() => [] as CaseRow[]),
    ]).then(([list, cases]) => {
      const counts: Record<string, number> = {};
      for (const c of cases as any[]) {
        const k = String(c.status || '').toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
      }
      setRows(list);
      setCaseCounts(counts);
      setMsg(null);
    }).catch(e => setMsg({ kind: 'error', text: (e as Error).message }))
      .finally(() => setBusy(false));
  }

  useEffect(() => { reload(); }, []);

  const visible = useMemo(() => {
    if (!rows) return [];
    const list = showInactive ? rows : rows.filter(r => r.active !== false);
    return [...list].sort((a, b) =>
      (a.sortOrder || 0) - (b.sortOrder || 0) ||
      (a.id || 0) - (b.id || 0)
    );
  }, [rows, showInactive]);

  function startEdit(m: MovementType) {
    setEditing({ id: m.id, draft: rowToDraft(m) });
    setCreating(null);
  }
  function cancelEdit() { setEditing(null); }
  async function saveEdit() {
    if (!editing) return;
    const d = editing.draft;
    const err = validateDraft(d);
    if (err) { setMsg({ kind: 'error', text: err }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.updateMovementType(editing.id, draftToPatch(d));
      setEditing(null);
      setMsg({ kind: 'ok', text: `Updated "${d.name}".` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  function startCreate() {
    const maxSort = (rows || []).reduce((m, r) => Math.max(m, r.sortOrder || 0), 0);
    setCreating({
      name: '', defaultLocation: '', defaultPurpose: '',
      next: [], sortOrder: maxSort + 10, active: true,
    });
    setEditing(null);
  }
  async function saveCreate() {
    if (!creating) return;
    const err = validateDraft(creating);
    if (err) { setMsg({ kind: 'error', text: err }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.createMovementType(draftToPatch(creating));
      setCreating(null);
      setMsg({ kind: 'ok', text: `Added "${creating.name}".` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  async function toggleActive(m: MovementType) {
    if (m.isSystem && m.active) {
      const count = caseCounts[m.name.toLowerCase()] || 0;
      if (count > 0) {
        setMsg({ kind: 'error', text: `Cannot deactivate "${m.name}" — ${count} case(s) still use it. Move them first.` });
        return;
      }
    }
    setBusy(true); setMsg(null);
    try {
      await api.updateMovementType(m.id, { active: !m.active });
      setMsg({ kind: 'ok', text: `${m.active ? 'Deactivated' : 'Reactivated'} "${m.name}".` });
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  async function doDelete() {
    if (!delTarget) return;
    setBusy(true); setMsg(null);
    try {
      await api.deleteMovementType(delTarget.id);
      setMsg({ kind: 'ok', text: `Removed "${delTarget.name}".` });
      setDelTarget(null);
      await reload();
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  function shift(m: MovementType, dir: -1 | 1) {
    if (!rows) return;
    const sorted = [...rows].sort((a, b) =>
      (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id || 0) - (b.id || 0)
    );
    const idx = sorted.findIndex(r => r.id === m.id);
    const swap = sorted[idx + dir];
    if (!swap) return;
    const aSort = m.sortOrder || 0;
    const bSort = swap.sortOrder || 0;
    setBusy(true);
    Promise.all([
      api.updateMovementType(m.id,   { sortOrder: bSort }),
      api.updateMovementType(swap.id, { sortOrder: aSort }),
    ]).then(() => reload())
      .catch(e => setMsg({ kind: 'error', text: (e as Error).message }))
      .finally(() => setBusy(false));
  }

  function renderRow(m: MovementType) {
    const isEditing = editing && editing.id === m.id;
    const count = caseCounts[m.name.toLowerCase()] || 0;
    const draft = isEditing ? editing!.draft : null;
    const inert = !m.active;

    return (
      <div key={m.id} className={`settings-row${inert ? ' inert' : ''}`}>
        <div className="settings-row-head">
          <div className="settings-row-title">
            {isEditing ? (
              <input
                className="settings-inline-input"
                value={draft!.name}
                maxLength={80}
                onChange={e => setEditing({ id: m.id, draft: { ...draft!, name: e.target.value } })}
                placeholder="Status name"
              />
            ) : (
              <>
                <b>{m.name}</b>
                {m.isSystem && <span className="badge built-in" title="Seeded by the system — cannot be deleted">built-in</span>}
                {!m.active && <span className="badge inactive">inactive</span>}
                <span className="muted small"> · used by {count} case{count === 1 ? '' : 's'}</span>
              </>
            )}
          </div>
          <div className="settings-row-actions">
            {!isEditing && (
              <>
                <button type="button" className="btn ghost sm" onClick={() => shift(m, -1)} disabled={busy} title="Move up">↑</button>
                <button type="button" className="btn ghost sm" onClick={() => shift(m, 1)}  disabled={busy} title="Move down">↓</button>
                <button type="button" className="btn ghost sm" onClick={() => startEdit(m)} disabled={busy}>Edit</button>
                <button type="button" className="btn ghost sm" onClick={() => toggleActive(m)} disabled={busy}>
                  {m.active ? 'Deactivate' : 'Reactivate'}
                </button>
                <button
                  type="button"
                  className="btn ghost sm danger"
                  onClick={() => setDelTarget(m)}
                  disabled={busy || m.isSystem}
                  title={m.isSystem ? 'Built-in statuses cannot be deleted' : 'Delete this movement type'}
                >Delete</button>
              </>
            )}
            {isEditing && (
              <>
                <button type="button" className="btn ghost sm" onClick={cancelEdit} disabled={busy}>Cancel</button>
                <button type="button" className="btn sm" onClick={saveEdit} disabled={busy}>Save</button>
              </>
            )}
          </div>
        </div>

        {isEditing && draft && (
          <div className="settings-row-body">
            <label>Default location
              <input value={draft.defaultLocation} maxLength={200}
                onChange={e => setEditing({ id: m.id, draft: { ...draft, defaultLocation: e.target.value } })}
                placeholder="e.g. Malkhana, FSL Madhuban" />
            </label>
            <label>Default purpose
              <input value={draft.defaultPurpose} maxLength={200}
                onChange={e => setEditing({ id: m.id, draft: { ...draft, defaultPurpose: e.target.value } })}
                placeholder="e.g. Returned to malkhana" />
            </label>
            <label>Allowed next statuses
              <NextChips
                all={visible}
                selected={draft.next}
                exclude={m.name}
                onChange={next => setEditing({ id: m.id, draft: { ...draft, next } })}
              />
            </label>
          </div>
        )}

        {!isEditing && (
          <div className="settings-row-body compact">
            <span className="mt-meta">
              <span className="mt-label">Location:</span>
              <span className="mt-value">{m.defaultLocation || <em>(none)</em>}</span>
            </span>
            <span className="mt-meta">
              <span className="mt-label">Purpose:</span>
              <span className="mt-value">{m.defaultPurpose || <em>(none)</em>}</span>
            </span>
            {Array.isArray(m.next) && m.next.length > 0 && (
              <span className="mt-meta">
                <span className="mt-label">Next:</span>
                <span className="mt-value">{m.next.join(', ')}</span>
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (rows === null) {
    return <div className="sub">Loading movement types…</div>;
  }

  return (
    <div className="settings-list-wrap">
      <div className="settings-list-head">
        <div className="settings-list-actions">
          <label className="settings-toggle">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <button type="button" className="btn sm" onClick={startCreate} disabled={busy || !!creating}>+ Add movement type</button>
        </div>
      </div>

      {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

      {creating && (
        <div className="settings-row create">
          <div className="settings-row-head">
            <div className="settings-row-title"><b>New movement type</b></div>
            <div className="settings-row-actions">
              <button type="button" className="btn ghost sm" onClick={() => setCreating(null)} disabled={busy}>Cancel</button>
              <button type="button" className="btn sm" onClick={saveCreate} disabled={busy}>Add</button>
            </div>
          </div>
          <div className="settings-row-body">
            <label>Name
              <input value={creating.name} maxLength={80}
                onChange={e => setCreating({ ...creating, name: e.target.value })}
                placeholder="e.g. With Police Custody" />
            </label>
            <label>Default location
              <input value={creating.defaultLocation} maxLength={200}
                onChange={e => setCreating({ ...creating, defaultLocation: e.target.value })}
                placeholder="e.g. Police Lines" />
            </label>
            <label>Default purpose
              <input value={creating.defaultPurpose} maxLength={200}
                onChange={e => setCreating({ ...creating, defaultPurpose: e.target.value })}
                placeholder="e.g. Handed over for investigation" />
            </label>
            <label>Allowed next statuses
              <NextChips
                all={visible}
                selected={creating.next}
                exclude={creating.name}
                onChange={next => setCreating({ ...creating, next })}
              />
            </label>
          </div>
        </div>
      )}

      <div className="settings-list">
        {visible.length === 0
          ? <div className="sub">No movement types match the current filter.</div>
          : visible.map(renderRow)
        }
      </div>

      {delTarget && (
        <div className="overlay open" onClick={e => {
          if (e.target === e.currentTarget && !busy) setDelTarget(null);
        }}>
          <div className="form-card confirm">
            <h3>Delete movement type?</h3>
            <div className="sub">
              This permanently removes <b>{delTarget.name}</b>. Cases that currently
              use this status must be moved to a different status first — the server
              will refuse the delete if any case still uses it.
            </div>
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setDelTarget(null)} disabled={busy}>Cancel</button>
              <button type="button" className="btn danger" onClick={doDelete} disabled={busy}>Delete</button>
            </div>
          </div>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={reload} disabled={busy}>Refresh</button>
      </div>
    </div>
  );
}

interface MovementTypeDraft {
  name: string;
  defaultLocation: string;
  defaultPurpose: string;
  next: string[];
  sortOrder: number;
  active: boolean;
}

function rowToDraft(m: MovementType): MovementTypeDraft {
  return {
    name:            m.name,
    defaultLocation: m.defaultLocation || '',
    defaultPurpose:  m.defaultPurpose  || '',
    next:            Array.isArray(m.next) ? m.next : [],
    sortOrder:       m.sortOrder || 0,
    active:          m.active !== false,
  };
}

function draftToPatch(d: MovementTypeDraft) {
  return {
    name:            d.name.trim(),
    defaultLocation: d.defaultLocation,
    defaultPurpose:  d.defaultPurpose,
    next:            d.next,
    sortOrder:       d.sortOrder,
    active:          d.active,
  };
}

function validateDraft(d: MovementTypeDraft): string | null {
  const n = (d.name || '').trim();
  if (!n) return 'Name is required';
  if (n.length > 80) return 'Name must be 80 characters or fewer';
  return null;
}

function NextChips(props: {
  all: MovementType[];
  selected: string[];
  exclude: string;
  onChange: (next: string[]) => void;
}) {
  const candidates = props.all.filter(r =>
    r.active !== false && r.name !== props.exclude);
  function toggle(name: string) {
    const has = props.selected.includes(name);
    const next = has ? props.selected.filter(n => n !== name) : [...props.selected, name];
    props.onChange(next);
  }
  return (
    <div className="chip-row">
      {candidates.length === 0
        ? <span className="muted small">No other statuses available.</span>
        : candidates.map(r => {
            const on = props.selected.includes(r.name);
            return (
              <button
                key={r.id}
                type="button"
                className={`chip${on ? ' on' : ''}`}
                onClick={() => toggle(r.name)}
                title={on ? 'Click to remove' : 'Click to add'}
              >{r.name}</button>
            );
          })
      }
      <span className="muted small" style={{ marginLeft: 8 }}>
        {props.selected.length === 0
          ? '(empty = any active status)'
          : `${props.selected.length} selected`}
      </span>
    </div>
  );
}
