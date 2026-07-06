import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
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

// Parse a QR payload (the same one /api/cases/:id/qr encodes).
//   - JSON { v:1, id, item, ... }  →  returns id
//   - Bare FIR/DD number           →  returns it as-is
// Returns { id, explicitItemId } — when the payload carries an explicit
// `item` field we use that for the case lookup too (matches MK-... ids
// for the rare case where the FIR id is missing/legacy).
function parsePayload(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { id: '', itemId: '' };
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      return { id: j.id || '', itemId: j.item || '' };
    } catch { /* fall through */ }
  }
  return { id: trimmed, itemId: '' };
}

export function ScanModal({ open, onClose, onSuccess }: Props) {
  const [phase, setPhase]       = useState<'idle' | 'scanning' | 'confirm' | 'manual'>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameras, setCameras]     = useState<{ id: string; label: string }[]>([]);
  const [activeCamId, setActiveCamId] = useState<string | null>(null);
  const [scanner, setScanner]     = useState<Html5Qrcode | null>(null);

  // Matched case (set after a successful scan) + optional movement form
  const [matched, setMatched] = useState<CaseRow | null>(null);
  const [movement, setMovement] = useState<MovementLogRow | null>(null);

  // Movement form state (shown when in the 'confirm' phase)
  const [toLocation, setToLocation] = useState('Malkhana');
  const [movedBy, setMovedBy]       = useState('SI Rakesh Sharma');
  const [purpose, setPurpose]       = useState('Check-in scan');
  const [setStatus, setSetStatus]   = useState<CaseStatus>('In Malkhana');

  // Manual fallback input
  const [manualPayload, setManualPayload] = useState('');

  // Movement-log post
  const [busy, setBusy] = useState(false);
  const [msg, setMsg]   = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const containerId = 'mm-qr-scanner-region';
  const containerRef = useRef<HTMLDivElement>(null);

  // Camera enumeration on open
  useEffect(() => {
    if (!open) return;
    setScanError(null);
    setPhase('idle');
    setMatched(null); setMovement(null); setMsg(null);
    setManualPayload('');

    Html5Qrcode.getCameras()
      .then(list => {
        setCameras(list);
        if (list.length === 0) {
          setScanError('No camera detected on this device. Use the manual tag-ID entry below.');
        }
      })
      .catch(e => {
        setScanError(`Camera unavailable: ${e?.message || e}. Use the manual entry below.`);
      });
  }, [open]);

  // Cleanup: stop the scanner whenever the modal closes or scanner swaps
  useEffect(() => {
    return () => { stopScanner(); };
  }, []);

  async function startScanner(cameraId) {
    setScanError(null);
    try {
      const s = new Html5Qrcode(containerId);
      setScanner(s);
      setPhase('scanning');
      // Slight delay so the container is in the DOM
      await new Promise(r => requestAnimationFrame(r));
      const camConfig = cameraId
        ? { deviceId: { exact: cameraId } }
        : { facingMode: 'environment' };
      await s.start(
        camConfig,
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        _onScanFailure,
      );
    } catch (e) {
      setScanError(`Failed to start camera: ${e?.message || e}. Try manual entry.`);
      setPhase('idle');
    }
  }

  async function stopScanner() {
    try {
      if (scanner) {
        // isScanning is only on the live instance; guard via try/catch
        try { await scanner.stop(); } catch { /* not running */ }
        try { scanner.clear(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  async function onScanSuccess(decodedText) {
    await stopScanner();
    const { id, itemId } = parsePayload(decodedText);
    if (!id) {
      setMsg({ kind: 'error', text: 'QR did not contain a recognisable case id.' });
      setPhase('idle');
      return;
    }
    await lookupAndPrompt({ payload: decodedText, fallbackId: id, itemId });
  }

  // onScanFailure fires on every frame that doesn't decode — keep it silent.
  function _onScanFailure(_msg) { /* noop */ }

  async function lookupAndPrompt({ payload, fallbackId, itemId }) {
    setBusy(true); setMsg(null);
    try {
      // The /api/scan endpoint accepts a raw payload (the JSON the QR
      // encodes).  Without a destination it just reports the matched case.
      const r = await api.scan({ payload: payload || fallbackId });
      setMatched(r.case);
      setPhase('confirm');
      // Pre-fill the toLocation from the case's current location if we can
      setToLocation('Malkhana');
      setSetStatus(r.case.status === 'Disposed' ? 'In Malkhana' : 'In Malkhana');
    } catch (e) {
      const err = e as ApiError;
      const detail = (err.body && err.body.error) || err.message;
      const suggestions: string[] = (err.body && Array.isArray(err.body.suggestions)) ? err.body.suggestions : [];
      setMsg({
        kind: 'error',
        text: `Could not recognise: ${detail}${suggestions.length ? ` — try: ${suggestions.join(', ')}` : ''}`,
      });
      setPhase('idle');
    } finally {
      setBusy(false);
    }
  }

  async function submitMovement(e) {
    e.preventDefault();
    if (!matched) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api.scan({
        payload: JSON.stringify({ v: 1, id: matched.id, item: matched.itemId }),
        toLocation, movedBy, purpose, setStatus,
      });
      setMovement(r.movement ?? null);
      setMatched(r.case);
      setMsg({ kind: 'ok', text: r.movement
        ? `Movement recorded: ${r.movement.fromLocation} → ${r.movement.toLocation}`
        : `Item recognised: ${r.case.itemType}` });
      onSuccess(r.case, !!r.movement);
      setTimeout(() => { reset(); onClose(); }, 1500);
    } catch (e) {
      const err = e as ApiError;
      setMsg({ kind: 'error', text: (err.body && err.body.error) || err.message });
    } finally {
      setBusy(false);
    }
  }

  function submitManual() {
    if (!manualPayload.trim()) return;
    setBusy(true); setMsg(null);
    const { id, itemId } = parsePayload(manualPayload);
    lookupAndPrompt({ payload: manualPayload, fallbackId: id, itemId })
      .finally(() => setBusy(false));
  }

  function reset() {
    stopScanner();
    setPhase('idle');
    setMatched(null); setMovement(null);
    setMsg(null); setScanError(null);
    setManualPayload('');
  }

  if (!open) return null;

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <div className="form-card" style={{ maxWidth: 540 }}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Scan QR / Record Movement</h3>
        <div className="sub">
          Point the camera at the case-property QR tag, or enter the tag id
          manually below.  A successful scan opens a movement form so you can
          confirm where the item is being moved.
        </div>

        {phase === 'idle' && (
          <div className="form-grid" style={{ paddingTop: 8 }}>
            {cameras.length > 0 && (
              <label className="full">
                Camera
                <select
                  value={activeCamId || ''}
                  onChange={e => { setActiveCamId(e.target.value || null); }}
                >
                  <option value="">Auto · rear camera</option>
                  {cameras.map(c => <option key={c.id} value={c.id}>{c.label || c.id}</option>)}
                </select>
              </label>
            )}
            {scanError && <div className="form-msg show error full">{scanError}</div>}

            <div className="full" style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => startScanner(activeCamId)}
                disabled={cameras.length === 0}
                style={{ flex: 1 }}
              >▶ Start camera</button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setPhase('manual')}
                style={{ flex: 1 }}
              >⌨ Enter tag id manually</button>
            </div>
          </div>
        )}

        {phase === 'scanning' && (
          <div>
            <div
              id={containerId}
              ref={containerRef}
              style={{
                width: '100%', minHeight: 280, background: '#000', borderRadius: 6,
                overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            />
            <div className="sub" style={{ marginTop: 8, textAlign: 'center' }}>
              Hold the QR steady in the frame…
            </div>
            <div className="form-actions" style={{ paddingTop: 12 }}>
              <button type="button" className="btn ghost" onClick={async () => { await stopScanner(); setPhase('idle'); }}>
                ◀ Back
              </button>
              <button type="button" className="btn ghost" onClick={() => { stopScanner(); setPhase('manual'); }}>
                Switch to manual
              </button>
            </div>
          </div>
        )}

        {phase === 'manual' && (
          <div className="form-grid" style={{ paddingTop: 8 }}>
            <label className="full">
              Tag id / QR payload
              <input
                value={manualPayload}
                onChange={e => setManualPayload(e.target.value)}
                placeholder='e.g. MK-2026-000214  ·  FIR 214/2026  ·  {"v":1,"id":"FIR 214/2026",…}'
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') submitManual(); }}
              />
            </label>
            <div className="full" style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" onClick={submitManual} disabled={busy || !manualPayload.trim()} style={{ flex: 1 }}>
                {busy ? 'Looking up…' : 'Look up'}
              </button>
              <button type="button" className="btn ghost" onClick={() => setPhase('idle')} style={{ flex: 1 }}>
                ◀ Back
              </button>
            </div>
          </div>
        )}

        {phase === 'confirm' && matched && (
          <form onSubmit={submitMovement}>
            <div className="form-msg show ok" style={{ marginBottom: 12 }}>
              Recognised: <b>{matched.id}</b> — {matched.itemType}{' '}
              <span className="case-pill">{matched.itemId}</span>
            </div>
            <div className="form-grid">
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
            {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Close</button>
              <button type="submit" className="btn" disabled={busy}>
                {busy ? 'Recording…' : 'Record Movement'}
              </button>
            </div>
          </form>
        )}

        {msg && phase !== 'confirm' && (
          <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}
