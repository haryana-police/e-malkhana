// e-Malkhana — single-port server: API on /api/* + static frontend on /*.
// Storage: JSON file at server/data/db.json (atomic writes, append-only log).
// Run:  node server.js   (port 4000 by default, override with PORT env)

import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  getDb, mutate, getCase, getMovements, nextMovementId, rebuildSectionCounts,
  appendAudit,
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
  return r.case;
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
  return [...db.cases, ...(db.extraCasesForAlerts || [])];
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
  res.json({
    officer: db.officer,
    racks: db.sections,
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

    const newCase = {
      id,
      itemType:   body.itemType,
      itemSub:    body.itemSub || '',
      section:    `PART ${section.letter}`,
      sectionName:`Part ${section.letter} — ${section.name}`,
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
    await auditMm(req, 'case.create', id, `Registered item: ${body.itemType} (${newCase.sectionName}) — seized by ${body.seizingOfficer} on ${body.seizedOn}`);
    res.status(201).json(newCase);
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
    const m = c.section?.match(/PART ([A-E])/);
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
    const movement = {
      id: nextMovementId(),
      caseId: b.caseId,
      fromLocation: b.fromLocation || lastLocationOf(b.caseId),
      toLocation:   b.toLocation,
      movedBy:      b.movedBy,
      timestamp:    b.timestamp || nowISO(),
      purpose:      b.purpose || 'Movement',
      docRef:       b.docRef || '',
    };
    await mutate(d => { d.movements.push(movement); });
    // optional: also update case status to the most-likely intent
    if (b.setStatus && STATUSES.includes(b.setStatus)) {
      await mutate(d => { const x = d.cases.find(y => y.id === b.caseId); if (x) x.status = b.setStatus; });
    }
    // return the freshly-saved case (with updated status if any)
    const updated = getCase(b.caseId) || c;
    await auditMm(req, b.setStatus ? 'movement.record' : 'movement.log', c.id,
      `${b.setStatus ? 'Recorded movement + status: ' : 'Logged movement: '}${b.fromLocation || '—'} → ${b.toLocation}${b.setStatus ? ` (status: ${b.setStatus})` : ''}${b.purpose ? ' — ' + b.purpose : ''}`);
    res.status(201).json({ case: updated, movement });
  } catch (e) { next(e); }
});

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
    const c = r.case;

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
      const finalCase = getCase(c.id) || c;
      await auditMm(req, 'scan.record', c.id, `Scan + movement: ${movement.fromLocation} → ${movement.toLocation}${b.setStatus ? ` (status → ${b.setStatus})` : ''}`);
      res.status(201).json({ case: finalCase, movement });
      return;
    }
    res.json({ case: c });
  } catch (e) { next(e); }
});

// =================== API: sections (configurable malkhana sections) ===================

app.get('/api/sections', (_req, res) => {
  res.json(getDb().sections);
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
  ensureUploadsDir();
  backfillImages();
  mutate(d => { rebuildSectionCountsIn(d); });
  scanAlerts();
  setInterval(scanAlerts, 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`[e-malkhana] http://localhost:${PORT}`);
    console.log(`[e-malkhana] API:  http://localhost:${PORT}/api/health`);
    if (existsSync(join(__dirname, '..', 'client', 'dist'))) console.log(`[e-malkhana] App:  http://localhost:${PORT}/`);
  });
} else {
  // Vercel serverless: state is per-instance, so on first invocation within
  // a fresh container we backfill the seeded cases' placeholder images.
  // (The function's request handler will still call getDb() lazily, so this
  // is safe to do at module-load time.)
  //
  // Every async op is wrapped so a boot-time error (e.g. /tmp permission
  // glitch, malformed seed) can never crash the serverless function and
  // turn into a FUNCTION_INVOCATION_FAILED 500 for the user.
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
}

export default app;
