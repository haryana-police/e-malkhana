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
  getDb, mutate, getCase, getMovements, nextMovementId, rebuildSectionCounts,
  appendAudit, boot as bootStore,
} from './store.js';
import { ensureUploadsDir, writeUpload, ensureCaseImage, UPLOADS_DIR } from './uploads.js';

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
app.use((req, _res, next) => {
  const id = String(req.header('x-mm-id') || '').trim().toUpperCase();
  const name = String(req.header('x-mm-name') || '').trim();
  const db = getDb();
  let u = null;
  if (id) u = (db.users || []).find(x => x.id.toUpperCase() === id) || null;
  req.mm = { id: u?.id || 'anonymous', name: u?.name || (id ? name : '—') };
  next();
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
  'With FSL', 'In Court', 'Disposed',
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
  // MK-YYYY-NNNNNN  (NNNNNN = digits of caseId, padded)
  const y = new Date().getFullYear();
  const digits = (seed.match(/\d+/g) || []).join('').padStart(6, '0').slice(-6);
  return `MK-${y}-${digits}`;
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
  return [...db.cases, ...(db.extraCasesForAlerts || [])].map(c => withFreshSectionName(c, db));
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
  return {
    totalProperty:   db.cases.length,            // only "real" register, matches design
    pendingDisposal: pendingDisp,
    expertPending:   expert,
    withFSL:         withFsl,
    inspectionDue:   inspectionDueText(),
    station:         db.meta.station,
    asOf:            db.meta.asOf,
  };
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
  return [...db.movements]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
    .map(m => {
      const c = getCase(m.caseId);
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
function humanTime(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const isToday = d >= today;
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  if (isToday) return `Today, ${time}`;
  const yest = new Date(today.getTime() - 86400000);
  if (d >= yest) return `Yesterday, ${time}`;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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
  res.json({ user: safe, station: db.meta.station, asOf: db.meta.asOf });
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
    const body = req.body || {};
    const required = ['firOrDd', 'itemType', 'section', 'seizingOfficer', 'seizedOn']; // photo is OPTIONAL
    for (const k of required) if (!body[k]) { const e = new Error(`missing field: ${k}`); e.status = 400; throw e; }

    const section = db_sectionByLetter(body.section);
    const id = body.firOrDd.trim();
    const itemId = body.itemId || makeItemId(id);
    const createdAt = nowISO();

    // NOTE: sectionName is NOT stored on the case record. It's always
    // resolved from the live sections table at read time (see
    // withFreshSectionName). This way section renames propagate to every
    // existing case without a migration. Only the letter reference is
    // persisted: c.section = "PART A".
    const newCase = {
      id,
      itemType:   body.itemType,
      itemSub:    body.itemSub || '',
      section:    `PART ${section.letter}`,
      status:     body.status || 'Seized',
      seizingOfficer: body.seizingOfficer,
      seizedOn:   body.seizedOn,
      itemId,
      // Photo is OPTIONAL. If the MM did not upload one, imageUrl stays
      // undefined and skipAutoImage=true so the boot-time backfill never
      // synthesises a dummy image for a newly-registered case.
      imageUrl:   body.photo || undefined,
      skipAutoImage: !body.photo,                              // protect newly-registered cases from auto-dummy
      docRef:     body.supportingDoc || undefined,             // optional — seizure memo URL
      createdAt,
    };
    await mutate(d => { d.cases.push(newCase); rebuildSectionCountsIn(d); });
    await auditMm(req, 'case.create', id, `Registered item: ${body.itemType} (Part ${section.letter} — ${section.name}) — seized by ${body.seizingOfficer} on ${body.seizedOn}`);
    res.status(201).json(withFreshSectionName(newCase, getDb()));
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

function db_sectionByLetter(letter) {
  const db = getDb();
  const l = String(letter).toUpperCase();
  return db.sections.find(s => s.letter === l);
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

// =================== API: QR codes ===================

app.get('/api/cases/:id/qr', async (req, res, next) => {
  try {
    const c = findOrThrow(req.params.id);
    // The QR encodes a compact JSON payload — the field scanner app
    // (or our web /api/scan) parses this to start a movement.
    const payload = JSON.stringify({
      v: 1,
      id: c.id,
      item: c.itemId,
      type: c.itemType,
      section: c.section,
    });
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#14243D', light: '#FAF7EE' },
    });
    res.json({ dataUrl, payload, case: c });
  } catch (e) { next(e); }
});

// =================== API: movements (append-only) ===================

app.get('/api/cases/:id/movements', (req, res) => {
  res.json(getMovements(req.params.id));
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
// Accepts either a raw case id (e.g. "FIR 214/2026") or a JSON payload
// (the same string the QR encodes).  Creates a movement log entry.

app.post('/api/scan', async (req, res, next) => {
  try {
    const b = req.body || {};
    const raw = (b.payload || b.caseId || '').trim();
    if (!raw) { const e = new Error('payload (QR text) or caseId is required'); e.status = 400; throw e; }

    // Try to parse as JSON payload
    let candidate = raw;
    try { if (raw.startsWith('{')) candidate = JSON.parse(raw).id; } catch {}

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
      const finalCase = withFreshSectionName(getCase(c.id) || c, getDb());
      await auditMm(req, 'scan.record', c.id, `Scan + movement: ${movement.fromLocation} → ${movement.toLocation}${b.setStatus ? ` (status → ${b.setStatus})` : ''}`);
      res.status(201).json({ case: finalCase, movement });
      return;
    }
    res.json({ case: c });
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
  res.json(getDb().alertConfig);
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
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: 'validation failed', fields });
    }

    // ---- Persist ----
    const result = await mutate(d => {
      const c = d.alertConfig;
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
      return { config: c, changes };
    });

    // ---- Re-scan alerts but never let a scan failure poison the PATCH response ----
    try { scanAlerts(); }
    catch (e) { console.error('[alerts] scanAlerts failed (config saved, scan skipped):', e.message); }

    await auditMm(req, 'alerts.config', 'thresholds', result.changes.length ? result.changes.join('; ') : 'no changes');
    res.json(result.config);
  } catch (e) { next(e); }
});

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
    rows = rows.filter(c => String(c.seizedOn || '') >= filters.from);
  }
  if (filters.to) {
    rows = rows.filter(c => String(c.seizedOn || '') <= filters.to);
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

// Canonical 9-column row shape used by both xlsx and PDF outputs.
const REPORT_COLUMNS = [
  { key: 'id',              label: 'FIR / DD No.' },
  { key: 'itemType',        label: 'Item Type' },
  { key: 'description',     label: 'Description' },
  { key: 'quantity',        label: 'Quantity' },
  { key: 'sectionName',     label: 'Section' },
  { key: 'status',          label: 'Status' },
  { key: 'seizingOfficer',  label: 'Seizing Officer' },
  { key: 'seizedOn',        label: 'Seized On' },
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
    id:              c.id,
    itemType:        c.itemType,
    description:     c.itemSub,
    quantity:        qty,
    sectionName:     `Part ${c.sectionLetter || c.section?.replace('PART ', '')} — ${c.sectionName}`,
    status:          c.status,
    seizingOfficer:  c.seizingOfficer,
    seizedOn:        c.seizedOn,
    lastMovement:    lastMovementDate(c.id, c.createdAt?.slice(0, 10) || c.seizedOn),
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
        margins: { top: 110, bottom: 70, left: 36, right: 36 },
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
      function drawFooter() {
        const y = doc.page.height - 50;
        doc.save();
        doc.lineWidth(0.5).strokeColor('#C9BFA0').moveTo(36, y).lineTo(doc.page.width - 36, y).stroke();
        doc.fillColor('#5C5A4E').font('Helvetica').fontSize(8)
           .text(`Page ${doc.pageNumber}`, 36, y + 8, { width: doc.page.width - 72, align: 'center' });
        doc.restore();
      }
      // Draw initial page header/footer
      drawHeader();
      drawFooter();

      // Column widths (proportional).  Total = page width minus margins.
      const colWidths = REPORT_COLUMNS.map((_, i) => {
        const widths = [70, 110, 145, 38, 130, 80, 95, 60, 75];
        return widths[i] || 60;
      });
      const colTotal = colWidths.reduce((a, b) => a + b, 0);
      const pageWidth = doc.page.width - 72;
      const scale = pageWidth / colTotal;
      const w = colWidths.map(x => x * scale);
      const rowH = 18;

      function drawTableHeader(y) {
        let x = 36;
        doc.save();
        doc.rect(36, y, pageWidth, rowH).fillAndStroke('#14243D', '#14243D');
        doc.fillColor('#FAF7EE').font('Helvetica-Bold').fontSize(8);
        REPORT_COLUMNS.forEach((c, i) => {
          doc.text(c.label, x + 4, y + 5, { width: w[i] - 6, align: 'left' });
          x += w[i];
        });
        doc.restore();
        return y + rowH;
      }

      function drawRow(r, y) {
        let x = 36;
        doc.save();
        doc.rect(36, y, pageWidth, rowH).fillAndStroke('#FAF7EE', '#C9BFA0');
        doc.fillColor('#2B2B28').font('Helvetica').fontSize(7.5);
        const values = REPORT_COLUMNS.map(c => String(r[c.key] ?? ''));
        values.forEach((v, i) => {
          doc.text(v, x + 4, y + 4, { width: w[i] - 6, align: 'left', height: rowH - 6, ellipsis: true });
          x += w[i];
        });
        doc.restore();
        return y + rowH;
      }

      let y = 100;
      y = drawTableHeader(y);
      if (rows.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#5C5A4E')
           .text('No cases match the applied filters.', 36, y + 8);
      } else {
        for (const r of rows) {
          if (y + rowH > doc.page.height - 60) {
            doc.addPage();
            drawHeader();
            drawFooter();
            y = 100;
          }
          y = drawTableHeader(y);
          if (y + rowH > doc.page.height - 60) {
            doc.addPage();
            drawHeader();
            drawFooter();
            y = 100;
          }
          y = drawRow(r, y);
        }
      }
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

    // 7 columns: Sl.No. | FIR/DD | Item Description | Seizure Date | Section | Status | Remarks
    const headers = ['Sl. No.', 'FIR / DD No.', 'Item Description', 'Seizure Date', 'Section', 'Status', 'Remarks'];
    const widths  = [28, 65, 175, 60, 95, 75, 40];
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
        c.seizedOn,
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
const BACKUP_SCRIPT = join(__dirname, 'scripts', 'backup-to-drive.js');

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
    await auditMm(req, 'backup.run', 'gdrive', `Manual backup: ${result.ok ? 'success' : 'failed'}${result.fileName ? ' → ' + result.fileName : ''}`);
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
  // Every async op is wrapped so a boot-time error (e.g. /tmp permission
  // glitch, malformed seed) can never crash the serverless function and
  // turn into a FUNCTION_INVOCATION_FAILED 500 for the user.
  (async () => {
    try { await bootStore(); }
    catch (e) { console.error('[boot] store mirror load failed (non-fatal):', e && e.message); }
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
