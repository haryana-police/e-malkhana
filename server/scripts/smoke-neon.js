// Smoke test for server/db.js.  Run with:  node scripts/smoke-neon.js
// Exits 0 on success, 1 on any failure.  Safe to re-run — it's idempotent.
import 'dotenv/config';
import { pool, initSchema, seedIfEmpty } from '../db.js';

const ok = (msg) => console.log('  ✓', msg);
const fail = (msg, e) => { console.error('  ✗', msg, e?.message || e); process.exit(1); };

async function main() {
  console.log('1) Connecting to Neon via DATABASE_URL ...');
  try {
    const { rows } = await pool.query('SELECT 1 AS one, current_database() AS db, version() AS v');
    ok(`connected: db=${rows[0].db}`);
  } catch (e) { fail('connect', e); }

  console.log('2) Running schema (CREATE TABLE IF NOT EXISTS) ...');
  try { await initSchema(); ok('schema ready'); }
  catch (e) { fail('schema', e); }

  console.log('3) Seeding (no-op if users already exist) ...');
  try { await seedIfEmpty(); ok('seed step finished'); }
  catch (e) { fail('seed', e); }

  console.log('4) Reading back the demo rows ...');
  try {
    const u = await pool.query('SELECT id, name, designation FROM users ORDER BY id');
    const c = await pool.query('SELECT count(*)::int AS n FROM cases');
    const s = await pool.query('SELECT count(*)::int AS n FROM sections');
    const m = await pool.query('SELECT count(*)::int AS n FROM movements');
    ok(`users: ${u.rows.length} (${u.rows.map(r => r.id).join(', ')})`);
    ok(`cases: ${c.rows[0].n}   sections: ${s.rows[0].n}   movements: ${m.rows[0].n}`);
  } catch (e) { fail('readback', e); }

  console.log('5) (Skipping pool.end() — known to hang on Windows)');
  console.log('\nAll good.');
}
main().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
