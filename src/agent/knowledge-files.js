// Knowledge saved as files in ./knowledge (for example knowledge/sellmetools.md, written by scripts/fetch-shop.mjs).
// Each file becomes one "Source:" block in the agent's website knowledge, replacing any older copy of the same site.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getSettings, saveSettings, kvGet, kvSet, log } from '../core.js';
import { DATA_DIR } from '../db.js';

export const KNOWLEDGE_DIR = path.resolve(process.env.KNOWLEDGE_DIR || './knowledge');
// Files uploaded from the dashboard live with the rest of the data, never in the app's own (git) folder.
export const UPLOAD_DIR = path.join(DATA_DIR, 'knowledge');

export function readFiles() {
  const found = new Map(); // name -> { dir, uploaded }
  for (const [dir, uploaded] of [[KNOWLEDGE_DIR, KNOWLEDGE_DIR === UPLOAD_DIR], [UPLOAD_DIR, true]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.(md|txt)$/i.test(f) && !/^readme/i.test(f)) found.set(f, { dir, uploaded });
  }
  return [...found.keys()].sort().map((f) => {
    const { dir, uploaded } = found.get(f);
    const full = path.join(dir, f);
    const raw = fs.readFileSync(full, 'utf8');
    const text = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^#{1,6}\s+/gm, '')        // headings become plain lines ("Payment", "AI Tools (26):")
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n').trim();
    return { file: f, uploaded, site: f.replace(/\.(md|txt)$/i, ''), text, raw, mtime: fs.statSync(full).mtimeMs };
  });
}

/** Load every knowledge file into settings. `force` reloads even if nothing changed since last time. */
export function importKnowledgeFiles({ force = false } = {}) {
  const files = readFiles();
  if (!files.length) return { files: 0 };
  const seen = kvGet('knowledgeFiles', {});
  const changed = files.filter((f) => force || seen[f.file] !== f.mtime);
  if (!changed.length) return { files: 0 };
  let blocks = (getSettings().business.learnedWeb || '').split(/\n\n(?=Source: )/).filter((b) => b.trim());
  for (const f of changed) {
    // Replace this file's previous copy and any live read of the same site (e.g. "Source: sellmetools.com …").
    // A live read of the same site ("Source: sellmetools.com …") is replaced too, but never another saved file.
    const site = new RegExp(`^Source: (https?://)?(www\\.)?${f.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z]{2,}|/|\\s|$)`, 'i');
    blocks = blocks.filter((b) => !b.startsWith(`Source: ${f.file} `) && !(site.test(b) && !/^[^\n]*\(saved file\)/.test(b)));
    blocks.push(`Source: ${f.file} (saved file)\n${f.text}`);
    seen[f.file] = f.mtime;
  }
  // A shop file made by fetch-shop.mjs links every product page, which always shows the current price.
  // Until the owner picks a price mode, use those links instead of prices that go stale.
  const shop = changed.map((f) => /<!-- products:start[^>]*?from (https?:\/\/\S+)/.exec(f.raw)).find(Boolean);
  const auto = shop && !kvGet('pricesChosen') ? { prices: 'link', shopLink: getSettings().business.shopLink || shop[1] } : {};
  saveSettings({ business: { learnedWeb: blocks.join('\n\n'), ...auto } });
  if (auto.prices) log('info', 'learn', `Prices change on ${auto.shopLink}: the agent sends product links instead of prices (change it on the Knowledge page)`);
  kvSet('knowledgeFiles', seen);
  log('info', 'learn', `Loaded saved knowledge: ${changed.map((f) => f.file).join(', ')}`);
  return { files: changed.length, names: changed.map((f) => f.file) };
}

// ---------- uploads from the dashboard ----------
const MAX_TEXT = 300_000;

/** Text from a .docx: it is a zip; the words are in word/document.xml. No library needed. */
export function docxText(buf) {
  // Find the zip's central directory, then the entry for word/document.xml.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This .docx file is damaged or not really a Word file');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'word/document.xml') {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      const xml = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      return xml
        .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error('No text found in this .docx file');
}

const safeName = (name) => String(name || 'notes').replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'notes';

/** Save an uploaded file as text in the knowledge folder and load it. Word files become .txt. */
/** The text of an uploaded .md, .txt or .docx file. */
export function fileToText(name, buf) {
  const ext = (/\.([a-z0-9]+)$/i.exec(String(name)) || [])[1]?.toLowerCase();
  let text;
  if (ext === 'md' || ext === 'txt' || ext === 'markdown') text = buf.toString('utf8');
  else if (ext === 'docx') text = docxText(buf);
  else if (ext === 'doc') throw new Error('Old .doc files cannot be read. In Word, use "Save as" → .docx (or .txt) and upload that.');
  else throw new Error('Upload .md, .txt or .docx files');
  return { ext, text: text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim() };
}

export function saveUpload(name, buf) {
  let { ext, text } = fileToText(name, buf);
  if (!text) throw new Error('The file has no text');
  if (text.length > MAX_TEXT) throw new Error(`The file is too long (${Math.round(text.length / 1000)}k characters). Split it into smaller files, up to ${MAX_TEXT / 1000}k each.`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const file = `${safeName(name)}.${ext === 'docx' ? 'txt' : ext === 'markdown' ? 'md' : ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), text);
  importKnowledgeFiles();
  log('info', 'learn', `Knowledge file added: ${file} (${text.length} characters)`);
  return { file, chars: text.length };
}

export function listFiles() {
  return readFiles().map((f) => ({ file: f.file, chars: f.text.length, updatedAt: Math.round(f.mtime), builtIn: !f.uploaded }));
}

/** Remove a knowledge file and what the agent learned from it. */
export function removeFile(file) {
  const f = readFiles().find((x) => x.file === file);
  if (!f) throw Object.assign(new Error('File not found'), { status: 404 });
  if (!f.uploaded) throw Object.assign(new Error('This file comes with the app (knowledge folder). Change it there, or turn it off by clearing its text in the box below.'), { status: 400 });
  fs.rmSync(path.join(UPLOAD_DIR, f.file));
  const blocks = (getSettings().business.learnedWeb || '').split(/\n\n(?=Source: )/).filter((b) => b.trim() && !b.startsWith(`Source: ${f.file} (saved file)`));
  saveSettings({ business: { learnedWeb: blocks.join('\n\n') } });
  const seen = kvGet('knowledgeFiles', {});
  delete seen[f.file];
  kvSet('knowledgeFiles', seen);
  log('info', 'learn', `Knowledge file removed: ${f.file}`);
  return { ok: true };
}
