// Makes one backup file of everything the agent knows: every database (copied safely while the agent runs),
// WhatsApp sessions, keys, uploaded knowledge. Restore = put the "data" folder back before starting the agent.
//   node deploy/backup.mjs            -> backups/agent-backup-YYYY-MM-DD-HHMM.tar.gz
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.join(root, 'data');
if (!fs.existsSync(data)) { console.error('No data folder found at', data); process.exit(1); }
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
const out = path.join(root, 'backups');
const work = path.join(out, `tmp-${stamp}`);
fs.mkdirSync(work, { recursive: true });

// Copy the folder, but databases through SQLite itself so a backup taken while the agent writes is never broken.
function copy(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'deleted') { fs.mkdirSync(d, { recursive: true }); copy(s, d); } continue; }
    if (/\.db-(wal|shm)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.db')) {
      const db = new DatabaseSync(s);
      db.exec(`VACUUM INTO '${d.replace(/'/g, "''")}'`);
      db.close();
    } else fs.copyFileSync(s, d);
  }
}
fs.mkdirSync(path.join(work, 'data'), { recursive: true });
copy(data, path.join(work, 'data'));
const file = path.join(out, `agent-backup-${stamp}.tar.gz`);
execFileSync('tar', ['-czf', file, '-C', work, 'data']);
fs.rmSync(work, { recursive: true, force: true });
// Keep the newest 14 backups on the server.
const old = fs.readdirSync(out).filter((f) => /^agent-backup-.*\.tar\.gz$/.test(f)).sort().reverse().slice(14);
for (const f of old) fs.rmSync(path.join(out, f));
console.log(`Backup ready: ${file} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
