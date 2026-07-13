import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RackItem, BnsSection, ItemType, ItemTypeField, FirMaster } from '../types';

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

interface BnsPick { sectionNo: string; title: string; category?: string; }

// ---- Item Type -> section letter map (the spec's 5 categories) ----
// The "Item Type" dropdown is the standardised item_types master; each
// item type belongs to ONE Malkhana section (A–E).  Selecting an item type
// opens the popup whose fields are defined for that section.
export function RegisterCaseModal({ open, racks, onClose, onCreated }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [step, setStep] = useState<'form' | 'popup'>('form');

  // ---- FIR master section ----
  const [firOrDd, setFirOrDd]        = useState('FIR ');
  const [firChecking, setFirChecking] = useState(false);
  const [firExists, setFirExists]     = useState<boolean | null>(null);
  const [ps, setPs]                   = useState('');      // Police Station
  const [firDate, setFirDate]         = useState(today);
  const [usSections, setUs]           = useState('');      // U/S
  const [io, setIo]                   = useState('');      // Investigating Officer

  // ---- item type + popup data ----
  const [itemTypeId, setItemTypeId]  = useState<number | null>(null);
  const [itemTypeName, setItemTypeName] = useState('');
  const [sectionLetter, setSectionLetter] = useState<string>('A');
  const [popupFields, setPopupFields]     = useState<ItemTypeField[]>([]);
  const [popupValues, setPopupValues]     = useState<Record<string, string>>({});

  // ---- common fields ----
  const [seizedOn, setSeizedOn]       = useState(today);
  const [seizedTime, setSeizedTime]   = useState('10:00');
  const [seizingOfficer, setOfficer]  = useState('SI Rakesh Sharma');
  const [location, setLocation]       = useState(racks[0]?.letter ?? 'A');
  const [witness1, setWitness1]       = useState('');
  const [witness2, setWitness2]       = useState('');
  const [quantity, setQuantity]       = useState('1');
  const [storageLocation, setStorage] = useState('');
  const [remarks, setRemarks]         = useState('');
  const [photo, setPhoto]             = useState<PendingFile | null>(null);
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // type options + bns typeahead
  const [typeOptions, setTypeOptions] = useState<ItemTypeOption[]>([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [bnsQuery, setBnsQuery]      = useState('');
  const [bnsPick, setBnsPick]        = useState<BnsPick | null>(null);
  const [bnsHits, setBnsHits]         = useState<BnsSection[]>([]);
  const [bnsOpen, setBnsOpen]         = useState(false);
  const [bnsLoading, setBnsLoading]   = useState(false);
  const [bnsActive, setBnsActive]     = useState<number>(-1);
  const bnsBoxRef                     = useRef<HTMLLabelElement>(null);
  const photoRef                      = useRef<HTMLInputElement>(null);

  interface ItemTypeOption { id: number; name: string; sectionLetter: string; }

  useEffect(() => {
    if (!open) return;
    setMsg(null); setTypeOptions([]); setFirExists(null);
  }, [open]);

  // load item types for the chosen section/rack
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTypesLoading(true);
    api.itemTypes(location).then(rows => {
      if (!cancelled) {
        setTypeOptions(rows.map(r => ({ id: r.id, name: r.name, sectionLetter: r.sectionLetter })));
        setTypesLoading(false);
      }
    }).catch(() => { if (!cancelled) { setTypeOptions([]); setTypesLoading(false); } });
    return () => { cancelled = true; };
  }, [open, location]);

  // BNS typeahead
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

  useEffect(() => {
    if (!bnsOpen) return;
    function onDocClick(e: MouseEvent) {
      if (bnsBoxRef.current && !bnsBoxRef.current.contains(e.target as Node)) setBnsOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [bnsOpen]);

  function reset() {
    setStep('form');
    setFirOrDd('FIR '); setFirExists(null); setPs(''); setFirDate(today); setUs(''); setIo('');
    setItemTypeId(null); setItemTypeName(''); setSectionLetter('A');
    setPopupFields([]); setPopupValues({});
    setSeizedOn(today); setSeizedTime('10:00'); setOfficer('SI Rakesh Sharma');
    setLocation(racks[0]?.letter ?? 'A'); setWitness1(''); setWitness2('');
    setQuantity('1'); setStorage(''); setRemarks(''); setPhoto(null);
    setBnsQuery(''); setBnsPick(null); setTypeOptions([]); setMsg(null);
  }

  // ---- FIR lookup ----
  async function checkFir() {
    const no = firOrDd.trim();
    if (!no || no === 'FIR ') { setMsg({ kind: 'error', text: 'Enter a FIR/DD number first.' }); return; }
    setFirChecking(true); setMsg(null);
    try {
      const fir = await api.firMaster(no);
      setFirExists(true);
      setPs(fir.policeStation || '');
      setFirDate(fir.firDate || today);
      setUs(fir.usSections || '');
      setIo(fir.io || '');
      setMsg({ kind: 'ok', text: `FIR ${no} already on file — details loaded. You can still edit them.` });
    } catch {
      setFirExists(false);
      setMsg({ kind: 'ok', text: `New FIR ${no} — please fill the FIR details below.` });
    } finally {
      setFirChecking(false);
    }
  }

  function pickBns(s: BnsSection) {
    setBnsPick({ sectionNo: s.sectionNo, title: s.title, category: s.category });
    setBnsQuery(`BNS ${s.sectionNo} — ${s.title}`);
    setBnsOpen(false); setBnsActive(-1);
  }
  function clearBns() { setBnsPick(null); setBnsQuery(''); setBnsOpen(true); setBnsActive(-1); }
  function onBnsKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setBnsOpen(true); setBnsActive(i => Math.min(i + 1, bnsHits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setBnsActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { if (bnsOpen && bnsActive >= 0 && bnsHits[bnsActive]) { e.preventDefault(); pickBns(bnsHits[bnsActive]); } }
    else if (e.key === 'Escape') setBnsOpen(false);
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const dataUrl = await fileToDataUrl(f);
      setPhoto({ file: f, dataUrl, uploading: true });
    } catch { setMsg({ kind: 'error', text: 'Failed to read the photo file.' }); }
  }

  function humanSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ---- open the per-item-type popup ----
  async function openPopup() {
    if (itemTypeId == null) { setMsg({ kind: 'error', text: 'Select an Item Type first.' }); return; }
    const opt = typeOptions.find(t => t.id === itemTypeId);
    const letter = opt?.sectionLetter || sectionLetter;
    setSectionLetter(letter);
    try {
      const fields = await api.itemTypeFields(letter);
      setPopupFields(fields.filter(f => f.active !== false));
      // seed empty values for any new keys
      setPopupValues(prev => {
        const next = { ...prev };
        for (const f of fields) if (next[f.key] == null) next[f.key] = '';
        return next;
      });
      setStep('popup');
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  }

  function renderPopupField(f: ItemTypeField) {
    const v = popupValues[f.key] ?? '';
    const set = (val: string) => setPopupValues(p => ({ ...p, [f.key]: val }));
    if (f.fieldType === 'select') {
      return (
        <select value={v} onChange={e => set(e.target.value)}>
          <option value="">— select —</option>
          {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    if (f.fieldType === 'number') return <input type="number" value={v} onChange={e => set(e.target.value)} />;
    if (f.fieldType === 'date')   return <input type="date" value={v} onChange={e => set(e.target.value)} />;
    if (f.fieldType === 'time')   return <input type="time" value={v} onChange={e => set(e.target.value)} />;
    return <input type="text" value={v} onChange={e => set(e.target.value)} />;
  }

  // ---- final submit ----
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const firNo = firOrDd.trim();
    if (!firNo || firNo === 'FIR ') { setMsg({ kind: 'error', text: 'FIR/DD number is required.' }); return; }
    if (itemTypeId == null) { setMsg({ kind: 'error', text: 'Item Type is required.' }); return; }
    setBusy(true); setMsg(null);
    try {
      // 1) Photo upload (optional)
      let photoUrl: string | undefined;
      if (photo && !photo.url) {
        const up = await api.upload(photo.file.name, photo.dataUrl);
        photoUrl = up.url;
      } else if (photo?.url) photoUrl = photo.url;

      // 2) Create the case row (auto-generates a unique Malkhana Sr. No. / QR on the server)
      const created: any = await api.createCase({
        firOrDd: firNo,
        firNo,
        itemType: itemTypeName || (typeOptions.find(t => t.id === itemTypeId)?.name || ''),
        section: sectionLetter,
        seizingOfficer: seizingOfficer.trim(),
        seizedOn,
        photo: photoUrl,
        legalSection: bnsPick?.sectionNo,
        itemTypeId: itemTypeId ?? null,
        description: popupValues['substance_type'] || popupValues['weapon_type'] || popupValues['doc_type'] || popupValues['vehicle_type'] || popupValues['sample_type'] || '',
      });
      const itemId: string = created.itemId || created.id;

      // 3) Upsert FIR master (once per FIR; reused for every item)
      await api.upsertFirMaster({
        firNo, policeStation: ps, firDate, usSections: usSections, io,
      });

      // 4) Save case_property (COMMON fields + type-specific popup values)
      const common: Record<string, string> = {
        seizedTime, witness1, witness2, quantity,
        storageLocation, photoUrl: photoUrl || '', remarks,
        status: 'Seized',
      };
      const fields = popupFields
        .filter(f => f.active !== false)
        .map(f => ({ key: f.key, value: popupValues[f.key] ?? '' }));
      await api.saveCaseProperty({ itemId, firNo, common, fields });

      setMsg({ kind: 'ok', text: `Registered ${firNo} — Malkhana Sr. No. ${itemId} generated. Status: Seized.` });
      onCreated();
      setTimeout(() => { reset(); onClose(); }, 1100);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // ---- POPUP VIEW ----
  if (step === 'popup') {
    return (
      <div className={`overlay${open ? ' open' : ''}`} onClick={e => { if (e.target === e.currentTarget && !busy) { setStep('form'); } }}>
        <form className="form-card" onSubmit={(e) => { e.preventDefault(); setStep('form'); }} style={{ maxWidth: 560 }}>
          <button type="button" className="tag-close" onClick={() => { setStep('form'); }} aria-label="Close">✕</button>
          <h3>{itemTypeName || 'Item'} — Specific Details</h3>
          <div className="sub">Fill the fields for this item type. These are saved with the seizure.</div>
          <div className="form-grid">
            {popupFields.length === 0 && (
              <div className="sub" style={{ padding: 12 }}>No specific fields defined for this item type.</div>
            )}
            {popupFields.map(f => (
              <label key={f.id} className="full">
                {f.label}
                {renderPopupField(f)}
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button type="button" className="btn ghost" onClick={() => setStep('form')} disabled={busy}>← Back</button>
            <button type="submit" className="btn" disabled={busy}>Done</button>
          </div>
        </form>
      </div>
    );
  }

  // ---- MAIN FORM VIEW ----
  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => {
      if (e.target === e.currentTarget && !busy) { reset(); onClose(); }
    }}>
      <form className="form-card" onSubmit={submit}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Register New Case Property</h3>
        <div className="sub">
          Enter the FIR/DD, then pick an Item Type to capture its specific details in a popup.
          On registration a unique <b>Malkhana Sr. No.</b> and QR code are auto-generated and status is set to <b>Seized</b>.
        </div>

        <div className="form-grid">
          {/* ---- FIR / DD no + lookup ---- */}
          <label className="full">
            FIR / DD No.
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={firOrDd}
                onChange={e => { setFirOrDd(e.target.value); setFirExists(null); }}
                placeholder="e.g. FIR 245/2026 or DD 12/2026"
                required
              />
              <button type="button" className="btn ghost" onClick={checkFir} disabled={busy || firChecking}>
                {firChecking ? '…' : 'Lookup'}
              </button>
            </div>
          </label>

          {/* ---- FIR master fields (shown once per FIR) ---- */}
          <label className="full">
            Police Station
            <input value={ps} onChange={e => setPs(e.target.value)} placeholder="e.g. PS Sadar, Panipat" />
          </label>
          <label>
            FIR Date
            <input type="date" value={firDate} max={today} onChange={e => setFirDate(e.target.value)} />
          </label>
          <label>
            U/S (Sections)
            <input value={usSections} onChange={e => setUs(e.target.value)} placeholder="e.g. NDPS 21, 22 / BNS 101" />
          </label>
          <label className="full">
            Investigating Officer
            <input value={io} onChange={e => setIo(e.target.value)} placeholder="e.g. SI Rakesh Sharma" />
          </label>

          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          {/* ---- Item Type (loads popup) ---- */}
          <label className="full">
            Item Type
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={itemTypeId != null ? String(itemTypeId) : ''}
                onChange={e => {
                  const v = e.target.value;
                  if (!v) { setItemTypeId(null); setItemTypeName(''); return; }
                  const id = Number(v);
                  const opt = typeOptions.find(t => t.id === id);
                  setItemTypeId(id);
                  setItemTypeName(opt?.name || '');
                  setSectionLetter(opt?.sectionLetter || location);
                }}
                disabled={busy || typesLoading}
                title="Pick an item type to open its specific-details popup"
              >
                <option value="">— select item type —</option>
                {typeOptions.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button type="button" className="btn" onClick={openPopup} disabled={busy || itemTypeId == null}>
                Open Specific Fields
              </button>
            </div>
            {typesLoading && <div className="sub" style={{ marginTop: 4 }}>Loading item types…</div>}
          </label>

          <label className="full">
            Storage Location (Rack/Almirah/Yard)
            <select value={location} onChange={e => setLocation(e.target.value)} title="Physical storage in the Malkhana room">
              {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
            </select>
          </label>

          {/* BNS section typeahead */}
          <label className="full" ref={bnsBoxRef}>
            Section (U/S legal section)
            <div className="bns-typeahead">
              <input
                value={bnsQuery}
                placeholder={bnsPick ? '' : 'Type 101, "murder", "kidnapping"… (BNS, 2023)'}
                onChange={e => { setBnsQuery(e.target.value); setBnsPick(null); setBnsOpen(true); }}
                onFocus={() => { setBnsOpen(true); }}
                onKeyDown={onBnsKeyDown}
                autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded={bnsOpen} aria-autocomplete="list" aria-controls="bns-hits"
              />
              {bnsPick && (
                <button type="button" className="bns-clear" onClick={clearBns} title="Clear the BNS section" aria-label="Clear BNS section">×</button>
              )}
              {bnsOpen && (
                <div className="bns-hits" id="bns-hits" role="listbox">
                  {bnsLoading && bnsHits.length === 0 && <div className="bns-empty">searching…</div>}
                  {!bnsLoading && bnsHits.length === 0 && <div className="bns-empty">No BNS section matches “{bnsQuery || '…'}”.</div>}
                  {bnsHits.map((s, i) => (
                    <div key={s.sectionNo} role="option" aria-selected={i === bnsActive}
                      className={`bns-hit${i === bnsActive ? ' active' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); pickBns(s); }}
                      onMouseEnter={() => setBnsActive(i)}
                      title={s.description || s.title}>
                      <span className="bns-no">BNS&nbsp;{s.sectionNo}</span>
                      <span className="bns-title">{s.title}</span>
                      {s.category && <span className="bns-cat">{s.category}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {bnsPick && (
              <div className="bns-picked">✓ <b>BNS {bnsPick.sectionNo}</b> — {bnsPick.title}{bnsPick.category && <> · <span className="muted">{bnsPick.category}</span></>}</div>
            )}
          </label>

          {/* ---- COMMON fields ---- */}
          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />
          <label>
            Seized On
            <input type="date" value={seizedOn} max={today} onChange={e => setSeizedOn(e.target.value)} required />
          </label>
          <label>
            Seized Time
            <input type="time" value={seizedTime} onChange={e => setSeizedTime(e.target.value)} required />
          </label>
          <label className="full">
            Seizing Officer
            <input value={seizingOfficer} onChange={e => setOfficer(e.target.value)} required />
          </label>
          <label className="full">
            Place of Seizure
            <input value={storageLocation} onChange={e => setStorage(e.target.value)} placeholder="e.g. Near bus stand, Panipat" />
          </label>
          <label>
            Witness 1 Name
            <input value={witness1} onChange={e => setWitness1(e.target.value)} />
          </label>
          <label>
            Witness 2 Name
            <input value={witness2} onChange={e => setWitness2(e.target.value)} />
          </label>
          <label>
            Quantity
            <input value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g. 1 or 2 kg" />
          </label>
          <label className="full">
            Photo of the seized object (OPTIONAL)
            <div className="file-field">
              {photo
                ? <img className="file-thumb" src={photo.dataUrl} alt="" />
                : <div className="file-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--slate-soft)' }}>📷</div>}
              <input ref={photoRef} type="file" accept="image/*" onChange={onPickPhoto} disabled={busy} />
              {photo
                ? <><div className="file-info"><b>{photo.file.name}</b> · {humanSize(photo.file.size)}</div>
                   <button type="button" className="file-remove" onClick={() => setPhoto(null)} disabled={busy}>remove</button></>
                : <div className="file-info">Click to choose a photo (JPG / PNG). Optional.</div>}
            </div>
          </label>
          <label className="full">
            Remarks
            <textarea value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Any remarks…" />
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
