import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { api } from '../api';
import html2canvas from 'html2canvas';
import type { CaseRow, CasePropertyData, FirMaster, MovementLogRow, CaseStatus } from '../types';
import { MovementForm, type MovementFormData } from './MovementForm';

// Status list mirrors server STATUSES in server.js.  Kept in sync via
// the same allow-list check on the server, so a stray value here just
// gets a 400 from PATCH.
const STATUS_OPTIONS: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed', 'Transfer',
];

// Lightweight HTML escaper for the print window so a malicious item name
// can't break out of the print template.  We use this instead of pulling
// in a dependency for one print function.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATUS_TONE: Record<string, string> = {
  'Seized': 'tone-info', 'In Malkhana': 'tone-info',
  'With FSL': 'tone-warn', 'Expert Opinion Pending': 'tone-warn',
  'In Court': 'tone-info', 'Disposed': 'tone-good',
  'Transfer': 'tone-info',
};

// ============================================================
// InlineEditCell
// ============================================================
//
// A single clickable label/value pair in the Case Property card.  Clicking
// the cell swaps the value for a `<input>` (text or date) or `<select>`
// so the user can edit it inline.  Saves on blur or Enter; reverts on Esc.
//
// Used directly by the CasePropertyDetail page so every visible field is
// editable without going through a separate "Edit details" form.
//
// Props:
//   - label:        small uppercase header above the value
//   - value:        current value (string | null | undefined)
//   - type:         'text' | 'date' | 'select'
//   - options?:     [{ value, label }] when type='select'
//   - mono?:        monospaced font for IDs / numbers
//   - placeholder?: input placeholder
//   - onSave(next): async (string|null) => void  — caller persists via api.updateCase
//   - disabled?:    when true, renders as static text only (system-derived fields)
function InlineEditCell(props: {
  label: string;
  value: string | null | undefined;
  type?: 'text' | 'date' | 'select';
  options?: { value: string; label: string }[];
  mono?: boolean;
  placeholder?: string;
  onSave?: (next: string | null) => Promise<void> | void;
  disabled?: boolean;
  rawValue?: React.ReactNode;          // when the value is JSX (e.g. status stamp)
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(props.value || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  // Re-sync draft when the source-of-truth value changes (after save).
  useEffect(() => { setDraft(props.value || ''); }, [props.value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if ('select' in inputRef.current) (inputRef.current as HTMLInputElement).select?.();
    }
  }, [editing]);

  async function commit() {
    if (!props.onSave) { setEditing(false); return; }
    const next = draft.trim();
    const old = (props.value || '').trim();
    if (next === old) { setEditing(false); return; }
    setBusy(true); setErr(null);
    try {
      await props.onSave(next || null);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setDraft(props.value || '');
    setErr(null);
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  // Read-only (system-derived or no onSave): just render the label/value.
  if (props.disabled || !props.onSave) {
    return (
      <div>
        <span className="k">{props.label}</span>
        <span className={`v${props.mono ? ' mono' : ''}`}>
          {props.rawValue ?? (props.value || '—')}
        </span>
      </div>
    );
  }

  if (editing) {
    return (
      <div>
        <span className="k">{props.label}</span>
        <div className="cp-cell-edit">
          {props.type === 'select' ? (
            <select
              ref={inputRef as React.RefObject<HTMLSelectElement>}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              disabled={busy}
            >
              {(props.options || []).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={props.type === 'date' ? 'date' : 'text'}
              value={draft}
              placeholder={props.placeholder}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              disabled={busy}
            />
          )}
          {err && <div className="cp-cell-err" title={err}>⚠ {err}</div>}
        </div>
      </div>
    );
  }

  return (
    <div
      className="cp-cell-clickable"
      onClick={() => setEditing(true)}
      title="Click to edit"
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
    >
      <span className="k">{props.label}</span>
      <span className={`v${props.mono ? ' mono' : ''}`}>
        {props.rawValue ?? (props.value || '—')}
        <span className="cp-edit-pencil" aria-hidden>✎</span>
      </span>
    </div>
  );
}

// PhotoCell — shows the current photo thumbnail + an upload affordance.
// Picking a file uploads via api.upload, then PATCHes imageUrl.
function PhotoCell(props: {
  caseId: string;
  itemId: string;
  imageUrl?: string;
  itemType: string;
  onUpdated: (imageUrl: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(f);
      });
      // Filename: derive a stable, content-type-correct name.
      const ext = (f.name.match(/\.[a-zA-Z0-9]+$/)?.[0] || '.jpg').toLowerCase();
      const safe = `case-${props.caseId.replace(/[^\w]+/g, '_')}-${Date.now()}${ext}`;
      const up = await api.upload(safe, dataUrl);
      const url = up.url || (up as any).filename;
      if (!url) throw new Error('upload returned no URL');
      // Persist through the standard PATCH endpoint so the audit log fires.
      await api.updateCase(props.caseId, { imageUrl: url });
      props.onUpdated(url);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
      // Clear the input so picking the same file again re-fires.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function clearPhoto() {
    setBusy(true); setErr(null);
    try {
      await api.updateCase(props.caseId, { imageUrl: null });
      props.onUpdated(null);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-photo-cell">
      <span className="k">Photo</span>
      <div className="cp-photo-body">
        {props.imageUrl
          ? <img src={props.imageUrl} alt={props.itemType} className="cp-thumb" />
          : <span className="cp-thumb cp-thumb-empty">—</span>}
        <div className="cp-photo-actions">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onPickFile}
          />
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : (props.imageUrl ? 'Replace photo' : '＋ Upload photo')}
          </button>
          {props.imageUrl && (
            <button type="button" className="btn ghost small" disabled={busy} onClick={clearPhoto}>✕ Remove</button>
          )}
          {err && <span className="cp-cell-err" title={err}>⚠ {err}</span>}
        </div>
      </div>
    </div>
  );
}

// U/S (legal section) formatted for the compact detail view + print sheets.
// Handles the new "ACT:N" multi-act format ("BNS:101", "NDPS:20" …) and
// falls back to "BNS <n>" for legacy bare-number rows.
function detailUsText(c: CaseRow): string {
  if (c.legalSections && c.legalSections.length) {
    return c.legalSections
      .map((s, i) => `${sectionDisplay(s)}${c.legalSectionsTitles && c.legalSectionsTitles[i] ? ' — ' + c.legalSectionsTitles[i] : ''}`)
      .join(' · ');
  }
  if (c.legalSection) return `${sectionDisplay(c.legalSection)}${c.legalSectionTitle ? ' — ' + c.legalSectionTitle : ''}`;
  return '—';
}

function sectionDisplay(s: string): string {
  const str = String(s).trim();
  const m = str.match(/^([A-Z]{2,10}):(\S+)$/);
  if (m) return `${m[1]} ${m[2]}`;
  if (/^[a-zA-Z]/.test(str)) return str;
  return `BNS ${str}`;
}

// Render the case's legal-section list as the raw "ACT:N" comma-separated
// (no titles), so the inline-edit input shows what the user is expected
// to type.  Legacy bare numbers are emitted without the "BNS:" prefix to
// match the old input format.
function detailUsNumbers(c: CaseRow): string {
  if (c.legalSections && c.legalSections.length) return c.legalSections.join(', ');
  if (c.legalSection) return c.legalSection;
  return '';
}
// Build the `common` payload for POST /api/case-property from the current
// CasePropertyData record, applying any single-field overrides.  We send the
// WHOLE common object back (not just the edited field) so a one-field edit
// never silently drops the other registration-time values (receivedBy,
// seal block, witnesses, remarks, …).  `undefined` overrides are skipped so
// we don't overwrite an existing value with undefined — pass `''` only when
// the user actually cleared the field.
function commonFrom(cp: CasePropertyData, overrides: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string | undefined> = {
    seizedTime: cp.seizedTime,
    witness1: cp.witness1,
    witness2: cp.witness2,
    quantity: cp.quantity,
    placeOfSeizure: cp.placeOfSeizure,
    storageLocation: cp.storageLocation ?? cp.placeOfSeizure,
    physicalStorage: cp.physicalStorage,
    photoUrl: cp.photoUrl,
    remarks: cp.remarks,
    status: cp.status || 'Seized',
    dateOfReceipt: cp.dateOfReceipt,
    receivedBy: cp.receivedBy,
    malkhanaLocation: cp.malkhanaLocation,
    sealSealed: cp.sealSealed,
    sealNo: cp.sealNo,
    sealBy: cp.sealBy,
  };
  const merged = { ...base, ...overrides };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

// Render a movement's docRef: a clickable link when it's a file URL,
// inline text when it's a short reference (e.g. "FSL-FWD-2026-114").
function renderDocRef(ref: string) {
  if (!ref) return null;
  const isUrl = /^https?:\/\//.test(ref) || ref.startsWith('/uploads') || ref.startsWith('/api/uploads');
  if (isUrl) {
    const name = decodeURIComponent(ref.split('/').pop() || ref);
    return <><br /><a href={ref} target="_blank" rel="noreferrer">📎 {name}</a></>;
  }
  return <> · {ref}</>;
}

export function CasePropertyDetail({ refresh = 0 }: { refresh?: number }) {
  const { item_id: itemIdParam } = useParams<{ item_id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const sno = (location.state as any)?.sno;
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [caseProperty, setCaseProperty] = useState<CasePropertyData | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrMask, setQrMask] = useState<string | null>(null);
  const [firMaster, setFirMaster] = useState<FirMaster | null>(null);
  const [movements, setMovements] = useState<MovementLogRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- dropdown options for the inline-edit cells ----
  // sections: full list (for Location dropdown).
  // itemTypes: scoped to the case's section letter (for Category dropdown).
  const [sections, setSections] = useState<{ letter: string; name: string }[]>([]);
  const [itemTypes, setItemTypes] = useState<{ id: number; name: string }[]>([]);
  const sectionLetter = caseRow?.section?.replace('PART ', '') || '';
  useEffect(() => {
    api.sections('all').then(s => setSections(s.map(x => ({ letter: x.letter, name: x.name })))).catch(() => setSections([]));
  }, []);
  useEffect(() => {
    if (!sectionLetter) { setItemTypes([]); return; }
    api.itemTypes(sectionLetter).then(t => setItemTypes(t.map(x => ({ id: x.id, name: x.name })))).catch(() => setItemTypes([]));
  }, [sectionLetter]);

  // ---- log / edit movement modal ----
  const [showLog, setShowLog] = useState(false);
  const [fromLocation, setFromLocation] = useState('—');
  const [logErr, setLogErr] = useState<string | null>(null);
  const [logBusy, setLogBusy] = useState(false);

  // ---- edit case property modal (single form, styled like Log/Edit Movement) ----
  const [showEdit, setShowEdit] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  // Field drafts — initialised from caseRow when the modal opens.
  const [edItemType, setEdItemType]           = useState('');
  const [edSection, setEdSection]             = useState('');
  const [edStatus, setEdStatus]               = useState<CaseStatus>('Seized');
  const [edReceivedBy, setEdReceivedBy]       = useState('');
  const [edFirDate, setEdFirDate]             = useState('');
  const [edUs, setEdUs]                       = useState('');

  function openEdit() {
    if (!caseRow) return;
    setShowEdit(true);
    setEditErr(null);
    setEdItemType(caseRow.itemType || '');
    setEdSection(caseRow.section?.replace('PART ', '') || '');
    setEdStatus(caseRow.status || 'Seized');
    setEdReceivedBy(caseRow.receivedBy || '');
    setEdFirDate(caseRow.firDate || '');
    setEdUs(detailUsNumbers(caseRow));
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow) return;
    setEditBusy(true); setEditErr(null);
    try {
      const usArr = (edUs || '').split(',').map(s => s.replace(/^BNS\s+/i, '').trim()).filter(Boolean);
      if (!edItemType.trim()) throw new Error('Category of Item cannot be empty');
      if (!edSection) throw new Error('Pick a location');
      const updated = await api.updateCase(caseRow.id, {
        itemType: edItemType.trim(),
        section: edSection,
        status: edStatus,
        receivedBy: edReceivedBy.trim() || null,
        firDate: edFirDate.trim() || null,
        legalSections: usArr,
      });
      setCaseRow(updated);
      // Re-fetch so server decorate/withFreshSectionName passes reflect.
      const fresh = await api.case(caseRow.id).catch(() => updated);
      setCaseRow(fresh);
      setShowEdit(false);
    } catch (err) {
      setEditErr((err as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  // Hidden off-screen node used to compose the Download QR sheet
  // (case detail + movement chain + QR) into a single PNG via html2canvas.
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!itemIdParam) return;
    setErr(null); setBusy(true);
    (async () => {
      try {
        const c = await api.case(itemIdParam);
        setCaseRow(c);
        const [qr, fir, mv, property] = await Promise.all([
          api.qr(c.id).catch(() => ({ dataUrl: '', payload: '', encrypted: false, mask: null })),
          // FIR master details (police station, U/S, IO) — once per FIR.
          api.firMaster(c.firNo || c.id).catch(() => null),
          api.movements(c.id).catch(() => [] as MovementLogRow[]),
          // MM/case-property details are keyed by the Malkhana item number.
          api.caseProperty(c.itemId).catch(() => null),
        ]);
        setQrUrl(qr.dataUrl);
        setQrMask(qr.mask || null);
        setFirMaster(fir);
        setMovements(Array.isArray(mv) ? mv : []);
        setCaseProperty(property);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [itemIdParam, refresh]);

  // ---- Print ----
  function printTag() {
    if (!qrUrl || !caseRow) return;
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Tag · ${caseRow.id}</title>
      <style>
        body{ font-family: 'IBM Plex Sans', sans-serif; padding: 24px; text-align: center; }
        .id{ font-family: 'IBM Plex Mono', monospace; font-size: 14px; }
        .meta{ font-size: 12px; color: #444; }
        img{ width: 280px; height: 280px; border: 6px solid #14243D; }
        @media print { .no-print{ display:none } }
      </style></head><body>
        <img src="${qrUrl}" />
        <h2 style="margin: 12px 0 4px">${escapeHtml(caseRow.itemType)}</h2>
        <div class="id">${escapeHtml(caseRow.id)}</div>
        <div class="meta">Item ID: ${escapeHtml(caseRow.itemId)}</div>
        <div class="meta">Section: ${escapeHtml(caseRow.sectionName)} (Part ${escapeHtml(caseRow.section?.replace('PART ', ''))})</div>
        <div class="meta">Status: ${escapeHtml(caseRow.status)}</div>
        <hr/>
        <button class="no-print" onclick="window.print()">Print</button>
      </body></html>`);
    w.document.close();
  }

  function printDetail() {
    if (!caseRow) return;
    // Entry / Seizure details the MM fills in at registration time.
    const entryRows: string[] = [];
    if (caseRow.seizingOfficer) entryRows.push(`<div><span class="k">Seizing Officer</span><span class="v">${escapeHtml(caseRow.seizingOfficer)}</span></div>`);
    if (caseRow.seizedOn) entryRows.push(`<div><span class="k">Seized On</span><span class="v">${escapeHtml(caseRow.seizedOn)}</span></div>`);
    if (caseRow.description) entryRows.push(`<div style="grid-column:1 / -1"><span class="k">Description / Remarks</span><span class="v">${escapeHtml(caseRow.description)}</span></div>`);
    if (caseRow.docRef) entryRows.push(`<div style="grid-column:1 / -1"><span class="k">Seizure Memo</span><span class="v">${escapeHtml(caseRow.docRef)}</span></div>`);
    const entryHtml = entryRows.length
      ? `<div class="card" style="margin-bottom:18px;"><h3>Entry / Seizure Details</h3><div class="meta">${entryRows.join('')}</div></div>`
      : '';
    // Movement chain (same timeline as the on-screen panel + Download sheet).
    const movementHtml = movements.length === 0
      ? '<div class="empty">No movements recorded yet.</div>'
      : `<ul class="timeline">${movements.map(m => `
          <li>
            <div class="t-route">${escapeHtml(m.fromLocation || 'New')}<span class="t-arrow">→</span>${escapeHtml(m.toLocation || '—')}</div>
            <div class="t-meta">${escapeHtml(m.movedBy || '—')} · ${fmtTime(m.timestamp)}${m.purpose ? ' · ' + escapeHtml(m.purpose) : ''}</div>
          </li>`).join('')}</ul>`;
    const qrHtml = qrUrl
      ? `<div class="card" style="flex:0 0 220px;text-align:center">
           <h3>QR Code</h3>
           <img class="qr" src="${qrUrl}" alt="QR" />
           <div class="qr-cap">Encrypted — scan with e-Malkhana</div>
         </div>`
      : '';
    const html = `<!doctype html><html><head><title>Case Detail · ${caseRow.id}</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body  { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; color: #14243D; margin: 0; }
        h1, h2, h3 { font-family: 'Rajdhani', 'Segoe UI', Arial, sans-serif; color: #14243D; margin: 0; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #8C7A54; padding-bottom: 8px; margin-bottom: 12px; }
        .id   { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #8C7A54; }
        .title{ font-size: 22px; margin: 4px 0; }
        .sub  { color: #4F6079; font-size: 12px; }
        .stamp{ display: inline-block; padding: 4px 10px; border-radius: 3px; background: #E6ECF2; color: #14243D; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .stamp.tone-warn { background: #FFEED1; color: #8A4B00; }
        .stamp.tone-good { background: #D6F0DC; color: #1A5A33; }
        .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; margin: 12px 0 18px; padding: 10px 12px; border: 1px solid #D9D2C2; border-radius: 4px; }
        .meta .k { font-size: 9.5px; text-transform: uppercase; color: #8C7A54; display: block; letter-spacing: 0.06em; }
        .meta .v { font-size: 12px; color: #14243D; font-weight: 500; }
        .row  { display: flex; gap: 16px; margin-bottom: 18px; align-items: flex-start; }
        .card { flex: 1; border: 1px solid #D9D2C2; border-radius: 4px; padding: 12px; }
        .card h3 { font-size: 13px; margin-bottom: 8px; }
        .qr   { width: 180px; height: 180px; display: block; margin: 0 auto; border: 4px solid #14243D; border-radius: 3px; }
        .qr-cap { font-size: 10px; color: #4F6079; text-align: center; margin-top: 6px; }
        .photo{ max-width: 100%; max-height: 220px; display: block; margin: 0 auto; border: 1px solid #D9D2C2; border-radius: 3px; }
        .timeline { list-style: none; padding: 0; margin: 0; }
        .timeline li { position: relative; padding: 6px 0 6px 20px; border-left: 2px solid #D9D2C2; margin-left: 4px; }
        .timeline li:last-child { border-left-color: transparent; }
        .timeline li::before { content: ''; position: absolute; left: -5px; top: 12px; width: 8px; height: 8px; border-radius: 50%; background: #14243D; border: 2px solid #fff; }
        .t-route { font-size: 12px; }
        .t-arrow { color: #8C7A54; margin: 0 4px; }
        .t-meta  { font-size: 10.5px; color: #4F6079; margin-top: 2px; }
        .empty   { color: #4F6079; font-size: 11px; font-style: italic; }
        .footer  { margin-top: 18px; padding-top: 8px; border-top: 1px solid #D9D2C2; font-size: 10px; color: #4F6079; display: flex; justify-content: space-between; }
        .noprint { display: block; text-align: right; margin: 12px 0; }
        .noprint button { padding: 6px 14px; border: 1px solid #14243D; background: #14243D; color: #fff; border-radius: 3px; cursor: pointer; }
        @media print { .noprint { display: none; } }
      </style></head><body>
        <div class="noprint"><button onclick="window.print()">🖨 Print this page</button></div>
        <div class="head">
          <div>
            <div class="id">${escapeHtml(caseRow.id)}</div>
            <h1 class="title">${escapeHtml(caseRow.itemType)}</h1>
            ${caseRow.itemSub ? `<div class="sub">${escapeHtml(caseRow.itemSub)}</div>` : ''}
          </div>
          <span class="stamp ${STATUS_TONE[caseRow.status] || ''}">${escapeHtml(caseRow.status)}</span>
        </div>
        <div class="meta">
          <div><span class="k">S.NO</span><span class="v">${sno != null ? sno : '—'}</span></div>
          <div><span class="k">Malkhana No.</span><span class="v">${escapeHtml(caseRow.itemId || '—')}</span></div>
          <div><span class="k">FIR / DD No.</span><span class="v">${escapeHtml(caseRow.id)}</span></div>
          <div><span class="k">FIR Date</span><span class="v">${escapeHtml(caseRow.firDate || '—')}</span></div>
          <div><span class="k">Section (U/S)</span><span class="v">${escapeHtml(detailUsText(caseRow))}</span></div>
          <div><span class="k">Category of Item</span><span class="v">${escapeHtml(caseRow.itemType)}</span></div>
          <div><span class="k">Location</span><span class="v">${escapeHtml(caseRow.sectionName || '—')} (Part ${escapeHtml((caseRow.section || '').replace('PART ', ''))})</span></div>
          <div><span class="k">Received By (Moharrir)</span><span class="v">${escapeHtml(caseRow.receivedBy || '—')}</span></div>
          <div><span class="k">Last Movement Date</span><span class="v">${escapeHtml(caseRow.lastMovement || '—')}</span></div>
          <div><span class="k">Status</span><span class="v">${escapeHtml(caseRow.status)}</span></div>
        </div>
        ${entryHtml}
        ${caseRow.imageUrl ? `<div class="card" style="margin-bottom:18px;"><h3>Photo</h3><img class="photo" src="${caseRow.imageUrl}" alt="${escapeHtml(caseRow.itemType)}" /></div>` : ''}
        <div class="row">
          <div class="card">
            <h3>Movement Chain</h3>
            ${movementHtml}
          </div>
          ${qrHtml}
        </div>
        <div class="footer">
          <span>e-Malkhana · Case Detail</span>
          <span>Printed: ${escapeHtml(new Date().toLocaleString('en-IN'))}</span>
        </div>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  // ---- Print QR page (composed sheet: detail + movement + QR) ----
  function printQr() {
    if (!qrUrl || !caseRow) return;
    const w = window.open('', '_blank', 'width=820,height=1100');
    if (!w) return;
    const movementHtml = movements.length === 0
      ? '<div class="empty">No movements recorded yet.</div>'
      : `<ul class="timeline">${movements.map(m => `
          <li>
            <div class="t-route">${escapeHtml(m.fromLocation || 'New')}<span class="t-arrow">→</span>${escapeHtml(m.toLocation || '—')}</div>
            <div class="t-meta">${escapeHtml(m.movedBy || '—')} · ${fmtTime(m.timestamp)}${m.purpose ? ' · ' + escapeHtml(m.purpose) : ''}</div>
          </li>`).join('')}</ul>`;
    const html = `<!doctype html><html><head><title>QR Sheet · ${caseRow.id}</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; color: #14243D; margin: 0; }
        h1, h3 { font-family: 'Rajdhani', 'Segoe UI', Arial, sans-serif; color: #14243D; margin: 0; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #8C7A54; padding-bottom: 8px; margin-bottom: 12px; }
        .id { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #8C7A54; }
        .title { font-size: 22px; margin: 4px 0; }
        .sub { color: #4F6079; font-size: 12px; }
        .stamp { display: inline-block; padding: 4px 10px; border-radius: 3px; background: #E6ECF2; color: #14243D; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; margin: 12px 0 18px; padding: 10px 12px; border: 1px solid #D9D2C2; border-radius: 4px; }
        .meta .k { font-size: 9.5px; text-transform: uppercase; color: #8C7A54; display: block; letter-spacing: 0.06em; }
        .meta .v { font-size: 12px; color: #14243D; font-weight: 500; }
        .row { display: flex; gap: 18px; align-items: flex-start; }
        .card { flex: 1; border: 1px solid #D9D2C2; border-radius: 4px; padding: 12px; }
        .card h3 { font-size: 13px; margin-bottom: 8px; }
        .qr { width: 180px; height: 180px; display: block; margin: 0 auto; border: 4px solid #14243D; border-radius: 3px; }
        .qr-cap { font-size: 10px; color: #4F6079; text-align: center; margin-top: 6px; }
        .timeline { list-style: none; padding: 0; margin: 0; }
        .timeline li { position: relative; padding: 6px 0 6px 20px; border-left: 2px solid #D9D2C2; margin-left: 4px; }
        .timeline li:last-child { border-left-color: transparent; }
        .timeline li::before { content: ''; position: absolute; left: -5px; top: 12px; width: 8px; height: 8px; border-radius: 50%; background: #14243D; border: 2px solid #fff; }
        .t-route { font-size: 12px; }
        .t-arrow { color: #8C7A54; margin: 0 4px; }
        .t-meta { font-size: 10.5px; color: #4F6079; margin-top: 2px; }
        .empty { color: #4F6079; font-size: 11px; font-style: italic; }
        .footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #D9D2C2; font-size: 10px; color: #4F6079; display: flex; justify-content: space-between; }
        .noprint { display: block; text-align: right; margin: 12px 0; }
        .noprint button { padding: 6px 14px; border: 1px solid #14243D; background: #14243D; color: #fff; border-radius: 3px; cursor: pointer; }
        @media print { .noprint { display: none; } }
      </style></head><body>
        <div class="noprint"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
        <div class="head">
          <div>
            <div class="id">${escapeHtml(caseRow.id)}</div>
            <h1 class="title">${escapeHtml(caseRow.itemType)}</h1>
            ${caseRow.itemSub ? `<div class="sub">${escapeHtml(caseRow.itemSub)}</div>` : ''}
          </div>
          <span class="stamp">${escapeHtml(caseRow.status)}</span>
        </div>
        <div class="meta">
          <div><span class="k">S.NO</span><span class="v">${sno != null ? sno : '—'}</span></div>
          <div><span class="k">Malkhana No.</span><span class="v">${escapeHtml(caseRow.itemId || '—')}</span></div>
          <div><span class="k">FIR / DD No.</span><span class="v">${escapeHtml(caseRow.id)}</span></div>
          <div><span class="k">FIR Date</span><span class="v">${escapeHtml(caseRow.firDate || '—')}</span></div>
          <div><span class="k">Section (U/S)</span><span class="v">${escapeHtml(detailUsText(caseRow))}</span></div>
          <div><span class="k">Category of Item</span><span class="v">${escapeHtml(caseRow.itemType)}</span></div>
          <div><span class="k">Location</span><span class="v">${escapeHtml(caseRow.sectionName || '—')} (Part ${escapeHtml((caseRow.section || '').replace('PART ', ''))})</span></div>
          <div><span class="k">Received By (Moharrir)</span><span class="v">${escapeHtml(caseRow.receivedBy || '—')}</span></div>
          <div><span class="k">Last Movement Date</span><span class="v">${escapeHtml(caseRow.lastMovement || '—')}</span></div>
          <div><span class="k">Status</span><span class="v">${escapeHtml(caseRow.status)}</span></div>
        </div>
        <div class="row">
          <div class="card">
            <h3>Movement Chain</h3>
            ${movementHtml}
          </div>
          <div class="card" style="flex:0 0 220px;text-align:center">
            <h3>QR Code</h3>
            <img class="qr" src="${qrUrl}" alt="QR" />
            <div class="qr-cap">Encrypted — scan with e-Malkhana</div>
          </div>
        </div>
        <div class="footer">
          <span>e-Malkhana · Case Detail</span>
          <span>Printed: ${escapeHtml(new Date().toLocaleString('en-IN'))}</span>
        </div>
      </body></html>`;
    w.document.write(html);
    w.document.close();
  }
  // ---- Download QR page (composed sheet: detail + movement + QR) ----
  async function downloadQr() {
    if (!qrUrl || !caseRow) return;
    const node = sheetRef.current;
    if (!node) return;
    try {
      const canvas = await html2canvas(node, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = `${caseRow.id.replace(/[^\w]+/g, '_')}_detail_qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      // Fallback: just download the bare QR if the sheet render fails.
      const a = document.createElement('a');
      a.href = qrUrl;
      a.download = `${caseRow.id.replace(/[^\w]+/g, '_')}_qr.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  // ---- Log / Edit movement modal ----
  async function openLog() {
    if (!caseRow) return;
    setShowLog(true);
    setLogErr(null);
    // From = previous (last movement) location, auto.
    let from = '—';
    try {
      const mv = await api.movements(caseRow.id);
      if (Array.isArray(mv) && mv.length) from = mv[mv.length - 1].toLocation || '—';
    } catch { /* leave '—' */ }
    setFromLocation(from);
  }

  async function submitLog(data: MovementFormData) {
    if (!caseRow) return;
    if (!data.toLocation.trim()) { setLogErr('Destination location is required.'); return; }
    setLogBusy(true); setLogErr(null);
    try {
      await api.createMovement({
        caseId: caseRow.id,
        toLocation: data.toLocation.trim(),
        movedBy: data.movedBy.trim() || 'Moharrir',
        purpose: data.purpose.trim() || 'Movement',
        docRef: data.docRef || undefined,
        setStatus: (data.toStatus && STATUS_OPTIONS.includes(data.toStatus as CaseStatus)) ? (data.toStatus as CaseStatus) : undefined,
      });
      setShowLog(false);
      // refresh movement log + case (last-movement date / location)
      const [c, mv] = await Promise.all([
        api.case(caseRow.id).catch(() => caseRow),
        api.movements(caseRow.id).catch(() => [] as MovementLogRow[]),
      ]);
      setCaseRow(c);
      setMovements(Array.isArray(mv) ? mv : []);
    } catch (err) {
      setLogErr((err as Error).message);
    } finally {
      setLogBusy(false);
    }
  }

  if (busy) return <div className="empty-state">Loading…</div>;
  if (err) return (
    <div className="empty-state">
      <p>❌ {err}</p>
      <Link to="/caseproperty" className="btn">← Back to register</Link>
    </div>
  );
  if (!caseRow) return null;

  return (
    <div className="case-detail">
      {/* breadcrumb + back, with the top-right action toolbar */}
      <div className="case-detail-bar">
        <Link to="/caseproperty" className="link-back">← All Case Property</Link>
        <div className="case-detail-actions">
          <button className="btn" type="button" onClick={openLog}>＋ Log New Movement</button>
          <button className="btn ghost" type="button" onClick={openEdit}>✎ Edit Case Property</button>
          <button className="btn ghost" type="button" onClick={printTag}>🏷 Print Tag</button>
          <button className="btn ghost" type="button" onClick={printDetail}>🖨 Print full detail</button>
        </div>
      </div>

      {/* header */}
      <header className="case-detail-head">
        <div>
          <div className="case-detail-id">{caseRow.id}</div>
          <h1 className="case-detail-title">{caseRow.itemType}</h1>
          {caseRow.itemSub && <div className="case-detail-sub">{caseRow.itemSub}</div>}
        </div>
        <span className={`stamp ${STATUS_TONE[caseRow.status] || ''}`}>{caseRow.status}</span>
      </header>

      {/* Compact 11-column Case Property card (matches the register) — no scroll.
          Every cell is INLINE EDITABLE on click.  See InlineEditCell above. */}
      <div className="case-property-card" style={{ marginTop: 16 }}>
        <div className="cp-card-grid">
          {/* S.NO — server-assigned, read-only */}
          <div>
            <span className="k">S.NO</span>
            <span className="v mono">{sno != null ? sno : '—'}</span>
          </div>

          {/* Malkhana No. — unique identifier, but the user can fix typos */}
          <InlineEditCell
            label="Malkhana No."
            value={caseRow.itemId}
            mono
            placeholder="MK-2026-000005"
            onSave={async (next) => {
              if (!next) throw new Error('Malkhana No. cannot be empty');
              const updated = await api.updateCase(caseRow.id, { itemId: next });
              setCaseRow(updated);
            }}
          />

          {/* FIR / DD No. — primary key, IMMUTABLE on the server.  Display
              as a static value but keep the label/value layout consistent. */}
          <div>
            <span className="k">FIR / DD No.</span>
            <span className="v mono">{caseRow.id}</span>
          </div>

          {/* FIR Date — written to fir_master via the PATCH handler */}
          <InlineEditCell
            label="FIR Date"
            value={caseRow.firDate || null}
            type="date"
            mono
            onSave={async (next) => {
              const updated = await api.updateCase(caseRow.id, { firDate: next });
              setCaseRow(updated);
              // Re-fetch so the server's decorateCaseRow() pass runs and
              // the joined firDate is reflected without us having to mirror
              // it locally.
              const fresh = await api.case(caseRow.id).catch(() => updated);
              setCaseRow(fresh);
            }}
          />

          {/* Section (U/S) — the legal sections under which the case is booked.
              Input is the raw BNS numbers comma-separated; the displayed
              label keeps the formatted "BNS 244 — title" rendering. */}
          <InlineEditCell
            label="Section (U/S)"
            value={detailUsNumbers(caseRow)}
            mono
            placeholder="e.g. 244, 245"
            onSave={async (next) => {
              const arr = (next || '').split(',').map(s => s.replace(/^BNS\s+/i, '').trim()).filter(Boolean);
              if (arr.length === 0) throw new Error('Enter at least one section number');
              const updated = await api.updateCase(caseRow.id, { legalSections: arr });
              setCaseRow(updated);
            }}
          />

          {/* Category of Item — mirrors itemType.  If item-types are loaded
              for the case's section, offer a dropdown; otherwise plain text
              (so the cell stays usable when the master list is empty). */}
          <InlineEditCell
            label="Category of Item"
            value={caseRow.itemType}
            type={itemTypes.length > 0 ? 'select' : 'text'}
            options={itemTypes.map(t => ({ value: t.name, label: t.name }))}
            onSave={async (next) => {
              if (!next) throw new Error('Category cannot be empty');
              const updated = await api.updateCase(caseRow.id, { itemType: next });
              setCaseRow(updated);
            }}
          />

          {/* Location — section letter dropdown (the sectionName is derived
              from the letter server-side). */}
          <InlineEditCell
            label="Location"
            value={caseRow.section?.replace('PART ', '') || ''}
            type="select"
            options={sections.map(s => ({ value: s.letter, label: `${s.letter} — ${s.name}` }))}
            rawValue={
              <span>
                {caseRow.sectionName || '—'} (Part {caseRow.section?.replace('PART ', '') || '—'})
                <span className="cp-edit-pencil" aria-hidden>✎</span>
              </span>
            }
            onSave={async (next) => {
              if (!next) throw new Error('Pick a section');
              const updated = await api.updateCase(caseRow.id, { section: next });
              setCaseRow(updated);
              // Re-fetch so server's withFreshSectionName() pass reflects
              // the renamed/letter-changed sectionName on screen.
              const fresh = await api.case(caseRow.id).catch(() => updated);
              setCaseRow(fresh);
            }}
          />

          {/* Received By (Moharrir) */}
          <InlineEditCell
            label="Received By (Moharrir)"
            value={caseRow.receivedBy}
            onSave={async (next) => {
              const updated = await api.updateCase(caseRow.id, { receivedBy: next });
              setCaseRow(updated);
              const fresh = await api.case(caseRow.id).catch(() => updated);
              setCaseRow(fresh);
            }}
          />

          {/* Last Movement Date — SYSTEM-DERIVED from movements log; read-only */}
          <div>
            <span className="k">Last Movement Date</span>
            <span className="v mono">{caseRow.lastMovement ? caseRow.lastMovement : '—'}</span>
          </div>

          {/* Status — inline `<select>` over STATUS_OPTIONS.  Per user spec this
              is a direct PATCH (not a movement-log entry). */}
          <InlineEditCell
            label="Status"
            value={caseRow.status}
            type="select"
            options={STATUS_OPTIONS.map(s => ({ value: s, label: s }))}
            rawValue={
              <span>
                <span className={`stamp ${STATUS_TONE[caseRow.status] || ''}`}>{caseRow.status}</span>
                <span className="cp-edit-pencil" aria-hidden>✎</span>
              </span>
            }
            onSave={async (next) => {
              if (!next || next === caseRow.status) return;
              const updated = await api.updateCase(caseRow.id, { status: next });
              setCaseRow(updated);
            }}
          />

          {/* Photo — upload affordance.  Replaces the static thumbnail. */}
          <PhotoCell
            caseId={caseRow.id}
            itemId={caseRow.itemId}
            imageUrl={caseRow.imageUrl}
            itemType={caseRow.itemType}
            onUpdated={(url) => setCaseRow(prev => prev ? { ...prev, imageUrl: url || undefined } : prev)}
          />
        </div>
      </div>

      {caseProperty && (
        <div className="case-property-card" style={{ marginTop: 16 }}>
          <h3>MM / Malkhana Details</h3>
          <div className="cp-card-grid">
            {/* Common MM block — inline editable.  Saving merges the whole
                common object back so a single-field edit never wipes the
                other registration-time values (receivedBy, seal, etc.). */}
            <InlineEditCell
              label="Quantity"
              value={caseProperty.quantity}
              mono
              placeholder="e.g. 50"
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { quantity: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Place of Seizure"
              value={caseProperty.placeOfSeizure}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { placeOfSeizure: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Physical Storage"
              value={caseProperty.physicalStorage || caseProperty.storageLocation || caseProperty.malkhanaLocation}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { physicalStorage: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Received By"
              value={caseProperty.receivedBy}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { receivedBy: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
                // Reflect immediately on the register card above.
                setCaseRow(prev => prev ? { ...prev, receivedBy: next || '' } : prev);
              }}
            />
            <InlineEditCell
              label="Sealed / Unsealed"
              value={caseProperty.sealSealed}
              type="select"
              options={[
                { value: 'Yes', label: 'Yes' },
                { value: 'No', label: 'No' },
              ]}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { sealSealed: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Seal No. / Mark"
              value={caseProperty.sealNo}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { sealNo: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Sealed By"
              value={caseProperty.sealBy}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { sealBy: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Witness 1"
              value={caseProperty.witness1}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { witness1: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Witness 2"
              value={caseProperty.witness2}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { witness2: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Seized Time"
              value={caseProperty.seizedTime}
              mono
              placeholder="HH:MM"
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { seizedTime: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            <InlineEditCell
              label="Remarks"
              value={caseProperty.remarks}
              onSave={async (next) => {
                const saved = await api.saveCaseProperty({
                  itemId: caseProperty!.itemId,
                  firNo: caseProperty!.firNo,
                  common: commonFrom(caseProperty!, { remarks: next ?? undefined }),
                  fields: caseProperty!.fields || [],
                });
                setCaseProperty(saved);
              }}
            />
            {/* Type-specific fields recorded at registration — editable too. */}
            {caseProperty.fields?.map(field => (
              <InlineEditCell
                key={field.key}
                label={field.key.replace(/_/g, ' ')}
                value={field.value}
                onSave={async (next) => {
                  const updatedFields = (caseProperty!.fields || []).map(f =>
                    f.key === field.key ? { ...f, value: next ?? '' } : f
                  );
                  const saved = await api.saveCaseProperty({
                    itemId: caseProperty!.itemId,
                    firNo: caseProperty!.firNo,
                    common: commonFrom(caseProperty!, {}),
                    fields: updatedFields,
                  });
                  setCaseProperty(saved);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Movement chain (LEFT) + QR code (RIGHT) */}
      <div className="case-detail-grid">
        {/* LEFT — Movement Chain */}
        <div className="case-detail-card">
          <h3>Movement Chain</h3>
          {movements.length === 0 ? (
            <div className="case-detail-timeline-item"><div className="t-route">No movements recorded yet.</div></div>
          ) : (
            <ul className="case-detail-timeline">
              {movements.map((m, i) => (
                <li className="case-detail-timeline-item" key={m.id ?? i}>
                  <div className="t-route">
                    {m.fromLocation === '—' ? 'New' : m.fromLocation}
                    <span className="t-arrow">→</span>
                    {m.toLocation}
                  </div>
                  <div className="t-meta">
                    by {m.movedBy} · {fmtTime(m.timestamp)} · {m.purpose}
                    {renderDocRef(m.docRef)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* RIGHT — QR Code (below the header, on the right) */}
        <div className="case-detail-card">
          <h3>QR Code</h3>
          {qrUrl
            ? <img className="case-detail-qr" src={qrUrl} alt={`QR for ${caseRow.id}`} />
            : <div className="case-detail-qr" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--slate-soft)' }}>No QR</div>}
          {qrMask && <div className="case-detail-qr-meta">{qrMask}</div>}
          {caseRow.imageUrl && (
            <img className="case-detail-photo" src={caseRow.imageUrl} alt="Evidence photo" style={{ marginTop: 12 }} />
          )}
        </div>
      </div>

      {/* Log / Edit Movement modal */}
      {showLog && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !logBusy) setShowLog(false); }}>
          <div className="form-card">
            <button type="button" className="tag-close" onClick={() => setShowLog(false)} aria-label="Close">✕</button>
            <h3>Log / Edit Movement — {caseRow.id}</h3>
            <div className="sub">{caseRow.itemType} · Current: {caseRow.sectionName}</div>
            <MovementForm
              caseRow={caseRow}
              fromLocation={fromLocation}
              busy={logBusy}
              submitLabel="Record movement"
              onSubmit={submitLog}
              onCancel={() => setShowLog(false)}
            />
            {logErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{logErr}</div>}
          </div>
        </div>
      )}

      {/* Edit Case Property modal — same layout/format as Log/Edit Movement */}
      {showEdit && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !editBusy) setShowEdit(false); }}>
          <form className="form-card" onSubmit={submitEdit}>
            <button type="button" className="tag-close" onClick={() => setShowEdit(false)} aria-label="Close">✕</button>
            <h3>Edit Case Property — {caseRow.id}</h3>
            <div className="sub">{caseRow.itemType} · Current: {caseRow.sectionName}</div>
            <div className="form-grid">
              <label className="full">Category of Item
                <input
                  value={edItemType}
                  onChange={e => setEdItemType(e.target.value)}
                  placeholder="e.g. Narcotics / NDPS Article"
                  required />
              </label>

              <label>Location
                <select value={edSection} onChange={e => setEdSection(e.target.value)} required>
                  <option value="">— pick a section —</option>
                  {sections.map(s => (
                    <option key={s.letter} value={s.letter}>{s.letter} — {s.name}</option>
                  ))}
                </select>
              </label>

              <label>Status
                <select value={edStatus} onChange={e => setEdStatus(e.target.value as CaseStatus)}>
                  {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <label>Received By (Moharrir)
                <input value={edReceivedBy} onChange={e => setEdReceivedBy(e.target.value)} placeholder="Officer name" />
              </label>

              <label>FIR Date
                <input type="date" value={edFirDate} onChange={e => setEdFirDate(e.target.value)} />
              </label>

              <label className="full">Section (U/S)
                <input
                  value={edUs}
                  onChange={e => setEdUs(e.target.value)}
                  placeholder="e.g. 244, 245"
                />
              </label>
            </div>
            {editErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{editErr}</div>}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setShowEdit(false)} disabled={editBusy}>Cancel</button>
              <button type="submit" className="btn" disabled={editBusy || !edItemType.trim() || !edSection}>{editBusy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {/* Hidden off-screen sheet used by "Download QR" — composes the
          upper case-detail record + movement chain + QR into one PNG. */}
      <div
        ref={sheetRef}
        style={{
          position: 'fixed', left: -10000, top: 0, width: 760, padding: 28,
          background: '#fff', color: '#14243D',
          fontFamily: "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif',",
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #8C7A54', paddingBottom: 8, marginBottom: 12 }}>
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: '#8C7A54' }}>{escapeHtml(caseRow.id)}</div>
            <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>{escapeHtml(caseRow.itemType)}</div>
            {caseRow.itemSub ? <div style={{ color: '#4F6079', fontSize: 12 }}>{escapeHtml(caseRow.itemSub)}</div> : null}
          </div>
          <span style={{ display: 'inline-block', padding: '4px 10px', borderRadius: 3, background: '#E6ECF2', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{escapeHtml(caseRow.status)}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px 16px', margin: '12px 0 18px', padding: '10px 12px', border: '1px solid #D9D2C2', borderRadius: 4 }}>
          <div><span style={KV_K}>S.NO</span><span style={KV_V}>{sno != null ? sno : '—'}</span></div>
          <div><span style={KV_K}>Malkhana No.</span><span style={KV_V}>{escapeHtml(caseRow.itemId || '—')}</span></div>
          <div><span style={KV_K}>FIR / DD No.</span><span style={KV_V}>{escapeHtml(caseRow.id)}</span></div>
          <div><span style={KV_K}>FIR Date</span><span style={KV_V}>{escapeHtml(caseRow.firDate || '—')}</span></div>
          <div><span style={KV_K}>Section (U/S)</span><span style={KV_V}>{escapeHtml(detailUsText(caseRow))}</span></div>
          <div><span style={KV_K}>Category of Item</span><span style={KV_V}>{escapeHtml(caseRow.itemType)}</span></div>
          <div><span style={KV_K}>Location</span><span style={KV_V}>{escapeHtml(caseRow.sectionName || '—')} (Part {escapeHtml((caseRow.section || '').replace('PART ', ''))})</span></div>
          <div><span style={KV_K}>Received By (Moharrir)</span><span style={KV_V}>{escapeHtml(caseRow.receivedBy || '—')}</span></div>
          <div><span style={KV_K}>Last Movement Date</span><span style={KV_V}>{escapeHtml(caseRow.lastMovement || '—')}</span></div>
          <div><span style={KV_K}>Status</span><span style={KV_V}>{escapeHtml(caseRow.status)}</span></div>
        </div>

        <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>Movement Chain</h3>
            {movements.length === 0 ? (
              <div style={{ color: '#4F6079', fontSize: 11, fontStyle: 'italic' }}>No movements recorded yet.</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {movements.map((m, i) => (
                  <li key={m.id ?? i} style={{ position: 'relative', padding: '6px 0 6px 20px', borderLeft: '2px solid #D9D2C2', marginLeft: 4 }}>
                    <div style={{ fontSize: 12 }}>{escapeHtml((m.fromLocation || 'New') )} <span style={{ color: '#8C7A54' }}>→</span> {escapeHtml(m.toLocation || '—')}</div>
                    <div style={{ fontSize: 10.5, color: '#4F6079', marginTop: 2 }}>{escapeHtml(m.movedBy || '—')} · {fmtTime(m.timestamp)}{m.purpose ? ' · ' + escapeHtml(m.purpose) : ''}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ width: 180, textAlign: 'center' }}>
            <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>QR Code</h3>
            {qrUrl ? <img src={qrUrl} style={{ width: 170, height: 170, border: '4px solid #14243D', borderRadius: 3 }} alt="QR" /> : null}
            <div style={{ fontSize: 10, color: '#4F6079', marginTop: 6 }}>Encrypted — scan with e-Malkhana</div>
          </div>
        </div>

        <div style={{ marginTop: 18, paddingTop: 8, borderTop: '1px solid #D9D2C2', fontSize: 10, color: '#4F6079', display: 'flex', justifyContent: 'space-between' }}>
          <span>e-Malkhana · Case Detail</span>
          <span>Generated: {escapeHtml(new Date().toLocaleString('en-IN'))}</span>
        </div>
      </div>
    </div>
  );
}

// Shared style snippets for the hidden download sheet.
const KV_K: React.CSSProperties = { fontSize: 9.5, textTransform: 'uppercase', color: '#8C7A54', display: 'block', letterSpacing: '0.06em' };
const KV_V: React.CSSProperties = { fontSize: 12, color: '#14243D', fontWeight: 500 };
