// Case Property — "Category of Item" master (per the spec's 10 categories).
//
// The spec asks for a CATEGORY dropdown that is SEPARATE from the legacy
// "Item Type" (which maps to a Malkhana Section A–E).  Each category has:
//   * a list of sub-types (the inner dropdown, e.g. Narcotic Type), and
//   * a set of sub-parameters (the per-item specific fields), and
//   * a default Malkhana Section it should be placed in (so the register
//     Part is auto-suggested but still editable per item).
//
// Each sub-parameter is rendered as a field in the per-item popup.  `type`
// controls the input: text | number | select | date | time.  `options`
// (for select) and `placeholder` are optional.

export type FieldType = 'text' | 'number' | 'select' | 'date' | 'time';

export interface CategoryField {
  key: string;            // stable snake_case id
  label: string;          // display label
  type: FieldType;
  options?: string[];     // for select
  placeholder?: string;
  unit?: string;          // e.g. "grams", "Rs."
}

export interface ItemCategory {
  id: string;             // stable id, e.g. "narcotics"
  label: string;          // display label, e.g. "Narcotics / NDPS Article"
  sectionLetter: string;  // suggested Malkhana Part (A–E)
  subTypes?: string[];    // the inner type dropdown options
  subTypeLabel?: string;  // label for the sub-type dropdown, e.g. "Narcotic Type"
  subTypeControl?: 'select' | 'radio';  // how subType is rendered (default: select)
  fields: CategoryField[];
}

export const ITEM_CATEGORIES: ItemCategory[] = [
  {
    id: 'narcotics',
    label: 'Narcotics / NDPS Article',
    sectionLetter: 'A',
    subTypeLabel: 'Narcotic Type',
    // Sub-types are the narcotic drugs / psychotropic substances named in the
    // NDPS Act 1985 — the Act's Schedule ("List of Psychotropic Substances",
    // Sl. 1–110ZT) plus the narcotic-drug definitions in s.2 (cannabis/ganja,
    // charas/hashish, opium, opium derivatives incl. heroin/morphine/codeine).
    // Verified 1:1 against the NDPS Act 1985 PDF (Sl. Nos noted inline below).
    // NOTE: the Act itself carries NO Small/Commercial gram numbers — s.2(viia)/
    // (xxiiia) define those only as "the quantity specified by the Central
    // Government by notification". The gram thresholds in NDPS_THRESHOLDS /
    // NDPS_TABLE come from the NDPS Rules, 1985 Schedule (the notified table),
    // which is the authoritative source for the numbers. Names here MUST match
    // NDPS_THRESHOLDS and NDPS_TABLE (used by the classifier + help legend).
    subTypes: [
      'Alprazolam',        // Act Sch. Sl. 30
      'Amphetamine',       // Act Sch. Sl. 16
      'Buprenorphine',     // Act Sch. Sl. 92
      'Charas / Hashish',  // NDPS Act s.2 — cannabis (charas/hashish)
      'Cocaine',           // NDPS Act s.2 — coca leaf / cocaine
      'Codeine',           // NDPS Act s.2 — opium derivative
      'Diazepam',          // Act Sch. Sl. 43
      'Ganja',             // NDPS Act s.2 — cannabis (ganja)
      'Heroin',            // NDPS Act s.2 — opium derivative
      'Ketamine',          // Act Sch. Sl. 110A
      'Lysergide (LSD)',   // Act Sch. Sl. 4 (LYSERGIDE)
      'MDMA / Ecstasy',    // Act Sch. Sl. 80 (MDMA)
      'Methamphetamine',   // Act Sch. Sl. 19
      'Methadone',         // NDPS Rules list (methadone)
      'Methaqualone',      // Act Sch. Sl. 20
      'Morphine',          // NDPS Act s.2 — opium derivative
      'Opium',             // NDPS Act s.2 — opium
      'Opium Derivatives',  // NDPS Act s.2 — opium derivatives (incl. the above)
      'Poppy Straw',       // NDPS Act s.2 — poppy straw
      'Tramadol',          // Act Sch. Sl. 110Y
    ],
    // Only the required narcotics columns are kept (Narcotic Type, Quantity Seized,
    // Item Description, Photo) — remaining detailed columns were removed per request.
    fields: [
      { key: 'quantity_seized', label: 'Quantity Seized', type: 'text', placeholder: 'e.g. 250 g / 1.2 kg', unit: 'g/kg' },
    ],
  },
  {
    id: 'arms',
    label: 'Arms & Ammunition',
    sectionLetter: 'B',
    subTypeLabel: 'Type',
    subTypeControl: 'radio',
    subTypes: [
      'Firearms',
      'Other Weapons',
    ],
    // Only the required Arms & Ammunition columns are kept on the register
    // (Category, Malkhana Section, Type, Item Description, Photo).  The
    // detailed weapon spec columns (caliber, rounds, ballistic report, …)
    // are intentionally omitted — they are captured separately / later.
    fields: [],
  },
  {
    id: 'cash',
    label: 'Currency & Valuables',
    sectionLetter: 'C',
    // Only the highlighted Cash & Valuables columns are kept on the register:
    // Category, Malkhana Section, Total Amount, Item Description, Photo.
    // The non-highlighted columns (Type, Denomination breakup, Currency Type,
    // Note Numbers, Suspected Counterfeit, plus the shared Place of Seizure /
    // Sealed / Seal No. / Sealed By blocks) are deleted per request — they are
    // hidden in RegisterCaseModal for the 'cash' category.
    fields: [
      { key: 'total_amount', label: 'Total Amount', type: 'number', unit: 'Rs.' },
    ],
  },
  {
    id: 'gold',
    label: 'Jewellery',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Gold ornaments', 'Silver ornaments', 'Precious stones/jewellery'],
    fields: [
      { key: 'weight', label: 'Weight', type: 'text', unit: 'grams' },
      { key: 'purity', label: 'Purity', type: 'text', placeholder: 'Carat / Hallmark' },
      { key: 'no_of_pieces', label: 'No. of Pieces', type: 'number' },
      { key: 'approx_value', label: 'Approx. Value', type: 'number', unit: 'Rs.' },
      { key: 'valuation_by', label: 'Valuation Done By', type: 'text', placeholder: 'Jeweller / Govt. Approved' },
    ],
  },
  {
    id: 'vehicle',
    label: 'Vehicle',
    sectionLetter: 'D',
    subTypeLabel: 'Type',
    subTypes: ['Two-wheeler', 'Four-wheeler', 'Commercial vehicle', 'Vehicle parts/spare parts'],
    // Only the required (highlighted) Vehicle columns are kept on the register:
    // Category, Malkhana Section, Type, Item Description, Photo.  The detailed
    // vehicle spec columns (Registration / Chassis / Engine / Make-Model /
    // Colour / Stolen-Used / Owner / Condition) are removed per request — they
    // are hidden in RegisterCaseModal for the 'vehicle' category so each row
    // stays a clean 3-column layout.
    fields: [],
  },
  {
    id: 'lost_items',
    label: 'Lost Items',
    sectionLetter: 'C',
    // "Minimal" category: only the highlighted columns are rendered in the
    // register modal — Category (selector), Malkhana Section, Item Description
    // and Photo. No sub-types or extra fields.
    fields: [],
  },
  {
    id: 'liquor',
    label: 'Excise',
    sectionLetter: 'A',
    // Only the highlighted Excise columns are kept on the register:
    // Category, Malkhana Section, Quantity, Item Description, Photo.  The
    // detailed liquor columns (Type, Place of Seizure, Sealed/Unsealed,
    // Seal No./Mark, Sealed By, No. of Bottles/Pouches, Brand Name, Sample
    // Sent) are removed per request — the Type dropdown is force-suppressed
    // in RegisterCaseModal for the 'liquor' category (liquorNoType flag),
    // matching the trimmed narcotics/arms/cash/vehicle layout (each item
    // row stays a clean 3-column grid).
    fields: [
      { key: 'quantity2', label: 'Quantity', type: 'text', placeholder: 'Liters / Bottles / Pouches' },
    ],
  },
  {
    id: 'viscera',
    label: 'Viscera (Dead-body Case)',
    sectionLetter: 'E',
    fields: [
      { key: 'viscera_jar_no', label: 'Viscera Jar No.', type: 'text', placeholder: 'usually 3–4 jars' },
      { key: 'organs_included', label: 'Organs Included', type: 'text', placeholder: 'Stomach/Liver/Kidney/Blood/Intestine' },
      { key: 'sealed_by', label: 'Sealed By (PM Doctor)', type: 'text', placeholder: 'Doctor name' },
      { key: 'purpose', label: 'Purpose', type: 'text', placeholder: 'Poisoning suspected / preservation' },
    ],
  },
  {
    id: 'other',
    label: 'Miscellaneous',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Other/Unclassified items'],
    fields: [
      { key: 'other_desc', label: 'Description', type: 'text', placeholder: 'Describe the article' },
    ],
  },
];

export function getCategory(id: string | null | undefined): ItemCategory | undefined {
  if (!id) return undefined;
  return ITEM_CATEGORIES.find(c => c.id === id);
}

// =====================================================================
// NDPS QUANTITY CLASSIFICATION TABLE (Small / Intermediate / Commercial)
// ---------------------------------------------------------------------
// Thresholds are the officially-notified quantities under the NDPS Act.
// `small`      = Small Quantity threshold (≤)
// `commercial` = Commercial Quantity threshold (≥)
// Anything strictly between the two qualifies as Intermediate Quantity.
// Weights are stored in GRAMS so the classifier can compare numerically.
// =====================================================================
export interface NdpsThreshold {
  subType: string;     // EXACT match to a narcotics subType in ITEM_CATEGORIES
  small: number;       // grams
  commercial: number;  // grams
}

export const NDPS_THRESHOLDS: NdpsThreshold[] = [
  { subType: 'Alprazolam',          small: 5,      commercial: 100 },
  { subType: 'Amphetamine',         small: 2,      commercial: 50 },
  { subType: 'Buprenorphine',       small: 1,      commercial: 20 },
  { subType: 'Charas / Hashish',    small: 100,    commercial: 1000 },
  { subType: 'Cocaine',             small: 2,      commercial: 100 },
  { subType: 'Codeine',             small: 10,     commercial: 1000 },
  { subType: 'Diazepam',            small: 20,     commercial: 500 },
  { subType: 'Ganja',               small: 1000,   commercial: 20000 },
  { subType: 'Heroin',              small: 5,      commercial: 250 },
  { subType: 'Ketamine',            small: 10,     commercial: 500 },
  { subType: 'Lysergide (LSD)',     small: 0.002,  commercial: 0.1 },
  { subType: 'MDMA / Ecstasy',      small: 0.5,    commercial: 10 },
  { subType: 'Methamphetamine',     small: 2,      commercial: 50 },
  { subType: 'Methadone',           small: 2,      commercial: 50 },
  { subType: 'Methaqualone',        small: 20,     commercial: 500 },
  { subType: 'Morphine',            small: 5,      commercial: 250 },
  { subType: 'Opium',               small: 25,     commercial: 2500 },
  { subType: 'Opium Derivatives',   small: 5,      commercial: 250 },
  { subType: 'Poppy Straw',         small: 1000,   commercial: 50000 },
  { subType: 'Tramadol',            small: 5,      commercial: 250 },
];

// Human-readable threshold table rows (for help/legend UI).
export interface NdpsTableRow {
  name: string;
  small: string;
  commercial: string;
  intermediate: string;
}
export const NDPS_TABLE: NdpsTableRow[] = [
  { name: 'Alprazolam',           small: 'Up to 5 g',            commercial: 'Above 100 g',          intermediate: '> 5 g but < 100 g' },
  { name: 'Amphetamine',          small: 'Up to 2 g',            commercial: 'Above 50 g',           intermediate: '> 2 g but < 50 g' },
  { name: 'Buprenorphine',        small: 'Up to 1 g',            commercial: 'Above 20 g',           intermediate: '> 1 g but < 20 g' },
  { name: 'Charas / Hashish',     small: 'Up to 100 g',          commercial: 'Above 1 kg',           intermediate: '> 100 g but < 1 kg' },
  { name: 'Cocaine',              small: 'Up to 2 g',            commercial: 'Above 100 g',          intermediate: '> 2 g but < 100 g' },
  { name: 'Codeine',              small: 'Up to 10 g',           commercial: 'Above 1 kg',           intermediate: '> 10 g but < 1 kg' },
  { name: 'Diazepam',             small: 'Up to 20 g',           commercial: 'Above 500 g',          intermediate: '> 20 g but < 500 g' },
  { name: 'Ganja',                small: 'Up to 1 kg',           commercial: 'Above 20 kg',          intermediate: '> 1 kg but < 20 kg' },
  { name: 'Heroin',               small: 'Up to 5 g',            commercial: 'Above 250 g',          intermediate: '> 5 g but < 250 g' },
  { name: 'Ketamine',             small: 'Up to 10 g',           commercial: 'Above 500 g',          intermediate: '> 10 g but < 500 g' },
  { name: 'Lysergide (LSD)',      small: 'Up to 0.002 g',        commercial: 'Above 0.1 g',          intermediate: '> 0.002 g but < 0.1 g' },
  { name: 'MDMA / Ecstasy',       small: 'Up to 0.5 g',          commercial: 'Above 10 g',           intermediate: '> 0.5 g but < 10 g' },
  { name: 'Methamphetamine',      small: 'Up to 2 g',            commercial: 'Above 50 g',           intermediate: '> 2 g but < 50 g' },
  { name: 'Methadone',            small: 'Up to 2 g',            commercial: 'Above 50 g',           intermediate: '> 2 g but < 50 g' },
  { name: 'Methaqualone',         small: 'Up to 20 g',           commercial: 'Above 500 g',          intermediate: '> 20 g but < 500 g' },
  { name: 'Morphine',             small: 'Up to 5 g',            commercial: 'Above 250 g',          intermediate: '> 5 g but < 250 g' },
  { name: 'Opium',                small: 'Up to 25 g',           commercial: 'Above 2.5 kg',         intermediate: '> 25 g but < 2.5 kg' },
  { name: 'Opium Derivatives',    small: 'Up to 5 g',            commercial: 'Above 250 g',          intermediate: '> 5 g but < 250 g' },
  { name: 'Poppy Straw',          small: 'Up to 1 kg',           commercial: 'Above 50 kg',          intermediate: '> 1 kg but < 50 kg' },
  { name: 'Tramadol',             small: 'Up to 5 g',            commercial: 'Above 250 g',          intermediate: '> 5 g but < 250 g' },
];

export type NdpsClass = 'Small' | 'Intermediate' | 'Commercial' | 'Unknown';

/**
 * Parse a weight string like "250 g", "1.2 kg", "1 kg 200 g", "500" (assumed g)
 * into grams. Returns NaN when no number can be parsed.
 */
export function parseQuantityToGrams(raw: string): number {
  if (!raw) return NaN;
  const s = String(raw).toLowerCase().trim();
  if (!s) return NaN;

  let total = NaN;
  // Combined "X kg Y g" form (e.g. "1 kg 200 g")
  const combo = s.match(/([\d.]+)\s*kg\s*([\d.]+)\s*g/);
  if (combo) {
    total = parseFloat(combo[1]) * 1000 + parseFloat(combo[2]);
  } else {
    // Split by unit: sum every "<number> <unit>" token.
    let sum = 0;
    let found = false;
    const re = /([\d.]+)\s*(kg|kilogram|kgs|g|gm|gram|grams|mg|milligram)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const num = parseFloat(m[1]);
      if (Number.isNaN(num)) continue;
      const unit = (m[2] || 'g').toLowerCase();
      const mult = unit.startsWith('k') ? 1000 : unit.startsWith('m') ? 0.001 : 1;
      sum += num * mult;
      found = true;
    }
    if (found) total = sum;
  }
  return total;
}

/**
 * Classify a seized narcotics quantity into Small / Intermediate / Commercial
 * using the NDPS Quantity Classification Table for the given substance.
 * Returns 'Unknown' when the substance has no threshold or the quantity
 * cannot be parsed.
 */
export function classifyNdps(subType: string, quantityRaw: string): NdpsClass {
  if (!subType) return 'Unknown';
  const t = NDPS_THRESHOLDS.find(x => x.subType === subType);
  if (!t) return 'Unknown';
  const g = parseQuantityToGrams(quantityRaw);
  if (Number.isNaN(g)) return 'Unknown';
  if (g <= t.small) return 'Small';
  if (g >= t.commercial) return 'Commercial';
  return 'Intermediate';
}
