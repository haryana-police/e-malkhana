import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CaseRow, CaseStatus } from '../types';
import { api } from '../api';

interface Props {
  cases: CaseRow[];
  activeSection: string | null;
  onClearSection: () => void;
  activeStatus?: CaseStatus | null;
  onClearStatus?: () => void;
  excludeDisposed?: boolean;
  onClearExcludeDisposed?: () => void;
  onOpenTag: (c: CaseRow) => void;
  onOpenTimeline: (fir: string) => void;
  onOpenScan: () => void;
  onOpenRegister: () => void;
  onChangeStatus: (c: CaseRow) => void;
  active?: boolean;
  onDownloadReport: (format: 'xlsx' | 'pdf') => void;
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

const ALL_STATUSES: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana', 'With FSL',
  'In Court', 'Disposed', 'Transfer',
];

// ---- Column model for the Case Property Register -------------------------
// Every column (except S.NO which is the running row index and Actions which
// holds the per-row buttons) is described here so the user can DRAG the
// headers to reorder them.  The order is persisted to localStorage so a
// station's preferred layout sticks across reloads.  No DB change — purely
// client-side, so the Neon schema is untouched.
type ColKey =
  | 'sno' | 'id' | 'seizingOfficer' | 'itemType'
  | 'section' | 'quantity' | 'status' | 'lastMovement' | 'actions';

interface ColumnDef {
  key: ColKey;
  label: string;
  className?: string;
  // When true the header is NOT draggable (S.NO + Actions stay put).
  locked?: boolean;
  render: (c: CaseRow, i: number) => React.ReactNode;
}

// Simplified register: FIR/DD · Item Type · Section · Quantity · Status ·
// Last Movement.  Full description lives on the detail page (row click).
const DEFAULT_ORDER: ColKey[] = [
  'sno', 'id', 'itemType',
  'section', 'quantity', 'status', 'lastMovement', 'actions',
];

const LS_KEY = 'cpr-column-order';

function loadOrder(): ColKey[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [...DEFAULT_ORDER];
    const parsed = JSON.parse(raw) as ColKey[];
    // Keep only known keys, preserve default order for any that are missing,
    // and drop unknown ones — defensive against schema drift.
    const known = new Set(DEFAULT_ORDER);
    const kept = parsed.filter(k => known.has(k));
    for (const k of DEFAULT_ORDER) if (!kept.includes(k)) kept.push(k);
    return kept;
  } catch {
    return [...DEFAULT_ORDER];
  }
}

export function CaseProperty({
  cases, activeSection, onClearSection,
  activeStatus, onClearStatus,
  excludeDisposed, onClearExcludeDisposed,
  onOpenTag, onOpenTimeline, onOpenScan, onOpenRegister, onChangeStatus, active,
  onDownloadReport,
}: Props) {
  const [textFilter, setTextFilter] = useState('');
  const [order, setOrder] = useState<ColKey[]>(loadOrder);
  const [dragKey, setDragKey] = useState<ColKey | null>(null);
  const navigate = useNavigate();

  // ---- Click a column heading to filter the register --------------------
  const [openCol, setOpenCol] = useState<ColKey | null>(null);
  const [colFilters, setColFilters] = useState<Partial<Record<ColKey, string>>>({});
  const [statusFilter, setStatusFilter] = useState<CaseStatus[]>([]);

  useEffect(() => {
    if (!openCol) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-colpop]')) setOpenCol(null);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [openCol]);

  const TEXT_COLS: ColKey[] = ['id', 'itemType', 'section', 'quantity', 'lastMovement'];

  function cellText(c: CaseRow, key: ColKey): string {
    switch (key) {
      case 'id': return c.id;
      case 'itemType': return c.itemType;
      case 'section': return c.sectionName;
      case 'quantity': return c.quantity || '1';
      case 'lastMovement': return c.lastMovement || '';
      default: return '';
    }
  }
  function isColFiltered(key: ColKey): boolean {
    if (key === 'status') return statusFilter.length > 0;
    return !!(colFilters[key] && colFilters[key]!.trim());
  }
  function clearColFilter(key: ColKey) {
    if (key === 'status') setStatusFilter([]);
    else setColFilters(p => { const n = { ...p }; delete n[key]; return n; });
  }
  function applyColFilters(rows: CaseRow[]): CaseRow[] {
    let out = rows;
    for (const key of TEXT_COLS) {
      const v = colFilters[key];
      if (v && v.trim()) {
        const f = v.toLowerCase();
        out = out.filter(c => (cellText(c, key) || '').toLowerCase().includes(f));
      }
    }
    if (statusFilter.length) out = out.filter(c => statusFilter.includes(c.status));
    return out;
  }
  const colFilterCount = TEXT_COLS.filter(isColFiltered).length + (statusFilter.length ? 1 : 0);

  const columns: Record<ColKey, ColumnDef> = {
    sno: {
      key: 'sno', label: 'S.NO', className: 'col-sno', locked: true,
      render: (_c, i) => <td className="sno">{i + 1}</td>,
    },
    id: {
      key: 'id', label: 'FIR / DD No.',
      render: (c) => (
        <td className="fir">
          <Link
            to={`/case-property/${encodeURIComponent(c.id)}`}
            className="case-link"
            onClick={(e) => e.stopPropagation()}
            title={`Open ${c.id} detail page`}
          >{c.id}</Link>
        </td>
      ),
    },
    seizingOfficer: {
      key: 'seizingOfficer', label: 'Seizing Officer',
      render: (c) => <td>{c.seizingOfficer}</td>,
    },
    itemType: {
      key: 'itemType', label: 'Item Type',
      render: (c) => <td className="type">{c.itemType}</td>,
    },
    quantity: {
      key: 'quantity', label: 'Quant', className: 'col-quant',
      render: (c) => <td className="quant">{c.quantity || '1'}</td>,
    },
    section: {
      key: 'section', label: 'Location',
      render: (c) => (
        <td>
          <span
            className="section-tag"
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={(e) => { e.stopPropagation(); onClearSection(); }}
            title={`Part ${c.section?.replace('PART ', '') || '?'} — click rack name in sidebar to filter`}
          >
            <small style={{ opacity: 0.7, fontWeight: 500 }}>{c.section?.replace('PART ', '')}</small>
            <span>{c.sectionName}</span>
          </span>
        </td>
      ),
    },
    status: {
      key: 'status', label: 'Status',
      render: (c) => (
        <td>
          <span className={`stamp ${statusClass(c.status)}`}>{c.status}</span>
        </td>
      ),
    },
    lastMovement: {
      key: 'lastMovement', label: 'Last Movement Date',
      render: (c) => <td className="date-col">{c.lastMovement ? c.lastMovement : '—'}</td>,
    },
    actions: {
      key: 'actions', label: 'Actions', className: 'col-actions', locked: true,
      render: (c) => (
        <td>
          <div className="row-actions">
            <Link
              to={`/case-property/${encodeURIComponent(c.id)}?tab=tag`}
              className="icon-btn"
              onClick={(e) => e.stopPropagation()}
              title="View evidence tag (real QR) on detail page"
            >▦</Link>
            <Link
              to={`/case-property/${encodeURIComponent(c.id)}?tab=timeline`}
              className="icon-btn"
              onClick={(e) => e.stopPropagation()}
              title="View movement log on detail page"
            >⏱</Link>
            <div className="icon-btn" title="Change status (record a movement)" onClick={(e) => { e.stopPropagation(); onChangeStatus(c); }}>↻</div>
          </div>
        </td>
      ),
    },
  };

  function onDrop(target: ColKey) {
    if (!dragKey || dragKey === target) return;
    setOrder((o) => {
      const next = o.filter((k) => k !== dragKey);
      const idx = next.indexOf(target);
      next.splice(idx, 0, dragKey);
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
      return next;
    });
    setDragKey(null);
  }

  function resetColumns() {
    setOrder([...DEFAULT_ORDER]);
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }

  // Three filters: text + section + status.  When `excludeDisposed` is set
  // (dashboard "Pending Disposal" tile), the 'Disposed' rows are dropped on
  // top of any other filters.
  const bySection = activeSection
    ? cases.filter(c => c.section === `PART ${activeSection}`)
    : cases;

  const byStatus = activeStatus
    ? bySection.filter(c => c.status === activeStatus)
    : bySection;

  const byExcludeDisposed = excludeDisposed
    ? byStatus.filter(c => c.status !== 'Disposed')
    : byStatus;

  const searchFiltered = byExcludeDisposed.filter(c => {
    if (!textFilter) return true;
    const f = textFilter.toLowerCase();
    return c.id.toLowerCase().includes(f)
        || c.itemType.toLowerCase().includes(f)
        || (c.description || c.itemSub || '').toLowerCase().includes(f)
        || c.seizingOfficer.toLowerCase().includes(f)
        || c.sectionName.toLowerCase().includes(f)
        || c.status.toLowerCase().includes(f);
  });

  const visible = applyColFilters(searchFiltered);

  return (
    <div className={`view${active ? ' active' : ''}`} id="view-caseproperty">
      <div className="page-head">
        <div>
          <h1>Case Property Register</h1>
          <div className="sub">
            {visible.length} of {cases.length} items
            {activeSection && <> · location: <b>Part {activeSection}</b></>}
            {!activeSection && <> · all locations</>}
            {colFilterCount > 0 && <> · <b>{colFilterCount}</b> column filter{colFilterCount > 1 ? 's' : ''} active</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn ghost" onClick={() => onDownloadReport('xlsx')} title="Download currently filtered cases as Excel">⬇ Download Report (Excel)</button>
          <button className="btn ghost" onClick={() => onDownloadReport('pdf')}  title="Download currently filtered cases as PDF">⬇ Download Report (PDF)</button>
          <button className="btn" onClick={onOpenRegister}>+ Register New Case Property</button>
        </div>
      </div>

      {activeSection && (
        <div className="section-banner">
          Showing only <b>Part {activeSection}</b> cases
          <button className="section-banner-clear" onClick={onClearSection}>× clear filter</button>
        </div>
      )}

      {activeStatus && (
        <div className="section-banner" style={{ background: 'rgba(140,122,84,0.10)', borderColor: 'var(--khaki)' }}>
          Filtered by status: <b>{activeStatus}</b>
          {onClearStatus && (
            <button className="section-banner-clear" onClick={onClearStatus}>× clear</button>
          )}
        </div>
      )}

      {excludeDisposed && (
        <div className="section-banner" style={{ background: 'rgba(140,122,84,0.10)', borderColor: 'var(--khaki)' }}>
          Showing all non-disposed cases
          {onClearExcludeDisposed && (
            <button className="section-banner-clear" onClick={onClearExcludeDisposed}>× clear</button>
          )}
        </div>
      )}

      {colFilterCount > 0 && (
        <div className="section-banner" style={{ background: 'rgba(140,122,84,0.10)', borderColor: 'var(--khaki)' }}>
          Column filters:{' '}
          {TEXT_COLS.filter(isColFiltered).map(key => (
            <span key={key} className="cfp-chip">{columns[key].label}: <b>{colFilters[key]}</b>
              <button className="section-banner-clear" onClick={() => clearColFilter(key)}>×</button>
            </span>
          ))}
          {statusFilter.length > 0 && (
            <span className="cfp-chip">Status: <b>{statusFilter.join(' / ')}</b>
              <button className="section-banner-clear" onClick={() => setStatusFilter([])}>×</button>
            </span>
          )}
        </div>
      )}

      <div className="scan-bar">
        <span className="scan-label">Search</span>
        <input
          placeholder="Filter by FIR/DD, item, officer, status…  (press Enter to open scanner)"
          value={textFilter}
          onChange={e => setTextFilter(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && textFilter.trim()) onOpenScan(); }}
        />
        <button className="btn small scan-btn" onClick={onOpenScan}>Scan QR</button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>All Case Property</h2>
          <span className="meta">
            <span className="col-reorder-hint" title="Drag a column header left/right to reorder it. Layout is saved on this device.">⠿ drag headers to reorder</span>
            <button className="btn tiny ghost" onClick={resetColumns} title="Reset columns to default order">reset</button>
            &nbsp; ▦ evidence tag &nbsp; ⏱ movement log &nbsp; ↻ change status
          </span>
        </div>
        <table className="register-table">
          <thead>
            <tr>
              {order.map((key) => {
                const col = columns[key];
                return (
                  <th
                    key={key}
                    data-colpop
                    className={[col.className, col.locked ? '' : 'col-draggable', !col.locked && openCol === key ? 'col-filter-open' : '', isColFiltered(key) ? 'col-filtered' : ''].filter(Boolean).join(' ')}
                    draggable={!col.locked}
                    title={!col.locked ? `Click heading to filter by ${col.label}` : undefined}
                    onClick={() => { if (!col.locked) setOpenCol(o => o === key ? null : key); }}
                    onDragStart={(e) => { setDragKey(key); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragOver={(e) => { if (!col.locked) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); } }}
                    onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
                    onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag-over'); onDrop(key); }}
                    onDragEnd={() => setDragKey(null)}
                  >
                    {!col.locked && <span className="drag-handle" aria-hidden>⠿</span>}
                    {col.label}
                    {isColFiltered(key) && <span className="col-filter-dot" title="Column filtered">▾</span>}
                    {!col.locked && openCol === key && (
                      <div className="col-filter-pop" onClick={e => e.stopPropagation()}>
                        {key === 'status' ? (
                          <>
                            <div className="cfp-title">Filter by Status</div>
                            <div className="cfp-checks">
                              {ALL_STATUSES.map(s => (
                                <label key={s} className="cfp-check">
                                  <input
                                    type="checkbox"
                                    checked={statusFilter.includes(s)}
                                    onChange={() => setStatusFilter(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])}
                                  />
                                  <span className={`stamp ${statusClass(s)}`}>{s}</span>
                                </label>
                              ))}
                            </div>
                            <div className="cfp-actions">
                              <button className="btn tiny ghost" onClick={() => setStatusFilter([])}>Clear</button>
                              <button className="btn tiny" onClick={() => setOpenCol(null)}>Done</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="cfp-title">Filter by {col.label}</div>
                            <input
                              autoFocus
                              className="cfp-input"
                              placeholder={`Type ${col.label}…`}
                              value={colFilters[key] || ''}
                              onChange={e => setColFilters(p => ({ ...p, [key]: e.target.value }))}
                            />
                            <div className="cfp-actions">
                              <button className="btn tiny ghost" onClick={() => clearColFilter(key)}>Clear</button>
                              <button className="btn tiny" onClick={() => setOpenCol(null)}>Done</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={order.length} style={{ textAlign: 'center', color: 'var(--slate-soft)' }}>
                No matching cases. {activeSection && <a href="#" onClick={e => { e.preventDefault(); onClearSection(); }}>Clear location filter</a>}
                {textFilter && <a href="#" onClick={e => { e.preventDefault(); setTextFilter(''); }}>Clear text filter</a>}
              </td></tr>
            )}
            {visible.map((c, i) => (
              <tr
                key={c.id}
                className="row-clickable"
                onClick={() => navigate(`/case-property/${encodeURIComponent(c.id)}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/case-property/${encodeURIComponent(c.id)}`); }}
                tabIndex={0}
                role="link"
                aria-label={`Open ${c.id} detail page`}
                title={`Open ${c.id} detail page`}
              >
                {order.map((key) => columns[key].render(c, i))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
