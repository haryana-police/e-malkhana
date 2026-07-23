import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import type {
  CaseRow, CasePropertyData, FirMaster, CategoryOfItem, CaseStatus, MovementLogRow,
} from '../types';
import { MovementForm, type MovementFormData } from './MovementForm';
import { CameraCaptureModal } from './CameraCaptureModal';

// Convert a File picked from <input type="file"> to a data-URL string.
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

// ============================================================
// CasePropertyDetail — REGISTRATION SNAPSHOT (read-only fields)
// with ACTION TOOLBAR at the top.
// ============================================================
//
// Opens when the user clicks a FIR/DD No. from the register. Renders
// the EXACT same fields as `RegisterCaseModal` (the registration
// form) — Step 1 (booking) + Step 2 (per-item) — but the field
// values are static, read-only cells.  The action toolbar at the
// top of the page lets the MM trigger the five page-level actions:
//
//   + Log New Movement   (opens the standard MovementForm in a modal)
//   ✎ Edit Case Property (compact single-form Edit modal)
//   🏷 Print Tag         (opens a minimal QR-tag window for printing)
//   🖨 Print full detail (opens the full card in a print-ready HTML)
//   🗑 Delete            (red, requires re-typing the Malkhana No.)
//
// The encrypted QR generated at registration is pinned in the
// TOP-RIGHT corner of the page header (same `api.qr(id)` payload).
//
// Data sources:
//   GET /api/cases/:id              → CaseRow (booked fields, sectionName, etc.)
//   GET /api/fir-master/:firNo      → FirMaster (police station, IO, DD-specific)
//   GET /api/case-property/:itemId  → CasePropertyData (seizedTime, quantity,
//                                     placeOfSeizure, seal block, …)
//   GET /api/item-categories        → CategoryOfItem[] (per-category field defs)
//   GET /api/cases/:id/qr           → encrypted QR data URL + mask
//   GET /api/cases/:id/movements    → MovementLogRow[] (last from-location for Log)
//   GET /api/sections?active=all    → for Edit Location dropdown
//   GET /api/item-types             → for Edit Category dropdown

// Status list mirrors server STATUSES.  Kept in sync via the same
// allow-list check on the server.
const STATUS_OPTIONS: CaseStatus[] = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed', 'Transfer',
];

const STATUS_TONE: Record<string, string> = {
  'Seized': 'tone-info', 'In Malkhana': 'tone-info',
  'With FSL': 'tone-warn', 'Expert Opinion Pending': 'tone-warn',
  'In Court': 'tone-info', 'Disposed': 'tone-good',
  'Transfer': 'tone-info',
};

// HTML escaper for the print windows so a malicious item name can't
// break out of the print template.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Format U/S section(s) as "ACT N — title" using the ACT:N form stored
// on the row.  Falls back to bare numbers with "BNS " prefix for legacy
// rows.  Empty -> em-dash.
function detailUsText(c: CaseRow): string {
  const fmt = (s: string) => {
    const str = String(s).trim();
    const m = str.match(/^([A-Z]{2,10}):(\S+)$/);
    if (m) return `${m[1]} ${m[2]}`;
    if (/^[a-zA-Z]/.test(str)) return str;
    return `BNS ${str}`;
  };
  if (c.legalSections && c.legalSections.length) {
    return c.legalSections
      .map((s, i) =>
        `${fmt(s)}${c.legalSectionsTitles && c.legalSectionsTitles[i] ? ' — ' + c.legalSectionsTitles[i] : ''}`,
      )
      .join(' · ');
  }
  if (c.legalSection) return `${fmt(c.legalSection)}${c.legalSectionTitle ? ' — ' + c.legalSectionTitle : ''}`;
  return '—';
}

// Section display letter — strips "PART " prefix from `section`.
function sectionLetter(c: CaseRow): string {
  return (c.section || '').replace('PART ', '').trim();
}

// Decide Record Type (FIR vs DD).  Prefer `fir_master.recordType`;
// fall back to parsing the first token of `c.id` ("FIR …" / "DD …").
function recordTypeOf(c: CaseRow, fm: FirMaster | null): 'FIR' | 'DD' {
  if (fm?.recordType === 'FIR' || fm?.recordType === 'DD') return fm.recordType;
  const head = (c.id || '').trim().split(/\s+/)[0].toUpperCase();
  return head === 'DD' ? 'DD' : 'FIR';
}

// Format a yyyy-mm-dd (or ISO) as a readable DD MMM YYYY for display.
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Format ISO timestamp as DD MMM HH:MM (en-IN) for movement chain / print.
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

// ============================================================
// Read-only cell — wraps a `<label>` exactly like the registration
// form, but the input is replaced by a `.ro-val` static value so the
// layout is identical (same label font, same border).
// ============================================================
function ReadOnlyField({ label, value, mono, full, className }: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  full?: boolean;
  className?: string;
}) {
  const cls = [full ? 'full' : '', className || ''].filter(Boolean).join(' ');
  return (
    <label className={cls}>
      {label}
      <div className={`ro-val${mono ? ' mono' : ''}`}>{value || '—'}</div>
    </label>
  );
}

export function CasePropertyDetail({ refresh = 0 }: { refresh?: number }) {
  const { item_id: idParam } = useParams<{ item_id: string }>();
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [caseProperty, setCaseProperty] = useState<CasePropertyData | null>(null);
  const [firMaster, setFirMaster] = useState<FirMaster | null>(null);
  const [categories, setCategories] = useState<CategoryOfItem[] | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrMask, setQrMask] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- Edit modal dropdown options ----
  const [sections, setSections] = useState<{ letter: string; name: string }[]>([]);
  const [itemTypes, setItemTypes] = useState<{ id: number; name: string }[]>([]);

  // ---- Action modal state ----
  const [showLog, setShowLog] = useState(false);
  const [fromLocation, setFromLocation] = useState('—');
  const [logErr, setLogErr] = useState<string | null>(null);
  const [logBusy, setLogBusy] = useState(false);

  const [showEdit, setShowEdit] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  // ---- Step 1 (FIR / DD & Receipt) — Edit state ----
  const [edRecordType, setEdRecordType] = useState<'FIR' | 'DD'>('FIR');
  const [edFirNo, setEdFirNo] = useState('');              // FIR/DD No. (read-only on detail, but carried for save)
  const [edFirDate, setEdFirDate] = useState('');
  // Common block
  const [edUs, setEdUs] = useState('');
  const [edReceivedBy, setEdReceivedBy] = useState('');
  const [edSeizedTime, setEdSeizedTime] = useState('');
  const [edSeizingOfficer, setEdSeizingOfficer] = useState('');

  // ---- Step 2 (Seized Item Details) — Edit state ----
  const [edItemType, setEdItemType] = useState('');
  const [edSection, setEdSection] = useState('');
  const [edStatus, setEdStatus] = useState<CaseStatus>('Seized');
  const [edQuantity, setEdQuantity] = useState('');
  const [edRemarks, setEdRemarks] = useState('');

  // ---- Photo edit state ----
  // `null` = server had no photo and user hasn't picked one yet,
  // `''` = explicitly cleared, `'data:...'` = picked/re-captured photo.
  // We always PATCH the server with the latest chosen state (data-URL
  // or null) so the on-disk file matches what the user sees.
  const [edPhotoDataUrl, setEdPhotoDataUrl] = useState<string | null>(null);
  const [edPhotoFile, setEdPhotoFile] = useState<File | null>(null);
  const [edPhotoOriginalUrl, setEdPhotoOriginalUrl] = useState<string | null>(null);
  // Camera modal
  const [editCamOpen, setEditCamOpen] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // ---- Initial fetch + dropdown options ----
  useEffect(() => {
    api.sections('all').then(s => setSections(s.map(x => ({ letter: x.letter, name: x.name })))).catch(() => setSections([]));
  }, []);

  // Scale the whole detail view to fit exactly one screen (no page scroll).
  useEffect(() => {
    const fit = () => {
      const wrap = document.querySelector('.case-detail') as HTMLElement | null;
      if (!wrap) return;
      const sheet = wrap.querySelector('.case-a4-sheet') as HTMLElement | null;
      // reset any prior scale to measure natural height
      wrap.style.transform = 'none';
      const natural = wrap.getBoundingClientRect().height;
      const topChrome = wrap.getBoundingClientRect().top; // distance from viewport top (header + nav)
      const avail = window.innerHeight - topChrome - 8; // 8px breathing room
      const scale = Math.min(1, avail / natural);
      wrap.style.transformOrigin = 'top center';
      wrap.style.transform = `scale(${scale})`;
      wrap.style.height = `${natural * scale}px`;
      if (sheet) sheet.style.transform = 'none';
    };
    fit();
    window.addEventListener('resize', fit);
    const t = setTimeout(fit, 350); // re-fit after fonts/images settle
    return () => { window.removeEventListener('resize', fit); clearTimeout(t); };
  }, [caseRow, movements]);

  useEffect(() => {
    if (!idParam) return;
    setErr(null);
    setBusy(true);
    (async () => {
      try {
        const c = await api.case(idParam);
        setCaseRow(c);
        const [qr, fm, cp, catList, mv] = await Promise.all([
          api.qr(c.id).catch(() => null),
          api.firMaster(c.firNo || c.id).catch(() => null),
          api.caseProperty(c.itemId).catch(() => null),
          api.itemCategories().catch(() => [] as CategoryOfItem[]),
          api.movements(c.id).catch(() => [] as MovementLogRow[]),
        ]);
        setQrUrl(qr?.dataUrl ?? null);
        setQrMask(qr?.mask ?? null);
        setFirMaster(fm);
        setCaseProperty(cp);
        setCategories(catList);
        setMovements(Array.isArray(mv) ? mv : []);
        // item-types for the case's section (drives the Edit Category dropdown)
        const secLetter = (c.section || '').replace('PART ', '').trim();
        if (secLetter) {
          api.itemTypes(secLetter).then(t => setItemTypes(t.map(x => ({ id: x.id, name: x.name })))).catch(() => setItemTypes([]));
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [idParam, refresh]);

  // ============================================================
  // Action handlers
  // ============================================================

  async function openLog() {
    if (!caseRow) return;
    setShowLog(true);
    setLogErr(null);
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

  function openEdit() {
    if (!caseRow) return;
    setShowEdit(true);
    setEditErr(null);

    // ---- Step 1: FIR/DD & Receipt ----
    const isDD = recordTypeOf(caseRow, firMaster) === 'DD';
    const fm = firMaster;
    setEdRecordType(isDD ? 'DD' : 'FIR');
    setEdFirNo(caseRow.id || '');
    setEdFirDate(caseRow.firDate || '');
    setEdReceivedBy(caseRow.receivedBy || caseProperty?.receivedBy || '');
    setEdSeizedTime(caseProperty?.seizedTime || '10:00');
    setEdSeizingOfficer(caseRow.seizingOfficer || '');
    if (caseRow.legalSections && caseRow.legalSections.length) setEdUs(caseRow.legalSections.join(', '));
    else if (caseRow.legalSection) setEdUs(caseRow.legalSection);
    else setEdUs('');

    // ---- Step 2: Seized Item ----
    setEdItemType(caseRow.itemType || '');
    setEdSection(caseRow.section?.replace('PART ', '') || '');
    setEdStatus(caseRow.status || 'Seized');
    setEdQuantity(caseProperty?.quantity || caseRow.quantity || caseRow.itemSub || '');
    setEdRemarks(caseProperty?.remarks || caseRow.description || '');

    // ---- Photo: prefill from current photoUrl (data-URL we can't reopen),
    //       so the user can either KEEP / REPLACE with a new file.
    const initialPhoto = caseRow.imageUrl || caseProperty?.photoUrl || null;
    setEdPhotoOriginalUrl(initialPhoto);
    setEdPhotoDataUrl(null);     // null = "no change to what the server has"
    setEdPhotoFile(null);
  }

  // Open the in-app camera modal to capture a new photo for the Edit modal.
  function openEditCam() {
    setEditCamOpen(true);
  }
  // Camera captured a new image — store as data-URL + File, close modal.
  function onEditCamCapture(dataUrl: string, file: File) {
    setEdPhotoDataUrl(dataUrl);
    setEdPhotoFile(file);
    setEditCamOpen(false);
  }
  // File input picked a new photo.
  async function onEditPhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const d = await fileToDataUrl(f);
    setEdPhotoDataUrl(d);
    setEdPhotoFile(f);
  }
  // Remove the photo — clears state and we PATCH `imageUrl: null` on save.
  function clearEditPhoto() {
    setEdPhotoDataUrl('');
    setEdPhotoFile(null);
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow) return;
    setEditBusy(true); setEditErr(null);
    try {
      const usArr = (edUs || '').split(',').map(s => s.replace(/^BNS\s+/i, '').trim()).filter(Boolean);
      if (!edItemType.trim()) throw new Error('Category of Item cannot be empty');
      if (!edSection) throw new Error('Pick a location');
      if (!edSeizingOfficer.trim()) throw new Error('Seizing Officer cannot be empty');

      // Slim case_property patch — only the fields the Edit modal renders
      // (seized time, moharrir, quantity, description).  No seal block,
      // no per-category popup fields, no sub-type — the modal doesn't
      // expose them so sending nothing preserves any existing value.
      const cpPatch: Partial<{
        seizedTime: string; receivedBy: string; quantity: string;
        remarks: string;
      }> = {
        seizedTime: edSeizedTime.trim() || undefined,
        receivedBy: edReceivedBy.trim() || undefined,
        quantity:   edQuantity.trim() || undefined,
        remarks:    edRemarks.trim() || undefined,
      };

      // Photo: explicit user action always wins.
      //   - data-URL set: user picked/captured a new photo → upload data-URL.
      //   - '' (empty string): user clicked Remove → clear the photo.
      //   - null: user did nothing with the photo → leave server value as-is.
      const imageUrlOverride: string | null | undefined =
        edPhotoDataUrl === null
          ? undefined
          : (edPhotoDataUrl === '' ? null : edPhotoDataUrl);

      // Slim updateCase payload — 13 fields exactly.  No DD-extras, no
      // caseProperty seal/per-cat block, no recordType flip (case id
      // immutable — see server.js).
      const updated = await api.updateCase(caseRow.id, {
        itemType:       edItemType.trim(),
        section:        edSection,
        status:         edStatus,
        seizingOfficer: edSeizingOfficer.trim(),
        receivedBy:     edReceivedBy.trim() || null,
        firDate:        edFirDate.trim() || null,
        description:    edRemarks.trim() || null,
        imageUrl:       imageUrlOverride,
        legalSections:  usArr,
        caseProperty:   cpPatch,
      });
      setCaseRow(updated);
      // Re-fetch so the on-screen detail cards reflect the edits.
      const [fresh, cpFresh, fmFresh] = await Promise.all([
        api.case(caseRow.id).catch(() => updated),
        api.caseProperty(caseRow.itemId).catch(() => null),
        api.firMaster(caseRow.firNo || caseRow.id).catch(() => null),
      ]);
      setCaseRow(fresh);
      setCaseProperty(cpFresh);
      setFirMaster(fmFresh);
      setShowEdit(false);
    } catch (err) {
      setEditErr((err as Error).message);
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteCase() {
    if (!caseRow) return;
    setDeleteBusy(true); setDeleteErr(null);
    try {
      const result = await api.deleteCase(caseRow.id, deleteConfirm);
      // After delete, navigate back to the register with a flash.
      window.history.back();
      setTimeout(() => { window.location.href = '/caseproperty'; }, 100);
      console.log('Deleted:', result);
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  // ============================================================
  // Print functions
  // ============================================================
  function printTag() {
    if (!qrUrl || !caseRow) return;
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>Tag · ${escapeHtml(caseRow.id)}</title>
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
        <div class="meta">Section: ${escapeHtml(caseRow.sectionName)} (Part ${escapeHtml((caseRow.section || '').replace('PART ', ''))})</div>
        <div class="meta">Status: ${escapeHtml(caseRow.status)}</div>
        <hr/>
        <button class="no-print" onclick="window.print()">Print</button>
      </body></html>`);
    w.document.close();
  }

  function printDetail() {
    if (!caseRow) return;
    const c = caseRow;
    const cp = caseProperty;
    const fm = firMaster;
    const isDD = recordTypeOf(c, fm) === 'DD';
    // Build the same Step 1 / Step 2 rows as the on-screen cards.
    const usText = detailUsText(c);
    const photoUrl = c.imageUrl || cp?.photoUrl || '';

    // Reuse the same contextbar pattern.
    const contextBar = `
      <div class="ctx">
        <span><b>Station:</b> ${escapeHtml(fm?.policeStation || '—')}</span>
        <span><b>Moharrir:</b> ${escapeHtml(cp?.receivedBy || c.receivedBy || '—')}</span>
        <span><b>Item:</b> ${escapeHtml(c.id)}</span>
      </div>`;

    const step1Rows = `
      <div><span class="k">Record Type</span><span class="v">${escapeHtml(isDD ? 'DD (Daily Diary)' : 'FIR')}</span></div>
      <div><span class="k">FIR / DD No.</span><span class="v mono">${escapeHtml(c.id)}</span></div>
      <div><span class="k">${escapeHtml(isDD ? 'DD Date' : 'FIR Date')}</span><span class="v mono">${escapeHtml(fmtDate(c.firDate))}</span></div>
      <div class="full"><span class="k">Section (U/S Legal Section)</span><span class="v mono">${escapeHtml(usText)}</span></div>
      <div><span class="k">Received By (Malkhana Moharrir)</span><span class="v">${escapeHtml(cp?.receivedBy || c.receivedBy || '—')}</span></div>
      <div><span class="k">Seized Time</span><span class="v mono">${escapeHtml(cp?.seizedTime || '—')}</span></div>
      <div><span class="k">Seizing Officer</span><span class="v">${escapeHtml(c.seizingOfficer || '—')}</span></div>
    `;

    const step2Rows = `
      <div><span class="k">Category of Item</span><span class="v">${escapeHtml(c.itemType)}</span></div>
      <div><span class="k">Location</span><span class="v">${escapeHtml(c.sectionName || '—')} (Part ${escapeHtml(sectionLetter(c) || '—')})</span></div>
      <div><span class="k">Quantity</span><span class="v">${escapeHtml(cp?.quantity || c.quantity || c.itemSub || '—')}</span></div>
      <div class="full"><span class="k">Item Description</span><span class="v">${escapeHtml(cp?.remarks || c.description || '—')}</span></div>
    `;

    const movementHtml = movements.length === 0
      ? '<div class="empty">No movements recorded yet.</div>'
      : `<ol class="timeline">${movements.map((m) => {
          return `<li>
            <div class="t-route">${escapeHtml(m.fromLocation || 'New')}<span class="t-arrow">→</span>${escapeHtml(m.toLocation || '—')}</div>
            <div class="t-meta">${escapeHtml(m.movedBy || '—')} · ${fmtTime(m.timestamp)}${m.purpose ? ' · ' + escapeHtml(m.purpose) : ''}</div>
          </li>`;
        }).join('')}</ol>`;

    const html = `<!doctype html><html><head><title>Case Detail · ${escapeHtml(c.id)}</title>
      <style>
        @page { size: A4; margin: 14mm; }
        body  { font-family: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; color: #14243D; margin: 0; background: #FAF7EE; }
        h1, h2, h3 { font-family: 'Rajdhani', sans-serif; color: #14243D; margin: 0; }
        .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #8C7A54; padding-bottom: 8px; margin-bottom: 14px; }
        .id   { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #8C7A54; }
        .title{ font-size: 22px; margin: 4px 0; }
        .sub  { color: #4F6079; font-size: 12px; }
        .stamp{ display: inline-block; padding: 4px 10px; border-radius: 3px; background: #E6ECF2; color: #14243D; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
        .stamp.tone-warn { background: #FFEED1; color: #8A4B00; }
        .stamp.tone-good { background: #D6F0DC; color: #1A5A33; }
        .card { border: 1px solid #D9D2C2; border-radius: 4px; padding: 12px 14px; margin-bottom: 14px; background: #fff; }
        .card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #14243D; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #D9D2C2; }
        .ctx { display: flex; gap: 18px; padding: 8px 10px; background: #F2EDDB; border: 1px solid #A99968; border-radius: 4px; margin-bottom: 12px; font-size: 11.5px; align-items: center; }
        .ctx b { color: #8C7A54; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.06em; margin-right: 4px; }
        .step1-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
        .step1-head .left { flex: 1; min-width: 0; }
        .step1-qr { flex: 0 0 auto; text-align: center; padding: 4px 6px; border: 1px solid #D9D2C2; border-radius: 3px; background: #fff; }
        .step1-qr img { width: 110px; height: 110px; display: block; border: 2px solid #14243D; }
        .step1-qr-cap { font-size: 8.5px; color: #4F6079; margin-top: 3px; max-width: 110px; }
        .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px; }
        .k { font-size: 9.5px; text-transform: uppercase; color: #8C7A54; display: block; letter-spacing: 0.06em; }
        .v { font-size: 12px; color: #14243D; font-weight: 500; word-break: break-word; }
        .v.mono { font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; }
        .full { grid-column: 1 / -1; }
        .qr   { width: 180px; height: 180px; display: block; margin: 0 auto; border: 4px solid #14243D; border-radius: 3px; }
        .qr-cap { font-size: 10px; color: #4F6079; text-align: center; margin-top: 4px; }
        .row  { display: flex; gap: 14px; margin-bottom: 14px; align-items: flex-start; }
        .bottom-row { display: flex; gap: 14px; margin-bottom: 14px; align-items: stretch; }
        .bottom-row .movement-card { flex: 1.15 1 0; }
        .bottom-row .evidence-card { flex: 1 1 0; }
        .bottom-row .evidence-card .evidence-body { display: flex; align-items: center; justify-content: center; min-height: 180px; }
        .bottom-row .evidence-card .evidence-body.empty { background: #FAF7EE; color: #4F6079; font-style: italic; font-size: 12px; border: 1px dashed #D9D2C2; }
        .empty-photo { opacity: 0.85; }
        .photo{ max-width: 100%; max-height: 360px; display: block; margin: 0 auto; border: 1px solid #D9D2C2; border-radius: 3px; }
        .evidence-card { border: 2px solid #14243D; padding: 14px 16px; }
        .evidence-card h3 { font-size: 13px; color: #14243D; border-bottom: 2px solid #14243D; padding-bottom: 8px; }
        .evidence-body { padding: 10px 0 4px; text-align: center; background: #FAF7EE; border-radius: 4px; }
        .photo-lg { max-width: 100%; max-height: 360px; display: inline-block; margin: 0 auto; border: 2px solid #14243D; border-radius: 4px; box-shadow: 0 2px 8px rgba(20,36,61,0.12); }
        .movement-card { border: 2px solid #14243D; padding: 14px 16px; }
        .movement-card h3 { font-size: 13px; color: #14243D; border-bottom: 2px solid #14243D; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: baseline; }
        .movement-card h3 .muted { font-size: 10.5px; font-weight: 400; color: #4F6079; text-transform: none; letter-spacing: 0; }
        .timeline { list-style: none; padding: 0; margin: 6px 0 0; }
        .timeline li { position: relative; padding: 4px 10px 4px 14px; border-left: 2px solid #14243D; margin-left: 5px; margin-bottom: 4px; background: #F2EDDB; border-radius: 0 4px 4px 0; }
        .timeline li:last-child { margin-bottom: 0; border-left-color: transparent; }
        .t-route { font-size: 12px; font-weight: 600; color: #14243D; }
        .t-arrow { color: #8C7A54; font-weight: 700; margin: 0 6px; }
        .t-meta  { font-size: 10px; color: #4F6079; margin-top: 2px; }
        .empty   { color: #4F6079; font-size: 11px; font-style: italic; }
        .footer  { margin-top: 14px; padding-top: 8px; border-top: 1px solid #D9D2C2; font-size: 10px; color: #4F6079; display: flex; justify-content: space-between; }
        .noprint { display: block; text-align: right; margin: 12px 0; }
        .noprint button { padding: 6px 14px; border: 1px solid #14243D; background: #14243D; color: #fff; border-radius: 3px; cursor: pointer; }
        @media print { .noprint { display: none; } }
      </style></head><body>
        <div class="noprint"><button onclick="window.print()">🖨 Print this page</button></div>
        <div class="head">
          <div>
            <h1 class="title">${escapeHtml(c.itemType)}</h1>
            ${c.itemSub ? `<div class="sub">${escapeHtml(c.itemSub)}</div>` : ''}
          </div>
          <span class="stamp ${STATUS_TONE[c.status] || ''}">${escapeHtml(c.status)}</span>
        </div>
        <div class="card">
          <h3>Step 1 of 2 — ${escapeHtml(isDD ? 'DD' : 'FIR')} &amp; Receipt</h3>
          <div class="step1-head">
            <div class="left">
              <div class="grid">${step1Rows}</div>
            </div>
            ${qrUrl ? `
            <div class="step1-qr">
              <img src="${escapeHtml(qrUrl)}" alt="Encrypted QR" />
            </div>` : ''}
          </div>
        </div>
        <div class="card">
          <h3>Step 2 of 2 — Seized Item Details</h3>
          <div class="grid">${step2Rows}</div>
        </div>
        ${(movements.length > 0 || photoUrl) ? `
        <div class="bottom-row">
          <div class="card movement-card">
            <h3>Movement Chain <span class="muted">(${movements.length} ${movements.length === 1 ? 'entry' : 'entries'})</span></h3>
            ${movementHtml}
          </div>
          ${photoUrl ? `
          <div class="card evidence-card">
            <h3>Photo of Seized Object</h3>
            <div class="evidence-body">
              <img class="photo-lg" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(c.itemType)}" />
            </div>
          </div>` : `<div class="card evidence-card empty-photo"><h3>Photo of Seized Object</h3><div class="evidence-body empty">No photo was uploaded at registration.</div></div>`}
        </div>` : ''}
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

  // ============================================================
  // Render
  // ============================================================

  if (busy) return <div className="empty-state">Loading…</div>;
  if (err) {
    return (
      <div className="empty-state">
        <p>❌ {err}</p>
        <Link to="/caseproperty" className="btn">← Back to register</Link>
      </div>
    );
  }
  if (!caseRow) return null;

  const c = caseRow;
  const cp = caseProperty;
  const fm = firMaster;
  const recordType = recordTypeOf(c, fm);
  const isDD = recordType === 'DD';

  // Photo URL: case_row.imageUrl preferred; falls back to case_property.photoUrl.
  const photoUrl = c.imageUrl || cp?.photoUrl || undefined;

  return (
    <div className="case-detail">
      {/* ===== Top action bar ===== */}
      <div className="case-detail-bar">
        <Link to="/caseproperty" className="link-back">← All Case Property</Link>
        <div className="case-detail-actions">
          <button className="btn" type="button" onClick={openLog}>＋ Log New Movement</button>
          <button className="btn ghost" type="button" onClick={openEdit}>✎ Edit Case Property</button>
          <button className="btn ghost" type="button" onClick={printTag}>🏷 Print Tag</button>
          <button className="btn ghost" type="button" onClick={printDetail}>🖨 Print full detail</button>
          <button
            className="btn ghost danger"
            type="button"
            onClick={() => { setDeleteConfirm(''); setDeleteErr(null); setShowDelete(true); }}
          >
            🗑 Delete
          </button>
        </div>
      </div>

      {/* ============================================================
          SINGLE-PAGE A4 LAYOUT — mirrors the printable Case Detail
          exactly so what the user prints is exactly what they see.
          {/* ============================================================
              SINGLE-PAGE A4 LAYOUT — mirrors the printable Case Detail
              exactly so what the user prints is exactly what they see.
              Every section (Step 1 + Step 2 + Movement + Photo) lives
              inside ONE A4 sheet so nothing scrolls off the screen.
              ============================================================ */}
          <div className="case-a4-sheet">

            {/* Title + status stamp (same as print head) */}
            <div className="case-a4-head">
              <div>
                <div className="case-a4-id">{c.id}</div>
                <h1 className="case-a4-title">{c.itemType}</h1>
                {c.itemSub && <div className="case-a4-sub">{c.itemSub}</div>}
              </div>
              <span className={`case-a4-stamp ${STATUS_TONE[c.status] || ''}`}>{c.status}</span>
            </div>

            {/* STEP 1 — title + QR top-right, fields below */}
            <div className="case-a4-card">
              <div className="case-a4-step1-head">
                <h3>Step 1 of 2 — {isDD ? 'DD' : 'FIR'} &amp; Receipt</h3>
                <div className="case-a4-qr">
                  {qrUrl
                    ? <img src={qrUrl} alt={`Encrypted QR for ${c.id}`} className="case-a4-qr-img" />
                    : <div className="case-a4-qr-placeholder">No QR</div>}
                  {qrMask && <div className="case-a4-qr-mask">{qrMask}</div>}
                </div>
              </div>
              <div className="case-a4-grid">
                <div><span className="k">Record Type</span><span className="v">{isDD ? 'DD (Daily Diary)' : 'FIR'}</span></div>
                <div><span className="k">FIR / DD No.</span><span className="v mono">{c.id}</span></div>
                <div><span className="k">{isDD ? 'DD Date' : 'FIR Date'}</span><span className="v mono">{fmtDate(c.firDate)}</span></div>
                <div className="full"><span className="k">Section (U/S Legal Section)</span><span className="v mono">{detailUsText(c)}</span></div>
                <div><span className="k">Received By (Malkhana Moharrir)</span><span className="v">{cp?.receivedBy || c.receivedBy || '—'}</span></div>
                <div><span className="k">Seized Time</span><span className="v mono">{cp?.seizedTime || '—'}</span></div>
                <div><span className="k">Seizing Officer</span><span className="v">{c.seizingOfficer || '—'}</span></div>
              </div>
            </div>

            {/* STEP 2 */}
            <div className="case-a4-card">
              <h3>Step 2 of 2 — Seized Item Details</h3>
              <div className="case-a4-grid">
                <div><span className="k">Category of Item</span><span className="v">{c.itemType}</span></div>
                <div>
                  <span className="k">Location</span>
                  <span className="v">
                    {c.sectionName
                      ? `${c.sectionName} (Part ${sectionLetter(c) || '—'})`
                      : sectionLetter(c)
                        ? `Part ${sectionLetter(c)}`
                        : '—'}
                  </span>
                </div>
                <div><span className="k">Quantity</span><span className="v">{cp?.quantity || c.quantity || c.itemSub || '—'}</span></div>
                <div className="full"><span className="k">Item Description</span><span className="v">{cp?.remarks || c.description || '—'}</span></div>
              </div>
            </div>

            {/* MOVEMENT + PHOTO side-by-side */}
            <div className="case-a4-bottom">
              <div className="case-a4-card case-a4-movement">
                <h3>
                  Movement Chain
                  <span className="muted"> ({movements.length} {movements.length === 1 ? 'entry' : 'entries'})</span>
                </h3>
                {movements.length === 0
                  ? <div className="case-a4-empty">No movements recorded yet.</div>
                  : (
                    <ol className="case-a4-timeline">
                      {movements.map((m, idx) => {
                        return (
                          <li key={idx}>
                            <div className="t-route">
                              {m.fromLocation || 'New'}
                              <span className="t-arrow">→</span>
                              {m.toLocation || '—'}
                            </div>
                            <div className="t-meta">
                              {m.movedBy || '—'} · {fmtTime(m.timestamp)}
                              {m.purpose ? ` · ${m.purpose}` : ''}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
              </div>

              <div className="case-a4-card case-a4-photo">
                <h3>Photo of Seized Object</h3>
                {photoUrl
                  ? (
                    <div className="case-a4-photo-body">
                      <img className="case-a4-photo-lg" src={photoUrl} alt={`Seized ${c.itemType}`} />
                      <span className="case-a4-photo-cap">{c.itemId} · captured at registration</span>
                    </div>
                  )
                  : <div className="case-a4-empty case-a4-empty-photo">No photo was uploaded at registration.</div>}
              </div>
            </div>

            {/* Footer (printed-style) */}
            <div className="case-a4-footer">
              <span>e-Malkhana · Case Detail · {recordType} {c.id}</span>
              <span>{escapeHtml(new Date().toLocaleString('en-IN'))}</span>
            </div>
          </div>

      {/* Footer */}
      <footer className="case-property-foot">
        <span className="case-property-foot-note">
          Read-only view · registration-time fields · {recordType} {c.id}
        </span>
        <Link to="/caseproperty" className="btn ghost">← Back to register</Link>
      </footer>

      {/* ============================================================
          Action modals (Log / Edit / Delete)
          ============================================================ */}

      {/* Log New Movement */}
      {showLog && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !logBusy) setShowLog(false); }}>
          <div className="form-card">
            <button type="button" className="tag-close" onClick={() => setShowLog(false)} aria-label="Close">✕</button>
            <h3>Log / Edit Movement — {c.id}</h3>
            <div className="sub">{c.itemType} · Current: {c.sectionName}</div>
            <MovementForm
              caseRow={c}
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

      {/* Edit Case Property — slim modal.  Only the fields that already
          appear on the on-screen detail card are editable (the same Step 1 +
          Step 2 layout the registration form uses, but trimmed to the
          actual-rendered columns).  No DD-extras block (case id immutable),
          no seal block (visible only on a few categories — not in the
          screenshot register path), no per-cat popup fields (visible only
          on a few categories).  Save writes 13 fields in one PATCH. */}
      {showEdit && (() => {
        const today = new Date().toISOString().slice(0, 10);
        // Photo preview — pick the freshly captured data-URL if any, else
        // the original server URL (read-only).
        const previewPhoto = edPhotoDataUrl === null ? edPhotoOriginalUrl : edPhotoDataUrl;
        return (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !editBusy) setShowEdit(false); }}>
          <form className="form-card form-card-wide" onSubmit={submitEdit}>
            <button type="button" className="tag-close" onClick={() => setShowEdit(false)} aria-label="Close">✕</button>
            <h3>Edit Case Property — {c.id}</h3>
            <div className="sub">{c.itemType} · Current: {c.sectionName} · Current status: {c.status}</div>

            {/* ============= Step 1 of 2 — FIR/DD & Receipt ============= */}
            <fieldset className="edit-step">
              <legend>Step 1 of 2 — FIR / DD &amp; Receipt</legend>

              <div className="form-grid rc-grid">
                {/* Record Type radio + FIR/DD No. read-only (case id immutable) */}
                <div className="rc-radio-row full">
                  <span className="rc-field-label">Record Type</span>
                  <div className="rc-radio-row-inner">
                    <label className={`rc-radio-opt ${edRecordType === 'FIR' ? 'on' : ''}`}>
                      <input type="radio" name="ed-record-type" checked={edRecordType === 'FIR'} onChange={() => setEdRecordType('FIR')} />
                      <span>FIR</span>
                    </label>
                    <label className={`rc-radio-opt ${edRecordType === 'DD' ? 'on' : ''}`}>
                      <input type="radio" name="ed-record-type" checked={edRecordType === 'DD'} onChange={() => setEdRecordType('DD')} />
                      <span>DD (Daily Diary)</span>
                    </label>
                  </div>
                </div>

                <label>FIR / DD No.
                  <input value={edFirNo} readOnly className="ro-val mono" title="Case id cannot be changed" />
                </label>
                <label>{edRecordType === 'DD' ? 'DD Date' : 'FIR Date'}
                  <input type="date" value={edFirDate} onChange={e => setEdFirDate(e.target.value)} max={today} />
                </label>

                <label className="full">Section (U/S Legal Section) — multiple allowed
                  <input
                    value={edUs}
                    onChange={e => setEdUs(e.target.value)}
                    placeholder="e.g. 244, 245 or BNS 101"
                  />
                </label>
                <label>Received By (Malkhana Moharrir)
                  <input value={edReceivedBy} onChange={e => setEdReceivedBy(e.target.value)} placeholder="Officer name" />
                </label>
                <label>Seized Time
                  <input type="time" value={edSeizedTime} onChange={e => setEdSeizedTime(e.target.value)} />
                </label>
                <label>Seizing Officer
                  <input value={edSeizingOfficer} onChange={e => setEdSeizingOfficer(e.target.value)} placeholder="Officer name" required />
                </label>
              </div>
            </fieldset>

            {/* ============= Step 2 of 2 — Seized Item Details ============= */}
            <fieldset className="edit-step">
              <legend>Step 2 of 2 — Seized Item Details</legend>
              <div className="form-grid rc-grid item-grid">

                <label>Category of Item
                  <select
                    value={edItemType}
                    onChange={e => setEdItemType(e.target.value)}
                  >
                    <option value="">— pick a category —</option>
                    {(categories || []).filter(c => c.active).map(cat => (
                      <option key={cat.id} value={cat.label}>{cat.label}</option>
                    ))}
                  </select>
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

                <label>Quantity
                  <input value={edQuantity} onChange={e => setEdQuantity(e.target.value)} placeholder="e.g. 1 or 2 kg" />
                </label>

                <label className="full">Item Description (detailed — brand, colour, size, marks)
                  <textarea
                    value={edRemarks}
                    onChange={e => setEdRemarks(e.target.value)}
                    placeholder="Detailed description"
                    rows={3}
                  />
                </label>
              </div>

              {/* Photo of the seized object — replace / remove / keep */}
              <label className="full rc-photo-label">Photo of the seized object
                <div className="edit-photo-zone">
                  {previewPhoto ? (
                    <div className="edit-photo-preview">
                      <img src={previewPhoto} alt={`Seized ${edItemType || ''}`} />
                      <span className="edit-photo-meta">
                        {edPhotoDataUrl && edPhotoDataUrl !== ''
                          ? 'New photo selected — click Save to upload.'
                          : 'Current photo (unchanged).'}
                      </span>
                    </div>
                  ) : (
                    <div className="rc-photo-empty">No photo on this case property.</div>
                  )}
                  <div className="edit-photo-actions">
                    <label className="btn ghost edit-photo-btn">
                      📁 Upload new
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onEditPhotoFile} />
                    </label>
                    <button type="button" className="btn ghost edit-photo-btn" onClick={openEditCam}>📷 Use camera</button>
                    {previewPhoto && (
                      <button type="button" className="btn ghost edit-photo-btn danger" onClick={clearEditPhoto}>🗑 Remove</button>
                    )}
                  </div>
                </div>
              </label>
            </fieldset>

            {editErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{editErr}</div>}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setShowEdit(false)} disabled={editBusy}>Cancel</button>
              <button type="submit" className="btn"
                      disabled={editBusy || !edItemType.trim() || !edSection || !edSeizingOfficer.trim()}>
                {editBusy ? 'Saving…' : 'Save all changes'}
              </button>
            </div>
          </form>
        </div>
        );
      })()}

      {/* Camera capture for the Edit modal */}
      <CameraCaptureModal
        open={editCamOpen}
        onClose={() => setEditCamOpen(false)}
        onCapture={onEditCamCapture}
      />

      {/* Delete confirm */}
      {showDelete && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !deleteBusy) setShowDelete(false); }}>
          <div className="form-card">
            <button type="button" className="tag-close" onClick={() => setShowDelete(false)} aria-label="Close">✕</button>
            <h3>Delete Case Property</h3>
            <p className="sub">This permanently deletes the registration record and its movement history. Type the Malkhana No. <strong>{c.itemId}</strong> to confirm.</p>
            <label>Confirm Malkhana No.
              <input autoFocus value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder={c.itemId} />
            </label>
            {deleteErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{deleteErr}</div>}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setShowDelete(false)} disabled={deleteBusy}>Cancel</button>
              <button type="button" className="btn danger" onClick={deleteCase} disabled={deleteBusy || deleteConfirm.trim().toLowerCase() !== c.itemId.trim().toLowerCase()}>{deleteBusy ? 'Deleting…' : 'Delete permanently'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
