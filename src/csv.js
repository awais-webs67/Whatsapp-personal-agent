// CSV in and out, as Excel and Google Sheets write and read it (quotes, commas and new lines inside cells, BOM).
/** Text -> rows of objects keyed by the lower-cased header ("First Name" -> "first_name"). */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const sep = (src.split('\n')[0].match(/;/g) || []).length > (src.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((k) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Rows -> CSV text with a BOM so Excel shows Urdu correctly. */
export function toCsv(rows, columns) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  return `﻿${[columns.map(([, label]) => cell(label)).join(','), ...rows.map((r) => columns.map(([k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n')}\r\n`;
}

/** Pakistani and international numbers -> digits with country code ("0309 1606792" -> "923091606792"). */
export function normPhone(v, country = '92') {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = country + d.slice(1);
  return d.replace(/\D/g, '');
}
