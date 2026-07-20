import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { api } from '../api';
import html2canvas from 'html2canvas';
import type { CaseRow, FirMaster, MovementLogRow } from '../types';

const STATUS_TONE: Record<string, string> = {
  'Seized': 'tone-info', 'In Malkhana': 'tone-info',
  'With FSL': 'tone-warn', 'Expert Opinion Pending': 'tone-warn',
  'In Court': 'tone-info', 'Disposed': 'tone-good',
  'Transfer': 'tone-info',
};

// U/S (legal section) formatted for the compact detail view.
function detailUsText(c: CaseRow): string {
  if (c.legalSections && c.legalSections.length) {
    return c.legalSections
      .map((s, i) => `BNS ${s}${c.legalSectionsTitles && c.legalSectionsTitles[i] ? ' — ' + c.legalSectionsTitles[i] : ''}`)
      .join(' · ');
  }
  if (c.legalSection) return `BNS ${c.legalSection}${c.legalSectionTitle ? ' — ' + c.legalSectionTitle : ''}`;
  return '—';
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

export function CasePropertyDetail() {
  const { item_id: itemIdParam } = useParams<{ item_id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const sno = (location.state as any)?.sno;
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrMask, setQrMask] = useState<string | null>(null);
  const [firMaster, setFirMaster] = useState<FirMaster | null>(null);
  const [movements, setMovements] = useState<MovementLogRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- inline edit (Edit details) ----
  const [editing, setEditing] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [sections, setSections] = useState<{ letter: string; name: string }[]>([]);

  // ---- log / edit movement modal ----
  const [showLog, setShowLog] = useState(false);
  const [logTo, setLogTo] = useState('');
  const [logBy, setLogBy] = useState('');
  const [logPurpose, setLogPurpose] = useState('');
  const [logDoc, setLogDoc] = useState('');
  const [logErr, setLogErr] = useState<string | null>(null);
  const [logBusy, setLogBusy] = useState(false);

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
        const [qr, fir, mv] = await Promise.all([
          api.qr(c.id).catch(() => ({ dataUrl: '', payload: '', encrypted: false, mask: null })),
          // FIR master details (police station, U/S, IO) — once per FIR.
          api.firMaster(c.firNo || c.id).catch(() => null),
          api.movements(c.id).catch(() => [] as MovementLogRow[]),
        ]);
        setQrUrl(qr.dataUrl);
        setQrMask(qr.mask || null);
        setFirMaster(fir);
        setMovements(Array.isArray(mv) ? mv : []);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [itemIdParam]);

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
    // Use a tiny inline stylesheet for the print window so we don't
    // need to ship a separate print.css through the bundler.  Mirrors
    // the on-screen layout minus the action bar.
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
        .row  { display: flex; gap: 16px; margin-bottom: 18px; }
        .card { flex: 1; border: 1px solid #D9D2C2; border-radius: 4px; padding: 12px; }
        .card h3 { font-size: 13px; margin-bottom: 8px; }
        .qr   { width: 180px; height: 180px; display: block; margin: 0 auto; border: 4px solid #14243D; border-radius: 3px; }
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
        ${caseRow.imageUrl ? `<div class="card" style="margin-bottom:18px;"><h3>Photo</h3><img class="photo" src="${caseRow.imageUrl}" alt="${escapeHtml(caseRow.itemType)}" /></div>` : ''}
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

  // ---- Inline edit (Edit details) ----
  function startEdit() {
    if (!caseRow) return;
    setEditing(true);
    setEditErr(null);
    setSavedFlash(false);
    api.sections('all').then(s => setSections(s.map(x => ({ letter: x.letter, name: x.name })))).catch(() => setSections([]));
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow) return;
    setSaving(true); setEditErr(null);
    const form = new FormData(e.currentTarget as HTMLFormElement);
    const patch: Record<string, any> = {};
    const itemType = String(form.get('itemType') || '').trim();
    const itemSub = String(form.get('itemSub') || '').trim();
    const section = String(form.get('section') || '').trim();
    const seizingOfficer = String(form.get('seizingOfficer') || '').trim();
    const itemId = String(form.get('itemId') || '').trim();
    const description = String(form.get('description') || '').trim();
    const legalRaw = String(form.get('legalSections') || '').trim();
    const legalSections = legalRaw
      ? legalRaw.split(',').map(s => s.replace(/^BNS\s+/i, '').trim()).filter(Boolean)
      : undefined;
    if (itemType && itemType !== caseRow.itemType) patch.itemType = itemType;
    if (itemSub !== (caseRow.itemSub || '')) patch.itemSub = itemSub;
    if (section && section !== caseRow.section?.replace('PART ', '')) patch.section = section;
    if (seizingOfficer && seizingOfficer !== caseRow.seizingOfficer) patch.seizingOfficer = seizingOfficer;
    if (itemId && itemId !== caseRow.itemId) patch.itemId = itemId;
    if (description !== (caseRow.description || '')) patch.description = description;
    if (legalSections && JSON.stringify(legalSections) !== JSON.stringify(caseRow.legalSections || [])) patch.legalSections = legalSections;
    if (Object.keys(patch).length === 0) { setEditing(false); setSaving(false); return; }
    try {
      const updated = await api.updateCase(caseRow.id, patch);
      setCaseRow(updated);
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
    } catch (err) {
      setEditErr((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ---- Log / Edit movement ----
  async function openLog() {
    if (!caseRow) return;
    setShowLog(true);
    setLogErr(null);
    setLogTo(caseRow.sectionName || '');
    setLogBy(caseRow.receivedBy || 'SI Rakesh Sharma');
    setLogPurpose('Movement');
    setLogDoc('');
  }
  async function submitLog(e: React.FormEvent) {
    e.preventDefault();
    if (!caseRow) return;
    if (!logTo.trim()) { setLogErr('Destination location is required.'); return; }
    setLogBusy(true); setLogErr(null);
    try {
      await api.createMovement({
        caseId: caseRow.id,
        toLocation: logTo.trim(),
        movedBy: logBy.trim() || 'Moharrir',
        purpose: logPurpose.trim() || 'Movement',
        docRef: logDoc.trim() || undefined,
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
          <button className="btn" type="button" onClick={startEdit}>✎ Edit details</button>
          <button className="btn" type="button" onClick={openLog}>＋ Log New Movement</button>
          <button className="btn ghost" type="button" onClick={printTag}>🏷 Print Tag</button>
          <button className="btn ghost" type="button" onClick={printDetail}>🖨 Print full detail</button>
          {savedFlash && <span className="case-detail-saved-flash">Saved ✓</span>}
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

      {/* Inline edit form */}
      {editing && (
        <form className="case-detail-edit" onSubmit={saveEdit}>
          <h3>Edit Case Property Details</h3>
          <div className="case-detail-edit-grid">
            <label>Item Type
              <input name="itemType" defaultValue={caseRow.itemType} />
            </label>
            <label>Description / Sub-type
              <input name="itemSub" defaultValue={caseRow.itemSub || ''} />
            </label>
            <label>Section (Part)
              <select name="section" defaultValue={caseRow.section?.replace('PART ', '') || ''}>
                <option value="">— select —</option>
                {sections.map(s => <option key={s.letter} value={s.letter}>{s.letter} — {s.name}</option>)}
              </select>
            </label>
            <label>Seizing Officer
              <input name="seizingOfficer" defaultValue={caseRow.seizingOfficer || ''} />
            </label>
            <label>Malkhana No.
              <input name="itemId" defaultValue={caseRow.itemId || ''} />
            </label>
            <label>Free-text description
              <input name="description" defaultValue={caseRow.description || ''} />
            </label>
            <label>Legal Section(s) — comma separated
              <input name="legalSections" defaultValue={(caseRow.legalSections || []).join(', ')} placeholder="e.g. 244, 245" />
            </label>
          </div>
          {editErr && <div className="case-detail-edit-err">{editErr}</div>}
          <div className="case-detail-edit-actions">
            <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
        </form>
      )}

      {/* Compact 11-column Case Property card (matches the register) — no scroll */}
      <div className="case-property-card" style={{ marginTop: 16 }}>
        <div className="cp-card-grid">
          <div><span className="k">S.NO</span><span className="v mono">{sno != null ? sno : '—'}</span></div>
          <div><span className="k">Malkhana No.</span><span className="v mono">{caseRow.itemId || '—'}</span></div>
          <div><span className="k">FIR / DD No.</span><span className="v mono">{caseRow.id}</span></div>
          <div><span className="k">FIR Date</span><span className="v mono">{caseRow.firDate ? caseRow.firDate : '—'}</span></div>
          <div><span className="k">Section (U/S)</span><span className="v mono us">{detailUsText(caseRow)}</span></div>
          <div><span className="k">Category of Item</span><span className="v">{caseRow.itemType}</span></div>
          <div><span className="k">Location</span><span className="v">{caseRow.sectionName} (Part {caseRow.section?.replace('PART ', '')})</span></div>
          <div><span className="k">Received By (Moharrir)</span><span className="v">{caseRow.receivedBy || '—'}</span></div>
          <div><span className="k">Last Movement Date</span><span className="v mono">{caseRow.lastMovement ? caseRow.lastMovement : '—'}</span></div>
          <div><span className="k">Status</span><span className="v"><span className={`stamp ${STATUS_TONE[caseRow.status] || ''}`}>{caseRow.status}</span></span></div>
          <div className="cp-photo-cell">
            <span className="k">Photo</span>
            {caseRow.imageUrl
              ? <img src={caseRow.imageUrl} alt={caseRow.itemType} className="cp-thumb" />
              : <span className="v">—</span>}
          </div>
        </div>
      </div>

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
          <div style={{ marginTop: 12 }}>
            <button className="btn small" type="button" onClick={openLog}>✎ Edit / Log Movement</button>
          </div>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn ghost small" type="button" onClick={printQr}>🖨 Print QR</button>
            <button className="btn ghost small" type="button" onClick={downloadQr} disabled={!qrUrl}>⬇ Download QR</button>
          </div>
        </div>
      </div>

      {/* Log / Edit Movement modal */}
      {showLog && (
        <div className="overlay open" onClick={e => { if (e.target === e.currentTarget && !logBusy) setShowLog(false); }}>
          <form className="form-card" onSubmit={submitLog}>
            <button type="button" className="tag-close" onClick={() => setShowLog(false)} aria-label="Close">✕</button>
            <h3>Log / Edit Movement — {caseRow.id}</h3>
            <div className="sub">{caseRow.itemType} · Current: {caseRow.sectionName}</div>
            <div className="form-grid">
              <label className="full">To location
                <input value={logTo} onChange={e => setLogTo(e.target.value)} placeholder="e.g. Malkhana — Part B / FSL Madhuban" required />
              </label>
              <label>Moved by
                <input value={logBy} onChange={e => setLogBy(e.target.value)} placeholder="Officer name" />
              </label>
              <label>Purpose
                <input value={logPurpose} onChange={e => setLogPurpose(e.target.value)} placeholder="e.g. For forensic analysis" />
              </label>
              <label className="full">Document ref (optional)
                <input value={logDoc} onChange={e => setLogDoc(e.target.value)} placeholder="e.g. FSL-FWD-2026-114" />
              </label>
            </div>
            {logErr && <div className="form-msg show error" style={{ marginTop: 8 }}>{logErr}</div>}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setShowLog(false)} disabled={logBusy}>Cancel</button>
              <button type="submit" className="btn" disabled={logBusy || !logTo.trim()}>{logBusy ? 'Recording…' : 'Record movement'}</button>
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
