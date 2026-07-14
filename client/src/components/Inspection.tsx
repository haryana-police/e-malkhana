import { useEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { api } from '../api';
import type { InspectionReport, InspectionBody, InspectionStatus, User } from '../types';

// ---------------------------------------------------------------------------
// Static option sets (controlled vocabulary — mirrors the spec exactly)
// ---------------------------------------------------------------------------
const RANKS = ['SHO', 'DSP', 'SP', 'Other'];
const YES_NO_NA = ['Yes', 'No', 'NA'];
const MATCH_OPTS = ['Yes', 'No', 'Discrepancy'];
const SEAL_OPTS = ['Intact', 'Tampered', 'NA'];
const NDPS_OPTS = ['Compliant', 'Delayed', 'NA'];
const NARC_OPTS = ['Good', 'Deteriorating', 'Critical', 'NA'];
const SAT_OPTS = ['Satisfactory', 'Needs Attention'];
const SPACE_OPTS = ['Adequate', 'Inadequate'];
const COMPLIANCE_OPTS = ['Complied', 'Partially Complied', 'Not Complied'];

// Values that make the paired remarks field MANDATORY (per Part 4).
const REMARKS_REQUIRED = new Set(['No', 'Discrepancy', 'Needs Attention', 'Non-Compliant']);
// Any of these in a paired answer -> auto overall status = Non-Compliant.
const NON_COMPLIANT_HINTS = new Set(['No', 'Discrepancy', 'Needs Attention', 'Non-Compliant', 'Tampered', 'Inadequate']);

interface PairField { key: string; label: string; options: string[]; }

interface Props {
  user?: User | null;
  onBack: (v: any) => void;
}

type Mode = 'list' | 'edit' | 'view';

export function Inspection({ user, onBack }: Props) {
  const [mode, setMode] = useState<Mode>('list');
  const [rows, setRows] = useState<InspectionReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // --- filters (list view) ---
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [officer, setOfficer] = useState('');
  const [statusF, setStatusF] = useState<'all' | InspectionStatus>('all');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  async function loadList() {
    setLoading(true);
    try {
      const data = await api.inspections();
      setRows(data);
      setErr(null);
    } catch (e: any) {
      setErr(e.message || 'Failed to load inspections');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (mode === 'list') loadList(); }, [mode]);

  const filtered = useMemo(() => {
    let r = rows.slice();
    if (dateFrom) r = r.filter(x => x.inspectionDate >= dateFrom);
    if (dateTo) r = r.filter(x => x.inspectionDate <= dateTo);
    if (officer.trim()) {
      const q = officer.trim().toLowerCase();
      r = r.filter(x => x.inspectingOfficerName.toLowerCase().includes(q));
    }
    if (statusF !== 'all') r = r.filter(x => x.overallStatus === statusF);
    r.sort((a, b) => {
      const da = a.inspectionDate + ' ' + a.inspectionTime;
      const db = b.inspectionDate + ' ' + b.inspectionTime;
      return sortDir === 'desc' ? db.localeCompare(da) : da.localeCompare(db);
    });
    return r;
  }, [rows, dateFrom, dateTo, officer, statusF, sortDir]);

  function openNew() { setMode('edit'); }
  function openEdit(rec: InspectionReport) { setEditTarget(rec); setMode('edit'); }
  function openView(rec: InspectionReport) { setEditTarget(rec); setMode('view'); }

  // --- form state lives in a child so edits don't leak into the list ---
  const [editTarget, setEditTarget] = useState<InspectionReport | null>(null);

  if (mode !== 'list') {
    return (
      <InspectionForm
        user={user}
        initial={editTarget}
        readOnly={mode === 'view'}
        onCancel={() => { setEditTarget(null); setMode('list'); }}
        onSaved={() => { setEditTarget(null); setMode('list'); loadList(); }}
      />
    );
  }

  return (
    <div className="view active" id="view-inspection">
      <div className="page-head">
        <div>
          <h1>Inspection</h1>
          <div className="sub">Malkhana compliance inspection register</div>
        </div>
        <button className="btn" onClick={openNew}>+ New Inspection</button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Filters</h2>
        </div>
        <div className="insp-filter-bar">
          <label>From
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label>To
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
          <label>Officer
            <input type="text" placeholder="Officer name…" value={officer} onChange={e => setOfficer(e.target.value)} />
          </label>
          <label>Status
            <select value={statusF} onChange={e => setStatusF(e.target.value as any)}>
              <option value="all">All</option>
              <option value="Compliant">Compliant</option>
              <option value="Non-Compliant">Non-Compliant</option>
              <option value="Needs Follow-up">Needs Follow-up</option>
              <option value="Pending">Pending</option>
            </select>
          </label>
          <button className="btn ghost small" onClick={() => { setDateFrom(''); setDateTo(''); setOfficer(''); setStatusF('all'); }}>
            Clear
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Inspection Reports</h2>
          <span className="meta">{filtered.length} record(s)</span>
          <button className="btn ghost small" onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>
            Sort: {sortDir === 'desc' ? 'Latest first ↓' : 'Oldest first ↑'}
          </button>
        </div>

        {loading ? (
          <div className="insp-empty">Loading…</div>
        ) : err ? (
          <div className="insp-empty" style={{ color: 'var(--seal-red)' }}>{err}</div>
        ) : filtered.length === 0 ? (
          <div className="insp-empty">No inspection reports match the filters.</div>
        ) : (
          <div className="table-wrap">
            <table className="register-table insp-table">
              <thead>
                <tr>
                  <th>Inspection ID</th>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Inspecting Officer</th>
                  <th>Police Station</th>
                  <th>Status</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.inspectionId}>
                    <td className="fir">{r.inspectionId}</td>
                    <td className="date-col">{r.inspectionDate}</td>
                    <td className="date-col">{r.inspectionTime}</td>
                    <td>{r.inspectingOfficerName}<div className="sub">{r.inspectingOfficerRank}</div></td>
                    <td>{r.policeStation}</td>
                    <td><StatusBadge status={r.overallStatus} /></td>
                    <td className="col-actions">
                      <button className="btn tiny ghost" title="View" onClick={() => openView(r)}>View</button>
                      <button className="btn tiny ghost" title="Edit" onClick={() => openEdit(r)}>Edit</button>
                      <button className="btn tiny ghost" title="Download PDF" onClick={() => exportRecordPdf(r)}>PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Form view (Sections 1–8)
// ===========================================================================
interface FormProps {
  user?: User | null;
  initial: InspectionReport | null;
  readOnly: boolean;
  onCancel: () => void;
  onSaved: () => void;
}

function emptyBody(): InspectionBody { return {}; }

function InspectionForm({ user, initial, readOnly, onCancel, onSaved }: FormProps) {
  const isEdit = !!initial;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // --- top-level fields ---
  const [nextId, setNextId] = useState('');
  const [prevDate, setPrevDate] = useState<string | null>(null);
  const [inspectionDate, setInspectionDate] = useState('');
  const [inspectionTime, setInspectionTime] = useState('');
  const [policeStation, setPoliceStation] = useState(user?.station || 'PS Sector-5, Panchkula');
  const [officerName, setOfficerName] = useState(user?.name || '');
  const [officerRank, setOfficerRank] = useState<string>(user?.rank || 'SHO');
  const [inchargeName, setInchargeName] = useState('');
  const [status, setStatus] = useState<InspectionStatus>('Compliant');
  const [signatureUrl, setSignatureUrl] = useState<string | undefined>(undefined);

  // --- structured body ---
  const [body, setBody] = useState<InspectionBody>(emptyBody());

  const sheetRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  // Initialise from existing record OR fetch next id + previous date.
  useEffect(() => {
    if (initial) {
      setInspectionDate(initial.inspectionDate);
      setInspectionTime(initial.inspectionTime);
      setPoliceStation(initial.policeStation);
      setOfficerName(initial.inspectingOfficerName);
      setOfficerRank(initial.inspectingOfficerRank);
      setInchargeName(initial.malkhanaInchargeName);
      setStatus(initial.overallStatus);
      setPrevDate(initial.previousInspectionDate || null);
      setSignatureUrl(initial.signatureUrl);
      setBody(initial.report || emptyBody());
    } else {
      setInspectionDate(new Date().toISOString().slice(0, 10));
      setInspectionTime(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
      api.inspectionMeta().then(m => { setNextId(m.nextInspectionId); setPrevDate(m.previousInspectionDate); })
        .catch(() => setNextId('INS-' + new Date().getFullYear() + '-0001'));
    }
  }, [initial]);

  // --- nested get/set helpers for the body ---
  function sec<T = any>(name: keyof InspectionBody): T { return (body[name] as any) || ({} as T); }
  function setField(section: keyof InspectionBody, key: string, value: string) {
    setBody(b => {
      const cur = (b[section] as any) || {};
      const next = { ...b, [section]: { ...cur, [key]: value } };
      return next;
    });
  }

  // --- auto-calculate overall status ---
  function computeAutoStatus(): InspectionStatus {
    const flat: any = {};
    for (const k of Object.keys(body)) Object.assign(flat, (body as any)[k]);
    for (const v of Object.values(flat)) {
      if (typeof v === 'string' && NON_COMPLIANT_HINTS.has(v)) return 'Non-Compliant';
    }
    return 'Compliant';
  }

  // Recompute status automatically whenever a paired answer changes (unless
  // the user has manually chosen "Needs Follow-up").
  function onPairValue(section: keyof InspectionBody, key: string, value: string) {
    setField(section, key, value);
    const auto = computeAutoStatus();
    setStatus(prev => (prev === 'Needs Follow-up' ? prev : auto));
  }

  // --- validation ---
  function validate(requireAll: boolean): Record<string, string> {
    const e: Record<string, string> = {};
    if (!inspectionDate) e.inspectionDate = 'Date is required';
    if (!inspectionTime) e.inspectionTime = 'Time is required';
    if (!officerName.trim()) e.officerName = 'Inspecting officer name is required';
    if (!officerRank) e.officerRank = 'Rank is required';
    if (!policeStation.trim()) e.policeStation = 'Police station is required';
    if (!inchargeName.trim()) e.inchargeName = 'Malkhana in-charge name is required';

    if (requireAll) {
      // conditional remarks: mandatory when answer is in REMARKS_REQUIRED
      const paired: { section: keyof InspectionBody; key: string }[] = [
        { section: 'registerVerification', key: 'malkhanaRegisterUpdated' },
        { section: 'registerVerification', key: 'casePropertyRegisterVerified' },
        { section: 'registerVerification', key: 'generalDiaryCrosscheck' },
        { section: 'physicalVerification', key: 'articlesCountMatch' },
        { section: 'physicalVerification', key: 'sealsPacketsStatus' },
        { section: 'physicalVerification', key: 'numberingLabelingCorrect' },
        { section: 'casePropertyStatus', key: 'ndpsPropertiesDisposalStatus' },
        { section: 'specialCategoryCheck', key: 'cashGoldSilverVerified' },
        { section: 'specialCategoryCheck', key: 'armsAmmunitionChecked' },
        { section: 'specialCategoryCheck', key: 'perishableNarcoticsCondition' },
        { section: 'malkhanaCondition', key: 'securityLocksSeals' },
        { section: 'malkhanaCondition', key: 'cleanlinessPestControl' },
        { section: 'malkhanaCondition', key: 'fireSafety' },
        { section: 'malkhanaCondition', key: 'storageSpaceAdequacy' },
      ];
      for (const p of paired) {
        const v = (sec<any>(p.section)[p.key] || '') as string;
        if (REMARKS_REQUIRED.has(v)) {
          const rem = (sec<any>(p.section)[p.key + 'Remarks'] || '').trim();
          if (!rem) e[p.section + '.' + p.key] = 'Remarks required for this answer';
        }
      }
    }
    return e;
  }

  async function submit(draft: boolean) {
    setMsg(null);
    if (!draft) {
      const e = validate(true);
      setErrors(e);
      if (Object.keys(e).length) {
        setMsg({ kind: 'error', text: 'Please fix the highlighted fields before submitting.' });
        return;
      }
    }
    setBusy(true);
    try {
      const payload: any = {
        inspectionId: initial?.inspectionId,
        inspectionDate,
        inspectionTime,
        policeStation: policeStation.trim(),
        inspectingOfficerName: officerName.trim(),
        inspectingOfficerRank: officerRank,
        malkhanaInchargeName: inchargeName.trim(),
        previousInspectionDate: prevDate || null,
        status: draft ? 'Pending' : status,
        report: body,
        signatureUrl,
      };
      if (initial) await api.updateInspection(payload);
      else await api.saveInspection(payload);
      setMsg({ kind: 'ok', text: draft ? 'Draft saved.' : `Inspection ${initial ? 'updated' : 'submitted'} successfully.` });
      setTimeout(onSaved, 700);
    } catch (errx: any) {
      setMsg({ kind: 'error', text: errx.message || 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  // --- signature pad ---
  function startDraw(e: React.PointerEvent) { drawing.current = true; drawAt(e); }
  function drawAt(e: React.PointerEvent) {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.width / rect.width);
    const y = (e.clientY - rect.top) * (c.height / rect.height);
    ctx.lineTo(x, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y);
  }
  function endDraw() {
    const c = canvasRef.current; if (!c) return;
    c.getContext('2d')?.beginPath();
    drawing.current = false;
    if (!readOnly) setSignatureUrl(c.toDataURL('image/png'));
  }
  function clearSig() {
    const c = canvasRef.current; if (!c) return;
    c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    if (!readOnly) setSignatureUrl(undefined);
  }
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#14243D';
    if (signatureUrl && canvasRef.current) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
      img.src = signatureUrl;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signatureUrl]);

  function onSigFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { if (!readOnly) setSignatureUrl(fr.result as string); };
    fr.readAsDataURL(f);
  }

  // --- PDF export ---
  const [pdfBusy, setPdfBusy] = useState(false);
  async function exportPdf() {
    const sheet = sheetRef.current; if (!sheet || pdfBusy) return;
    setPdfBusy(true);
    try {
      const canvas = await html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const availW = pw - margin * 2;
      const ratio = canvas.height / canvas.width;
      let w = availW, h = w * ratio;
      if (h > ph - margin * 2) { h = ph - margin * 2; w = h / ratio; }
      const x = (pw - w) / 2, y = margin;
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, w, h);
      const fname = (initial?.inspectionId || nextId || 'inspection').replace(/[^\\w\\-]+/g, '_');
      pdf.save(`${fname}.pdf`);
    } catch (er) {
      console.error(er);
      alert('PDF export failed — try again.');
    } finally { setPdfBusy(false); }
  }

  const auto = computeAutoStatus();
  const title = initial ? (readOnly ? `Inspection ${initial.inspectionId}` : `Edit ${initial.inspectionId}`) : 'New Inspection Report';

  return (
    <div className="view active" id="view-inspection-form">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <div className="sub">{readOnly ? 'Read-only view' : 'Complete all 8 sections'}</div>
        </div>
        <div className="btn-row">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>← Back</button>
          {!readOnly && (
            <>
              <button className="btn ghost" onClick={() => submit(true)} disabled={busy}>Save as Draft</button>
              <button className="btn ghost" onClick={exportPdf} disabled={pdfBusy}>{pdfBusy ? 'Generating…' : '⬇ Generate PDF'}</button>
              <button className="btn" onClick={() => submit(false)} disabled={busy}>{initial ? 'Update' : 'Submit'}</button>
            </>
          )}
          {readOnly && (
            <button className="btn ghost" onClick={exportPdf} disabled={pdfBusy}>{pdfBusy ? 'Generating…' : '⬇ Generate PDF'}</button>
          )}
        </div>
      </div>

      {msg && <div className={`form-msg show ${msg.kind}`}>{msg.text}</div>}

      {/* SECTION 1 */}
      <SectionCard n="1" title="Basic Inspection Details">
        <div className="form-grid">
          <label>Inspection ID
            <input value={initial?.inspectionId || nextId || '…'} readOnly disabled />
          </label>
          <label>Previous Inspection
            <input value={prevDate ? prevDate : 'First inspection'} readOnly disabled />
          </label>
          <label className={errors.inspectionDate ? 'has-err' : ''}>Inspection Date *
            <input type="date" value={inspectionDate} disabled={readOnly}
              onChange={e => setInspectionDate(e.target.value)} />
            {errors.inspectionDate && <span className="field-error">{errors.inspectionDate}</span>}
          </label>
          <label className={errors.inspectionTime ? 'has-err' : ''}>Inspection Time *
            <input type="time" value={inspectionTime} disabled={readOnly}
              onChange={e => setInspectionTime(e.target.value)} />
            {errors.inspectionTime && <span className="field-error">{errors.inspectionTime}</span>}
          </label>
          <label className={errors.policeStation ? 'has-err' : ''}>Police Station *
            <input value={policeStation} disabled={readOnly}
              onChange={e => setPoliceStation(e.target.value)} />
            {errors.policeStation && <span className="field-error">{errors.policeStation}</span>}
          </label>
          <label className={errors.officerName ? 'has-err' : ''}>Inspecting Officer Name *
            <input value={officerName} disabled={readOnly}
              onChange={e => setOfficerName(e.target.value)} />
            {errors.officerName && <span className="field-error">{errors.officerName}</span>}
          </label>
          <label className={errors.officerRank ? 'has-err' : ''}>Inspecting Officer Rank *
            <select value={officerRank} disabled={readOnly} onChange={e => setOfficerRank(e.target.value)}>
              {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            {errors.officerRank && <span className="field-error">{errors.officerRank}</span>}
          </label>
          <label className={errors.inchargeName ? 'has-err' : ''}>Malkhana In-charge Name *
            <input value={inchargeName} disabled={readOnly}
              onChange={e => setInchargeName(e.target.value)} />
            {errors.inchargeName && <span className="field-error">{errors.inchargeName}</span>}
          </label>
        </div>
      </SectionCard>

      {/* SECTION 2 */}
      <SectionCard n="2" title="Register Verification">
        <PairGroup section="registerVerification" fields={[
          { key: 'malkhanaRegisterUpdated', label: 'Malkhana Register Updated', options: YES_NO_NA },
          { key: 'casePropertyRegisterVerified', label: 'Case Property Register Verified', options: YES_NO_NA },
          { key: 'generalDiaryCrosscheck', label: 'General Diary Cross-check', options: YES_NO_NA },
        ]} body={body} errors={errors} readOnly={readOnly} onValue={onPairValue} setField={setField} />
      </SectionCard>

      {/* SECTION 3 */}
      <SectionCard n="3" title="Physical Verification">
        <PairGroup section="physicalVerification" fields={[
          { key: 'articlesCountMatch', label: 'Articles Count Match', options: MATCH_OPTS },
          { key: 'sealsPacketsStatus', label: 'Seals / Packets Status', options: SEAL_OPTS },
          { key: 'numberingLabelingCorrect', label: 'Numbering / Labeling Correct', options: ['Yes', 'No'] },
        ]} body={body} errors={errors} readOnly={readOnly} onValue={onPairValue} setField={setField} />
      </SectionCard>

      {/* SECTION 4 */}
      <SectionCard n="4" title="Case Property Status">
        <div className="form-grid">
          <NumberField label="Court Disposal Pending (count)" value={sec('casePropertyStatus').courtDisposalPendingCount || ''}
            disabled={readOnly} onChange={v => setField('casePropertyStatus', 'courtDisposalPendingCount', v)} />
          <PairInline section="casePropertyStatus" field={{ key: 'ndpsPropertiesDisposalStatus', label: 'NDPS Properties Disposal', options: NDPS_OPTS }}
            body={body} errors={errors} readOnly={readOnly} onValue={onPairValue} setField={setField} />
          <NumberField label="FSL Exhibits Pending (count)" value={sec('casePropertyStatus').fslExhibitsPendingCount || ''}
            disabled={readOnly} onChange={v => setField('casePropertyStatus', 'fslExhibitsPendingCount', v)} />
          <label className="full">FSL Exhibits Remarks
            <textarea value={sec('casePropertyStatus').fslExhibitsRemarks || ''} disabled={readOnly}
              onChange={e => setField('casePropertyStatus', 'fslExhibitsRemarks', e.target.value)} />
          </label>
          <NumberField label="Old / Unclaimed Property (count)" value={sec('casePropertyStatus').oldUnclaimedPropertyCount || ''}
            disabled={readOnly} onChange={v => setField('casePropertyStatus', 'oldUnclaimedPropertyCount', v)} />
          <label className="full">Old / Unclaimed Property List
            <textarea value={sec('casePropertyStatus').oldUnclaimedPropertyList || ''} disabled={readOnly}
              placeholder="e.g. MK-2025-00011, MK-2025-00034 …" onChange={e => setField('casePropertyStatus', 'oldUnclaimedPropertyList', e.target.value)} />
          </label>
        </div>
      </SectionCard>

      {/* SECTION 5 */}
      <SectionCard n="5" title="Special Category Check">
        <PairGroup section="specialCategoryCheck" fields={[
          { key: 'cashGoldSilverVerified', label: 'Cash / Gold / Silver Verified', options: YES_NO_NA },
          { key: 'armsAmmunitionChecked', label: 'Arms / Ammunition Checked', options: YES_NO_NA },
          { key: 'perishableNarcoticsCondition', label: 'Perishable Narcotics Condition', options: NARC_OPTS },
        ]} body={body} errors={errors} readOnly={readOnly} onValue={onPairValue} setField={setField} />
      </SectionCard>

      {/* SECTION 6 */}
      <SectionCard n="6" title="Malkhana Condition">
        <PairGroup section="malkhanaCondition" fields={[
          { key: 'securityLocksSeals', label: 'Security / Locks / Seals', options: SAT_OPTS },
          { key: 'cleanlinessPestControl', label: 'Cleanliness / Pest Control', options: SAT_OPTS },
          { key: 'fireSafety', label: 'Fire Safety', options: SAT_OPTS },
          { key: 'storageSpaceAdequacy', label: 'Storage Space Adequacy', options: SPACE_OPTS },
        ]} body={body} errors={errors} readOnly={readOnly} onValue={onPairValue} setField={setField} />
      </SectionCard>

      {/* SECTION 7 */}
      <SectionCard n="7" title="Discrepancy & Observations">
        <div className="form-grid">
          <label className="full">Discrepancies Found
            <textarea value={body.discrepanciesFound || ''} disabled={readOnly} style={{ minHeight: 80 }}
              onChange={e => setBody(b => ({ ...b, discrepanciesFound: e.target.value }))} />
          </label>
          <label>Previous Remarks Compliance
            <select value={body.previousRemarksComplianceStatus || ''} disabled={readOnly}
              onChange={e => setBody(b => ({ ...b, previousRemarksComplianceStatus: e.target.value }))}>
              <option value="">— Select —</option>
              {COMPLIANCE_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="full">New Remarks / Suggestions
            <textarea value={body.newRemarksSuggestions || ''} disabled={readOnly} style={{ minHeight: 80 }}
              onChange={e => setBody(b => ({ ...b, newRemarksSuggestions: e.target.value }))} />
          </label>
        </div>
      </SectionCard>

      {/* SECTION 8 */}
      <SectionCard n="8" title="Final Submission">
        <div className="form-grid">
          <label className="full">Overall Status
            <div className="insp-status-row">
              <StatusBadge status={status} />
              <select value={status} disabled={readOnly} onChange={e => setStatus(e.target.value as InspectionStatus)}
                style={{ maxWidth: 220 }}>
                <option value="Compliant">Compliant</option>
                <option value="Non-Compliant">Non-Compliant</option>
                <option value="Needs Follow-up">Needs Follow-up</option>
              </select>
              <span className="sub">Auto-suggested: {auto}{status !== auto && status !== 'Needs Follow-up' ? ' (manual override)' : ''}</span>
            </div>
          </label>
          <label className="full">Officer Signature
            <div className="sig-pad-wrap">
              <canvas ref={canvasRef} width={420} height={140}
                className="sig-pad"
                onPointerDown={readOnly ? undefined : startDraw}
                onPointerMove={readOnly ? undefined : (e) => drawing.current && drawAt(e)}
                onPointerUp={readOnly ? undefined : endDraw}
                onPointerLeave={readOnly ? undefined : endDraw}
              />
              {!readOnly && (
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn tiny ghost" onClick={clearSig}>Clear</button>
                  <label className="btn tiny ghost" style={{ cursor: 'pointer' }}>
                    Upload
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={onSigFile} disabled={readOnly} />
                  </label>
                </div>
              )}
              {signatureUrl && <span className="sub" style={{ marginTop: 6, display: 'block' }}>✓ Signature captured</span>}
            </div>
          </label>
        </div>
      </SectionCard>

      {/* Hidden printable sheet for PDF export (HP letterhead + full report) */}
      <div style={{ position: 'absolute', left: -99999, top: 0, width: '760px' }}>
        <InspectionSheet
          ref={sheetRef}
          data={{
            inspectionId: initial?.inspectionId || nextId,
            inspectionDate, inspectionTime, policeStation, officerName, officerRank,
            inchargeName, prevDate, status, body, signatureUrl,
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable sub-components
// ---------------------------------------------------------------------------
function SectionCard({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="panel insp-section">
      <div className="panel-head">
        <h2><span className="sec-num">{n}</span>{title}</h2>
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

function PairGroup({ section, fields, body, errors, readOnly, onValue, setField }: {
  section: keyof InspectionBody; fields: PairField[]; body: InspectionBody;
  errors: Record<string, string>; readOnly: boolean;
  onValue: (s: keyof InspectionBody, k: string, v: string) => void;
  setField: (s: keyof InspectionBody, k: string, v: string) => void;
}) {
  const data: any = (body[section] as any) || {};
  return (
    <div className="form-grid">
      {fields.map(f => {
        const val = data[f.key] || '';
        const remErr = errors[section + '.' + f.key];
        return (
          <div key={f.key} className="pair-field">
            <label className={remErr ? 'has-err' : ''}>{f.label}
              <select value={val} disabled={readOnly} onChange={e => onValue(section, f.key, e.target.value)}>
                <option value="">— Select —</option>
                {f.options.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              {remErr && <span className="field-error">{remErr}</span>}
            </label>
            <label>Remarks
              <textarea value={data[f.key + 'Remarks'] || ''} disabled={readOnly}
                onChange={e => setField(section, f.key + 'Remarks', e.target.value)}
                placeholder={REMARKS_REQUIRED.has(val) ? 'Required — explain this finding' : 'Optional'} />
            </label>
          </div>
        );
      })}
    </div>
  );
}

function PairInline({ section, field, body, errors, readOnly, onValue, setField }: {
  section: keyof InspectionBody; field: PairField; body: InspectionBody;
  errors: Record<string, string>; readOnly: boolean;
  onValue: (s: keyof InspectionBody, k: string, v: string) => void;
  setField: (s: keyof InspectionBody, k: string, v: string) => void;
}) {
  const data: any = (body[section] as any) || {};
  const val = data[field.key] || '';
  const remErr = errors[section + '.' + field.key];
  return (
    <div className="pair-field">
      <label className={remErr ? 'has-err' : ''}>{field.label}
        <select value={val} disabled={readOnly} onChange={e => onValue(section, field.key, e.target.value)}>
          <option value="">— Select —</option>
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        {remErr && <span className="field-error">{remErr}</span>}
      </label>
      <label>Remarks
        <textarea value={data[field.key + 'Remarks'] || ''} disabled={readOnly}
          onChange={e => setField(section, field.key + 'Remarks', e.target.value)} />
      </label>
    </div>
  );
}

function NumberField({ label, value, disabled, onChange }: {
  label: string; value: string; disabled?: boolean; onChange: (v: string) => void;
}) {
  return (
    <label>{label}
      <input type="number" min={0} value={value} disabled={disabled}
        onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function StatusBadge({ status }: { status: InspectionStatus }) {
  const cls = status === 'Compliant' ? 'insp-compliant'
    : status === 'Non-Compliant' ? 'insp-noncompliant'
    : status === 'Needs Follow-up' ? 'insp-followup' : 'insp-pending';
  return <span className={`stamp ${cls}`}>{status}</span>;
}

// Hidden sheet rendered to PDF (HP crest + full report).  forwardRef so the
// parent can rasterize it.
const InspectionSheet = forwardRef<HTMLDivElement, { data: any }>(({ data }, ref) => {
  const b = data.body || {};
  const rv = b.registerVerification || {};
  const pv = b.physicalVerification || {};
  const cp = b.casePropertyStatus || {};
  const sc = b.specialCategoryCheck || {};
  const mc = b.malkhanaCondition || {};
  const row = (k: string, v: any) => (
    <div className="sh-row"><span className="sh-k">{k}</span><span className="sh-v">{v || '—'}</span></div>
  );
  return (
    <div className="insp-sheet" ref={ref}>
      <div className="insp-sheet-head">
        <div className="emblem">HP</div>
        <div>
          <div className="l1">Haryana Police · Digital Records</div>
          <div className="l2">e-Malkhana — Malkhana Inspection Report</div>
        </div>
      </div>
      <h3 className="insp-sheet-title">{data.inspectionId}</h3>
      <div className="sh-grid">
        {row('Date', data.inspectionDate)}
        {row('Time', data.inspectionTime)}
        {row('Police Station', data.policeStation)}
        {row('Inspecting Officer', `${data.officerName} (${data.officerRank})`)}
        {row('Malkhana In-charge', data.inchargeName)}
        {row('Previous Inspection', data.prevDate || 'First')}
        {row('Overall Status', data.status)}
      </div>

      <h4>Register Verification</h4>
      {row('Malkhana Register Updated', `${rv.malkhanaRegisterUpdated || '—'}${rv.malkhanaRegisterRemarks ? ' — ' + rv.malkhanaRegisterRemarks : ''}`)}
      {row('Case Property Register Verified', `${rv.casePropertyRegisterVerified || '—'}${rv.casePropertyRegisterRemarks ? ' — ' + rv.casePropertyRegisterRemarks : ''}`)}
      {row('General Diary Cross-check', `${rv.generalDiaryCrosscheck || '—'}${rv.generalDiaryRemarks ? ' — ' + rv.generalDiaryRemarks : ''}`)}

      <h4>Physical Verification</h4>
      {row('Articles Count Match', `${pv.articlesCountMatch || '—'}${pv.articlesCountRemarks ? ' — ' + pv.articlesCountRemarks : ''}`)}
      {row('Seals / Packets Status', `${pv.sealsPacketsStatus || '—'}${pv.sealsPacketsRemarks ? ' — ' + pv.sealsPacketsRemarks : ''}`)}
      {row('Numbering / Labeling Correct', `${pv.numberingLabelingCorrect || '—'}${pv.numberingLabelingCorrectRemarks ? ' — ' + pv.numberingLabelingCorrectRemarks : ''}`)}

      <h4>Case Property Status</h4>
      {row('Court Disposal Pending', cp.courtDisposalPendingCount || '0')}
      {row('NDPS Properties Disposal', `${cp.ndpsPropertiesDisposalStatus || '—'}${cp.ndpsPropertiesDisposalRemarks ? ' — ' + cp.ndpsPropertiesDisposalRemarks : ''}`)}
      {row('FSL Exhibits Pending', cp.fslExhibitsPendingCount || '0')}
      {row('FSL Exhibits Remarks', cp.fslExhibitsRemarks || '—')}
      {row('Old / Unclaimed Property', `${cp.oldUnclaimedPropertyCount || '0'}${cp.oldUnclaimedPropertyList ? ' — ' + cp.oldUnclaimedPropertyList : ''}`)}

      <h4>Special Category Check</h4>
      {row('Cash / Gold / Silver Verified', `${sc.cashGoldSilverVerified || '—'}${sc.cashGoldSilverRemarks ? ' — ' + sc.cashGoldSilverRemarks : ''}`)}
      {row('Arms / Ammunition Checked', `${sc.armsAmmunitionChecked || '—'}${sc.armsAmmunitionRemarks ? ' — ' + sc.armsAmmunitionRemarks : ''}`)}
      {row('Perishable Narcotics Condition', `${sc.perishableNarcoticsCondition || '—'}${sc.perishableNarcoticsRemarks ? ' — ' + sc.perishableNarcoticsRemarks : ''}`)}

      <h4>Malkhana Condition</h4>
      {row('Security / Locks / Seals', `${mc.securityLocksSeals || '—'}${mc.securityLocksSealsRemarks ? ' — ' + mc.securityLocksSealsRemarks : ''}`)}
      {row('Cleanliness / Pest Control', `${mc.cleanlinessPestControl || '—'}${mc.cleanlinessPestControlRemarks ? ' — ' + mc.cleanlinessPestControlRemarks : ''}`)}
      {row('Fire Safety', `${mc.fireSafety || '—'}${mc.fireSafetyRemarks ? ' — ' + mc.fireSafetyRemarks : ''}`)}
      {row('Storage Space Adequacy', `${mc.storageSpaceAdequacy || '—'}${mc.storageSpaceAdequacyRemarks ? ' — ' + mc.storageSpaceAdequacyRemarks : ''}`)}

      <h4>Discrepancy & Observations</h4>
      {row('Discrepancies Found', b.discrepanciesFound || '—')}
      {row('Previous Remarks Compliance', b.previousRemarksComplianceStatus || '—')}
      {row('New Remarks / Suggestions', b.newRemarksSuggestions || '—')}

      {data.signatureUrl && (
        <div className="sh-sign">
          <div>Officer Signature</div>
          <img src={data.signatureUrl} alt="signature" />
        </div>
      )}
    </div>
  );
});
InspectionSheet.displayName = 'InspectionSheet';

// Standalone PDF export for a saved record (list → PDF button).
async function exportRecordPdf(rec: InspectionReport) {
  // Render a temporary sheet off-screen, rasterize, download, then remove.
  const host = document.createElement('div');
  host.style.position = 'absolute'; host.style.left = '-99999px'; host.style.top = '0';
  host.style.width = '760px';
  document.body.appendChild(host);
  const root = document.createElement('div');
  host.appendChild(root);
  const r = createRoot(root);
  r.render(<InspectionSheet ref={() => {}} data={{
    inspectionId: rec.inspectionId, inspectionDate: rec.inspectionDate, inspectionTime: rec.inspectionTime,
    policeStation: rec.policeStation, officerName: rec.inspectingOfficerName, officerRank: rec.inspectingOfficerRank,
    inchargeName: rec.malkhanaInchargeName, prevDate: rec.previousInspectionDate || null, status: rec.overallStatus,
    body: rec.report, signatureUrl: rec.signatureUrl,
  }} />);
  // allow paint
  await new Promise(res => setTimeout(res, 120));
  try {
    const canvas = await html2canvas(root.firstElementChild as HTMLElement, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const availW = pw - margin * 2;
    const ratio = canvas.height / canvas.width;
    let w = availW, h = w * ratio;
    if (h > ph - margin * 2) { h = ph - margin * 2; w = h / ratio; }
    const x = (pw - w) / 2, y = margin;
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, w, h);
    pdf.save(`${rec.inspectionId.replace(/[^\\w\\-]+/g, '_')}.pdf`);
  } finally {
    r.unmount();
    document.body.removeChild(host);
  }
}
