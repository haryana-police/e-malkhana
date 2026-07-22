import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CaseRow, CaseStatus, MovementLogRow, MovementType } from '../types';

// ============================================================================
// MovementForm — ONE shared movement form used by every surface in the app:
//   • ScanModal (after a successful QR / tag scan)
//   • CasePropertyDetail "Log New Movement"
//   • ChangeStatusModal (status change + movement in one go)
//
// Layout (identical everywhere):
//   FROM (auto = previous location, read-only)
//   MOVE TO STATUS   (Movement Types vocab — drives to-location + purpose)
//   TO LOCATION      (auto-filled from the status's defaultLocation)
//   MOVED BY
//   PURPOSE OF MOVEMENT (auto-filled from the status's defaultPurpose)
//   ATTACH DOCUMENT  (camera capture + device file picker -> /api/upload)
//
// Props:
//   caseRow        — the case being moved (current status + last location)
//   fromLocation   — the previous location (auto).  Falls back to the case's
//                    last movement toLocation, else '—'.
//   onSubmit(data) — called with the assembled movement payload.
//   submitLabel    — label for the primary button (e.g. "Record movement",
//                    "Record movement & change status").
//   requireStatus  — when true the status select is required (ChangeStatus).
//   busy           — disables inputs while a request is in flight.
//   onCancel       — close handler.
//   initialStatus  — pre-select a status (ChangeStatus forward default).
// ============================================================================

export interface MovementFormData {
  fromLocation: string;
  toStatus: string;        // selected Movement Type name ('' = none / Transfer)
  toLocation: string;
  movedBy: string;
  purpose: string;
  docRef: string;          // uploaded file URL OR typed reference
  attachedName?: string;
}

interface Props {
  caseRow: CaseRow | null;
  fromLocation: string;            // auto previous location
  submitLabel?: string;
  requireStatus?: boolean;
  busy?: boolean;
  onCancel?: () => void;
  onSubmit: (data: MovementFormData) => void | Promise<void>;
  initialStatus?: string;
  initialToLocation?: string;
  initialPurpose?: string;
}

// Forward ordering shown when no server vocab is available (offline-safe).
const FALLBACK_STATUSES: CaseStatus[] = [
  'Seized', 'In Malkhana', 'With FSL', 'Expert Opinion Pending', 'In Court', 'Disposed',
];

function readFileAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error || new Error('Could not read file'));
    r.readAsDataURL(f);
  });
}

export function MovementForm(props: Props) {
  const {
    caseRow, fromLocation, submitLabel = 'Record movement',
    requireStatus = false, busy = false, onCancel, onSubmit,
    initialStatus, initialToLocation, initialPurpose,
  } = props;

  const [types, setTypes] = useState<MovementType[]>([]);
  const [typeStatuses, setTypeStatuses] = useState<string[]>([]);
  const [locSuggestions, setLocSuggestions] = useState<string[]>([]);

  const [toStatus, setToStatus]           = useState<string>(initialStatus || '');
  const [toLocation, setToLocation]       = useState<string>(initialToLocation || '');
  const [movedBy, setMovedBy]             = useState<string>('SI Rakesh Sharma');
  const [purpose, setPurpose]             = useState<string>(initialPurpose || '');
  const [docRef, setDocRef]               = useState<string>('');
  const [attached, setAttached]           = useState<{ name: string; url: string } | null>(null);
  const [uploading, setUploading]         = useState(false);
  const [uploadErr, setUploadErr]         = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // Load the Movement Types vocabulary once.  This is the single source of
  // truth for the status dropdown, the To-location suggestions, and the
  // auto-fill of to-location + purpose per status (per your spec: link the
  // movement types to the movement form everywhere).
  useEffect(() => {
    let alive = true;
    (async () => {
      let list: MovementType[] = [];
      try { list = await api.movementTypes('all'); } catch { list = []; }
      if (!alive) return;
      setTypes(list);
      const names = list.map(t => t.name);
      setTypeStatuses(names.length ? names : FALLBACK_STATUSES as string[]);
      const locs = Array.from(new Set(list.map(t => (t.defaultLocation || '').trim()).filter(Boolean)));
      setLocSuggestions(locs);
    })();
    return () => { alive = false; };
  }, []);

  // When the selected status changes, auto-fill To location + Purpose from
  // the Movement Type's defaults (unless the user already overrode them).
  function applyStatusDefaults(name: string) {
    setToStatus(name);
    if (name) {
      const t = types.find(x => x.name === name);
      if (t) {
        if (t.defaultLocation) setToLocation(t.defaultLocation);
        if (t.defaultPurpose) setPurpose(t.defaultPurpose);
      }
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setUploadErr(null); setUploading(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await api.upload(file.name, dataUrl);
      const url = res.url || (res as any).filename;
      if (!url) throw new Error('upload returned no URL');
      setAttached({ name: file.name, url });
      setDocRef(url);
    } catch (err) {
      setUploadErr((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (requireStatus && !toStatus) return;
    onSubmit({
      fromLocation,
      toStatus,
      toLocation: toLocation || '',
      movedBy: movedBy || 'Moharrir',
      purpose: purpose || '',
      docRef: attached?.url || docRef,
      attachedName: attached?.name,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="form-grid">
        {/* FROM — auto previous location (read-only) */}
        <label className="full">
          From (previous location)
          <input value={fromLocation || '—'} readOnly disabled
            style={{ background: '#f3f1ea', color: '#5a6678' }} />
        </label>

        {/* MOVE TO STATUS — Movement Types vocabulary */}
        <label className="full">
          Move to status
          <select
            value={toStatus}
            onChange={e => applyStatusDefaults(e.target.value)}
            required={requireStatus}
            disabled={busy}
          >
            <option value="">— pick a status / movement type —</option>
            {typeStatuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        {/* TO LOCATION */}
        <label>
          To location
          <input
            list="mv-loc-suggestions"
            value={toLocation}
            onChange={e => setToLocation(e.target.value)}
            placeholder="Destination (from Movement Types)"
            required
            disabled={busy}
          />
          <datalist id="mv-loc-suggestions">
            {locSuggestions.map((l, i) => <option key={i} value={l} />)}
          </datalist>
        </label>

        {/* MOVED BY */}
        <label>
          Moved by
          <input value={movedBy} onChange={e => setMovedBy(e.target.value)}
            placeholder="Officer name" disabled={busy} />
        </label>

        {/* PURPOSE */}
        <label className="full">
          Purpose of movement
          <input value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder="e.g. For forensic analysis" disabled={busy} />
        </label>

        {/* ATTACH DOCUMENT — camera + device picker */}
        <label className="full">
          Attach document (optional)
          <div className="attach-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost small"
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading || busy}>📷 Camera</button>
            <button type="button" className="btn ghost small"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || busy}>📎 From device</button>
            {/* camera: capture attribute opens the native camera on mobile */}
            <input ref={cameraInputRef} type="file" accept="image/*"
              capture="environment" style={{ display: 'none' }}
              onChange={e => onPickFile(e.target.files?.[0])} disabled={uploading || busy} />
            <input ref={fileInputRef} type="file"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip"
              style={{ display: 'none' }}
              onChange={e => onPickFile(e.target.files?.[0])} disabled={uploading || busy} />
            {uploading && <span className="attach-busy">Uploading…</span>}
          </div>
          {uploadErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{uploadErr}</div>}
          {attached && (
            <span className="attach-chip">
              📎 <a href={attached.url} target="_blank" rel="noreferrer">{attached.name}</a>
              <span className="x" title="Remove" onClick={() => { setAttached(null); setDocRef(''); }}>✕</span>
            </span>
          )}
          {!attached && (
            <input value={docRef} onChange={e => setDocRef(e.target.value)}
              placeholder="or type a document ref (e.g. FSL-FWD-2026-114)"
              style={{ marginTop: 8 }} disabled={busy} />
          )}
        </label>
      </div>

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        )}
        <button type="submit" className="btn" disabled={busy || (requireStatus && !toStatus)}>
          {busy ? 'Recording…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default MovementForm;
