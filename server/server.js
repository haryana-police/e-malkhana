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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  getDb, mutate, getCase, getCaseByItemId, getMovements, nextMovementId, rebuildSectionCounts,
  nextMalkhanaSeq, formatMalkhanaSrNo, syncMalkhanaSeq,
  appendAudit, boot as bootStore, ensureBoot,
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

const STATUSES = [
  'Seized', 'Expert Opinion Pending', 'In Malkhana',
  'With FSL', 'In Court', 'Disposed', 'Transfer',
];

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
function resolveCaseId(raw) {
  const db = getDb();
  const all = [...db.cases, ...(db.extraCasesForAlerts || [])];
  const q = String(raw || '').trim();
  if (!q) return { case: null, suggestions: all.slice(0, 5).map(c => c.id) };

  // 1) exact
  let hit = all.find(c => c.id === q);
  if (hit) return { case: hit, suggestions: [] };

  // 2) case-insensitive
  const ql = q.toLowerCase();
  hit = all.find(c => c.id.toLowerCase() === ql);
  if (hit) return { case: hit, suggestions: [] };

  // 3) numeric substring — e.g. "215" matches "FIR 215/2026"
  const digits = q.match(/\d+/);
  if (digits) {
    const matches = all.filter(c => c.id.includes(digits[0]));
    if (matches.length === 1) return { case: matches[0], suggestions: [] };
    if (matches.length > 1)  return { case: null, suggestions: matches.slice(0, 8).map(c => c.id) };
  }

  // 4) any substring (unique)
  const subs = all.filter(c => c.id.toLowerCase().includes(ql));
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
  try { res.json(findOrThrow(req.params.id)); }
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

  // Multi-section support: the user can book a case under several BNS
  // sections at once (e.g. "BNS 101 — Murder" + "BNS 397 — Causing hurt").
  // `body.legalSections` is the ordered array of section numbers; each is
  // validated against bns_sections.  We keep `legalSection`/`legalSectionTitle`
  // as the *primary* (first) section for the register tag / legacy reports.
  let legalSection = null, legalSectionTitle = null;
  let legalSections = [], legalSectionsTitles = [];
  if (Array.isArray(body.legalSections) && body.legalSections.length) {
    for (const raw of body.legalSections) {
      const secNo = String(raw).replace(/^BNS\s+/i, '').trim();
      const hit = db_bnsSectionByNo(secNo);
      if (!hit) { const e = new Error(`unknown BNS section: ${raw}`); e.status = 400; throw e; }
      legalSections.push(hit.sectionNo);
      legalSectionsTitles.push(hit.title);
    }
    legalSection = legalSections[0];
    legalSectionTitle = legalSectionsTitles[0];
  } else if (body.legalSection) {
    // Backward-compat: single section still accepted.
    const secNo = String(body.legalSection).replace(/^BNS\s+/i, '').trim();
    const hit = db_bnsSectionByNo(secNo);
    if (!hit) { const e = new Error(`unknown BNS section: ${body.legalSection}`); e.status = 400; throw e; }
    legalSection = hit.sectionNo;
    legalSectionTitle = hit.title;
    legalSections = [hit.sectionNo];
    legalSectionsTitles = [hit.title];
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
    itemTypeId: itemTypeId != null ? itemTypeId : undefined,
    description: body.description || undefined,
    createdAt,
  };
  await mutate(d => { d.cases.push(newCase); rebuildSectionCountsIn(d); });
  await auditMm(req, 'case.create', id, `Registered item: ${body.itemType} (Part ${section.letter} — ${section.name}) — seized by ${body.seizingOfficer}${legalSection ? ` — BNS ${legalSection} (${legalSectionTitle})` : ''} — Sr. No. ${itemId}`);
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

// PATCH /api/cases/:id
//
// Edit the editable fields of a case from the Case Property Detail page.
// The case id itself is immutable (it's the FIR/DD number — renaming that
// would break every movement / alert / QR link that points at it).  All
// other fields the user can see in the detail view are editable.
//
// Body (all fields OPTIONAL — only present keys are touched):
//   {
//     itemType?:        string,
//     itemSub?:         string,
//     section?:         string  (section letter "A".."E"),
//     seizingOfficer?:  string,
//     seizedOn?:        string  (ISO date "2026-03-11" or display "11 Mar 2026"),
//     itemId?:          string,
//     legalSection?:    string  (BNS section no., bare "101" or "BNS 101"; null/"" to clear)
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
    // dropped (avoids callers sneaking in `status` or `id` changes through
    // a different endpoint).
    const ALLOWED = ['itemType', 'itemSub', 'section', 'seizingOfficer', 'itemId', 'legalSection',
                      'legalSections', 'itemTypeId', 'description'];
    const patch = {};
    for (const k of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) { const e = new Error('no editable fields supplied'); e.status = 400; throw e; }

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
    await mutate(d => {
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

// =================== API: movements (append-only) ===================

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
      fromLocation: lastLocationOf(c.id),
      toLocation:   b.toLocation,
      movedBy:      b.movedBy || getDb().officer.name,
      timestamp:    nowISO(),
      purpose:      b.purpose || `Scan @ ${b.toLocation}`,
      docRef:       b.docRef || `SCAN-${Date.now()}`,
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

function lastLocationOf(caseId) {
  const ms = getMovements(caseId);
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
        id: nextMovementId(),
        caseId: c.id,
        fromLocation: lastLocationOf(c.id),
        toLocation:   b.toLocation,
        movedBy:      b.movedBy || getDb().officer.name,
        timestamp:    nowISO(),
        purpose:      b.purpose || `Scan @ ${b.toLocation}`,
        docRef:       b.docRef || `SCAN-${Date.now()}`,
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
      d.sections.push({ letter: chosen, name, count: 0 });
      d.sections.sort((a, b) => a.letter.length - b.letter.length || a.letter.localeCompare(b.letter));
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
  return { section, status, excludeDisposed, from, to, q };
}

function applyCaseFilters(filters) {
  const db = getDb();
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

// Canonical 10-column row shape used by both xlsx and PDF outputs.
// Column order matches the issued Case Property Register format
// (S.No. first, Quantity + Last Movement Date present).
const REPORT_COLUMNS = [
  { key: 'sno',             label: 'S.No.' },
  { key: 'id',              label: 'FIR / DD No.' },
  { key: 'itemType',        label: 'Item Type' },
  { key: 'description',     label: 'Description' },
  { key: 'quantity',        label: 'Quantity' },
  { key: 'sectionName',     label: 'Section' },
  { key: 'status',          label: 'Status' },
  { key: 'seizingOfficer',  label: 'Seizing Officer' },
  { key: 'lastMovement',    label: 'Last Movement Date' },
];

function toReportRow(c) {
  // Quantity is parsed out of the leading "<n> unit(s) · …" pattern that
  // RegisterCaseModal prefixes into itemSub; we fall back to "1" when
  // nothing is parseable (legacy seed rows).
  let qty = '1';
  if (c.itemSub) {
    const m = c.itemSub.match(/^(\d+)\s*unit/i);
    if (m) qty = m[1];
  }
  return {
    sno:             '', // filled in per-row by buildReportRows() so it reflects the filtered, sorted order
    id:              c.id,
    itemType:        c.itemType,
    description:     c.itemSub,
    quantity:        qty,
    sectionName:     `Part ${c.sectionLetter || c.section?.replace('PART ', '')} — ${c.sectionName}`,
    status:          c.status,
    seizingOfficer:  c.seizingOfficer,
    lastMovement:    lastMovementDate(c.id, c.createdAt?.slice(0, 10) || ''),
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

      // Column widths (approximate; ExcelJS uses character widths)
      const widths = [16, 28, 38, 8, 30, 18, 22, 12, 16];
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
        const widths = [70, 110, 145, 38, 130, 80, 95, 60, 75];
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
// Schedules a daily `node server/scripts/backup-to-drive.js` run, logs each
// attempt to db.backupLog (visible via /api/backups/last), and exposes a
// "Run backup now" endpoint for admins.
//
// Backed by an in-process node-cron task.  On Vercel (serverless) the cron
// is never triggered (the function instance is short-lived); the
// /api/backups/run endpoint and the existing scripts/backup-to-drive.js
// still work for manual / external-cron-driven backups.

const BACKUP_CRON = process.env.BACKUP_CRON || '0 23 * * *';   // 23:00 daily
const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
const BACKUP_SCRIPT = join(__dirname, 'scripts', 'backup-email.js');

function appendBackupLog(entry) {
  mutate(d => {
    if (!d.backupLog) d.backupLog = [];
    const id = (d.backupLog.at(-1)?.id ?? 0) + 1;
    d.backupLog.push({
      id,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    // Cap at 100 entries — older rows are pruned; the actual file on Drive
    // is the long-term archive.
    if (d.backupLog.length > 100) d.backupLog.splice(0, d.backupLog.length - 100);
  }).catch(e => console.error('[backup] failed to append log:', e && e.message));
}

async function runBackup(reason) {
  const startedAt = new Date();
  appendBackupLog({ status: 'running', reason, startedAt: startedAt.toISOString(), fileName: '' });
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BACKUP_SCRIPT], {
      env: { ...process.env, BACKUP_RETENTION_DAYS: String(BACKUP_RETENTION_DAYS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', e => {
      appendBackupLog({
        status: 'failed', reason,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        fileName: '',
        error: e.message,
      });
      resolve({ ok: false, error: e.message });
    });
    child.on('close', code => {
      const finishedAt = new Date();
      // Extract the uploaded filename from the stdout — the script logs
      // "✓ uploaded: <name>".  Best-effort; falls back to the timestamped
      // default if the script's output format changes.
      const m = stdout.match(/✓ uploaded:\s+(\S+)/);
      const fileName = m ? m[1] : `emalkhana-backup-${startedAt.toISOString().slice(0, 10)}.json`;
      if (code === 0) {
        appendBackupLog({
          status: 'success', reason,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          fileName,
          durationMs: finishedAt - startedAt,
        });
      } else {
        appendBackupLog({
          status: 'failed', reason,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          fileName: '',
          exitCode: code,
          error: stderr.trim() || `backup script exited with code ${code}`,
        });
      }
      resolve({ ok: code === 0, code, fileName });
    });
  });
}

let _backupTask = null;
function scheduleDailyBackup() {
  if (_backupTask) return;
  if (!existsSync(BACKUP_SCRIPT)) {
    console.warn(`[backup] script not found at ${BACKUP_SCRIPT} — daily backup disabled.`);
    return;
  }
  _backupTask = cron.schedule(BACKUP_CRON, () => {
    console.log('[backup] cron fired — starting daily backup');
    runBackup('cron').catch(e => console.error('[backup] cron run failed:', e && e.message));
  }, { scheduled: true });
  console.log(`[backup] daily backup scheduled: "${BACKUP_CRON}" (retention: ${BACKUP_RETENTION_DAYS} days)`);
}

// GET /api/backups/status  —  returns the latest backup entry, plus the
// configured schedule / retention.  Cheap to call; the admin screen polls it
// on open + after "Run now" so the user sees fresh status.
app.get('/api/backups/status', async (req, res, next) => {
  try {
    const db = getDb();
    const log = db.backupLog || [];
    const last  = log.at(-1) || null;
    const lastSuccess = [...log].reverse().find(e => e.status === 'success') || null;
    const lastFailed  = [...log].reverse().find(e => e.status === 'failed')  || null;
    res.json({
      cron: BACKUP_CRON,
      retentionDays: BACKUP_RETENTION_DAYS,
      transport: 'email',
      to: process.env.BACKUP_TO || null,
      scriptPath: BACKUP_SCRIPT,
      last,
      lastSuccess,
      lastFailed,
      totalRuns: log.length,
      // Convenience: a single "summary" string the settings screen renders.
      summary: last
        ? `Last backup: ${new Date(last.timestamp).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })} — ${
            last.status === 'success' ? 'Success' :
            last.status === 'failed'  ? 'Failed'  :
            last.status === 'running' ? 'Running…' : 'Unknown'
          }`
        : 'No backups yet',
    });
  } catch (e) { next(e); }
});

// GET /api/backups/log?limit=N  —  recent backup attempts, newest first.
app.get('/api/backups/log', async (req, res, next) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
    const log = (db.backupLog || []).slice().reverse().slice(0, limit);
    res.json(log);
  } catch (e) { next(e); }
});

// POST /api/backups/run  —  trigger a backup right now.  Used by the admin
// "Run backup now" button.  Returns when the child process finishes.
app.post('/api/backups/run', async (req, res, next) => {
  try {
    if (!existsSync(BACKUP_SCRIPT)) {
      return res.status(503).json({ error: 'backup script not found', path: BACKUP_SCRIPT });
    }
    const result = await runBackup('manual');
    await auditMm(req, 'backup.run', 'email', `Manual backup: ${result.ok ? 'success' : 'failed'}${result.fileName ? ' → ' + result.fileName : ''}`);
    res.json(result);
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
    scheduleDailyBackup();

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
    scheduleDailyBackup();
  })();
}

export default app;
