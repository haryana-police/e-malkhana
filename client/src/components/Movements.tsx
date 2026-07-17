import { useEffect, useRef, useState } from 'react';
import type { CaseRow, CaseStatus, MovementEvent } from '../types';
import { api } from '../api';

interface Props {
  cases: CaseRow[];
  onOpenScan: () => void;
  onOpenChangeStatus: (c: CaseRow) => void;
  onOpenTag: (c: CaseRow) => void;
  active?: boolean;
}

interface CaseSummary {
  case: CaseRow;
  lastLocation: string;
  lastMovementAt: string;
  movementCount: number;
}

function statusClass(s: CaseStatus): string {
  switch (s) {
    case 'Seized':                  return 'seized';
    case 'Expert Opinion Pending':  return 'expert';
    case 'In Malkhana':             return 'malkhana';
    case 'With FSL':                return 'fsl';
    case 'In Court':                return 'court';
    case 'Disposed':                return 'disposed';
    case 'Transfer':                return 'transfer';
  }
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

// A movement's docRef is either a short reference (e.g. "FSL-FWD-2026-114")
// or a full uploaded-file URL (e.g. "/api/uploads/...pdf").  Render the URL
// as a clickable link, and inline-references as plain text.
function renderDocRef(ref: string) {
  if (!ref) return null;
  const isUrl = /^https?:\/\//.test(ref) || ref.startsWith('/uploads') || ref.startsWith('/api/uploads');
  if (isUrl) {
    const name = decodeURIComponent(ref.split('/').pop() || ref);
    return <><br /><a href={ref} target="_blank" rel="noreferrer">📎 {name}</a></>;
  }
  return <> · {ref}</>;
}

export function Movements({ cases, onOpenScan, onOpenChangeStatus, onOpenTag, active }: Props) {
  const [summaries, setSummaries] = useState<CaseSummary[] | null>(null);
  const [filter, setFilter] = useState('');
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<MovementEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadSummaries() {
    setErr(null);
    try {
      // Fetch the latest 1 movement per case (we use the full list and pick the last one)
      const lists = await Promise.all(
        cases.map(c => api.movements(c.id).then(ms => ({
          case: c,
          last: ms[ms.length - 1],
          count: ms.length,
        })).catch(() => ({ case: c, last: undefined, count: 0 })))
      );
      setSummaries(lists.map(x => ({
        case: x.case,
        lastLocation: x.last?.toLocation ?? '—',
        lastMovementAt: x.last?.timestamp ?? '',
        movementCount: x.count,
      })));
    } catch (e) { setErr((e as Error).message); }
  }
  // Keep the latest loader in a ref so the interval always calls the
  // current closure (fresh `cases`) instead of a stale one.
  const loadRef = useRef(loadSummaries);
  loadRef.current = loadSummaries;

  // Auto-refresh: while this view is open, keep the movement log in sync
  // with the server every 2s so newly recorded movements / status changes
  // show up on their own — no manual "Refresh" button needed.
  useEffect(() => {
    if (!active) return;
    loadRef.current();
    const t = setInterval(() => loadRef.current(), 2000);
    return () => clearInterval(t);
  }, [active, cases.length]);

  // Open the timeline (movement log) for a specific case
  async function openTimeline(caseId: string) {
    setOpenCaseId(caseId);
    setTimelineLoading(true);
    try {
      const events = await api.movements(caseId);
      setTimeline(events.map(e => ({
        title: `${e.fromLocation === '—' ? 'New' : e.fromLocation} → ${e.toLocation}`,
        meta: `by ${e.movedBy} · ${fmtTime(e.timestamp)} · ${e.purpose}`,
        docRef: e.docRef,
      })));
    } catch {
      setTimeline([]);
    } finally {
      setTimelineLoading(false);
    }
  }

  // Strict case-id filter. The user typing "214" should land on FIR 214/2026
  // and nothing else — NOT the "2" in "2 live cartridges" and NOT the
  // itemId field.  Match priority:
  //   1. case.id    — "FIR 214/2026", "DD 41/2026"
  //   2. case.itemId — "MK-2026-000214"
  // We do NOT search item descriptions, status, or officer — those are
  // searchable elsewhere (the audit log / full-text).
  const norm = (s: string) => s.toLowerCase().replace(/^(fir|dd)\s+/, '');
  const f = filter.trim().toLowerCase();
  const fNum = f.replace(/\D+/g, '');   // digits only ("" if none)

  // Show the most recently-updated (newest movement) cases on top.
  const visible = (summaries ?? [])
    .filter(s => {
      if (!f) return true;
      const id   = s.case.id.toLowerCase();
      const idN  = norm(s.case.id);                  // "214/2026"
      const iid  = (s.case.itemId || '').toLowerCase();

      // 1) Direct substring on case id (with or without the FIR/DD prefix).
      if (id.includes(f) || idN.includes(f)) return true;
      if (iid.includes(f)) return true;

      // 2) Number-only: typing "214" should match id "214" and itemId "000214".
      //    Strip ALL non-digits from BOTH sides so incidental digits in the
      //    item description ("2 live cartridges") never trip the filter.
      if (fNum) {
        const idDigits   = idN.replace(/\D+/g, '');  // "2142026"
        const iidDigits  = iid.replace(/\D+/g, '');  // "2026000214"
        if (idDigits.includes(fNum) || iidDigits.includes(fNum)) return true;
      }
      return false;
    })
    // Sort newest movement first; cases with no timestamp sink to the bottom.
    .sort((a, b) => (b.lastMovementAt || '').localeCompare(a.lastMovementAt || ''));

  return (
    <div className={`view${active ? ' active' : ''}`} id="view-movements">
      <div className="page-head">
        <div>
          <h1>Movements &amp; Status Changes</h1>
          <div className="sub">
            One row per case — shows the <b>current station</b> and <b>current status</b>.
            Click a row to see its full movement log.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onOpenScan}>+ Scan / Record Movement</button>
        </div>
      </div>

      <div className="scan-bar">
        <span className="scan-label">Filter</span>
        <input
          placeholder="Filter by case id or item id (e.g. 214, MK-2026-000214)…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        {filter && (
          <button
            className="btn ghost small"
            type="button"
            onClick={() => setFilter('')}
            title="Clear filter"
            style={{ flex: '0 0 auto' }}
          >✕</button>
        )}
        <span className="scan-result">{visible.length} of {summaries?.length ?? 0} cases</span>
      </div>

      {err && <div className="form-msg show error" style={{ marginBottom: 14 }}>{err}</div>}

      <div className="panel">
        <div className="panel-head">
          <h2>Current Station · All Cases</h2>
          <span className="meta">Click a row to see its full movement log</span>
        </div>
        {summaries === null
          ? <div className="sub" style={{ padding: 18 }}>Loading…</div>
          : (
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Item</th>
                  <th>Current Status</th>
                  <th>Current Station</th>
                  <th>Last Update</th>
                  <th>Moves</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--slate-soft)' }}>
                    No matching cases.
                  </td></tr>
                )}
                {visible.map(s => (
                  <tr key={s.case.id} className="movements-row" onClick={() => openTimeline(s.case.id)} style={{ cursor: 'pointer' }}>
                    <td className="fir">{s.case.id}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {s.case.imageUrl && <img src={s.case.imageUrl} alt="" className="case-thumb" />}
                        <div>
                          <div className="type" style={{ fontWeight: 600, color: 'var(--slate)' }}>{s.case.itemType}</div>
                          <div className="sub" style={{ fontSize: 11, color: 'var(--slate-soft)' }}>{s.case.itemSub}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`stamp ${statusClass(s.case.status)}`}>
                        {s.case.status}
                      </span>
                    </td>
                    <td><b>{s.lastLocation}</b></td>
                    <td className="fir" style={{ whiteSpace: 'nowrap' }}>{s.lastMovementAt ? fmtTime(s.lastMovementAt) : '—'}</td>
                    <td style={{ textAlign: 'center' }}>{s.movementCount}</td>
                    <td>
                      <div className="row-actions" onClick={e => e.stopPropagation()}>
                        <div className="icon-btn" title="View evidence tag" onClick={() => onOpenTag(s.case)}>▦</div>
                        <div className="icon-btn" title="Change status again" onClick={() => onOpenChangeStatus(s.case)}>↻</div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* Inline timeline modal — opened when a row is clicked */}
      {openCaseId && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget) setOpenCaseId(null); }}>
          <div className="timeline-card">
            <button className="tag-close" onClick={() => setOpenCaseId(null)} aria-label="Close">✕</button>
            <h3>Movement Log — {openCaseId}</h3>
            <div className="fir-line">Current status: {cases.find(c => c.id === openCaseId)?.status ?? '—'}</div>
            {timelineLoading
              ? <div className="sub">Loading…</div>
              : timeline.length === 0
                ? <div className="sub">No movements recorded yet.</div>
                : timeline.map((ev, i) => (
                    <div key={i} className="tl-item">
                      <div className="tl-dot">●</div>
                      <div className="tl-body">
                        <div className="tl-title">{ev.title}</div>
                        <div className="tl-meta">{ev.meta}{renderDocRef(ev.docRef || '')}</div>
                      </div>
                    </div>
                  ))}
          </div>
        </div>
      )}
    </div>
  );
}
