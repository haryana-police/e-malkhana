import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RackItem, BnsSection, User, FirMaster } from '../types';
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
  seizingOfficer: string;
  quantity: string;
  placeOfSeizure: string;
  physicalStorage: string;
  remarks: string;
  photo: PendingFile | null;
  sealSealed: string;
  sealNo: string;
  sealBy: string;
  // Manual NDPS quantity class override (Small / Intermediate / Commercial).
  // When undefined the class tracks the auto value from the NDPS table; once
  // the user picks a radio this locks the chosen class even if the quantity
  // later changes.
  ndpsOverride?: 'Small' | 'Intermediate' | 'Commercial';
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
  // ---- FIR/DD live typeahead (single-select, replaces Lookup button) ----
  const [firHits, setFirHits] = useState<FirMaster[]>([]);
  const [firOpen, setFirOpen] = useState(false);
  const [firLoading, setFirLoading] = useState(false);
  const [firActive, setFirActive] = useState(-1);
  const firBoxRef = useRef<HTMLDivElement>(null);
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
  const [receivedBy, setReceivedBy] = useState('');

  // ---------- multi-item list ----------
  const [items, setItems] = useState<DraftItem[]>([]);
  const [itemsCollapsed, setItemsCollapsed] = useState(false);

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
    setFirHits([]); setFirOpen(false); setFirActive(-1);
    setBnsQuery(''); setLegalSections([]);
    setSeizedTime('10:00'); setReceivedBy('');
    setItems([]); setMsg(null); setErrors([]); setItemsCollapsed(false);
  }

  // ---------- FIR/DD lookup (fetches existing data if present) ----------
  // FIR/DD live typeahead search (debounced).  Triggers on every keystroke
 // in the FIR/DD No. field and shows matching records from the DB to
 // single-select, replacing the old "Lookup" button.
 useEffect(() => {
   if (!firOpen) return;
   const q = firNo.trim();
   if (!q) { setFirHits([]); setFirActive(-1); return; }
   let cancelled = false;
   setFirLoading(true);
   const timer = setTimeout(() => {
     api.searchFirMaster(q, 8)
       .then(rows => { if (!cancelled) { setFirHits(rows); setFirActive(rows.length ? 0 : -1); } })
       .catch(() => { if (!cancelled) setFirHits([]); })
       .finally(() => { if (!cancelled) setFirLoading(false); });
   }, 200);
   return () => { cancelled = true; clearTimeout(timer); };
 }, [firNo, firOpen]);

 useEffect(() => {
   if (!firOpen) return;
   function onDocClick(e: MouseEvent) {
     if (firBoxRef.current && !firBoxRef.current.contains(e.target as Node)) setFirOpen(false);
   }
   document.addEventListener('mousedown', onDocClick);
   return () => document.removeEventListener('mousedown', onDocClick);
 }, [firOpen]);

 // Single-select a FIR/DD candidate: prefill the wizard exactly like the
 // old lookup did, then close the typeahead.
 async function selectFir(fir: FirMaster) {
   setFirNo(fir.firNo);
   setFirOpen(false);
   setFirHits([]);
   setFirLoading(false);
   setFirChecking(true); setMsg(null); setFirExists(null);
   try {
     const m = await api.firMaster(fir.firNo);
     setFirExists(true); setFirLoaded(true);
     setRecordType(m.recordType || fir.recordType || recordType);
     setFirDate(m.firDate || today);
     setDdDate(m.ddDate || today); setNatureOfDd(m.natureOfDd || '');
     setNameOfDeceased(m.nameOfDeceased || ''); setReportingPerson(m.reportingPerson || '');
     setActualSeizureDdNo(m.actualSeizureDdNo || ''); setActualSeizureDate(m.actualSeizureDate || '');
     if (!receivedBy.trim()) setReceivedBy(defaultIo(user));
     setMsg({ kind: 'ok', text: `${fir.firNo} already on file — details loaded. Review below, then click Next.` });
   } catch {
     setFirExists(false); setFirLoaded(false);
     setMsg({ kind: 'ok', text: `New ${fir.firNo} — please fill the ${fir.recordType === 'DD' ? 'DD' : 'FIR'} details below.` });
   } finally {
     setFirChecking(false);
   }
 }

 function onFirKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
   if (e.key === 'ArrowDown') { e.preventDefault(); setFirOpen(true); setFirActive(i => Math.min(i + 1, firHits.length - 1)); }
   else if (e.key === 'ArrowUp') { e.preventDefault(); setFirActive(i => Math.max(i - 1, 0)); }
   else if (e.key === 'Enter') {
     if (firOpen && firActive >= 0 && firHits[firActive]) { e.preventDefault(); selectFir(firHits[firActive]); }
   } else if (e.key === 'Escape') { setFirOpen(false); }
   }

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
      // Fill the details in place and STAY on Step 1 (same page) — do NOT
      // auto-advance to Step 2. The MM can review the loaded details and
      // click "Next" when ready to add the seized item(s).
      setMsg({ kind: 'ok', text: `${full} already on file — details loaded. Review below, then click Next.` });
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
      catValues: {}, seizingOfficer: defaultIo(user),
      quantity: '1', placeOfSeizure: '', physicalStorage: '', remarks: '',
      photo: null, sealSealed: 'Yes', sealNo: '', sealBy: '', ndpsOverride: undefined,
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
  // The auto-derived class is shown, and the user may override it via radio
  // buttons (e.g. when the actual classification differs from the table value).
  const NDPS_CLASSES: ('Small' | 'Intermediate' | 'Commercial')[] = ['Small', 'Intermediate', 'Commercial'];
  function renderNdpsClassBadge(it: DraftItem) {
    const cat = getCategory(it.categoryId);
    if (!cat || cat.id !== 'narcotics') return null;
    if (!it.subType) return null;
    const auto = classifyNdps(it.subType, it.catValues['quantity_seized'] || '');
    if (auto === 'Unknown') return null;
    // Effective class = manual override if set, otherwise the auto value.
    const effective = it.ndpsOverride ?? auto;
    const tone = effective === 'Small' ? 'small' : effective === 'Intermediate' ? 'inter' : 'comm';
    const overriden = it.ndpsOverride != null && it.ndpsOverride !== auto;
    return (
      <div className="ndps-class-badge">
        <span className="ndps-class-label">NDPS Quantity Class</span>
        <span className={`ndps-class ndps-${tone}`}>{effective} Quantity</span>
        {overriden
          ? <span className="ndps-class-hint">(overridden — auto: {auto})</span>
          : <span className="ndps-class-hint">(auto from NDPS table)</span>}

        <div className="ndps-override" role="radiogroup" aria-label="Override NDPS quantity class">
          <span className="ndps-override-cap">Change class:</span>
          {NDPS_CLASSES.map(c => (
            <label key={c} className={`ndps-radio ${it.ndpsOverride === c ? 'sel' : ''}`}>
              <input
                type="radio"
                name={`ndps-class-${it.localId}`}
                value={c}
                checked={it.ndpsOverride === c}
                onChange={() => patchItem(it.localId, { ndpsOverride: c })}
              />
              {c}
            </label>
          ))}
          <button
            type="button"
            className="ndps-reset"
            disabled={it.ndpsOverride == null}
            onClick={() => patchItem(it.localId, { ndpsOverride: undefined })}
            title="Revert to the auto value from the NDPS table"
          >Auto</button>
        </div>
      </div>
    );
  }

  const prefix = recordType === 'DD' ? 'DD ' : 'FIR ';

  // ---------- validation ----------
  // All fields are optional — no compulsory inputs (per request). Returning []
  // means nothing blocks submission.
  function validateStep1(): string[] {
    return [];
  }
  function validateStep2(): string[] {
    return [];
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
          receivedBy, malkhanaLocation: '',
          legalSections: legalSections.map(s => s.sectionNo),
          seizingOfficer: items[0]?.seizingOfficer || defaultIo(user),
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
            const cls = it.ndpsOverride ?? classifyNdps(it.subType, it.catValues['quantity_seized'] || '');
            if (cls !== 'Unknown') itemFields.push({ key: 'quantity_class', value: cls });
          }
          return {
            itemType: (cat?.subTypes && it.subType) ? `${cat.label} — ${it.subType}` : (cat?.label || 'Article'),
            sectionLetter: it.sectionLetter,
            category: it.categoryId,
            subType: it.subType,
            malkhanaSection: it.sectionLetter,
            legalSections: legalSections.map(s => s.sectionNo),
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
          <div
            className={`step ${step === 2 ? 'active clickable' : 'clickable'}`}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-current={step === 2 ? 'step' : undefined}
            onClick={() => { if (busy) return; if (step === 1) goNext(); else setStep(2); }}
            onKeyDown={e => { if (busy) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (step === 1) goNext(); else setStep(2); } }}
          >
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
                          onChange={() => { setRecordType('FIR'); setFirExists(null); setFirLoaded(false); setFirOpen(false); setFirHits([]); }}
                        />
                        <span>FIR</span>
                      </label>
                      <label className="rc-radio">
                        <input
                          type="radio"
                          name="recordType"
                          value="DD"
                          checked={recordType === 'DD'}
                          onChange={() => { setRecordType('DD'); setFirExists(null); setFirLoaded(false); setFirOpen(false); setFirHits([]); }}
                        />
                        <span>DD (Daily Diary)</span>
                      </label>
                    </div>
                  </label>

                  <label>FIR / DD No.
                    <div className="rc-fir-row fir-typeahead" ref={firBoxRef}>
                      <input
                        value={firNo}
                        onChange={e => { setFirNo(e.target.value); setFirExists(null); setFirLoaded(false); setFirOpen(true); }}
                        onFocus={() => { if (firNo.trim()) setFirOpen(true); }}
                        onKeyDown={onFirKeyDown}
                        placeholder={recordType === 'DD' ? 'e.g. DD 12/2026' : 'e.g. FIR 245/2026'}
                        autoComplete="off" spellCheck={false}
                        role="combobox" aria-expanded={firOpen} aria-autocomplete="list" aria-controls="fir-hits"
                      />
                      {lookupPill}
                      {firOpen && (
                        <div className="fir-hits" id="fir-hits" role="listbox">
                          {firLoading && firHits.length === 0 && <div className="fir-empty">searching…</div>}
                          {!firLoading && firHits.length === 0 && firNo.trim() &&
                            <div className="fir-empty">No matching FIR/DD for “{firNo.trim()}”.</div>}
                          {firHits.map((h, i) => (
                            <div
                              key={h.firNo}
                              role="option" aria-selected={i === firActive}
                              className={`fir-opt ${i === firActive ? 'active' : ''} ${h.recordType === 'DD' ? 'is-dd' : ''}`}
                              onMouseDown={() => selectFir(h)}
                              onMouseEnter={() => setFirActive(i)}
                            >
                              <span className="fir-opt-no">{h.firNo}</span>
                              <span className="fir-opt-meta">
                                {h.recordType === 'DD' ? 'DD' : 'FIR'}
                                {h.policeStation ? ` · ${h.policeStation}` : ''}
                                {h.itemCount != null ? ` · ${h.itemCount} item(s)` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
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
                  <label>Received By (Malkhana Moharrir)
                    <input value={receivedBy} onChange={e => setReceivedBy(e.target.value)} placeholder="Moharrir name" />
                  </label>
                  <label>Seized Time
                    <input type="time" value={seizedTime} onChange={e => setSeizedTime(e.target.value)} />
                  </label>
                  <label>Seizing Officer
                    <input value={items[0]?.seizingOfficer || defaultIo(user)} onChange={e => setItems(prev => prev.map((it, i) => i === 0 ? { ...it, seizingOfficer: e.target.value } : it))} />
                  </label>
                </div>
              </section>
            </>
          )}

          {step === 2 && (
            <>
              <div className={`rc-items-head${items.length ? ' clickable' : ''}`} onClick={() => items.length && !busy && setItemsCollapsed(c => !c)} role="button" tabIndex={items.length ? 0 : -1} aria-expanded={!itemsCollapsed} onKeyDown={e => { if (items.length && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setItemsCollapsed(c => !c); } }} title={items.length ? (itemsCollapsed ? 'Expand seized items' : 'Collapse seized items') : undefined}>
                <span className="rc-items-count">Seized Items <b>({items.length})</b>{items.length > 0 && <span className="rc-collapse-caret">{itemsCollapsed ? '▸' : '▾'}</span>}</span>
                <button type="button" className="btn add-item-btn" onClick={e => { e.stopPropagation(); addItem(); }} disabled={busy}>+ Add Item</button>
              </div>

              {items.length > 0 && itemsCollapsed && (
                <div className="rc-collapsed-note">Seized items hidden — click <b>“Seized Items ({items.length})”</b> to expand.</div>
              )}

              {items.length === 0 && (
                <div className="rc-empty">
                  <div className="rc-empty-ic">📦</div>
                  <p>No items yet — click <b>“+ Add Item”</b> to add each seized article.</p>
                </div>
              )}

              <div className="items-grid" style={itemsCollapsed ? { display: 'none' } : undefined}>
                {items.map((it, idx) => {
                  const cat = getCategory(it.categoryId);
                  // Before a category is selected, hide the highlighted columns — Quantity
                  // and the common seizure fields (Place of Seizure, Sealed/Unsealed, Seal
                  // No./Mark, Sealed By). Only Category, Malkhana Section, Description and
                  // Photo remain, so the blank item row isn't cluttered with empty fields.
                  const noCat = !it.categoryId;
                  // "Minimal" categories (Lost Items, Viscera, Miscellaneous) keep ONLY the
                  // highlighted columns — Malkhana Section, Item Description and Photo (plus
                  // the always-present Category selector).  All other common/per-category
                  // fields are suppressed so the item row stays a clean 3-column block.
                  const isMinimal = cat?.id === 'lost_items' || cat?.id === 'viscera' || cat?.id === 'other';
                  const seqHint = `MK-2026-${(items.length ? String(idx + 1).padStart(6, '0') : '000001')} (server-assigned)`;
                  return (
                    <div key={it.localId} className="item-card">
                      <div className="item-card-head">
                        <span className="item-no">Item {idx + 1}</span>
                        <span className="sr-hint">Sr. No. → {seqHint}</span>
                        <button type="button" className="item-remove" onClick={() => removeItem(it.localId)} aria-label="Remove item" title="Remove item">✕</button>
                      </div>
                      <div className={`rc-grid item-grid${cat?.id === 'arms' ? ' arms-grid' : ''}`}>
                        <label>Category of Item
                          <select value={it.categoryId} onChange={e => {
                            const c = getCategory(e.target.value);
                            patchItem(it.localId, { categoryId: e.target.value, subType: '', sectionLetter: c?.sectionLetter || it.sectionLetter, catValues: {} });
                          }} >
                            <option value="">— select category —</option>
                            {ITEM_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </select>
                        </label>
                        <label>Location
                          <select value={it.sectionLetter} onChange={e => patchItem(it.localId, { sectionLetter: e.target.value })}>
                            {racks.map(r => <option key={r.letter} value={r.letter}>Part {r.letter} — {r.name}</option>)}
                          </select>
                        </label>

                        {/* Quantity is hidden for Narcotics / NDPS, Arms & Ammunition,
                            Cash & Valuables, Jewellery and Vehicle (not a highlighted
                            column — only Category, Section, Type, Description, Photo are).
                            For Liquor / Excise, a SEPARATE category-field Quantity is
                            shown instead (below), so the common Quantity is suppressed.
                            Also hidden until a Category is selected (noCat). */}
                        {!noCat && !isMinimal && cat?.id !== 'narcotics' && cat?.id !== 'arms' && cat?.id !== 'cash' && cat?.id !== 'gold' && cat?.id !== 'vehicle' && cat?.id !== 'liquor' && (
                          <label>Quantity
                            <input value={it.quantity} onChange={e => patchItem(it.localId, { quantity: e.target.value })} placeholder="e.g. 1 or 2 kg" />
                          </label>
                        )}

                        {!isMinimal && cat?.subTypes && cat.subTypeControl === 'radio' ? (
                          <div className={`rc-radio req${cat?.id === 'arms' ? ' inline' : ''}${it.subType ? ' filled' : ''}`}>
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
                        ) : !isMinimal && cat?.subTypes && (
                          <label>{cat.subTypeLabel || 'Type'}
                            <select value={it.subType} onChange={e => patchItem(it.localId, { subType: e.target.value })}>
                              <option value="">— select —</option>
                              {cat.subTypes.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </label>
                        )}

                        {/* The following common seizure fields are hidden for Narcotics / NDPS,
                            Arms & Ammunition, Cash & Valuables, Jewellery, Liquor / Excise
                            and Vehicle (only the highlighted columns — Category, Section,
                            Type, Description, Photo — are kept per the required markup).
                            They are also hidden until a Category is selected (noCat), so a
                            fresh item row shows only Category, Section, Description, Photo. */}
                        {!noCat && !isMinimal && cat?.id !== 'narcotics' && cat?.id !== 'arms' && cat?.id !== 'cash' && cat?.id !== 'gold' && cat?.id !== 'vehicle' && cat?.id !== 'liquor' && (
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

                        {/* Per-category detail fields are suppressed for the minimal
                            categories (Lost Items, Viscera, Miscellaneous) — only the
                            highlighted columns (Section, Description, Photo) are kept. */}
                        {!isMinimal && cat?.id !== 'gold' && cat?.fields.map(f => (
                          <label key={f.key}>
                            {f.label}{f.unit ? ` (${f.unit})` : ''}
                            {renderCatField(it.localId, it, f)}
                          </label>
                        ))}

                        {renderNdpsClassBadge(it)}

                        <label className="full">Item Description (detailed — brand, colour, size, marks) <span className="opt-tag">(optional)</span>
                          <textarea value={it.remarks} onChange={e => patchItem(it.localId, { remarks: e.target.value })} placeholder="Detailed description" />
                        </label>
                        <label className="full">Photo of the seized object <span className="opt-tag">(optional)</span>
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
