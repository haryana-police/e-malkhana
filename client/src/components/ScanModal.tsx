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
//   - JSON { v:2, enc:'aes-256-gcm', iv, tag, ct }  →  ENCRYPTED tag.
//     We must NOT try to read an `id` out of it — there isn't one.  We
//     pass the whole blob straight to /api/scan, which is the only place
//     that can decrypt it (backend holds QR_SECRET).  Parse it as an
//     encrypted payload and return id='' so onScanSuccess ships the raw
//     blob to the server rather than failing with "no case id".
//   - JSON { v:1, id, item, ... }  →  legacy plaintext tag (pre-encryption).
//   - Bare FIR/DD number           →  returns it as-is (manual entry).
function parsePayload(raw: string): { id: string; itemId: string; encrypted: boolean } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { id: '', itemId: '', encrypted: false };
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed);
      if (j && j.enc === 'aes-256-gcm') {
        // Encrypted tag: nothing to read client-side; server decrypts.
        return { id: '', itemId: '', encrypted: true };
      }
      return { id: j.id || '', itemId: j.item || '', encrypted: false };
    } catch { /* fall through */ }
  }
  return { id: trimmed, itemId: '', encrypted: false };
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
        if (list.length === 0) {
          setCameras(list);
          setScanError('No camera detected on this device. Use the manual tag-ID entry below.');
          return;
        }
        // Sort rear cameras first so the default selection is the one the
        // user wants for scanning a QR tag (front cameras on most phones
        // return first from getUserMedia, which produced the wrong default).
        const isRear = (c: { id: string; label: string }) =>
          /back|rear|environment/i.test(c.label) ||
          // deviceId strings from Chromium often encode the facing: a token
          // containing "back" or the absence of "front" is a strong signal.
          (/back/i.test(c.id) || !/front/i.test(c.id));
        const sorted = [...list].sort((a, b) =>
          (isRear(b) ? 1 : 0) - (isRear(a) ? 1 : 0),
        );
        setCameras(sorted);
        // Default to a NULL selection so startScanner() falls back to
        // facingMode:'environment' (the REAR camera).  This is the correct
        // default for scanning a physical QR tag — on many phones the front
        // lens is enumerated first and would otherwise open by mistake.
        // The user can still pick a specific lens from the dropdown; until
        // they do, we always use the rear camera.
        setActiveCamId(null);
      })
      .catch(e => {
        setScanError(`Camera unavailable: ${e?.message || e}. Use the manual entry below.`);
      });
  }, [open]);

  // Cleanup: stop the scanner whenever the modal closes or scanner swaps
  useEffect(() => {
    return () => { stopScanner(); };
  }, []);

  async function startScanner(cameraId: string | null) {
    setScanError(null);
    try {
      // The scanner div only mounts when phase === 'scanning', so we have
      // to flip the phase first, wait for React to commit the DOM, and
      // only THEN construct Html5Qrcode — its constructor looks up the
      // element by id synchronously and throws if it isn't there yet.
      setPhase('scanning');
      // Two rAFs: one for the React state update, one for the layout commit.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const s = new Html5Qrcode(containerId);
      setScanner(s);
      const camConfig = cameraId
        ? { deviceId: { exact: cameraId } }
        : { facingMode: 'environment' };
      await s.start(
        camConfig as any,
        { fps: 10, qrbox: { width: 240, height: 240 } },
        onScanSuccess,
        _onScanFailure,
      );
    } catch (e: any) {
      setScanError(`Failed to start camera: ${e?.message || e}. Try manual entry.`);
      setPhase('idle');
      setScanner(null);
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

  async function onScanSuccess(decodedText: string) {
    await stopScanner();
    const { id, itemId, encrypted } = parsePayload(decodedText);
    // Encrypted tags carry no readable id — the server is the only place
    // that can decrypt them, so we forward the raw blob as the payload.
    if (encrypted) {
      await lookupAndPrompt({ payload: decodedText, fallbackId: '', itemId: '' });
      return;
    }
    if (!id) {
      setMsg({ kind: 'error', text: 'QR did not contain a recognisable case id.' });
      setPhase('idle');
      return;
    }
    await lookupAndPrompt({ payload: decodedText, fallbackId: id, itemId });
  }

  // onScanFailure fires on every frame that doesn't decode — keep it silent.
  function _onScanFailure(_msg: string) { /* noop */ }

  async function lookupAndPrompt({ payload, fallbackId, itemId }: { payload: string; fallbackId: string; itemId: string }) {
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

  async function submitMovement(e: React.FormEvent) {
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
    } catch (e: any) {
      const err = e as ApiError;
      setMsg({ kind: 'error', text: (err.body && err.body.error) || err.message });
    } finally {
      setBusy(false);
    }
  }

  function submitManual() {
    if (!manualPayload.trim()) return;
    setBusy(true); setMsg(null);
    const { id, itemId, encrypted } = parsePayload(manualPayload);
    // Encrypted blob pasted manually → forward the raw string to the server.
    if (encrypted) {
      lookupAndPrompt({ payload: manualPayload, fallbackId: '', itemId: '' })
        .finally(() => setBusy(false));
      return;
    }
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
                  <option value="">Auto · rear camera (facingMode)</option>
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
