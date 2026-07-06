import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { CaseRow, MovementEvent, MovementLogRow } from '../types';

interface Props {
  onOpenTag: (c: CaseRow) => void;        // legacy: kept for global fallback
  onRegisterMovement: (c: CaseRow) => void; // opens the inline movement form
}

const STATUS_TONE: Record<string, string> = {
  'Seized': 'tone-info', 'In Malkhana': 'tone-info',
  'With FSL': 'tone-warn', 'Expert Opinion Pending': 'tone-warn',
  'In Court': 'tone-info', 'Disposed': 'tone-good',
};

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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!itemIdParam) return;
    setErr(null); setBusy(true);
    (async () => {
      try {
        const c = await api.case(itemIdParam);
        setCaseRow(c);
        const [mv, qr] = await Promise.all([
          api.movements(c.id),
          api.qr(c.id).catch(() => ({ dataUrl: '', payload: '' })),
        ]);
        setMovements(mv);
        setQrUrl(qr.dataUrl);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [itemIdParam]);

  // Honour ?tab=tag / ?tab=timeline from the case-property row icons.
  // After a short delay (so the DOM is rendered) we scroll the matching
  // section into view + briefly highlight it, then strip the param so
  // a refresh of the same URL doesn't keep jumping.
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
        <h2 style="margin: 12px 0 4px">${caseRow.itemType}</h2>
        <div class="id">${caseRow.id}</div>
        <div class="meta">Item ID: ${caseRow.itemId}</div>
        <div class="meta">Section: ${caseRow.sectionName} (Part ${caseRow.section?.replace('PART ', '')})</div>
        <div class="meta">Status: ${caseRow.status}</div>
        <div class="meta">Seized: ${caseRow.seizedOn} · by ${caseRow.seizingOfficer}</div>
        <hr/>
        <button class="no-print" onclick="window.print()">Print</button>
      </body></html>`);
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
          {caseRow.itemSub && <div className="case-detail-sub">{caseRow.itemSub}</div>}
        </div>
        <span className={`stamp ${STATUS_TONE[caseRow.status] || ''}`}>{caseRow.status}</span>
      </header>

      {/* meta strip */}
      <div className="case-detail-meta">
        <div><span className="k">Section</span><span className="v">Part {caseRow.section?.replace('PART ', '')} · {caseRow.sectionName}</span></div>
        <div><span className="k">Item ID</span><span className="v">{caseRow.itemId}</span></div>
        <div><span className="k">Seized</span><span className="v">{caseRow.seizedOn} · by {caseRow.seizingOfficer}</span></div>
        <div><span className="k">Created</span><span className="v">{fmtTime(caseRow.createdAt)}</span></div>
      </div>

      {/* actions */}
      <div className="case-detail-actions">
        <button className="btn" onClick={() => onRegisterMovement(caseRow)}>＋ Log New Movement</button>
        {qrUrl && <button className="btn ghost" onClick={printTag}>🖨 Print Tag</button>}
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
            <div><span className="k">Payload</span><span className="v" style={{fontFamily:'monospace',fontSize:11}}>{JSON.stringify({id:caseRow.id, type:caseRow.itemType, ts:caseRow.createdAt}).slice(0,80)}…</span></div>
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
