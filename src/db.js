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

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  kind TEXT NOT NULL,               -- batch | scheduled
  schedule TEXT,                    -- JSON: {type: once|every|daily, at|minutes|time}
  status TEXT NOT NULL,             -- active | paused | done | failed | removed
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_result TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  chat_id INTEGER
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, id);

-- Which chat has which WhatsApp label, exactly as the phone says (counts come from here, not from tags).
CREATE TABLE IF NOT EXISTS wa_label_chats (
  account_id INTEGER NOT NULL,
  label_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  PRIMARY KEY (account_id, label_id, jid)
);
CREATE TABLE IF NOT EXISTS wa_labels (
  account_id INTEGER NOT NULL,
  label_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, label_id)
);

-- Email: your own sending accounts (SMTP, and IMAP to see replies), contact lists, and every email a campaign sends.
CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, from_name TEXT NOT NULL, from_email TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_secure INTEGER NOT NULL DEFAULT 1, smtp_user TEXT NOT NULL, smtp_pass TEXT NOT NULL,
  imap_host TEXT, imap_port INTEGER, imap_user TEXT, imap_pass TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 40,
  warmup INTEGER NOT NULL DEFAULT 1,          -- start low and add a few a day until daily_limit
  footer TEXT,                                -- your business name and address, shown under every email
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT, last_ok_at INTEGER, imap_checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT, last_name TEXT, company TEXT, website TEXT, title TEXT, phone TEXT, extra TEXT,
  status TEXT NOT NULL DEFAULT 'active',      -- active | replied | unsubscribed | bounced
  created_at INTEGER NOT NULL,
  UNIQUE(list, email)
);
CREATE INDEX IF NOT EXISTS email_contacts_email ON email_contacts(email);
CREATE TABLE IF NOT EXISTS email_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL, contact_id INTEGER NOT NULL, account_id INTEGER,
  step INTEGER NOT NULL DEFAULT 1,
  subject TEXT, body TEXT,
  status TEXT NOT NULL DEFAULT 'queued',      -- queued | sent | failed | skipped
  due_at INTEGER NOT NULL, sent_at INTEGER, message_id TEXT, error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS email_sends_due ON email_sends(status, due_at);
CREATE INDEX IF NOT EXISTS email_sends_task ON email_sends(task_id, contact_id);

CREATE TABLE IF NOT EXISTS campaign_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,             -- dashboard | command | system
  field TEXT NOT NULL,
  before TEXT,
  after TEXT
);
CREATE INDEX IF NOT EXISTS campaign_changes_task ON campaign_changes(task_id, id);

CREATE TABLE IF NOT EXISTS command_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',  -- chat | whatsapp | tasks
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,               -- owner | agent
  text TEXT NOT NULL,
  steps TEXT,                       -- JSON: what the agent did
  ts INTEGER NOT NULL
);
`);
// Additive migrations for databases created by earlier versions.
for (const sql of ['ALTER TABLE accounts ADD COLUMN self_jid TEXT', "ALTER TABLE providers ADD COLUMN use_for TEXT NOT NULL DEFAULT 'all'", 'ALTER TABLE followups ADD COLUMN task_id INTEGER', 'ALTER TABLE tasks ADD COLUMN ignore_quiet INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE commands ADD COLUMN thread_id INTEGER', 'ALTER TABLE tasks ADD COLUMN thread_id INTEGER', 'ALTER TABLE chats ADD COLUMN tags TEXT', 'ALTER TABLE tasks ADD COLUMN params TEXT', 'ALTER TABLE chats ADD COLUMN campaign_id INTEGER', 'ALTER TABLE chats ADD COLUMN ad_id TEXT', 'ALTER TABLE chats ADD COLUMN ad_title TEXT', 'ALTER TABLE chats ADD COLUMN profile TEXT', 'ALTER TABLE tasks ADD COLUMN parent_id INTEGER', 'ALTER TABLE messages ADD COLUMN reply_to TEXT', 'ALTER TABLE messages ADD COLUMN reply_text TEXT', 'ALTER TABLE wa_label_chats ADD COLUMN alt TEXT']) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

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
