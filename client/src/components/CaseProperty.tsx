import type { CaseRow, CaseStatus } from '../types';
import { RegisterTable } from './RegisterTable';
import {
  FilterButton, FilterPanel, parseDMY,
  useOutsideClose, type SectionOpt,
} from './FiltersBar';
import { useState, useMemo, useRef } from 'react';

interface Props {
  cases: CaseRow[];
  activeSection: string | null;
  onClearSection: () => void;
  setSectionFilter: (letter: string | null) => void;
  activeStatus?: CaseStatus | null;
  onClearStatus?: () => void;
  setStatusFilter: (s: CaseStatus | null) => void;
  excludeDisposed?: boolean;
  onClearExcludeDisposed?: () => void;
  onOpenTag: (c: CaseRow) => void;
  onOpenTimeline: (fir: string) => void;
  onOpenScan: () => void;
  onOpenRegister: () => void;
  onChangeStatus: (c: CaseRow) => void;
  active?: boolean;
  onDownloadReport: (format: 'xlsx' | 'pdf' | 'html') => void;
  // Shared date range (owned by App so it persists + is included in exports).
  filterDateFrom: string; setFilterDateFrom: (v: string) => void;
  filterDateTo: string; setFilterDateTo: (v: string) => void;
}

export function CaseProperty({
  cases, activeSection, onClearSection, setSectionFilter,
  activeStatus, onClearStatus, setStatusFilter,
  excludeDisposed, onClearExcludeDisposed,
  onOpenTag, onOpenTimeline, onOpenScan, onOpenRegister, onChangeStatus, active,
  onDownloadReport,
  filterDateFrom, setFilterDateFrom,
  filterDateTo, setFilterDateTo,
}: Props) {
  const [showFilters, setShowFilters] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useOutsideClose([btnRef, popRef], () => setShowFilters(false), showFilters);

  // Sections present in the data (Section-wise options).
  const sectionOptions: SectionOpt[] = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cases) {
      if (c.section && !map.has(c.section)) map.set(c.section, c.sectionName || c.section);
    }
    return Array.from(map.entries()).map(([letter, name]) => ({
      letter,
      name,
      label: `${letter.replace('PART ', '')} · ${name}`,
    }));
  }, [cases]);

  function toggleSection(letter: string) {
    setSectionFilter(activeSection === letter ? null : letter);
  }
  function toggleStatus(s: CaseStatus) {
    setStatusFilter(activeStatus === s ? null : s);
  }
  function clearAll() {
    setFilterDateFrom(''); setFilterDateTo('');
    setSectionFilter(null);
    setStatusFilter(null);
    onClearExcludeDisposed?.();
    setShowFilters(false);
  }

  const dateActive = !!(filterDateFrom || filterDateTo);
  const activeCount =
    (dateActive ? 1 : 0) +
    (activeSection ? 1 : 0) +
    (activeStatus ? 1 : 0) +
    (excludeDisposed ? 1 : 0);

  const filterButton = (
    <div ref={btnRef}>
      <FilterButton activeCount={activeCount} open={showFilters} onToggle={() => setShowFilters(o => !o)} />
    </div>
  );
  const filterPanel = showFilters && (
    <div ref={popRef}>
      <FilterPanel
        dateFrom={filterDateFrom} setDateFrom={setFilterDateFrom}
        dateTo={filterDateTo} setDateTo={setFilterDateTo}
        sectionOptions={sectionOptions}
        selSections={activeSection ? [activeSection] : []}
        toggleSection={toggleSection}
        selStatuses={activeStatus ? [activeStatus] : []}
        toggleStatus={toggleStatus}
        notSelected={false}
        toggleNotSelected={() => {}}
        onClearAll={clearAll}
        onClose={() => setShowFilters(false)}
      />
    </div>
  );

  // The full Case Property Register now lives in the shared <RegisterTable>
  // component so the Dashboard can embed the same register.  compact=false
  // keeps the original /caseproperty behaviour (all rows, full toolbar).
  return (
    <div className={`view${active ? ' active' : ''}`} id="view-caseproperty">
      <RegisterTable
        cases={cases}
        activeSection={activeSection}
        onClearSection={onClearSection}
        activeStatus={activeStatus}
        onClearStatus={onClearStatus}
        excludeDisposed={excludeDisposed}
        onClearExcludeDisposed={onClearExcludeDisposed}
        filterButton={filterButton}
        filterPanel={filterPanel}
        onOpenTag={onOpenTag}
        onOpenTimeline={onOpenTimeline}
        onOpenScan={onOpenScan}
        onOpenRegister={onOpenRegister}
        onChangeStatus={onChangeStatus}
        onDownloadReport={onDownloadReport}
      />
    </div>
  );
}
