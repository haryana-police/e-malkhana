import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RackItem, BnsSection } from '../types';
import { ITEM_CATEGORIES, getCategory, type ItemCategory, type CategoryField } from '../categories';

interface Props {
  open: boolean;
  racks: RackItem[];
  onClose: () => void;
  onCreated: () => void;
}

interface PendingFile {
  file: File;
  dataUrl: string;
}

// One item in the multi-item list (before submit).
interface DraftItem {
  localId: string;
  categoryId: string;       // 10-category id
  subType: string;          // inner type dropdown value
  sectionLetter: string;    // Malkhana Part placement (auto from category, editable)
  // per-category sub-parameter values
  catValues: Record<string, string>;
  // common-overridable fields for THIS item
  seizedOn: string;
  seizingOfficer: string;
  quantity: string;
  placeOfSeizure: string;
  physicalStorage: string;
  remarks: string;
  photo: PendingFile | null;
  // seal block
  sealSealed: string;       // Yes / No
  sealNo: string;
  sealBy: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

let _localSeq = 0;
function newLocalId() { return `li_${Date.now()}_${_localSeq++}`; }

export function RegisterCaseModal({ open, racks, onClose, onCreated }: Props) {
  const today = new Date().toISOString().slice(0, 10);

  // ---------- record type + FIR/DD master ----------
  const [recordType, setRecordType] = useState<'FIR' | 'DD'>('FIR');
  const [firNo, setFirNo] = useState('');
  const [firChecking, setFirChecking] = useState(false);
  const [firExists, setFirExists] = useState<boolean | null>(null);
  const [firLoaded, setFirLoaded] = useState(false); // master already loaded once for this no.
  const [policeStation, setPoliceStation] = useState('');
  const [firDate, setFirDate] = useState(today);
  const [usSections, setUsSections] = useState('');
  const [io, setIo] = useState('');
  // DD-specific
  const [ddDate, setDdDate] = useState(today);
  const [natureOfDd, setNatureOfDd] = useState('');
  const [nameOfDeceased, setNameOfDeceased] = useState('');
  const [reportingPerson, setReportingPerson] = useState('');

  // ---------- BNS legal sections (multi) ----------
  const [bnsQuery, setBnsQuery] = useState('');
  const [bnsHits, setBnsHits] = useState<BnsSection[]>([]);
  const [bnsOpen, setBnsOpen] = useState(false);
  const [bnsLoading, setBnsLoading] = useState(false);
  const [bnsActive, setBnsActive] = useState<number>(-1);
  const [legalSections, setLegalSections] = useState<BnsSection[]>([]);
  const bnsBoxRef = useRef<HTMLLabelElement>(null);

  // ---------- common block (entered once, copied to every item) ----------
  const [seizedTime, setSeizedTime] = useState('10:00');
  const [witness1, setWitness1] = useState('');
  const [witness2, setWitness2] = useState('');
  const [dateOfReceipt, setDateOfReceipt] = useState(today);
  const [receivedBy, setReceivedBy] = useState('');        // Malkhana Moharrir
  const [malkhanaLocation, setMalkhanaLocation] = useState('');

  // ---------- multi-item list ----------
  const [items, setItems] = useState<DraftItem[]>([]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null); setFirExists(null); setFirLoaded(false);
  }, [open]);

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
    setRecordType('FIR'); setFirNo(''); setFirExists(null); setFirLoaded(false);
    setPoliceStation(''); setFirDate(today); setUsSections(''); setIo('');
    setDdDate(today); setNatureOfDd(''); setNameOfDeceased(''); setReportingPerson('');
    setBnsQuery(''); setLegalSections([]);
    setSeizedTime('10:00'); setWitness1(''); setWitness2('');
    setDateOfReceipt(today); setReceivedBy(''); setMalkhanaLocation('');
    setItems([]); setMsg(null);
  }

  // ---------- FIR/DD lookup ----------
  async function checkFir() {
    const no = firNo.trim();
    const prefix = recordType === 'DD' ? 'DD ' : 'FIR ';
    const full = no.startsWith(prefix) ? no : `${prefix}${no}`;
    if (!no) { setMsg({ kind: 'error', text: 'Enter a FIR/DD number first.' }); return; }
    setFirChecking(true); setMsg(null);
    try {
      const fir = await api.firMaster(full);
      setFirExists(true); setFirLoaded(true);
      setRecordType(fir.recordType || recordType);
      setPoliceStation(fir.policeStation || '');
      setFirDate(fir.firDate || today); setUsSections(fir.usSections || ''); setIo(fir.io || '');
      setDdDate(fir.ddDate || today); setNatureOfDd(fir.natureOfDd || '');
      setNameOfDeceased(fir.nameOfDeceased || ''); setReportingPerson(fir.reportingPerson || '');
      setMsg({ kind: 'ok', text: `${full} already on file — details loaded. You can still edit them.` });
    } catch {
      setFirExists(false); setFirLoaded(false);
      setMsg({ kind: 'ok', text: `New ${full} — please fill the ${recordType === 'DD' ? 'DD' : 'FIR'} details below.` });
    } finally {
      setFirChecking(false);
    }
  }

  function addBns(s: BnsSection) {
    setLegalSections(prev => prev.find(x => x.sectionNo === s.sectionNo) ? prev : [...prev, s]);
    setBnsQuery(''); setBnsOpen(true); setBnsActive(-1);
  }
  function removeBns(no: string) { setLegalSections(prev => prev.filter(x => x.sectionNo !== no)); }
  function onBnsKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setBnsOpen(true); setBnsActive(i => Math.min(i + 1, bnsHits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setBnsActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      if (bnsOpen && bnsActive >= 0 && bnsHits[bnsActive]) { e.preventDefault(); addBns(bnsHits[bnsActive]); }
      else if (bnsHits.length === 1) { e.preventDefault(); addBns(bnsHits[0]); }
    } else if (e.key === 'Escape') setBnsOpen(false);
  }

  // ---------- item list helpers ----------
  function addItem() {
    setItems(prev => [...prev, {
      localId: newLocalId(),
      categoryId: '', subType: '', sectionLetter: racks[0]?.letter ?? 'A',
      catValues: {}, seizedOn: today, seizingOfficer: 'SI Rakesh Sharma',
      quantity: '1', placeOfSeizure: '', physicalStorage: '', remarks: '',
      photo: null, sealSealed: 'Yes', sealNo: '', sealBy: '',
    }]);
  }
  function removeItem(localId: string) {
    setItems(prev => prev.filter(it => it.localId !== localId));
  }
  function patchItem(localId: string, patch: Partial<DraftItem>) {
    setItems(prev => prev.map(it => it.localId === localId ? { ...it, ...patch } : it));
  }
  function onPickItemPhoto(localId: string, e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    fileToDataUrl(f).then(d => patchItem(localId, { photo: { file: f, dataUrl: d } }))
      .catch(() => setMsg({ kind: 'error', text: 'Failed to read the photo file.' }));
  }
  function renderCatField(localId: string, it: DraftItem, f: CategoryField) {
    const v = it.catValues[f.key] ?? '';
    const set = (val: string) => patchItem(localId, { catValues: { ...it.catValues, [f.key]: val } });
    if (f.type === 'select') {
      return (<select value={v} onChange={e => set(e.target.value)}><option value="">— select —</option>{(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}</select>);
    }
    if (f.type === 'number') return <input type="number" value={v} placeholder={f.placeholder} onChange={e => set(e.target.value)} />;
    if (f.type === 'date') return <input type="date" value={v} onChange={e => set(e.target.value)} />;
    if (f.type === 'time') return <input type="time" value={v} onChange={e => set(e.target.value)} />;
    return <input type="text" value={v} placeholder={f.placeholder} onChange={e => set(e.target.value)} />;
  }

  const prefix = recordType === 'DD' ? 'DD ' : 'FIR ';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const no = firNo.trim();
    if (!no) { setMsg({ kind: 'error', text: 'FIR/DD number is required.' }); return; }
    if (items.length === 0) { setMsg({ kind: 'error', text: 'Add at least one item.' }); return; }
    for (const it of items) {
      if (!it.categoryId) { setMsg({ kind: 'error', text: 'Every item needs a Category of Item.' }); return; }
    }
    const fullNo = no.startsWith(prefix) ? no : `${prefix}${no}`;
    setBusy(true); setMsg(null);
    try {
      const res = await api.createCaseBatch({
        firOrDd: fullNo,
        firNo: fullNo,
        recordType,
        policeStation, firDate: recordType === 'FIR' ? firDate : null,
        usSections, io,
        ddDate: recordType === 'DD' ? ddDate : null,
        natureOfDd: recordType === 'DD' ? natureOfDd : null,
        nameOfDeceased: recordType === 'DD' && natureOfDd === 'UD Case (Unnatural Death)' ? nameOfDeceased : null,
        reportingPerson: recordType === 'DD' && (natureOfDd === 'Lost Property Report' || natureOfDd === 'Other Miscellaneous Entry') ? reportingPerson : null,
        common: {
          seizedTime, witness1, witness2,
          dateOfReceipt, receivedBy, malkhanaLocation,
          legalSections: legalSections.map(s => s.sectionNo),
          seizingOfficer: items[0]?.seizingOfficer || 'SI Rakesh Sharma',
          seizedOn: items[0]?.seizedOn || today,
        },
        items: items.map(it => {
          const cat = getCategory(it.categoryId);
          const itemFields: { key: string; value: string }[] = [];
          if (cat?.subTypes && it.subType) itemFields.push({ key: 'sub_type', value: it.subType });
          for (const f of cat?.fields || []) {
            const val = it.catValues[f.key];
            if (val != null && val !== '') itemFields.push({ key: f.key, value: val });
          }
          return {
            itemType: (cat?.subTypes && it.subType) ? `${cat.label} — ${it.subType}` : (cat?.label || 'Article'),
            sectionLetter: it.sectionLetter,
            category: it.categoryId,
            subType: it.subType,
            malkhanaSection: it.sectionLetter,
            legalSections: legalSections.map(s => s.sectionNo),
            seizedOn: it.seizedOn,
            seizingOfficer: it.seizingOfficer,
            quantity: it.quantity,
            placeOfSeizure: it.placeOfSeizure,
            physicalStorage: it.physicalStorage,
            remarks: it.remarks,
            photo: it.photo?.dataUrl,
            status: 'Seized',
            sealSealed: it.sealSealed,
            sealNo: it.sealNo,
            sealBy: it.sealBy,
            popupFields: itemFields,
          };
        }),
      });
      const ids = res.items.map(i => i.itemId).join(', ');
      setMsg({ kind: 'ok', text: `Registered ${res.items.length} item(s) under ${fullNo}. Sr. No(s): ${ids}. Status: Seized.` });
      onCreated();
      setTimeout(() => { reset(); onClose(); }, 1200);
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => { if (e.target === e.currentTarget && !busy) { reset(); onClose(); } }}>
      <form className="form-card" onSubmit={submit} style={{ maxWidth: 760 }}>
        <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>
        <h3>Register New Case Property</h3>
        <div className="sub">
          Choose <b>FIR</b> or <b>DD</b>, fill the {recordType === 'DD' ? 'DD' : 'FIR'} details and BNS <b>Sections</b> (multiple allowed),
          then <b>Add Item</b> for each seized article — every item gets its own unique <b>Malkhana Sr. No.</b> and QR,
          status starts as <b>Seized</b>.
        </div>

        <div className="form-grid">
          {/* ---- Record type + FIR/DD no ---- */}
          <label>
            Record Type
            <select value={recordType} onChange={e => { setRecordType(e.target.value as 'FIR' | 'DD'); setFirExists(null); setFirLoaded(false); }}>
              <option value="FIR">FIR</option>
              <option value="DD">DD (Daily Diary)</option>
            </select>
          </label>
          <label className="full">
            {recordType === 'DD' ? 'DD No.' : 'FIR No.'}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={firNo}
                onChange={e => { setFirNo(e.target.value); setFirExists(null); setFirLoaded(false); }}
                placeholder={recordType === 'DD' ? 'e.g. DD 12/2026' : 'e.g. FIR 245/2026'}
                required
              />
              <button type="button" className="btn ghost" onClick={checkFir} disabled={busy || firChecking}>
                {firChecking ? '…' : 'Lookup'}
              </button>
            </div>
          </label>

          {/* ---- FIR master fields ---- */}
          {recordType === 'FIR' ? (
            <>
              <label className="full">Police Station
                <input value={policeStation} onChange={e => setPoliceStation(e.target.value)} placeholder="e.g. PS Sadar, Panipat" />
              </label>
              <label>FIR Date
                <input type="date" value={firDate} max={today} onChange={e => setFirDate(e.target.value)} />
              </label>
              <label>U/S (Sections)
                <input value={usSections} onChange={e => setUsSections(e.target.value)} placeholder="e.g. NDPS 21, 22 / BNS 101" />
              </label>
              <label className="full">Investigating Officer
                <input value={io} onChange={e => setIo(e.target.value)} placeholder="e.g. SI Rakesh Sharma" />
              </label>
            </>
          ) : (
            <>
              <label>DD Date
                <input type="date" value={ddDate} max={today} onChange={e => setDdDate(e.target.value)} />
              </label>
              <label>Nature of DD
                <select value={natureOfDd} onChange={e => setNatureOfDd(e.target.value)}>
                  <option value="">— select —</option>
                  <option value="UD Case (Unnatural Death)">UD Case (Unnatural Death)</option>
                  <option value="Lost Property Report">Lost Property Report</option>
                  <option value="Other Miscellaneous Entry">Other Miscellaneous Entry</option>
                </select>
              </label>
              {natureOfDd === 'UD Case (Unnatural Death)' && (
                <label className="full">Name of Deceased
                  <input value={nameOfDeceased} onChange={e => setNameOfDeceased(e.target.value)} placeholder="Name of deceased" />
                </label>
              )}
              {(natureOfDd === 'Lost Property Report' || natureOfDd === 'Other Miscellaneous Entry') && (
                <label className="full">Reporting Person Name &amp; Address
                  <input value={reportingPerson} onChange={e => setReportingPerson(e.target.value)} placeholder="Name & address of reporter" />
                </label>
              )}
            </>
          )}

          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          {/* ---- BNS sections (multi) ---- */}
          <label className="full" ref={bnsBoxRef}>
            Section (U/S legal section) — multiple allowed
            <div className="bns-typeahead">
              <input
                value={bnsQuery}
                placeholder={legalSections.length ? 'Add another section…' : 'Type 101, "murder", "kidnapping"... (BNS, 2023)'}
                onChange={e => { setBnsQuery(e.target.value); setBnsOpen(true); }}
                onFocus={() => setBnsOpen(true)}
                onKeyDown={onBnsKeyDown}
                autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded={bnsOpen} aria-autocomplete="list" aria-controls="bns-hits"
              />
              {bnsOpen && (
                <div className="bns-hits" id="bns-hits" role="listbox">
                  {bnsLoading && bnsHits.length === 0 && <div className="bns-empty">searching…</div>}
                  {!bnsLoading && bnsHits.length === 0 && <div className="bns-empty">No BNS section matches “{bnsQuery || '…'}”.</div>}
                  {bnsHits.map((s, i) => {
                    const picked = legalSections.some(x => x.sectionNo === s.sectionNo);
                    return (
                      <div key={s.sectionNo} role="option" aria-selected={i === bnsActive}
                        className={`bns-hit${i === bnsActive ? ' active' : ''}${picked ? ' picked' : ''}`}
                        onMouseDown={(e) => { e.preventDefault(); if (!picked) addBns(s); }}
                        onMouseEnter={() => setBnsActive(i)} title={s.description || s.title}>
                        <span className="bns-no">BNS&nbsp;{s.sectionNo}</span>
                        <span className="bns-title">{s.title}</span>
                        {s.category && <span className="bns-cat">{s.category}</span>}
                        {picked && <span className="bns-tick">✓</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {legalSections.length > 0 && (
              <div className="bns-chips">
                {legalSections.map(s => (
                  <span key={s.sectionNo} className="bns-chip">
                    <b>BNS {s.sectionNo}</b> — {s.title}
                    <button type="button" className="bns-chip-x" onClick={() => removeBns(s.sectionNo)} aria-label={`Remove BNS ${s.sectionNo}`}>×</button>
                  </span>
                ))}
              </div>
            )}
          </label>

          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          {/* ---- common block (once) ---- */}
          <label>FIR/DD Date of Receipt in Malkhana
            <input type="date" value={dateOfReceipt} max={today} onChange={e => setDateOfReceipt(e.target.value)} required />
          </label>
          <label>Received By (Malkhana Moharrir)
            <input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} placeholder="Moharrir name" required />
          </label>
          <label className="full">Malkhana Location
            <input value={malkhanaLocation} onChange={e => setMalkhanaLocation(e.target.value)} placeholder="e.g. Part A Shelf 2 / Almirah 1" />
          </label>
          <label>Seized On
            <input type="date" value={items[0]?.seizedOn || today} onChange={e => setItems(prev => prev.map((it, i) => i === 0 ? { ...it, seizedOn: e.target.value } : it))} required />
          </label>
          <label>Seized Time
            <input type="time" value={seizedTime} onChange={e => setSeizedTime(e.target.value)} required />
          </label>
          <label className="full">Seizing Officer
            <input value={items[0]?.seizingOfficer || 'SI Rakesh Sharma'} onChange={e => setItems(prev => prev.map((it, i) => i === 0 ? { ...it, seizingOfficer: e.target.value } : it))} required />
          </label>
          <label>Witness 1
            <input value={witness1} onChange={e => setWitness1(e.target.value)} />
          </label>
          <label>Witness 2
            <input value={witness2} onChange={e => setWitness2(e.target.value)} />
          </label>

          <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          {/* ---- multi-item list ---- */}
          <label className="full" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700 }}>Seized Items ({items.length})</span>
            <button type="button" className="btn" onClick={addItem} disabled={busy}>+ Add Item</button>
          </label>

          {items.length === 0 && (
            <div className="sub" style={{ padding: 12 }}>No items yet — click “+ Add Item” to add each seized article.</div>
          )}

          {items.map((it, idx) => {
            const cat = getCategory(it.categoryId);
            return (
              <div key={it.localId} className="item-block" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <b>Item {idx + 1}</b>
                  <button type="button" className="bns-chip-x" onClick={() => removeItem(it.localId)} aria-label="Remove item">✕ remove</button>
                </div>
                <div className="form-grid">
                  <label>Category of Item
                    <select value={it.categoryId} onChange={e => {
                      const c = getCategory(e.target.value);
                      patchItem(it.localId, { categoryId: e.target.value, subType: '', sectionLetter: c?.sectionLetter || it.sectionLetter, catValues: {} });
                    }} required>
                      <option value="">— select category —</option>
                      {ITEM_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </label>
                  {cat?.subTypes && (
                    <label>{cat.subTypeLabel || 'Type'}
                      <select value={it.subType} onChange={e => patchItem(it.localId, { subType: e.target.value })}>
                        <option value="">— select —</option>
                        {cat.subTypes.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </label>
                  )}
                  <label>Malkhana Section (placement)
                    <select value={it.sectionLetter} onChange={e => patchItem(it.localId, { sectionLetter: e.target.value })}>
                      {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
                    </select>
                  </label>
                  <label>Quantity
                    <input value={it.quantity} onChange={e => patchItem(it.localId, { quantity: e.target.value })} placeholder="e.g. 1 or 2 kg" />
                  </label>

                  {/* per-category sub-parameters */}
                  {cat?.fields.map(f => (
                    <label key={f.key}>
                      {f.label}{f.unit ? ` (${f.unit})` : ''}
                      {renderCatField(it.localId, it, f)}
                    </label>
                  ))}

                  <label className="full">Item Description (detailed — brand, colour, size, marks)
                    <textarea value={it.remarks} onChange={e => patchItem(it.localId, { remarks: e.target.value })} placeholder="Detailed description" />
                  </label>
                  <label>Place of Seizure
                    <input value={it.placeOfSeizure} onChange={e => patchItem(it.localId, { placeOfSeizure: e.target.value })} placeholder="e.g. Near bus stand" />
                  </label>
                  <label>Storage Location (Rack/Almirah/Yard)
                    <input value={it.physicalStorage} onChange={e => patchItem(it.localId, { physicalStorage: e.target.value })} placeholder="e.g. Almirah No. 2" />
                  </label>

                  <hr style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', margin: '4px 0' }} />

                  {/* seal block */}
                  <label>Sealed / Unsealed
                    <select value={it.sealSealed} onChange={e => patchItem(it.localId, { sealSealed: e.target.value })}>
                      <option value="Yes">Sealed</option>
                      <option value="No">Unsealed</option>
                    </select>
                  </label>
                  <label>Seal No. / Mark
                    <input value={it.sealNo} onChange={e => patchItem(it.localId, { sealNo: e.target.value })} placeholder="Seal no. / mark" />
                  </label>
                  <label className="full">Sealed By (Officer)
                    <input value={it.sealBy} onChange={e => patchItem(it.localId, { sealBy: e.target.value })} placeholder="Officer name" />
                  </label>
                  <label className="full">Photo of the seized object (optional)
                    <div className="file-field">
                      <input type="file" accept="image/*" onChange={e => onPickItemPhoto(it.localId, e)} disabled={busy} />
                      {it.photo && <span className="file-info">{it.photo.file.name}</span>}
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</button>
          <button type="submit" className="btn" disabled={busy || !firNo.trim() || items.length === 0}>
            {busy ? 'Saving…' : `Register ${items.length || ''} Item(s) & Generate Tags`}
          </button>
        </div>
      </form>
    </div>
  );
}
