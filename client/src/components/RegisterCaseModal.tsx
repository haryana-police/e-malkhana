import { useRef, useState } from 'react';
import type { RackItem } from '../types';
import { api } from '../api';

interface Props {
  open: boolean;
  racks: RackItem[];
  onClose: () => void;
  onCreated: () => void;
}

interface PendingFile {
  file: File;
  dataUrl: string;
  url?: string;       // populated after /api/upload
  uploading?: boolean;
  error?: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function RegisterCaseModal({ open, racks, onClose, onCreated }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [firOrDd, setFirOrDd]        = useState('FIR ');
  const [itemType, setItemType]      = useState('');
  const [itemSub, setItemSub]        = useState('');
  const [quantity, setQuantity]      = useState('1');
  const [section, setSection]        = useState(racks[0]?.letter ?? 'A');
  const [seizingOfficer, setOfficer] = useState('SI Rakesh Sharma');
  const [seizedOn, setSeizedOn]      = useState(today);
  const [photo, setPhoto]            = useState<PendingFile | null>(null);
  const [doc, setDoc]                = useState<PendingFile | null>(null);
  const [busy, setBusy]              = useState(false);
  const [msg, setMsg]                = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const photoRef = useRef<HTMLInputElement>(null);
  const docRef   = useRef<HTMLInputElement>(null);

  function reset() {
    setFirOrDd('FIR '); setItemType(''); setItemSub(''); setQuantity('1');
    setSection(racks[0]?.letter ?? 'A'); setOfficer('SI Rakesh Sharma');
    setSeizedOn(today); setPhoto(null); setDoc(null); setMsg(null);
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      setPhoto({ file: f, dataUrl, uploading: true });
    } catch (err) {
      setMsg({ kind: 'error', text: 'Failed to read the photo file.' });
    }
  }

  async function onPickDoc(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      setDoc({ file: f, dataUrl, uploading: true });
    } catch (err) {
      setMsg({ kind: 'error', text: 'Failed to read the supporting document.' });
    }
  }

  function humanSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Photo is OPTIONAL — if the MM skips it, the case is still registered
    // (no dummy image is generated for new entries; only pre-existing/seeded
    // records get auto-generated placeholders).
    setBusy(true); setMsg(null);
    try {
      // 1. Upload the photo only if the user picked one
      let photoUrl: string | undefined;
      if (photo) {
        const photoUpload = await api.upload(photo.file.name, photo.dataUrl);
        photoUrl = photoUpload.url;
      }
      // 2. Upload the supporting doc if present (optional)
      let docUrl: string | undefined;
      if (doc) {
        const docUpload = await api.upload(doc.file.name, doc.dataUrl);
        docUrl = docUpload.url;
      }
      // 3. Register the case
      const itemSubFinal = itemSub.trim()
        ? `${quantity} unit${quantity === '1' ? '' : 's'} · ${itemSub.trim()}`
        : `${quantity} unit${quantity === '1' ? '' : 's'}`;
      await api.createCase({
        firOrDd: firOrDd.trim(),
        itemType: itemType.trim(),
        itemSub:  itemSubFinal,
        section,
        seizingOfficer: seizingOfficer.trim(),
        seizedOn,
        photo: photoUrl,
        supportingDoc: docUrl,
      });
      setMsg({ kind: 'ok', text: `Registered ${firOrDd} — evidence tag generated. Status: Seized.` });
      onCreated();
      setTimeout(() => { reset(); onClose(); }, 1100);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <form className="form-card" onSubmit={submit}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Register New Case Property</h3>
        <div className="sub">
          On registration the status is set to <b>Seized</b>. Move it to Malkhana,
          FSL, Court, etc. through the Movements module.
        </div>

        <div className="form-grid">
          <label className="full">
            FIR / DD No.
            <input value={firOrDd} onChange={e => setFirOrDd(e.target.value)} placeholder="e.g. FIR 245/2026 or DD 12/2026" required />
          </label>
          <label className="full">
            Item type
            <input value={itemType} onChange={e => setItemType(e.target.value)} placeholder="e.g. Country-made pistol, Heroin packet" required />
          </label>
          <label>
            Quantity
            <input type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} required />
          </label>
          <label>
            Section (Rack)
            <select value={section} onChange={e => setSection(e.target.value)}>
              {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
            </select>
          </label>
          <label className="full">
            Description
            <textarea value={itemSub} onChange={e => setItemSub(e.target.value)} placeholder="e.g. 1 unit, with 2 live cartridges (auto-prefixed with quantity)" />
          </label>
          <label>
            Seized on
            <input type="date" value={seizedOn} max={today} onChange={e => setSeizedOn(e.target.value)} required />
          </label>
          <label>
            Seizing officer
            <input value={seizingOfficer} onChange={e => setOfficer(e.target.value)} required />
          </label>

          <label className="full">
            Photo of the seized object (OPTIONAL)
            <div className="file-field">
              {photo
                ? <img className="file-thumb" src={photo.dataUrl} alt="" />
                : <div className="file-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--slate-soft)' }}>📷</div>}
              <input ref={photoRef} type="file" accept="image/*" onChange={onPickPhoto} disabled={busy} />
              {photo
                ? <>
                    <div className="file-info"><b>{photo.file.name}</b> · {humanSize(photo.file.size)}</div>
                    <button type="button" className="file-remove" onClick={() => setPhoto(null)} disabled={busy}>remove</button>
                  </>
                : <div className="file-info">Click to choose a photo (JPG / PNG). <b>Skip this and the case is still registered — no placeholder image is created for new entries.</b></div>}
            </div>
          </label>

          <label className="full">
            Supporting document — seizure memo, FIR copy, etc. (OPTIONAL)
            <div className="file-field">
              {doc
                ? <img className="file-thumb" src={doc.dataUrl.startsWith('data:image') ? doc.dataUrl : ''} alt="" />
                : <div className="file-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--slate-soft)' }}>📄</div>}
              <input ref={docRef} type="file" accept="image/*,application/pdf" onChange={onPickDoc} disabled={busy} />
              {doc
                ? <>
                    <div className="file-info"><b>{doc.file.name}</b> · {humanSize(doc.file.size)}</div>
                    <button type="button" className="file-remove" onClick={() => setDoc(null)} disabled={busy}>remove</button>
                  </>
                : <div className="file-info">Click to attach a PDF or image of the supporting document</div>}
            </div>
          </label>
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !firOrDd.trim() || !itemType.trim()}>
            {busy ? 'Saving…' : 'Register & Generate Tag'}
          </button>
        </div>
      </form>
    </div>
  );
}
