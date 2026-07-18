import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { CaseRow, MovementLogRow, RackItem, BnsSection, ItemType, FirMaster, CasePropertyData } from '../types';

interface Props {
  onOpenTag: (c: CaseRow) => void;        // legacy: kept for global fallback
  onRegisterMovement: (c: CaseRow) => void; // opens the inline movement form
}

const STATUS_TONE: Record<string, string> = {
  'Seized': 'tone-info', 'In Malkhana': 'tone-info',
  'With FSL': 'tone-warn', 'Expert Opinion Pending': 'tone-warn',
  'In Court': 'tone-info', 'Disposed': 'tone-good',
  'Transfer': 'tone-info',
};

// Editable copy of the case row used by the inline-edit form.  Every key
// the user can change is on this shape.  Keep it in sync with what
// server.js's PATCH /api/cases/:id actually persists.
interface EditableCase {
  itemTypeId: number | null;
  description: string;
  sectionLetter: string;       // "A".."E" (we send just the letter; server re-derives "PART A")
  seizingOfficer: string;
  itemId: string;
  legalSectionNo: string;      // bare "101" or ""
  legalSectionTitle: string;
}

function caseToEditable(c: CaseRow): EditableCase {
  return {
    itemTypeId: c.itemTypeId != null ? c.itemTypeId : null,
    description: c.description || '',
    sectionLetter: (c.section || '').match(/PART ([A-Z]{1,2})/i)?.[1]?.toUpperCase() || 'A',
    seizingOfficer: c.seizingOfficer || '',
    itemId: c.itemId || '',
    legalSectionNo: c.legalSection || '',
    legalSectionTitle: c.legalSectionTitle || '',
  };
}

export function CasePropertyDetail({ onOpenTag, onRegisterMovement }: Props) {
  const { item_id: itemIdParam } = useParams<{ item_id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The icon links from the case-property table pass ?tab=tag or
  // ?tab=timeline.  We honour that by scrolling to + briefly highlighting
  // the relevant section.  We also strip the param from the URL after a
  // moment so a manual reload doesn't keep jumping on every render.
  const tab = (searchParams.get('tab') || '').toLowerCase();
  const highlightTab = (tab === 'tag' || tab === 'timeline') ? tab : null;
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [movements, setMovements] = useState<MovementLogRow[]>([]);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrMask, setQrMask] = useState<string | null>(null);
  const [firMaster, setFirMaster] = useState<FirMaster | null>(null);
  const [cp, setCp]             = useState<CasePropertyData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Racks for the section picker (loaded once per case change).
  const [racks, setRacks] = useState<RackItem[]>([]);
  // Item Types for THIS case's section (loaded for the edit dropdown).
  const [typeOptions, setTypeOptions] = useState<ItemTypeOption[]>([]);
  interface ItemTypeOption { id: number; name: string; }

  // Current "Item Type Fields" (Form Builder) definitions for THIS case's
  // section.  Used to filter the per-item specific fields so we ONLY render
  // columns that still exist in the current registration form — legacy keys
  // written by older schema versions (e.g. sub_type, fsl_seal_no,
  // malkhana_section, category) are dropped instead of being shown as stale
  // "previous type" columns.
  const [sectionFieldKeys, setSectionFieldKeys] = useState<Set<string>>(new Set());

  // Edit-mode state.  `null` = read-only (default).  An object = the
  // form's working copy (dirty, unsaved).
  const [editDraft, setEditDraft] = useState<EditableCase | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // BNS typeahead inside the edit form.
  const [bnsQuery, setBnsQuery] = useState('');
  const [bnsHits, setBnsHits] = useState<BnsSection[]>([]);
  const [bnsOpen, setBnsOpen] = useState(false);
  const [bnsLoading, setBnsLoading] = useState(false);
  const [bnsActive, setBnsActive] = useState<number>(-1);
  const bnsBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!itemIdParam) return;
    setErr(null); setBusy(true);
    (async () => {
      try {
        const c = await api.case(itemIdParam);
        setCaseRow(c);
        // Defensive: some server endpoints can return non-array shapes
        // (e.g. an un-awaited Promise that serialises as {}).  The movements
        // and sections endpoints are typed as arrays; coerce anything that
        // isn't an array to [] so the rest of the component can rely on
        // .length / .map without crashing.
        const safeArray = <T,>(x: unknown): T[] => Array.isArray(x) ? (x as T[]) : [];
        const [mv, qr, sec, types, fir, cp] = await Promise.all([
          api.movements(c.id).catch(() => [] as MovementLogRow[]),
          api.qr(c.id).catch(() => ({ dataUrl: '', payload: '', encrypted: false, mask: null })),
          // load racks for the section picker; ignore failure (the form
          // is hidden until the user clicks Edit anyway).
          api.sections('all').catch(() => [] as RackItem[]),
          // Load the item-type list for THIS case's section so the
          // edit dropdown only shows valid options.  The letter comes
          // from the loaded case; fall back to 'A' if unresolved.
          api.itemTypes(c.section?.replace('PART ', '') || 'A').catch(() => [] as ItemType[]),
          // FIR master details (police station, U/S, IO) — once per FIR.
          api.firMaster(c.firNo || c.id).catch(() => null),
          // Per-item COMMON + type-specific fields.
          api.caseProperty(c.itemId || c.id).catch(() => null),
        ]);
        setMovements(safeArray<MovementLogRow>(mv));
        setQrUrl(qr.dataUrl);
        setQrMask(qr.mask || null);
        setRacks(safeArray<RackItem>(sec));
        setTypeOptions(safeArray<ItemType>(types).map(t => ({ id: t.id, name: t.name })));
        setFirMaster(fir);
        setCp(cp);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [itemIdParam]);

  // Debounced BNS typeahead, only active while the form is open.
  useEffect(() => {
    if (!editDraft) return;
    let cancelled = false;
    setBnsLoading(true);
    const timer = setTimeout(() => {
      api.bnsSections(bnsQuery, 15)
        .then(rows => { if (!cancelled) { setBnsHits(rows); setBnsActive(rows.length ? 0 : -1); } })
        .catch(() => { if (!cancelled) setBnsHits([]); })
        .finally(() => { if (!cancelled) setBnsLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bnsQuery, editDraft]);

  // Click-outside closes the BNS dropdown.
  useEffect(() => {
    if (!bnsOpen) return;
    function onDocClick(e: MouseEvent) {
      if (bnsBoxRef.current && !bnsBoxRef.current.contains(e.target as Node)) {
        setBnsOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [bnsOpen]);

  // Honour ?tab=tag / ?tab=timeline from the case-property row icons.
  // After a short delay (so the DOM is rendered) we scroll the matching
  // section into view + briefly highlight it, then strip the param so
  // a refresh of the same URL doesn't loop.
  useEffect(() => {
    if (!highlightTab || busy || !caseRow) return;
    const id = highlightTab === 'tag' ? 'detail-section-tag' : 'detail-section-timeline';
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Clear the param from the URL so a manual refresh doesn't loop.
      const next = new URLSearchParams(searchParams);
      next.delete('tab');
      setSearchParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [highlightTab, busy, caseRow]); // eslint-disable-line react-hooks/exhaustive-deps

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  }
  function fmtDisplayDate(s: string) {
    if (!s) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    return s;
  }

  // ---- Edit-mode handlers ----

  function startEdit() {
    if (!caseRow) return;
    const draft = caseToEditable(caseRow);
    setEditDraft(draft);
    setEditErr(null);
    setBnsQuery(draft.legalSectionTitle ? `${draft.legalSectionNo} — ${draft.legalSectionTitle}` : (draft.legalSectionNo || ''));
    setBnsOpen(false);
  }
  function cancelEdit() {
    setEditDraft(null);
    setEditErr(null);
    setBnsHits([]);
    setBnsQuery('');
  }
  function pickBns(s: BnsSection) {
    if (!editDraft) return;
    setEditDraft({ ...editDraft, legalSectionNo: s.sectionNo, legalSectionTitle: s.title });
    setBnsQuery(`${s.sectionNo} — ${s.title}`);
    setBnsOpen(false);
  }
  function clearBns() {
    if (!editDraft) return;
    setEditDraft({ ...editDraft, legalSectionNo: '', legalSectionTitle: '' });
    setBnsQuery('');
    setBnsHits([]);
  }
  async function saveEdit() {
    if (!editDraft || !caseRow) return;
    setEditErr(null); setSaving(true);
    try {
      // Build the PATCH body.  We only send the legalSection key (even
      // when empty) so the server clears it; for the other fields we
      // send them all — the server's diff logic will skip no-ops.
      const patch: any = {
        itemTypeId:     editDraft.itemTypeId,
        description:    editDraft.description.trim(),
        section:        editDraft.sectionLetter,
        seizingOfficer: editDraft.seizingOfficer.trim(),
        itemId:         editDraft.itemId.trim(),
      };
      if (editDraft.legalSectionNo) {
        patch.legalSection = editDraft.legalSectionNo;
      } else {
        patch.legalSection = null;
      }
      const updated = await api.updateCase(caseRow.id, patch);
      setCaseRow(updated);
      setEditDraft(null);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 3000);
    } catch (e) {
      setEditErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

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
          <div><span class="k">Section</span><span class="v">Part ${escapeHtml((caseRow.section || '').replace('PART ', ''))} · ${escapeHtml(caseRow.sectionName || '')}</span></div>
          <div><span class="k">Item ID</span><span class="v">${escapeHtml(caseRow.itemId || '—')}</span></div>
          <div><span class="k">BNS Section${caseRow.legalSections && caseRow.legalSections.length > 1 ? 's' : ''}</span><span class="v">${(caseRow.legalSections && caseRow.legalSections.length ? caseRow.legalSections.map((s, i) => `BNS ${escapeHtml(s)}${caseRow.legalSectionsTitles && caseRow.legalSectionsTitles[i] ? ' — ' + escapeHtml(caseRow.legalSectionsTitles[i]) : ''}`) : (caseRow.legalSection ? [`BNS ${escapeHtml(caseRow.legalSection)}${caseRow.legalSectionTitle ? ' — ' + escapeHtml(caseRow.legalSectionTitle) : ''}`] : ['—'])).join(' · ')}</span></div>
          <div><span class="k">Created</span><span class="v">${escapeHtml(fmtTime(caseRow.createdAt))}</span></div>
        </div>
        <div class="row">
          <div class="card">
            <h3>Evidence Tag (QR)</h3>
            ${qrUrl ? `<img class="qr" src="${qrUrl}" alt="QR code" />` : '<div class="empty">No QR available</div>'}
          </div>
          <div class="card">
            <h3>Photo</h3>
            ${caseRow.imageUrl ? `<img class="photo" src="${caseRow.imageUrl}" alt="${escapeHtml(caseRow.itemType)}" />` : '<div class="empty">No photo on file</div>'}
          </div>
        </div>
        <div class="card" style="margin-bottom:18px;">
          <h3>Movement Timeline (${movements.length})</h3>
          ${movements.length === 0
            ? '<div class="empty">No movements recorded yet.</div>'
            : `<ol class="timeline">${movements.map(m => `
                <li>
                  <div class="t-route">
                    <span>${escapeHtml(m.fromLocation === '—' ? 'New' : m.fromLocation)}</span>
                    <span class="t-arrow">→</span>
                    <span><b>${escapeHtml(m.toLocation)}</b></span>
                  </div>
                  <div class="t-meta">
                    by ${escapeHtml(m.movedBy || '—')} · ${escapeHtml(fmtTime(m.timestamp))}${m.purpose ? ' · ' + escapeHtml(m.purpose) : ''}${m.docRef ? ' · ' + escapeHtml(m.docRef) : ''}
                  </div>
                </li>`).join('')}</ol>`}
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

  if (busy) return <div className="empty-state">Loading…</div>;
  if (err) return (
    <div className="empty-state">
      <p>❌ {err}</p>
      <Link to="/caseproperty" className="btn">← Back to register</Link>
    </div>
  );
  if (!caseRow) return null;

  const isEditing = !!editDraft;

  return (
    <div className="case-detail">
      {/* breadcrumb + back */}
      <div className="case-detail-bar">
        <Link to="/caseproperty" className="link-back">← All Case Property</Link>
        {savedFlash && <span className="case-detail-saved-flash">✓ Saved</span>}
      </div>

      {/* header */}
      <header className="case-detail-head">
        <div>
          <div className="case-detail-id">{caseRow.id}</div>
          <h1 className="case-detail-title">{caseRow.itemType}</h1>
          {caseRow.description && <div className="case-detail-sub">{caseRow.description}</div>}
        </div>
        <span className={`stamp ${STATUS_TONE[caseRow.status] || ''}`}>{caseRow.status}</span>
      </header>

      {/* FIR master details — entered once per FIR */}
      {firMaster && (
        <div className="case-detail-card" style={{ marginTop: 16 }}>
          <h3>FIR Master</h3>
          <div className="case-detail-meta">
            <div><span className="k">FIR/DD No.</span><span className="v">{firMaster.firNo}</span></div>
            <div><span className="k">Police Station</span><span className="v">{firMaster.policeStation || '—'}</span></div>
            <div><span className="k">FIR Date</span><span className="v">{firMaster.firDate || '—'}</span></div>
            <div><span className="k">U/S</span><span className="v">{firMaster.usSections || '—'}</span></div>
            <div><span className="k">Investigating Officer</span><span className="v">{firMaster.io || '—'}</span></div>
          </div>
        </div>
      )}

      {/* Case property: type-specific (popup) + common fields */}
      {cp && (
        <div className="case-detail-card" style={{ marginTop: 16 }}>
          <h3>Seizure Details</h3>
          {cp.fields && cp.fields.length > 0 && (
            <>
              <div className="case-detail-sub" style={{ marginBottom: 8 }}>Item-type specific fields</div>
              <div className="case-detail-meta">
                {cp.fields.filter(f => f.value).map(f => {
                  if (f.key === 'quantity_class') {
                    const tone = f.value === 'Small' ? 'small' : f.value === 'Intermediate' ? 'inter' : 'comm';
                    return (
                      <div key={f.key}><span className="k">NDPS Quantity Class</span>
                        <span className={`ndps-class ndps-${tone}`}>{f.value} Quantity</span></div>
                    );
                  }
                  return (<div key={f.key}><span className="k">{f.key.replace(/_/g, ' ')}</span><span className="v">{f.value}</span></div>);
                })}
              </div>
            </>
          )}
          <div className="case-detail-sub" style={{ margin: '10px 0 8px' }}>Common fields</div>
          <div className="case-detail-meta">
            <div><span className="k">Seizing Officer</span><span className="v">{caseRow.seizingOfficer}</span></div>
            <div><span className="k">Place of Seizure</span><span className="v">{cp.placeOfSeizure || cp.storageLocation || '—'}</span></div>
            <div><span className="k">Storage Location</span><span className="v">{cp.physicalStorage || '—'}</span></div>
            <div><span className="k">Witness 1</span><span className="v">{cp.witness1 || '—'}</span></div>
            <div><span className="k">Witness 2</span><span className="v">{cp.witness2 || '—'}</span></div>
            <div><span className="k">Quantity</span><span className="v">{cp.quantity || '—'}</span></div>
            <div className="case-detail-sub" style={{ margin: '10px 0 8px' }}>Malkhana Receipt</div>
            <div><span className="k">Received By (Moharrir)</span><span className="v">{cp.receivedBy || '—'}</span></div>
            <div><span className="k">Malkhana Location</span><span className="v">{cp.malkhanaLocation || '—'}</span></div>
            <div className="case-detail-sub" style={{ margin: '10px 0 8px' }}>Seal</div>
            <div><span className="k">Sealed / Unsealed</span><span className="v">{cp.sealSealed || '—'}</span></div>
            <div><span className="k">Seal No. / Mark</span><span className="v">{cp.sealNo || '—'}</span></div>
            <div><span className="k">Sealed By</span><span className="v">{cp.sealBy || '—'}</span></div>
            <div><span className="k">Status</span><span className="v">{cp.status || caseRow.status}</span></div>
            {cp.remarks && <div><span className="k">Remarks</span><span className="v">{cp.remarks}</span></div>}
            {cp.photoUrl && <div><span className="k">Photo</span><span className="v"><a href={cp.photoUrl} target="_blank" rel="noreferrer">view</a></span></div>}
          </div>
        </div>
      )}

      {/* edit form OR read-only meta strip */}
      {isEditing && editDraft ? (
        <div className="case-detail-edit">
          <div className="case-detail-edit-grid">
            <label>
              <span>Item type</span>
              <select
                value={editDraft.itemTypeId != null ? String(editDraft.itemTypeId) : ''}
                onChange={e => {
                  const v = e.target.value;
                  setEditDraft({ ...editDraft, itemTypeId: v ? Number(v) : null });
                }}
              >
                <option value="">— none —</option>
                {typeOptions.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Description (specifics)</span>
              <input
                type="text"
                value={editDraft.description}
                onChange={e => setEditDraft({ ...editDraft, description: e.target.value })}
                placeholder="e.g. 80 grams, sealed poly bag"
              />
            </label>
            <label>
              <span>Section (Rack)</span>
              <select
                value={editDraft.sectionLetter}
                onChange={e => setEditDraft({ ...editDraft, sectionLetter: e.target.value })}
              >
                {racks.length === 0 && <option value={editDraft.sectionLetter}>Part {editDraft.sectionLetter}</option>}
                {racks.map(r => (
                  <option key={r.letter} value={r.letter}>
                    Part {r.letter} · {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Seizing officer</span>
              <input
                type="text"
                value={editDraft.seizingOfficer}
                onChange={e => setEditDraft({ ...editDraft, seizingOfficer: e.target.value })}
                placeholder="Officer name & rank"
              />
            </label>
            <label>
              <span>Item ID</span>
              <input
                type="text"
                value={editDraft.itemId}
                onChange={e => setEditDraft({ ...editDraft, itemId: e.target.value })}
                placeholder="MK-YYYY-NNNNNN"
              />
            </label>
            <div className="case-detail-edit-bns" ref={bnsBoxRef}>
              <span>BNS section</span>
              <input
                type="text"
                value={bnsQuery}
                onChange={e => {
                  setBnsQuery(e.target.value);
                  setEditDraft({ ...editDraft, legalSectionNo: '', legalSectionTitle: '' });
                  setBnsOpen(true);
                }}
                onFocus={() => setBnsOpen(true)}
                placeholder="Type to search — e.g. 101, murder, theft"
              />
              {editDraft.legalSectionNo && (
                <button type="button" className="case-detail-edit-bns-clear" onClick={clearBns}>× clear</button>
              )}
              {bnsOpen && (
                <div className="case-detail-edit-bns-pop">
                  {bnsLoading && <div className="case-detail-edit-bns-empty">Searching…</div>}
                  {!bnsLoading && bnsHits.length === 0 && (
                    <div className="case-detail-edit-bns-empty">No matching BNS section</div>
                  )}
                  {!bnsLoading && bnsHits.map((s, i) => (
                    <button
                      type="button"
                      key={s.sectionNo}
                      className={`case-detail-edit-bns-row${i === bnsActive ? ' is-active' : ''}`}
                      onMouseEnter={() => setBnsActive(i)}
                      onClick={() => pickBns(s)}
                    >
                      <span className="case-detail-edit-bns-no">BNS&nbsp;{s.sectionNo}</span>
                      <span className="case-detail-edit-bns-title">{s.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {editErr && <div className="case-detail-edit-err">❌ {editErr}</div>}
          <div className="case-detail-edit-actions">
            <button className="btn primary" disabled={saving} onClick={saveEdit}>
              {saving ? 'Saving…' : '💾 Save changes'}
            </button>
            <button className="btn ghost" disabled={saving} onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="case-detail-meta">
          <div><span className="k">Section</span><span className="v">Part {caseRow.section?.replace('PART ', '')} · {caseRow.sectionName}</span></div>
          <div><span className="k">Item ID</span><span className="v">{caseRow.itemId}</span></div>
          <div><span className="k">BNS section{(caseRow.legalSections && caseRow.legalSections.length > 1) ? 's' : ''}</span><span className="v">{(caseRow.legalSections && caseRow.legalSections.length ? caseRow.legalSections.map((s, i) => `BNS ${s}${caseRow.legalSectionsTitles && caseRow.legalSectionsTitles[i] ? ' — ' + caseRow.legalSectionsTitles[i] : ''}`) : (caseRow.legalSection ? [`BNS ${caseRow.legalSection}${caseRow.legalSectionTitle ? ' — ' + caseRow.legalSectionTitle : ''}`] : ['—'])).join(' · ')}</span></div>
          <div><span className="k">Created</span><span className="v">{fmtTime(caseRow.createdAt)}</span></div>
        </div>
      )}

      {/* actions */}
      <div className="case-detail-actions">
        {!isEditing && <button className="btn primary" onClick={startEdit}>✏️ Edit details</button>}
        <button className="btn" onClick={() => onRegisterMovement(caseRow)} disabled={isEditing}>＋ Log New Movement</button>
        {qrUrl && <button className="btn ghost" onClick={printTag} disabled={isEditing}>🏷 Print Tag</button>}
        <button className="btn ghost" onClick={printDetail} disabled={isEditing}>🖨 Print full detail</button>
        {caseRow.imageUrl && <a className="btn ghost" href={caseRow.imageUrl} target="_blank" rel="noreferrer">📷 Evidence Photo</a>}
      </div>

      {/* QR + photo side-by-side */}
      <div className="case-detail-grid">
        <div
          id="detail-section-tag"
          className={`case-detail-card${highlightTab === 'tag' ? ' is-highlight' : ''}`}
        >
          <h3>Evidence Tag</h3>
          {qrUrl
            ? <img src={qrUrl} alt="QR code" className="case-detail-qr" />
            : <div className="sub">No QR available</div>}
          <div className="case-detail-qr-meta">
            <div><span className="k">Payload</span><span className="v" style={{fontFamily:'monospace',fontSize:11}}>{qrMask || JSON.stringify({id:caseRow.id, type:caseRow.itemType, ts:caseRow.createdAt}).slice(0,80)}…</span></div>
          </div>
        </div>
        <div className="case-detail-card">
          <h3>Photo</h3>
          {caseRow.imageUrl
            ? <img src={caseRow.imageUrl} alt={caseRow.itemType} className="case-detail-photo" />
            : <div className="sub">No photo on file</div>}
        </div>
      </div>

      {/* timeline (inline, not modal) */}
      <div
        id="detail-section-timeline"
        className={`case-detail-card${highlightTab === 'timeline' ? ' is-highlight' : ''}`}
      >
        <h3>Movement Timeline <span className="audit-tab-count">{movements.length}</span></h3>
        {movements.length === 0
          ? <div className="sub">No movements recorded yet.</div>
          : <ol className="case-detail-timeline">
              {movements.map(m => (
                <li key={m.id} className="case-detail-timeline-item">
                  <div className="t-route">
                    <span>{m.fromLocation === '—' ? 'New' : m.fromLocation}</span>
                    <span className="t-arrow">→</span>
                    <span><b>{m.toLocation}</b></span>
                  </div>
                  <div className="t-meta">
                    by {m.movedBy} · {fmtTime(m.timestamp)}{m.purpose ? ' · ' + m.purpose : ''}{m.docRef ? ' · ' + m.docRef : ''}
                  </div>
                </li>
              ))}
            </ol>}
      </div>
    </div>
  );
}

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
