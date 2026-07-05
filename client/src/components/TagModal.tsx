import { useEffect, useState } from 'react';
import type { CaseRow } from '../types';
import { api } from '../api';

interface Props {
  open: boolean;
  data: CaseRow | null;
  onClose: () => void;
}

export function TagModal({ open, data, onClose }: Props) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !data) { setQrUrl(null); setErr(null); return; }
    let cancelled = false;
    api.qr(data.id)
      .then(r => { if (!cancelled) setQrUrl(r.dataUrl); })
      .catch(e => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [open, data]);

  if (!data) return null;

  function doPrint() {
    if (!qrUrl) return;
    const w = window.open('', '_blank', 'width=400,height=600');
    if (!w) return;
    w.document.write(`
      <html><head><title>Evidence Tag — ${data!.id}</title>
      <style>body{font-family:sans-serif;padding:24px;text-align:center}h2{font-size:18px;margin:8px 0}p{color:#666;margin:4px 0;font-size:13px}</style>
      </head><body>
        <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#8C7A54;font-weight:600">Evidence Tag</div>
        <h2>${data!.id}</h2>
        <img src="${qrUrl}" style="width:240px;height:240px;border:6px solid #14243D"/>
        <p><b>Item:</b> ${data!.itemType}</p>
        <p><b>Section:</b> ${data!.sectionName}</p>
        <p><b>Status:</b> ${data!.status}</p>
        <p><b>Item ID:</b> ${data!.itemId}</p>
        <script>setTimeout(()=>window.print(), 250);</script>
      </body></html>
    `);
    w.document.close();
  }

  return (
    <div className={`overlay${open ? ' open' : ''}`} id="tagOverlay" onClick={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="tag-card">
        <div className="tag-eyelet"></div>
        <button className="tag-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="tag-perforation"></div>
        <div className="tag-content">
          <div className="eyebrow">Evidence Tag</div>
          <h3 id="tagFir">{data.id}</h3>
          {qrUrl
            ? <img className="qr-image" src={qrUrl} alt={`QR for ${data.id}`} />
            : (err
                ? <div className="form-msg show error" style={{ margin: '4px auto 16px' }}>QR error: {err}</div>
                : <div className="qr-visual" />)}
          {data.imageUrl && <img className="case-full" src={data.imageUrl} alt="Evidence photo" />}
          <div className="tag-meta">
            <div className="tag-meta-row"><span className="k">Item</span><span className="v">{data.itemType}</span></div>
            <div className="tag-meta-row"><span className="k">Section</span><span className="v">{data.sectionName}</span></div>
            <div className="tag-meta-row"><span className="k">Status</span><span className="v">{data.status}</span></div>
            <div className="tag-meta-row"><span className="k">Item ID</span><span className="v">{data.itemId}</span></div>
            {data.docRef && <div className="tag-meta-row"><span className="k">Doc</span><span className="v"><a href={data.docRef} target="_blank" rel="noreferrer">view</a></span></div>}
          </div>
          <button className="btn ghost small" style={{ width: '100%', justifyContent: 'center' }} onClick={doPrint} disabled={!qrUrl}>
            Print Tag
          </button>
        </div>
      </div>
    </div>
  );
}
