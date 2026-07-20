import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AlertConfig, AuditEntry, CategoryOfItem, CategoryFieldDef } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onUpdated: (cfg: AlertConfig) => void;
  onOpenSectionsManager?: () => void;
  onOpenItemTypeManager?: () => void;
  initialTab?: 'thresholds' | 'fields' | 'backup' | 'log';
  // When true, show ONLY the requested part (no tab bar). Used when the
  // user clicks a specific System Setting part from the sidebar, so they
  // land on that one part instead of the whole settings surface.
  single?: boolean;
}

// Title shown in the focused (single-part) header strip.
const FOCUS_TITLE: Record<string, string> = {
  thresholds: 'Alert Thresholds',
  fields: 'Item Type Fields',
  backup: 'Backup & Restore',
  log: 'Activity log',
};

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

export function SettingsModal({ open, onClose, onUpdated, onOpenSectionsManager, onOpenItemTypeManager, initialTab, single }: Props) {
  const [tab, setTab] = useState<'thresholds' | 'fields' | 'log' | 'backup'>('thresholds');
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
    if (open) {
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
  }, [open, tab]);

  // Jump to the tab requested by the caller (e.g. a sidebar deep-link)
  // whenever the modal is (re)opened with an `initialTab`.  In single-part
  // mode we focus that one part and hide the tab bar (see `showTabs`).
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  const showTabs = !single;
  const activeTab = single && initialTab ? initialTab : tab;

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

  return (
    <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="form-card audit-card">
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>

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
      </div>
    </div>
  );
}

// =============================================================
// Backup tab — shows the latest backup status, the configured
// schedule, and a "Run backup now" button.  On the server the
// backup is performed by `server/scripts/backup-to-drive.js`,
// which expects a Google service account key + Drive folder id.
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
  return (
    <div>
      <div className="sub" style={{ marginBottom: 12 }}>
        Daily email backup of the full case register (PostgreSQL). A timestamped
        JSON dump of every table is emailed to <b>{backup?.to || 'the configured address'}</b>.
        Local dumps older than <b>{backup?.retentionDays ?? 30} days</b> are auto-pruned.
        Configure the cron, retention, and SMTP recipients via the
        <code> BACKUP_CRON</code>, <code>BACKUP_RETENTION_DAYS</code>, and
        <code> BACKUP_TO</code> env vars. See <code>docs/BACKUP_EMAIL.md</code> for setup.
      </div>

      <div className="backup-card">
        <div className="row">
          <div>
            <div className="k">Last backup</div>
            <div className={`v ${lastClass}`} style={{ fontSize: 14 }}>
              {last ? `${fmtTime(last.timestamp)} — ${
                last.status === 'success' ? 'Success' :
                last.status === 'failed'  ? 'Failed'  :
                last.status === 'running' ? 'Running…' : 'Unknown'
              }` : 'No backups yet'}
            </div>
            {last?.fileName && <div className="v" style={{ fontSize: 11, color: 'var(--slate-soft)' }}>📄 {last.fileName}</div>}
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
            <div className="v" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{backup?.cron || '—'}</div>
          </div>
          <div>
            <div className="k">Transport</div>
            <div className="v">{backup?.transport || 'email'}</div>
          </div>
          <div>
            <div className="k">Total runs</div>
            <div className="v">{backup?.totalRuns ?? 0}</div>
          </div>
        </div>
        {msg && <div className={`form-msg show ${msg.kind}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>

      <h3 style={{ fontFamily: 'Rajdhani, sans-serif', color: 'var(--ink-navy)', fontSize: 14, margin: '12px 0 8px' }}>
        Recent runs <span className="audit-tab-count">{backupLog.length}</span>
      </h3>
      {backupLog.length === 0 ? (
        <div className="sub">No backup attempts recorded yet.</div>
      ) : (
        <table className="audit-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Reason</th>
              <th>File</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {backupLog.map((e: any) => (
              <tr key={e.id}>
                <td className="fir">{fmtTime(e.timestamp)}</td>
                <td>
                  <span className={`stamp ${
                    e.status === 'success' ? 'malkhana' :
                    e.status === 'failed'  ? 'disposed' :
                    'expert'
                  }`}>{e.status}</span>
                </td>
                <td>{e.reason || '—'}</td>
                <td style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }}>{e.fileName || '—'}</td>
                <td style={{ fontSize: 11.5, color: 'var(--slate-soft)' }}>
                  {e.error ? <span style={{ color: 'var(--seal-red)' }}>{e.error}</span> :
                   e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '—'}
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
          const [catDraft, setCatDraft] = useState<{ id?: string; label: string; sectionLetter: string; subTypeLabel: string; subTypeControl: 'select' | 'radio'; subTypes: string; } | null>(null);

          // field editor (add / edit) for the active category.  null = closed.
          const [fieldDraft, setFieldDraft] = useState<{ key?: string; label: string; type: 'text'|'number'|'select'|'date'|'time'; options: string } | null>(null);

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
            setCatDraft({ label: '', sectionLetter: 'A', subTypeLabel: '', subTypeControl: 'select', subTypes: '' });
          }
          function openEditCat(c: CategoryOfItem) {
            setCatDraft({ id: c.id, label: c.label, sectionLetter: c.sectionLetter,
              subTypeLabel: c.subTypeLabel || '', subTypeControl: c.subTypeControl || 'select',
              subTypes: (c.subTypes || []).join(', ') });
          }
          async function saveCat() {
            if (!catDraft) return;
            const id = catDraft.id || slug(catDraft.label);
            const payload: any = {
              id,
              label: catDraft.label.trim(),
              sectionLetter: catDraft.sectionLetter,
              subTypeLabel: catDraft.subTypeLabel.trim() || null,
              subTypeControl: catDraft.subTypeControl,
              subTypes: catDraft.subTypes.split(',').map(s => s.trim()).filter(Boolean),
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

          // ---------- field (column) CRUD for the active category ----------
          function openAddField() { setFieldDraft({ label: '', type: 'text', options: '' }); }
          function openEditField(f: CategoryFieldDef) {
            setFieldDraft({ key: f.key, label: f.label, type: f.type, options: (f.options || []).join(', ') });
          }
          async function saveField() {
            if (!active || !fieldDraft) return;
            const key = fieldDraft.key || slug(fieldDraft.label);
            const options = fieldDraft.type === 'select'
              ? fieldDraft.options.split(',').map(s => s.trim()).filter(Boolean) : undefined;
            const fields = [...(active.fields || [])];
            const idx = fields.findIndex(f => f.key === key);
            const newField: CategoryFieldDef = { key, label: fieldDraft.label.trim(), type: fieldDraft.type, options, placeholder: undefined, unit: undefined };
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
              {/* edit / delete the active category */}
              <div className="itemtype-section-head">
                <b>{active.label}</b>
                <span className="itemtype-count">{(active.fields || []).length} column{(active.fields || []).length === 1 ? '' : 's'}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className="icon-btn tiny" title="Edit category" onClick={() => openEditCat(active)} disabled={busy}>✎</button>
                  <button type="button" className="icon-btn tiny" title="Delete category"
                    onClick={() => deleteCat(active)} disabled={busy}
                    style={{ color: 'var(--seal-red)', borderColor: 'var(--seal-red)' }}>×</button>
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
                      <span className="itemtype-case-badge">{f.type}{f.options ? ` · ${(f.options).join(' / ')}` : ''}</span>
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
                  <select value={fieldDraft.type} onChange={e => setFieldDraft(d => d && { ...d, type: e.target.value as any })}>
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="select">Select (dropdown)</option>
                    <option value="date">Date</option>
                    <option value="time">Time</option>
                  </select>
                  {fieldDraft.type === 'select' && (
                    <input value={fieldDraft.options} onChange={e => setFieldDraft(d => d && { ...d, options: e.target.value })} placeholder="Comma-separated options e.g. Cash, Fake Currency, Papers" />
                  )}
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
              <input value={catDraft.subTypes} onChange={e => setCatDraft(d => d && { ...d, subTypes: e.target.value })} placeholder="Comma-separated sub-types (optional)" />
              <div style={{ display: 'flex', gap: 8 }}>
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

