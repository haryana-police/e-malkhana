// Postgres connection + schema bootstrap for e-Malkhana.
//
// All Neon connections MUST use TLS.  The connection string from the Neon
// dashboard already has `?sslmode=require&channel_binding=require`, which
// node-postgres picks up automatically.  On Vercel, the connection string
// is supplied via the DATABASE_URL env var (set with `vercel env add`).
//
// On first import we:
//   1. Lazily create the pool (so a missing/invalid DATABASE_URL surfaces
//      at the first DB call, not at module-load time — this is important
//      for local dev where the user might not have a Postgres running).
//   2. Run `initSchema()` once to CREATE TABLE IF NOT EXISTS for every
//      collection.  Idempotent — safe to run on every cold start.
//   3. Run `seedIfEmpty()` once to insert the demo MM accounts + sample
//      cases on a fresh database.  Subsequent boots are no-ops.
//
// The schema deliberately mirrors the JSON shape that store.js used to
// read from db.json.  Sections/cases/movements are normalised into proper
// tables; the singletons (meta, officer, alertConfig) live in a `kv` table
// keyed by name.

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Neon serverless driver requires a WebSocket constructor in Node.  In
// the Edge runtime it's provided globally; in Node we need to wire it up.
if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

let _pool = null;
let _schemaReady = null;
let _seedReady = null;

function getPool() {
  if (_pool) return _pool;
  const cs = process.env.DATABASE_URL;
  if (!cs) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env (local) or via `vercel env add DATABASE_URL production`. ' +
      'Get the connection string from the Neon dashboard: https://console.neon.tech'
    );
  }
  // @neondatabase/serverless Pool talks to the pooler over WebSocket — no
  // TCP connection lifecycle, no idle-client errors, no 10s connect
  // timeout.  This is the recommended driver for Vercel serverless.
  _pool = new Pool({ connectionString: cs });
  _pool.on('error', (err) => {
    // The pool emits 'error' for transient issues.  Log and move on; the
    // next query will reconnect.
    console.error('[db] pool error:', err && err.message);
  });
  return _pool;
}

// Public handle so store.js can do `await pool.query(...)` directly.
export const pool = new Proxy({}, {
  get(_t, prop) { return getPool()[prop]; },
});

// ---------- schema ----------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  initials    TEXT NOT NULL,
  name        TEXT NOT NULL,
  rank        TEXT,
  designation TEXT,
  station     TEXT,
  password    TEXT
);

CREATE TABLE IF NOT EXISTS sections (
  letter TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS cases (
  id            TEXT PRIMARY KEY,
  item_type     TEXT NOT NULL,
  item_sub      TEXT DEFAULT '',
  section       TEXT NOT NULL,
  status        TEXT NOT NULL,
  seizing_officer TEXT,
  seized_on     TEXT,
  item_id       TEXT,
  image_url     TEXT,
  image_auto_generated BOOLEAN DEFAULT FALSE,
  skip_auto_image BOOLEAN DEFAULT FALSE,
  doc_ref       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_section_idx ON cases (section);
CREATE INDEX IF NOT EXISTS cases_status_idx  ON cases (status);

CREATE TABLE IF NOT EXISTS movements (
  id            BIGSERIAL PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_location TEXT NOT NULL,
  to_location   TEXT NOT NULL,
  moved_by      TEXT NOT NULL,
  purpose       TEXT,
  doc_ref       TEXT,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_case_id_idx ON movements (case_id);
CREATE INDEX IF NOT EXISTS movements_ts_idx      ON movements (ts DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   TEXT NOT NULL DEFAULT 'anonymous',
  user_name TEXT NOT NULL DEFAULT '—',
  action    TEXT NOT NULL,
  target    TEXT NOT NULL DEFAULT '',
  details   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx      ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx  ON audit_log (action);
`;

export async function initSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const client = await getPool().connect();
    try {
      // Run each DDL statement separately so a parse error in one doesn't
      // abort the rest.  Postgres doesn't accept multi-statement queries
      // through the simple query protocol by default.
      for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
        await client.query(stmt);
      }
    } finally {
      client.release();
    }
  })();
  return _schemaReady;
}

// ---------- seed (first boot only) ----------

function buildDefaultSections() {
  const defaults = [
    'Narcotics Rack', 'Weapons Almirah', 'Documents & Cash', 'Vehicles Yard',
    'Biological / Viscera', 'Ammunition & Explosives', 'Stolen Vehicle Parts',
    'Recovered Electronics', 'Mobile Phones & SIMs', 'Laptops & Hard Disks',
    'Counterfeit Currency', 'Foreign Currency', 'Jewellery & Gold',
    'Precious Stones', 'Alcohol & Illicit Liquor', 'Pharmaceuticals',
    'Fake / Counterfeit Goods', 'Arms Accessories', 'Knives & Sharp Weapons',
    'Firearms — Long Barrel', 'Firearms — Short Barrel', 'Country-made Pistols',
    'Air Guns & Replicas', 'Clothing — Accused', 'Clothing — Victim',
    'Footwear', 'Personal Documents', 'Passports & Visas', 'Vehicle Documents',
    'Sealed Sample Packets', 'Drug Paraphernalia', 'Syringes & Vials',
    'Blood Samples', 'Hair & Fibre Samples', 'Semen Samples', 'Saliva Swabs',
    'Fingerprints — Lifts', 'Shoe Impressions', 'Tool Marks', 'Paint Chips',
    'Glass Fragments', 'Soil Samples', 'Paint Smears', 'Document Forgeries',
    'Banned Books / Material', 'Audio Recordings', 'Video Recordings',
    'CCTV Footage — Media', 'Misc / Unclassified',
  ];
  const letters = [];
  for (let i = 0; i < 26; i++) letters.push(String.fromCharCode(65 + i));
  for (let i = 0; i < 26; i++) letters.push('A' + String.fromCharCode(65 + i));
  return defaults.slice(0, letters.length).map((name, i) => ({
    letter: letters[i], name, count: 0, active: true,
  }));
}

function defaultSeed() {
  const DEMO_PW = 'malkhana2026';
  return {
    meta: { version: 1, station: 'PS Sector-5, Panchkula', asOf: '05 Jul 2026, 10:42 AM' },
    officer: { initials: 'RS', name: 'SI Rakesh Sharma', rank: 'PS Sector-5, Panchkula' },
    users: [
      { id: 'MM-001', initials: 'RS', name: 'SI Rakesh Sharma',  rank: 'Sub-Inspector',      designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula', password: DEMO_PW },
      { id: 'MM-002', initials: 'VK', name: 'HC Vinod Kumar',    rank: 'Head Constable',      designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula', password: DEMO_PW },
      { id: 'MM-003', initials: 'SD', name: 'ASI Sunita Devi',   rank: 'Asst Sub-Inspector',  designation: 'Malkhana Moharrir', station: 'PS Sector-5, Panchkula', password: DEMO_PW },
    ],
    auditLog: [],
    sections: buildDefaultSections(),
    cases: [
      { id: 'FIR 214/2026', itemType: 'Country-made pistol (.315 bore)', itemSub: '1 unit, with 2 live cartridges', section: 'PART B', sectionName: 'Part B — Weapons Almirah',         status: 'In Malkhana',           seizingOfficer: 'HC Vinod Kumar',     seizedOn: '02 Jun 2026', itemId: 'MK-2026-000214', createdAt: '2026-06-02T18:20:00' },
      { id: 'FIR 198/2026', itemType: 'Suspected heroin packet',          itemSub: '420 grams, sealed poly bag',       section: 'PART A', sectionName: 'Part A — Narcotics Rack',          status: 'With FSL',              seizingOfficer: 'ASI Sunita Devi',    seizedOn: '29 May 2026', itemId: 'MK-2026-000198', createdAt: '2026-05-29T23:15:00' },
      { id: 'DD 41/2026',   itemType: 'Viscera sample (jar, sealed)',     itemSub: 'Natural death — non-FIR case',     section: 'PART E', sectionName: 'Part E — Biological / Viscera',    status: 'In Malkhana',           seizingOfficer: 'SI Rakesh Sharma',   seizedOn: '21 Jun 2026', itemId: 'MK-2026-000041', createdAt: '2026-06-21T15:10:00' },
      { id: 'DD 33/2026',   itemType: 'Viscera sample (2 jars)',         itemSub: 'Suspected poisoning — non-FIR',    section: 'PART E', sectionName: 'Part E — Biological / Viscera',    status: 'Expert Opinion Pending',seizingOfficer: 'SI Rakesh Sharma',   seizedOn: '14 Jun 2026', itemId: 'MK-2026-000033', createdAt: '2026-06-14T14:30:00' },
      { id: 'FIR 156/2026', itemType: 'Cash — currency notes',            itemSub: '₹2,40,000, seized from accused',   section: 'PART C', sectionName: 'Part C — Documents & Cash',        status: 'Seized',                seizingOfficer: 'ASI Manoj Yadav',    seizedOn: '30 Jun 2026', itemId: 'MK-2026-000156', createdAt: '2026-06-30T09:45:00' },
      { id: 'FIR 088/2026', itemType: 'Stolen motorcycle',                itemSub: 'Bajaj Pulsar, no. HR-05-AX-2231', section: 'PART D', sectionName: 'Part D — Vehicles Yard',           status: 'Disposed',              seizingOfficer: 'HC Vinod Kumar',     seizedOn: '11 Mar 2026', itemId: 'MK-2026-000088', createdAt: '2026-03-11T10:20:00' },
      // FIR 176/2026: "alert-only" case from the legacy JSON seed.  In the
      // SQL world this is just another row in `cases` — it drives the FSL
      // overdue alert on the dashboard.
      { id: 'FIR 176/2026', itemType: 'Suspected narcotics (heroin)',     itemSub: '80 grams, sealed poly bag',         section: 'PART A', sectionName: 'Part A — Narcotics Rack',          status: 'With FSL',              seizingOfficer: 'ASI Sunita Devi',    seizedOn: '18 May 2026', itemId: 'MK-2026-000176', createdAt: '2026-05-18T22:00:00' },
    ],
    movements: [
      { id: 1,  caseId: 'FIR 214/2026', fromLocation: '—',              toLocation: 'Malkhana — Part B',          movedBy: 'HC Vinod Kumar',  timestamp: '2026-06-02T20:05:00', purpose: 'Seizure check-in',          docRef: 'SM-2026-0214' },
      { id: 2,  caseId: 'FIR 214/2026', fromLocation: 'Malkhana',       toLocation: 'FSL Madhuban',               movedBy: 'SI Rakesh Sharma',timestamp: '2026-06-10T11:00:00', purpose: 'Ballistic expert opinion',  docRef: 'FSL-FWD-2026-114' },
      { id: 3,  caseId: 'FIR 214/2026', fromLocation: 'FSL Madhuban',    toLocation: 'Malkhana',                   movedBy: 'SI Rakesh Sharma',timestamp: '2026-06-25T15:40:00', purpose: 'Report received',           docRef: 'FSL-BAL-9012' },
      { id: 4,  caseId: 'FIR 214/2026', fromLocation: 'Malkhana',       toLocation: 'Court',                      movedBy: 'HC Vinod Kumar',  timestamp: '2026-07-05T09:12:00', purpose: 'Produced as exhibit',       docRef: 'CO-2026-1187' },
      { id: 5,  caseId: 'FIR 198/2026', fromLocation: '—',              toLocation: 'Malkhana — Part A',          movedBy: 'ASI Sunita Devi', timestamp: '2026-05-30T00:40:00', purpose: 'Seizure check-in',          docRef: 'SM-2026-0198' },
      { id: 6,  caseId: 'FIR 198/2026', fromLocation: 'Malkhana',       toLocation: 'FSL Madhuban',               movedBy: 'ASI Sunita Devi', timestamp: '2026-07-04T17:30:00', purpose: 'Chemical analysis',         docRef: 'FSL-FWD-2026-188' },
      { id: 7,  caseId: 'DD 41/2026',   fromLocation: 'Civil Hospital', toLocation: 'Malkhana — Part E',          movedBy: 'SI Rakesh Sharma',timestamp: '2026-06-21T17:50:00', purpose: 'PM report received',        docRef: 'PM-2026-041' },
      { id: 8,  caseId: 'DD 33/2026',   fromLocation: 'Civil Hospital', toLocation: 'Malkhana — Part E',          movedBy: 'SI Rakesh Sharma',timestamp: '2026-06-14T16:20:00', purpose: 'Seizure check-in',          docRef: 'SM-DD-2026-033' },
      { id: 9,  caseId: 'DD 33/2026',   fromLocation: 'Malkhana',       toLocation: 'Civil Hospital Panchkula',  movedBy: 'SI Rakesh Sharma',timestamp: '2026-06-14T17:00:00', purpose: 'Chemical opinion',          docRef: 'CH-FWD-2026-033' },
      { id: 10, caseId: 'FIR 156/2026', fromLocation: '—',              toLocation: 'Malkhana — Part C',          movedBy: 'ASI Manoj Yadav', timestamp: '2026-06-30T11:00:00', purpose: 'Seizure check-in',          docRef: 'SM-2026-0156' },
      { id: 11, caseId: 'FIR 088/2026', fromLocation: '—',              toLocation: 'Malkhana — Part D',          movedBy: 'HC Vinod Kumar',  timestamp: '2026-03-11T14:00:00', purpose: 'Seizure check-in',          docRef: 'SM-2026-0088' },
      { id: 12, caseId: 'FIR 088/2026', fromLocation: 'Malkhana',       toLocation: 'Disposed (auctioned)',       movedBy: 'HC Vinod Kumar',  timestamp: '2026-06-02T12:00:00', purpose: 'Released to RTO',           docRef: 'CO-2026-0412' },
      // FIR 176/2026: synthetic case used by the original UI to drive the
      // FSL-overdue alert on the dashboard.  In the SQL world this is just
      // another row in `cases` — no need for a separate "alert-only" table.
      { id: 13, caseId: 'FIR 176/2026', fromLocation: '—',              toLocation: 'Malkhana — Part A',          movedBy: 'ASI Sunita Devi', timestamp: '2026-05-18T22:30:00', purpose: 'Seizure check-in',          docRef: 'SM-2026-0176' },
      { id: 14, caseId: 'FIR 176/2026', fromLocation: 'Malkhana',       toLocation: 'FSL Madhuban',               movedBy: 'ASI Sunita Devi', timestamp: '2026-05-18T23:00:00', purpose: 'Forensic analysis',         docRef: 'FSL-FWD-2026-176' },
    ],
    alertConfig: { fslDays: 30, expertDays: 15, courtDays: 30, inspectionCycleDays: 90, lastInspection: '2026-04-05' },
    alertIssues: [],
  };
}

export async function seedIfEmpty() {
  if (_seedReady) return _seedReady;
  _seedReady = (async () => {
    await initSchema();
    const client = await getPool().connect();
    try {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
      if (rows[0].n > 0) return; // already seeded
      const s = defaultSeed();
      const isoTs = (s) => s ? new Date(s).toISOString() : null;
      await client.query('BEGIN');
      try {
        // Singleton kvs — pre-create the rows so the in-memory mirror finds
        // them on the very first load (avoids the legacy "missing key
        // back-fill from default" code path in the old JSON store).
        for (const k of ['meta', 'officer', 'alertConfig', 'alertIssues', 'backupLog']) {
          await client.query(
            'INSERT INTO kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
            [k, JSON.stringify(s[k] ?? (k === 'backupLog' ? [] : null))]
          );
        }
        // Users
        for (const u of s.users) {
          await client.query(
            `INSERT INTO users (id, initials, name, rank, designation, station, password)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO NOTHING`,
            [u.id, u.initials, u.name, u.rank || null, u.designation || null, u.station || null, u.password || null]
          );
        }
        // Sections
        for (const sec of s.sections) {
          await client.query(
            `INSERT INTO sections (letter, name, count, active)
             VALUES ($1,$2,$3,$4) ON CONFLICT (letter) DO NOTHING`,
            [sec.letter, sec.name, sec.count || 0, sec.active !== false]
          );
        }
        // Cases
        for (const c of s.cases) {
          await client.query(
            `INSERT INTO cases (id, item_type, item_sub, section, status,
                                seizing_officer, seized_on, item_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, $9)
             ON CONFLICT (id) DO NOTHING`,
            [c.id, c.itemType, c.itemSub || '', c.section, c.status,
             c.seizingOfficer || null, c.seizedOn || null, c.itemId || null,
             isoTs(c.createdAt)]
          );
        }
        // Movements (preserves the original id so the seed numbers stay stable)
        for (const m of s.movements) {
          await client.query(
            `INSERT INTO movements (id, case_id, from_location, to_location, moved_by, purpose, doc_ref, ts)
             VALUES ($1,$2,$3,$4,$5,$6,$7, $8)
             ON CONFLICT (id) DO NOTHING`,
            [m.id, m.caseId, m.fromLocation, m.toLocation, m.movedBy, m.purpose || null, m.docRef || null,
             isoTs(m.timestamp)]
          );
          // Sync the BIGSERIAL sequence so nextMovementId() returns id+1
          await client.query(
            "SELECT setval(pg_get_serial_sequence('movements','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM movements), 1))"
          );
        }
        // Audit log starts empty — nothing to insert.
        await client.query('COMMIT');
        console.log('[db] seeded empty database with demo data');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    } finally {
      client.release();
    }
  })();
  return _seedReady;
}

// Convenience: ensure everything is ready before any read or write.  Call
// this at the top of every exported store function.
export async function ensureReady() {
  await seedIfEmpty();
}
