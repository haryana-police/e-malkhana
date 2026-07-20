import type { CaseRow, CaseStatus } from '../types';
import { RegisterTable } from './RegisterTable';

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

export function CaseProperty({
  cases, activeSection, onClearSection,
  activeStatus, onClearStatus,
  excludeDisposed, onClearExcludeDisposed,
  onOpenTag, onOpenTimeline, onOpenScan, onOpenRegister, onChangeStatus, active,
  onDownloadReport,
}: Props) {
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
