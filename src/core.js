// Shared plumbing: event bus, activity log, settings, secret encryption.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, get, run, now, parse } from './db.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
/** Push a live event to every open dashboard. */
export const emit = (type, data = {}) => bus.emit('event', { type, data, ts: now() });

export function log(level, scope, msg) {
  const text = String(msg).slice(0, 2000);
  const { lastInsertRowid } = run('INSERT INTO logs (ts, level, scope, msg) VALUES (?,?,?,?)', now(), level, scope, text);
  if (Number(lastInsertRowid) % 200 === 0) run('DELETE FROM logs WHERE id < ?', Number(lastInsertRowid) - 5000);
  emit('log', { id: Number(lastInsertRowid), ts: now(), level, scope, msg: text });
  if (process.env.NODE_ENV !== 'test') console.log(`[${level}] ${scope}: ${text}`);
}

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  autopilot: true,
  commandsViaWhatsApp: true,            // messages in "Message yourself" are treated as commands
  business: {
    name: '', persona: '',
    goal: 'Answer questions about what we offer and help the customer buy, without pressure.',
    offTopic: 'redirect',               // redirect | brief: how to handle unrelated questions
    learned: '', learnedAt: null,        // distilled from the owner's own chats
    learnedWeb: '',                      // distilled from the website / WhatsApp business profile
    memory: '',                          // things the owner told the agent to remember
    about: '', catalog: '', faqs: '', policies: '',
    tone: 'Short, warm, natural WhatsApp messages. No long paragraphs, no bullet lists.',
    language: 'Reply in the language and script the customer uses: if they write in Urdu script (اردو), reply in proper Urdu script; if they write Roman Urdu, reply in Roman Urdu; if English, reply in English.',
    purchaseSignal: 'Customer confirms the order or shares a payment proof.',
    examples: '',
  },
  human: {
    debounceMin: 2, debounceMax: 3.5,   // seconds to wait for the customer to finish typing
    readMin: 0.5, readMax: 1.5,         // seconds before the chat is marked read
    typingCpsMin: 14, typingCpsMax: 22, // simulated typing speed, characters per second
    typingMaxSec: 6,
    gapMin: 0.6, gapMax: 1.4,           // pause between consecutive bubbles
    maxRepliesPerHour: 120,             // per account safety cap
    handoffMinutes: 60,                 // AI stays quiet this long after you reply by hand
  },
  followup: {
    enabled: true,
    approval: true,                     // drafts wait for your approval before sending
    stepsHours: [24, 72, 168],
    quietStart: 21, quietEnd: 9,        // no proactive messages between these hours
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    dailyCap: 40,                       // proactive messages per account per day
    gapMinSec: 60, gapMaxSec: 240,
  },
  llm: { historyMessages: 12, maxTokens: 1024, timeoutSec: 20, tokenSaver: true },
};

const merge = (base, over) => {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
};

/** Pacing presets offered in Settings. */
export const PACING = {
  instant: { debounceMin: 1, debounceMax: 1.5, readMin: 0, readMax: 0.3, typingCpsMin: 40, typingCpsMax: 60, typingMaxSec: 2, gapMin: 0.3, gapMax: 0.6 },
  fast: { debounceMin: 2, debounceMax: 3.5, readMin: 0.5, readMax: 1.5, typingCpsMin: 14, typingCpsMax: 22, typingMaxSec: 6, gapMin: 0.6, gapMax: 1.4 },
  natural: { debounceMin: 4, debounceMax: 9, readMin: 1, readMax: 4, typingCpsMin: 5, typingCpsMax: 9, typingMaxSec: 14, gapMin: 1, gapMax: 3 },
};

export function getSettings() {
  const row = get('SELECT value FROM settings WHERE key = ?', 'app');
  return merge(DEFAULT_SETTINGS, row ? parse(row.value) : {});
}
export function saveSettings(patch) {
  const next = merge(getSettings(), patch);
  kvSet('app', next);
  emit('settings');
  return next;
}
export const kvGet = (key, fallback = null) => {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? parse(row.value, fallback) : fallback;
};
export const kvSet = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

/** Installs created with the first, slower defaults move to the fast pacing once. */
export function migrateSettings() {
  const version = kvGet('settingsVersion', 1);
  if (version >= 4) return;
  const row = get('SELECT value FROM settings WHERE key = ?', 'app');
  let stored = row ? parse(row.value) : null;
  if (stored && version < 2 && stored.human?.debounceMin === 4 && stored.human.debounceMax === 9) stored = merge(stored, { human: PACING.fast, llm: { timeoutSec: 20 } });
  // v4: Urdu script support in the default language rule.
  if (stored && stored.business?.language === 'Reply in the same language and script the customer uses (English, Urdu, Roman Urdu...).') stored = merge(stored, { business: { language: 'Reply in the language and script the customer uses: if they write in Urdu script (اردو), reply in proper Urdu script; if they write Roman Urdu, reply in Roman Urdu; if English, reply in English.' } });
  // v3: shorter history by default (fewer tokens per reply), unless the owner had changed it.
  if (stored && stored.llm?.historyMessages === 30) stored = merge(stored, { llm: { historyMessages: 12 } });
  if (stored) kvSet('app', stored);
  kvSet('settingsVersion', 4);
}

// ---------- secrets ----------
// API keys and tokens are encrypted at rest with a key that never leaves this machine.
function loadSecret() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
export const SECRET = loadSecret();

export function encrypt(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}
export function decrypt(blob) {
  if (!blob) return '';
  try {
    const [, iv, tag, body] = blob.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}
export const mask = (blob) => {
  const v = decrypt(blob);
  return v ? `${v.slice(0, 4)}…${v.slice(-4)}` : '';
};

// ---------- small helpers ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export function hourIn(timezone, date = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(date));
  } catch {
    return date.getHours();
  }
}
/** True when `hour` falls inside the quiet window (which may wrap past midnight). */
export function isQuiet(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
