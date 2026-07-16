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
    subTypes: [
      'Heroin (Smack)', 'Charas/Hashish', 'Ganja (Cannabis)', 'Opium (Afeem)',
      'Cocaine', 'MDMA/Ecstasy', 'Ketamine', 'Poppy Husk (Doda/Post)',
      'Pseudoephedrine/Precursor Chemical', 'Other Psychotropic Substance',
    ],
    fields: [
      { key: 'quantity_seized', label: 'Quantity Seized', type: 'text', placeholder: 'e.g. 250 g / 1.2 kg', unit: 'g/kg' },
      { key: 'packing_type', label: 'Packing Type', type: 'select', options: ['Pouch', 'Packet', 'Loose', 'Bottle', 'Other'] },
      { key: 'no_of_packets', label: 'No. of Packets', type: 'number' },
      { key: 'sample_drawn', label: 'Sample Drawn', type: 'select', options: ['Yes', 'No'] },
      { key: 'sample_qty', label: 'Qty of Sample', type: 'text', placeholder: 'e.g. 10 g' },
      { key: 'fsl_seal_no', label: 'FSL Sample Sealed Packet No.', type: 'text' },
      { key: 'quantity_class', label: 'Commercial / Intermediate / Small', type: 'select', options: ['Commercial', 'Intermediate', 'Small', 'Not Assessed'] },
      { key: 'market_value', label: 'Approx. Market Value', type: 'number', unit: 'Rs.' },
      { key: 'ncb_informed', label: 'NCB Informed', type: 'select', options: ['Yes', 'No'] },
    ],
  },
  {
    id: 'arms',
    label: 'Arms & Ammunition',
    sectionLetter: 'B',
    subTypeLabel: 'Type',
    subTypes: [
      'Country-made Pistol (Katta)', 'Revolver', 'Rifle', 'Sword/Knife/Sharp weapon',
      'Live Cartridge', 'Empty Cartridge/Shell', 'Explosive/Bomb material',
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
    label: 'Cash / Currency',
    sectionLetter: 'C',
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
    label: 'Gold / Silver / Jewellery',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Gold Ornament', 'Silver Ornament', 'Gold Coin/Biscuit', 'Diamond/Studded Jewellery'],
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
    subTypes: ['Two-Wheeler', 'Four-Wheeler', 'Commercial Vehicle', 'Tractor'],
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
    subTypes: ['Mobile Phone', 'Laptop/Computer', 'Hard Disk/Pen Drive', 'SIM Card', 'CCTV DVR'],
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
    id: 'documents',
    label: 'Documents',
    sectionLetter: 'C',
    subTypeLabel: 'Type',
    subTypes: ['Original Document', 'Forged/Fake Document', 'Property Papers', 'Identity Documents (Aadhar/PAN/Passport)', 'Bank Documents/Cheque'],
    fields: [
      { key: 'no_of_pages', label: 'No. of Pages', type: 'number' },
      { key: 'genuine_forged', label: 'Genuine / Suspected Forged', type: 'select', options: ['Genuine', 'Suspected Forged'] },
      { key: 'handwriting_opinion', label: 'Handwriting Expert Opinion Needed', type: 'select', options: ['Yes', 'No'] },
      { key: 'related_to', label: 'Related To', type: 'text', placeholder: 'Property Dispute / Fraud / Cheating' },
    ],
  },
  {
    id: 'blood',
    label: 'Blood-stained Articles',
    sectionLetter: 'E',
    subTypeLabel: 'Type',
    subTypes: ['Clothes', 'Weapon with blood', 'Soil/Sample with blood', 'Bedsheet/Cloth material'],
    fields: [
      { key: 'blood_origin', label: 'Human / Animal Blood', type: 'select', options: ['Human', 'Animal', 'Pending FSL'] },
      { key: 'dna_sent', label: 'Sample Sent for DNA', type: 'select', options: ['Yes', 'No'] },
      { key: 'blood_group', label: 'Blood Group (if tested)', type: 'text' },
      { key: 'condition', label: 'Condition', type: 'select', options: ['Dry', 'Wet at seizure'] },
    ],
  },
  {
    id: 'liquor',
    label: 'Liquor (Illicit / NDPS-Excise)',
    sectionLetter: 'A',
    subTypeLabel: 'Type',
    subTypes: ['Country Liquor (Deshi Sharab)', 'Foreign Liquor (Without Permit)', 'Beer', 'Raw Material (Lahan/Wash)'],
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
    label: 'Other',
    sectionLetter: 'C',
    fields: [
      { key: 'other_desc', label: 'Description', type: 'text', placeholder: 'Describe the article' },
    ],
  },
];

export function getCategory(id: string | null | undefined): ItemCategory | undefined {
  if (!id) return undefined;
  return ITEM_CATEGORIES.find(c => c.id === id);
}
