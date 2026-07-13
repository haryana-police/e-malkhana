import { useState } from 'react';
import { api } from '../api';
import type { CaseRow, CaseStatus } from '../types';

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

// Record<string,string> (not Record<CaseStatus,string>) so the 'Transfer'
// pseudo-option can carry its own quick default too.
const QUICK_LOCATIONS: Record<string, string> = {
  'Seized':                 'Scene',
  'In Malkhana':            'Malkhana',
  'With FSL':               'FSL Madhuban',
  'Expert Opinion Pending': 'Civil Hospital Panchkula',
  'In Court':               'Court',
  'Disposed':               'Disposed',
  'Transfer':               '',           // user fills the destination
};

const QUICK_PURPOSE: Record<string, string> = {
  'Seized':                 'Seizure check-in',
  'In Malkhana':            'Returned to malkhana',
  'With FSL':               'Sent for forensic analysis',
  'Expert Opinion Pending': 'Sent for chemical opinion',
  'In Court':               'Produced as exhibit',
  'Disposed':               'Disposed per court order',
  'Transfer':               'Transfer between locations',
};

function readFileAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error || new Error('Could not read file'));
    r.readAsDataURL(f);
  });
}

export function ChangeStatusModal({ open, caseRow, onClose, onChanged }: Props) {
  const [nextStatus, setNextStatus] = useState<SelectedStatus | ''>('');
  const [toLocation, setToLocation] = useState('');
  const [purpose, setPurpose]       = useState('');
  const [docRef, setDocRef]         = useState('');
  const [attached, setAttached]     = useState<{ name: string; url: string } | null>(null);
  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState<string | null>(null);
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Default the form whenever a new case is opened
  if (open && caseRow && !nextStatus) {
    const opts = FORWARD[caseRow.status] || [];
    const first = opts[0] ?? '';
    setNextStatus(first);
    setToLocation(QUICK_LOCATIONS[first] ?? caseRow.sectionName);
    setPurpose(QUICK_PURPOSE[first] ?? 'Movement');
  }

  function reset() {
    setNextStatus(''); setToLocation(''); setPurpose(''); setDocRef('');
    setAttached(null); setUploading(false); setUploadErr(null); setMsg(null);
  }

  function onPickStatus(s: SelectedStatus) {
    setNextStatus(s);
    setToLocation(QUICK_LOCATIONS[s] ?? '');
    setPurpose(QUICK_PURPOSE[s] ?? 'Movement');
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';                 // allow re-selecting the same file
    if (!file) return;
    setUploadErr(null);
    setUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await api.upload(file.name, dataUrl);
      setAttached({ name: file.name, url: res.url });
    } catch (err) {
      setUploadErr((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow || !nextStatus) return;
    const isTransfer = nextStatus === 'Transfer';
    setBusy(true); setMsg(null);
    try {
      // record the movement + change status in one call.
      // For a Transfer we intentionally do NOT change the case status.
      await api.createMovement({
        caseId: caseRow.id,
        toLocation: toLocation || QUICK_LOCATIONS[nextStatus] || '',
        movedBy: 'SI Rakesh Sharma',
        purpose: purpose || QUICK_PURPOSE[nextStatus] || 'Movement',
        // Prefer the uploaded file URL; otherwise fall back to the typed ref.
        docRef: attached?.url || docRef,
        setStatus: isTransfer ? undefined : nextStatus,
      });
      const text = isTransfer
        ? `Transfer logged → ${toLocation || 'new location'}. Status unchanged (${caseRow.status}).`
        : `Status changed: ${caseRow.status} → ${nextStatus}. Movement logged.`;
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

  // 'Transfer' is always offered in addition to the forward status options.
  const allowed: SelectedStatus[] = [...(FORWARD[caseRow.status] || []), 'Transfer'];

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
            <select value={nextStatus} onChange={e => onPickStatus(e.target.value as SelectedStatus)} required>
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

          {/* Attach a supporting document (photo / PDF / any file) */}
          <label className="full">
            Attach document (optional)
            <div className="attach-row">
              <input
                type="file"
                className="attach-input"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={onPickFile}
                disabled={uploading || busy}
              />
              {uploading && <span className="attach-busy">Uploading…</span>}
            </div>
            {uploadErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{uploadErr}</div>}
            {attached && (
              <span className="attach-chip">
                📎 <a href={attached.url} target="_blank" rel="noreferrer">{attached.name}</a>
                <span className="x" title="Remove" onClick={() => setAttached(null)}>✕</span>
              </span>
            )}
          </label>
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !nextStatus}>
            {busy ? 'Recording…' : (nextStatus === 'Transfer' ? 'Record transfer' : 'Record movement & change status')}
          </button>
        </div>
      </form>
    </div>
  );
}
