// Daily Google Drive backup for e-Malkhana db.json
// Run manually:  node server/scripts/backup-to-drive.js
// Or schedule via:
//   - Local:   Windows Task Scheduler (daily 02:00) → "node server/scripts/backup-to-drive.js"
//   - Vercel:  vercel.json crons entry (see project root)
//
// Env (read from .env / .env.local — server is dotenv-aware? if not, this script uses
// a small inline parser; otherwise use process.env directly):
//   GCP_SERVICE_ACCOUNT_JSON   absolute path to the JSON key file
//                              default: server/secrets/gcp-service-account.json
//   GDRIVE_FOLDER_ID           Drive folder ID where backups are written
//                              default: read from .gdrive-folder-id (project root) or env
//   BACKUP_RETENTION_DAYS      how many days of backups to keep on Drive
//                              default: 10
//   DB_PATH                    override the source data file
//                              default: server/data/db.json (or /tmp/data/db.json on Vercel)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..', '..'); // e-malkhana/

// --- config ----------------------------------------------------------------
const IS_VERCEL         = !!process.env.VERCEL;
const KEY_PATH          = process.env.GCP_SERVICE_ACCOUNT_JSON
                       || join(ROOT, 'server', 'secrets', 'gcp-service-account.json');
const FOLDER_ID_FILE    = join(ROOT, '.gdrive-folder-id');
const FOLDER_ID         = process.env.GDRIVE_FOLDER_ID
                       || (existsSync(FOLDER_ID_FILE) ? readFileSync(FOLDER_ID_FILE, 'utf8').trim() : null);
const RETENTION_DAYS    = parseInt(process.env.BACKUP_RETENTION_DAYS || '10', 10);
const DB_PATH           = process.env.DB_PATH
                       || (IS_VERCEL ? '/tmp/data/db.json' : join(ROOT, 'server', 'data', 'db.json'));

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

if (!existsSync(KEY_PATH))  fail(`service account JSON not found at: ${KEY_PATH}`);
if (!FOLDER_ID)             fail('GDRIVE_FOLDER_ID env var (or .gdrive-folder-id file) is required');
if (!existsSync(DB_PATH))   fail(`db.json not found at: ${DB_PATH}`);

// --- build filename like malkhana-backup-2026-07-06-1430.json ---------------
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const fileName = `malkhana-backup-${ts()}.json`;

// --- google auth (service account) -----------------------------------------
const creds   = JSON.parse(readFileSync(KEY_PATH, 'utf8'));
const auth    = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive   = google.drive({ version: 'v3', auth });

async function upload() {
  const data = readFileSync(DB_PATH);
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [FOLDER_ID],
      description: `e-Malkhana db.json backup at ${new Date().toISOString()}`,
    },
    media: { mimeType: 'application/json', body: Buffer.from(data) },
    fields: 'id, name, webViewLink, createdTime, size',
  });
  return res.data;
}

async function pruneOldBackups() {
  // List all files in the folder, parse name → date, delete those older than RETENTION_DAYS.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pageToken = undefined;
  let deleted = 0;
  do {
    const list = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false and mimeType = 'application/json'`,
      fields: 'nextPageToken, files(id, name, createdTime)',
      pageSize: 100,
      pageToken,
    });
    for (const f of list.data.files || []) {
      const m = f.name && f.name.match(/^malkhana-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.json$/);
      if (!m) continue;
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`).getTime();
      if (d < cutoff) {
        await drive.files.delete({ fileId: f.id });
        deleted++;
        console.log(`  pruned ${f.name}  (${f.createdTime})`);
      }
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken);
  return deleted;
}

(async () => {
  try {
    console.log('▶ e-Malkhana → Google Drive backup');
    console.log('  source:  ' + DB_PATH);
    console.log('  target:  drive folder ' + FOLDER_ID);
    console.log('  file:    ' + fileName);
    console.log('  retain:  ' + RETENTION_DAYS + ' days');
    console.log('');

    const up = await upload();
    console.log('✓ uploaded: ' + up.name);
    console.log('  size:     ' + up.size + ' bytes');
    console.log('  link:     ' + up.webViewLink);
    console.log('  created:  ' + up.createdTime);
    console.log('');

    console.log('▶ pruning backups older than ' + RETENTION_DAYS + ' days…');
    const n = await pruneOldBackups();
    console.log('✓ pruned ' + n + ' old backup(s)');
  } catch (e) {
    console.error('✗ backup failed:', e.message);
    process.exit(1);
  }
})();
