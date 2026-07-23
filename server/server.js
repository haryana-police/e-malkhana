// e-Malkhana — single-port server: API on /api/* + static frontend on /*.
// Storage: Postgres (Neon) via server/store.js.
// Run:  node server.js   (port 4000 by default, override with PORT env)
//
// Load .env at startup so DATABASE_URL is available for the DB layer.  On
// Vercel the env is supplied by `vercel env add`, so dotenv's "missing file"
// path is a no-op.
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  getDb, mutate, getCase, getCaseByItemId, getMovements, nextMovementId, rebuildSectionCounts,
  nextMalkhanaSeq, formatMalkhanaSrNo, syncMalkhanaSeq,
  appendAudit, boot as bootStore, ensureBoot,
  syncRegistrationMirrors,
} from './store.js';
import {
  getSectionMeta, getItemTypeFields, upsertItemTypeField, deleteItemTypeField,
  getFirMaster, upsertFirMaster, searchFirMaster, getCaseProperty, upsertCaseProperty,
  getInspections, getInspection, upsertInspection, deleteInspection,
  nextInspectionId, getLastInspectionDate,
  getItemCategories, getItemCategory, upsertItemCategory, deleteItemCategory,
} from './db.js';
import { ensureUploadsDir, writeUpload, ensureCaseImage, UPLOADS_DIR } from './uploads.js';
import crypto from 'node:crypto';

// Defence-in-depth: surface unhandled rejections instead of silently killing
// the process (which is what the live PATCH bug looked like from the client).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && (reason.stack || reason.message || reason));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err.message || err));
});

// Detect Vercel serverless environment.  On Vercel the function is stateless
// and persistent state lives in /tmp (per-instance, lost on cold start).
const IS_VERCEL = !!process.env.VERCEL;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Audit context middleware: every request gets `req.mm = { id, name }` from
// the X-MM-Id header (set by the client).  Falls back to 'anonymous' for
// un-authenticated requests (e.g. login itself).  All write endpoints use
// `auditMm(req, action, target, details)` to record a log entry.
//
// On Vercel the boot IIFE in this file can call mutate() AFTER boot()
// resolves (backfillImages / rebuildSectionCountsIn / scanAlerts).  If
// any of those fail, mutate()'s rollback path does `_mirror = null`,
// which would make a request that just awaited bootOnce() in api/index.js
// throw "before boot()" when the middleware hits getDb() below.  We
// await ensureBoot() here as defence-in-depth: every request is safe
// regardless of what the IIFE does to the mirror after initial boot.
app.use(async (req, _res, next) => {
  try {
    await ensureBoot();
    const id = String(req.header('x-mm-id') || '').trim().toUpperCase();
    const name = String(req.header('x-mm-name') || '').trim();
    const db = getDb();
    let u = null;
    if (id) u = (db.users || []).find(x => x.id.toUpperCase() === id) || null;
    req.mm = { id: u?.id || 'anonymous', name: u?.name || (id ? name : '—') };
    next();
  } catch (e) {
    next(e);
  }
});

function auditMm(req, action, target, details) {
  // Returns a promise — callers should `await` to ensure the audit is
  // written to disk before the response goes back to the client.
  return appendAudit({
    userId:   req.mm?.id   || 'anonymous',
    userName: req.mm?.name || '—',
    action, target, details,
  });
}

// Serve uploaded files (photos, supporting documents, generated SVGs).
// Locally we use express.static on the persistent data dir.  On Vercel
// /tmp/uploads/ is per-instance and not servable by Vercel's static
// engine, so we expose them through an API route that streams from the
// UPLOADS_DIR exported by uploads.js (which already points at /tmp on
// Vercel — see uploads.js).
//
// IMPORTANT: this route must be registered BEFORE the
// `app.use('/api', ...)` 404 catch-all further down the file, otherwise
// the catch-all will eat every /api/uploads/* request.
if (!IS_VERCEL) {
  const uploadsDir = join(__dirname, 'data', 'uploads');
  if (existsSync(uploadsDir)) {
    app.use('/uploads', express.static(uploadsDir));
  }
} else {
  app.get('/api/uploads/:filename', (req, res) => {
    const safe = String(req.params.filename || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (!safe) return res.status(400).json({ error: 'bad filename' });
    // resolve() ensures the path is absolute — required by res.sendFile.
    const full = resolve(join(UPLOADS_DIR, safe));
    if (!existsSync(full)) return res.status(404).json({ error: 'not found' });
    const ext = safe.split('.').pop()?.toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml'
              : ext === 'png' ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
              : ext === 'webp' ? 'image/webp'
              : 'application/octet-stream';
    res.type(mime).sendFile(full);
  });
}

// =================== helpers ===================

// STATUSES used to be a hardcoded constant; the active list now lives in
// the movement_types table (see db_statusNameSet() below).  Keeping a
// module-level snapshot for any synchronous readers that still expect a
// Set/Array — values are loaded lazily from the mirror on first access.
const STATUSES = (typeof Proxy !== 'undefined') ? new Proxy([], {
  get(_t, prop) {
    const arr = Array.from(db_statusNameSet());
    const v = arr[prop];
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return v;
    if (prop === 'length') return arr.length;
    if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr);
    if (prop === 'includes') return (x) => arr.includes(x);
    return v;
  },
}) : Array.from(db_statusNameSet());

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}
function daysBetween(fromISO, toISO = nowISO()) {
  const a = new Date(fromISO); const b = new Date(toISO);
  return Math.floor((b - a) / 86400000);
}
function makeItemId(seed) {
  // DEPRECATED deterministic form (derived the number FROM the FIR/DD number
  // -> collisions for multi-item FIRs).  Kept for callers that pass a seed
  // but now delegates to the global sequence for a unique, monotonic number.
  // The seed argument is ignored; the sequence owns the number.
  throw new Error('makeItemId() is deprecated — use nextMalkhanaSrNo() (async sequence).');
}
// Returns the next unique Malkhana Sr. No. (Register Entry No.), e.g.
// MK-2026-000521.  Each call consumes one sequence value, so even several
// items registered under the same FIR each get a distinct Sr. No.
async function nextMalkhanaSrNo() {
  const n = await nextMalkhanaSeq();
  return formatMalkhanaSrNo(n);
}
function findOrThrow(id) {
  const r = resolveCaseId(id);
  if (!r.case) { const err = new Error('case not found'); err.status = 404; err.payload = { tried: id, suggestions: r.suggestions }; throw err; }
  return withFreshSectionName(r.case, getDb());
}

// Resolve a (possibly partial) case id. Returns { case, suggestions }.
//   1. exact match wins
//   2. case-insensitive exact match
//   3. "215" → matches "FIR 215/2026" (numeric substring match)
//   4. any other partial substring (case-insensitive) when unique
// Normalise a free-text FIR/DD query into its canonical stored id form.
// Handles the messy ways MMs actually type the number at the scanner /
// manual-entry box:
//   "FIR 125"          → "FIR 125/2026"   (year auto-filled to current FY)
//   "fir no 125"       → "FIR 125/2026"
//   "125"              → "125"            (yearless: matched loosely below)
//   "DD 125"           → "DD 125/2026"
//   "dd fir 125"       → "DD FIR 125/2026"  (a FIR logged as a DD)
//   "DD FIR 125"       → "DD FIR 125/2026"
// Anything that doesn't look like a FIR/DD query is returned unchanged so
// the existing exact / substring fallbacks still work (MK- no., etc.).
function normaliseFirQuery(q) {
  const s = String(q || '').trim();
  if (!s) return s;
  const low = s.toLowerCase();

  // Pull the leading integer(s) — the case number.  Allow "125" or
  // "2026/125" style; we only care about the trailing number when a year
  // prefix is present.  Capture trailing digits group.
  const numMatch = s.match(/(\d{1,6})\s*(?:\/\s*(\d{2,4}))?\s*$/);
  if (!numMatch) return s;
  const num = numMatch[1];
  const yr = numMatch[2]
    ? normaliseFyYear(numMatch[2])
    : currentFyYear();

  // Determine record type + whether it's a FIR-under-DD.
  const isDd = /(^|\s)dd(\s|$)/.test(low);
  const isFir = /(^|\s)fir(\s|$)/.test(low);
  const isDdFir = isDd && isFir; // "dd fir 125" / "dd fir no 125"

  if (isDdFir) return `DD FIR ${num}/${yr}`;
  if (isDd)     return `DD ${num}/${yr}`;
  if (isFir)    return `FIR ${num}/${yr}`;

  // No keyword at all (e.g. just "125").  Leave it as the bare number so
  // the loose matching below can match both "FIR 125/2026" and
  // "DD FIR 125/2026" and surface them as candidates.
  return num;
}

// Normalise a 2- or 4-digit year to the 4-digit FY year used in ids.
function normaliseFyYear(y) {
  const n = parseInt(y, 10);
  if (y.length <= 2) {
    // "25" → 2025, "26" → 2026.  Assume 2000s.
    return 2000 + n;
  }
  return n;
}

// Current financial-year year suffix (Apr–Mar).  Used when the MM omits
// the year, e.g. "FIR 125" → "FIR 125/2026".
function currentFyYear() {
  const now = new Date();
  // FY starts 1 Apr: Apr–Dec → same year; Jan–Mar → previous year.
  const fy = (now.getMonth() >= 3) ? now.getFullYear() : now.getFullYear() - 1;
  return fy + 1; // FY label year (e.g. "2026" for Apr 2025–Mar 2026)
}

function resolveCaseId(raw) {
  const db = getDb();
  const all = [...db.cases, ...(db.extraCasesForAlerts || [])];
  const q = String(raw || '').trim();
  if (!q) return { case: null, suggestions: all.slice(0, 5).map(c => c.id) };

  // ---- FIR/DD-aware matching ----
  // Normalise keywords ("fir 125" → "FIR 125/2026", "dd 125" → "DD 125/2026",
  // "dd fir 125" → "DD FIR 125/2026", "125" → "125").
  const norm = normaliseFirQuery(q);

  // 1) exact (canonical or normalised)
  let hit = all.find(c => c.id === norm || c.id === q);
  if (hit) return { case: hit, suggestions: [] };

  // 1b) case-insensitive
  const normL = norm.toLowerCase();
  const qL = q.toLowerCase();
  hit = all.find(c => c.id.toLowerCase() === normL || c.id.toLowerCase() === qL);
  if (hit) return { case: hit, suggestions: [] };

  // 2) loose keyword match:
  //    - If a FIR/DD keyword was present, match the canonical-type prefix
  //      exactly (e.g. "FIR 125" only matches ids starting "FIR 125").
  //    - If no keyword (bare number "125"), match ANY id containing that
  //      number so "FIR 125/2026" AND "DD FIR 125/2026" both surface.
  //    This is what disambiguates between "FIR 125" and "DD FIR 125".
  const looksFirDd = /(^|\s)(fir|dd)(\s|$)/i.test(q);
  const numMatch = norm.match(/\d{1,6}/);
  const num = numMatch ? numMatch[0] : null;
  if (num) {
    const matches = all.filter(c => {
      const idL = c.id.toLowerCase();
      if (looksFirDd) {
        // keyword present → demand the exact prefix token before the number
        const prefix = /dd fir/i.test(q) ? 'dd fir '
          : /(^|\s)dd(\s|$)/i.test(q) ? 'dd '
          : 'fir ';
        return idL.startsWith(prefix + num + '/') || idL === prefix.trim() + ' ' + num;
      }
      // bare number → any id containing that number
      return idL.includes(num);
    });
    if (matches.length === 1) return { case: matches[0], suggestions: [] };
    if (matches.length > 1)  return { case: null, suggestions: matches.slice(0, 8).map(c => c.id) };
  }

  // 3) any substring (unique) — last resort for MK- numbers, partial text
  const subs = all.filter(c => c.id.toLowerCase().includes(qL));
  if (subs.length === 1) return { case: subs[0], suggestions: [] };
  return { case: null, suggestions: subs.slice(0, 8).map(c => c.id) };
}
function allCases() {
  const db = getDb();
  // Always resolve section name at read time so renames propagate.
  // The case record stores ONLY the letter reference ("PART A"); the
  // display name is joined from db.sections on every read.
  return [...db.cases, ...(db.extraCasesForAlerts || [])]
    .map(c => withFreshSectionName(c, db))
    .map(c => decorateCaseRow(c, db));
}

// Attach the two derived columns the Case Property Register (and the
// downloadable reports) need: a parsed `quantity` and the
// `lastMovement` date.  Computed synchronously from the in-memory
// mirror so /api/cases can return them alongside every case.  Mirrors
// the logic in toReportRow()/lastMovementDate() used by the report
// endpoints, so the on-screen table and the PDF/XLSX stay in lock-step.
function decorateCaseRow(c, db) {
  if (!c) return c;
  // Quantity is parsed out of the leading "<n> unit(s) · …" pattern that
  // RegisterCaseModal prefixes into itemSub.  Falls back to "1" when
  // nothing is parseable (legacy seed rows).
  let quantity = '1';
  if (c.itemSub) {
    const m = c.itemSub.match(/^(\d+)\s*unit/i);
    if (m) quantity = m[1];
  }
  c.quantity = quantity;

  // FIR Date — joined from the FIR/DD master (fir_master.fir_date, falling
  // back to dd_date for DD records).  This is the date the FIR/DD was
  // registered, shown in the register's "FIR Date" column.  Empty when no
  // master row exists yet (legacy rows registered before fir_master).
  const fmKey = String(c.id || '').toLowerCase();
  const fmFirNo = String(c.firNo || c.id || '').toLowerCase();
  const fm = (db.firMaster || []).find(f => f.firNo && (
    f.firNo.toLowerCase() === fmKey || f.firNo.toLowerCase() === fmFirNo
  ));
  c.firDate = fm && fm.firDate ? fm.firDate : '';
  if (!c.legalSection && (!c.legalSections || !c.legalSections.length) && fm && fm.usSections) {
    c.legalSection = fm.usSections;
  }

  // Received By (Malkhana Moharrir) — joined from case_property.received_by,
  // keyed by the item's unique item_id (MK-xxxx).  Empty when the receipt
  // hasn't been recorded yet.
  const cpKey = String(c.itemId || '').toLowerCase();
  const cp = (db.caseProperty || []).find(p => p.itemId && p.itemId.toLowerCase() === cpKey);
  c.receivedBy = cp && cp.receivedBy ? cp.receivedBy : '';

  // Last-movement date: most recent movements-log entry for this case,
  // else the case's createdAt / seizedOn as a fallback.
  const ms = (db.movements || [])
    .filter(m => m.caseId === c.id)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  c.lastMovement = ms.length
    ? ms[ms.length - 1].timestamp.slice(0, 10)
    : (c.createdAt ? c.createdAt.slice(0, 10) : '');
  return c;
}

// Resolve the current section name for a case. Replaces any stale
// `sectionName` stored on the case record (e.g. from before a section
// rename). The letter reference ("PART A" or "PART AA") stays on c.section —
// only the display name is recomputed. Falls back to whatever was stored
// if the section is missing or deleted, so we never silently lose data.
function withFreshSectionName(c, db) {
  if (!c) return c;
  const m = String(c.section || '').match(/PART ([A-Z]{1,2})/i);
  if (m) {
    const letter = m[1].toUpperCase();
    const s = (db.sections || []).find(x => x.letter === letter);
    if (s) { c.sectionName = s.name; c.sectionLetter = letter; return c; }
  }
  // Fallback: section was deleted. Keep the stored name (or letter) so the
  // user can still see what was there, but mark it.
  if (!c.sectionName) c.sectionName = c.section || 'Unknown section';
  return c;
}
function dashboardStats() {
  const db = getDb();
  const cs = allCases();
  const total        = cs.length;
  // Pending Disposal = every case in any stage EXCEPT 'Disposed'.
  // (Covers Seized, Expert Opinion Pending, In Malkhana, With FSL, In Court.)
  const pendingDisp  = cs.filter(c => c.status !== 'Disposed').length;
  const expert       = cs.filter(c => c.status === 'Expert Opinion Pending').length;
  const withFsl      = cs.filter(c => c.status === 'With FSL').length;
  const transfers    = cs.filter(c => c.status === 'Transfer').length;
  return {
    totalProperty:   db.cases.length,            // only "real" register, matches design
    pendingDisposal: pendingDisp,
    expertPending:   expert,
    withFSL:         withFsl,
    transfers:       transfers,
    inspectionDue:   inspectionDueText(),
    station:         db.meta.station,
    // Always show the current server time — never a stale seeded value
    // (the dashboard "As of …" should reflect whenever it was loaded).
    asOf:            formatAsOf(new Date()),
  };
}

// Matches the visual format the dashboard was designed around:
//   "05 Jul 2026, 10:42 AM"
// Pinned to Asia/Kolkata so the "As of …" stamp shows IST (the deployment
// host — Vercel — runs in UTC, otherwise the time is off by 5h30m).
function formatAsOf(d) {
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}
function inspectionDueText() {
  const db = getDb();
  const last = new Date(db.alertConfig.lastInspection);
  const next = new Date(last.getTime() + db.alertConfig.inspectionCycleDays * 86400000);
  const days = Math.floor((next - new Date()) / 86400000);
  return days <= 0 ? 'Overdue' : `${days} days`;
}
function recentMovements(limit = 8) {
  const db = getDb();
  // Look up the case from the in-memory mirror SYNCHRONOUSLY.  getCase()
  // is async (it awaits ensureReady()), so calling it without await here
  // returned a Promise and `c?.itemType` was always undefined — which is
  // why the Item column rendered as "—" forever.  The mirror is fully
  // loaded by boot() before any handler runs, so a direct find is safe.
  const caseById = (id) =>
    (db.cases || []).find(x => x.id === id)
    || (db.extraCasesForAlerts || []).find(x => x.id === id);
  return [...db.movements]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
    .map(m => {
      const c = caseById(m.caseId);
      const from = m.fromLocation === '—' ? 'New' : m.fromLocation;
      return {
        fir: m.caseId,
        item: c?.itemType || '—',
        movement: `${from} → ${m.toLocation}`,
        by: m.movedBy,
        time: humanTime(m.timestamp),
      };
    });
}
// Format a movement timestamp for the dashboard's Recent Activity table.
// Pinned to Asia/Kolkata so the "Today"/"Yesterday" boundary and the time
// itself are correct for Indian users even though the host (Vercel) is UTC.
// A movement logged at IST 02:00 is stored as UTC 20:30 the previous day,
// so the midnight comparison MUST happen in IST or it gets mislabeled.
function humanTime(iso) {
  const d = new Date(iso);
  const istDate = (x) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(x); // "YYYY-MM-DD" in IST
  const time = d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
  const todayStr = istDate(new Date());
  const movStr = istDate(d);
  if (movStr === todayStr) return `Today, ${time}`;
  const yest = new Date(Date.now() - 86400000);
  if (istDate(yest) === movStr) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

// =================== alert scan job ===================

function scanAlerts() {
  const db = getDb();
  const cfg = db.alertConfig;
  const out = [];

  for (const c of allCases()) {
    // FSL overdue
    if (c.status === 'With FSL') {
      const fslMove = [...db.movements].reverse().find(m => m.caseId === c.id && m.toLocation.toLowerCase().includes('fsl'));
      if (fslMove) {
        const days = daysBetween(fslMove.timestamp);
        if (days > cfg.fslDays) {
          out.push({
            level: 'urgent',
            title: `${c.id} — FSL report pending ${days} days`,
            desc:  `Sent to ${fslMove.toLocation} on ${fslMove.timestamp.slice(0,10)}. Threshold: ${cfg.fslDays} days.`,
            days:  `+${days - cfg.fslDays} days over`,
            category: 'fsl',
            caseId: c.id,
          });
        }
      }
    }
    // Expert opinion overdue
    if (c.status === 'Expert Opinion Pending') {
      const move = [...db.movements].reverse().find(m => m.caseId === c.id);
      const days = daysBetween(move.timestamp);
      if (days > cfg.expertDays) {
        out.push({
          level: 'urgent',
          title: `${c.id} — Expert opinion pending ${days} days`,
          desc:  `Sent to ${move.toLocation} on ${move.timestamp.slice(0,10)} for opinion. Threshold: ${cfg.expertDays} days.`,
          days:  `+${days - cfg.expertDays} days over`,
          category: 'expert',
          caseId: c.id,
        });
      }
    }
    // Court / disposal overdue
    if (c.status === 'In Court' && daysBetween(c.createdAt) > cfg.courtDays) {
      // Synthetic: not part of seed, but the engine handles it generically.
    }
  }

  // Inspection reminder
  {
    const last = new Date(cfg.lastInspection);
    const next = new Date(last.getTime() + cfg.inspectionCycleDays * 86400000);
    const days = Math.floor((next - new Date()) / 86400000);
    out.push({
      level: days <= 7 ? 'warn' : 'urgent',
      title: `Quarterly inspection due — Malkhana, ${db.meta.station}`,
      desc:  `Last inspection: ${cfg.lastInspection}. Next due: ${next.toISOString().slice(0,10)}.`,
      days:  days <= 0 ? 'Overdue' : (days === 1 ? '1 day' : `${days} days`),
      category: 'inspection',
    });
  }

  // Persist into alert_issues. Catch so an unhandled rejection can't crash
  // the process if the alertIssues write fails after a PATCH.
  mutate(d => { d.alertIssues = out; })
    .catch(e => console.error('[alerts] failed to persist alertIssues:', e.message));
  return out;
}
function getAlertIssues() {
  const db = getDb();
  return db.alertIssues || scanAlerts();
}

// =================== API: dashboard / cases / alerts ===================

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'e-malkhana', time: nowISO() });
});

// =================== API: MM login ===================
// POST /api/login   { loginId, password? }
// Returns the user record on success, 401 on failure.
app.post('/api/login', async (req, res) => {
  const { loginId, password } = req.body || {};
  const db = getDb();
  // Normalise: trim + uppercase, then accept EITHER the official id (MM-001)
  // OR the officer's name (full name or first name, case-insensitive). This
  // matches the real-world flow where MMs type what they remember — the
  // ledger says "Rakesh" but the form field says "MM-001" and confusion follows.
  const raw = String(loginId || '').trim();
  const idKey = raw.toUpperCase();
  const nameKey = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  const users = db.users || [];
  const u = users.find(x =>
    x.id.toUpperCase() === idKey
    || (x.name || '').toLowerCase() === nameKey
    || (x.name || '').toLowerCase().split(/\s+/).includes(nameKey)          // any single word
    || (nameKey.length >= 3 && (x.name || '').toLowerCase().includes(nameKey))  // "rakesh sharma" → "SI Rakesh Sharma"
  );
  if (!u) {
    return res.status(401).json({
      error: 'unknown login id',
      tried: raw,
      suggestions: users.map(x => x.id),
      hint: 'Use your MM Login ID (e.g. MM-001). The officer name also works.',
    });
  }
  if (u.password && password !== u.password) {
    return res.status(401).json({ error: 'wrong password', hint: `Demo password: ${process.env.DEMO_PW || 'malkhana2026'}` });
  }
  // strip the password before returning
  const { password: _pw, ...safe } = u;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json({ user: safe, station: db.meta.station, asOf: formatAsOf(new Date()) });
  // Audit the login (using the same request that we now know is authenticated)
  await auditMm({ mm: { id: u.id, name: u.name } }, 'login', u.id, `Malkhana Moharrir signed in`);
});

app.get('/api/users', (_req, res) => {
  const db = getDb();
  // Never return the password field
  res.json((db.users || []).map(({ password, ...u }) => u));
});

app.get('/api/dashboard', (_req, res) => {
  const db = getDb();
  // Only return ACTIVE sections — the sidebar shouldn't show deactivated
  // rows, and the manager modal fetches `/api/sections?active=all` for the
  // full list.  Counts (per-section) are still meaningful because the
  // rebuild pass accounts for cases on deactivated sections too.
  const activeSections = (db.sections || []).filter(s => s.active !== false);
  res.json({
    officer: db.officer,
    racks: activeSections,
    stats: dashboardStats(),
    recentMovements: recentMovements(),
    priorityAlerts: getAlertIssues().slice(0, 3),
  });
});

app.get('/api/cases', (_req, res) => {
  res.json(allCases());
});

app.get('/api/cases/:id', (req, res, next) => {
  try {
    const db = getDb();
    const row = findOrThrow(req.params.id);
    res.json(decorateCaseRow(withFreshSectionName(row, db), db));
  }
  catch (e) { next(e); }
});

app.post('/api/cases', async (req, res, next) => {
  try {
    const out = await createOneCase(req, req.body || {});
    res.status(201).json(withFreshSectionName(out.newCase, getDb()));
  } catch (e) { next(e); }
});

// Shared case-creation logic used by POST /api/cases (single item) and
// POST /api/cases/batch (multiple items under one FIR/DD).  Validates the
// FIR/DD number, section, item type, and BNS legal sections; mints a UNIQUE
// Malkhana Sr. No. (sequence) per item; returns the new case row + metadata
// the caller needs to write the per-item case_property row.
async function createOneCase(req, body) {
  const required = ['firOrDd', 'itemType', 'section', 'seizingOfficer']; // photo is OPTIONAL
  for (const k of required) if (!body[k]) { const e = new Error(`missing field: ${k}`); e.status = 400; throw e; }

  const section = db_sectionByLetter(body.section);
  const id = body.firOrDd.trim();
  // Unique Malkhana Sr. No. for THIS item (sequence -> no collisions even
  // when several items share one FIR/DD number).
  const itemId = body.itemId || await nextMalkhanaSrNo();
  const createdAt = nowISO();

  // Item Type: optional controlled-vocabulary link.  The MM picks
  // from /api/item-types dropdown (per section).  If supplied we
  // validate it exists + belongs to the chosen section; the free-text
  // `description` (e.g. "80 grams, sealed poly bag") carries the
  // case-specific specifics instead of overloading itemType.
  let itemTypeId = null, itemTypeName = null;
  if (body.itemTypeId != null && body.itemTypeId !== '' && body.itemTypeId !== 0) {
    const it = db_itemTypeById(Number(body.itemTypeId));
    if (!it) { const e = new Error(`unknown item type id: ${body.itemTypeId}`); e.status = 400; throw e; }
    if (it.sectionLetter !== section.letter) {
      const e = new Error(`item type "${it.name}" belongs to Part ${it.sectionLetter}, not Part ${section.letter}`);
      e.status = 400; throw e;
    }
    itemTypeId = it.id;
    itemTypeName = it.name;
  }
  // Multi-section support: the user can book a case under several legal
  // sections across multiple acts at once (e.g. "BNS 101 — Murder" +
  // "NDPS 20 — Possession of cannabis").  `body.legalSections` is an
  // ordered array of section keys, each formatted as "ACT:N" (e.g.
  // "BNS:101", "NDPS:20", "IPC:304A").  Each is validated against the
  // multi-act reference table; the legacy `legalSection`/`legalSectionTitle`
  // columns keep the PRIMARY (first) entry's bare number + title for the
  // register tag / reports.
  let legalSection = null, legalSectionTitle = null;
  let legalSections = [], legalSectionsTitles = [];
  let legalSectionsActs = [], legalSectionsNos = [];
  if (Array.isArray(body.legalSections) && body.legalSections.length) {
    for (const raw of body.legalSections) {
      const hit = db_legalSectionByKey(raw);
      if (hit) {
        legalSectionsActs.push(hit.actCode);
        legalSectionsNos.push(hit.sectionNo);
        legalSections.push(`${hit.actCode}:${hit.sectionNo}`);
        legalSectionsTitles.push(hit.title);
      } else {
        // Fallback: accept the raw key without validation so legacy
        // single-act BNS rows don't break.
        const parsed = parseLegalKey(raw);
        if (parsed) {
          legalSectionsActs.push(parsed.actCode);
          legalSectionsNos.push(parsed.sectionNo);
          legalSections.push(`${parsed.actCode}:${parsed.sectionNo}`);
          legalSectionsTitles.push('');
        }
      }
    }
    legalSection = legalSectionsNos[0] || null;
    legalSectionTitle = legalSectionsTitles[0] || null;
  } else if (body.legalSection) {
    // Backward-compat: single section still accepted.
    const hit = db_legalSectionByKey(body.legalSection);
    if (hit) {
      legalSectionsActs = [hit.actCode];
      legalSectionsNos = [hit.sectionNo];
      legalSections = [`${hit.actCode}:${hit.sectionNo}`];
      legalSectionsTitles = [hit.title];
      legalSection = hit.sectionNo;
      legalSectionTitle = hit.title;
    } else {
      const secNo = String(body.legalSection).replace(/^BNS\s+/i, '').trim();
      const parsed = parseLegalKey(body.legalSection);
      legalSection = secNo || null;
      legalSectionTitle = '';
      legalSectionsActs = parsed ? [parsed.actCode] : ['BNS'];
      legalSectionsNos = parsed ? [parsed.sectionNo] : [secNo];
      legalSections = parsed ? [`${parsed.actCode}:${parsed.sectionNo}`] : [secNo];
      legalSectionsTitles = [''];
    }
  } else if (body.usSections || body.us_sections) {
    const rawUs = String(body.usSections || body.us_sections).trim();
    if (rawUs) {
      // Legacy "NDPS 21, 22" style free-text — accept as-is, mark as BNS.
      legalSection = rawUs;
      legalSectionTitle = '';
      legalSections = [rawUs];
      legalSectionsTitles = [''];
      legalSectionsActs = [];
      legalSectionsNos = [];
    }
  }
  const newCase = {
    id,
    firNo: body.firNo || id,                 // FIR number for register grouping (defaults to id)
    itemType:   itemTypeName || body.itemType,
    itemSub:    body.itemSub || '',
    section:    `PART ${section.letter}`,
    status:     body.status || 'Seized',
    seizingOfficer: body.seizingOfficer,
    itemId,
    imageUrl:   body.photo || undefined,
    skipAutoImage: !body.photo,                              // protect newly-registered cases from auto-dummy
    docRef:     body.supportingDoc || undefined,             // optional — seizure memo URL
    legalSection,
    legalSectionTitle,
    legalSections,
    legalSectionsTitles,
    legalSectionAct: legalSectionsActs[0] || null,        // primary act code
    legalSectionsActs: legalSectionsActs || [],            // parallel array
    itemTypeId: itemTypeId != null ? itemTypeId : undefined,
    description: body.description || undefined,
    createdAt,
  };
  await mutate(d => { d.cases.push(newCase); rebuildSectionCountsIn(d); });
  await auditMm(req, 'case.create', id, `Registered item: ${body.itemType} (Part ${section.letter} — ${section.name}) — seized by ${body.seizingOfficer}${legalSection ? ` — ${(legalSectionsActs[0] || 'BNS')} ${legalSection} (${legalSectionTitle})` : ''} — Sr. No. ${itemId}`);
  return { newCase, itemId, legalSection, legalSectionTitle };
}

// POST /api/cases/batch  — register several items under one FIR/DD in a
// single request.  Body:
//   { firOrDd, firNo?, recordType?, ...firMaster,   // FIR/DD master upserted once
//     common: { seizedTime, witness1, witness2, quantity, placeOfSeizure,
//               physicalStorage, remarks, status, dateOfReceipt, receivedBy,
//               malkhanaLocation, seizedOn?, seizingOfficer? },
//     items: [ { itemType, section, sectionLetter, itemTypeId?, description?,
//                category?, malkhanaSection?, legalSections?, photo?,
//                popupFields:[{key,value}], sealSealed?, sealNo?, sealBy? } ] }
// Each item gets its OWN unique Malkhana Sr. No.  The FIR master is upserted
// once; the common block + per-item case_property rows are written under
// each item's Sr. No.  Returns { items: [{ itemId, ... }], firNo }.
app.post('/api/cases/batch', async (req, res, next) => {
  try {
    const body = req.body || {};
    const firNo = String(body.firOrDd || body.firNo || '').trim();
    if (!firNo) { const e = new Error('firOrDd is required'); e.status = 400; throw e; }
    if (!Array.isArray(body.items) || !body.items.length) {
      const e = new Error('items[] is required (at least one)'); e.status = 400; throw e;
    }
    // 1) Upsert FIR/DD master once.
    if (body.policeStation !== undefined || body.recordType || body.ddDate || body.natureOfDd) {
      await upsertFirMaster({
        firNo, recordType: body.recordType || 'FIR',
        policeStation: body.policeStation || '', firDate: body.firDate || null,
        usSections: body.usSections || null, io: body.io || null,
        ddDate: body.ddDate || null, natureOfDd: body.natureOfDd || null,
        nameOfDeceased: body.nameOfDeceased || null, reportingPerson: body.reportingPerson || null,
        actualSeizureDdNo: body.actualSeizureDdNo || null, actualSeizureDate: body.actualSeizureDate || null,
      });
    }
    // 2) Common block (copied onto every item, with per-item overrides below).
    const c = body.common || {};
    const created = [];
    for (const it of body.items) {
      const one = await createOneCase(req, {
        firOrDd: firNo,
        firNo,
        itemType: it.itemType,
        itemSub: it.itemSub || '',
        section: it.sectionLetter || it.section,   // accept either letter or "PART X"
        seizingOfficer: it.seizingOfficer || c.seizingOfficer || '',
        itemTypeId: it.itemTypeId != null ? it.itemTypeId : null,
        legalSections: it.legalSections || c.legalSections || [],
        description: it.description || '',
        photo: it.photo || undefined,
        status: it.status || c.status || 'Seized',
      });
      // 3) Write the case_property (common + per-item specific + seal block).
      const common = {
        firNo,
        seizedTime: it.seizedTime ?? c.seizedTime,
        witness1: c.witness1, witness2: c.witness2,
        quantity: it.quantity ?? c.quantity,
        placeOfSeizure: it.placeOfSeizure ?? c.placeOfSeizure,
        physicalStorage: it.physicalStorage ?? c.physicalStorage,
        photoUrl: (it.photo ? (await apiUploadInline(it.photo)) : undefined) || c.photoUrl,
        remarks: it.remarks ?? c.remarks,
        status: it.status || c.status || 'Seized',
        dateOfReceipt: it.dateOfReceipt ?? c.dateOfReceipt,
        receivedBy: it.receivedBy ?? c.receivedBy,
        malkhanaLocation: it.malkhanaLocation ?? c.malkhanaLocation,
        sealSealed: it.sealSealed ?? null,
        sealNo: it.sealNo ?? null,
        sealBy: it.sealBy ?? null,
      };
      const fields = Array.isArray(it.popupFields)
        ? it.popupFields.map(f => ({ key: f.key, value: f.value }))
        : [];
      // Persist the item's chosen Malkhana Section (placement) as a field too.
      if (it.malkhanaSection) fields.push({ key: 'malkhana_section', value: it.malkhanaSection });
      if (it.category) fields.push({ key: 'category', value: it.category });
      await upsertCaseProperty(one.itemId, common, fields);
      created.push({ itemId: one.itemId, itemType: one.newCase.itemType, section: one.newCase.section });
    }
    // Refresh the in-memory mirror's caseProperty / firMaster slices so the
    // freshly-registered item's Received-By + FIR-Date join correctly on the
    // very next detail GET (decorateCaseRow reads them from the mirror).
    // Best-effort: never fails the registration that already succeeded.
    try {
      await syncRegistrationMirrors(created[0]?.itemId, firNo);
    } catch { /* no-op */ }
    res.status(201).json({ firNo, items: created });
  } catch (e) { next(e); }
});

// Upload endpoint — accepts JSON { name, type, dataUrl } where dataUrl is
// a `data:<mime>;base64,...` string.  Saves the file and returns its URL.
app.post('/api/upload', async (req, res) => {
  const { name, dataUrl } = req.body || {};
  if (!name || !dataUrl) return res.status(400).json({ error: 'name and dataUrl are required' });
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'dataUrl must be data:<mime>;base64,<...>' });
  const mime = m[1];
  const ext = mime.split('/')[1] || 'bin';
  const safeName = name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}.${ext}`;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'file too large (10MB max)' });
  const url = writeUpload(filename, buf);
  await auditMm(req, 'file.upload', name, `Uploaded ${humanBytes(buf.length)} (${mime}) → ${url}`);
  res.status(201).json({ url, filename, mime, bytes: buf.length });
});

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Upload a data: URL photo and return its public URL.  Used by the batch
// registration endpoint so a per-item photo can be attached inline.  Returns
// null if the value isn't a valid data URL (caller falls back to common).
async function apiUploadInline(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const ext = mime.split('/')[1] || 'bin';
  const safeName = `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return null;
  return writeUpload(safeName, buf);
}

app.patch('/api/cases/:id/status', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) { const e = new Error('invalid status'); e.status = 400; throw e; }
    let updated = null;
    await mutate(d => {
      const c = d.cases.find(x => x.id === id);
      if (!c) { const e = new Error('case not found'); e.status = 404; throw e; }
      c.status = status;
      updated = c;
    });
    await auditMm(req, 'case.status', id, `Changed status: ${id} → ${status}`);
    res.json(updated);
  } catch (e) { next(e); }
});

// =================== helpers (case_property + fir_master writes) ===================
//
// The PATCH /api/cases/:id handler below can edit fields that live in
// sibling tables (case_property.received_by, fir_master.fir_date).  These
// helpers keep the in-memory mirror and Postgres in lock-step so the
// subsequent decorateCaseRow() pass (called by withFreshSectionName before
// res.json) sees the freshly-written value.

function ensureCasePropertyFor(c) {
  const db = getDb();
  if (!db.caseProperty) db.caseProperty = [];
  let cp = db.caseProperty.find(p => p.itemId && p.itemId.toLowerCase() === String(c.itemId || '').toLowerCase());
  if (!cp) {
    cp = { itemId: c.itemId, firNo: c.firNo || c.id, receivedBy: null };
    db.caseProperty.push(cp);
  }
  return cp;
}

async function dbSaveCaseProperty(cp) {
  // Mirror upsertCaseProperty in db.js — but keeps the in-memory copy the
  // source of truth so subsequent reads see the new value immediately.
  if (!cp || !cp.itemId) return;
  const { upsertCaseProperty } = await import('./db.js').catch(() => ({}));
  if (typeof upsertCaseProperty === 'function') {
    await upsertCaseProperty(cp);
  }
}

async function upsertFirMasterPartial({ firNo, firDate }) {
  if (!firNo) return;
  const db = getDb();
  if (!db.firMaster) db.firMaster = [];
  let fm = db.firMaster.find(f => f.firNo && f.firNo.toLowerCase() === firNo.toLowerCase());
  if (!fm) {
    fm = { firNo, policeStation: '', firDate: firDate || null, usSections: null, io: null,
           recordType: 'FIR', ddDate: null, natureOfDd: null, nameOfDeceased: null,
           reportingPerson: null, actualSeizureDdNo: null, actualSeizureDate: null };
    db.firMaster.push(fm);
  } else {
    fm.firDate = firDate || null;
  }
  // Best-effort Postgres upsert (silently no-op if the helper changes shape).
  try {
    const { upsertFirMaster } = await import('./db.js');
    if (typeof upsertFirMaster === 'function') {
      await upsertFirMaster(fm);
    }
  } catch {}
}

// PATCH /api/cases/:id
//
// Edit the editable fields of a case from the Case Property Detail page.
// The case id itself is immutable (it's the FIR/DD number — renaming that
// would break every movement / alert / QR link that points at it).  All
// other fields the user can see in the detail view are editable, but only
// the actually-rendered slim set (13 fields) — the Edit Case Property
// modal mirrors the on-screen detail card 1-for-1, not the full
// registration form.  Seal / per-category popup / DD-extras stay editable
// through the dedicated `/cases/batch` (registration) endpoint, NOT here.
//
// Body (all fields OPTIONAL — only present keys are touched):
//   {
//     itemType?, itemSub?, section?, seizingOfficer?, itemId?,
//     legalSection?, legalSections?, itemTypeId?, description?,
//     receivedBy?,   (Malkhana Moharrir → case_property.received_by)
//     firDate?,      (YYYY-MM-DD → fir_master.fir_date)
//     imageUrl?,     (data-URL OR URL OR null/"" to clear)
//     status?,       (must be one of STATUSES)
//     caseProperty?: { seizedTime?, receivedBy?, quantity?, remarks? }
//   }
//
// Returns the updated CaseRow (with fresh sectionName joined from the
// sections table, same as GET /api/cases/:id).
//
// Audit log entry is written for every successful update, summarising
// ONLY the fields that actually changed (so a no-op PATCH doesn't pollute
// the audit log).
app.patch('/api/cases/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    // Allow-list of editable keys.  Anything outside this list is silently
    // dropped.  Aligned with the slim Edit Case Property modal — no DD
    // extras, no seal block, no per-category popup fields.  See
    // client/src/components/CasePropertyDetail.tsx for the matching form.
    //
    // shortVal: trim noisy strings for the audit log diff so a 200-char
    // remarks change doesn't balloon the entry to multiple lines.
    const shortVal = (s) => (s == null ? '—' : String(s).length > 30 ? String(s).slice(0, 27) + '…' : String(s));
    const ALLOWED = ['itemType', 'itemSub', 'section', 'seizingOfficer', 'itemId', 'legalSection',
                      'legalSections', 'itemTypeId', 'description',
                      'receivedBy', 'firDate', 'imageUrl', 'status',
                      'caseProperty'];
    const patch = {};
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) { const e = new Error('no editable fields supplied'); e.status = 400; throw e; }

    // Validate status if provided (same allow-list as PATCH /:id/status).
    if (Object.prototype.hasOwnProperty.call(patch, 'status') && !STATUSES.includes(patch.status)) {
      const e = new Error(`invalid status: ${patch.status}`); e.status = 400; throw e;
    }
    // Normalise empty firDate to null so we can clear it.
    let newFirDate = undefined;          // undefined = no change requested
    if (Object.prototype.hasOwnProperty.call(patch, 'firDate')) {
      const raw = patch.firDate;
      if (raw == null || String(raw).trim() === '') newFirDate = null;
      else {
        // Accept YYYY-MM-DD or display formats like "17 Jul 2026".
        const iso = String(raw).trim().match(/^\d{4}-\d{2}-\d{2}$/) ? String(raw).trim()
          : (() => { const d = new Date(raw); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); })();
        if (!iso) { const e = new Error(`invalid firDate: ${raw}`); e.status = 400; throw e; }
        newFirDate = iso;
      }
    }
    let newImageUrl = undefined;        // undefined = no change requested
    if (Object.prototype.hasOwnProperty.call(patch, 'imageUrl')) {
      const raw = patch.imageUrl;
      if (raw == null || String(raw).trim() === '') {
        newImageUrl = null;
      } else {
        const s = String(raw).trim();
        // data: URL — upload via the existing inline helper and replace
        // the file on disk.  Caller is the Edit Case Property modal.
        if (s.startsWith('data:')) {
          const uploaded = await apiUploadInline(s);
          if (!uploaded) { const e = new Error('failed to upload photo (bad data URL)'); e.status = 400; throw e; }
          newImageUrl = uploaded;
        } else {
          // Pass-through URL (already on disk, e.g. user untouched it).
          newImageUrl = s;
        }
      }
    }
    let newReceivedBy = undefined;      // undefined = no change requested
    if (Object.prototype.hasOwnProperty.call(patch, 'receivedBy')) {
      const raw = patch.receivedBy;
      newReceivedBy = (raw == null || String(raw).trim() === '') ? '' : String(raw).trim();
    }

    // Normalise / validate section letter if provided.
    let newSectionLetter = null;
    if (patch.section != null) {
      const sec = db_sectionByLetter(patch.section);
      if (!sec) { const e = new Error(`unknown section: ${patch.section}`); e.status = 400; throw e; }
      newSectionLetter = sec.letter;
    }

    // Validate + normalise itemTypeId if provided.
    let newItemTypeId = undefined;        // undefined = no change requested
    let newItemTypeName = undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'itemTypeId')) {
      const raw = patch.itemTypeId;
      if (raw == null || raw === '' || raw === 0) {
        newItemTypeId = null;                    // clear the link
        newItemTypeName = null;
      } else {
        const it = db_itemTypeById(Number(raw));
        if (!it) { const e = new Error(`unknown item type: ${raw}`); e.status = 400; throw e; }
        if (newSectionLetter && it.sectionLetter !== newSectionLetter) {
          const e = new Error(`item type "${it.name}" belongs to Part ${it.sectionLetter}, not Part ${newSectionLetter}`);
          e.status = 400; throw e;
        }
        newItemTypeId = it.id;
        newItemTypeName = it.name;
      }
    }
    let newLegalSection = undefined;
    let newLegalSectionTitle = undefined;
    let newLegalSections = undefined;        // undefined = no change requested
    let newLegalSectionsTitles = undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'legalSections')) {
      // Multi-section edit: an array of section numbers.
      const arr = Array.isArray(patch.legalSections) ? patch.legalSections : [];
      const secs = [], tits = [];
      for (const raw of arr) {
        const secNo = String(raw).replace(/^BNS\s+/i, '').trim();
        const hit = db_bnsSectionByNo(secNo);
        if (!hit) { const e = new Error(`unknown BNS section: ${raw}`); e.status = 400; throw e; }
        secs.push(hit.sectionNo);
        tits.push(hit.title);
      }
      newLegalSections = secs;
      newLegalSectionsTitles = tits;
      newLegalSection = secs[0] || null;          // primary = first
      newLegalSectionTitle = tits[0] || null;
    } else if (Object.prototype.hasOwnProperty.call(patch, 'legalSection')) {
      const raw = patch.legalSection;
      if (raw == null || String(raw).trim() === '') {
        newLegalSection = null;
        newLegalSectionTitle = null;
      } else {
        const secNo = String(raw).replace(/^BNS\s+/i, '').trim();
        const hit = db_bnsSectionByNo(secNo);
        if (!hit) { const e = new Error(`unknown BNS section: ${raw}`); e.status = 400; throw e; }
        newLegalSection = hit.sectionNo;
        newLegalSectionTitle = hit.title;
      }
    }

    let updated = null;
    const changes = [];
    await mutate(async d => {
      const c = d.cases.find(x => x.id === id);
      if (!c) { const e = new Error('case not found'); e.status = 404; throw e; }

      // Apply each field + record a change line for the audit log.
      if ('itemType' in patch) {
        const v = String(patch.itemType || '').trim();
        if (!v) { const e = new Error('itemType cannot be empty'); e.status = 400; throw e; }
        if (c.itemType !== v) { changes.push(`item: "${c.itemType}" → "${v}"`); c.itemType = v; }
      }
      if ('itemSub' in patch) {
        const v = String(patch.itemSub || '').trim();
        if (c.itemSub !== v) { changes.push(`detail: "${c.itemSub || ''}" → "${v}"`); c.itemSub = v; }
      }
      if ('section' in patch) {
        if (c.section !== `PART ${newSectionLetter}`) {
          changes.push(`section: ${c.section} → PART ${newSectionLetter}`);
          c.section = `PART ${newSectionLetter}`;
        }
      }
      if ('seizingOfficer' in patch) {
        const v = String(patch.seizingOfficer || '').trim();
        if (!v) { const e = new Error('seizingOfficer cannot be empty'); e.status = 400; throw e; }
        if (c.seizingOfficer !== v) { changes.push(`officer: "${c.seizingOfficer}" → "${v}"`); c.seizingOfficer = v; }
      }
      if ('itemId' in patch) {
        const v = String(patch.itemId || '').trim();
        if (c.itemId !== v) { changes.push(`item id: ${c.itemId || ''} → ${v}`); c.itemId = v; }
      }
      if (newLegalSection !== undefined) {
        const oldSec = c.legalSection || '';
        const oldTit = c.legalSectionTitle || '';
        if (oldSec !== (newLegalSection || '') ||
            (newLegalSections !== undefined && JSON.stringify(c.legalSections || []) !== JSON.stringify(newLegalSections))) {
          if (newLegalSection) {
            changes.push(`BNS section: ${oldSec || '—'} → ${newLegalSection} (${newLegalSectionTitle})`);
          } else {
            changes.push(`BNS section: ${oldSec || '—'} → (cleared)`);
          }
          c.legalSection = newLegalSection || undefined;
          c.legalSectionTitle = newLegalSectionTitle || undefined;
          if (newLegalSections !== undefined) {
            c.legalSections = newLegalSections;
            c.legalSectionsTitles = newLegalSectionsTitles;
          }
        }
      }

      if (newItemTypeId !== undefined) {
        const oldId = c.itemTypeId || null;
        if (oldId !== newItemTypeId) {
          if (newItemTypeId) {
            changes.push(`item type: ${c.itemType || '—'} → ${newItemTypeName}`);
            // Mirror the canonical type name into itemType so the
            // register table keeps rendering a readable label.
            c.itemType = newItemTypeName || c.itemType;
          } else {
            changes.push(`item type: ${c.itemType || '—'} → (cleared)`);
          }
          c.itemTypeId = newItemTypeId || undefined;
        }
      }
      if ('description' in patch) {
        const v = patch.description == null ? '' : String(patch.description);
        if (c.description !== v) {
          const short = (s) => (s && s.length > 40 ? s.slice(0, 37) + '…' : (s || '—'));
          changes.push(`description: ${short(c.description)} → ${short(v)}`);
          c.description = v || undefined;
        }
      }
      if ('status' in patch) {
        const v = String(patch.status);
        if (c.status !== v) { changes.push(`status: ${c.status || '—'} → ${v}`); c.status = v; }
      }
      if (newImageUrl !== undefined) {
        const oldUrl = c.imageUrl || '';
        if ((newImageUrl || '') !== oldUrl) {
          changes.push(`photo: ${oldUrl ? 'replaced' : 'added'}`);
          c.imageUrl = newImageUrl || undefined;
          // Newly-uploaded photo is user-provided; protect it from the
          // auto-generated SVG fallback that runs for cases without a photo.
          c.skipAutoImage = !!c.imageUrl;
        }
      }
      // receivedBy / firDate / imageUrl touch sibling tables — handle
      // OUTSIDE the in-memory mutate so the data is consistent before the
      // re-decorate below.  We capture the values, then write after the
      // mutate returns.
      if (newReceivedBy !== undefined) {
        const cp = ensureCasePropertyFor(c);
        if (cp.receivedBy !== newReceivedBy) {
          changes.push(`received by: ${cp.receivedBy || '—'} → ${newReceivedBy || '—'}`);
          cp.receivedBy = newReceivedBy || null;
          await dbSaveCaseProperty(cp);
        }
      }
      if (newFirDate !== undefined) {
        const fmKey = String(c.firNo || c.id || '').trim();
        if (fmKey) {
          const fm = (getDb().firMaster || []).find(f => f.firNo && f.firNo.toLowerCase() === fmKey.toLowerCase());
          const old = fm && fm.firDate ? fm.firDate : '';
          const next = newFirDate || null;
          if ((next || '') !== old) {
            changes.push(`fir date: ${old || '—'} → ${next || '—'}`);
            await upsertFirMasterPartial({ firNo: fmKey, firDate: next });
          }
        }
      }

      // ---- case_property STEP-2 slim payload (only the 4 fields the
      //      Edit modal actually sends).  Goes through the helper that
      //      mirrors to Postgres + keeps the in-memory mirror in sync. ----
      if (patch.caseProperty && typeof patch.caseProperty === 'object') {
        const cpPatch = patch.caseProperty || {};
        const cp = ensureCasePropertyFor(c);
        let cpChanged = false;
        // Only the 4 fields the modal exposes — seized time, moharrir,
        // quantity, remarks.  Seal / place-of-seizure / per-category popup
        // fields are not in the modal (they live on the registration form).
        const fields = [
          ['seizedTime', cpPatch.seizedTime],
          ['receivedBy', cpPatch.receivedBy],
          ['quantity',   cpPatch.quantity],
          ['remarks',    cpPatch.remarks],
        ];
        for (const [k, v] of fields) {
          if (v === undefined) continue;
          const next = v == null ? (k === 'receivedBy' ? null : '') : String(v);
          const old = cp[k] == null ? (k === 'receivedBy' ? '' : '') : String(cp[k]);
          if (next !== old) {
            changes.push(`${k}: ${shortVal(cp[k])} → ${shortVal(next)}`);
            cp[k] = next || null;
            cpChanged = true;
          }
        }
        if (cpChanged) await dbSaveCaseProperty(cp);
      }

      // No DD-extras or fir_master merging here — the slim PATCH payload
      // (see ALLOWED above) no longer carries recordType / DD fields.
      // fir_master is still touched when `firDate` changes (see the
      // upsertFirMasterPartial call earlier in this handler).

      // section counts are derived from the cases table; recompute so the
      // sidebar/dashboard counters stay accurate after a move.
      rebuildSectionCountsIn(d);
      updated = c;
    });

    const summary = changes.length > 0 ? changes.join('; ') : '(no-op)';
    await auditMm(req, 'case.update', id, `Edited ${id}: ${summary}`);
    res.json(withFreshSectionName(updated, getDb()));
  } catch (e) { next(e); }
});

// DELETE /api/cases/:id — permanent case delete used by the Edit Case
// Property modal.  Body: { confirmItemId }.  Hard-removes the case row
// (cascades to movements), clears the sibling case_property row,
// recomputes section counts, and writes a `case.delete` audit entry.
app.delete('/api/cases/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    const confirmItemId = String((req.body && req.body.confirmItemId) || '').trim();
    if (!confirmItemId) { const e = new Error('confirmItemId is required'); e.status = 400; throw e; }

    let deletedMeta = null;
    let movementsRemoved = 0;
    let cpTouched = false;

    await mutate(async d => {
      const idx = d.cases.findIndex(x => x.id === id);
      if (idx < 0) { const e = new Error(`case not found: ${id}`); e.status = 404; throw e; }
      const victim = d.cases[idx];

      // Re-type-to-confirm guard — same shape every destructive endpoint
      // in this server uses (movement-logs, sections, item-types,
      // inspections).  Case-insensitive so the user can type either case.
      const want = confirmItemId.toLowerCase();
      const have = String(victim.itemId || '').trim().toLowerCase();
      if (!have || want !== have) {
        const e = new Error(`item id mismatch — expected "${victim.itemId}"`); e.status = 400; throw e;
      }

      movementsRemoved = (d.movements || []).filter(m => m.caseId === id).length;

      // Sibling case_property row has no FK to cases, so we clear it here.
      const beforeCp = (d.caseProperty || []).length;
      d.caseProperty = (d.caseProperty || []).filter(p =>
        !(p.itemId && String(p.itemId).toLowerCase() === String(victim.itemId || '').toLowerCase())
      );
      cpTouched = d.caseProperty.length !== beforeCp;

      d.cases.splice(idx, 1);                            // cascades to movements.case_id
      rebuildSectionCountsIn(d);

      deletedMeta = { id: victim.id, itemId: victim.itemId, itemType: victim.itemType, section: victim.section };
    });

    await auditMm(req, 'case.delete', deletedMeta.id,
      `Deleted case ${deletedMeta.id} (${deletedMeta.itemType}, Malkhana ${deletedMeta.itemId}) — ${movementsRemoved} movement(s) removed` +
      (cpTouched ? ', case_property row cleared' : ''));

    res.json({ id: deletedMeta.id, deleted: true, movementsRemoved, casePropertyCleared: cpTouched });
  } catch (e) { next(e); }
});

function db_sectionByLetter(letter) {
  const db = getDb();
  const l = String(letter).toUpperCase();
  return db.sections.find(s => s.letter === l);
}
function db_bnsSectionByNo(no) {
  const db = getDb();
  const n = String(no || '').replace(/^BNS\s+/i, '').trim();
  return (db.bnsSections || []).find(s => s.sectionNo === n);
}

// ----------------------------------------------------------------------
// Multi-Act legal-section lookup.  Keys can be either:
//   - "BNS:101" (preferred — disambiguates between acts with same number)
//   - "BNS 101"  (BNS only, with optional space)
//   - "101"      (legacy bare number — treated as BNS for backward compat)
//
// On startup we load the same JSON the client bundles
// (client/src/data/legalSections.json — also mirrored under
// server/data/legal_sections.json) into `db.legalSections`, keyed by
// `${actCode}:${sectionNo}`.  Validation rejects unknown tuples with HTTP
// 400 — same shape as the old BNS-only validator.
// ----------------------------------------------------------------------
function db_loadLegalSections() {
  try {
    const fs = require('fs');
    const path = require('path');
    // Try a few likely locations for the bundled JSON.
    const candidates = [
      path.join(__dirname, 'data', 'legal_sections.json'),
      path.join(__dirname, '..', 'client', 'src', 'data', 'legalSections.json'),
    ];
    let rows = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        rows = JSON.parse(fs.readFileSync(p, 'utf-8'));
        console.log(`[legal] loaded ${rows.length} sections from ${p}`);
        break;
      }
    }
    if (!rows) {
      console.warn('[legal] legal_sections.json not found — multi-act picker will reject everything');
      return [];
    }
    return rows.map(r => ({
      actCode: r.act_code,
      actName: r.act_name,
      actYear: r.act_year,
      actLabel: r.act_label,
      sectionNo: r.section_no,
      title: r.title,
      category: r.category || '',
      key: `${r.act_code}:${r.section_no}`,
    }));
  } catch (err) {
    console.error('[legal] failed to load:', err.message);
    return [];
  }
}

// Parse a section key like "BNS:101", "BNS 101", "IPC:304A", or "101".
// Returns {actCode, sectionNo} or null if the input can't be parsed.
function parseLegalKey(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z]{2,10})\s*[:\-]\s*(\S+)$/);
  if (m) return { actCode: m[1].toUpperCase(), sectionNo: m[2] };
  const m2 = s.match(/^([A-Za-z]{2,10})\s+(\S+)$/);
  if (m2) return { actCode: m2[1].toUpperCase(), sectionNo: m2[2] };
  return { actCode: 'BNS', sectionNo: s };   // legacy: bare number = BNS
}

// Look up a section by any of the accepted key formats.
// Returns the matched row or null.
function db_legalSectionByKey(raw) {
  const db = getDb();
  const parsed = parseLegalKey(raw);
  if (!parsed) return null;
  const key = `${parsed.actCode}:${parsed.sectionNo}`;
  return (db.legalSections || []).find(s => s.key === key) || null;
}

// Resolve an array of section keys into the canonical {sectionNo, title}
// rows used by createOneCase / upsertFirMaster.  Throws 400 on unknown key.
function resolveLegalSectionList(rawList) {
  if (!Array.isArray(rawList)) return { legalSections: [], legalSectionsTitles: [] };
  const out = [];
  const titles = [];
  for (const raw of rawList) {
    const hit = db_legalSectionByKey(raw);
    if (!hit) {
      const e = new Error(`unknown legal section: ${raw}`);
      e.status = 400;
      throw e;
    }
    out.push(`${hit.actCode}:${hit.sectionNo}`);
    titles.push(hit.title);
  }
  return { legalSections: out, legalSectionsTitles: titles };
}

// Express the primary section as a single canonical "ACT:N" key for the
// legacy `legal_section` column, plus a parallel title.  Falls back to the
// first entry when the array has more than one.
function primaryLegalSection(legalSections, legalSectionsTitles) {
  if (!legalSections || !legalSections.length) return { legalSection: null, legalSectionTitle: null };
  const head = legalSections[0];
  const title = legalSectionsTitles && legalSectionsTitles[0];
  // Strip the "ACT:" prefix when persisting into the legacy `legal_section`
  // column — that column has always been a bare number.  Server-side
  // readers that need the act code can recover it from the parallel
  // legal_sections_acts column (added below) or by joining against the
  // resolved key string in legal_sections[].
  const m = head.match(/^([A-Z]{2,10}):(\S+)$/);
  return {
    legalSection: m ? m[2] : head,
    legalSectionTitle: title || null,
  };
}
function rebuildSectionCountsIn(d) {
  for (const s of d.sections) s.count = 0;
  for (const c of [...d.cases, ...(d.extraCasesForAlerts || [])]) {
    // 1- or 2-letter section keys: "PART A" … "PART AZ"
    const m = c.section?.match(/PART ([A-Z]{1,2})/);
    if (m) {
      const s = d.sections.find(x => x.letter === m[1]);
      if (s) s.count += 1;
    }
  }
}

// =================== API: BNS sections (typeahead reference) ===================
//
// GET /api/bns-sections?q=<text>&limit=<n>
//   - returns matching BNS sections ordered by section number
//   - `q` is matched (case-insensitive) against sectionNo, title, and category
//   - `limit` defaults to 15, capped at 100
//   - when `q` is empty/missing, returns the first 15 (so the dropdown has
//     content the moment the field is focused)
//
// Idempotent: a single boot-time seed populates exactly 100 rows
// (see server/db.js `BNS_SECTIONS`).  The endpoint never writes; it
// just reads from the in-memory mirror.
app.get('/api/bns-sections', (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 100);
  const all = db.bnsSections || [];
  let hits;
  if (!q) {
    hits = all.slice(0, limit);
  } else {
    // "starts with" beats "contains" for short numeric queries like "30"
    // so the user typing "30" sees BNS 30 first, not BNS 130/230/300.
    const exact = [], starts = [], contains = [];
    for (const s of all) {
      const no = s.sectionNo.toLowerCase();
      const title = s.title.toLowerCase();
      const cat = (s.category || '').toLowerCase();
      if (no === q) exact.push(s);
      else if (no.startsWith(q) || title.startsWith(q)) starts.push(s);
      else if (title.includes(q) || cat.includes(q) || no.includes(q)) contains.push(s);
    }
    hits = [...exact, ...starts, ...contains].slice(0, limit);
  }
  res.json(hits);
});

// =================== API: QR codes ===================
// The QR tag encodes a compact JSON payload (case id + item id + type).
// To stop anyone with a generic QR scanner from reading case data, the
// payload is AES-256-GCM encrypted server-side.  Only the e-Malkhana
// backend (which holds QR_SECRET) can decrypt it via /api/scan, so a tag
// is meaningless until an MM has logged in and points the app at it.
// Fallback secret keeps local/dev working; SET QR_SECRET in production.
const QR_SECRET = (() => {
  const raw = process.env.QR_SECRET || 'eMalkhana-QR-v1-secret-key!!';
  return Buffer.from(raw, 'utf8').subarray(0, 32).toString('utf8').padEnd(32, '0');
})();

// Encrypt a plain object into a compact, self-describing AES-256-GCM blob.
// Returns a JSON string: { v:2, enc:'aes-256-gcm', iv, tag, ct } (base64).
function encryptQrPayload(obj) {
  const plaintext = JSON.stringify(obj);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(QR_SECRET, 'utf8'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const b64 = (buf) => buf.toString('base64');
  return JSON.stringify({ v: 2, enc: 'aes-256-gcm', iv: b64(iv), tag: b64(authTag), ct: b64(enc) });
}

// Reverse of encryptQrPayload.  Throws if the blob isn't aes-256-gcm.
function decryptQrPayload(encJson) {
  const j = JSON.parse(encJson);
  if (!j || j.enc !== 'aes-256-gcm') throw new Error('unsupported QR encryption');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', Buffer.from(QR_SECRET, 'utf8'), Buffer.from(j.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(j.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(j.ct, 'base64')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

app.get('/api/cases/:id/qr', async (req, res, next) => {
  try {
    const c = findOrThrow(req.params.id);
    // Plain payload that the backend would decode.  We ENCRYPT it before
    // encoding into the QR so the printed tag carries no readable case data.
    const payloadObj = {
      v: 1,
      id: c.id,
      item: c.itemId,
      type: c.itemType,
      section: c.section,
    };
    const encrypted = encryptQrPayload(payloadObj);
    const dataUrl = await QRCode.toDataURL(encrypted, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#14243D', light: '#FAF7EE' },
    });
    // The on-screen "Payload" line must NOT leak case data — show a mask.
    res.json({
      dataUrl,
      payload: encrypted,
      encrypted: true,
      mask: '🔒 Encrypted — scan with e-Malkhana to decode',
      case: c,
    });
  } catch (e) { next(e); }
});

// =================== API: movements ===================

app.get('/api/cases/:id/movements', async (req, res, next) => {
  try {
    // getMovements is async (queries the mirror or PG).  We MUST await it
    // before res.json — otherwise the Promise serialises as `{}` and the
    // client gets an empty object instead of an array, which crashes
    // .map/.length on the case-detail page.
    const rows = await getMovements(req.params.id);
    res.json(rows);
  } catch (e) { next(e); }
});

// System Settings CRUD for the actual persisted movement-log rows. The
// normal case-detail flow continues to use POST /movements; these endpoints
// are for controlled corrections, manual back-entry, and removal of an
// incorrect log.
app.get('/api/movement-logs', async (_req, res, next) => {
  try {
    const rows = [...(getDb().movements || [])]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id - a.id);
    res.json(rows);
  } catch (e) { next(e); }
});

function movementText(value) {
  return value == null ? '' : String(value).trim();
}

function normaliseMovementTimestamp(value, fallback = nowISO()) {
  if (value == null || String(value).trim() === '') return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const e = new Error('timestamp must be a valid date and time');
    e.status = 400;
    throw e;
  }
  return d.toISOString();
}

app.post('/api/movement-logs', async (req, res, next) => {
  try {
    const b = req.body || {};
    const caseId = movementText(b.caseId);
    const toLocation = movementText(b.toLocation);
    const movedBy = movementText(b.movedBy);
    if (!caseId) { const e = new Error('caseId is required'); e.status = 400; throw e; }
    if (!toLocation) { const e = new Error('toLocation is required'); e.status = 400; throw e; }
    if (!movedBy) { const e = new Error('movedBy is required'); e.status = 400; throw e; }

    const c = findOrThrow(caseId);
    const prior = await getMovements(c.id);
    const movement = {
      id: await nextMovementId(),
      caseId: c.id,
      fromLocation: movementText(b.fromLocation) || (prior.length ? prior[prior.length - 1].toLocation : '—'),
      toLocation,
      movedBy,
      timestamp: normaliseMovementTimestamp(b.timestamp),
      purpose: movementText(b.purpose),
      docRef: movementText(b.docRef),
    };
    await mutate(d => { d.movements.push(movement); });
    await auditMm(req, 'movement.create', c.id,
      `Created movement: ${movement.fromLocation} → ${movement.toLocation}${movement.purpose ? ` — ${movement.purpose}` : ''}`);
    res.status(201).json(movement);
  } catch (e) { next(e); }
});

app.patch('/api/movement-logs/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid movement id'); e.status = 400; throw e; }
    const existing = (getDb().movements || []).find(m => m.id === id);
    if (!existing) { const e = new Error(`movement not found: ${id}`); e.status = 404; throw e; }
    const b = req.body || {};
    const caseId = b.caseId != null ? movementText(b.caseId) : existing.caseId;
    const toLocation = b.toLocation != null ? movementText(b.toLocation) : existing.toLocation;
    const movedBy = b.movedBy != null ? movementText(b.movedBy) : existing.movedBy;
    if (!caseId) { const e = new Error('caseId is required'); e.status = 400; throw e; }
    if (!toLocation) { const e = new Error('toLocation is required'); e.status = 400; throw e; }
    if (!movedBy) { const e = new Error('movedBy is required'); e.status = 400; throw e; }
    const targetCase = findOrThrow(caseId);
    const movement = {
      ...existing,
      caseId: targetCase.id,
      fromLocation: b.fromLocation != null ? movementText(b.fromLocation) : existing.fromLocation,
      toLocation,
      movedBy,
      timestamp: normaliseMovementTimestamp(b.timestamp, existing.timestamp),
      purpose: b.purpose != null ? movementText(b.purpose) : existing.purpose,
      docRef: b.docRef != null ? movementText(b.docRef) : existing.docRef,
      status: b.status != null ? movementText(b.status) : existing.status,
    };
    await mutate(d => {
      const index = d.movements.findIndex(m => m.id === id);
      if (index >= 0) d.movements[index] = movement;
      // Keep the case's current status in sync if this movement carries one.
      if (movement.status && STATUSES.includes(movement.status)) {
        const x = d.cases.find(y => y.id === targetCase.id);
        if (x) x.status = movement.status;
      }
    });
    await auditMm(req, 'movement.update', targetCase.id,
      `Updated movement #${id}: ${movement.fromLocation} → ${movement.toLocation}`);
    res.json(movement);
  } catch (e) { next(e); }
});

app.delete('/api/movement-logs/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid movement id'); e.status = 400; throw e; }
    const existing = (getDb().movements || []).find(m => m.id === id);
    if (!existing) { const e = new Error(`movement not found: ${id}`); e.status = 404; throw e; }
    await mutate(d => { d.movements = d.movements.filter(m => m.id !== id); });
    await auditMm(req, 'movement.delete', existing.caseId,
      `Deleted movement #${id}: ${existing.fromLocation} → ${existing.toLocation}`);
    res.json({ id, deleted: true });
  } catch (e) { next(e); }
});

app.post('/api/movements', async (req, res, next) => {
  try {
    const b = req.body || {};
    const required = ['caseId', 'toLocation', 'movedBy'];
    for (const k of required) if (!b[k]) { const e = new Error(`missing field: ${k}`); e.status = 400; throw e; }
    const c = findOrThrow(b.caseId);
    // append-only — no id reuse, no from/to mutation
    const movementId = await nextMovementId();
    const movement = {
      id: movementId,
      caseId: c.id,
      fromLocation: await lastLocationOf(c.id),
      toLocation:   b.toLocation,
      movedBy:      b.movedBy || getDb().officer.name,
      timestamp:    nowISO(),
      purpose:      b.purpose || `Scan @ ${b.toLocation}`,
      docRef:       b.docRef || `SCAN-${Date.now()}`,
      status:       (b.setStatus && STATUSES.includes(b.setStatus)) ? b.setStatus : null,
    };
    await mutate(d => { d.movements.push(movement); });
    if (b.setStatus && STATUSES.includes(b.setStatus)) {
      await mutate(d => { const x = d.cases.find(y => y.id === b.caseId); if (x) x.status = b.setStatus; });
    }
    const updatedCase = await getCase(b.caseId);
    const finalCase = withFreshSectionName(updatedCase || c, getDb());
    await auditMm(req, b.setStatus ? 'movement.record' : 'movement.log', c.id,
      `${b.setStatus ? 'Recorded movement + status: ' : 'Logged movement: '}${movement.fromLocation} → ${movement.toLocation}${b.setStatus ? ` (status: ${b.setStatus})` : ''}${b.purpose ? ' — ' + b.purpose : ''}`);
    res.status(201).json({ case: finalCase, movement });
    return;
  } catch (e) { next(e); }
});

// =================== API: scan endpoint ===================

async function lastLocationOf(caseId) {
  const ms = await getMovements(caseId);
  return ms.length ? ms[ms.length - 1].toLocation : '—';
}

// =================== API: scan endpoint ===================
// Accepts either a raw case id (e.g. "FIR 214/2026"), the encrypted QR
// blob (aes-256-gcm), or a legacy plaintext JSON payload.  A logged-in
// MM is required (the X-MM-Id header must resolve to a known user) —
// anonymous scans are refused so a found tag can't be decoded by anyone.

app.post('/api/scan', async (req, res, next) => {
  try {
    const b = req.body || {};
    const raw = (b.payload || b.caseId || '').trim();
    if (!raw) { const e = new Error('payload (QR text) or caseId is required'); e.status = 400; throw e; }

    // Gate: only an authenticated MM may decode a tag.  The audit
    // middleware sets req.mm from the X-MM-Id header; 'anonymous' means
    // nobody is signed in (or the app didn't send the header).
    if (!req.mm || req.mm.id === 'anonymous') {
      const e = new Error('login required to scan');
      e.status = 401;
      throw e;
    }

    // Resolve the candidate case id from whatever form the input takes.
    let candidate = raw;
    try {
      const looksEncrypted = raw.includes('"enc":"aes-256-gcm"') || raw.startsWith('enc::');
      if (looksEncrypted) {
        // Encrypted QR payload — only the backend holding QR_SECRET can read it.
        const encJson = raw.startsWith('enc::') ? raw.slice('enc::'.length) : raw;
        const obj = decryptQrPayload(encJson);
        candidate = obj.id || raw;
      } else if (raw.startsWith('{')) {
        // Legacy plaintext JSON payload (pre-encryption tags / manual).
        candidate = JSON.parse(raw).id || raw;
      }
      // otherwise: a bare case id typed manually — keep as-is.
    } catch (decErr) {
      // If decryption fails (wrong secret / tampered tag), do NOT fall
      // back to treating the blob as a case id — that would leak/scrub it.
      const e = new Error('could not decode QR tag');
      e.status = 400;
      e.payload = { detail: String(decErr?.message || decErr) };
      throw e;
    }

    const r = resolveCaseId(candidate);
    if (!r.case) {
      const e = new Error('case not found');
      e.status = 404;
      e.payload = { tried: candidate, suggestions: r.suggestions };
      throw e;
    }
    const c = withFreshSectionName(r.case, getDb());

    // If a destination is provided, log movement. Otherwise, just report the case
    // (this is what the QR scanner typically does first: "what is this item?").
    if (b.toLocation) {
      const movement = {
        id: await nextMovementId(),
        caseId: c.id,
        fromLocation: await lastLocationOf(c.id),
        toLocation:   b.toLocation,
        movedBy:      b.movedBy || getDb().officer.name,
        timestamp:    nowISO(),
        purpose:      b.purpose || `Scan @ ${b.toLocation}`,
        docRef:       b.docRef || `SCAN-${Date.now()}`,
        status:       (b.setStatus && STATUSES.includes(b.setStatus)) ? b.setStatus : null,
      };
      await mutate(d => { d.movements.push(movement); });
      if (b.setStatus && STATUSES.includes(b.setStatus)) {
        await mutate(d => { const x = d.cases.find(y => y.id === c.id); if (x) x.status = b.setStatus; });
      }
      const finalCase = withFreshSectionName(await getCase(c.id) || c, getDb());
      await auditMm(req, 'scan.record', c.id, `Scan + movement: ${movement.fromLocation} → ${movement.toLocation}${b.setStatus ? ` (status → ${b.setStatus})` : ''}`);
      res.status(201).json({ case: finalCase, movement });
      return;
    }
    res.json({ case: c });
  } catch (e) { next(e); }
});

// Helper: resolve an item type by id from the mirror (or null).
function db_itemTypeById(id) {
  const db = getDb();
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  return (db.itemTypes || []).find(t => t.id === n) || null;
}

// =================== helpers: Movement Types (admin-managed vocabulary) ===================
// Movement Types is the configurable "Move to status" list shown on the
// Change Status modal and the Register filter dropdown.  We read it from
// the in-memory mirror (loaded once at boot from the movement_types
// table) so every endpoint and dashboard tile can resolve it
// synchronously.  Writes go through mutate() so persistDiff() syncs them
// back to Postgres and auditMm() records who changed what.

// Resolve the full list of movement types (sorted by sortOrder, then id).
function db_movementTypes({ activeOnly = false } = {}) {
  const db = getDb();
  let rows = db.movementTypes || [];
  if (activeOnly) rows = rows.filter(m => m.active !== false);
  return [...rows].sort((a, b) =>
    (a.sortOrder || 0) - (b.sortOrder || 0) ||
    (a.id || 0) - (b.id || 0)
  );
}

// Set of valid status names — used to validate PATCH /api/cases/:id/status.
// Built from the mirror so admins can extend the list without a code
// change.  The legacy "Transfer" status is always allowed (back-compat
// for older client builds) but is also a row in movement_types — adding
// it explicitly keeps the union non-empty even if the seed didn't fire.
function db_statusNameSet() {
  const names = db_movementTypes({ activeOnly: true }).map(m => m.name);
  // Always include legacy statuses that older clients may still use,
  // even if the admin deactivated the row.
  for (const legacy of ['Seized', 'In Malkhana', 'With FSL', 'Expert Opinion Pending', 'In Court', 'Disposed', 'Transfer']) {
    if (!names.includes(legacy)) names.push(legacy);
  }
  return new Set(names);
}

// Look up a movement type by name (used by ChangeStatusModal and
// status-validation fallbacks).  Returns null when not found.
function db_movementTypeByName(name) {
  if (!name) return null;
  return (getDb().movementTypes || []).find(m => m.name === name) || null;
}

// Build the per-status FORWARD transition map for ChangeStatusModal.
// Reads the `next` JSONB column from each movement type.  If `next`
// is empty we fall back to "every active status" (open graph).
function db_forwardTransitions() {
  const all = db_movementTypes({ activeOnly: true });
  const names = all.map(m => m.name);
  const out = {};
  for (const m of all) {
    if (Array.isArray(m.next) && m.next.length > 0) {
      // Only include names that still exist as active statuses.
      out[m.name] = m.next.filter(n => names.includes(n));
    } else {
      out[m.name] = names.filter(n => n !== m.name);
    }
  }
  return out;
}

// TO_LOCATION + PURPOSE defaults used to pre-fill the Change Status
// modal.  Falls back to legacy hardcoded values when the admin hasn't
// customised a particular status yet.
const LEGACY_DEFAULT_LOCATION = {
  'Seized': 'Scene',
  'In Malkhana': 'Malkhana',
  'With FSL': 'FSL Madhuban',
  'Expert Opinion Pending': 'Civil Hospital Panchkula',
  'In Court': 'Court',
  'Disposed': 'Disposed',
  'Transfer': '',
};
const LEGACY_DEFAULT_PURPOSE = {
  'Seized': 'Seizure check-in',
  'In Malkhana': 'Returned to malkhana',
  'With FSL': 'Sent for forensic analysis',
  'Expert Opinion Pending': 'Sent for chemical opinion',
  'In Court': 'Produced as exhibit',
  'Disposed': 'Disposed per court order',
  'Transfer': 'Inter-station transfer',
};
function db_defaultLocationFor(statusName) {
  const m = db_movementTypeByName(statusName);
  return (m && m.defaultLocation) || LEGACY_DEFAULT_LOCATION[statusName] || '';
}
function db_defaultPurposeFor(statusName) {
  const m = db_movementTypeByName(statusName);
  return (m && m.defaultPurpose) || LEGACY_DEFAULT_PURPOSE[statusName] || '';
}

// =================== API: Movement Types (admin-managed status vocabulary) ===================
// These endpoints back System Settings -> Movement Types.  The list drives
// the "Move to status" dropdown, the Register filter, the Dashboard
// tiles, and the validation gate on every case PATCH.  Admins can add,
// rename, reorder, soft-delete, and tweak default location / purpose /
// allowed-next statuses without redeploying.

// GET /api/movement-types?active=true|false|all
//   default `active=true` — the manager's "show inactive" toggle flips
//   this client-side.
app.get('/api/movement-types', (req, res, next) => {
  try {
    const a = String(req.query.active || 'true');
    const activeOnly = a === 'true';
    const list = activeOnly
      ? db_movementTypes({ activeOnly: true })
      : (a === 'all' ? db_movementTypes() : db_movementTypes({ activeOnly: false }));
    res.json(list);
  } catch (e) { next(e); }
});

// POST /api/movement-types  { name, defaultLocation?, defaultPurpose?, next?, sortOrder?, active? }
//   name is required and unique (case-insensitive on the DB side via UNIQUE).
app.post('/api/movement-types', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    if (name.length > 80) { const e = new Error('name must be 80 characters or fewer'); e.status = 400; throw e; }
    const existing = db_movementTypes();
    if (existing.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      const e = new Error(`"${name}" already exists`); e.status = 409; throw e;
    }
    const maxSort = existing.reduce((m, t) => Math.max(m, t.sortOrder || 0), 0);
    const next = Array.isArray(body.next)
      ? body.next.map(s => String(s).trim()).filter(Boolean).slice(0, 200)
      : [];
    let created;
    await mutate(d => {
      const nextId = (d.movementTypes || []).reduce((m, t) => Math.max(m, t.id || 0), 0) + 1;
      created = {
        id:              nextId,
        name,
        defaultLocation: String(body.defaultLocation || '').slice(0, 200),
        defaultPurpose:  String(body.defaultPurpose  || '').slice(0, 200),
        next,
        sortOrder:       Number.isInteger(body.sortOrder) ? body.sortOrder : maxSort + 10,
        active:          body.active === false ? false : true,
        isSystem:        false,           // new rows are user-managed
      };
      d.movementTypes = [...(d.movementTypes || []), created];
    });
    await auditMm(req, 'movementtype.create', String(created.id),
      `Added movement type "${created.name}"`);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// PATCH /api/movement-types/:id  { name?, defaultLocation?, defaultPurpose?, next?, sortOrder?, active? }
app.patch('/api/movement-types/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid id'); e.status = 400; throw e; }
    const body = req.body || {};
    const existing = (getDb().movementTypes || []).find(m => m.id === id);
    if (!existing) { const e = new Error(`movement type not found: ${id}`); e.status = 404; throw e; }

    const patch = {};
    const changes = [];
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) { const e = new Error('name cannot be empty'); e.status = 400; throw e; }
      if (name.length > 80) { const e = new Error('name must be 80 characters or fewer'); e.status = 400; throw e; }
      const clash = (getDb().movementTypes || []).some(m =>
        m.id !== id && m.name.toLowerCase() === name.toLowerCase());
      if (clash) { const e = new Error(`"${name}" already exists`); e.status = 409; throw e; }
      patch.name = name;
    }
    if (body.defaultLocation !== undefined) {
      patch.defaultLocation = String(body.defaultLocation || '').slice(0, 200);
    }
    if (body.defaultPurpose !== undefined) {
      patch.defaultPurpose = String(body.defaultPurpose || '').slice(0, 200);
    }
    if (body.next !== undefined) {
      if (!Array.isArray(body.next)) { const e = new Error('next must be an array of status names'); e.status = 400; throw e; }
      patch.next = body.next.map(s => String(s).trim()).filter(Boolean).slice(0, 200);
    }
    if (body.sortOrder !== undefined) {
      const so = Number(body.sortOrder);
      if (!Number.isInteger(so) || so < 0) { const e = new Error('sortOrder must be a non-negative integer'); e.status = 400; throw e; }
      patch.sortOrder = so;
    }
    if (body.active !== undefined) {
      const active = !!body.active;
      if (!active) {
        // Refuse to deactivate a status that still has live cases — they'd
        // be stranded (the Register filter / Change Status modal would no
        // longer show this option).  The manager surfaces this constraint
        // by counting cases on each row.
        const inUse = (getDb().cases || []).filter(c => c.status === existing.name).length;
        if (inUse > 0) {
          const e = new Error(
            `Cannot deactivate "${existing.name}" — ${inUse} case(s) still use this status. ` +
            `Move those cases to a different status first, or rename instead of deactivating.`
          );
          e.status = 409; e.payload = { caseCount: inUse }; throw e;
        }
      }
      patch.active = active;
    }
    if (Object.keys(patch).length === 0) {
      const e = new Error('no editable fields supplied'); e.status = 400; throw e;
    }

    await mutate(d => {
      const m = (d.movementTypes || []).find(x => x.id === id);
      if (!m) { const e = new Error(`movement type not found: ${id}`); e.status = 404; throw e; }
      if (patch.name !== undefined && m.name !== patch.name) { changes.push(`name: "${m.name}" → "${patch.name}"`); m.name = patch.name; }
      if (patch.defaultLocation !== undefined) m.defaultLocation = patch.defaultLocation;
      if (patch.defaultPurpose  !== undefined) m.defaultPurpose  = patch.defaultPurpose;
      if (patch.next !== undefined) m.next = patch.next;
      if (patch.sortOrder !== undefined) m.sortOrder = patch.sortOrder;
      if (patch.active !== undefined) {
        if (m.active !== patch.active) changes.push(`active: ${m.active} → ${patch.active}`);
        m.active = patch.active;
      }
    });
    const updated = db_movementTypes().find(m => m.id === id);
    const summary = changes.length ? changes.join('; ') : '(no-op)';
    await auditMm(req, 'movementtype.update', String(id),
      `Edited movement type "${updated.name}": ${summary}`);
    res.json(updated);
  } catch (e) { next(e); }
});

// DELETE /api/movement-types/:id  — HARD delete, guarded:
//   - refuse to delete a built-in (is_system) row
//   - refuse if any case still uses this status (count = 0 also blocks it)
app.delete('/api/movement-types/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid id'); e.status = 400; throw e; }
    const existing = (getDb().movementTypes || []).find(m => m.id === id);
    if (!existing) { const e = new Error(`movement type not found: ${id}`); e.status = 404; throw e; }
    if (existing.isSystem) {
      const e = new Error(
        `"${existing.name}" is a built-in status and cannot be deleted. ` +
        `You can deactivate it instead (only safe when no cases use it).`
      );
      e.status = 400; throw e;
    }
    const inUse = (getDb().cases || []).filter(c => c.status === existing.name).length;
    if (inUse > 0) {
      const e = new Error(
        `Cannot delete "${existing.name}" — ${inUse} case(s) still use this status. ` +
        `Move those cases to a different status first.`
      );
      e.status = 409; e.payload = { caseCount: inUse }; throw e;
    }
    await mutate(d => {
      d.movementTypes = (d.movementTypes || []).filter(m => m.id !== id);
    });
    await auditMm(req, 'movementtype.delete', String(id),
      `Removed movement type "${existing.name}"`);
    res.json({ id, name: existing.name, deleted: true });
  } catch (e) { next(e); }
});

// =================== API: Item Types (per-section controlled vocabulary) ===================
// GET /api/item-types?section=A|all
//   - section=A       → only Part A types
//   - section=all     → every type, grouped by section client-side
//   - active=true     → only active types (the register dropdown uses this;
//                       default when no `active` param is supplied)
//   - active=all     → active + deactivated (the manager uses this)
// Returns ItemType[] = { id, sectionLetter, name, sortOrder, active, caseCount }
app.get('/api/item-types', (req, res) => {
  const db = getDb();
  const section = String(req.query.section || 'all').toUpperCase();
  const wantActive = String(req.query.active || 'true').toLowerCase();
  let rows = db.itemTypes || [];
  if (section !== 'ALL') rows = rows.filter(t => t.sectionLetter === section);
  if (wantActive === 'all') {
    // keep all
  } else {
    const want = wantActive === 'false' ? false : true;
    rows = rows.filter(t => !!t.active === want);
  }
  rows = [...rows].sort((a, b) =>
    a.sectionLetter === b.sectionLetter
      ? (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)
      : a.sectionLetter.localeCompare(b.sectionLetter)
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// CASE PROPERTY ENTRY EXTENSION
// ---------------------------------------------------------------------------

// GET /api/sections/meta  -> [{ letter, name, count, active }] for the popup
// builder.  Lightweight list of the five Malkhana sections (Narcotics,
// Weapons, Cash & Documents, Vehicle, Biological/Viscera).
app.get('/api/sections/meta', async (_req, res, next) => {
  try { res.json(await getSectionMeta()); } catch (e) { next(e); }
});

// GET /api/item-type-fields?section=A  -> popup field definitions for a
// section (Narcotics = A, Weapons = B, ...).  Returns active ones first.
app.get('/api/item-type-fields', async (req, res, next) => {
  try {
    const letter = String(req.query.section || '').toUpperCase().trim();
    if (!/^[A-Z]{1,2}$/.test(letter)) { const e = new Error('section is required (A–E)'); e.status = 400; throw e; }
    res.json(await getItemTypeFields(letter));
  } catch (e) { next(e); }
});

// POST /api/item-type-fields  { section, label, fieldType?, options?, sortOrder?, active?, key? }
//   upsert a popup field definition for a section (Form Builder add/edit).
app.post('/api/item-type-fields', async (req, res, next) => {
  try {
    const body = req.body || {};
    const section = String(body.section || '').toUpperCase().trim();
    if (!/^[A-Z]{1,2}$/.test(section)) { const e = new Error('section must be 1-2 letters A-Z'); e.status = 400; throw e; }
    if (!db_sectionByLetter(section)) { const e = new Error(`unknown section: ${section}`); e.status = 400; throw e; }
    if (!body.label || !String(body.label).trim()) { const e = new Error('label is required'); e.status = 400; throw e; }
    const f = await upsertItemTypeField(section, {
      key: body.key, label: String(body.label).trim(),
      fieldType: body.fieldType || 'text',
      options: Array.isArray(body.options) ? body.options.map(String) : undefined,
      sortOrder: body.sortOrder, active: body.active,
    });
    await auditMm(req, 'section.fields', section, `Saved popup field "${f.label}" for Part ${section}`);
    res.status(201).json(f);
  } catch (e) { next(e); }
});

// DELETE /api/item-type-fields/:id
app.delete('/api/item-type-fields/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid id'); e.status = 400; throw e; }
    await deleteItemTypeField(id);
    await auditMm(req, 'section.fields', String(id), `Deleted popup field #${id}`);
    res.json({ id, deleted: true });
  } catch (e) { next(e); }
});

// ---- Item Category of Item master (DB-backed, admin-editable) -----------
// GET /api/item-categories -> full ordered list (active first then inactive).
app.get('/api/item-categories', async (_req, res, next) => {
  try {
    const list = await getItemCategories();
    // active first, then inactive, each by sortOrder
    list.sort((a, b) => (a.active === b.active ? a.sortOrder - b.sortOrder : a.active ? -1 : 1));
    res.json(list);
  } catch (e) { next(e); }
});

// POST /api/item-categories  { id, label, sectionLetter, subTypeLabel?,
//   subTypeControl?, subTypes?, fields? } -> create or replace a category.
app.post('/api/item-categories', async (req, res, next) => {
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim();
    if (!id) { const e = new Error('id is required'); e.status = 400; throw e; }
    if (!body.label || !String(body.label).trim()) { const e = new Error('label is required'); e.status = 400; throw e; }
    const cat = await upsertItemCategory({
      id,
      label: String(body.label).trim(),
      sectionLetter: body.sectionLetter,
      subTypeLabel: body.subTypeLabel,
      subTypeControl: body.subTypeControl,
      subTypes: Array.isArray(body.subTypes) ? body.subTypes : [],
      fields: Array.isArray(body.fields) ? body.fields : [],
    });
    await auditMm(req, 'category.upsert', id, `Saved category "${cat.label}"`);
    res.status(201).json(cat);
  } catch (e) { next(e); }
});

// PATCH /api/item-categories/:id  -> partial update (label / section /
// subTypes / fields / active / sortOrder).  Same upsert at the DB layer.
app.patch('/api/item-categories/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) { const e = new Error('id is required'); e.status = 400; throw e; }
    const existing = await getItemCategory(id);
    if (!existing) { const e = new Error(`unknown category: ${id}`); e.status = 404; throw e; }
    const b = req.body || {};
    const merged = {
      id,
      label: b.label != null ? String(b.label).trim() : existing.label,
      sectionLetter: b.sectionLetter != null ? b.sectionLetter : existing.sectionLetter,
      subTypeLabel: b.subTypeLabel !== undefined ? b.subTypeLabel : existing.subTypeLabel,
      subTypeControl: b.subTypeControl != null ? b.subTypeControl : existing.subTypeControl,
      subTypes: Array.isArray(b.subTypes) ? b.subTypes : existing.subTypes,
      fields: Array.isArray(b.fields) ? b.fields : existing.fields,
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : existing.sortOrder,
      active: b.active != null ? !!b.active : existing.active,
    };
    const cat = await upsertItemCategory(merged);
    await auditMm(req, 'category.upsert', id, `Updated category "${cat.label}"`);
    res.json(cat);
  } catch (e) { next(e); }
});

// DELETE /api/item-categories/:id
app.delete('/api/item-categories/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) { const e = new Error('id is required'); e.status = 400; throw e; }
    const existing = await getItemCategory(id);
    if (!existing) { const e = new Error(`unknown category: ${id}`); e.status = 404; throw e; }
    await deleteItemCategory(id);
    await auditMm(req, 'category.delete', id, `Deleted category "${existing.label}"`);
    res.json({ id, deleted: true });
  } catch (e) { next(e); }
});


// Declared BEFORE the /:firNo(*) route so "search" is not captured as a
// firNo param.  Returns [] (never 404) so the typeahead can render an
// empty state.
app.get('/api/fir-master/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 25);
    const hits = await searchFirMaster(q, limit);
    res.json(hits);
  } catch (e) { next(e); }
});

// GET /api/fir-master/:firNo  -> FIR master record (or 404 null).
// NOTE: the FIR/DD number contains a slash (e.g. "FIR 088/2026"), so the
// `*` modifier on :firNo is REQUIRED — a plain :firNo param stops at the
// first "/" and the route would never match, silently returning 404 (the
// original bug: the Lookup button always reported "New — not on file").
app.get('/api/fir-master/:firNo(*)', async (req, res, next) => {
  try {
    const firNo = String(req.params.firNo || '').trim();
    const fir = await getFirMaster(firNo);
    if (!fir) { res.status(404).json({ error: 'not found' }); return; }
    res.json(fir);
  } catch (e) { next(e); }
});

// POST /api/fir-master  { firNo, policeStation?, firDate?, usSections?, io? }
//   upsert the FIR's static details (entered once, reused per item).
app.post('/api/fir-master', async (req, res, next) => {
  try {
    const body = req.body || {};
    const firNo = String(body.firNo || '').trim();
    if (!firNo) { const e = new Error('firNo is required'); e.status = 400; throw e; }
    const fir = await upsertFirMaster({
      firNo,
      policeStation: body.policeStation,
      firDate: body.firDate,
      usSections: body.usSections,
      io: body.io,
      actualSeizureDdNo: body.actualSeizureDdNo || null,
      actualSeizureDate: body.actualSeizureDate || null,
    });
    await auditMm(req, 'fir.master', firNo, `Saved FIR master for ${firNo}`);
    res.status(201).json(fir);
  } catch (e) { next(e); }
});

// GET /api/case-property/:itemId  -> common + type-specific fields for an item.
app.get('/api/case-property/:itemId', async (req, res, next) => {
  try {
    const itemId = decodeURIComponent(req.params.itemId).trim();
    const cp = await getCaseProperty(itemId);
    if (!cp) { res.status(404).json({ error: 'not found' }); return; }
    res.json(cp);
  } catch (e) { next(e); }
});

// POST /api/case-property  { itemId, firNo?, common:{...}, fields:[{key,value}] }
//   write the COMMON case_property row + per-item popup field values.
app.post('/api/case-property', async (req, res, next) => {
  try {
    const body = req.body || {};
    const itemId = String(body.itemId || '').trim();
    if (!itemId) { const e = new Error('itemId is required'); e.status = 400; throw e; }
    // The case_property tables are keyed by the Malkhana Sr. No. (item_id),
    // not by the FIR id.  Look the case up by item_id so a valid item never
    // 404s (the previous bug: it matched against the FIR id and rejected
    // every save with "unknown item: MK-2026-000500").
    if (!(await getCaseByItemId(itemId))) { const e = new Error(`unknown item: ${itemId}`); e.status = 404; throw e; }
    const common = body.common || {};
    const fields = Array.isArray(body.fields) ? body.fields : [];
    await upsertCaseProperty(itemId, {
      firNo: body.firNo,
      seizedTime: common.seizedTime,
      witness1: common.witness1,
      witness2: common.witness2,
      quantity: common.quantity,
      storageLocation: common.placeOfSeizure ?? common.storageLocation,
      placeOfSeizure: common.placeOfSeizure ?? common.storageLocation,
      physicalStorage: common.physicalStorage,
      photoUrl: common.photoUrl,
      remarks: common.remarks,
      status: common.status || 'Seized',
      dateOfReceipt: common.dateOfReceipt ?? null,
      receivedBy: common.receivedBy ?? null,
      malkhanaLocation: common.malkhanaLocation ?? null,
      sealSealed: common.sealSealed ?? null,
      sealNo: common.sealNo ?? null,
      sealBy: common.sealBy ?? null,
    }, fields.map(f => ({ key: String(f.key), value: f.value == null ? null : String(f.value) })));
    await auditMm(req, 'case.property', itemId, `Saved case property for ${itemId} (${fields.length} type-specific field(s))`);
    res.status(201).json(await getCaseProperty(itemId));
  } catch (e) { next(e); }
});

// POST /api/cases
//   - creates a new item type in the given section
//   - name must be unique within the section (UNIQUE constraint + guard)
app.post('/api/item-types', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sectionLetter = String(body.sectionLetter || '').toUpperCase().trim();
    const name = String(body.name || '').trim();
    if (!/^[A-Z]{1,2}$/.test(sectionLetter)) {
      const e = new Error('sectionLetter must be 1-2 letters A-Z'); e.status = 400; throw e;
    }
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    if (!db_sectionByLetter(sectionLetter)) {
      const e = new Error(`unknown section: ${sectionLetter}`); e.status = 400; throw e;
    }
    const existing = (getDb().itemTypes || []).filter(t => t.sectionLetter === sectionLetter);
    if (existing.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      const e = new Error(`"${name}" already exists in Part ${sectionLetter}`); e.status = 409; throw e;
    }
    // Auto-assign the next sort_order so a freshly-added type lands at the
    // bottom of its section list.
    const maxSort = existing.reduce((m, t) => Math.max(m, t.sortOrder || 0), 0);
    const toInsert = {
      sectionLetter,
      name,
      sortOrder: Number.isInteger(body.sortOrder) ? body.sortOrder : maxSort + 10,
    };
    let created;
    await mutate(d => {
      const nextId = (d.itemTypes || []).reduce((m, t) => Math.max(m, t.id || 0), 0) + 1;
      created = { id: nextId, active: true, caseCount: 0, ...toInsert };
      d.itemTypes = [...(d.itemTypes || []), created];
    });
    created = db_itemTypeById(created.id);
    if (!created) { const e = new Error('item type not found after create'); e.status = 500; throw e; }
    await auditMm(req, 'itemtype.create', `${sectionLetter}:${created.id}`, `Added item type "${name}" to Part ${sectionLetter}`);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// PATCH /api/item-types/:id  { name?, sortOrder?, active? }
//   - rename, reorder, or (soft) de/activate an item type
//   - refuses to deactivate (active=false) a type still used by >=1 case —
//     that would orphan the register dropdown for those cases.  The
//     manager instead surfaces the "N cases" count as a warning.
app.patch('/api/item-types/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid id'); e.status = 400; throw e; }
    const body = req.body || {};
    const t = db_itemTypeById(id);
    if (!t) { const e = new Error('item type not found'); e.status = 404; throw e; }
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) { const e = new Error('name cannot be empty'); e.status = 400; throw e; }
      const clash = (getDb().itemTypes || []).some(x =>
        x.id !== id && x.sectionLetter === t.sectionLetter && x.name.toLowerCase() === name.toLowerCase());
      if (clash) { const e = new Error(`"${name}" already exists in Part ${t.sectionLetter}`); e.status = 409; throw e; }
      patch.name = name;
    }
    if (body.sortOrder !== undefined) {
      const so = Number(body.sortOrder);
      if (!Number.isInteger(so) || so < 0) { const e = new Error('sortOrder must be a non-negative integer'); e.status = 400; throw e; }
      patch.sortOrder = so;
    }
    if (body.active !== undefined) {
      const active = !!body.active;
      if (!active && (t.caseCount || 0) > 0) {
        const e = new Error(`cannot deactivate — ${t.caseCount} case(s) still use "${t.name}". Move or reassign them first.`);
        e.status = 409; e.payload = { caseCount: t.caseCount }; throw e;
      }
      patch.active = active;
    }
    if (Object.keys(patch).length === 0) {
      const e = new Error('no editable fields supplied'); e.status = 400; throw e;
    }
    const changes = [];
    await mutate(d => {
      const x = d.itemTypes.find(y => y.id === id);
      if (!x) { const e = new Error('item type not found'); e.status = 404; throw e; }
      if (patch.name !== undefined && x.name !== patch.name) { changes.push(`name: "${x.name}" → "${patch.name}"`); x.name = patch.name; }
      if (patch.sortOrder !== undefined) { x.sortOrder = patch.sortOrder; }
      if (patch.active !== undefined) { x.active = patch.active; }
    });
    const updated = db_itemTypeById(id);
    const summary = changes.length ? changes.join('; ') : (body.active !== undefined ? `active → ${updated.active}` : '(no-op)');
    await auditMm(req, 'itemtype.update', `${t.sectionLetter}:${id}`, `Edited item type in Part ${t.sectionLetter}: ${summary}`);
    res.json(updated);
  } catch (e) { next(e); }
});

// DELETE /api/item-types/:id
//   - HARD delete, but guarded: refuses if any case still points at it
//     (the manager also prevents deactivation of in-use types, and offers
//     reassignment before delete).  On success, FK ON DELETE SET NULL
//     semantics are emulated by nulling item_type_id on linked cases so
//     historical rows never error on a missing FK.
app.delete('/api/item-types/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { const e = new Error('invalid id'); e.status = 400; throw e; }
    const t = db_itemTypeById(id);
    if (!t) { const e = new Error('item type not found'); e.status = 404; throw e; }
    if ((t.caseCount || 0) > 0) {
      const e = new Error(`cannot delete — ${t.caseCount} case(s) still use "${t.name}". Reassign them first.`);
      e.status = 409; e.payload = { caseCount: t.caseCount }; throw e;
    }
    // Null any case links BEFORE removing the row (defence-in-depth; the
    // constraint is RESTRICT so this must happen first).
    await mutate(d => {
      for (const c of d.cases) if (c.itemTypeId === id) c.itemTypeId = undefined;
      d.itemTypes = (d.itemTypes || []).filter(x => x.id !== id);
    });
    await auditMm(req, 'itemtype.delete', `${t.sectionLetter}:${id}`, `Removed item type "${t.name}" from Part ${t.sectionLetter}`);
    res.json({ id, sectionLetter: t.sectionLetter, name: t.name, deleted: true });
  } catch (e) { next(e); }
});

// =================== API: sections (configurable malkhana sections) ===================

// GET /api/sections?active=true|false|all
// Default: only active sections (the dropdowns the MM uses should never
// include deactivated rows; the admin section manager sets the filter to
// `all` to see every row).
app.get('/api/sections', (req, res) => {
  const db = getDb();
  const all = db.sections || [];
  const want = String(req.query.active || 'true').toLowerCase();
  if (want === 'all') return res.json(all);
  const filter = want === 'false' ? false : true;
  res.json(all.filter(s => !!s.active === filter));
});

// Persist an explicit display order for all sections.  Body: { order: ['A','B',...] }.
// Letters listed get sequential sort_order = index; any letter omitted keeps a
// stable slot after the listed ones (so a partial order from the client is safe).
app.patch('/api/sections/order', async (req, res, next) => {
  try {
    const incoming = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
    if (!incoming.length) { const e = new Error('order is required (array of letters)'); e.status = 400; throw e; }
    let result = [];
    await mutate(d => {
      const present = new Set(d.sections.map(s => s.letter));
      for (const l of incoming) {
        if (!present.has(l)) { const e = new Error(`unknown section: ${l}`); e.status = 400; throw e; }
      }
      const rank = new Map(incoming.map((l, i) => [l, i]));
      let tail = incoming.length;
      for (const s of d.sections) {
        if (rank.has(s.letter)) s.sortOrder = rank.get(s.letter);
        else s.sortOrder = tail++;
      }
      d.sections.sort((a, b) =>
        (a.sortOrder || 0) - (b.sortOrder || 0) ||
        a.letter.length - b.letter.length ||
        a.letter.localeCompare(b.letter)
      );
      result = d.sections.map(s => ({
        letter: s.letter, name: s.name, count: s.count,
        active: s.active !== false, sortOrder: s.sortOrder || 0,
      }));
    });
    await auditMm(req, 'section.reorder', '*', `Reordered ${incoming.length} section(s)`);
    res.json(result);
  } catch (e) { next(e); }
});

app.patch('/api/sections/:letter', async (req, res, next) => {
  try {
    const letter = String(req.params.letter).toUpperCase();
    const name = String((req.body || {}).name || '').trim();
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    const s = db_sectionByLetter(letter);
    const prev = s.name;
    await mutate(d => {
      const x = d.sections.find(y => y.letter === letter);
      if (!x) { const e = new Error('section not found'); e.status = 404; throw e; }
      x.name = name;
    });
    const updated = db_sectionByLetter(letter);
    await auditMm(req, 'section.rename', letter, `Renamed Part ${letter}: "${prev}" → "${name}"`);
    res.json(updated);
  } catch (e) { next(e); }
});

// Toggle the active flag on a section.  Deactivated sections:
//   • are hidden from the section dropdown on "Register New Case Property"
//   • remain in the section manager so admins can re-activate
//   • keep all cases already stored against them (the case still resolves
//     its display name via the join, even when the section is inactive).
app.patch('/api/sections/:letter/active', async (req, res, next) => {
  try {
    const letter = String(req.params.letter).toUpperCase();
    const active = !!(req.body || {}).active;
    const s = db_sectionByLetter(letter);
    if (!s) { const e = new Error('section not found'); e.status = 404; throw e; }
    await mutate(d => {
      const x = d.sections.find(y => y.letter === letter);
      if (x) x.active = active;
    });
    const updated = db_sectionByLetter(letter);
    await auditMm(req, 'section.active', letter, `${active ? 'Activated' : 'Deactivated'} Part ${letter}: "${updated.name}"`);
    res.json(updated);
  } catch (e) { next(e); }
});

// Add a new malkhana section.  Letter is auto-assigned as the next unused
// letter after the current highest (A..Z, then AA..AZ, etc.).  The client may
// also pass an explicit `letter` to pick a specific slot.
app.post('/api/sections', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    if (name.length > 60) { const e = new Error('name too long (max 60 chars)'); e.status = 400; throw e; }

    let letter = '';
    await mutate(d => {
      const used = new Set(d.sections.map(s => s.letter));
      const explicit = String(body.letter || '').toUpperCase().trim();
      let chosen = '';
      if (explicit) {
        if (!/^[A-Z]{1,2}$/.test(explicit)) { const e = new Error('letter must be 1-2 letters A-Z'); e.status = 400; throw e; }
        if (used.has(explicit))             { const e = new Error(`section "${explicit}" already exists`); e.status = 409; throw e; }
        chosen = explicit;
      } else {
        // Auto-assign: next unused letter after current max
        const maxLen = Math.max(0, ...[...used].map(l => l.length));
        const poolLen = maxLen === 0 ? 1 : maxLen;
        let found = null;
        for (let len = 1; len <= poolLen + 1 && !found; len++) {
          for (let i = 0; i < 26; i++) {
            const candidate = String.fromCharCode(65 + i).repeat(len);
            if (!used.has(candidate)) { found = candidate; break; }
          }
        }
        if (!found) { const e = new Error('no free section letter available'); e.status = 409; throw e; }
        chosen = found;
      }
      const maxOrder = d.sections.reduce((m, s) => Math.max(m, (s.sortOrder || 0)), -1);
      d.sections.push({ letter: chosen, name, count: 0, sortOrder: maxOrder + 1 });
      d.sections.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.letter.length - b.letter.length || a.letter.localeCompare(b.letter));
      letter = chosen;
    });

    const created = db_sectionByLetter(letter);
    if (!created) { const e = new Error('section not found after create'); e.status = 500; throw e; }
    await auditMm(req, 'section.create', created.letter, `Added Part ${created.letter}: "${created.name}"`);
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// Delete a malkhana section.  Refuses if any case (live or alert-only) is
// currently stored in this section — caller must move cases first.
app.delete('/api/sections/:letter', async (req, res, next) => {
  try {
    const letter = String(req.params.letter).toUpperCase();
    const s = db_sectionByLetter(letter);
    if (!s) { const e = new Error('section not found'); e.status = 404; throw e; }
    if (s.count > 0) {
      const e = new Error(`cannot delete — ${s.count} case(s) still in Part ${letter}. Move or dispose them first.`);
      e.status = 409; e.payload = { count: s.count, letter }; throw e;
    }
    const removedName = s.name;
    await mutate(d => {
      const i = d.sections.findIndex(y => y.letter === letter);
      if (i < 0) { const e = new Error('section not found'); e.status = 404; throw e; }
      d.sections.splice(i, 1);
    });
    await auditMm(req, 'section.delete', letter, `Removed Part ${letter}: "${removedName}"`);
    res.json({ letter, name: removedName, count: 0, deleted: true });
  } catch (e) { next(e); }
});

app.get('/api/audit', (req, res) => {
  // Returns the most-recent audit log entries (newest first).
  // Query params: limit (default 100, max 500), userId, action, target.
  const db = getDb();
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  const userId = (req.query.userId || '').trim().toUpperCase();
  const action = (req.query.action || '').trim();
  const target = (req.query.target || '').trim();
  let entries = (db.auditLog || []).slice();
  if (userId) entries = entries.filter(e => e.userId === userId);
  if (action) entries = entries.filter(e => e.action === action);
  if (target) entries = entries.filter(e => e.target === target);
  entries.reverse();
  res.json(entries.slice(0, limit));
});

// =================== API: alerts ===================

app.get('/api/alerts', (_req, res) => {
  res.json(getAlertIssues());
});

app.get('/api/alerts/config', (_req, res) => {
  // Return alertConfig + the editable station name so the Settings UI
  // can show and update it in a single Save action.
  const db = getDb();
  res.json({ ...db.alertConfig, station: db.meta.station });
});

app.patch('/api/alerts/config', async (req, res, next) => {
  try {
    const b = req.body || {};

    // ---- Validate BEFORE persisting (don't corrupt db on bad input) ----
    const fields = {};
    const dayKeys = ['fslDays', 'expertDays', 'courtDays', 'inspectionCycleDays'];
    for (const k of dayKeys) {
      if (b[k] === undefined) continue;                                 // partial PATCH is OK
      const v = b[k];
      if (!Number.isInteger(v) || v < 1 || v > 3650) {
        fields[k] = 'must be a whole number between 1 and 3650 days';
      }
    }
    if (b.lastInspection !== undefined) {
      const li = b.lastInspection;
      if (typeof li !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(li)) {
        fields.lastInspection = 'must be a date in YYYY-MM-DD format';
      } else if (Number.isNaN(new Date(li).getTime())) {
        fields.lastInspection = 'must be a real calendar date';
      }
    }
    // Police station name — free text but bounded so it fits in the
    // dashboard subheader and the report letterhead.  3–80 chars, trimmed.
    if (b.station !== undefined) {
      const s = String(b.station).trim();
      if (s.length < 3 || s.length > 80) {
        fields.station = 'station name must be 3–80 characters';
      }
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: 'validation failed', fields });
    }

    // ---- Persist ----
    const result = await mutate(d => {
      const c = d.alertConfig;
      const m = d.meta;
      const changes = [];
      for (const k of dayKeys) {
        if (b[k] !== undefined && c[k] !== b[k]) {
          changes.push(`${k}: ${c[k]} → ${b[k]}`);
          c[k] = b[k];
        }
      }
      if (b.lastInspection !== undefined && c.lastInspection !== b.lastInspection) {
        changes.push(`lastInspection: ${c.lastInspection} → ${b.lastInspection}`);
        c.lastInspection = b.lastInspection;
      }
      if (b.station !== undefined) {
        const newStation = String(b.station).trim();
        if (m.station !== newStation) {
          changes.push(`station: ${m.station} → ${newStation}`);
          m.station = newStation;
        }
      }
      return { config: c, changes };
    });

    // ---- Re-scan alerts but never let a scan failure poison the PATCH response ----
    try { scanAlerts(); }
    catch (e) { console.error('[alerts] scanAlerts failed (config saved, scan skipped):', e.message); }

    await auditMm(req, 'alerts.config', 'thresholds', result.changes.length ? result.changes.join('; ') : 'no changes');
    res.json(result.config);
  } catch (e) { next(e); }
});

// =================== API: Inspection register ===================

// GET /api/inspections  -> all inspection reports (latest first).
app.get('/api/inspections', async (_req, res, next) => {
  try {
    res.json(await getInspections());
  } catch (e) { next(e); }
});

// GET /api/inspections/:id  -> a single report (or 404).
app.get('/api/inspections/:id', async (req, res, next) => {
  try {
    const id = decodeURIComponent(req.params.id).trim();
    const rec = await getInspection(id);
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    res.json(rec);
  } catch (e) { next(e); }
});

// GET /api/inspections/meta/next-id  -> next sequential inspection id +
// the previous inspection date (for the read-only "last record" link).
app.get('/api/inspections/meta/next-id', async (_req, res, next) => {
  try {
    const [nextId, prevDate] = await Promise.all([nextInspectionId(), getLastInspectionDate()]);
    res.json({ nextInspectionId: nextId, previousInspectionDate: prevDate || null });
  } catch (e) { next(e); }
});

// POST|PUT /api/inspections  { inspectionId?, ... , report, status, signatureUrl? }
//   create OR update a single inspection report.  If inspectionId is
//   omitted, a fresh sequential id is minted server-side.  `status` is the
//   authoritative overall_status (auto-calculated client-side or manual).
app.post('/api/inspections', async (req, res, next) => {
  try {
    const body = req.body || {};
    // Mint a fresh sequential id when none is supplied (client "new" flow).
    const inspectionId = body.inspectionId ? String(body.inspectionId).trim() : await nextInspectionId();
    const rec = sanitizeInspection({ ...body, inspectionId });
    if (!rec) {
      const e = new Error('inspection_date, inspection_time, inspecting_officer_name and police_station are required');
      e.status = 400; throw e;
    }
    const saved = await upsertInspection(rec);
    await auditMm(req, 'inspection.create', saved.inspectionId,
      `Inspection ${saved.inspectionId} — ${saved.overallStatus} (officer: ${saved.inspectingOfficerName})`);
    res.status(201).json(saved);
  } catch (e) { next(e); }
});

app.patch('/api/inspections', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.inspectionId) { const e = new Error('inspectionId is required to update'); e.status = 400; throw e; }
    const rec = sanitizeInspection(body);
    if (!rec) { const e = new Error('inspection_date, inspection_time, inspecting_officer_name and police_station are required'); e.status = 400; throw e; }
    const saved = await upsertInspection(rec);
    await auditMm(req, 'inspection.update', saved.inspectionId, `Inspection updated — ${saved.overallStatus}`);
    res.json(saved);
  } catch (e) { next(e); }
});

// DELETE /api/inspections/:id  -> remove a report (admin/MM correction).
app.delete('/api/inspections/:id', async (req, res, next) => {
  try {
    const id = decodeURIComponent(req.params.id).trim();
    const existing = await getInspection(id);
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    await deleteInspection(id);
    await auditMm(req, 'inspection.delete', id, `Inspection ${id} deleted`);
    res.json({ id, deleted: true });
  } catch (e) { next(e); }
});

// Build a clean, snake_cased inspection record from the loose request body.
// Returns null if any required field is missing.  isNew tells the caller
// whether to mint a fresh id.
function sanitizeInspection(b) {
  const inspectionDate = String(b.inspectionDate || '').trim();
  const inspectionTime = String(b.inspectionTime || '').trim();
  const inspectingOfficerName = String(b.inspectingOfficerName || '').trim();
  const policeStation = String(b.policeStation || '').trim();
  if (!inspectionDate || !inspectionTime || !inspectingOfficerName || !policeStation) return null;
  return {
    inspectionId: b.inspectionId ? String(b.inspectionId).trim() : null,
    inspectionDate,
    inspectionTime,
    policeStation,
    inspectingOfficerName,
    inspectingOfficerRank: String(b.inspectingOfficerRank || '').trim(),
    malkhanaInchargeName: String(b.malkhanaInchargeName || '').trim(),
    previousInspectionDate: b.previousInspectionDate || null,
    status: String(b.status || 'Needs Follow-up').trim(),
    report: b.report && typeof b.report === 'object' ? b.report : {},
    signatureUrl: b.signatureUrl || null,
    isNew: !b.inspectionId,
  };
}

// =================== API: Reports (Excel + PDF) ===================
// One source of truth for filtering the case list — used by the JSON list
// endpoint, the xlsx export, and the PDF export, so the "respect currently
// applied filters" requirement is enforced server-side.
//
// Filters accepted via query string (all optional):
//   section = "A" | "B" | … | "AA" | "all"        (default: all)
//   status  = "Seized" | "In Malkhana" | … | "all" (default: all)
//   excludeDisposed = "1"                         (default: false)
//   from    = "YYYY-MM-DD"   (seizedOn lower bound, inclusive)
//   to      = "YYYY-MM-DD"   (seizedOn upper bound, inclusive)
//   q       = "search"       (substring match on FIR/DD, item, officer, …)
function parseCaseFilters(query) {
  const section = String(query.section || 'all').toUpperCase();
  const status  = String(query.status  || 'all');
  const excludeDisposed = String(query.excludeDisposed || '') === '1';
  const from = String(query.from || '').trim();
  const to   = String(query.to   || '').trim();
  const q    = String(query.q    || '').trim().toLowerCase();
  // Ordered list of item ids to export EXACTLY (in this order).  When
  // present, the export mirrors the rows currently visible on screen
  // (after search / column filters / sort), overriding section/status/etc.
  const rawIds = String(query.ids || '').trim();
  const ids = rawIds ? rawIds.split(',').map(s => s.trim()).filter(Boolean) : null;
  return { section, status, excludeDisposed, from, to, q, ids };
}

function applyCaseFilters(filters) {
  const db = getDb();
  // When an explicit ordered id list is supplied (export "what's on screen"),
  // return exactly those cases, in that order, ignoring other filters.
  if (filters.ids && filters.ids.length) {
    const byId = new Map(allCases().map(c => [c.id, c]));
    return filters.ids.map(id => byId.get(id)).filter(Boolean);
  }
  let rows = allCases();
  if (filters.section && filters.section !== 'ALL') {
    rows = rows.filter(c => (c.sectionLetter || c.section?.replace('PART ', '')) === filters.section);
  }
  if (filters.status && filters.status !== 'all') {
    rows = rows.filter(c => c.status === filters.status);
  }
  if (filters.excludeDisposed) {
    rows = rows.filter(c => c.status !== 'Disposed');
  }
  if (filters.from) {
    rows = rows.filter(c => String(c.createdAt || '').slice(0,10) >= filters.from);
  }
  if (filters.to) {
    rows = rows.filter(c => String(c.createdAt || '').slice(0,10) <= filters.to);
  }
  if (filters.q) {
    const f = filters.q;
    rows = rows.filter(c =>
      c.id.toLowerCase().includes(f) ||
      c.itemType.toLowerCase().includes(f) ||
      c.itemSub.toLowerCase().includes(f) ||
      c.seizingOfficer.toLowerCase().includes(f) ||
      (c.sectionName || '').toLowerCase().includes(f) ||
      c.status.toLowerCase().includes(f) ||
      (c.itemId || '').toLowerCase().includes(f)
    );
  }
  return rows;
}

// Last-movement date per case: used in the "Last Movement Date" column of
// the report.  Falls back to the case's createdAt / seizedOn for items
// that have no movement log yet.
function lastMovementDate(caseId, fallback) {
  const ms = getMovements(caseId);
  if (!ms.length) return fallback || '';
  return ms[ms.length - 1].timestamp.slice(0, 10);
}

// Canonical column shape used by both xlsx and PDF outputs.
// Column order & labels MIRROR the on-screen Case Property Register table
// (S.No., FIR/DD No., FIR Date, Section U/S, Category of Item, Location,
// Received By, Last Movement Date, Status).  "Action" is UI-only (buttons)
// and is intentionally excluded from the export.
const REPORT_COLUMNS = [
  { key: 'sno',         label: 'S.No.' },
  { key: 'id',          label: 'FIR / DD No.' },
  { key: 'firDate',     label: 'FIR Date' },
  { key: 'usSection',   label: 'Section (U/S legal section)' },
  { key: 'category',    label: 'Category of Item' },
  { key: 'location',    label: 'Location' },
  { key: 'receivedBy',  label: 'Received By (Malkhana Moharrir)' },
  { key: 'lastMovement',label: 'Last Movement Date' },
  { key: 'status',      label: 'Status' },
];

// Mirror of the client's usSectionText(): "BNS 101 — Murder · BNS 22 — …".
function usSectionText(c) {
  if (Array.isArray(c.legalSections) && c.legalSections.length) {
    return c.legalSections
      .map((s, i) => {
        const title = Array.isArray(c.legalSectionsTitles) && c.legalSectionsTitles[i] ? ' — ' + c.legalSectionsTitles[i] : '';
        const str = String(s).trim();
        const hasPrefix = /^[a-zA-Z]/.test(str);
        return hasPrefix ? `${str}${title}` : `BNS ${str}${title}`;
      })
      .join(' · ');
  }
  if (c.legalSection) {
    const title = c.legalSectionTitle ? ' — ' + c.legalSectionTitle : '';
    const str = String(c.legalSection).trim();
    const hasPrefix = /^[a-zA-Z]/.test(str);
    return hasPrefix ? `${str}${title}` : `BNS ${str}${title}`;
  }
  return '';
}

function toReportRow(c, idx) {
  const letter = c.sectionLetter || c.section?.replace('PART ', '') || '';
  return {
    sno:          String(idx + 1),
    id:           c.id,
    firDate:      c.firDate || '',
    usSection:    usSectionText(c),
    category:     c.itemType || '',
    location:     letter ? `${letter} — ${c.sectionName || ''}`.trim() : (c.sectionName || ''),
    receivedBy:   c.receivedBy || '',
    lastMovement: lastMovementDate(c.id, c.createdAt?.slice(0, 10) || ''),
    status:       c.status || '',
  };
}

function reportFileName(stem, ext, filters) {
  const today = new Date().toISOString().slice(0, 10);
  const bits = [stem, today];
  if (filters.section && filters.section !== 'ALL') bits.push(`part-${filters.section}`);
  if (filters.status  && filters.status  !== 'all') bits.push(filters.status.toLowerCase().replace(/\s+/g, '-'));
  if (filters.from) bits.push(`from-${filters.from}`);
  if (filters.to)   bits.push(`to-${filters.to}`);
  return bits.join('-') + '.' + ext;
}

// CSV-style stream of report rows.  Used by both ExcelJS (as in-memory
// rows) and pdfkit (rendered into a table).
function buildReportRows(filters) {
  return applyCaseFilters(filters).map(toReportRow);
}

// ---------------- Excel (.xlsx) ----------------
app.get('/api/reports/case-property', async (req, res, next) => {
  try {
    const filters = parseCaseFilters(req.query);
    const format  = String(req.query.format || 'xlsx').toLowerCase();

    const rows = buildReportRows(filters);
    const db = getDb();
    const officer = req.mm?.name || db.officer?.name || 'Malkhana Moharrir';
    const station = db.meta.station;
    const generatedAt = new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    if (format === 'json') {
      // Useful for debugging / future integrations.  Not a download.
      return res.json({ rows, columns: REPORT_COLUMNS, station, officer, generatedAt, filters });
    }

    if (format === 'xlsx') {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      wb.creator = officer;
      wb.created = new Date();
      const ws = wb.addWorksheet('Case Property Register', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
        headerFooter: {
          oddHeader: `&L&"-,Bold"${station}&C&"-,Bold"Case Property Register&R&"-,Italic"Generated by ${officer} on ${generatedAt}`,
          oddFooter: '&LPage &P of &N&R&"-,Italic"e-Malkhana',
        },
      });
      // Top title block
      ws.mergeCells(1, 1, 1, REPORT_COLUMNS.length);
      const title = ws.getCell('A1');
      title.value = `${station} — Case Property Register`;
      title.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FF14243D' } };
      title.alignment = { vertical: 'middle', horizontal: 'center' };
      ws.getRow(1).height = 24;
      ws.mergeCells(2, 1, 2, REPORT_COLUMNS.length);
      const meta = ws.getCell('A2');
      meta.value = `Generated by ${officer} on ${generatedAt} · ${rows.length} item(s)${filters.section && filters.section !== 'ALL' ? ` · Part ${filters.section}` : ''}${filters.status && filters.status !== 'all' ? ` · ${filters.status}` : ''}`;
      meta.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF5C5A4E' } };
      meta.alignment = { vertical: 'middle', horizontal: 'center' };
      ws.getRow(2).height = 18;

      // Header row
      const headerRow = ws.getRow(4);
      headerRow.values = REPORT_COLUMNS.map(c => c.label);
      headerRow.font = { bold: true, color: { argb: 'FFFAF7EE' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14243D' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
      headerRow.height = 20;

      // Data rows
      rows.forEach((r, i) => {
        const row = ws.getRow(5 + i);
        row.values = REPORT_COLUMNS.map(c => r[c.key]);
        row.font = { name: 'Calibri', size: 10 };
        if (i % 2 === 1) {
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0EBDD' } };
        }
      });

      // Column widths (approximate; ExcelJS uses character widths) — one
      // per REPORT_COLUMNS entry, in the same order.
      const widths = [8, 20, 12, 36, 40, 22, 22, 16, 16];
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      // Borders on the table region
      const lastRow = 4 + rows.length;
      for (let r = 4; r <= lastRow; r++) {
        for (let c = 1; c <= REPORT_COLUMNS.length; c++) {
          const cell = ws.getCell(r, c);
          cell.border = {
            top:    { style: 'hair', color: { argb: 'FFC9BFA0' } },
            bottom: { style: 'hair', color: { argb: 'FFC9BFA0' } },
            left:   { style: 'hair', color: { argb: 'FFC9BFA0' } },
            right:  { style: 'hair', color: { argb: 'FFC9BFA0' } },
          };
        }
      }

      const filename = reportFileName('case-property', 'xlsx', filters);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      try {
        await wb.xlsx.write(res);
      } catch (e) { console.error('[xlsx] write failed:', e && (e.stack || e.message)); throw e; }
      res.end();
      // Audit AFTER res.end() so a slow audit doesn't block the download.
      // (We don't await — fire-and-forget is fine for an audit row.)
      auditMm(req, 'report.export', 'case-property', `Exported xlsx: ${rows.length} row(s), filters=${JSON.stringify(filters)}`)
        .catch(e => console.error('[xlsx] audit failed (non-fatal):', e && e.message));
      return;
    }

    if (format === 'pdf') {
      const PDFDocument = (await import('pdfkit')).default;
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margins: { top: 110, bottom: 0, left: 36, right: 36 },
        info: { Title: 'Case Property Register', Author: officer, Subject: 'e-Malkhana export' },
      });
      const filename = reportFileName('case-property', 'pdf', filters);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.on('error', e => console.error('[pdf] doc error:', e && (e.stack || e.message)));
      try {
        doc.pipe(res);
      } catch (e) { console.error('[pdf] pipe failed:', e && (e.stack || e.message)); throw e; }

      // Letterhead + footer (drawn manually on every page; the pageAdded
      // event in older pdfkit builds can recurse on certain text() calls,
      // so we just call the drawing helpers explicitly before each table).
      function drawHeader() {
        doc.save();
        doc.lineWidth(0.5).strokeColor('#14243D').moveTo(36, 80).lineTo(doc.page.width - 36, 80).stroke();
        doc.fillColor('#14243D').font('Helvetica-Bold').fontSize(14)
           .text(station, 36, 40, { width: doc.page.width - 72, align: 'center' });
        doc.font('Helvetica').fontSize(10).fillColor('#5C5A4E')
           .text('Case Property Register', 36, 58, { width: doc.page.width - 72, align: 'center' });
        doc.fontSize(8).fillColor('#5C5A4E')
           .text(`Generated by ${officer} · ${generatedAt} · ${rows.length} item(s)${filters.section && filters.section !== 'ALL' ? ` · Part ${filters.section}` : ''}${filters.status && filters.status !== 'all' ? ` · ${filters.status}` : ''}`,
                 36, 70, { width: doc.page.width - 72, align: 'center' });
        doc.restore();
      }
      // Prepared-by / Prepared-on / signature block, pinned to the bottom
      // of the single page (replaces the old "Page N" footer).  The officer
      // signs here — there is no electronic signature, just a signature line.
      function drawPreparedBy() {
        const blockH = 72;
        const y = doc.page.height - blockH;
        doc.save();
        doc.lineWidth(0.5).strokeColor('#C9BFA0').moveTo(36, y).lineTo(doc.page.width - 36, y).stroke();
        doc.font('Helvetica').fontSize(9).fillColor('#2B2B28');
        doc.text(`Prepared by: ${officer}`, 36, y + 10, { width: 260 });
        doc.text(`Prepared on: ${generatedAt}`, 36, y + 26, { width: 260 });
        // signature line (right side)
        const sx = doc.page.width - 250;
        doc.lineWidth(0.4).strokeColor('#2B2B28')
           .moveTo(sx, y + 30).lineTo(doc.page.width - 36, y + 30).stroke();
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#5C5A4E')
           .text('Signature of Malkhana Moharrir', sx, y + 34, { width: doc.page.width - 36 - sx });
        doc.restore();
      }
      // Single-page layout: letterhead at top, ONE table header, all rows
      // beneath, and a "Prepared by / Prepared on / Signature" block pinned
      // to the bottom.  No pagination — if there are many rows the row
      // height auto-compresses so everything still fits on one page.
      drawHeader();

      // Column widths (proportional).  Total = page width minus margins.
      const colWidths = REPORT_COLUMNS.map((_, i) => {
        const widths = [40, 95, 55, 150, 160, 95, 95, 60, 55];
        return widths[i] || 60;
      });
      const colTotal = colWidths.reduce((a, b) => a + b, 0);
      const pageWidth = doc.page.width - 72;
      const scale = pageWidth / colTotal;
      const w = colWidths.map(x => x * scale);

      // Reserve space for the prepared-by block, then share the rest among
      // the rows (capped at 18pt; never overflows the single page).
      const topY = 100;
      const signBlockH = 72;
      const usableH = doc.page.height - topY - signBlockH;
      const headerH = 18;
      const rowH = rows.length > 0
        ? Math.min(18, (usableH - headerH) / rows.length)
        : 18;
      const rowFont = Math.min(7.5, Math.max(5, rowH - 2));

      function drawTableHeader(y) {
        let x = 36;
        doc.save();
        doc.rect(36, y, pageWidth, headerH).fillAndStroke('#14243D', '#14243D');
        doc.fillColor('#FAF7EE').font('Helvetica-Bold').fontSize(Math.min(8, Math.max(5, headerH - 3)));
        REPORT_COLUMNS.forEach((c, i) => {
          doc.text(c.label, x + 4, y + 5, { width: w[i] - 6, align: 'left' });
          x += w[i];
        });
        doc.restore();
        return y + headerH;
      }

      function drawRow(r, y) {
        let x = 36;
        doc.save();
        doc.rect(36, y, pageWidth, rowH).fillAndStroke('#FAF7EE', '#C9BFA0');
        doc.fillColor('#2B2B28').font('Helvetica').fontSize(rowFont);
        const values = REPORT_COLUMNS.map(c => String(r[c.key] ?? ''));
        values.forEach((v, i) => {
          doc.text(v, x + 4, y + 3, { width: w[i] - 6, align: 'left', ellipsis: true });
          x += w[i];
        });
        doc.restore();
        return y + rowH;
      }

      let y = topY;
      y = drawTableHeader(y);
      if (rows.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#5C5A4E')
           .text('No cases match the applied filters.', 36, y + 8);
      } else {
        for (const r of rows) {
          y = drawRow(r, y);
        }
      }

      // Prepared-by / prepared-on / signature block on the same page.
      drawPreparedBy();
      try { doc.end(); }
      catch (e) { console.error('[pdf] end failed:', e && (e.stack || e.message)); throw e; }
      auditMm(req, 'report.export', 'case-property', `Exported pdf: ${rows.length} row(s), filters=${JSON.stringify(filters)}`)
        .catch(e => console.error('[pdf] audit failed (non-fatal):', e && e.message));
      return;
    }

    res.status(400).json({ error: 'unsupported format', expected: ['xlsx', 'pdf', 'json'] });
  } catch (e) { next(e); }
});

// ---------------- Malkhana Register (official printed register) ----------------
// GET /api/reports/malkhana-register?section=all|<letter>&format=pdf
// Each page: station letterhead, table (Sl. No., FIR/DD, item, seizure date,
// section, status, blank Remarks), and MM + SHO signature lines at the bottom.
app.get('/api/reports/malkhana-register', async (req, res, next) => {
  try {
    const db = getDb();
    const sectionFilter = String(req.query.section || 'all').toUpperCase();
    const format  = String(req.query.format || 'pdf').toLowerCase();
    if (format !== 'pdf') {
      return res.status(400).json({ error: 'unsupported format', expected: ['pdf'] });
    }
    const officer = req.mm?.name || db.officer?.name || 'Malkhana Moharrir';
    const station = db.meta.station;
    const generatedAt = new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });

    let rows = allCases();
    if (sectionFilter && sectionFilter !== 'ALL') {
      rows = rows.filter(c => (c.sectionLetter || c.section?.replace('PART ', '')) === sectionFilter);
    }
    // Order: section letter, then FIR number ascending (numeric within FIR/DD)
    rows.sort((a, b) => {
      const la = a.sectionLetter || a.section?.replace('PART ', '') || '';
      const lb = b.sectionLetter || b.section?.replace('PART ', '') || '';
      if (la !== lb) return la.localeCompare(lb);
      // numeric part of id ascending
      const na = parseInt((a.id.match(/\d+/) || ['0'])[0], 10);
      const nb = parseInt((b.id.match(/\d+/) || ['0'])[0], 10);
      return na - nb;
    });

    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margins: { top: 120, bottom: 120, left: 36, right: 36 },
      info: { Title: 'Malkhana Register', Author: officer, Subject: 'e-Malkhana official register' },
    });
    const filename = (sectionFilter && sectionFilter !== 'ALL'
        ? `malkhana-register-part-${sectionFilter}`
        : 'malkhana-register') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.on('error', e => console.error('[reg] doc error:', e && (e.stack || e.message)));
    try { doc.pipe(res); }
    catch (e) { console.error('[reg] pipe failed:', e && (e.stack || e.message)); throw e; }

    const pageW = doc.page.width - 72;
    const pageH = doc.page.height;

    function drawPageHeader() {
      doc.save();
      // Decorative double line
      doc.lineWidth(1).strokeColor('#14243D').moveTo(36, 70).lineTo(doc.page.width - 36, 70).stroke();
      doc.lineWidth(0.4).moveTo(36, 73).lineTo(doc.page.width - 36, 73).stroke();
      doc.fillColor('#14243D').font('Helvetica-Bold').fontSize(15)
         .text(station, 36, 36, { width: pageW, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#2B2B28')
         .text('MALKHANA REGISTER', 36, 56, { width: pageW, align: 'center' });
      const sub = sectionFilter && sectionFilter !== 'ALL'
        ? `Part ${sectionFilter} only · ${rows.length} entries`
        : `All sections · ${rows.length} entries`;
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#5C5A4E')
         .text(sub, 36, 80, { width: pageW, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#5C5A4E')
         .text(`Generated by ${officer} on ${generatedAt}`, 36, 92, { width: pageW, align: 'center' });
      doc.restore();
    }

    function drawSignatureBlock() {
      const y = pageH - 90;
      doc.save();
      doc.lineWidth(0.4).strokeColor('#2B2B28')
         .moveTo(36, y).lineTo(60, y).stroke();
      doc.moveTo(pageW / 2 - 24, y).lineTo(pageW / 2 + 24, y).stroke();
      doc.moveTo(doc.page.width - 60, y).lineTo(doc.page.width - 36, y).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#2B2B28')
         .text('Prepared by', 36, y + 4, { width: 100 });
      doc.text('Checked by', pageW / 2 - 50, y + 4, { width: 100, align: 'center' });
      doc.text('Station House Officer', doc.page.width - 200, y + 4, { width: 164, align: 'right' });
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#5C5A4E')
         .text('Malkhana Moharrir', 36, y + 16, { width: 100 });
      doc.text('(MM Signature)', pageW / 2 - 50, y + 16, { width: 100, align: 'center' });
      doc.text('(SHO Signature)', doc.page.width - 200, y + 16, { width: 164, align: 'right' });
      doc.font('Helvetica').fontSize(7).fillColor('#8C7A54')
         .text(`Page ${doc.pageNumber}  ·  e-Malkhana  ·  ${generatedAt}`,
               36, pageH - 30, { width: pageW, align: 'center' });
      doc.restore();
    }

    // 6 columns: Sl.No. | FIR/DD | Item Description | Section | Status | Remarks
    const headers = ['Sl. No.', 'FIR / DD No.', 'Item Description', 'Section', 'Status', 'Remarks'];
    const widths  = [28, 65, 235, 95, 75, 40];
    const sumW = widths.reduce((a, b) => a + b, 0);
    const scale = pageW / sumW;
    const w = widths.map(x => x * scale);
    const headerH = 22;
    const rowH = 22;

    function drawTableHeader(y) {
      let x = 36;
      doc.save();
      doc.rect(36, y, pageW, headerH).fillAndStroke('#14243D', '#14243D');
      doc.fillColor('#FAF7EE').font('Helvetica-Bold').fontSize(9);
      headers.forEach((h, i) => {
        doc.text(h, x + 4, y + 6, { width: w[i] - 6, align: 'left' });
        x += w[i];
      });
      doc.restore();
      return y + headerH;
    }

    function drawRow(sl, c, y) {
      let x = 36;
      doc.save();
      doc.rect(36, y, pageW, rowH).fillAndStroke('#FAF7EE', '#C9BFA0');
      doc.fillColor('#2B2B28').font('Helvetica').fontSize(8);
      const values = [
        String(sl),
        c.id,
        c.itemSub ? `${c.itemType} — ${c.itemSub}` : c.itemType,
        `Part ${c.sectionLetter || c.section?.replace('PART ', '')} · ${c.sectionName}`,
        c.status,
        '',   // blank Remarks
      ];
      values.forEach((v, i) => {
        doc.text(v, x + 4, y + 6, { width: w[i] - 6, align: 'left', height: rowH - 8, ellipsis: true });
        x += w[i];
      });
      doc.restore();
      return y + rowH;
    }

    // First page: draw header + signature block.  Subsequent pages: call
    // them again after doc.addPage().  We avoid the pageAdded event here
    // for the same reason as the case-property PDF.
    drawPageHeader();
    drawSignatureBlock();

    let y = 130;
    y = drawTableHeader(y);

    if (rows.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#5C5A4E')
         .text('No cases match this section filter.', 36, y + 16, { width: pageW, align: 'center' });
    } else {
      let sl = 1;
      for (const c of rows) {
        if (y + rowH > pageH - 130) {
          doc.addPage();
          drawPageHeader();
          drawSignatureBlock();
          y = 130;
          y = drawTableHeader(y);
        }
        y = drawRow(sl++, c, y);
      }
    }
    try { doc.end(); }
    catch (e) { console.error('[reg] end failed:', e && (e.stack || e.message)); throw e; }
    auditMm(req, 'report.export', 'malkhana-register', `Exported pdf: ${rows.length} row(s), section=${sectionFilter}`)
      .catch(e => console.error('[reg] audit failed (non-fatal):', e && e.message));
  } catch (e) { next(e); }
});

// =================== API: Daily backup to Google Drive ===================
// Reads server/data/backup-status.json (written by server/scripts/backup-to-drive.js
// or server/scripts/backup-to-drive.sh, both run from the daily Windows Task
// Scheduler job).  Also supports a manual "Run backup now" endpoint which
// spawns the Node script on demand.
//
// Transport: Google Drive (rclone + Google account OAuth).
//   - No service-account JSON key required.
//   - pg_dump | gzip | rclone rcat streamed straight to Drive folder
//     "e-Malkhana Backups" owned by asppanipat01@gmail.com.

const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '10', 10);
const BACKUP_STATUS_FILE    = join(__dirname, 'data', 'backup-status.json');
const BACKUP_SCRIPT         = join(__dirname, 'scripts', 'backup-to-drive.js');
const BACKUP_FOLDER_URL     = process.env.GDRIVE_FOLDER_URL
  || 'https://drive.google.com/drive/folders/1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b';
const BACKUP_ACCOUNT        = process.env.GDRIVE_ACCOUNT || 'asppanipat01@gmail.com';
const BACKUP_REMOTE         = process.env.GDRIVE_REMOTE  || 'gdrive:e-Malkhana Backups';

function readBackupStatus() {
  try {
    if (!existsSync(BACKUP_STATUS_FILE)) return { runs: [], last: null, lastSuccess: null, lastFailed: null };
    return JSON.parse(readFileSync(BACKUP_STATUS_FILE, 'utf8'));
  } catch (e) {
    console.warn('[backup] failed to read backup-status.json:', e.message);
    return { runs: [], last: null, lastSuccess: null, lastFailed: null };
  }
}

function fmtRun(r) {
  if (!r) return null;
  return {
    ...r,
    prettyTime: new Date(r.timestamp || r.finishedAt || r.startedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    }),
  };
}

// GET /api/backups/status — drive-only, no email transport.
app.get('/api/backups/status', async (req, res, next) => {
  try {
    const st = readBackupStatus();
    const last       = st.last || null;
    const lastSuccess = st.lastSuccess || null;
    const lastFailed  = st.lastFailed || null;
    res.json({
      transport: 'drive',
      remote: BACKUP_REMOTE,
      folderUrl: BACKUP_FOLDER_URL,
      folderId: '1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b',
      account: BACKUP_ACCOUNT,
      retentionDays: BACKUP_RETENTION_DAYS,
      schedule: 'Windows Task Scheduler (daily 02:00)',
      scriptPath: BACKUP_SCRIPT,
      statusFile: BACKUP_STATUS_FILE,
      last: fmtRun(last),
      lastSuccess: fmtRun(lastSuccess),
      lastFailed: fmtRun(lastFailed),
      totalRuns: (st.runs || []).length,
      summary: last
        ? `Last backup: ${fmtRun(last).prettyTime} — ${
            last.status === 'success' ? 'Success' :
            last.status === 'failed'  ? 'Failed'  :
            last.status === 'running' ? 'Running…' : 'Unknown'
          }`
        : 'No backups yet',
    });
  } catch (e) { next(e); }
});

// GET /api/backups/log?limit=N — recent drive backup attempts, newest first.
app.get('/api/backups/log', async (req, res, next) => {
  try {
    const st = readBackupStatus();
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const log = (st.runs || []).slice().reverse().slice(0, limit).map(fmtRun);
    res.json(log);
  } catch (e) { next(e); }
});

// POST /api/backups/run — trigger a drive backup right now. Spawns the
// Node script with the same env the server is running under (which on
// Vercel has DATABASE_URL but NOT rclone — so this will fail gracefully
// on serverless and the user is told to run the script from the laptop).
app.post('/api/backups/run', async (req, res, next) => {
  try {
    if (!existsSync(BACKUP_SCRIPT)) {
      return res.status(503).json({ error: 'backup script not found', path: BACKUP_SCRIPT });
    }
    const startedAt = new Date();
    const child = spawn(process.execPath, [BACKUP_SCRIPT], {
      env: {
        ...process.env,
        BACKUP_RETENTION_DAYS: String(BACKUP_RETENTION_DAYS),
        GDRIVE_FOLDER_URL:     BACKUP_FOLDER_URL,
        GDRIVE_ACCOUNT:        BACKUP_ACCOUNT,
        GDRIVE_REMOTE:         BACKUP_REMOTE,
        BACKUP_STATUS_FILE:    BACKUP_STATUS_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', e => {
      console.error('[backup] spawn error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    });
    child.on('close', code => {
      const m = stdout.match(/✓ uploaded:\s+(\S+)/);
      const fileName = m ? m[1] : null;
      if (code === 0) {
        res.json({ ok: true, code, fileName, transport: 'drive' });
      } else {
        res.status(500).json({
          ok: false, code,
          error: stderr.trim().split('\n').slice(-3).join(' | ')
              || `backup script exited with code ${code}`,
        });
      }
    });
  } catch (e) { next(e); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// JSON error handler — turns thrown Errors into clean { error, ...payload } responses
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const body = { error: err.message || 'internal error' };
  if (err.payload) Object.assign(body, err.payload);
  res.status(status).json(body);
});

// =================== static frontend (local dev only) ===================

if (!IS_VERCEL) {
  const distDir = join(__dirname, '..', 'client', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(join(distDir, 'index.html'));
    });
    console.log(`[e-malkhana] serving frontend from ${distDir}`);
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send(
        'e-Malkhana API is running, but the frontend has not been built yet.\n' +
        'Run:  cd ../client && npm run build   then restart this server.\n' +
        'Or use the dev server:  cd ../client && npm run dev  (port 5173).\n'
      );
    });
  }
}

// =================== boot ===================

// Generate a placeholder SVG image for every case that DOES NOT have one.
// This is a one-time migration: it only ever sets imageUrl on cases that have
// no imageUrl at all.  Crucially, a case that was registered through the app
// without a photo keeps imageUrl = undefined forever — no dummy is ever
// generated for it.  The placeholder is purely for pre-existing/seeded data.
function backfillImages() {
  const db = getDb();
  for (const c of [...db.cases, ...(db.extraCasesForAlerts || [])]) {
    if (c.imageUrl) continue;                                  // already has a real image (uploaded or previously generated)
    if (c.imageAutoGenerated) continue;                        // already attempted before
    if (c.skipAutoImage) continue;                             // case was registered via the app without a photo — leave it
    const url = ensureCaseImage(c);
    mutate(d => {
      const target = d.cases.find(x => x.id === c.id) || d.extraCasesForAlerts?.find(x => x.id === c.id);
      if (target && !target.imageUrl) {
        target.imageUrl = url;
        target.imageAutoGenerated = true;                      // mark so we don't redo this
      }
    });
  }
}

if (!IS_VERCEL) {
  // Long-lived Node process: do the one-time migrations and start the listener.
  // bootStore() loads the PG mirror synchronously into memory; after this point
  // getDb() can be called as a sync accessor (legacy JSON-store style).
  (async () => {
    try {
      await bootStore();
    } catch (e) {
      console.error('[boot] failed to load store mirror:', e && e.message);
      console.error('[boot] start anyway — first request will retry and surface the real error');
    }
    // Fast-forward malkhana_seq past existing item_id values so the next
    // Sr. No. never collides with a seeded/prod MK-YYYY-NNNNNN.
    try { await syncMalkhanaSeq(); } catch (e) { console.error('[boot] syncMalkhanaSeq failed (non-fatal):', e && e.message); }
    ensureUploadsDir();
    backfillImages();
    try { mutate(d => { rebuildSectionCountsIn(d); }); }
    catch (e) { console.error('[boot] rebuildSectionCountsIn failed (non-fatal):', e && e.message); }
    scanAlerts();
    setInterval(scanAlerts, 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`[e-malkhana] http://localhost:${PORT}`);
      console.log(`[e-malkhana] API:  http://localhost:${PORT}/api/health`);
      if (existsSync(join(__dirname, '..', 'client', 'dist'))) console.log(`[e-malkhana] App:  http://localhost:${PORT}/`);
    });
  })();
} else {
  // Vercel serverless: state is per-instance, so on first invocation within
  // a fresh container we backfill the seeded cases' placeholder images.
  // (The function's request handler will still call getDb() lazily, so this
  // is safe to do at module-load time.)
  //
  // We LOG (but don't swallow) bootStore errors — if DATABASE_URL is wrong
  // or the pool can't reach Neon, the user MUST see the real reason, not
  // the silent "store.getDb() called before boot()" error in the response.
  console.log('[boot] Vercel cold start.  DATABASE_URL present:', !!process.env.DATABASE_URL,
    ' length:', (process.env.DATABASE_URL || '').length,
    ' prefix:', (process.env.DATABASE_URL || '').slice(0, 30) + '...');
  (async () => {
    try {
      await bootStore();
      console.log('[boot] store mirror loaded; rows:',
        'users=' + (getDb().users.length),
        'cases=' + (getDb().cases.length),
        'sections=' + (getDb().sections.length));
    } catch (e) {
      console.error('[boot] FATAL — store mirror load failed:', e && e.message);
      console.error('[boot] stack:', e && e.stack);
      // NOTE: we deliberately do NOT swallow this.  The error is recorded
      // in store.js's _bootError so getDb() throws the real message.
      throw e;
    }
    // Load multi-Act legal-section reference into the in-memory db so the
    // new "ACT:N" picker (Register form) and server-side validation can
    // resolve every section across BNS / IPC / NDPS / POCSO / Arms / MV /
    // CrPC / etc.  Comes from the same JSON the client bundles; mirror
    // copy lives at server/data/legal_sections.json for Vercel deploys.
    try {
      const sections = db_loadLegalSections();
      await mutate(d => { d.legalSections = sections; });
      console.log('[boot] legalSections loaded:', (getDb().legalSections || []).length);
    } catch (e) {
      console.error('[boot] legalSections load failed (non-fatal):', e && e.message);
    }
    // Fast-forward malkhana_seq past existing item_id values.
    try { await syncMalkhanaSeq(); } catch (e) { console.error('[boot] syncMalkhanaSeq failed (non-fatal):', e && e.message); }
    try {
      ensureUploadsDir();
      backfillImages();
    } catch (e) {
      console.error('[boot] sync init error (non-fatal):', e && e.message);
    }
    const p1 = mutate(d => { rebuildSectionCountsIn(d); });
    if (p1 && typeof p1.catch === 'function') p1.catch(e => console.error('[boot] mutate error (non-fatal):', e && e.message));
    const p2 = scanAlerts();
    if (p2 && typeof p2.catch === 'function') p2.catch(e => console.error('[boot] scanAlerts error (non-fatal):', e && e.message));
  })();
}

export default app;
