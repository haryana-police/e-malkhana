import { useState } from 'react';
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
}

function statusClass(s: CaseStatus): string {
  switch (s) {
    case 'Seized':                  return 'seized';
    case 'Expert Opinion Pending':  return 'expert';
    case 'In Malkhana':             return 'malkhana';
    case 'With FSL':                return 'fsl';
    case 'In Court':                return 'court';
    case 'Disposed':                return 'disposed';
  }
}

export function CaseProperty({
  cases, activeSection, onClearSection,
  activeStatus, onClearStatus,
  excludeDisposed, onClearExcludeDisposed,
  onOpenTag, onOpenTimeline, onOpenScan, onOpenRegister, onChangeStatus, active,
}: Props) {
  const [textFilter, setTextFilter] = useState('');

  // Three filters: text + section + status.  When `excludeDisposed` is set
  // (dashboard "Pending Disposal" tile), the 'Disposed' rows are dropped on
  // top of any other filters — the count on the tile then matches the rows
  // the user actually sees.
  const bySection = activeSection
    ? cases.filter(c => c.section === `PART ${activeSection}`)
    : cases;

  const byStatus = activeStatus
    ? bySection.filter(c => c.status === activeStatus)
    : bySection;

  const byExcludeDisposed = excludeDisposed
    ? byStatus.filter(c => c.status !== 'Disposed')
    : byStatus;

  const visible = byExcludeDisposed.filter(c => {
    if (!textFilter) return true;
    const f = textFilter.toLowerCase();
    return c.id.toLowerCase().includes(f)
        || c.itemType.toLowerCase().includes(f)
        || c.itemSub.toLowerCase().includes(f)
        || c.seizingOfficer.toLowerCase().includes(f)
        || c.sectionName.toLowerCase().includes(f)
        || c.status.toLowerCase().includes(f);
  });

  return (
    <div className={`view${active ? ' active' : ''}`} id="view-caseproperty">
      <div className="page-head">
        <div>
          <h1>Case Property Register</h1>
          <div className="sub">
            {visible.length} of {cases.length} items
            {activeSection && <> · filtered by section: <b>Part {activeSection}</b></>}
            {!activeSection && <> · filtered by: all sections</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost" onClick={onOpenScan}>Open Scanner</button>
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
          <span className="meta">▦ evidence tag &nbsp; ⏱ movement log &nbsp; ↻ change status</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>FIR / DD No.</th>
              <th>Item</th>
              <th>Section</th>
              <th>Status</th>
              <th>Seizing Officer</th>
              <th>Seized On</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--slate-soft)' }}>
                No matching cases. {activeSection && <a href="#" onClick={e => { e.preventDefault(); onClearSection(); }}>Clear section filter</a>}
                {textFilter && <a href="#" onClick={e => { e.preventDefault(); setTextFilter(''); }}>Clear text filter</a>}
              </td></tr>
            )}
            {visible.map(c => (
              <tr key={c.id}>
                <td className="fir">{c.id}</td>
                <td className="item-desc">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    {c.imageUrl && <img src={c.imageUrl} alt="" className="case-thumb" />}
                    <div>
                      <div className="type">{c.itemType}</div>
                      <div className="sub">{c.itemSub}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    className="section-tag"
                    style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    onClick={() => { onClearSection(); /* will reset filter, then re-set via sidebar */ }}
                    title={`Part ${c.section?.replace('PART ', '') || '?'} — click rack name in sidebar to filter`}
                  >
                    <small style={{ opacity: 0.7, fontWeight: 500 }}>{c.section?.replace('PART ', '')}</small>
                    <span>{c.sectionName}</span>
                  </span>
                </td>
                <td>
                  <span className={`stamp ${statusClass(c.status)}`}>
                    {c.status}
                  </span>
                </td>
                <td>{c.seizingOfficer}</td>
                <td>{c.seizedOn}</td>
                <td>
                  <div className="row-actions">
                    <div className="icon-btn" title="View evidence tag (real QR)" onClick={() => onOpenTag(c)}>▦</div>
                    <div className="icon-btn" title="View movement log" onClick={() => onOpenTimeline(c.id)}>⏱</div>
                    <div className="icon-btn" title="Change status (record a movement)" onClick={() => onChangeStatus(c)}>↻</div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
