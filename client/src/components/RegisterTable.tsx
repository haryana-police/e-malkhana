import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CaseRow, CaseStatus } from '../types';

interface Props {
  cases: CaseRow[];
  compact?: boolean;                 // Dashboard: cap rows + show "view all" link
  activeSection?: string | null;
  onClearSection?: () => void;
  activeStatus?: CaseStatus | null;
  onClearStatus?: () => void;
  excludeDisposed?: boolean;
  onClearExcludeDisposed?: () => void;
  onOpenTag?: (c: CaseRow) => void;
  onOpenTimeline?: (fir: string) => void;
  onOpenScan?: () => void;
  onChangeStatus?: (c: CaseRow) => void;
  onDownloadReport?: (format: 'xlsx' | 'pdf', ids?: string[]) => void;
  onOpenRegister?: () => void;
  onViewAll?: () => void;            // Dashboard "View full register →"
  pagerTop?: boolean;               // also render page controls above the table
};

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
type ColKey =
  | 'sno' | 'id' | 'firDate' | 'usSection'
  | 'category' | 'location' | 'receivedBy'
  | 'lastMovement' | 'status' | 'actions';

interface ColumnDef {
  key: ColKey;
  label: string;
  className?: string;
  locked?: boolean;                 // S.NO + Actions stay put
  render: (c: CaseRow, i: number) => React.ReactNode;
}

// Statutory order: S.No · FIR/DD No. · FIR Date · Section (U/S) ·
// Category of Item · Location · Received By (Moharrir) · Last Movement
// Date · Status · Action.
const DEFAULT_ORDER: ColKey[] = [
  'sno', 'id', 'firDate', 'usSection',
  'category', 'location', 'receivedBy',
  'lastMovement', 'status', 'actions',
];

// U/S (legal section) — "BNS 101 — Murder · BNS 22 — …".
function usSectionText(c: CaseRow): string {
  if (c.legalSections && c.legalSections.length) {
    return c.legalSections
      .map((s, i) => `BNS ${s}${c.legalSectionsTitles && c.legalSectionsTitles[i] ? ' — ' + c.legalSectionsTitles[i] : ''}`)
      .join(' · ');
  }
  if (c.legalSection) return `BNS ${c.legalSection}${c.legalSectionTitle ? ' — ' + c.legalSectionTitle : ''}`;
  return '';
}

export function RegisterTable({
  cases, compact,
  activeSection, onClearSection,
  activeStatus, onClearStatus,
  excludeDisposed, onClearExcludeDisposed,
  onOpenTag, onOpenTimeline, onOpenScan, onChangeStatus,
  onDownloadReport, onOpenRegister, onViewAll, pagerTop,
}: Props) {
  const [textFilter, setTextFilter] = useState('');
  const order: ColKey[] = DEFAULT_ORDER;
  const navigate = useNavigate();
  const PAGE_SIZE = 8;
  const [page, setPage] = useState(1);

  const [openCol, setOpenCol] = useState<ColKey | null>(null);
  const [colFilters, setColFilters] = useState<Partial<Record<ColKey, string>>>({});
  const [statusFilter, setStatusFilter] = useState<CaseStatus[]>([]);

  // Reset to first page whenever the filter result changes.
  useEffect(() => { setPage(1); }, [textFilter, colFilters, statusFilter, activeSection, activeStatus, excludeDisposed]);

  useEffect(() => {
    if (!openCol) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-colpop]')) setOpenCol(null);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [openCol]);

  const TEXT_COLS: ColKey[] = ['id', 'firDate', 'usSection', 'category', 'location', 'receivedBy', 'lastMovement'];

  function cellText(c: CaseRow, key: ColKey): string {
    switch (key) {
      case 'id': return c.id;
      case 'firDate': return c.firDate || '';
      case 'usSection': return usSectionText(c);
      case 'category': return c.itemType || '';
      case 'location': return c.sectionName || '';
      case 'receivedBy': return c.receivedBy || '';
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
    firDate: {
      key: 'firDate', label: 'FIR Date', className: 'col-firdate',
      render: (c) => <td className="date-col">{c.firDate ? c.firDate : '—'}</td>,
    },
    usSection: {
      key: 'usSection', label: 'Section (U/S legal section)', className: 'col-us',
      render: (c) => {
        const txt = usSectionText(c);
        return <td className="us-section">{txt ? txt : '—'}</td>;
      },
    },
    category: {
      key: 'category', label: 'Category of Item', className: 'col-category',
      render: (c) => <td className="type">{c.itemType}</td>,
    },
    location: {
      key: 'location', label: 'Location',
      render: (c) => (
        <td>
          <span
            className="section-tag"
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={(e) => { e.stopPropagation(); if (onClearSection) onClearSection(); }}
            title={`Part ${c.section?.replace('PART ', '') || '?'} — click rack name in sidebar to filter`}
          >
            <small style={{ opacity: 0.7, fontWeight: 500 }}>{c.section?.replace('PART ', '')}</small>
            <span>{c.sectionName}</span>
          </span>
        </td>
      ),
    },
    receivedBy: {
      key: 'receivedBy', label: 'Received By (Malkhana Moharrir)', className: 'col-received',
      render: (c) => <td>{c.receivedBy ? c.receivedBy : '—'}</td>,
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
      key: 'actions', label: 'Action', className: 'col-actions', locked: true,
      render: (c) => (
        <td>
          <div className="row-actions-vertical">
            <button
              type="button"
              className="act-btn act-tag"
              title="View evidence tag (real QR)"
              onClick={(e) => { e.stopPropagation(); if (onOpenTag) onOpenTag(c); }}
            ><span className="act-ico">▦</span><span className="act-lbl">evidence tag</span></button>
            <button
              type="button"
              className="act-btn act-log"
              title="View movement log"
              onClick={(e) => { e.stopPropagation(); if (onOpenTimeline) onOpenTimeline(c.id); }}
            ><span className="act-ico">⏱</span><span className="act-lbl">movement log</span></button>
            <button
              type="button"
              className="act-btn act-status"
              title="Change status (record a movement)"
              onClick={(e) => { e.stopPropagation(); if (onChangeStatus) onChangeStatus(c); }}
            ><span className="act-ico">↻</span><span className="act-lbl">change status</span></button>
          </div>
        </td>
      ),
    },
  };

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
    const us = usSectionText(c).toLowerCase();
    return c.id.toLowerCase().includes(f)
        || (c.itemId || '').toLowerCase().includes(f)
        || c.itemType.toLowerCase().includes(f)
        || (c.description || c.itemSub || '').toLowerCase().includes(f)
        || (c.receivedBy || '').toLowerCase().includes(f)
        || (c.firDate || '').toLowerCase().includes(f)
        || c.sectionName.toLowerCase().includes(f)
        || us.includes(f)
        || c.status.toLowerCase().includes(f);
  });

  const visible = applyColFilters(searchFiltered);

  // Newest first: by createdAt (malkhana entry time).  Stable fallback so
  // equal/blank dates keep their original array order.
  const sorted = [...visible].sort((a, b) => {
    const da = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const db = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (!isNaN(da) && !isNaN(db)) return db - da;
    if (!isNaN(db)) return 1;
    if (!isNaN(da)) return -1;
    return 0;
  });

  // Both modes are paginated at PAGE_SIZE.  Compact (Dashboard) was
  // previously capped at 8 with a "view all" link; now it just pages like
  // the full register so the Dashboard can reach every page too.
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const shown = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const renderPager = () => (
    <div className="rt-pager">
      <button className="pg-btn" disabled={safePage === 1} onClick={() => setPage(1)} title="First page">«</button>
      <button className="pg-btn" disabled={safePage === 1} onClick={() => setPage(p => Math.max(1, p - 1))} title="Previous">‹ Prev</button>
      {Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter(p => p === 1 || p === totalPages || (p >= safePage - 2 && p <= safePage + 2))
        .map((p, idx, arr) => (
          <span key={p} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {idx > 0 && p !== arr[idx - 1] + 1 && <span className="pg-ellipsis">…</span>}
            <button
              className={`pg-btn${p === safePage ? ' active' : ''}`}
              onClick={() => setPage(p)}
            >{p}</button>
          </span>
        ))}
      <button className="pg-btn" disabled={safePage === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} title="Next">Next ›</button>
      <button className="pg-btn" disabled={safePage === totalPages} onClick={() => setPage(totalPages)} title="Last page">»</button>
      <span className="pg-info">Page {safePage} of {totalPages} · {sorted.length} items</span>
    </div>
  );

  return (
    <div className="register-wrap">
      {(onDownloadReport || onOpenRegister || onOpenScan) && (
        <div className="page-head" style={{ marginTop: 0 }}>
          <div>
            <h1>Case Property Register</h1>
          </div>
          <div className="register-head-actions">
            {onDownloadReport && <button className="btn small btn-excel" onClick={() => onDownloadReport('xlsx', shown.map(c => c.id))} title="Download currently filtered cases as Excel">⬇ Excel</button>}
            {onDownloadReport && <button className="btn small btn-pdf" onClick={() => onDownloadReport('pdf', shown.map(c => c.id))}   title="Download currently filtered cases as PDF">⬇ PDF</button>}
            {onOpenRegister && <button className="btn small register-head-add" onClick={onOpenRegister}>+ Register New</button>}
          </div>
        </div>
      )}

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
          onKeyDown={e => { if (e.key === 'Enter' && textFilter.trim() && onOpenScan) onOpenScan(); }}
        />
        {onOpenScan && <button className="btn small scan-btn" onClick={onOpenScan}>Scan QR</button>}
      </div>

      {pagerTop && totalPages > 1 && renderPager()}

      <div className="panel">
        <table className="register-table">
          <thead>
            <tr>
              {order.map((key) => {
                const col = columns[key];
                return (
                  <th
                    key={key}
                    data-colpop
                    className={[col.className, openCol === key ? 'col-filter-open' : '', isColFiltered(key) ? 'col-filtered' : ''].filter(Boolean).join(' ')}
                    title={`Click heading to filter by ${col.label}`}
                    onClick={() => setOpenCol(o => o === key ? null : key)}
                  >
                    {col.label}
                    {isColFiltered(key) && <span className="col-filter-dot" title="Column filtered">▾</span>}
                    {openCol === key && (
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
                No matching cases. {activeSection && <a href="#" onClick={e => { e.preventDefault(); if (onClearSection) onClearSection(); }}>Clear location filter</a>}
                {textFilter && <a href="#" onClick={e => { e.preventDefault(); setTextFilter(''); }}>Clear text filter</a>}
              </td></tr>
            )}
            {shown.map((c, i) => (
              <tr
                key={c.id}
                className="row-clickable"
                onClick={() => navigate(`/case-property/${encodeURIComponent(c.id)}`, { state: { sno: i + 1 } })}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/case-property/${encodeURIComponent(c.id)}`, { state: { sno: i + 1 } }); }}
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
