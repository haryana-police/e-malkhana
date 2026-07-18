// e-Malkhana — printable form templates.
//
// Each template is a fill-in-the-blanks form: the field LABELS are fixed
// (Haryana Police / Malkhana boilerplate) but the VALUES are intentionally
// blank so an officer can hand-fill the printed sheet.  The `blankTemplate`
// helper lets the user generate a *custom* blank form from their own list of
// field names typed into the Templates page.
//
// Templates are either:
//   kind: 'form'   — a list of labelled fields with dotted fill-lines
//                    (the original 6 registers, plus any custom blank form).
//   kind: 'letter' — a prose performa (application / letter) with inline
//                    blanks.  The three performa supplied in
//                    Downloads\templets.docx (Hindi applications) are of this
//                    kind and carry `hindi: true`.

import type { CaseRow } from './types';

export type FieldType = 'text' | 'date' | 'time' | 'number' | 'textarea';

export interface DocField {
  key: string;
  label: string;
  type?: FieldType;
  /** Optional hint shown under the fill line (e.g. "BNS section no."). */
  hint?: string;
}

export type TemplateKind = 'form' | 'letter';

export interface LetterParagraph {
  /** true = a fill-in-the-blank paragraph (renders an editable "_____" gap). */
  blank?: boolean;
  text: string;
}

// Structured Hindi letterhead (as seen on the official performa): the police
// station + district sit on ONE row, left/right aligned, followed by the
// "सेवा में" / judicial-authority / city lines.  Kept as data (not hand-typed
// prose) so every Hindi performa renders the identical official header.
export interface LetterHead {
  station: string;   // left  — e.g. थाना शहर
  district: string;  // right — e.g. जिला पानीपत
  service?: string;  // e.g. सेवा में
  authority: string; // e.g. मुख्य न्यायिक डंडाधिकारी / सत्र न्यायाधीश
  city: string;      // e.g. पानीपत
}

export interface FormTemplate {
  id: string;
  name: string;
  sub: string;
  /** 'form' = field list (fill-in-the-blanks sheet); 'letter' = prose performa. */
  kind?: TemplateKind;
  /** Present only for kind === 'letter'. */
  paragraphs?: LetterParagraph[];
  /** Structured official letterhead for Hindi performa (rendered top of sheet). */
  letterhead?: LetterHead;
  /** true for the 3 performa supplied in Downloads\\templets.docx (Hindi applications). */
  hindi?: boolean;
  fields: DocField[];
}

// Map an existing case (FIR/DD) row onto the field keys shared by the
// register-style templates.  Used by the "Fill from FIR no." selector so an
// officer doesn't re-type what is already recorded against the case.
export function firValues(c: CaseRow): Record<string, string> {
  const out: Record<string, string> = {
    fir: c.id || '',
    item: c.itemType || '',
    qty: c.quantity || '',
    desc: c.description || '',
    bns: (c.legalSections && c.legalSections.length ? c.legalSections : (c.legalSection ? [c.legalSection] : []))
      .map(s => `BNS ${s}`).join(', '),
    // letters label the BNS section as "धारा / Section"
    section: (c.legalSections && c.legalSections.length ? c.legalSections : (c.legalSection ? [c.legalSection] : []))
      .map(s => `BNS ${s}`).join(', '),
    officer: c.seizingOfficer || '',
    ps: '',
  };
  return out;
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
  {
    id: 'fsl-madhuban',
    name: 'FSL Report Handover — Madhuban (Karnal)',
    sub: 'अपने पास जमा माल मुकदमा की FSL रिपोर्ट कांस्टेबल को सौंपने हेतु आवेदन — डायरेक्टर, न्यायवेदिक प्रयोगशाला, मधुबन (करनाल)',
    kind: 'letter',
    hindi: true,
    letterhead: {
      station: 'थाना शहर',
      district: 'जिला पानीपत',
      service: 'सेवा में',
      authority: 'डायरेक्टर न्यायवेदिक प्रयोगशाला',
      city: 'मधुबन (करनाल)',
    },
    fields: [
      { key: 'kr_number', label: 'क्रमांक संख्या / Reference No.', type: 'text' },
      { key: 'kr_date', label: 'दिनांक / Date', type: 'date' },
      { key: 'fir', label: 'मुकदमा नंबर / FIR No.', type: 'text', hint: 'e.g. 01 दिनांक 01/01/26' },
      { key: 'section', label: 'धारा / Section', type: 'text', hint: 'e.g. 302 BNS' },
      { key: 'rc', label: 'RC No.', type: 'text', hint: 'माल मुकदमा RC NO' },
      { key: 'rc_date', label: 'RC Date', type: 'date' },
      { key: 'constable', label: 'सिपाही का नाम / Constable Name', type: 'text' },
      { key: 'belt', label: 'बेल्ट नंबर / Belt No.', type: 'text' },
      { key: 'next_date', label: 'अगली तारीख / Next Court Date', type: 'date' },
    ],
    paragraphs: [
      { blank: true, text: 'क्रमांक संख्या {{kr_number}} दिनांक {{kr_date}} –' },
      { blank: true, text: 'विषय – मुकदमा नंबर {{fir}} धारा {{section}} भारतीय न्याय संहिता' },
      { text: 'श्री मान जी ,' },
      {
        blank: true,
        text: 'निवेदन यह है की मुकदमा नंबर {{fir}} धारा {{section}} भारतीय न्याय संहिता मे माल मुकदमा {{rc}} क अनुसार सिपाही {{constable}} बेल्ट नंबर {{belt}} द्वारा दिनांक {{rc_date}} को आपके पास जमा करवाया गया था |जो उपरोक्त मुकदमा हजा की माननीय अदालत मे आगामी तारीख {{next_date}} है | अतः आपसे से निवेदन है की मुकदमा हजा की FSL रिपोर्ट सिपाही --------------- बेल्ट नंबर ------- को दी जावे |ताकि समय पर माननीय अदालत मे पेश की जा सके |',
      },
      { text: 'थाना प्रबंधक' },
      { text: 'शहर पानीपत' },
    ],
  },
  {
    id: 'destroy-court-application',
    name: 'Application to Court — Destroy Case Property',
    sub: 'न्यायालय के आदेश हेतु आवेदन — तयशुदा (निर्णीत) मुकदमों की केस प्रॉपर्टी (माल मुकदमा) को नष्ट करने की अनुमति बारे — मुख्य न्यायिक दंडाधिकारी / सत्र न्यायाधीश, पानीपत',
    kind: 'letter',
    hindi: true,
    letterhead: {
      station: 'थाना शहर',
      district: 'जिला पानीपत',
      service: 'सेवा में',
      authority: 'मुख्य न्यायिक दंडाधिकारी / सत्र न्यायाधीश',
      city: 'पानीपत',
    },
    fields: [
      { key: 'court', label: 'न्यायालय / Court', type: 'text', hint: 'मुख्य न्यायिक दंडाधिकारी / सत्र न्यायाधीश' },
      { key: 'fir', label: 'मुकदमा नंबर / FIR No.', type: 'text' },
      { key: 'fir_date', label: 'मुकदमा दिनांक / FIR Date', type: 'date' },
      { key: 'section', label: 'धारा / Section', type: 'text' },
      { key: 'ps', label: 'थाना / Police Station', type: 'text' },
      { key: 'decision_date', label: 'फैसले की तारीख / Date of Judgment', type: 'date' },
    ],
    paragraphs: [
      { blank: true, text: 'मुकदमा नंबर: {{fir}} दिनांक: {{fir_date}} धारा: {{section}} थाना: {{ps}}' },
      { blank: true, text: 'विषय: मुकदमा उपरोक्त में तयशुदा केस प्रॉपर्टी (माल मुकदमा) को नष्ट करने की अनुमति प्रदान करने बारे।' },
      { text: 'श्रीमतीमान जी,' },
      {
        text: 'निवेदन यह है कि उपरोक्त मुकदमा यह कि माननीय न्यायालय द्वारा इस मुकदमे का अंतिम फैसला दिनांक [यहाँ फैसले की तारीख लिखें] को सुनाया जा चुका है ।यह कि इस मुकदमे से संबंधित केस प्रॉपर्टी ,जिसका विवरण नीचे दिया गया है, वर्तमान में थाना के मालखाना में जमा है| यह कि इस मुकदमे की अपील (Appeal) या निगरानी (Revision) की निर्धारित समयावधि समाप्त हो चुकी है और अब इस केस प्रॉपर्टी को मालखाने में सुरक्षित रखने का कोई कानूनी औचित्य नहीं रह गया है। मालखाने में जगह की कमी और माल के खराब होने की संभावना को देखते हुए इसे नष्ट किया जाना आवश्यक है।:अतः आपसे से विनम्र प्रार्थना है कि उपरोक्त तयशुदा केस प्रॉपर्टी को नियमानुसार नष्ट करने की अनुमति प्रदान करने की कृपा करें।',
      },
      { text: 'थाना प्रबंधक' },
      { text: 'शहर पानीपत' },
    ],
  },
  {
    id: 'fsl-panchkula',
    name: 'FSL Report Handover — Panchkula',
    sub: 'अपने पास जमा माल मुकदमा की FSL रिपोर्ट कांस्टेबल को सौंपने हेतु आवेदन — असिस्टन्ट डायरेक्टर, न्यायवेदिक प्रयोगशाला, पंचकुला',
    kind: 'letter',
    hindi: true,
    letterhead: {
      station: 'थाना शहर',
      district: 'जिला पानीपत',
      service: 'सेवा में',
      authority: 'असिस्टन्ट डायरेक्टर न्यायवेदिक प्रयोगशाला',
      city: 'पंचकुला',
    },
    fields: [
      { key: 'kr_number', label: 'क्रमांक संख्या / Reference No.', type: 'text' },
      { key: 'kr_date', label: 'दिनांक / Date', type: 'date' },
      { key: 'fir', label: 'मुकदमा नंबर / FIR No.', type: 'text', hint: 'e.g. 01 दिनांक 01/01/26' },
      { key: 'section', label: 'धारा / Section', type: 'text', hint: 'e.g. 302 BNS' },
      { key: 'rc', label: 'RC No.', type: 'text', hint: 'माल मुकदमा RC NO' },
      { key: 'rc_date', label: 'RC Date', type: 'date' },
      { key: 'constable', label: 'सिपाही का नाम / Constable Name', type: 'text' },
      { key: 'belt', label: 'बेल्ट नंबर / Belt No.', type: 'text' },
      { key: 'next_date', label: 'अगली तारीख / Next Court Date', type: 'date' },
    ],
    paragraphs: [
      { blank: true, text: 'क्रमांक संख्या {{kr_number}} दिनांक {{kr_date}} –' },
      { blank: true, text: 'विषय – मुकदमा नंबर {{fir}} धारा {{section}} भारतीय न्याय संहिता' },
      { text: 'श्री मान जी ,' },
      {
        blank: true,
        text: 'निवेदन यह है की मुकदमा नंबर {{fir}} धारा {{section}} भारतीय न्याय संहिता मे माल मुकदमा {{rc}} क अनुसार सिपाही {{constable}} बेल्ट नंबर {{belt}} द्वारा दिनांक {{rc_date}} को आपके पास जमा करवाया गया था |जो उपरोक्त मुकदमा हजा की माननीय अदालत मे आगामी तारीख {{next_date}} है | अतः आपसे से निवेदन है की मुकदमा हजा की FSL रिपोर्ट सिपाही --------------- बेल्ट नंबर ------- को दी जावे |ताकि समय पर माननीय अदालत मे पेश की जा सके |',
      },
      { text: 'थाना प्रबंधक' },
      { text: 'शहर पानीपत' },
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
    kind: 'form',
    fields: clean,
  };
}
