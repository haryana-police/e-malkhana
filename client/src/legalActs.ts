// Legal Acts reference data — extracted from the BNS 2023, BNSS 2023, BSA 2023,
// IPC 1860, CrPC 1973, NDPS 1985, POCSO 2012, Arms 1959, MV 1988, IT 2000,
// Dowry 1961, DV 2005, SC/ST 1989, Explosives 1884, PMLA 2002, PC Act 1988,
// Benami 1988, D&C 1940, EP Act 1986, DM Act 2005, FSS 2006, ITPA 1956,
// JJ 2015, NS 1980, OS Act 1923, Passports 1967, Gambling 1867, Tele 2023,
// UAPA 1967 PDFs at script-extraction time.  Used by the Register form's
// "Section (U/S legal section) — multiple allowed" picker.
//
// One row per (act_code, section_no).  Each entry carries:
//   - act_code:    short label shown before the section number ("BNS 101")
//   - act_name:    full act title
//   - act_year:    year of the Act
//   - act_label:   human-friendly display label ("BNS 2023")
//   - section_no:  bare number string ("101", "304A", "33-O")
//   - title:       short heading of the section
//   - category:    chapter / sub-chapter the section belongs to (used as
//                  the right-hand label in the dropdown)

export interface LegalSection {
  actCode: string;
  actName: string;
  actYear: number;
  actLabel: string;
  sectionNo: string;
  title: string;
  category: string;
}

import raw from './data/legalSections.json';
const DATA = raw as Omit<LegalSection, 'actCode' | 'actName' | 'actYear' | 'actLabel'>[];

export const LEGAL_SECTIONS: LegalSection[] = DATA.map(r => ({
  actCode: r.act_code,
  actName: r.act_name,
  actYear: r.act_year,
  actLabel: r.act_label,
  sectionNo: r.section_no,
  title: r.title,
  category: r.category,
}));

// Act catalogue in display order — derived from data so it always matches
// what's actually present.  Sort by year desc, then alpha.
export const ACTS: { code: string; name: string; year: number; label: string; count: number }[] = (() => {
  const m = new Map<string, { name: string; year: number; label: string; count: number }>();
  for (const r of LEGAL_SECTIONS) {
    const e = m.get(r.actCode);
    if (e) e.count++;
    else m.set(r.actCode, { name: r.actName, year: r.actYear, label: r.actLabel, count: 1 });
  }
  return [...m.entries()]
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.year - a.year || a.code.localeCompare(b.code));
})();

/** Stable id for a (act_code, section_no) tuple — used in chips + payloads. */
export function lsKey(act: string, sec: string): string {
  return `${act}:${sec}`;
}

/** Parse a "BNS:101" style id back into {act, sec}. */
export function parseLsKey(k: string): { act: string; sec: string } | null {
  const i = k.indexOf(':');
  if (i < 0) return null;
  return { act: k.slice(0, i), sec: k.slice(i + 1) };
}

/** Pretty display: "BNS 101 — Murder". */
export function lsDisplay(s: { actCode: string; sectionNo: string; title: string }): string {
  const t = (s.title || '').trim();
  return t ? `${s.actCode} ${s.sectionNo} — ${t}` : `${s.actCode} ${s.sectionNo}`;
}

export interface TypeaheadOptions {
  query: string;        // live search text
  act?: string | null;  // optional act filter (e.g. "BNS")
  limit?: number;       // max results (default 20)
  /** When true, the result list must begin with `act_code + section_no` prefix
   *  matches before any title contains matches. Default true. */
  preferSectionNo?: boolean;
}

/** In-memory typeahead over LEGAL_SECTIONS.  Same scoring rules as the
 *  original BNS server endpoint: exact > starts-with > contains; section_no
 *  match beats title match for short numeric queries. */
export function searchLegalSections(opts: TypeaheadOptions): LegalSection[] {
  const q = (opts.query || '').trim().toLowerCase();
  const limit = opts.limit ?? 20;
  const act = opts.act || null;
  let pool = act ? LEGAL_SECTIONS.filter(s => s.actCode === act) : LEGAL_SECTIONS;
  if (!q) {
    return pool.slice(0, limit);
  }
  const exact: LegalSection[] = [];
  const starts: LegalSection[] = [];
  const contains: LegalSection[] = [];
  for (const s of pool) {
    const no = s.sectionNo.toLowerCase();
    const code = s.actCode.toLowerCase();
    const codeNo = `${code} ${no}`;
    const title = s.title.toLowerCase();
    const cat = s.category.toLowerCase();
    if (no === q || codeNo === q) exact.push(s);
    else if (no.startsWith(q) || codeNo.startsWith(q) || title.startsWith(q)) starts.push(s);
    else if (title.includes(q) || cat.includes(q) || no.includes(q) || code.includes(q)) contains.push(s);
  }
  return [...exact, ...starts, ...contains].slice(0, limit);
}
