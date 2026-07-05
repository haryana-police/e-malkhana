// e-Malkhana — file uploads + SVG image generator.
//
// All uploaded files live in server/data/uploads/ and are served by Express
// at /uploads/<filename>.  This module handles:
//   1. Storing an uploaded file (raw bytes + a chosen filename) and returning
//      the public URL.
//   2. Generating a stylised SVG "evidence photo" for a case based on the
//      item-type keyword.  These are produced on demand for the seeded cases
//      so the prototype has placeholder imagery for previous records.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

export const UPLOADS_DIR = join(__dirname, 'data', 'uploads');

export function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Save a Buffer under a chosen filename and return the public URL.
export function writeUpload(filename, data) {
  ensureUploadsDir();
  const full = join(UPLOADS_DIR, filename);
  writeFileSync(full, data);
  return `/uploads/${filename}`;
}

// Map an item-type description to an icon glyph + accent colour.
function classifyItem(itemType) {
  const s = (itemType || '').toLowerCase();
  if (/(pistol|gun|rifle|firearm|weapon|bor|cartridge)/.test(s))   return { glyph: '🔫', label: 'FIREARM',     accent: '#7A3F1E', bg: '#EFE1D2' };
  if (/(heroin|narcotic|drug|charas|opium|cocaine|ganja|mdma)/.test(s)) return { glyph: '📦', label: 'NARCOTICS',   accent: '#5C4A8A', bg: '#E7E1F1' };
  if (/(viscera|jar|organ|tissue|blood|sample|swab)/.test(s))      return { glyph: '🧪', label: 'BIOLOGICAL',  accent: '#1E5C7A', bg: '#DCE9EE' };
  if (/(cash|note|money|currency|cheque)/.test(s))                 return { glyph: '💵', label: 'CASH',        accent: '#4B5D3A', bg: '#E4E9D9' };
  if (/(vehicle|motorcycle|car|bike|truck|auto)/.test(s))          return { glyph: '🏍️', label: 'VEHICLE',    accent: '#93641E', bg: '#F1E4C9' };
  if (/(phone|mobile|laptop|computer|electronic|device)/.test(s))  return { glyph: '📱', label: 'ELECTRONICS', accent: '#14243D', bg: '#D8CEAD' };
  if (/(document|paper|passport|license|aadhaar)/.test(s))        return { glyph: '📄', label: 'DOCUMENT',    accent: '#8C7A54', bg: '#F0EBDD' };
  return { glyph: '📦', label: 'EVIDENCE', accent: '#14243D', bg: '#E4DCC5' };
}

// Render an SVG that looks like a stamped evidence photo.
// 360 × 300, paper background, ledger-style frame, big icon, label.
export function svgForCase(caseId, itemType, itemSub) {
  const c = classifyItem(itemType);
  const esc = (s) => String(s || '').replace(/[<>&"']/g, ch => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[ch]));
  const itemLabel = esc(itemType || '').slice(0, 40);
  const subLabel  = esc(itemSub  || '').slice(0, 50);
  const caseLabel = esc(caseId   || '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 300" width="360" height="300" role="img" aria-label="Evidence photo placeholder">
  <defs>
    <pattern id="paper" patternUnits="userSpaceOnUse" width="6" height="6">
      <rect width="6" height="6" fill="${c.bg}"/>
      <circle cx="1" cy="1" r="0.4" fill="${c.accent}" opacity="0.10"/>
      <circle cx="4" cy="3" r="0.3" fill="${c.accent}" opacity="0.08"/>
    </pattern>
  </defs>
  <rect width="360" height="300" fill="url(#paper)"/>
  <rect x="6" y="6" width="348" height="288" fill="none" stroke="${c.accent}" stroke-width="2" stroke-dasharray="4 3"/>
  <rect x="14" y="14" width="332" height="36" fill="${c.accent}"/>
  <text x="180" y="38" text-anchor="middle" font-family="Rajdhani, Arial, sans-serif" font-weight="700" font-size="16" fill="#FAF7EE" letter-spacing="3">${c.label} · EVIDENCE PHOTO</text>
  <text x="180" y="150" text-anchor="middle" font-size="110" fill="${c.accent}">${c.glyph}</text>
  <text x="180" y="208" text-anchor="middle" font-family="IBM Plex Sans, Arial, sans-serif" font-weight="600" font-size="15" fill="#14243D">${itemLabel}</text>
  <text x="180" y="228" text-anchor="middle" font-family="IBM Plex Sans, Arial, sans-serif" font-size="11" fill="#5C5A4E">${subLabel}</text>
  <text x="180" y="258" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" font-weight="600" fill="#14243D">${caseLabel}</text>
  <line x1="20" y1="270" x2="340" y2="270" stroke="${c.accent}" stroke-width="0.6" stroke-dasharray="2 2"/>
  <text x="20" y="284" font-family="Rajdhani, Arial, sans-serif" font-size="9" font-weight="700" fill="${c.accent}" letter-spacing="2">PLACEHOLDER · NOT AN ACTUAL PHOTOGRAPH</text>
  <text x="340" y="284" text-anchor="end" font-family="IBM Plex Mono, monospace" font-size="9" fill="#5C5A4E">e-Malkhana</text>
</svg>`;
}

// Generate (or return existing) SVG for a case.  Returns the public URL.
export function ensureCaseImage(c) {
  const slug = c.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  const filename = `case-${slug}.svg`;
  const full = join(UPLOADS_DIR, filename);
  if (!existsSync(full)) {
    writeFileSync(full, svgForCase(c.id, c.itemType, c.itemSub));
  }
  return `/uploads/${filename}`;
}
