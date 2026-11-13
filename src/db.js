import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,               -- 'qr' (WhatsApp Web session) | 'cloud' (official Cloud API)
  config TEXT NOT NULL DEFAULT '{}',
  reply_mode TEXT NOT NULL DEFAULT 'new_only',  -- all | new_only | manual
  enabled INTEGER NOT NULL DEFAULT 1,
  connected_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  phone TEXT,
  name TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  summary TEXT,
  notes TEXT,
  ai_enabled INTEGER,               -- NULL = follow account reply_mode, 1 = on, 0 = off
  paused_until INTEGER,
  needs_human INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  is_new INTEGER NOT NULL DEFAULT 0, -- first seen live (after connect), not from history
  unread INTEGER NOT NULL DEFAULT 0,
  last_in_at INTEGER,
  last_out_at INTEGER,
  last_msg_at INTEGER,
  last_text TEXT,
  followup_count INTEGER NOT NULL DEFAULT 0,
  next_followup_at INTEGER,
  analyzed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, jid)
);
CREATE INDEX IF NOT EXISTS chats_recent ON chats(last_msg_at DESC);
CREATE INDEX IF NOT EXISTS chats_followup ON chats(next_followup_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  wa_id TEXT,
  from_me INTEGER NOT NULL,
  by TEXT NOT NULL,                 -- customer | ai | owner | followup
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  ts INTEGER NOT NULL,
  UNIQUE(chat_id, wa_id)
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, ts);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- openai | anthropic
  base_url TEXT,
  api_key TEXT,                     -- encrypted
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  daily_limit INTEGER,              -- optional self-imposed requests/day cap
  state TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(provider_id, day)
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- auto | campaign
  text TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,             -- pending | approved | sent | skipped | failed
  due_at INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS followups_status ON followups(status, due_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  msg TEXT NOT NULL
);
`);

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
};
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

export const now = () => Date.now();
export const parse = (s, fallback = {}) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

/** Build "SET a=?, b=?" for a whitelist of columns present in `patch`. */
export function update(table, id, patch, allowed) {
  const cols = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (!cols.length) return;
  run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => patch[c]), id);
}
