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
  fields: CategoryField[];
}

export const ITEM_CATEGORIES: ItemCategory[] = [
  {
    id: 'narcotics',
    label: 'Narcotics / NDPS Article',
    sectionLetter: 'A',
    subTypeLabel: 'Narcotic Type',
    // Sub-types mirror the official NDPS Quantity Classification Table exactly
    // (so the Small / Intermediate / Commercial thresholds map 1:1 to a substance).
    subTypes: [
      'Heroin (Diacetylmorphine)',
      'Ganja (Cannabis)',
      'Charas / Hashish',
      'Opium',
      'Poppy Straw',
      'Cocaine',
      'Alprazolam',
      'Codeine (Cough Syrups)',
    ],
    // Only the required narcotics columns are kept (Narcotic Type, Quantity Seized,
    // Item Description, Photo) — remaining detailed columns were removed per request.
    fields: [
      { key: 'quantity_seized', label: 'Quantity Seized (g/kg)', type: 'text', placeholder: 'e.g. 250 g / 1.2 kg', unit: 'g/kg' },
    ],
  },
  {
    id: 'arms',
    label: 'Arms & Ammunition',
    sectionLetter: 'B',
    subTypeLabel: 'Type',
    subTypes: [
      'Firearms (Pistol, Revolver, Rifle, Gun)',
      'Sharp weapons (Knife, Sword, Farsa, Gandasa)',
      'Blunt weapons (Lathi, Danda, Iron rod)',
      'Explosives/Bombs',
    ],
    fields: [
      { key: 'no_of_weapons', label: 'No. of Weapons', type: 'number' },
      { key: 'caliber', label: 'Caliber / Bore', type: 'text', placeholder: 'e.g. .315 / 7.62 mm' },
      { key: 'licensed', label: 'Licensed / Unlicensed', type: 'select', options: ['Licensed', 'Unlicensed', 'Not Known'] },
      { key: 'working_condition', label: 'Working Condition', type: 'select', options: ['Yes', 'No'] },
      { key: 'no_of_rounds', label: 'No. of Rounds', type: 'number' },
      { key: 'ballistic_sent', label: 'Ballistic Report Sent', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  {
    id: 'cash',
    label: 'Currency & Valuables',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Indian currency (genuine)', 'Fake/Counterfeit currency', 'Foreign currency'],
    fields: [
      { key: 'denom_breakup', label: 'Denomination-wise breakup', type: 'text', placeholder: '₹2000: 100, ₹500: 80 …' },
      { key: 'total_amount', label: 'Total Amount', type: 'number', unit: 'Rs.' },
      { key: 'currency_type', label: 'Currency Type', type: 'select', options: ['Indian', 'Foreign'] },
      { key: 'note_numbers', label: 'Note Numbers (if recorded)', type: 'text', placeholder: 'esp. trap cases' },
      { key: 'counterfeit', label: 'Suspected Counterfeit', type: 'select', options: ['Yes', 'No'] },
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
    fields: [
      { key: 'reg_no', label: 'Registration No.', type: 'text' },
      { key: 'chassis_no', label: 'Chassis No.', type: 'text' },
      { key: 'engine_no', label: 'Engine No.', type: 'text' },
      { key: 'make_model', label: 'Make / Model', type: 'text' },
      { key: 'colour', label: 'Colour', type: 'text' },
      { key: 'stolen_used', label: 'Stolen / Used in Crime', type: 'select', options: ['Stolen', 'Used in Crime', 'Both', 'No'] },
      { key: 'owner_name', label: 'Owner Name', type: 'text' },
      { key: 'vehicle_condition', label: 'Vehicle Condition', type: 'select', options: ['Running', 'Damaged', 'Non-functional'] },
    ],
  },
  {
    id: 'electronic',
    label: 'Electronic / Digital Evidence',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Mobile phones', 'Laptops/Computers', 'SIM cards/Memory cards', 'Other electronic devices'],
    fields: [
      { key: 'imei_no', label: 'IMEI No. (mobile)', type: 'text' },
      { key: 'brand_model', label: 'Brand / Model', type: 'text' },
      { key: 'password_pin', label: 'Password / PIN (if known)', type: 'text' },
      { key: 'data_extraction', label: 'Data Extraction Done', type: 'select', options: ['Yes', 'No'] },
      { key: 'forensic_sent', label: 'Forensic Lab Sent', type: 'select', options: ['Yes', 'No'] },
      { key: 'cloud_requested', label: 'Cloud / Call Data Requested', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  {
    id: 'liquor',
    label: 'Liquor (Illicit / NDPS-Excise)',
    sectionLetter: 'A',
    subTypeLabel: 'Type',
    subTypes: ['Country liquor (illicit)', 'Foreign/IMFL liquor', 'Empty bottles/manufacturing equipment'],
    fields: [
      { key: 'quantity2', label: 'Quantity', type: 'text', placeholder: 'Liters / Bottles / Pouches' },
      { key: 'no_of_bottles', label: 'No. of Bottles / Pouches', type: 'number' },
      { key: 'brand_name', label: 'Brand Name (if foreign liquor)', type: 'text' },
      { key: 'sample_sent', label: 'Sample Sent', type: 'select', options: ['Yes', 'No'] },
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
  { subType: 'Heroin (Diacetylmorphine)', small: 5,          commercial: 250 },
  { subType: 'Ganja (Cannabis)',          small: 1000,       commercial: 20000 },
  { subType: 'Charas / Hashish',          small: 100,        commercial: 1000 },
  { subType: 'Opium',                     small: 25,         commercial: 2500 },
  { subType: 'Poppy Straw',               small: 1000,       commercial: 50000 },
  { subType: 'Cocaine',                   small: 2,          commercial: 100 },
  { subType: 'Alprazolam',                small: 5,          commercial: 100 },
  { subType: 'Codeine (Cough Syrups)',    small: 10,         commercial: 1000 },
];

// Human-readable threshold table rows (for help/legend UI).
export interface NdpsTableRow {
  name: string;
  small: string;
  commercial: string;
  intermediate: string;
}
export const NDPS_TABLE: NdpsTableRow[] = [
  { name: 'Heroin (Diacetylmorphine)', small: 'Up to 5 g',        commercial: 'Above 250 g',         intermediate: '> 5 g but < 250 g' },
  { name: 'Ganja (Cannabis)',          small: 'Up to 1 kg',       commercial: 'Above 20 kg',          intermediate: '> 1 kg but < 20 kg' },
  { name: 'Charas / Hashish',          small: 'Up to 100 g',      commercial: 'Above 1 kg',           intermediate: '> 100 g but < 1 kg' },
  { name: 'Opium',                     small: 'Up to 25 g',       commercial: 'Above 2.5 kg',         intermediate: '> 25 g but < 2.5 kg' },
  { name: 'Poppy Straw',               small: 'Up to 1 kg',       commercial: 'Above 50 kg',          intermediate: '> 1 kg but < 50 kg' },
  { name: 'Cocaine',                   small: 'Up to 2 g',        commercial: 'Above 100 g',          intermediate: '> 2 g but < 100 g' },
  { name: 'Alprazolam',                small: 'Up to 5 g',        commercial: 'Above 100 g',          intermediate: '> 5 g but < 100 g' },
  { name: 'Codeine (Cough Syrups)',    small: 'Up to 10 g',       commercial: 'Above 1 kg',           intermediate: '> 10 g but < 1 kg' },
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
