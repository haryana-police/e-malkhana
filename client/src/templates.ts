// e-Malkhana — printable form templates.
//
// Each template is a fill-in-the-blanks form: the field LABELS are fixed
// (Haryana Police / Malkhana boilerplate) but the VALUES are intentionally
// blank so an officer can hand-fill the printed sheet.  The `blankTemplate`
// helper lets the user generate a *custom* blank form from their own list of
// field names typed into the Templates page.

export type FieldType = 'text' | 'date' | 'time' | 'number' | 'textarea';

export interface DocField {
  key: string;
  label: string;
  type?: FieldType;
  /** Optional hint shown under the fill line (e.g. "BNS section no."). */
  hint?: string;
}

export interface FormTemplate {
  id: string;
  name: string;
  sub: string;
  fields: DocField[];
}

export const formTemplates: FormTemplate[] = [
  {
    id: 'seizure-memo',
    name: 'Seizure Memo',
    sub: 'Memo of articles seized during investigation (s. 102 Cr.P.C. / BNS)',
    fields: [
      { key: 'fir', label: 'FIR / DD No.', type: 'text' },
      { key: 'date', label: 'Date of Seizure', type: 'date' },
      { key: 'time', label: 'Time of Seizure', type: 'time' },
      { key: 'place', label: 'Place of Seizure', type: 'text', hint: 'address / landmark' },
      { key: 'item', label: 'Article / Item Seized', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'text' },
      { key: 'desc', label: 'Description / Particulars', type: 'textarea' },
      { key: 'bns', label: 'Section (BNS)', type: 'text', hint: 'e.g. 303, 379' },
      { key: 'officer', label: 'Seizing Officer', type: 'text' },
      { key: 'w1', label: 'Witness 1 (Name & Father’s name)', type: 'text' },
      { key: 'w2', label: 'Witness 2 (Name & Father’s name)', type: 'text' },
      { key: 'ps', label: 'Police Station', type: 'text' },
    ],
  },
  {
    id: 'recovery-memo',
    name: 'Recovery Memo',
    sub: 'Memo of recovery of stolen / incriminating article',
    fields: [
      { key: 'fir', label: 'FIR / DD No.', type: 'text' },
      { key: 'date', label: 'Date of Recovery', type: 'date' },
      { key: 'time', label: 'Time of Recovery', type: 'time' },
      { key: 'place', label: 'Place of Recovery', type: 'text' },
      { key: 'recFrom', label: 'Recovered From', type: 'text', hint: 'accused / premises / search' },
      { key: 'accused', label: 'Accused Name', type: 'text' },
      { key: 'item', label: 'Article Recovered', type: 'text' },
      { key: 'qty', label: 'Quantity', type: 'text' },
      { key: 'bns', label: 'Section (BNS)', type: 'text' },
      { key: 'officer', label: 'Investigating Officer', type: 'text' },
      { key: 'witness', label: 'Witness (Name & Father’s name)', type: 'text' },
      { key: 'ps', label: 'Police Station', type: 'text' },
    ],
  },
  {
    id: 'malkhana-inward',
    name: 'Malkhana Inward Entry',
    sub: 'Receipt of case property into the Malkhana (inward register)',
    fields: [
      { key: 'itemId', label: 'Item ID / Tag No.', type: 'text' },
      { key: 'fir', label: 'FIR / DD No.', type: 'text' },
      { key: 'date', label: 'Date Received', type: 'date' },
      { key: 'from', label: 'Received From (Officer)', type: 'text' },
      { key: 'part', label: 'Part / Section Stored', type: 'text', hint: 'e.g. Part B — Weapons' },
      { key: 'desc', label: 'Article Description', type: 'textarea' },
      { key: 'qty', label: 'Quantity', type: 'text' },
      { key: 'cond', label: 'Condition at Receipt', type: 'text' },
      { key: 'mm', label: 'Malkhana In-charge', type: 'text' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
  {
    id: 'malkhana-outward',
    name: 'Malkhana Outward / Disposal',
    sub: 'Issue / disposal of case property from the Malkhana',
    fields: [
      { key: 'itemId', label: 'Item ID / Tag No.', type: 'text' },
      { key: 'fir', label: 'FIR / DD No.', type: 'text' },
      { key: 'date', label: 'Date of Issue / Disposal', type: 'date' },
      { key: 'auth', label: 'Issuing Authority', type: 'text', hint: 'Court / SSP order' },
      { key: 'purpose', label: 'Purpose', type: 'text', hint: 'production / FSL / disposal' },
      { key: 'to', label: 'Handed Over To', type: 'text' },
      { key: 'doc', label: 'Document Ref.', type: 'text', hint: 'order / memo no.' },
      { key: 'mm', label: 'Malkhana In-charge', type: 'text' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
  {
    id: 'inspection-report',
    name: 'Malkhana Inspection Report',
    sub: 'Daily / periodic inspection of the Malkhana by the SHO',
    fields: [
      { key: 'date', label: 'Date of Inspection', type: 'date' },
      { key: 'time', label: 'Time', type: 'time' },
      { key: 'by', label: 'Inspected By (Rank & Name)', type: 'text' },
      { key: 'parts', label: 'Part(s) / Section(s) Checked', type: 'text' },
      { key: 'items', label: 'Total Items Counted', type: 'number' },
      { key: 'short', label: 'Missing / Short / Damaged Items', type: 'textarea' },
      { key: 'action', label: 'Action Taken', type: 'textarea' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
  {
    id: 'production-diary',
    name: 'Production Diary Entry',
    sub: 'Record of accused / property produced before court',
    fields: [
      { key: 'accused', label: 'Accused Name', type: 'text' },
      { key: 'fir', label: 'FIR / DD No.', type: 'text' },
      { key: 'date', label: 'Date of Production', type: 'date' },
      { key: 'purpose', label: 'Purpose of Production', type: 'text' },
      { key: 'before', label: 'Produced Before (Court)', type: 'text' },
      { key: 'officer', label: 'Escorting Officer', type: 'text' },
      { key: 'remarks', label: 'Remarks', type: 'textarea' },
    ],
  },
];

// Build a custom blank template from a document title + a list of field
// names typed by the user.  Every field is left blank (fill-in-the-blanks).
export function blankTemplate(name: string, fieldLabels: string[]): FormTemplate {
  const clean = fieldLabels
    .map(l => (l || '').toString().trim())
    .filter(Boolean)
    .map((l, i) => ({ key: `cf${i}`, label: l }));
  return {
    id: 'custom-' + Date.now().toString(36),
    name: name.trim() || 'Custom Blank Form',
    sub: 'Custom blank template',
    fields: clean,
  };
}
