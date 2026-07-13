import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RackItem, BnsSection, ItemType } from '../types';

// Controlled-vocabulary option for the Item Type dropdown in this modal.
interface ItemTypeOption { id: number; name: string; }

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

// Selected BNS section the user picked from the typeahead.  We keep the
// section number + title in a single object so the form's submit handler
// can send the canonical number without re-fetching.
interface BnsPick {
  sectionNo: string;
  title: string;
  category?: string;
}

export function RegisterCaseModal({ open, racks, onClose, onCreated }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [firOrDd, setFirOrDd]        = useState('FIR ');
  const [itemTypeId, setItemTypeId]  = useState<number | null>(null);
  const [itemTypeName, setItemTypeName] = useState('');   // mirrored free-text fallback label
  const [description, setDescription] = useState('');       // "80 grams, sealed poly bag"
  const [quantity, setQuantity]      = useState('1');
  // "Location (Rack)" — the physical storage rack the item is being
  // placed in.  Was called "Section (Rack)" in the previous UI; renamed
  // because "Section" is now reserved for the BNS legal-section field
  // (see legalSection state below).
  const [location, setLocation]      = useState(racks[0]?.letter ?? 'A');
  const [seizingOfficer, setOfficer] = useState('SI Rakesh Sharma');
  const [seizedOn, setSeizedOn]      = useState(today);
  const [photo, setPhoto]            = useState<PendingFile | null>(null);
  const [doc, setDoc]                = useState<PendingFile | null>(null);
  const [busy, setBusy]              = useState(false);
  const [msg, setMsg]                = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Item Types for the chosen section.  Loaded from /api/item-types
  // (active only) and refreshed whenever the section changes or the
  // modal re-opens.  This is the controlled vocabulary that replaces
  // free-text item type entry.
  const [typeOptions, setTypeOptions] = useState<ItemTypeOption[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);

  // Load the item-type list for the currently-selected section.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTypesLoading(true);
    api.itemTypes(location).then(rows => {
      if (!cancelled) {
        setTypeOptions(rows.map(r => ({ id: r.id, name: r.name })));
        setTypesLoading(false);
      }
    }).catch(() => { if (!cancelled) { setTypeOptions([]); setTypesLoading(false); } });
    return () => { cancelled = true; };
  }, [open, location]);

  // BNS (Bharatiya Nyaya Sanhita, 2023) legal-section typeahead.  The
  // user types "302" or "murder" and picks one of the 100 BNS sections
  // from the bns_sections table on the server.  We debounce 200ms to
  // avoid hammering the API; store both the picked object and the
  // visible query text so the user can edit the query to change the
  // pick (which then resets the pick).
  const [bnsQuery, setBnsQuery]      = useState('');
  const [bnsPick, setBnsPick]        = useState<BnsPick | null>(null);
  const [bnsHits, setBnsHits]        = useState<BnsSection[]>([]);
  const [bnsOpen, setBnsOpen]        = useState(false);
  const [bnsLoading, setBnsLoading]  = useState(false);
  const [bnsActive, setBnsActive]    = useState<number>(-1);  // keyboard nav
  const bnsBoxRef                    = useRef<HTMLLabelElement>(null);

  const photoRef = useRef<HTMLInputElement>(null);
  const docRef   = useRef<HTMLInputElement>(null);

  // Debounced BNS typeahead.  Empty query returns the first 15 (so the
  // dropdown has content the moment the field is focused).  Cancellable
  // via a token so a fast-typing user doesn't see stale results land.
  useEffect(() => {
    if (!bnsOpen) return;
    let cancelled = false;
    setBnsLoading(true);
    const timer = setTimeout(() => {
      api.bnsSections(bnsQuery, 15)
        .then(rows => { if (!cancelled) { setBnsHits(rows); setBnsActive(rows.length ? 0 : -1); } })
        .catch(() => { if (!cancelled) setBnsHits([]); })
        .finally(() => { if (!cancelled) setBnsLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bnsQuery, bnsOpen]);

  // Click-outside closes the typeahead dropdown.
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

  function reset() {
    setFirOrDd('FIR '); setItemTypeId(null); setItemTypeName('');
    setDescription(''); setQuantity('1');
    setLocation(racks[0]?.letter ?? 'A'); setOfficer('SI Rakesh Sharma');
    setSeizedOn(today); setPhoto(null); setDoc(null); setMsg(null);
    setTypeOptions([]);
  }

  function pickBns(s: BnsSection) {
    setBnsPick({ sectionNo: s.sectionNo, title: s.title, category: s.category });
    setBnsQuery(`BNS ${s.sectionNo} — ${s.title}`);
    setBnsOpen(false);
    setBnsActive(-1);
  }

  function clearBns() {
    setBnsPick(null);
    setBnsQuery('');
    setBnsOpen(true);
    setBnsActive(-1);
  }

  function onBnsKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setBnsOpen(true);
      setBnsActive(i => Math.min(i + 1, bnsHits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setBnsActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (bnsOpen && bnsActive >= 0 && bnsHits[bnsActive]) {
        e.preventDefault();
        pickBns(bnsHits[bnsActive]);
      }
    } else if (e.key === 'Escape') {
      setBnsOpen(false);
    }
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
      // 3. Register the case.  itemTypeId (FK to item_types) +
      // description (free-text specifics) replace the old free-text
      // itemType/itemSub pair.  If the MM somehow has no type
      // options loaded yet (race), we fall back to sending the
      // mirrored name so the row still records something readable.
      await api.createCase({
        firOrDd: firOrDd.trim(),
        itemType: itemTypeName || (typeOptions.find(t => t.id === itemTypeId)?.name || ''),
        itemSub:  '',
        section:  location,                              // rack letter — was `section`
        seizingOfficer: seizingOfficer.trim(),
        seizedOn,
        photo: photoUrl,
        supportingDoc: docUrl,
        legalSection: bnsPick?.sectionNo,                // optional — validated server-side
        itemTypeId: itemTypeId ?? null,
        description: description.trim() || undefined,
      });
      const bnsPart = bnsPick ? ` — BNS ${bnsPick.sectionNo} (${bnsPick.title})` : '';
      setMsg({ kind: 'ok', text: `Registered ${firOrDd} — evidence tag generated. Status: Seized.${bnsPart}` });
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
            <select
              value={itemTypeId != null ? String(itemTypeId) : ''}
              onChange={e => {
                const v = e.target.value;
                if (!v) { setItemTypeId(null); setItemTypeName(''); return; }
                const id = Number(v);
                const opt = typeOptions.find(t => t.id === id);
                setItemTypeId(id);
                setItemTypeName(opt?.name || '');
              }}
              disabled={busy || typesLoading}
              title="Pick from the section's standardised item-type list (managed in System Settings)"
            >
              <option value="">— select item type —</option>
              {typeOptions.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {typesLoading && <div className="sub" style={{ marginTop: 4 }}>Loading item types…</div>}
          </label>

          <label className="full">
            Description (specifics)
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. 80 grams, sealed poly bag · 2 live cartridges"
            />
          </label>
          <label>
            {/* Renamed from "Section (Rack)" — the rack letter is the
                physical LOCATION the item is being stored in.  "Section"
                is now reserved for the BNS legal section below. */}
            Location
            <select value={location} onChange={e => setLocation(e.target.value)} title="Physical storage rack in the Malkhana room">
              {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
            </select>
          </label>

          {/* BNS (Bharatiya Nyaya Sanhita, 2023) legal-section field.  The
              user types a number ("101") or a word ("murder") and picks
              from the typeahead dropdown that searches the bns_sections
              table on the server.  OPTIONAL — cases can be registered
              without a BNS section, and the dropdown can be reopened to
              change the pick.  The clear (×) button appears only after
              a section has been picked. */}
          <label className="full" ref={bnsBoxRef}>
            Section
            <div className="bns-typeahead">
              <input
                value={bnsQuery}
                placeholder={bnsPick ? '' : 'Type 101, "murder", or "kidnapping"… (BNS, 2023)'}
                onChange={e => { setBnsQuery(e.target.value); setBnsPick(null); setBnsOpen(true); }}
                onFocus={() => { setBnsOpen(true); }}
                onKeyDown={onBnsKeyDown}
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded={bnsOpen}
                aria-autocomplete="list"
                aria-controls="bns-hits"
              />
              {bnsPick && (
                <button
                  type="button"
                  className="bns-clear"
                  onClick={clearBns}
                  title="Clear the BNS section"
                  aria-label="Clear BNS section"
                >×</button>
              )}
              {bnsOpen && (
                <div className="bns-hits" id="bns-hits" role="listbox">
                  {bnsLoading && bnsHits.length === 0 && (
                    <div className="bns-empty">searching…</div>
                  )}
                  {!bnsLoading && bnsHits.length === 0 && (
                    <div className="bns-empty">No BNS section matches “{bnsQuery || '…'}”.</div>
                  )}
                  {bnsHits.map((s, i) => (
                    <div
                      key={s.sectionNo}
                      role="option"
                      aria-selected={i === bnsActive}
                      className={`bns-hit${i === bnsActive ? ' active' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); pickBns(s); }}
                      onMouseEnter={() => setBnsActive(i)}
                      title={s.description || s.title}
                    >
                      <span className="bns-no">BNS&nbsp;{s.sectionNo}</span>
                      <span className="bns-title">{s.title}</span>
                      {s.category && <span className="bns-cat">{s.category}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {bnsPick && (
              <div className="bns-picked">
                ✓ <b>BNS {bnsPick.sectionNo}</b> — {bnsPick.title}
                {bnsPick.category && <> · <span className="muted">{bnsPick.category}</span></>}
              </div>
            )}
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
          <button type="submit" className="btn" disabled={busy || !firOrDd.trim() || itemTypeId == null}>
            {busy ? 'Saving…' : 'Register & Generate Tag'}
          </button>
        </div>
      </form>
    </div>
  );
}
