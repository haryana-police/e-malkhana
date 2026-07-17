import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RackItem, BnsSection, User } from '../types';
import { ITEM_CATEGORIES, getCategory, classifyNdps, type ItemCategory, type CategoryField } from '../categories';

interface Props {
  open: boolean;
  racks: RackItem[];
  user?: User | null;
  onClose: () => void;
  onCreated: () => void;
  /** Render inline as a full page instead of a centered modal popup. */
  asPage?: boolean;
}

interface PendingFile {
  file: File;
  dataUrl: string;
}

// One item in the multi-item list (before submit).
interface DraftItem {
  localId: string;
  categoryId: string;
  subType: string;
  sectionLetter: string;
  catValues: Record<string, string>;
  seizedOn: string;
  seizingOfficer: string;
  quantity: string;
  placeOfSeizure: string;
  physicalStorage: string;
  remarks: string;
  photo: PendingFile | null;
  sealSealed: string;
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

// Demo MM name used as the investigating officer fallback (UI field removed
// per request — IO is captured from the signed-in MM automatically).
function defaultIo(user?: User | null) {
  return user?.name || user?.rank || 'SI (on duty)';
}

export function RegisterCaseModal({ open, racks, user, onClose, onCreated, asPage = false }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const station = user?.station || '';

  // ---------- step state (interactive wizard) ----------
  const [step, setStep] = useState<1 | 2>(1);

  // ---------- record type + FIR/DD master ----------
  const [recordType, setRecordType] = useState<'FIR' | 'DD'>('FIR');
  const [firNo, setFirNo] = useState('');
  const [ddNo, setDdNo] = useState('');            // secondary DD reference (optional)
  const [firChecking, setFirChecking] = useState(false);
  const [firExists, setFirExists] = useState<boolean | null>(null);
  const [firLoaded, setFirLoaded] = useState(false);
  const [firDate, setFirDate] = useState(today);
  // DD-specific
  const [ddDate, setDdDate] = useState(today);
  const [natureOfDd, setNatureOfDd] = useState('');
  const [nameOfDeceased, setNameOfDeceased] = useState('');
  const [reportingPerson, setReportingPerson] = useState('');
  // Actual seizure details — the DD under which the property was ACTUALLY seized
  const [actualSeizureDdNo, setActualSeizureDdNo] = useState('');
  const [actualSeizureDate, setActualSeizureDate] = useState('');

  // ---------- BNS legal sections (multi) ----------
  const [bnsQuery, setBnsQuery] = useState('');
  const [bnsHits, setBnsHits] = useState<BnsSection[]>([]);
  const [bnsOpen, setBnsOpen] = useState(false);
  const [bnsLoading, setBnsLoading] = useState(false);
  const [bnsActive, setBnsActive] = useState<number>(-1);
  const [legalSections, setLegalSections] = useState<BnsSection[]>([]);
  const bnsBoxRef = useRef<HTMLLabelElement>(null);

  // ---------- common block (once) ----------
  const [seizedTime, setSeizedTime] = useState('10:00');
  const [dateOfReceipt, setDateOfReceipt] = useState(today);
  const [receivedBy, setReceivedBy] = useState('');

  // ---------- multi-item list ----------
  const [items, setItems] = useState<DraftItem[]>([]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (!open && !asPage) return;
    setMsg(null); setErrors([]); setStep(1); setFirExists(null); setFirLoaded(false);
  }, [open, asPage]);

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
    setStep(1); setRecordType('FIR'); setFirNo(''); setDdNo(''); setFirExists(null); setFirLoaded(false);
    setFirDate(today); setDdDate(today); setNatureOfDd(''); setNameOfDeceased(''); setReportingPerson('');
    setActualSeizureDdNo(''); setActualSeizureDate('');
    setBnsQuery(''); setLegalSections([]);
    setSeizedTime('10:00'); setDateOfReceipt(today); setReceivedBy('');
    setItems([]); setMsg(null); setErrors([]);
  }

  // ---------- FIR/DD lookup (fetches existing data if present) ----------
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
      setFirDate(fir.firDate || today);
      setDdDate(fir.ddDate || today); setNatureOfDd(fir.natureOfDd || '');
      setNameOfDeceased(fir.nameOfDeceased || ''); setReportingPerson(fir.reportingPerson || '');
      setActualSeizureDdNo(fir.actualSeizureDdNo || ''); setActualSeizureDate(fir.actualSeizureDate || '');
      // The FIR's static details are now loaded — default the Malkhana
      // receipt block (this-registration info) so the user can jump
      // straight to item entry without step 1 blocking on empty required
      // fields.  Received-By defaults to the signed-in Moharrir.
      if (!receivedBy.trim()) setReceivedBy(defaultIo(user));
      // Auto-advance to Step 2 (Seized Items) — the FIR is already on file,
      // so there is nothing left to type in Step 1.  New (not-on-file) FIRs
      // stay on Step 1 so the MM can fill the details first.
      setStep(2);
      setMsg({ kind: 'ok', text: `${full} already on file — details loaded. Add the seized item(s) below.` });
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
      catValues: {}, seizedOn: today, seizingOfficer: defaultIo(user),
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

  // Live NDPS quantity classification badge (Small / Intermediate / Commercial)
  // shown when the item is a Narcotics article with a narcotic type + quantity.
  function renderNdpsClassBadge(it: DraftItem) {
    const cat = getCategory(it.categoryId);
    if (!cat || cat.id !== 'narcotics') return null;
    if (!it.subType) return null;
    const cls = classifyNdps(it.subType, it.catValues['quantity_seized'] || '');
    if (cls === 'Unknown') return null;
    const tone = cls === 'Small' ? 'small' : cls === 'Intermediate' ? 'inter' : 'comm';
    return (
      <div className="ndps-class-badge">
        <span className="ndps-class-label">NDPS Quantity Class</span>
        <span className={`ndps-class ndps-${tone}`}>{cls} Quantity</span>
        <span className="ndps-class-hint">(auto from NDPS table)</span>
      </div>
    );
  }

  const prefix = recordType === 'DD' ? 'DD ' : 'FIR ';

  // ---------- validation ----------
  function validateStep1(): string[] {
    const e: string[] = [];
    if (!firNo.trim()) e.push('FIR/DD number is required.');
    if (recordType === 'DD' && !natureOfDd) e.push('Select the Nature of DD.');
    if (recordType === 'DD' && natureOfDd === 'UD Case (UnnaturalDeath)' && !nameOfDeceased.trim())
      e.push('Name of Deceased is required for a UD case.');
    if (!dateOfReceipt) e.push('Date of Receipt in Malkhana is required.');
    if (!receivedBy.trim()) e.push('Received By (Malkhana Moharrir) is required.');
    if (!seizedTime) e.push('Seized Time is required.');
    return e;
  }
  function validateStep2(): string[] {
    const e: string[] = [];
    if (items.length === 0) e.push('Add at least one seized item.');
    items.forEach((it, i) => {
      if (!it.categoryId) e.push(`Item ${i + 1}: choose a Category of Item.`);
      if (!it.seizedOn) e.push(`Item ${i + 1}: Seized On date is required.`);
      if (!it.seizingOfficer.trim()) e.push(`Item ${i + 1}: Seizing Officer is required.`);
      if (it.categoryId !== 'narcotics' && it.sealSealed === 'Yes' && !it.sealNo.trim()) e.push(`Item ${i + 1}: enter the Seal No. / Mark.`);
      // Arms & Ammunition — only the highlighted sections are required.
      if (it.categoryId === 'arms') {
        if (!it.subType) e.push(`Item ${i + 1}: select Type (Firearms / Other Weapons).`);
        if (!it.remarks.trim()) e.push(`Item ${i + 1}: Item Description is required.`);
      }
    });
    return e;
  }

  function goNext() {
    const e = validateStep1();
    if (e.length) { setErrors(e); setMsg({ kind: 'error', text: e[0] }); return; }
    setErrors([]); setMsg(null); setStep(2);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const e1 = validateStep1(); const e2 = validateStep2();
    const all = [...e1, ...e2];
    if (all.length) { setErrors(all); setMsg({ kind: 'error', text: all[0] }); setStep(e1.length ? 1 : 2); return; }
    const fullNo = firNo.trim().startsWith(prefix) ? firNo.trim() : `${prefix}${firNo.trim()}`;
    setBusy(true); setMsg(null); setErrors([]);
    try {
      const res = await api.createCaseBatch({
        firOrDd: fullNo,
        firNo: fullNo,
        recordType,
        policeStation: station,            // auto from dashboard / signed-in MM
        firDate: recordType === 'FIR' ? firDate : null,
        usSections: null,                  // removed from form (BNS sections used instead)
        io: defaultIo(user),               // auto from signed-in MM
        ddDate: recordType === 'DD' ? ddDate : null,
        natureOfDd: recordType === 'DD' ? natureOfDd : null,
        nameOfDeceased: recordType === 'DD' && natureOfDd === 'UD Case (UnnaturalDeath)' ? nameOfDeceased : null,
        reportingPerson: recordType === 'DD' && (natureOfDd === 'Lost Property Report' || natureOfDd === 'Other Miscellaneous Entry') ? reportingPerson : null,
        actualSeizureDdNo: actualSeizureDdNo.trim() || null,
        actualSeizureDate: actualSeizureDate.trim() || null,
        common: {
          seizedTime,
          witness1: null, witness2: null,  // removed from form
          dateOfReceipt, receivedBy, malkhanaLocation: '',
          legalSections: legalSections.map(s => s.sectionNo),
          seizingOfficer: items[0]?.seizingOfficer || defaultIo(user),
          seizedOn: items[0]?.seizedOn || today,
        },
        items: items.map((it, idx) => {
          const cat = getCategory(it.categoryId);
          const itemFields: { key: string; value: string }[] = [];
          if (cat?.subTypes && it.subType) itemFields.push({ key: 'sub_type', value: it.subType });
          if (ddNo.trim()) itemFields.push({ key: 'dd_no', value: ddNo.trim() });   // persist optional DD ref
          for (const f of cat?.fields || []) {
            const val = it.catValues[f.key];
            if (val != null && val !== '') itemFields.push({ key: f.key, value: val });
          }
          // Auto-classify the NDPS quantity (Small / Intermediate / Commercial)
          // from the narcotic type + seized weight, using the official table.
          if (cat?.id === 'narcotics' && it.subType) {
            const cls = classifyNdps(it.subType, it.catValues['quantity_seized'] || '');
            if (cls !== 'Unknown') itemFields.push({ key: 'quantity_class', value: cls });
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
      setTimeout(() => { reset(); onClose(); }, 1400);
    } catch (err) {
      setMsg({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!open && !asPage) return null;

  const lookupPill = firChecking
    ? <span className="lookup-pill checking">checking…</span>
    : firExists === true
      ? <span className="lookup-pill ok">✓ Fetched from records</span>
      : firExists === false && firNo.trim()
        ? <span className="lookup-pill neu">New — not on file</span>
        : null;

  const inner = (
    <form
      className={`form-card rc${asPage ? ' rc-page' : ''}`}
      onSubmit={submit}
      style={asPage
        ? undefined
        : step === 2
          ? { width: 'min(1120px, 95vw)', maxWidth: 1120 }
          : { width: 560, maxWidth: 560 }}
    >
      <button type="button" className="tag-close" onClick={() => { reset(); onClose(); }} aria-label="Close">✕</button>

      <div className="rc-head">
          <h3>Register New Case Property</h3>
          <p className="rc-sub">Step {step} of 2 — {step === 1 ? 'FIR / DD & Receipt' : 'Seized Items'}</p>
        </div>

        {/* ----- stepper ----- */}
        <div className="stepper">
          <div className={`step ${step === 1 ? 'active' : ''} ${step > 1 ? 'done' : ''}`} onClick={() => !busy && setStep(1)}>
            <span className="step-no">1</span> FIR / DD &amp; Receipt
          </div>
          <div className="step-sep" />
          <div className={`step ${step === 2 ? 'active' : ''}`} onClick={() => step === 2 && !busy && setStep(2)}>
            <span className="step-no">2</span> Seized Items ({items.length})
          </div>
        </div>

        {station && (
          <div className="station-badge">📍 Station: <b>{station}</b> &nbsp;·&nbsp; Moharrir: <b>{user?.name}</b></div>
        )}

        {/* ============ SCROLLABLE BODY ============ */}
        <div className="rc-body">

          {step === 1 && (
            <>
              {/* --- Record group --- */}
              <section className="rc-group">
                <div className="rc-grid">
                  <label>Record Type
                    <div className="rc-radio-row" role="radiogroup" aria-label="Record Type">
                      <label className="rc-radio">
                        <input
                          type="radio"
                          name="recordType"
                          value="FIR"
                          checked={recordType === 'FIR'}
                          onChange={() => { setRecordType('FIR'); setFirExists(null); setFirLoaded(false); }}
                        />
                        <span>FIR</span>
                      </label>
                      <label className="rc-radio">
                        <input
                          type="radio"
                          name="recordType"
                          value="DD"
                          checked={recordType === 'DD'}
                          onChange={() => { setRecordType('DD'); setFirExists(null); setFirLoaded(false); }}
                        />
                        <span>DD (Daily Diary)</span>
                      </label>
                    </div>
                  </label>

                  <label>FIR / DD No.
                    <div className="rc-fir-row">
                      <input
                        value={firNo}
                        onChange={e => { setFirNo(e.target.value); setFirExists(null); setFirLoaded(false); }}
                        placeholder={recordType === 'DD' ? 'e.g. DD 12/2026' : 'e.g. FIR 245/2026'}
                        required
                      />
                      <button type="button" className="btn ghost" onClick={checkFir} disabled={busy || firChecking}>
                        {firChecking ? '…' : 'Lookup'}
                      </button>
                      {lookupPill}
                    </div>
                  </label>

                  {recordType === 'FIR' ? (
                    <label>FIR Date
                      <input type="date" value={firDate} max={today} onChange={e => setFirDate(e.target.value)} />
                    </label>
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
                      {natureOfDd === 'UD Case (UnnaturalDeath)' && (
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
                </div>
              </section>

              {/* --- Actual Seizure group --- */}
              <section className="rc-group">
                <div className="rc-grid">
                  <label>DD No.
                    <input value={actualSeizureDdNo} onChange={e => setActualSeizureDdNo(e.target.value)} placeholder="e.g. DD 12/2026" />
                  </label>
                  <label>Date
                    <input type="date" value={actualSeizureDate} max={today} onChange={e => setActualSeizureDate(e.target.value)} />
                  </label>
                </div>
              </section>

              {/* --- Legal sections group --- */}
              <section className="rc-group">
                <div className="rc-grid">
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
                </div>
              </section>

              {/* --- Malkhana receipt group --- */}
              <section className="rc-group">
                <div className="rc-grid">
                  <label>Date of Receipt in Malkhana
                    <input type="date" value={dateOfReceipt} max={today} onChange={e => setDateOfReceipt(e.target.value)} required />
                  </label>
                  <label>Received By (Malkhana Moharrir)
                    <input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} placeholder="Moharrir name" required />
                  </label>
                  <label>Seized Time
                    <input type="time" value={seizedTime} onChange={e => setSeizedTime(e.target.value)} required />
                  </label>
                  <label>Seizing Officer
                    <input value={items[0]?.seizingOfficer || defaultIo(user)} onChange={e => setItems(prev => prev.map((it, i) => i === 0 ? { ...it, seizingOfficer: e.target.value } : it))} required />
                  </label>
                  <label>Seized On
                    <input type="date" value={items[0]?.seizedOn || today} onChange={e => setItems(prev => prev.map((it, i) => i === 0 ? { ...it, seizedOn: e.target.value } : it))} required />
                  </label>
                </div>
              </section>
            </>
          )}

          {step === 2 && (
            <>
              <div className="rc-items-head">
                <span className="rc-items-count">Seized Items <b>({items.length})</b></span>
                <button type="button" className="btn add-item-btn" onClick={addItem} disabled={busy}>+ Add Item</button>
              </div>

              {items.length === 0 && (
                <div className="rc-empty">
                  <div className="rc-empty-ic">📦</div>
                  <p>No items yet — click <b>“+ Add Item”</b> to add each seized article.</p>
                </div>
              )}

              <div className="items-grid">
                {items.map((it, idx) => {
                  const cat = getCategory(it.categoryId);
                  const seqHint = `MK-2026-${(items.length ? String(idx + 1).padStart(6, '0') : '000001')} (server-assigned)`;
                  return (
                    <div key={it.localId} className="item-card">
                      <div className="item-card-head">
                        <span className="item-no">Item {idx + 1}</span>
                        <span className="sr-hint">Sr. No. → {seqHint}</span>
                        <button type="button" className="item-remove" onClick={() => removeItem(it.localId)} aria-label="Remove item" title="Remove item">✕</button>
                      </div>
                      <div className={`rc-grid item-grid${cat?.id === 'arms' ? ' arms-grid' : ''}`}>
                        <label className="req">Category of Item
                          <select value={it.categoryId} onChange={e => {
                            const c = getCategory(e.target.value);
                            patchItem(it.localId, { categoryId: e.target.value, subType: '', sectionLetter: c?.sectionLetter || it.sectionLetter, catValues: {} });
                          }} required>
                            <option value="">— select category —</option>
                            {ITEM_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </select>
                        </label>
                        <label className="req">Malkhana Section (placement)
                          <select value={it.sectionLetter} onChange={e => patchItem(it.localId, { sectionLetter: e.target.value })}>
                            {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
                          </select>
                        </label>

                        {/* Quantity is hidden for Narcotics / NDPS, Arms & Ammunition,
                            and Cash & Valuables (not a highlighted column for cash). */}
                        {cat?.id !== 'narcotics' && cat?.id !== 'arms' && cat?.id !== 'cash' && (
                          <label>Quantity
                            <input value={it.quantity} onChange={e => patchItem(it.localId, { quantity: e.target.value })} placeholder="e.g. 1 or 2 kg" />
                          </label>
                        )}

                        {cat?.subTypes && cat.subTypeControl === 'radio' ? (
                          <div className={`rc-radio req ${it.subType ? 'filled' : ''}`}>
                            <span className="rc-field-label">{cat.subTypeLabel || 'Type'}</span>
                            <div className="rc-radio-row">
                              {cat.subTypes.map(t => (
                                <label key={t} className={`rc-radio-opt ${it.subType === t ? 'on' : ''}`}>
                                  <input type="radio" name={`${it.localId}-subtype`} value={t}
                                    checked={it.subType === t}
                                    onChange={() => patchItem(it.localId, { subType: t })} />
                                  <span>{t}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        ) : cat?.subTypes && (
                          <label>{cat.subTypeLabel || 'Type'}
                            <select value={it.subType} onChange={e => patchItem(it.localId, { subType: e.target.value })}>
                              <option value="">— select —</option>
                              {cat.subTypes.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </label>
                        )}

                        {/* The following common seizure fields are hidden for Narcotics / NDPS,
                            Arms & Ammunition, and Cash & Valuables (only Category, Section,
                            Total Amount, Description, Photo are kept per the required markup). */}
                        {cat?.id !== 'narcotics' && cat?.id !== 'arms' && cat?.id !== 'cash' && (
                          <>
                            <label>Place of Seizure
                              <input value={it.placeOfSeizure} onChange={e => patchItem(it.localId, { placeOfSeizure: e.target.value })} placeholder="e.g. Near bus stand" />
                            </label>

                            <label>Sealed / Unsealed
                              <select value={it.sealSealed} onChange={e => patchItem(it.localId, { sealSealed: e.target.value })}>
                                <option value="Yes">Sealed</option>
                                <option value="No">Unsealed</option>
                              </select>
                            </label>
                            <label>Seal No. / Mark
                              <input value={it.sealNo} onChange={e => patchItem(it.localId, { sealNo: e.target.value })} placeholder="Seal no. / mark" />
                            </label>
                            <label>Sealed By (Officer)
                              <input value={it.sealBy} onChange={e => patchItem(it.localId, { sealBy: e.target.value })} placeholder="Officer name" />
                            </label>
                          </>
                        )}

                        {cat?.fields.map(f => (
                          <label key={f.key}>
                            {f.label}{f.unit ? ` (${f.unit})` : ''}
                            {renderCatField(it.localId, it, f)}
                          </label>
                        ))}

                        {renderNdpsClassBadge(it)}

                        <label className={cat?.id === 'arms' ? 'req' : 'full req'}>Item Description (detailed — brand, colour, size, marks)
                          <textarea value={it.remarks} onChange={e => patchItem(it.localId, { remarks: e.target.value })} placeholder="Detailed description" required />
                        </label>
                        <label className={cat?.id === 'arms' ? 'req' : 'full req'}>Photo of the seized object
                          <div className="file-field">
                            <input type="file" accept="image/*" onChange={e => onPickItemPhoto(it.localId, e)} disabled={busy} required={cat?.id === 'arms'} />
                            {it.photo && <span className="file-info">{it.photo.file.name}</span>}
                          </div>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}
          {errors.length > 1 && (
            <ul className="form-errors">
              {errors.map((er, i) => <li key={i}>{er}</li>)}
            </ul>
          )}
        </div>

        {/* ============ STICKY FOOTER ACTIONS ============ */}
        <div className="rc-actions">
          {step === 1 ? (
            <>
              <button type="button" className="btn ghost" onClick={() => { reset(); onClose(); }} disabled={busy}>Cancel</button>
              <button type="button" className="btn" onClick={goNext} disabled={busy}>Next: Add Items →</button>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={() => setStep(1)} disabled={busy}>← Back</button>
              <button type="submit" className="btn" disabled={busy || items.length === 0}>
                {busy ? 'Saving…' : `Register ${items.length || ''} Item(s) & Generate Tags`}
              </button>
            </>
          )}
        </div>
      </form>
  );

  if (asPage) {
    return <div className="rc-page-wrap">{inner}</div>;
  }

  return (
    <div className={`overlay${open ? ' open' : ''}`} onClick={e => { if (e.target === e.currentTarget && !busy) { reset(); onClose(); } }}>
      {inner}
    </div>
  );
}
