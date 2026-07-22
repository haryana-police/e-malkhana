import { useState } from 'react';
import { api } from '../api';
import type { CaseRow, CaseStatus } from '../types';
import { MovementForm, type MovementFormData } from './MovementForm';

interface Props {
  open: boolean;
  caseRow: CaseRow | null;
  onClose: () => void;
  onChanged: () => void;
}

// "Transfer" is not a real case status — it's a location-to-location move
// that leaves the case status unchanged.  We model it as a pseudo-option in
// the same dropdown so the UI stays a single, familiar control.
type SelectedStatus = CaseStatus | 'Transfer';

// The forward transitions offered in addition to the Movement Types vocab
// (used only as a fallback when the server vocab is unreachable).
const FORWARD: Record<CaseStatus, CaseStatus[]> = {
  'Seized':                 ['In Malkhana', 'With FSL', 'Expert Opinion Pending'],
  'In Malkhana':            ['With FSL', 'Expert Opinion Pending', 'In Court', 'Disposed'],
  'With FSL':               ['In Malkhana', 'In Court'],
  'Expert Opinion Pending': ['In Malkhana', 'In Court'],
  'In Court':               ['In Malkhana', 'Disposed'],
  'Disposed':               ['In Malkhana'],
  'Transfer':               ['In Malkhana', 'With FSL', 'Expert Opinion Pending', 'In Court', 'Disposed'],
};

export function ChangeStatusModal({ open, caseRow, onClose, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fromLocation, setFromLocation] = useState('—');

  function reset() {
    setMsg(null);
  }

  async function handleSubmit(data: MovementFormData) {
    if (!caseRow) return;
    const isTransfer = data.toStatus === 'Transfer';
    // If no status chosen, default to current status (pure movement).
    const status = data.toStatus
      ? (isTransfer ? 'Transfer' : (STATUSES_OK.has(data.toStatus as CaseStatus) ? data.toStatus as CaseStatus : caseRow.status))
      : caseRow.status;
    setBusy(true); setMsg(null);
    try {
      await api.createMovement({
        caseId: caseRow.id,
        toLocation: data.toLocation || '',
        movedBy: data.movedBy,
        purpose: data.purpose,
        docRef: data.docRef,
        setStatus: status as CaseStatus,
      });
      const text = isTransfer
        ? `Transfer logged → ${data.toLocation || 'new location'}. Status set to Transfer.`
        : `Status changed: ${caseRow.status} → ${status}. Movement logged.`;
      setMsg({ kind: 'ok', text });
      onChanged();
      setTimeout(() => { reset(); onClose(); }, 900);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!caseRow) return null;

  // Initial status hint: forward transition, or just leave blank so the
  // MovementForm's vocabulary drives it.
  const forward = FORWARD[caseRow.status] || [];
  const initialStatus = forward[0] ?? '';

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <div className="form-card">
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Change Status — {caseRow.id}</h3>
        <div className="sub">
          {caseRow.itemType} &nbsp;·&nbsp; <b>Current status: {caseRow.status}</b> &nbsp;·&nbsp; {caseRow.sectionName}
        </div>

        <MovementForm
          caseRow={caseRow}
          fromLocation={fromLocation}
          busy={busy}
          requireStatus={false}
          submitLabel={initialStatus === 'Transfer' ? 'Record transfer' : 'Record movement & change status'}
          initialStatus={initialStatus}
          onSubmit={handleSubmit}
          onCancel={() => { reset(); onClose(); }}
        />

        {msg && <div className={`form-msg show ${msg.kind}`} style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>
    </div>
  );
}

const STATUSES_OK = new Set<string>([
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed', 'Transfer',
]);

export default ChangeStatusModal;
