// JSON-file persistent store for e-Malkhana.
// The "append-only" invariant on `movements` is enforced at the
// store API level — there is no `updateMovement` or `deleteMovement`.
// All mutations write the whole file atomically via a temp file + rename.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_PATH = join(__dirname, 'data', 'db.json');

function seed() {
  return {
    meta: { version: 1, station: 'PS Sector-5, Panchkula', asOf: '05 Jul 2026, 10:42 AM' },
    officer: { initials: 'RS', name: 'SI Rakesh Sharma', rank: 'PS Sector-5, Panchkula' },
    // Malkhana Moharrir (MM) accounts that can log in.
    // Login by entering any of these IDs (case-insensitive): MM-001, MM-002, MM-003.
    //
    // SECURITY: demo seed omits the `password` field so plaintext credentials
    // never enter the repo.  The login endpoint treats an empty/undefined
    // password as "no password required" (see /api/login in server.js).
    // For production deployments, either:
    //   (a) edit `server/data/db.json` after first run to add a `password`
    //       field per user, OR
    //   (b) set the `MM_USERS` env var (see .env.example) to override the
    //       seed users at boot.
    users: [
      { id: 'MM-001', initials: 'RS', name: 'SI Rakesh Sharma',  rank: 'Sub-Inspector',     designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula' },
      { id: 'MM-002', initials: 'VK', name: 'HC Vinod Kumar',    rank: 'Head Constable',   designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula' },
      { id: 'MM-003', initials: 'SD', name: 'ASI Sunita Devi',   rank: 'Asst Sub-Inspector', designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula' },
    ],
    // Append-only audit log: who did what, when.  Starts empty for new
    // stations; existing pilots keep their history when migrating.
    auditLog: [],
    sections: [
      { letter: 'A', name: 'Narcotics Rack',       count: 0 },
      { letter: 'B', name: 'Weapons Almirah',      count: 0 },
      { letter: 'C', name: 'Documents & Cash',     count: 0 },
      { letter: 'D', name: 'Vehicles Yard',        count: 0 },
      { letter: 'E', name: 'Biological / Viscera', count: 0 },
    ],
    cases: [
      {
        id: 'FIR 214/2026',
        itemType: 'Country-made pistol (.315 bore)',
        itemSub: '1 unit, with 2 live cartridges',
        section: 'PART B',
        sectionName: 'Part B — Weapons Almirah',
        status: 'In Court',
        seizingOfficer: 'HC Vinod Kumar',
        seizedOn: '02 Jun 2026',
        itemId: 'MK-2026-000214',
        createdAt: '2026-06-02T18:20:00',
      },
      {
        id: 'FIR 198/2026',
        itemType: 'Suspected heroin packet',
        itemSub: '420 grams, sealed poly bag',
        section: 'PART A',
        sectionName: 'Part A — Narcotics Rack',
        status: 'With FSL',
        seizingOfficer: 'ASI Sunita Devi',
        seizedOn: '29 May 2026',
        itemId: 'MK-2026-000198',
        createdAt: '2026-05-29T23:15:00',
      },
      {
        id: 'DD 41/2026',
        itemType: 'Viscera sample (jar, sealed)',
        itemSub: 'Natural death — non-FIR case',
        section: 'PART E',
        sectionName: 'Part E — Biological / Viscera',
        status: 'In Malkhana',
        seizingOfficer: 'SI Rakesh Sharma',
        seizedOn: '21 Jun 2026',
        itemId: 'MK-2026-000041',
        createdAt: '2026-06-21T15:10:00',
      },
      {
        id: 'DD 33/2026',
        itemType: 'Viscera sample (2 jars)',
        itemSub: 'Suspected poisoning — non-FIR case',
        section: 'PART E',
        sectionName: 'Part E — Biological / Viscera',
        status: 'Expert Opinion Pending',
        seizingOfficer: 'SI Rakesh Sharma',
        seizedOn: '14 Jun 2026',
        itemId: 'MK-2026-000033',
        createdAt: '2026-06-14T14:30:00',
      },
      {
        id: 'FIR 156/2026',
        itemType: 'Cash — currency notes',
        itemSub: '₹2,40,000, seized from accused',
        section: 'PART C',
        sectionName: 'Part C — Documents & Cash',
        status: 'Seized',
        seizingOfficer: 'ASI Manoj Yadav',
        seizedOn: '30 Jun 2026',
        itemId: 'MK-2026-000156',
        createdAt: '2026-06-30T09:45:00',
      },
      {
        id: 'FIR 088/2026',
        itemType: 'Stolen motorcycle',
        itemSub: 'Bajaj Pulsar, no. HR-05-AX-2231',
        section: 'PART D',
        sectionName: 'Part D — Vehicles Yard',
        status: 'Disposed',
        seizingOfficer: 'HC Vinod Kumar',
        seizedOn: '11 Mar 2026',
        itemId: 'MK-2026-000088',
        createdAt: '2026-03-11T10:20:00',
      },
    ],
    movements: [
      { id: 1, caseId: 'FIR 214/2026', fromLocation: '—',         toLocation: 'Malkhana — Part B',         movedBy: 'HC Vinod Kumar', timestamp: '2026-06-02T20:05:00', purpose: 'Seizure check-in', docRef: 'SM-2026-0214' },
      { id: 2, caseId: 'FIR 214/2026', fromLocation: 'Malkhana',  toLocation: 'FSL Madhuban',              movedBy: 'SI Rakesh Sharma', timestamp: '2026-06-10T11:00:00', purpose: 'Ballistic expert opinion', docRef: 'FSL-FWD-2026-114' },
      { id: 3, caseId: 'FIR 214/2026', fromLocation: 'FSL Madhuban', toLocation: 'Malkhana',               movedBy: 'SI Rakesh Sharma', timestamp: '2026-06-25T15:40:00', purpose: 'Report received', docRef: 'FSL-BAL-9012' },
      { id: 4, caseId: 'FIR 214/2026', fromLocation: 'Malkhana',  toLocation: 'Court',                    movedBy: 'HC Vinod Kumar', timestamp: '2026-07-05T09:12:00', purpose: 'Produced as exhibit', docRef: 'CO-2026-1187' },
      { id: 5, caseId: 'FIR 198/2026', fromLocation: '—',         toLocation: 'Malkhana — Part A',         movedBy: 'ASI Sunita Devi', timestamp: '2026-05-30T00:40:00', purpose: 'Seizure check-in', docRef: 'SM-2026-0198' },
      { id: 6, caseId: 'FIR 198/2026', fromLocation: 'Malkhana',  toLocation: 'FSL Madhuban',              movedBy: 'ASI Sunita Devi', timestamp: '2026-07-04T17:30:00', purpose: 'Chemical analysis', docRef: 'FSL-FWD-2026-188' },
      { id: 7, caseId: 'DD 41/2026',   fromLocation: 'Civil Hospital', toLocation: 'Malkhana — Part E',   movedBy: 'SI Rakesh Sharma', timestamp: '2026-06-21T17:50:00', purpose: 'PM report received', docRef: 'PM-2026-041' },
      { id: 8, caseId: 'DD 33/2026',   fromLocation: 'Civil Hospital', toLocation: 'Malkhana — Part E',   movedBy: 'SI Rakesh Sharma', timestamp: '2026-06-14T16:20:00', purpose: 'Seizure check-in', docRef: 'SM-DD-2026-033' },
      { id: 9, caseId: 'DD 33/2026',   fromLocation: 'Malkhana',  toLocation: 'Civil Hospital Panchkula', movedBy: 'SI Rakesh Sharma', timestamp: '2026-06-14T17:00:00', purpose: 'Chemical opinion', docRef: 'CH-FWD-2026-033' },
      { id: 10, caseId: 'FIR 156/2026', fromLocation: '—',         toLocation: 'Malkhana — Part C',        movedBy: 'ASI Manoj Yadav', timestamp: '2026-06-30T11:00:00', purpose: 'Seizure check-in', docRef: 'SM-2026-0156' },
      { id: 11, caseId: 'FIR 088/2026', fromLocation: '—',         toLocation: 'Malkhana — Part D',        movedBy: 'HC Vinod Kumar', timestamp: '2026-03-11T14:00:00', purpose: 'Seizure check-in', docRef: 'SM-2026-0088' },
      { id: 12, caseId: 'FIR 088/2026', fromLocation: 'Malkhana',  toLocation: 'Disposed (auctioned)',      movedBy: 'HC Vinod Kumar', timestamp: '2026-06-02T12:00:00', purpose: 'Released to RTO after court order', docRef: 'CO-2026-0412' },
    ],
    alertConfig: {
      fslDays: 30,                 // FSL report overdue threshold
      expertDays: 15,              // Expert opinion overdue threshold
      courtDays: 30,               // Court order / disposal overdue threshold
      inspectionCycleDays: 90,     // Quarterly inspection cycle
      lastInspection: '2026-04-05',// Last quarterly inspection date
    },
    // Synthetic "FIR 176/2026" used by the original UI for the FSL overdue alert.
    // We model it as a case still "With FSL" since 18 May 2026.
    extraCasesForAlerts: [
      {
        id: 'FIR 176/2026',
        itemType: 'Suspected narcotics (heroin)',
        itemSub: '80 grams, sealed poly bag',
        section: 'PART A',
        sectionName: 'Part A — Narcotics Rack',
        status: 'With FSL',
        seizingOfficer: 'ASI Sunita Devi',
        seizedOn: '18 May 2026',
        itemId: 'MK-2026-000176',
        createdAt: '2026-05-18T22:00:00',
      },
    ],
    extraMovements: [
      { id: 13, caseId: 'FIR 176/2026', fromLocation: '—', toLocation: 'Malkhana — Part A', movedBy: 'ASI Sunita Devi', timestamp: '2026-05-18T22:30:00', purpose: 'Seizure check-in', docRef: 'SM-2026-0176' },
      { id: 14, caseId: 'FIR 176/2026', fromLocation: 'Malkhana', toLocation: 'FSL Madhuban', movedBy: 'ASI Sunita Devi', timestamp: '2026-05-18T23:00:00', purpose: 'Forensic analysis', docRef: 'FSL-FWD-2026-176' },
    ],
  };
}

// Top-level keys that must exist in the DB.  Any missing key is back-filled
// from the seed on every load so the system stays self-healing after a
// schema migration or an older db.json written before new features shipped.
const REQUIRED_KEYS = [
  'meta', 'officer', 'users', 'auditLog', 'sections',
  'cases', 'movements', 'alertConfig',
  'extraCasesForAlerts', 'extraMovements', 'alertIssues',
];

function ensureDb() {
  if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true });
  if (!existsSync(DB_PATH)) {
    const initial = seed();
    writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = readFileSync(DB_PATH, 'utf8');
  let db;
  try { db = JSON.parse(raw); } catch {
    const initial = seed();
    writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  // Back-fill any missing top-level keys (preserves existing data)
  const reference = seed();
  let dirty = false;
  for (const k of REQUIRED_KEYS) {
    if (db[k] === undefined) {
      db[k] = reference[k];
      dirty = true;
    }
  }
  if (dirty) writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}

let _db = ensureDb();
const writeLocks = new Map();   // simple per-key serialization

function persist() {
  // Atomic write: write to .tmp, then rename.
  const tmp = DB_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(_db, null, 2));
  renameSync(tmp, DB_PATH);
}

export function getDb() { return _db; }

export async function mutate(fn) {
  // Serialise mutations one at a time (single-writer; this is a small pilot).
  while (writeLocks.get('*')) {
    await new Promise(r => setTimeout(r, 5));
  }
  writeLocks.set('*', true);
  try {
    const db = getDb();
    fn(db);
    if (!db.auditLog) db.auditLog = [];
    persist();
    return db;
  } finally {
    writeLocks.delete('*');
  }
}

// Append-only audit log. Every write operation in the system should call
// `appendAudit({ userId, userName, action, target, details })` to record who
// did what and when.  The store is intentionally append-only — there is no
// function to edit or delete entries, so the log is tamper-evident.
export async function appendAudit(entry) {
  const ts = new Date().toISOString();
  const entry_obj = {
    id:        ((getDb().auditLog || []).at(-1)?.id ?? 0) + 1,
    timestamp: ts,
    userId:    entry.userId    ?? 'anonymous',
    userName:  entry.userName  ?? '—',
    action:    entry.action    ?? 'unknown',
    target:    entry.target    ?? '',
    details:   entry.details   ?? '',
  };
  // Run the append + persist as a single mutate so the entry is durable
  // before this function resolves.  Returning a promise means callers
  // should `await` to guarantee the entry hits disk before they respond.
  await mutate(d => {
    if (!d.auditLog) d.auditLog = [];
    d.auditLog.push(entry_obj);
    // Cap to 5000 entries to keep the file manageable
    if (d.auditLog.length > 5000) d.auditLog.splice(0, d.auditLog.length - 5000);
  });
  process.stderr.write(`[audit] #${entry_obj.id}  ${entry_obj.userId}  ${entry_obj.action}  ${entry_obj.target}\n`);
  return entry_obj;
}
// ---------- helpers ----------
export function getCase(id)   { return _db.cases.find(c => c.id === id) || _db.extraCasesForAlerts?.find(c => c.id === id); }
export function getMovements(caseId) { return _db.movements.filter(m => m.caseId === caseId).sort((a, b) => a.timestamp.localeCompare(b.timestamp)); }
export function nextMovementId()    { return (_db.movements.at(-1)?.id ?? 0) + 1; }

export function rebuildSectionCounts() {
  for (const s of _db.sections) s.count = 0;
  for (const c of [..._db.cases, ...(_db.extraCasesForAlerts ?? [])]) {
    const s = _db.sections.find(x => x.letter === c.section?.replace('PART ', ''));
    if (s) s.count += 1;
  }
}
