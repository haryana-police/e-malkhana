// Daily e-Malkhana backup — uploads a gzipped SQL dump of the live Postgres
// database to Google Drive as `backup-YYYY-MM-DD-HHMM.sql.gz`.
//
// Transport: Google Drive (rclone + Google account OAuth).
//   - No service-account JSON key required (the GCP org policy blocks those).
//   - rclone config is provided via the RCLONE_CONFIG_BASE64 env var
//     (base64 of an rclone.conf) so it works on Vercel serverless too —
//     set RCLONE_CONFIG_BASE64 and bundle rclone via server/bin/rclone.
//
// Dual dump strategy (so the SAME script runs everywhere):
//   - On the operator laptop: uses `pg_dump` (fast, full fidelity) piped
//     straight to Drive via rclone rcat.
//   - On Vercel serverless: no pg_dump binary, so it does a pure-SQL dump
//     using the @neondatabase/serverless pool (tables + COPY-style rows).
//     Restorable with: psql -f backup.sql (schema + INSERTs).
//
// Retention: 10 days by default; older files are pruned from the Drive folder.
//
// This script also writes a status JSON file the server reads at
// GET /api/backups/status so the admin "Backup & Restore" page shows the
// real Drive state (file names, timestamps, sizes) instead of guessing.
//
// Run manually:
//   node server/scripts/backup-to-drive.js
//   bash  server/scripts/backup-to-drive.sh
//
// Schedule: Windows Task Scheduler → daily 14:10 (see docs/BACKUP_DAILY.md).
//           On Vercel, trigger from the admin page "Run backup now" or an
//           external cron (e.g. UptimeRobot ping) — the script itself runs
//           fully inside the serverless function.
//
// Env (read from process.env; server.js passes DATABASE_URL + retention):
//   DATABASE_URL              Neon/Postgres connection string (required)
//   GDRIVE_REMOTE             rclone remote:path (default: "gdrive:e-Malkhana Backups")
//   GDRIVE_FOLDER_ID          Drive folder ID (fallback if remote unknown)
//   GDRIVE_FOLDER_URL         human-facing Drive URL (for the status page)
//   GDRIVE_ACCOUNT            Google account email that owns the backups
//   RCLONE_CONFIG_BASE64      base64 of rclone.conf (for serverless auth)
//   BACKUP_RETENTION_DAYS     prune age in days (default 10)
//   BACKUP_STATUS_FILE        where to write the status JSON
//                             (default: <repo>/server/data/backup-status.json)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..', '..');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

const IS_VERCEL = !!process.env.VERCEL;

// --- locate rclone (bundled at server/bin/rclone on Vercel, local elsewhere) ---
function locateRclone() {
  const candidates = [
    join(__dirname, '..', 'bin', 'rclone'),                         // bundled (Vercel/Linux)
    join(__dirname, '..', 'bin', 'rclone.exe'),                     // bundled (Windows)
    join(process.env.USERPROFILE || process.env.HOME || '', 'bin', 'rclone-v1.74.4-windows-amd64', 'rclone.exe'),
    '/usr/local/bin/rclone',
    '/usr/bin/rclone',
    'C:\\Program Files\\rclone\\rclone.exe',
    process.env.RCLONE_BIN || '',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch { /* bad path */ }
  }
  return null;
}

// --- locate pg_dump (laptop only; not on Vercel) ---
function locatePgDump() {
  const candidates = [
    'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
    'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
    '/usr/bin/pg_dump',
    '/usr/local/bin/pg_dump',
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch { /* bad path */ }
  }
  return null;
}

const RCLONE_BIN = locateRclone();
const DATABASE_URL = process.env.DATABASE_URL;

if (!RCLONE_BIN) fail('rclone not found — expected at server/bin/rclone (Vercel) or ~/bin/rclone-*-windows-amd64/ (laptop)');
if (!DATABASE_URL) fail('DATABASE_URL is not set');

// If RCLONE_CONFIG_BASE64 is set, write it to a temp config file so rclone
// can pick it up on serverless (where we can't persist to ~/.config).
let RCLONE_CONFIG_ARG = [];
if (process.env.RCLONE_CONFIG_BASE64) {
  const tmp = join(__dirname, '..', 'data', '.rclone-gdrive.conf');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, Buffer.from(process.env.RCLONE_CONFIG_BASE64, 'base64'), 'utf8');
  RCLONE_CONFIG_ARG = ['--config', tmp];
}

const REMOTE        = process.env.GDRIVE_REMOTE  || 'gdrive:e-Malkhana Backups';
const FOLDER_URL    = process.env.GDRIVE_FOLDER_URL || 'https://drive.google.com/drive/folders/1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b';
const FOLDER_ID     = process.env.GDRIVE_FOLDER_ID || '1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b';
const ACCOUNT       = process.env.GDRIVE_ACCOUNT  || 'asppanipat01@gmail.com';
const RETENTION     = parseInt(process.env.BACKUP_RETENTION_DAYS || '10', 10);
const STATUS_FILE   = process.env.BACKUP_STATUS_FILE
  || join(ROOT, 'server', 'data', 'backup-status.json');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function appendStatus(entry) {
  let cur = { runs: [] };
  try { cur = JSON.parse(readFileSync(STATUS_FILE, 'utf8')); } catch { /* fresh file */ }
  const id = (cur.runs.at(-1)?.id ?? 0) + 1;
  cur.runs.push({ id, ...entry });
  if (cur.runs.length > 50) cur.runs.splice(0, cur.runs.length - 50);
  cur.last = cur.runs.at(-1);
  cur.lastSuccess = [...cur.runs].reverse().find(r => r.status === 'success') || null;
  cur.lastFailed  = [...cur.runs].reverse().find(r => r.status === 'failed')  || null;
  mkdirSync(dirname(STATUS_FILE), { recursive: true });
  writeFileSync(STATUS_FILE, JSON.stringify(cur, null, 2), 'utf8');
}

const startedAt = new Date();
const fileName = `backup-${ts()}.sql.gz`;
console.log('▶ e-Malkhana → Google Drive backup');
console.log(`  environment: ${IS_VERCEL ? 'Vercel serverless' : 'local'}`);
console.log(`  target:      ${REMOTE}/${fileName}`);
console.log(`  account:     ${ACCOUNT}`);
console.log(`  retain:      ${RETENTION} days`);

appendStatus({
  status: 'running',
  transport: 'drive',
  timestamp: startedAt.toISOString(),
  fileName: '',
});

// Decide dump method: pg_dump if available (laptop), else SQL dump (Vercel).
const PG_DUMP_BIN = locatePgDump();
const usePgDump = !!PG_DUMP_BIN && !IS_VERCEL;

let sqlDumpBuffer;
try {
  if (usePgDump) {
    console.log('  method:     pg_dump | gzip | rclone rcat');
    const pg = spawnSync(PG_DUMP_BIN, [
      '--no-owner', '--no-acl',
      '--schema=public',
      '--dbname=' + DATABASE_URL,
    ], { encoding: 'buffer' });
    if (pg.status !== 0) {
      throw new Error(`pg_dump failed (exit ${pg.status}): ${(pg.stderr || pg.stdout || '').toString().slice(0, 400)}`);
    }
    sqlDumpBuffer = gzipSync(pg.stdout, { level: 9 });
  } else {
    console.log('  method:     SQL dump via @neondatabase/serverless | gzip | rclone rcat');
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(DATABASE_URL, { fetchConnectionCache: true });
    const dump = await buildSqlDump(sql);
    sqlDumpBuffer = gzipSync(Buffer.from(dump, 'utf8'), { level: 9 });
  }

  // Stream to Drive
  const rc = spawnSync(RCLONE_BIN, [
    ...RCLONE_CONFIG_ARG,
    'rcat', `${REMOTE}/${fileName}`,
  ], { input: sqlDumpBuffer, encoding: 'buffer' });
  if (rc.status !== 0) {
    throw new Error(`rclone rcat failed (exit ${rc.status}): ${rc.stderr.toString().slice(0, 400)}`);
  }
} catch (e) {
  appendStatus({
    status: 'failed',
    transport: 'drive',
    timestamp: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    fileName: '',
    durationMs: Date.now() - startedAt.getTime(),
    error: e.message,
  });
  fail(e.message);
}

const finishedAt = new Date();

appendStatus({
  status: 'success',
  transport: 'drive',
  timestamp: finishedAt.toISOString(),
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  fileName,
  fileUrl: `${FOLDER_URL.replace(/\/$/, '')}/${fileName}`,
  folderUrl: FOLDER_URL,
  account: ACCOUNT,
  remote: REMOTE,
  retentionDays: RETENTION,
  durationMs: finishedAt - startedAt,
  method: usePgDump ? 'pg_dump' : 'sql',
});

console.log(`✓ uploaded: ${fileName}`);
console.log(`  link:     ${FOLDER_URL}`);

// --- prune older files in Drive ---
console.log(`▶ pruning files older than ${RETENTION} days...`);
const prune = spawnSync(RCLONE_BIN, [
  ...RCLONE_CONFIG_ARG,
  'delete', `${REMOTE}/`,
  '--min-age', `${RETENTION}d`,
  '--include', 'backup-*.sql.gz',
  '--drive-use-trash=false',
], { encoding: 'utf8' });
if (prune.status === 0) console.log('✓ prune complete');

console.log(`✓ backup complete: ${fileName}`);

// =============================================================
// Pure-SQL dump builder (no pg_dump binary needed).
// Produces a restorable .sql: DROP/CREATE TABLE + INSERT statements.
// =============================================================
async function buildSqlDump(sql) {
  const lines = [];
  lines.push('-- e-Malkhana PostgreSQL backup');
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push('-- Source: Neon PostgreSQL (DATABASE_URL)');
  lines.push('-- Restorable with: psql "postgresql://..." -f backup.sql');
  lines.push('');
  lines.push('SET statement_timeout = 0;');
  lines.push('SET client_encoding = \'UTF8\';');
  lines.push('SET standard_conforming_strings = on;');
  lines.push('');

  // List public tables (excluding schema_migrations / _prisma_migrations if present)
  const tablesRes = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const tables = (Array.isArray(tablesRes) ? tablesRes : (tablesRes?.rows || [])).map(r => r.table_name);
  console.log(`  tables: ${tables.length} found`);

  for (const t of tables) {
    // Column definitions
    const colsRes = await sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${t}
      ORDER BY ordinal_position
    `;
    const cols = Array.isArray(colsRes) ? colsRes : (colsRes?.rows || []);
    const colDefs = cols.map(c => {
      let def = `"${c.column_name}" ${mapType(c.data_type)}`;
      if (c.is_nullable === 'NO') def += ' NOT NULL';
      if (c.column_default != null) def += ` DEFAULT ${c.column_default}`;
      return def;
    }).join(', ');

    lines.push(`DROP TABLE IF EXISTS "${t}" CASCADE;`);
    lines.push(`CREATE TABLE "${t}" (${colDefs});`);
    lines.push('');

    // Rows — fetch in pages to avoid huge memory on large tables
    let offset = 0;
    const PAGE = 500;
    let total = 0;
    while (true) {
      const rowsRes = await sql`
        SELECT * FROM ${sql.unsafe(t)} LIMIT ${PAGE} OFFSET ${offset}
      `;
      const rows = Array.isArray(rowsRes) ? rowsRes : (rowsRes?.rows || []);
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const vals = cols.map(c => sqlLiteral(row[c.column_name]));
        lines.push(`INSERT INTO "${t}" (${cols.map(c => `"${c.column_name}"`).join(', ')}) VALUES (${vals.join(', ')});`);
        total++;
      }
      offset += rows.length;
      if (rows.length < PAGE) break;
    }
    console.log(`    ✓ ${t}: ${total} row(s)`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function mapType(dt) {
  // Map Postgres information_schema types to CREATE TABLE types (good enough for dump/reload)
  const m = {
    'character varying': 'TEXT',
    'character': 'TEXT',
    'text': 'TEXT',
    'integer': 'INTEGER',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'numeric': 'NUMERIC',
    'real': 'REAL',
    'double precision': 'DOUBLE PRECISION',
    'boolean': 'BOOLEAN',
    'timestamp without time zone': 'TIMESTAMP',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'date': 'DATE',
    'time without time zone': 'TIME',
    'json': 'JSONB',
    'jsonb': 'JSONB',
    'uuid': 'UUID',
    'bytea': 'BYTEA',
  };
  return m[dt] || 'TEXT';
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
