// Daily e-Malkhana backup — dumps the live PostgreSQL ("case register")
// and emails it as a JSON attachment.
//
// Why email (not Google Drive):
//   The production deployment runs on Vercel (serverless).  The original
//   Drive design needed a service-account JSON key, but the GCP org policy
//   `iam.managed.disableServiceAccountKeyCreation` permanently blocks SA
//   key creation in this project.  Email has no such dependency — it just
//   needs an SMTP account (a Gmail address + app password works).
//
// Transport-agnostic by design:
//   The JSON dump is written to a local "attachment" buffer.  If SMTP is
//   not configured (no BACKUP_SMTP_* / BACKUP_TO env vars) we still write
//   the dump to disk under server/data/backups/ and exit 0 — so the cron
//   job records a success and you always have a local copy.  Set the SMTP
//   env vars to actually deliver it.
//
// Run manually:  node server/scripts/backup-email.js
// (server.js calls this same file via the "Run backup now" button.)
//
// Env (read from process.env; server.js passes BACKUP_RETENTION_DAYS):
//   DATABASE_URL        Neon/Postgres connection string (required)
//   BACKUP_FROM         From: address, e.g. emalkhana.backup@gmail.com
//   BACKUP_TO           Comma-separated recipient(s)
//   BACKUP_SMTP_HOST    default smtp.gmail.com
//   BACKUP_SMTP_PORT    default 465 (SSL)
//   BACKUP_SMTP_USER    SMTP login (usually == BACKUP_FROM)
//   BACKUP_SMTP_PASS    SMTP password / app password
//   BACKUP_RETENTION_DAYS  local dump retention (default 30)

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, '..', '..'); // e-malkhana/

const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

// Pick the first dir we can actually create + write into. Tries each in order
// and probes with a real write so read-only/serverless FS (e.g. Vercel's
// read-only bundle) fails fast and we fall back to /tmp instead of EROFS.
function pickWritableDir(dirs) {
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, '.write-test-' + Date.now());
      writeFileSync(probe, 'ok');
      unlinkSync(probe);
      return dir;
    } catch { /* try next */ }
  }
  // Last resort: OS temp; if even that fails the caller will get the error.
  return dirs[dirs.length - 1];
}

// --- Postgres connection (mirrors db.js: HTTP transport, serverless-safe) ---
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail('DATABASE_URL is not set — cannot dump the register.');
const sql = neon(DATABASE_URL, { fetchConnectionCache: true });

// Tables that make up the "case register".  Order matters only for readability.
const TABLES = [
  'kv', 'users', 'sections', 'item_types', 'cases', 'bns_sections',
  'movements', 'audit_log', 'fir_master', 'case_property',
  'item_type_fields', 'case_property_fields', 'inspections',
];

async function dumpTable(name) {
  const rows = await sql`SELECT * FROM ${sql.unsafe(name)}`;
  return Array.isArray(rows) ? rows : (rows?.rows || []);
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  console.log('▶ e-Malkhana → email backup (PostgreSQL register dump)');
  const dump = {
    app: 'e-Malkhana',
    generatedAt: new Date().toISOString(),
    source: 'Neon PostgreSQL (DATABASE_URL)',
    tables: {},
  };
  for (const t of TABLES) {
    try {
      const rows = await dumpTable(t);
      dump.tables[t] = rows;
      console.log(`  ✓ ${t}: ${rows.length} row(s)`);
    } catch (e) {
      // A missing table shouldn't kill the whole backup.
      console.warn(`  ⚠ ${t}: skipped (${e.message})`);
      dump.tables[t] = { _error: e.message };
    }
  }

  const json = JSON.stringify(dump, null, 2);
  const fileName = `malkhana-backup-${ts()}.json`;

  // Always write a local copy (also the safety net if SMTP is unset).
  // Prefer server/data/backups locally; on read-only/serverless filesystems
  // (e.g. Vercel: only /tmp is writable) fall back to /tmp automatically
  // instead of hard-failing with EROFS.
  const outDir = pickWritableDir([
    join(ROOT, 'server', 'data', 'backups'),
    '/tmp/emalkhana-backups',
  ]);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, fileName);
  writeFileSync(outPath, json, 'utf8');
  console.log(`✓ wrote local dump: ${outPath} (${json.length} bytes)`);
  pruneLocalDumps(outDir);

  // Deliver via email only if configured.
  const to = process.env.BACKUP_TO;
  if (!to) {
    console.log('ℹ BACKUP_TO not set — skipping email delivery (local dump kept).');
    return { ok: true, fileName, delivered: false };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.BACKUP_SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.BACKUP_SMTP_PORT || '465', 10),
    secure: true,
    auth: {
      user: process.env.BACKUP_SMTP_USER || process.env.BACKUP_FROM,
      pass: process.env.BACKUP_SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.BACKUP_FROM || process.env.BACKUP_SMTP_USER,
    to,
    subject: `e-Malkhana backup ${ts()}`,
    text: `Daily case-register backup is attached.\n\nGenerated: ${dump.generatedAt}\nTables: ${TABLES.length}\nSize: ${json.length} bytes`,
    attachments: [{ filename: fileName, content: json, contentType: 'application/json' }],
  });
  console.log(`✓ emailed backup to: ${to}`);
  return { ok: true, fileName, delivered: true };
}

// Remove local dumps older than RETENTION_DAYS so they don't pile up.
function pruneLocalDumps(dir) {
  if (!existsSync(dir)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('malkhana-backup-') || !f.endsWith('.json')) continue;
    const full = join(dir, f);
    try {
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); removed++; }
    } catch { /* ignore */ }
  }
  if (removed) console.log(`✓ pruned ${removed} local dump(s) older than ${RETENTION_DAYS} days`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('✗ backup failed:', e.message); process.exit(1); });
