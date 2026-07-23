// Daily e-Malkhana backup — uploads a gzipped pg_dump of the live Postgres
// database to Google Drive as `backup-YYYY-MM-DD-HHMM.sql.gz`.
//
// Transport: Google Drive (rclone + Google account OAuth).
//   - No service-account JSON key required (the GCP org policy blocks those).
//   - rclone stores the OAuth token locally; the backup script just pipes
//     pg_dump | gzip | rclone rcat straight to Drive.
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
// Schedule: Windows Task Scheduler → daily 02:00 (see docs/BACKUP_DAILY.md).
//
// Env (read from process.env; server.js passes DATABASE_URL + retention):
//   DATABASE_URL              Neon/Postgres connection string (required)
//   GDRIVE_REMOTE             rclone remote:path (default: "gdrive:e-Malkhana Backups")
//   GDRIVE_FOLDER_URL         human-facing Drive URL (for the status page)
//   GDRIVE_ACCOUNT            Google account email that owns the backups
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

// --- locate rclone + pg_dump (Windows-aware) ---
function locateExe(name) {
  const candidates = name === 'rclone'
    ? [
        join(process.env.USERPROFILE || process.env.HOME || '', 'bin', 'rclone-v1.74.4-windows-amd64', 'rclone.exe'),
        'C:\\Program Files\\rclone\\rclone.exe',
        'C:\\ProgramData\\chocolatey\\bin\\rclone.exe',
        '/usr/bin/rclone',
      ]
    : [
        'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
        'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
        'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
        'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
        '/usr/bin/pg_dump',
      ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch { /* bad path */ }
  }
  return null;
}

const RCLONE_BIN = locateExe('rclone');
const PG_DUMP_BIN = locateExe('pg_dump');
if (!RCLONE_BIN) fail('rclone not found — install to ~/bin/rclone-*-windows-amd64/');
if (!PG_DUMP_BIN) fail('pg_dump not found — install PostgreSQL client');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is not set');

const REMOTE        = process.env.GDRIVE_REMOTE  || 'gdrive:e-Malkhana Backups';
const FOLDER_URL    = process.env.GDRIVE_FOLDER_URL || 'https://drive.google.com/drive/folders/1gcQEnhcF9cXCYnURwYDnJt6mTzt2Ur2b';
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
  try { cur = JSON.parse(readFileSync(STATUS_FILE, 'utf8')); }
  catch { /* fresh file */ }
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
console.log(`  source:   Neon Postgres`);
console.log(`  target:   ${REMOTE}/${fileName}`);
console.log(`  account:  ${ACCOUNT}`);
console.log(`  retain:   ${RETENTION} days`);

appendStatus({
  status: 'running',
  transport: 'drive',
  timestamp: startedAt.toISOString(),
  fileName: '',
});

let pgOut, pgErr, code;
try {
  // pg_dump | gzip | rclone rcat  (single pipeline, no temp file)
  const pg = spawnSync(PG_DUMP_BIN, [
    '--no-owner', '--no-acl',
    '--schema=public',
    '--dbname=' + DATABASE_URL,
  ], { encoding: 'buffer' });
  if (pg.status !== 0) {
    pgOut = pg.stdout; pgErr = pg.stderr; code = pg.status;
    throw new Error(`pg_dump failed (exit ${code}): ${(pgErr || pgOut || '').toString().slice(0, 400)}`);
  }
  // gzip from buffer → buffer (no native gzip on Windows; use Node's zlib)
  const gz = gzipSync(pg.stdout, { level: 9 });

  const rc = spawnSync(RCLONE_BIN, ['rcat', `${REMOTE}/${fileName}`], {
    input: gz,
    encoding: 'buffer',
  });
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
const sizeBytes = existsSync(STATUS_FILE) ? null : null; // streamed, no local file

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
});

console.log(`✓ uploaded: ${fileName}`);
console.log(`  link:     ${FOLDER_URL}`);

// --- prune older files in Drive ---
console.log(`▶ pruning files older than ${RETENTION} days...`);
const prune = spawnSync(RCLONE_BIN, [
  'delete', `${REMOTE}/`,
  '--min-age', `${RETENTION}d`,
  '--include', 'backup-*.sql.gz',
  '--drive-use-trash=false',
], { encoding: 'utf8' });
if (prune.status === 0) console.log('✓ prune complete');

console.log(`✓ backup complete: ${fileName}`);