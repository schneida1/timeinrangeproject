// parse.js — CGM export parsers. Everything runs locally; files never leave the device.
import { MGDL_PER_MMOL } from './metrics.js';

export function splitCsvLine(line, delim = ',') {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (c === delim && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseValue(raw, isMmol) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Dexcom exports "Low"/"High" for out-of-sensor-range readings.
  if (/^low$/i.test(s)) return 40;
  if (/^high$/i.test(s)) return 400;
  let n = parseFloat(s.replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (isMmol || n < 30) n = n * MGDL_PER_MMOL;
  return Math.round(n);
}

// Accepts ISO-ish and LibreView "MM-DD-YYYY HH:MM" / "DD-MM-YYYY HH:MM" timestamps.
export function parseTimestamp(raw) {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return +new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (m) {
    let a = +m[1], b = +m[2];
    let hour = +m[4];
    if (m[7]) hour = (hour % 12) + (/pm/i.test(m[7]) ? 12 : 0);
    // Prefer US month-first unless that's impossible.
    let month = a, day = b;
    if (a > 12) { month = b; day = a; }
    return +new Date(+m[3], month - 1, day, hour, +m[5], +(m[6] || 0));
  }
  const d = new Date(s);
  return Number.isNaN(+d) ? null : +d;
}

// Returns { readings, source, unit }.
export function parseCgmCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { readings: [], source: 'unknown' };
  const delim = (lines.slice(0, 5).join('').match(/;/g) || []).length > (lines.slice(0, 5).join('').match(/,/g) || []).length ? ';' : ',';

  // LibreView has 1–2 preamble lines before the header. Find the header row.
  let headerIdx = lines.findIndex((l) => /glucose/i.test(l) && /(time|date)/i.test(l));
  if (headerIdx < 0) headerIdx = 0;
  const cols = splitCsvLine(lines[headerIdx], delim).map((c) => c.toLowerCase());
  const isMmol = cols.some((c) => c.includes('mmol'));
  const readings = [];
  let source = 'CSV';

  const find = (pred) => cols.findIndex(pred);
  let tIdx, vIdx, altIdx = -1, typeIdx = -1;

  if (cols.some((c) => c.includes('glucose value')) && cols.some((c) => c.includes('timestamp'))) {
    source = 'Dexcom Clarity';
    tIdx = find((c) => c.includes('timestamp'));
    vIdx = find((c) => c.includes('glucose value'));
    typeIdx = find((c) => c === 'event type');
  } else if (cols.some((c) => c.includes('device timestamp'))) {
    source = 'LibreView';
    tIdx = find((c) => c.includes('device timestamp'));
    vIdx = find((c) => c.includes('historic glucose'));
    altIdx = find((c) => c.includes('scan glucose'));
  } else {
    tIdx = find((c) => /time|date/.test(c));
    vIdx = find((c) => c.includes('glucose') || c.includes('sgv') || c === 'value');
  }
  if (tIdx < 0 || (vIdx < 0 && altIdx < 0)) {
    throw new Error('Could not find timestamp and glucose columns.');
  }

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = splitCsvLine(lines[i], delim);
    if (typeIdx >= 0 && row[typeIdx] && !/^egv$/i.test(row[typeIdx])) continue;
    const raw = vIdx >= 0 && row[vIdx] ? row[vIdx] : altIdx >= 0 ? row[altIdx] : null;
    const v = parseValue(raw, isMmol);
    const t = parseTimestamp(row[tIdx]);
    if (v == null || t == null) continue;
    readings.push({ t, v });
  }
  return { readings, source, unit: isMmol ? 'mmol' : 'mgdl' };
}
