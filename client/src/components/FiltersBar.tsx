import type { CaseStatus } from '../types';
import { useEffect, useRef } from 'react';

// ---- date helpers (DD-MM-YYYY <-> YYYY-MM-DD) -------------------------
export function parseDMY(s: string): string | null {
  const m = String(s || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function toDMY(s: string): string {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}
export function isValidDMY(s: string): boolean {
  return s.trim() === '' || parseDMY(s) !== null;
}

// ---- inline SVGs (outline style matching the design system) ----------
export function FunnelIcon() {
  return (
    <svg className="fb-ico" viewBox="0 0 24 24" width="14" height="14" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h18l-7 8v6l-4 2v-8z" />
    </svg>
  );
}
export function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 2.5v4M16 2.5v4" />
    </svg>
  );
}

// ---- a single DD-MM-YYYY date field with a calendar trigger ----------
export function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const dateRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="date-field">
      <input
        type="text"
        className={`date-input${value && !isValidDMY(value) ? ' invalid' : ''}`}
        placeholder="dd-mm-yyyy"
        value={value}
        inputMode="numeric"
        onChange={e => onChange(e.target.value)}
        aria-label="Date (dd-mm-yyyy)"
      />
      <button
        type="button"
        className="date-cal"
        aria-label="Pick date"
        onClick={() => {
          const el = dateRef.current;
          if (!el) return;
          if (typeof el.showPicker === 'function') el.showPicker();
          else el.click();
        }}
      >
        <CalendarIcon />
      </button>
      <input
        ref={dateRef}
        type="date"
        className="date-hidden"
        value={parseDMY(value) ?? ''}
        onChange={e => onChange(e.target.value ? toDMY(e.target.value) : '')}
      />
    </div>
  );
}

export const ALL_STATUSES: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana', 'With FSL',
  'In Court', 'Disposed', 'Transfer',
];

export interface SectionOpt {
  letter: string;
  name: string;
  label: string;
}

// ---- the Filters pill button (funnel icon + active count badge) -------
export function FilterButton({
  activeCount, open, onToggle,
}: {
  activeCount: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-btn${open || activeCount ? ' active' : ''}`}
      onClick={onToggle}
      title="Filter (date-wise, section-wise, status-wise)"
    >
      <FunnelIcon />
      <span>Filters</span>
      {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
    </button>
  );
}

// ---- the popover panel: date-wise · section-wise · status-wise --------
export function FilterPanel({
  dateFrom, setDateFrom, dateTo, setDateTo,
  sectionOptions, selSections, toggleSection,
  selStatuses, toggleStatus, onClearAll,
}: {
  dateFrom: string; setDateFrom: (v: string) => void;
  dateTo: string; setDateTo: (v: string) => void;
  sectionOptions: SectionOpt[];
  selSections: string[]; toggleSection: (letter: string) => void;
  selStatuses: CaseStatus[]; toggleStatus: (s: CaseStatus) => void;
  onClearAll: () => void;
}) {
  const dateText =
    dateFrom && dateTo ? `${dateFrom} → ${dateTo}`
      : dateFrom ? `from ${dateFrom}`
        : dateTo ? `until ${dateTo}` : '';

  return (
    <div className="filter-pop">
      <div className="filter-grid">
        <div className="filter-col">
          <h4>Date-wise (FIR/DD date)</h4>
          <div className="date-range">
            <DateField value={dateFrom} onChange={setDateFrom} />
            <span className="date-dash">–</span>
            <DateField value={dateTo} onChange={setDateTo} />
          </div>
          <div className="f-range-text">
            {dateText ? `Range: ${dateText}` : 'All dates'}
          </div>
        </div>

        <div className="filter-col">
          <h4>Section-wise</h4>
          <div className="f-chips">
            {sectionOptions.map(o => (
              <button
                key={o.letter}
                type="button"
                className={`f-chip${selSections.includes(o.letter) ? ' on' : ''}`}
                onClick={() => toggleSection(o.letter)}
              >
                {o.label}
              </button>
            ))}
            {sectionOptions.length === 0 && <span className="f-empty">No sections</span>}
          </div>
        </div>

        <div className="filter-col">
          <h4>Status-wise</h4>
          <div className="f-chips">
            {ALL_STATUSES.map(s => (
              <button
                key={s}
                type="button"
                className={`f-chip${selStatuses.includes(s) ? ' on' : ''}`}
                onClick={() => toggleStatus(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="filter-actions">
        <button type="button" className="btn small ghost" onClick={onClearAll}>Clear all</button>
        <button type="button" className="btn small" onClick={onClearAll}>Done</button>
      </div>
    </div>
  );
}

// Close helper: dismiss the panel when clicking outside of it.
export function useOutsideClose(refs: React.RefObject<HTMLElement>[], onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (refs.some(r => r.current && r.current.contains(t))) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [active, onClose, refs]);
}
