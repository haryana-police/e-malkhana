// Upload 10 distinct TEST entries to the LIVE e-Malkhana Vercel API.
// Each entry exercises a different category / input-field block in RegisterCaseModal.
// Auth via X-MM-Id header (MM-001 demo account).
const BASE = 'https://e-malkhana-gamma.vercel.app';
const MM_ID = 'MM-001';
const MM_NAME = 'SI Rakesh Sharma';
const T = 'TEST';

// Helper: build one batch payload for a single item.
function batch(firNo, master, common, items) {
  return {
    firOrDd: firNo, firNo,
    recordType: master.recordType || 'FIR',
    policeStation: 'PS Sector-5, Panchkula',
    firDate: master.firDate || null,
    ddDate: master.ddDate || null,
    natureOfDd: master.natureOfDd || null,
    nameOfDeceased: master.nameOfDeceased || null,
    reportingPerson: master.reportingPerson || null,
    actualSeizureDdNo: master.actualSeizureDdNo || null,
    actualSeizureDate: master.actualSeizureDate || null,
    common, items,
    io: MM_NAME,
  };
}

const common = (seizedOn, officer, legalSections) => ({
  seizedTime: '11:30',
  witness1: null, witness2: null,
  quantity: '1',
  placeOfSeizure: 'Near Sector-5 Market, Panchkula',
  physicalStorage: 'Rack-A / Almirah-B / Yard-D',
  remarks: `${T} entry — distinct input field set`,
  dateOfReceipt: seizedOn,
  receivedBy: MM_NAME,
  malkhanaLocation: '',
  legalSections: legalSections || [],
  seizingOfficer: officer,
  seizedOn,
});

// 10 entries — one per distinct form configuration.
const payloads = [
  // 1) NARCOTICS (subType select + quantity_seized + NDPS class auto)
  batch('FIR 901/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'HC Vinod Kumar', ['101']),
    [{ itemType:'Narcotics / NDPS Article — Heroin (Diacetylmorphine)', sectionLetter:'A',
       category:'narcotics', subType:'Heroin (Diacetylmorphine)', malkhanaSection:'A',
       legalSections:['101'], seizedOn:'2026-07-18', seizingOfficer:'HC Vinod Kumar',
       quantity:'1', placeOfSeizure:'Bus stand, Panchkula', physicalStorage:'Rack A-1',
       remarks:'TEST: heroin 280 g — Commercial', status:'Seized', sealSealed:'Yes', sealNo:'MK/H/18', sealBy:'HC Vinod Kumar',
       popupFields:[{key:'sub_type',value:'Heroin (Diacetylmorphine)'},{key:'quantity_seized',value:'280 g'},{key:'quantity_class',value:'Commercial'},{key:'category',value:'narcotics'},{key:'malkhana_section',value:'A'}] }]),

  // 2) ARMS — Firearms (radio subType=Firearms, remarks required, no extra cat fields)
  batch('FIR 902/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'ASI Sunita Devi', ['111']),
    [{ itemType:'Arms & Ammunition — Firearms', sectionLetter:'B',
       category:'arms', subType:'Firearms', malkhanaSection:'B',
       legalSections:['111'], seizedOn:'2026-07-18', seizingOfficer:'ASI Sunita Devi',
       quantity:'1', placeOfSeizure:'Accused residence', physicalStorage:'Almirah B-2',
       remarks:'TEST: country-made pistol .315 bore with 3 live cartridges', status:'Seized', sealSealed:'Yes', sealNo:'MK/A/21', sealBy:'ASI Sunita Devi',
       popupFields:[{key:'sub_type',value:'Firearms'},{key:'category',value:'arms'},{key:'malkhana_section',value:'B'}] }]),

  // 3) ARMS — Other Weapons (radio subType=Other Weapons — 2nd arms variant)
  batch('FIR 903/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'HC Vinod Kumar', ['111']),
    [{ itemType:'Arms & Ammunition — Other Weapons', sectionLetter:'B',
       category:'arms', subType:'Other Weapons', malkhanaSection:'B',
       legalSections:['111'], seizedOn:'2026-07-18', seizingOfficer:'HC Vinod Kumar',
       quantity:'1', placeOfSeizure:'Road nakab', physicalStorage:'Almirah B-3',
       remarks:'TEST: iron danda / lathi used in assault', status:'Seized', sealSealed:'Yes', sealNo:'MK/A/22', sealBy:'HC Vinod Kumar',
       popupFields:[{key:'sub_type',value:'Other Weapons'},{key:'category',value:'arms'},{key:'malkhana_section',value:'B'}] }]),

  // 4) CASH (total_amount number field)
  batch('FIR 904/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'ASI Manoj Yadav', ['244']),
    [{ itemType:'Currency & Valuables', sectionLetter:'C',
       category:'cash', malkhanaSection:'C',
       legalSections:['244'], seizedOn:'2026-07-18', seizingOfficer:'ASI Manoj Yadav',
       quantity:'1', placeOfSeizure:'Bank locker', physicalStorage:'Strong room C-1',
       remarks:'TEST: seized cash from accused', status:'Seized', sealSealed:'Yes', sealNo:'MK/C/31', sealBy:'ASI Manoj Yadav',
       popupFields:[{key:'total_amount',value:'240000'},{key:'category',value:'cash'},{key:'malkhana_section',value:'C'}] }]),

  // 5) GOLD / Jewellery (5 cat fields: weight, purity, no_of_pieces, approx_value, valuation_by)
  batch('FIR 905/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'HC Vinod Kumar', ['244']),
    [{ itemType:'Jewellery — Gold ornaments', sectionLetter:'C',
       category:'gold', subType:'Gold ornaments', malkhanaSection:'C',
       legalSections:['244'], seizedOn:'2026-07-18', seizingOfficer:'HC Vinod Kumar',
       quantity:'1', placeOfSeizure:'Residence search', physicalStorage:'Strong room C-2',
       remarks:'TEST: gold chain + bangles', status:'Seized', sealSealed:'Yes', sealNo:'MK/C/32', sealBy:'HC Vinod Kumar',
       popupFields:[{key:'sub_type',value:'Gold ornaments'},{key:'weight',value:'120 grams'},{key:'purity',value:'22 Carat Hallmark'},{key:'no_of_pieces',value:'5'},{key:'approx_value',value:'720000'},{key:'valuation_by',value:'M/s Sharma Jewellers, Panchkula'},{key:'category',value:'gold'},{key:'malkhana_section',value:'C'}] }]),

  // 6) VEHICLE — Four-wheeler (radio subType select, no extra cat fields)
  batch('FIR 906/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'ASI Sunita Devi', ['137']),
    [{ itemType:'Vehicle — Four-wheeler', sectionLetter:'D',
       category:'vehicle', subType:'Four-wheeler', malkhanaSection:'D',
       legalSections:['137'], seizedOn:'2026-07-18', seizingOfficer:'ASI Sunita Devi',
       quantity:'1', placeOfSeizure:'Highway', physicalStorage:'Vehicles Yard D-1',
       remarks:'TEST: stolen Swift Dzire, HR-26-AB-1234', status:'Seized', sealSealed:'Yes', sealNo:'MK/D/41', sealBy:'ASI Sunita Devi',
       popupFields:[{key:'sub_type',value:'Four-wheeler'},{key:'category',value:'vehicle'},{key:'malkhana_section',value:'D'}] }]),

  // 7) LOST ITEMS (minimal category — only category + section + desc + photo)
  batch('DD 907/2026', { recordType:'DD', ddDate:'2026-07-18', natureOfDd:'Lost Property Report', reportingPerson:'Ram Kumar, Sec-5 Panchkula' },
    { ...common('2026-07-18', 'SI Rakesh Sharma', []), legalSections:[] },
    [{ itemType:'Lost Items', sectionLetter:'C',
       category:'lost_items', malkhanaSection:'C',
       legalSections:[], seizedOn:'2026-07-18', seizingOfficer:'SI Rakesh Sharma',
       quantity:'1', placeOfSeizure:'Reported lost at market', physicalStorage:'Lost property shelf C-3',
       remarks:'TEST: lost mobile phone Redmi Note 12', status:'Seized', sealSealed:'Yes', sealNo:'MK/L/51', sealBy:'SI Rakesh Sharma',
       popupFields:[{key:'category',value:'lost_items'},{key:'malkhana_section',value:'C'}] }]),

  // 8) EXCISE / Liquor (quantity2 text field)
  batch('FIR 908/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'HC Vinod Kumar', ['109']),
    [{ itemType:'Excise', sectionLetter:'A',
       category:'liquor', malkhanaSection:'A',
       legalSections:['109'], seizedOn:'2026-07-18', seizingOfficer:'HC Vinod Kumar',
       quantity:'1', placeOfSeizure:'Check post', physicalStorage:'Rack A-2',
       remarks:'TEST: illicit liquor without permit', status:'Seized', sealSealed:'Yes', sealNo:'MK/E/61', sealBy:'HC Vinod Kumar',
       popupFields:[{key:'quantity2',value:'45 bottles (22.5 L)'},{key:'category',value:'liquor'},{key:'malkhana_section',value:'A'}] }]),

  // 9) VISCERA — Dead-body case (4 cat fields: viscera_jar_no, organs_included, sealed_by, purpose)
  batch('DD 909/2026', { recordType:'DD', ddDate:'2026-07-18', natureOfDd:'UD Case (Unnatural Death)', nameOfDeceased:'Smt. Leela Devi' },
    { ...common('2026-07-18', 'SI Rakesh Sharma', []), legalSections:[] },
    [{ itemType:'Viscera (Dead-body Case)', sectionLetter:'E',
       category:'viscera', malkhanaSection:'E',
       legalSections:[], seizedOn:'2026-07-18', seizingOfficer:'SI Rakesh Sharma',
       quantity:'1', placeOfSeizure:'Civil Hospital Panchkula', physicalStorage:'Fridge E-1 (Bio)',
       remarks:'TEST: viscera preserved for chemical analysis', status:'Seized', sealSealed:'Yes', sealNo:'MK/V/71', sealBy:'Dr. A. Gupta (PM)',
       popupFields:[{key:'viscera_jar_no',value:'3 jars'},{key:'organs_included',value:'Stomach/Liver/Kidney'},{key:'sealed_by',value:'Dr. A. Gupta'},{key:'purpose',value:'Poisoning suspected'},{key:'category',value:'viscera'},{key:'malkhana_section',value:'E'}] }]),

  // 10) MISCELLANEOUS (other_desc text field)
  batch('FIR 910/2026', { recordType:'FIR', firDate:'2026-07-18' },
    common('2026-07-18', 'ASI Sunita Devi', ['115']),
    [{ itemType:'Miscellaneous', sectionLetter:'C',
       category:'other', subType:'Other/Unclassified items', malkhanaSection:'C',
       legalSections:['115'], seizedOn:'2026-07-18', seizingOfficer:'ASI Sunita Devi',
       quantity:'1', placeOfSeizure:'Scene of crime', physicalStorage:'Shelf C-4',
       remarks:'TEST: assorted electronic evidence (DVR, HDD)', status:'Seized', sealSealed:'Yes', sealNo:'MK/M/81', sealBy:'ASI Sunita Devi',
       popupFields:[{key:'sub_type',value:'Other/Unclassified items'},{key:'other_desc',value:'DVR + 2 HDDs seized from CCTV room'},{key:'category',value:'other'},{key:'malkhana_section',value:'C'}] }]),
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  let ok = 0, fail = 0;
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    try {
      const res = await fetch(`${BASE}/api/cases/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MM-Id': MM_ID, 'X-MM-Name': MM_NAME },
        body: JSON.stringify(p),
      });
      const txt = await res.text();
      if (!res.ok) {
        console.log(`#${i+1} ${p.firOrDd} -> HTTP ${res.status}: ${txt.slice(0,200)}`);
        fail++;
      } else {
        const j = JSON.parse(txt);
        console.log(`#${i+1} ${p.firOrDd} -> OK items=[${j.items.map(x=>x.itemId).join(', ')}]`);
        ok++;
      }
    } catch (e) {
      console.log(`#${i+1} ${p.firOrDd} -> EXCEPTION ${e.message}`);
      fail++;
    }
    await sleep(250);
  }
  console.log(`\nDONE: ${ok} ok, ${fail} failed`);
}
main();
