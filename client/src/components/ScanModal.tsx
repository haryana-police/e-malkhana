import { useState } from 'react';
import { api, ApiError } from '../api';
import type { CaseRow, CaseStatus, MovementLogRow } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: (c: CaseRow, recorded: boolean) => void;
}

const STATUSES: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed',
];

const QUICK_LOCATIONS = [
  'Malkhana', 'FSL Madhuban', 'Court',
  'Civil Hospital Panchkula', 'Returned to Owner', 'Disposed',
];

export function ScanModal({ open, onClose, onSuccess }: Props) {
  const [payload, setPayload]       = useState('');
  const [toLocation, setToLocation] = useState('Malkhana');
  const [movedBy, setMovedBy]       = useState('SI Rakesh Sharma');
  const [purpose, setPurpose]       = useState('Check-in scan');
  const [setStatus, setSetStatus]   = useState<CaseStatus>('In Malkhana');
  const [busy, setBusy]             = useState(false);
  const [msg, setMsg]               = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [matched, setMatched]       = useState<CaseRow | null>(null);
  const [movement, setMovement]     = useState<MovementLogRow | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null); setMatched(null); setMovement(null);
    try {
      const r = await api.scan({ payload, toLocation, movedBy, purpose, setStatus });
      setMatched(r.case);
      setMovement(r.movement ?? null);
      setMsg({ kind: 'ok', text: r.movement
        ? `Movement recorded: ${r.movement.fromLocation} → ${r.movement.toLocation}`
        : `Item recognised: ${r.case.itemType}` });
      onSuccess(r.case, !!r.movement);
    } catch (e) {
      // ApiError carries the parsed JSON envelope; surface its `error` and
      // any `suggestions` array so the user sees a clean message.
      const err = e as ApiError;
      const detail = (err.body && err.body.error) || err.message;
      const suggestions: string[] = (err.body && Array.isArray(err.body.suggestions)) ? err.body.suggestions : [];
      setMsg({
        kind: 'error',
        text: `Could not recognise the case. ${detail}${suggestions.length ? ` — try: ${suggestions.join(', ')}` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPayload(''); setToLocation('Malkhana'); setMovedBy('SI Rakesh Sharma');
    setPurpose('Check-in scan'); setSetStatus('In Malkhana');
    setMsg(null); setMatched(null); setMovement(null);
  }

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <form className="form-card" onSubmit={submit}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Scan QR / Record Movement</h3>
        <div className="sub">
          Paste the QR payload (or type a FIR/DD number) and where the item is moving to.
          A row is appended to the immutable movement log.
        </div>

        <div className="form-grid">
          <label className="full">
            QR payload / case id
            <input
              value={payload}
              onChange={e => setPayload(e.target.value)}
              placeholder='{"v":1,"id":"FIR 214/2026",...}   or   FIR 214/2026'
              required autoFocus
            />
          </label>
          <label>
            To location
            <input list="locs" value={toLocation} onChange={e => setToLocation(e.target.value)} required />
            <datalist id="locs">{QUICK_LOCATIONS.map(l => <option key={l} value={l} />)}</datalist>
          </label>
          <label>
            New status
            <select value={setStatus} onChange={e => setSetStatus(e.target.value as CaseStatus)}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            Moved by
            <input value={movedBy} onChange={e => setMovedBy(e.target.value)} required />
          </label>
          <label>
            Purpose
            <input value={purpose} onChange={e => setPurpose(e.target.value)} />
          </label>
        </div>

        {matched && (
          <div className="form-msg show ok">
            Recognised: <b>{matched.id}</b> — {matched.itemType} <span className="case-pill">{matched.itemId}</span>
          </div>
        )}
        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Close</button>
          <button type="submit" className="btn" disabled={busy || !payload.trim()}>
            {busy ? 'Recording…' : 'Record Movement'}
          </button>
        </div>
      </form>
    </div>
  );
}
