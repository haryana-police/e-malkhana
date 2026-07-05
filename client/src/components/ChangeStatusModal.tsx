import { useState } from 'react';
import { api } from '../api';
import type { CaseRow, CaseStatus } from '../types';

interface Props {
  open: boolean;
  caseRow: CaseRow | null;
  onClose: () => void;
  onChanged: () => void;
}

// The "natural" forward status transitions (reversible but discouraged).
// We present them in a logical order:  Seized -> In Malkhana -> FSL/Expert -> In Court -> Disposed
const FORWARD: Record<CaseStatus, CaseStatus[]> = {
  'Seized':                 ['In Malkhana', 'With FSL', 'Expert Opinion Pending'],
  'In Malkhana':            ['With FSL', 'Expert Opinion Pending', 'In Court', 'Disposed'],
  'With FSL':               ['In Malkhana', 'In Court'],
  'Expert Opinion Pending': ['In Malkhana', 'In Court'],
  'In Court':               ['In Malkhana', 'Disposed'],
  'Disposed':               ['In Malkhana'],
};

const QUICK_LOCATIONS: Record<CaseStatus, string> = {
  'Seized':                 'Scene',
  'In Malkhana':            'Malkhana',
  'With FSL':               'FSL Madhuban',
  'Expert Opinion Pending': 'Civil Hospital Panchkula',
  'In Court':               'Court',
  'Disposed':               'Disposed',
};

const QUICK_PURPOSE: Record<CaseStatus, string> = {
  'Seized':                 'Seizure check-in',
  'In Malkhana':            'Returned to malkhana',
  'With FSL':               'Sent for forensic analysis',
  'Expert Opinion Pending': 'Sent for chemical opinion',
  'In Court':               'Produced as exhibit',
  'Disposed':               'Disposed per court order',
};

export function ChangeStatusModal({ open, caseRow, onClose, onChanged }: Props) {
  const [nextStatus, setNextStatus] = useState<CaseStatus | ''>('');
  const [toLocation, setToLocation] = useState('');
  const [purpose, setPurpose]       = useState('');
  const [docRef, setDocRef]         = useState('');
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Default the form whenever a new case is opened
  if (open && caseRow && !nextStatus) {
    const opts = FORWARD[caseRow.status] || [];
    setNextStatus(opts[0] ?? '');
    setToLocation(QUICK_LOCATIONS[opts[0] ?? ''] ?? caseRow.sectionName);
    setPurpose(QUICK_PURPOSE[opts[0] ?? ''] ?? 'Movement');
  }

  function reset() {
    setNextStatus(''); setToLocation(''); setPurpose(''); setDocRef(''); setMsg(null);
  }

  function onPickStatus(s: CaseStatus) {
    setNextStatus(s);
    setToLocation(QUICK_LOCATIONS[s] ?? '');
    setPurpose(QUICK_PURPOSE[s] ?? 'Movement');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow || !nextStatus) return;
    setBusy(true); setMsg(null);
    try {
      // record the movement + change status in one call
      await api.createMovement({
        caseId: caseRow.id,
        toLocation: toLocation || QUICK_LOCATIONS[nextStatus],
        movedBy: 'SI Rakesh Sharma',
        purpose: purpose || QUICK_PURPOSE[nextStatus],
        docRef,
        setStatus: nextStatus,
      });
      setMsg({ kind: 'ok', text: `Status changed: ${caseRow.status} → ${nextStatus}. Movement logged.` });
      onChanged();
      setTimeout(() => { reset(); onClose(); }, 900);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!caseRow) return null;

  const allowed = FORWARD[caseRow.status] || [];

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <form className="form-card" onSubmit={submit}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Change Status — {caseRow.id}</h3>
        <div className="sub">
          {caseRow.itemType} &nbsp;·&nbsp; <b>Current status: {caseRow.status}</b> &nbsp;·&nbsp; {caseRow.sectionName}
        </div>

        <div className="form-grid">
          <label className="full">
            Move to status
            <select value={nextStatus} onChange={e => onPickStatus(e.target.value as CaseStatus)} required>
              <option value="">— pick a new status —</option>
              {allowed.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            To location
            <input value={toLocation} onChange={e => setToLocation(e.target.value)} placeholder="e.g. Malkhana — Part B" required />
          </label>
          <label>
            Document ref (optional)
            <input value={docRef} onChange={e => setDocRef(e.target.value)} placeholder="e.g. FSL-FWD-2026-114" />
          </label>
          <label className="full">
            Purpose of movement
            <input value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="e.g. For forensic analysis" />
          </label>
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !nextStatus}>
            {busy ? 'Recording…' : 'Record movement & change status'}
          </button>
        </div>
      </form>
    </div>
  );
}
