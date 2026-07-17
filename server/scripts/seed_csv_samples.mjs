// Seed sample seized-item rows from malkhana_seized_items_test_data.csv
// into the existing tables: fir_master, cases, case_property.
// Only CSV columns that map cleanly onto those tables are used; the
// category-specific columns (narcotic_type, weapon_type, etc.) are skipped.
// Idempotent: every INSERT uses ON CONFLICT DO NOTHING.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const { Client } = pg;

const CSV_PATH = path.resolve(
  process.env.HOME || process.env.USERPROFILE,
  'Downloads',
  'malkhana_seized_items_test_data.csv'
);

// --- minimal quote-aware CSV parser ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const partLetter = (s) => {
  const m = String(s || '').match(/Part\s*([A-E])/i);
  return m ? `PART ${m[1].toUpperCase()}` : null;
};

async function main() {
  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const data = rows.slice(1).filter((r) => r.length > 1 && r[idx.case_id]?.trim());

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let inserted = 0;
  for (const r of data) {
    const g = (k) => (r[idx[k]] ?? '').trim();
    const recordType = g('record_type') || 'FIR';
    const firNo = `${recordType} ${g('fir_dd_no')}`;
    const itemId = g('sr_no_mk');
    const section = partLetter(g('malkhana_section')) || 'PART C';
    const status = 'In Malkhana';
    const sealed = g('sealed_unsealed') === 'Sealed' ? 'Yes' : 'No';

    // 1) fir_master
    await client.query(
      `INSERT INTO fir_master
         (fir_no, police_station, fir_date, us_sections, io,
          record_type, dd_date, actual_seizure_dd_no, actual_seizure_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (fir_no) DO NOTHING`,
      [firNo, g('station'), g('fir_date') || null, g('sections_us') || null,
       g('seizing_officer') || null, recordType,
       recordType === 'DD' ? (g('fir_date') || null) : null,
       g('dd_no_actual_seizure') || null, g('date_actual_seizure') || null]
    );

    // 2) cases
    const caseRes = await client.query(
      `INSERT INTO cases
         (id, item_type, item_sub, section, status, seizing_officer,
          seized_on, item_id, description, fir_no, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [firNo, g('category_of_item'), g('quantity'), section, status,
       g('seizing_officer') || null, g('seized_on') || null, itemId || null,
       g('item_description') || null, firNo, g('date_receipt_malkhana') || g('seized_on') || null]
    );

    // 3) case_property (keyed by MK item_id)
    await client.query(
      `INSERT INTO case_property
         (item_id, fir_no, seized_time, quantity, place_of_seizure,
          physical_storage, date_of_receipt, received_by, malkhana_location,
          seal_sealed, seal_no, seal_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (item_id) DO NOTHING`,
      [itemId, firNo, g('seized_time') || null, g('quantity') || null,
       g('place_of_seizure') || null, g('malkhana_section') || null,
       g('date_receipt_malkhana') || null, g('received_by') || null,
       g('malkhana_section') || null, sealed,
       g('seal_no_mark') || null, g('sealed_by') || null, status]
    );

    if ((caseRes.rowCount ?? 0) > 0) inserted++;
  }

  await client.end();
  console.log(`Done. Rows in CSV: ${data.length}, new cases inserted: ${inserted}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
