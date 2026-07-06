// Wipe and re-seed the Neon database.  Run with:  node scripts/reseed-neon.js
// Use this after changing the seed shape in db.js so the new demo data
// takes effect.
import 'dotenv/config';
import { pool } from '../db.js';

async function main() {
  console.log('Wiping all data...');
  await pool.query(`
    TRUNCATE TABLE
      audit_log, movements, cases, sections, users, kv
    RESTART IDENTITY CASCADE
  `);
  console.log('  ✓ truncated');
  // Now drop+recreate schema to make sure initSchema() re-runs cleanly.
  await pool.query(`
    DROP TABLE IF EXISTS
      audit_log, movements, cases, sections, users, kv CASCADE
  `);
  console.log('  ✓ dropped (initSchema will recreate on next read)');
  // Force-exit; pool.end() can hang on Windows.
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
