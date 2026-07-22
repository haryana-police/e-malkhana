// e-Malkhana store — Postgres-backed implementation of the legacy in-memory
// store API that server.js (and api/index.js via it) consumes.
//
// This file is a *behavioural drop-in* for the old JSON-file store.  The
// exported functions keep the same signatures and return shapes that
// server.js expects.  The only externally observable difference is that
// data is now durable across process restarts and Vercel cold starts.
//
// ---------------------------------------------------------------
// API contract (unchanged from the JSON-file era)
// ---------------------------------------------------------------
//   getDb()                          → { meta, officer, users, auditLog,
//                                        sections, cases, movements,
//                                        alertConfig, extraCasesForAlerts,
//                                        extraMovements, alertIssues }
//   mutate(fn)                       → runs fn(snapshot) and persists
//   getCase(id)                      → case object | undefined
//   getMovements(caseId)             → movement[] sorted by timestamp asc
//   nextMovementId()                 → integer
//   rebuildSectionCounts()           → void (recomputes sections.count)
//   appendAudit({ userId, userName, action, target, details }) → audit row
//
// ---------------------------------------------------------------
// Concurrency model
// ---------------------------------------------------------------
// Node's event loop is single-threaded, so we don't need a real write lock
// across the whole snapshot.  We DO serialise mutate() calls (one at a time)
// with a simple in-process queue so two overlapping requests can't diff
// against the same pre-state and lose each other's writes.  On Vercel
// serverless this only matters if the same container handles two requests
// concurrently — which is rare but possible.
//
// ---------------------------------------------------------------
// What changes
// ---------------------------------------------------------------
//   - getDb() loads the full snapshot from PG on first call per process,
//     then serves subsequent calls from the in-memory mirror.
//   - mutate() snapshots the mirror, runs fn, diffs the result against the
//     pre-snapshot, and writes the minimal set of rows to PG (inside a
//     transaction).
//   - getCase / getMovements / nextMovementId hit the mirror (fast path)
//     but call ensureReady() to make sure the schema + seed have been
//     initialised first.
//   - appendAudit is a direct SQL INSERT (no mirror diff needed).
//   - On every mutate we invalidate the mirror after the write so the
//     next getDb() pulls fresh data from PG.  This is what makes the
//     data survive across cold starts and across multiple function
//     instances on Vercel.

import { ensureReady, pool, getCaseProperty, getFirMaster } from './db.js';

// Parse a JSON-array TEXT column back into a string[] (used by the
// multi-section columns legal_sections / legal_sections_titles).  Tolerant
// of NULL / empty / malformed values — returns [] in every failure case.
function parseJsonArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// ---------- mirror + write lock ----------

let _mirror = null;      // { meta, officer, ..., cases: [], movements: [] }
let _loading = null;     // Promise guarding first-load
let _writeQueue = Promise.resolve();

function deepCopy(obj) {
  // JSON round-trip is fine here: the snapshot only contains plain JSON-safe
  // data (strings, numbers, booleans, arrays, objects).  The cost of
  // serialising a few hundred rows is negligible compared to the SQL round-trip.
  return obj === null || obj === undefined ? obj : JSON.parse(JSON.stringify(obj));
}

export async function loadMirror() {
  if (_mirror) return _mirror;
  if (_loading) return _loading;
  _loading = (async () => {
    await ensureReady();
    const client = await pool.connect();
    try {
      const [kvRes, usersRes, sectionsRes, itRes, bnsRes, casesRes, movRes, auditRes, fmRes, cpRes, mtRes] = await Promise.all([
        client.query("SELECT key, value FROM kv WHERE key IN ('meta','officer','alertConfig','alertIssues','backupLog')"),
        client.query(`SELECT id, initials, name, rank, designation, station, password FROM users ORDER BY id`),
        client.query(`SELECT letter, name, count, active, sort_order FROM sections ORDER BY sort_order, length(letter), letter`),
        client.query(`SELECT id, section_letter, name, sort_order, active FROM item_types ORDER BY section_letter, sort_order, name`),
        client.query(`SELECT section_no, title, description, category FROM bns_sections ORDER BY length(section_no), section_no`),
        client.query(`SELECT id, fir_no, item_type, item_sub, section, status,
                            seizing_officer, item_id,
                            image_url, image_auto_generated, skip_auto_image,
                            doc_ref, legal_section, legal_section_title,
                            legal_sections, legal_sections_titles,
                            item_type_id, description,
                            created_at
                     FROM cases ORDER BY created_at`),
        client.query(`SELECT id, case_id, from_location, to_location, moved_by,
                             purpose, doc_ref, status, ts
                      FROM movements ORDER BY ts, id`),
        client.query(`SELECT id, ts, user_id, user_name, action, target, details
                      FROM audit_log ORDER BY id`),
        // FIR/DD master (FIR Date lives here) + case_property (Received By)
        // are loaded into the mirror so the Case Property Register can show
        // those two columns without a per-row round-trip to Postgres.
        client.query(`SELECT fir_no, fir_date, record_type, dd_date, us_sections FROM fir_master`),
        client.query(`SELECT item_id, received_by FROM case_property`),
        // Movement Types — the configurable "Move to status" vocabulary.
        // Loaded into the mirror so the Change Status modal and the
        // Register filter dropdown can read it synchronously.  Seeded by
        // db.seedMovementTypesIfEmpty() on first boot.
        client.query(`SELECT id, name, default_location, default_purpose, "next",
                             sort_order, active, is_system
                        FROM movement_types
                       ORDER BY sort_order ASC, id ASC`),
      ]);
      const kv = Object.fromEntries(kvRes.rows.map(r => [r.key, r.value]));
      _mirror = {
        meta:     kv.meta     || { version: 1, station: 'PS Sector-5, Panchkula', asOf: '' },
        officer:  kv.officer  || { initials: 'RS', name: 'SI Rakesh Sharma', rank: '' },
        users:    usersRes.rows.map(r => ({
          id: r.id, initials: r.initials, name: r.name,
          rank: r.rank, designation: r.designation, station: r.station,
          password: r.password,
        })),
        auditLog: auditRes.rows.map(r => ({
          id:        Number(r.id),
          timestamp: new Date(r.ts).toISOString(),
          userId:    r.user_id,
          userName:  r.user_name,
          action:    r.action,
          target:    r.target,
          details:   r.details,
        })),
        sections: sectionsRes.rows.map(r => ({
          letter: r.letter, name: r.name, count: r.count, active: r.active, sortOrder: Number(r.sort_order) || 0,
        })),
        bnsSections: bnsRes.rows.map(r => ({
          sectionNo: r.section_no,
          title:     r.title,
          description: r.description || undefined,
          category:  r.category || undefined,
        })),
        itemTypes: itRes.rows.map(r => ({
          id:            Number(r.id),
          sectionLetter: r.section_letter,
          name:          r.name,
          sortOrder:     Number(r.sort_order) || 0,
          active:        r.active !== false,
          caseCount:    0,                 // filled by the pass below
        })),
        // Movement Types — admin-managed vocabulary for the Change Status
        // dropdown, Register filter, Dashboard tiles, and status validation.
        // The mirror is the source of truth at runtime; persistDiff() below
        // syncs every mutation back to Postgres.
        movementTypes: (mtRes?.rows || []).map(r => ({
          id:              Number(r.id),
          name:            r.name,
          defaultLocation: r.default_location || '',
          defaultPurpose:  r.default_purpose  || '',
          next:            Array.isArray(r.next) ? r.next : [],
          sortOrder:       Number(r.sort_order) || 0,
          active:          r.active !== false,
          isSystem:        r.is_system === true,
        })),
        cases: casesRes.rows.map(r => ({
          id: r.id,
          firNo: r.fir_no || undefined,
          itemType: r.item_type,
          itemSub: r.item_sub || '',
          section: r.section,
          status: r.status,
          seizingOfficer: r.seizing_officer || '',
          itemId: r.item_id || '',
          imageUrl: r.image_url || undefined,
          imageAutoGenerated: r.image_auto_generated || false,
          skipAutoImage: r.skip_auto_image || false,
          docRef: r.doc_ref || undefined,
          legalSection:      r.legal_section || undefined,        // "101" (no "BNS " prefix on the wire)
          legalSectionTitle: r.legal_section_title || undefined,  // "Murder"
          legalSections:      parseJsonArray(r.legal_sections),   // string[] of section_no
          legalSectionsTitles: parseJsonArray(r.legal_sections_titles), // string[] of titles (parallel)
          itemTypeId:       r.item_type_id != null ? Number(r.item_type_id) : undefined,
          description:       r.description || undefined,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        // FIR/DD master → keyed by fir_no (lowercased for case-insensitive join).
        // `firDate` is displayed in the register's "FIR Date" column.  For DD
        // records we fall back to dd_date so the column is never empty.
        firMaster: fmRes.rows.map(r => ({
          firNo: r.fir_no,
          firDate: r.fir_date || r.dd_date || null,
          recordType: r.record_type || 'FIR',
          usSections: r.us_sections || null,
        })),
        // case_property → keyed by item_id (lowercased).  `receivedBy` is the
        // Malkhana Moharrir who received the item (register column).
        caseProperty: cpRes.rows
          .filter(r => r.item_id)
          .map(r => ({ itemId: r.item_id, receivedBy: r.received_by || null })),
        movements: movRes.rows.map(r => ({
          id: Number(r.id),
          caseId: r.case_id,
          fromLocation: r.from_location,
          toLocation: r.to_location,
          movedBy: r.moved_by,
          purpose: r.purpose || '',
          docRef: r.doc_ref || '',
          status: r.status || null,
          timestamp: new Date(r.ts).toISOString(),
        })),
        alertConfig: kv.alertConfig || { fslDays: 30, expertDays: 15, courtDays: 30, inspectionCycleDays: 90, lastInspection: '2026-04-05' },
        alertIssues: kv.alertIssues || [],
        // Daily Google Drive backup log (sibling session).  In-memory + a
        // single row in the `kv` table under key='backupLog'.  Capped to
        // 100 entries in the server.js appendBackupLog() helper.
        backupLog: kv.backupLog || [],
        // Per-item-type case count: how many cases currently point at
        // each type id.  Drives the "N cases" badge in the form builder
        // and the soft-delete guard (can't deactivate a type still in use).
        extraCasesForAlerts: [],
        extraMovements: [],
      };
      // Compute caseCount for each item type from the loaded cases.
      for (const c of _mirror.cases) {
        if (c.itemTypeId != null) {
          const it = _mirror.itemTypes.find(t => t.id === c.itemTypeId);
          if (it) it.caseCount = (it.caseCount || 0) + 1;
        }
      }
      return _mirror;
    } finally {
      client.release();
      _loading = null;
    }
  })();
  return _loading;
}

// Synchronous accessor — returns the current in-memory mirror.  Callers
// MUST await boot() first; this is a hard pre-condition enforced at the
// Synchronous mirror accessor.  We block on the first load at boot (via
// the exported `boot()` function in server.js) so route handlers can use
// the JSON-store-style `const db = getDb(); db.cases` access pattern that
// the rest of server.js expects.  After boot, the in-memory mirror is the
// source of truth; mutate() refreshes it transactionally.
//
// If the mirror is null (e.g. mutate() just invalidated it and another
// request slipped in between), we synchronously wait for the load.  This
// shouldn't normally happen because mutate() re-loads before returning,
// but it costs nothing to guard.
let _waiters = [];
export function getDb() {
  if (_mirror) return _mirror;
  // Cold-start race on Vercel: the module-load IIFE in server.js kicks
  // off bootStore() but the first request can land before it finishes.
  // Throw with the actual boot error (if we already know it) so the user
  // sees the REAL reason instead of a generic "before boot()" message.
  if (_bootError) {
    const e = _bootError;
    const detail = e.message || (e.error && e.error.message) || e.toString?.() || String(e);
    const code = e.code || e.error?.code || '';
    throw new Error(`store.getDb() — boot failed earlier: ${detail}${code ? ` (code=${code})` : ''}`);
  }
  throw new Error('store.getDb() called before boot() — boot still in progress (cold start). Retry in 1-2s.');
}

// Block until the mirror is loaded.  Call this once at server start (before
// app.listen).  On Vercel, wrap with await before any handler runs.
let _bootError = null;
export async function boot() {
  try {
    await loadMirror();
    return _mirror;
  } catch (e) {
    _bootError = e;
    throw e;
  }
}

// Defence-in-depth for Express middleware that runs SYNCHRONOUSLY before
// any await point.  On Vercel serverless, the boot IIFE in server.js can
// call `mutate()` AFTER boot() resolves (backfillImages /
// rebuildSectionCountsIn / scanAlerts); if any of those fail, mutate()'s
// rollback path does `_mirror = null` (store.js:422).  The request that
// just awaited bootOnce() in api/index.js then calls getDb() and gets a
// fresh null.  `ensureBoot()` re-runs loadMirror() if the mirror was
// nuked, so every route handler is safe regardless of IIFE side effects.
export async function ensureBoot() {
  if (_mirror) return _mirror;
  // Cold start (or post-rollback): wait for the next load to finish.
  return await boot();
}

// ---------- mutate() with snapshot diff + transactional write ----------

function rowsById(arr) {
  // For `cases` and `movements` and `auditLog`, identity = `id`.
  // For `sections`, identity = `letter`.
  const m = new Map();
  for (const x of arr || []) m.set(x.id ?? x.letter, x);
  return m;
}

function diffById(prevArr, nextArr, idKey) {
  // Returns { inserted, updated, deleted }.
  const prev = rowsById(prevArr);
  const next = rowsById(nextArr);
  const inserted = [], updated = [], deleted = [];
  for (const [k, v] of next) {
    if (!prev.has(k)) inserted.push(v);
    else {
      const p = prev.get(k);
      if (JSON.stringify(p) !== JSON.stringify(v)) updated.push(v);
    }
  }
  for (const [k, v] of prev) {
    if (!next.has(k)) deleted.push(v);
  }
  return { inserted, updated, deleted };
}

async function persistDiff(client, pre, post) {
  // 1. Singleton kvs: meta, officer, alertConfig, alertIssues, backupLog
  for (const k of ['meta', 'officer', 'alertConfig', 'alertIssues', 'backupLog']) {
    if (JSON.stringify(pre[k]) !== JSON.stringify(post[k])) {
      await client.query(
        `INSERT INTO kv (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, JSON.stringify(post[k])]
      );
    }
  }

  // 2. Users
  {
    const { inserted, updated, deleted } = diffById(pre.users, post.users);
    for (const u of inserted) {
      await client.query(
        `INSERT INTO users (id, initials, name, rank, designation, station, password)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [u.id, u.initials, u.name, u.rank || null, u.designation || null, u.station || null, u.password || null]
      );
    }
    for (const u of updated) {
      await client.query(
        `UPDATE users SET initials=$2, name=$3, rank=$4, designation=$5, station=$6, password=$7
         WHERE id=$1`,
        [u.id, u.initials, u.name, u.rank || null, u.designation || null, u.station || null, u.password || null]
      );
    }
    for (const u of deleted) {
      await client.query(`DELETE FROM users WHERE id=$1`, [u.id]);
    }
  }

  // 3. Sections (id key = letter)
  {
    const prev = (pre.sections || []).map(s => ({ ...s }));
    const next = (post.sections || []).map(s => ({ ...s }));
    const { inserted, updated, deleted } = diffById(prev, next);
    for (const s of inserted) {
      await client.query(
        `INSERT INTO sections (letter, name, count, active, sort_order) VALUES ($1,$2,$3,$4,$5)`,
        [s.letter, s.name, s.count || 0, s.active !== false, s.sortOrder || 0]
      );
    }
    for (const s of updated) {
      await client.query(
        `UPDATE sections SET name=$2, count=$3, active=$4, sort_order=$5 WHERE letter=$1`,
        [s.letter, s.name, s.count || 0, s.active !== false, s.sortOrder || 0]
      );
    }
    for (const s of deleted) {
      await client.query(`DELETE FROM sections WHERE letter=$1`, [s.letter]);
    }
  }

  // 3b. Item Types (id key = id)
  {
    const { inserted, updated, deleted } = diffById(pre.itemTypes || [], post.itemTypes || [], 'id');
    for (const t of inserted) {
      await client.query(
        `INSERT INTO item_types (id, section_letter, name, sort_order, active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [t.id, t.sectionLetter, t.name, t.sortOrder || 0, t.active !== false]
      );
    }
    for (const t of updated) {
      await client.query(
        `UPDATE item_types SET section_letter=$2, name=$3, sort_order=$4, active=$5
         WHERE id=$1`,
        [t.id, t.sectionLetter, t.name, t.sortOrder || 0, t.active !== false]
      );
    }
    for (const t of deleted) {
      // Soft guard: the API refuses to deactivate types that still have
      // cases, but if a delete slipped through we hard-remove (FK
      // ON DELETE is RESTRICT-free here — we null the case link first
      // in the manager to avoid orphan rows).
      await client.query('DELETE FROM item_types WHERE id=$1', [t.id]);
    }
  }

  // 3c. Movement Types (id key = id).  Admin-editable vocabulary
  // that drives the Change Status dropdown + Register filter +
  // status PATCH validation.  The is_system flag is preserved on
  // UPDATE; the API layer refuses to DELETE a row where is_system
  // = TRUE.
  {
    const preMT  = (pre.movementTypes || []).map(t => ({ ...t, next: t.next || [] }));
    const postMT = (post.movementTypes || []).map(t => ({ ...t, next: t.next || [] }));
    const { inserted, updated, deleted } = diffById(preMT, postMT, 'id');
    for (const m of inserted) {
      await client.query(
        `INSERT INTO movement_types
           (id, name, default_location, default_purpose, "next", sort_order, active, is_system)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [m.id, m.name,
         m.defaultLocation || '', m.defaultPurpose || '',
         JSON.stringify(m.next || []),
         m.sortOrder || 0, m.active !== false, !!m.isSystem]
      );
    }
    for (const m of updated) {
      await client.query(
        `UPDATE movement_types
            SET name=$2, default_location=$3, default_purpose=$4,
                "next"=$5::jsonb, sort_order=$6, active=$7
          WHERE id=$1`,
        [m.id, m.name,
         m.defaultLocation || '', m.defaultPurpose || '',
         JSON.stringify(m.next || []),
         m.sortOrder || 0, m.active !== false]
      );
    }
    for (const m of deleted) {
      // API layer already blocks deletes of in-use or is_system rows.
      await client.query('DELETE FROM movement_types WHERE id=$1', [m.id]);
    }
  }

  // 4. Cases
  {
    const { inserted, updated, deleted } = diffById(pre.cases, post.cases);
    for (const c of inserted) {
      await client.query(
        `INSERT INTO cases (id, item_type, item_sub, section, status,
                            seizing_officer, seized_on, item_id,
                            image_url, image_auto_generated, skip_auto_image,
                            doc_ref, legal_section, legal_section_title,
                            legal_sections, legal_sections_titles,
                            item_type_id, description, fir_no, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [c.id, c.itemType, c.itemSub || '', c.section, c.status,
         c.seizingOfficer || null, c.seizedOn || null, c.itemId || null,
         c.imageUrl || null, !!c.imageAutoGenerated, !!c.skipAutoImage,
         c.docRef || null,
         c.legalSection || null, c.legalSectionTitle || null,
         JSON.stringify(c.legalSections || []), JSON.stringify(c.legalSectionsTitles || []),
         c.itemTypeId != null ? c.itemTypeId : null, c.description || null,
         c.firNo || null, c.createdAt || new Date().toISOString()]
      );
    }
    for (const c of updated) {
      await client.query(
        `UPDATE cases SET item_type=$2, item_sub=$3, section=$4, status=$5,
                          seizing_officer=$6, item_id=$7,
                          image_url=$8, image_auto_generated=$9, skip_auto_image=$10,
                          doc_ref=$11, legal_section=$12, legal_section_title=$13,
                          legal_sections=$17, legal_sections_titles=$18,
                          item_type_id=$14, description=$15, fir_no=$16
         WHERE id=$1`,
        [c.id, c.itemType, c.itemSub || '', c.section, c.status,
         c.seizingOfficer || null, c.itemId || null,
         c.imageUrl || null, !!c.imageAutoGenerated, !!c.skipAutoImage,
         c.docRef || null,
         c.legalSection || null, c.legalSectionTitle || null,
         c.itemTypeId != null ? c.itemTypeId : null, c.description || null,
         c.firNo || null,
         JSON.stringify(c.legalSections || []), JSON.stringify(c.legalSectionsTitles || [])]
      );
    }
    for (const c of deleted) {
      await client.query(`DELETE FROM cases WHERE id=$1`, [c.id]);
    }
  }

  // 5. Movements (append-only, but we still diff in case of corrections)
  {
    const { inserted, updated, deleted } = diffById(pre.movements, post.movements);
    for (const m of inserted) {
      // If the caller supplied an id, respect it (legacy code does this);
      // otherwise let the BIGSERIAL pick the next value.
      if (m.id != null) {
        await client.query(
          `INSERT INTO movements (id, case_id, from_location, to_location, moved_by, purpose, doc_ref, status, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING`,
          [m.id, m.caseId, m.fromLocation, m.toLocation, m.movedBy, m.purpose || null, m.docRef || null,
           m.status || null,
           m.timestamp || new Date().toISOString()]
        );
      } else {
        await client.query(
          `INSERT INTO movements (case_id, from_location, to_location, moved_by, purpose, doc_ref, status, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [m.caseId, m.fromLocation, m.toLocation, m.movedBy, m.purpose || null, m.docRef || null,
           m.status || null,
           m.timestamp || new Date().toISOString()]
        );
      }
      // Keep the sequence in sync so nextMovementId() returns a free id.
      await client.query(
        "SELECT setval(pg_get_serial_sequence('movements','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM movements), 1))"
      );
    }
    for (const m of updated) {
      await client.query(
        `UPDATE movements SET case_id=$2, from_location=$3, to_location=$4,
                             moved_by=$5, purpose=$6, doc_ref=$7, status=$8, ts=$9
         WHERE id=$1`,
        [m.id, m.caseId, m.fromLocation, m.toLocation, m.movedBy, m.purpose || null, m.docRef || null,
         m.status || null,
         m.timestamp || new Date().toISOString()]
      );
    }
    for (const m of deleted) {
      await client.query(`DELETE FROM movements WHERE id=$1`, [m.id]);
    }
  }

  // 6. Audit log — INSERT only (append-only invariant).  We diff to skip
  // no-ops and to handle the (very rare) case where a caller overwrites an
  // existing entry.
  {
    const { inserted, updated, deleted } = diffById(pre.auditLog, post.auditLog);
    for (const a of inserted) {
      if (a.id != null) {
        await client.query(
          `INSERT INTO audit_log (id, ts, user_id, user_name, action, target, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.timestamp || new Date().toISOString(), a.userId || 'anonymous',
           a.userName || '—', a.action || 'unknown', a.target || '', a.details || '']
        );
      } else {
        await client.query(
          `INSERT INTO audit_log (ts, user_id, user_name, action, target, details)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [a.timestamp || new Date().toISOString(), a.userId || 'anonymous',
           a.userName || '—', a.action || 'unknown', a.target || '', a.details || '']
        );
      }
    }
    for (const a of updated) {
      await client.query(
        `UPDATE audit_log SET ts=$2, user_id=$3, user_name=$4, action=$5, target=$6, details=$7
         WHERE id=$1`,
        [a.id, a.timestamp || new Date().toISOString(), a.userId || 'anonymous',
         a.userName || '—', a.action || 'unknown', a.target || '', a.details || '']
      );
    }
    for (const a of deleted) {
      await client.query(`DELETE FROM audit_log WHERE id=$1`, [a.id]);
    }
  }
}

export async function mutate(fn) {
  await ensureReady();
  // Serialise: only one mutate at a time per process.
  let release;
  const slot = new Promise(r => { release = r; });
  const prev = _writeQueue;
  _writeQueue = prev.then(() => slot);
  await prev;
  try {
    // Reuse the in-memory mirror if it's loaded — no need to nuke it
    // and re-load, which would expose a window where getDb() throws for
    // concurrent requests.  The diff is computed from a deep copy of
    // the live mirror (preCopy) against the mutated version.
    let pre = _mirror;
    if (!pre) pre = await loadMirror();
    const preCopy = deepCopy(pre);
    // Pass the live mirror to fn — callers push/splice/set on it, which
    // mutates the in-memory object in place.
    const result = fn(pre);
    // Persist the diff.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await persistDiff(client, preCopy, pre);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      // Roll back the in-memory mutation by reloading.
      _mirror = null;
      throw e;
    } finally {
      client.release();
    }
    return result;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------
// syncRegistrationMirrors
// ---------------------------------------------------------------
// After a case is registered we write case_property (receivedBy, …) and
// fir_master (firDate, …) via direct SQL upserts.  Those tables are NOT
// part of mutate()'s diff/persist pass, so the in-memory mirror's
// `caseProperty` / `firMaster` slices go STALE for the freshly-registered
// item.  decorateCaseRow() joins Received-By and FIR-Date from those mirror
// slices, so a brand-new item would otherwise show blank Received-By /
// blank FIR-Date in the upper case-detail box until the next process
// restart — even though the values were entered at registration.
//
// This helper re-reads the just-written rows from Postgres and patches the
// live mirror so the very next GET reflects registration exactly.  Safe to
// call even if the mirror is null (it no-ops then).
export async function syncRegistrationMirrors(itemId, firNo) {
  if (!_mirror) return;
  try {
    if (itemId) {
      const cp = await getCaseProperty(itemId);
      if (cp) {
        const i = _mirror.caseProperty.findIndex(
          p => p.itemId && p.itemId.toLowerCase() === String(itemId).toLowerCase()
        );
        const row = { itemId: cp.itemId, receivedBy: cp.receivedBy || null };
        if (i >= 0) _mirror.caseProperty[i] = row;
        else _mirror.caseProperty.push(row);
      }
    }
    if (firNo) {
      const fm = await getFirMaster(firNo);
      if (fm) {
        const key = String(firNo).toLowerCase();
        const i = _mirror.firMaster.findIndex(
          f => f.firNo && f.firNo.toLowerCase() === key
        );
        const row = {
          firNo: fm.firNo,
          firDate: fm.firDate || fm.ddDate || null,
          recordType: fm.recordType || 'FIR',
          usSections: fm.usSections || null,
        };
        if (i >= 0) _mirror.firMaster[i] = row;
        else _mirror.firMaster.push(row);
      }
    }
  } catch {
    // Mirror refresh is best-effort; a failure here must not fail the
    // registration that already succeeded in Postgres.
  }
}

// ---------- direct SQL helpers ----------

export async function appendAudit(entry) {
  await ensureReady();
  const ts = new Date().toISOString();
  const row = {
    id:        ((_mirror?.auditLog || []).at(-1)?.id ?? 0) + 1,
    timestamp: ts,
    userId:    entry.userId    ?? 'anonymous',
    userName:  entry.userName  ?? '—',
    action:    entry.action    ?? 'unknown',
    target:    entry.target    ?? '',
    details:   entry.details   ?? '',
  };
  const client = await pool.connect();
  try {
    // Use the BIGSERIAL to get a durable id; then sync the mirror so the
    // in-process snapshot shows the new entry.
    const { rows } = await client.query(
      `INSERT INTO audit_log (ts, user_id, user_name, action, target, details)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ts, row.userId, row.userName, row.action, row.target, row.details]
    );
    row.id = Number(rows[0].id);
    if (_mirror) {
      if (!_mirror.auditLog) _mirror.auditLog = [];
      _mirror.auditLog.push(row);
    }
    process.stderr.write(`[audit] #${row.id}  ${row.userId}  ${row.action}  ${row.target}\n`);
    return row;
  } finally {
    client.release();
  }
}

export async function getCase(id) {
  await ensureReady();
  // Fast path: mirror lookup
  if (_mirror) {
    return _mirror.cases.find(c => c.id === id)
        || (_mirror.extraCasesForAlerts || []).find(c => c.id === id);
  }
  // Fallback: SQL
  const { rows } = await pool.query(
    `SELECT id, item_type, item_sub, section, status,
            seizing_officer, item_id,
            image_url, image_auto_generated, skip_auto_image,
            doc_ref, created_at
     FROM cases WHERE id = $1`,
    [id]
  );
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    id: r.id, itemType: r.item_type, itemSub: r.item_sub || '',
    section: r.section, status: r.status,
    seizingOfficer: r.seizing_officer || '', itemId: r.item_id || '',
    imageUrl: r.image_url || undefined,
    imageAutoGenerated: r.image_auto_generated || false,
    skipAutoImage: r.skip_auto_image || false,
    docRef: r.doc_ref || undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// Look up a case by its Malkhana Sr. No. (item_id, e.g. "MK-2026-000500").
// The /api/case-property endpoints are keyed by item_id, NOT by the FIR id,
// so this is the correct lookup for them.  Without it the handler matches
// against the FIR id and throws 404 "unknown item" for a perfectly valid item.
export async function getCaseByItemId(itemId) {
  await ensureReady();
  if (_mirror) {
    return _mirror.cases.find(c => c.itemId === itemId)
        || (_mirror.extraCasesForAlerts || []).find(c => c.itemId === itemId);
  }
  const { rows } = await pool.query(
    `SELECT id, item_type, item_sub, section, status,
            seizing_officer, item_id,
            image_url, image_auto_generated, skip_auto_image,
            doc_ref, created_at
     FROM cases WHERE item_id = $1`,
    [itemId]
  );
  if (!rows.length) return undefined;
  const r = rows[0];
  return {
    id: r.id, itemType: r.item_type, itemSub: r.item_sub || '',
    section: r.section, status: r.status,
    seizingOfficer: r.seizing_officer || '', itemId: r.item_id || '',
    imageUrl: r.image_url || undefined,
    imageAutoGenerated: r.image_auto_generated || false,
    skipAutoImage: r.skip_auto_image || false,
    docRef: r.doc_ref || undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function getMovements(caseId) {
  await ensureReady();
  if (_mirror) {
    return _mirror.movements
      .filter(m => m.caseId === caseId)
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  const { rows } = await pool.query(
    `SELECT id, case_id, from_location, to_location, moved_by, purpose, doc_ref, ts
     FROM movements WHERE case_id = $1 ORDER BY ts, id`,
    [caseId]
  );
  return rows.map(r => ({
    id: Number(r.id), caseId: r.case_id,
    fromLocation: r.from_location, toLocation: r.to_location, movedBy: r.moved_by,
    purpose: r.purpose || '', docRef: r.doc_ref || '',
    status: r.status || null,
    timestamp: new Date(r.ts).toISOString(),
  }));
}

export async function nextMovementId() {
  await ensureReady();
  // Atomic: SELECT nextval from the movements sequence.
  const { rows } = await pool.query(
    "SELECT nextval(pg_get_serial_sequence('movements','id')) AS id"
  );
  // NOTE: this consumes a sequence value.  The matching INSERT in mutate()
  // either uses this id (if the caller attached it to the new row before
  // persisting) or lets BIGSERIAL default.  To avoid wasting sequence
  // values we DO use the returned id for the next movement.
  return Number(rows[0].id);
}

// Next unique Malkhana Sr. No. (Register Entry No.), e.g. MK-2026-000521.
// Computed as MAX(numeric part of existing item_id) + 1 from the `cases`
// table.  This is deterministic and self-healing on ANY database state
// (no dependency on a sequence that may have been advanced/corrupted by
// another instance) and never produces collisions — even when several
// items are registered under one FIR.  A process-local guard syncs once
// per cold start; concurrency across instances is negligible at this scale.
let _seqMax = 0;
let _seqReady = false;
export async function nextMalkhanaSeq() {
  await ensureReady();
  if (!_seqReady) {
    const { rows } = await pool.query(
      `SELECT COALESCE(MAX((regexp_match(item_id, 'MK-[0-9]{4}-([0-9]+)'))[1]::int), 0) AS m
       FROM cases WHERE item_id ~ '^MK-[0-9]{4}-[0-9]+$'`
    );
    _seqMax = Number(rows[0]?.m || 0);
    _seqReady = true;
  }
  _seqMax += 1;
  return _seqMax;
}

export function formatMalkhanaSrNo(n) {
  const y = new Date().getFullYear();
  return `MK-${y}-${String(n).padStart(6, '0')}`;
}

// Kept for backward-compat with boot wiring; now a harmless no-op (the
// sequence table still exists but Sr. No. generation uses nextMalkhanaSeq
// which reads MAX(item_id) instead).
export async function syncMalkhanaSeq() { /* no-op */ }

export async function rebuildSectionCounts() {
  await ensureReady();
  await mutate(d => {
    for (const s of d.sections) s.count = 0;
    for (const c of [...d.cases, ...(d.extraCasesForAlerts || [])]) {
      const m = c.section?.match(/PART ([A-Z]{1,2})/);
      if (m) {
        const s = d.sections.find(x => x.letter === m[1]);
        if (s) s.count += 1;
      }
    }
  });
}
