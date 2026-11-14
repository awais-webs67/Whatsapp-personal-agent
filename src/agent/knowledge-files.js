// Knowledge saved as files in ./knowledge (for example knowledge/sellmetools.md, written by scripts/fetch-shop.mjs).
// Each file becomes one "Source:" block in the agent's website knowledge, replacing any older copy of the same site.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, saveSettings, kvGet, kvSet, log } from '../core.js';

export const KNOWLEDGE_DIR = path.resolve(process.env.KNOWLEDGE_DIR || './knowledge');

export function readFiles() {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  return fs.readdirSync(KNOWLEDGE_DIR).filter((f) => /\.(md|txt)$/i.test(f) && !/^readme/i.test(f)).sort().map((f) => {
    const full = path.join(KNOWLEDGE_DIR, f);
    const text = fs.readFileSync(full, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^#{1,6}\s+/gm, '')        // headings become plain lines ("Payment", "AI Tools (26):")
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n').trim();
    return { file: f, site: f.replace(/\.(md|txt)$/i, ''), text, mtime: fs.statSync(full).mtimeMs };
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
    blocks = blocks.filter((b) => !b.startsWith(`Source: ${f.file}`) && !new RegExp(`^Source: (https?://)?(www\\.)?${f.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(b));
    blocks.push(`Source: ${f.file} (saved file)\n${f.text}`);
    seen[f.file] = f.mtime;
  }
  saveSettings({ business: { learnedWeb: blocks.join('\n\n') } });
  kvSet('knowledgeFiles', seen);
  log('info', 'learn', `Loaded saved knowledge: ${changed.map((f) => f.file).join(', ')}`);
  return { files: changed.length, names: changed.map((f) => f.file) };
}
