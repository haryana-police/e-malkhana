import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { api } from '../api';
import type { CaseRow, FirMaster } from '../types';

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

export function CasePropertyDetail() {
  const { item_id: itemIdParam } = useParams<{ item_id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const sno = (location.state as any)?.sno;
  const [caseRow, setCaseRow] = useState<CaseRow | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrMask, setQrMask] = useState<string | null>(null);
  const [firMaster, setFirMaster] = useState<FirMaster | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!itemIdParam) return;
    setErr(null); setBusy(true);
    (async () => {
      try {
        const c = await api.case(itemIdParam);
        setCaseRow(c);
        const [qr, fir] = await Promise.all([
          api.qr(c.id).catch(() => ({ dataUrl: '', payload: '', encrypted: false, mask: null })),
          // FIR master details (police station, U/S, IO) — once per FIR.
          api.firMaster(c.firNo || c.id).catch(() => null),
        ]);
        setQrUrl(qr.dataUrl);
        setQrMask(qr.mask || null);
        setFirMaster(fir);
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
      {/* breadcrumb + back */}
      <div className="case-detail-bar">
        <Link to="/caseproperty" className="link-back">← All Case Property</Link>
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
