// Owns every connected number and is the single place messages enter and leave the database.
import { db, all, get, run, now, parse, update } from '../db.js';
import { decrypt, emit, log } from '../core.js';
import { QrConnector } from './baileys.js';
import { CloudConnector } from './cloud.js';

const connectors = new Map(); // accountId -> connector
const statuses = new Map();   // accountId -> { state, qr, pairingCode, me, error }
const pendingBot = new Map(); // chatId -> [{ text, by, at }] sends in flight, to recognise our own echoes
let handlers = { onCustomer: () => {}, onOwner: () => {}, onCommand: () => {} };
export const setHandlers = (h) => { handlers = { ...handlers, ...h }; };

export const statusOf = (id) => statuses.get(id) || { state: 'disconnected' };
export const connectorOf = (id) => connectors.get(id);

export function publicAccount(row) {
  const cfg = parse(row.config);
  return {
    id: row.id, name: row.name, type: row.type, replyMode: row.reply_mode, enabled: !!row.enabled, connectedAt: row.connected_at,
    status: statusOf(row.id),
    cloud: row.type === 'cloud' ? { phoneNumberId: cfg.phoneNumberId || '', verifyToken: cfg.verifyToken || '', template: cfg.template || '', templateLang: cfg.templateLang || 'en', hasToken: !!cfg.accessToken, hasSecret: !!cfg.appSecret } : undefined,
    chats: get('SELECT COUNT(*) n FROM chats WHERE account_id = ?', row.id).n,
  };
}
export const listAccounts = () => all('SELECT * FROM accounts ORDER BY id').map(publicAccount);

function setStatus(id, patch) {
  const prev = statusOf(id);
  // qr / pairing code only make sense in their own state
  const next = { ...prev, qr: null, pairingCode: null, error: null, ...patch };
  statuses.set(id, next);
  if (patch.state === 'connected' && prev.state !== 'connected') {
    const row = get('SELECT connected_at, name FROM accounts WHERE id = ?', id);
    if (row && !row.connected_at) update('accounts', id, { connected_at: now() }, ['connected_at']);
    next.since = now();
    // First link: give the history sync a moment so old contacts are not mistaken for new leads.
    next.settleUntil = row && !row.connected_at && get('SELECT type FROM accounts WHERE id = ?', id)?.type === 'qr' ? now() + 10_000 : 0;
    log('info', 'whatsapp', `${row?.name || id} connected${next.me ? ` as +${next.me}` : ''}`);
  }
  if (patch.error && patch.error !== prev.error) log('warn', 'whatsapp', `Account ${id}: ${patch.error}`);
  emit('accounts', listAccounts());
}

function hooksFor(account) {
  return {
    onStatus: (s) => setStatus(account.id, s),
    onMessages: (msgs, { live }) => ingest(account.id, msgs, live),
    onNotice: (level, msg) => log(level, 'whatsapp', `${account.name}: ${msg}`),
    // WhatsApp asks for a re-send when the other phone could not decrypt one of our messages.
    getMessage: (waId) => get('SELECT m.text FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.account_id = ? AND m.wa_id = ? AND m.from_me = 1', account.id, waId)?.text || null,
    onContacts: (contacts) => {
      for (const c of contacts) {
        run('UPDATE chats SET name = COALESCE(name, ?), phone = COALESCE(phone, ?) WHERE account_id = ? AND jid = ?', c.name, c.phone, account.id, c.jid);
      }
    },
  };
}

export async function connect(id, opts = {}) {
  const row = get('SELECT * FROM accounts WHERE id = ?', id);
  if (!row) throw new Error('Account not found');
  await connectors.get(id)?.stop().catch(() => {});
  const cfg = parse(row.config);
  const conn = row.type === 'cloud'
    ? new CloudConnector(row, hooksFor(row), { ...cfg, accessToken: decrypt(cfg.accessToken), appSecret: decrypt(cfg.appSecret) })
    : new QrConnector(row, hooksFor(row));
  connectors.set(id, conn);
  await conn.start(opts);
}

export async function disconnect(id, { logout = false } = {}) {
  await connectors.get(id)?.stop({ logout }).catch(() => {});
  connectors.delete(id);
  setStatus(id, { state: logout ? 'logged_out' : 'disconnected' });
}

export async function startAll() {
  for (const row of all('SELECT id, name FROM accounts WHERE enabled = 1')) {
    connect(row.id).catch((e) => log('error', 'whatsapp', `Could not start ${row.name}: ${e.message}`));
  }
}

// ---------- message intake ----------
function upsertChat(accountId, m, live) {
  let chat = get('SELECT * FROM chats WHERE account_id = ? AND jid = ?', accountId, m.jid);
  if (!chat) {
    run('INSERT INTO chats (account_id, jid, phone, name, is_new, created_at) VALUES (?,?,?,?,?,?)', accountId, m.jid, m.phone ?? null, m.name ?? null, live && !m.fromMe ? 1 : 0, now());
    chat = get('SELECT * FROM chats WHERE account_id = ? AND jid = ?', accountId, m.jid);
  } else if ((m.name && !chat.name) || (m.phone && !chat.phone)) {
    run('UPDATE chats SET name = COALESCE(name, ?), phone = COALESCE(phone, ?) WHERE id = ?', m.name ?? null, m.phone ?? null, chat.id);
  }
  return chat;
}

function takePending(chatId, text) {
  const list = pendingBot.get(chatId);
  const i = list?.findIndex((p) => p.text === text && now() - p.at < 120_000) ?? -1;
  return i >= 0 ? list.splice(i, 1)[0] : null;
}

function ingest(accountId, msgs, live) {
  const account = get('SELECT connected_at, self_jid FROM accounts WHERE id = ?', accountId);
  const touched = new Map();
  db.exec('BEGIN');
  try {
    for (const m of msgs) {
      const chat = upsertChat(accountId, m, live);
      const pending = m.fromMe ? takePending(chat.id, m.text) : null;
      const by = m.fromMe ? (pending?.by || 'owner') : 'customer';
      const res = run('INSERT OR IGNORE INTO messages (chat_id, wa_id, from_me, by, type, text, ts) VALUES (?,?,?,?,?,?,?)', chat.id, m.waId, m.fromMe ? 1 : 0, by, m.type, m.text, m.ts);
      if (!res.changes) continue; // duplicate (already stored, or our own send echoed back)
      // A chat with messages from before this number was linked is not a "new lead".
      if (chat.is_new && account?.connected_at && m.ts < account.connected_at - 60_000) run('UPDATE chats SET is_new = 0 WHERE id = ?', chat.id);
      const t = touched.get(chat.id) || { chat, last: null, liveCustomer: false, liveOwner: false };
      if (!t.last || m.ts >= t.last.ts) t.last = m;
      if (live && !m.fromMe) t.liveCustomer = true;
      if (live && m.fromMe && !pending) {
        // A message the owner typed in their own "Message yourself" chat is a command, not a customer reply.
        if (connectors.get(accountId)?.isSelf?.(m.jid)) {
          if (account.self_jid !== m.jid) { run('UPDATE accounts SET self_jid = ? WHERE id = ?', m.jid, accountId); account.self_jid = m.jid; }
          t.command = m.text;
        } else t.liveOwner = true;
      }
      touched.set(chat.id, t);
    }
    for (const [chatId, t] of touched) {
      const prev = get('SELECT last_msg_at FROM chats WHERE id = ?', chatId);
      if (!prev.last_msg_at || t.last.ts >= prev.last_msg_at) run('UPDATE chats SET last_msg_at = ?, last_text = ? WHERE id = ?', t.last.ts, t.last.text.slice(0, 200), chatId);
      run(`UPDATE chats SET
             last_in_at  = (SELECT MAX(ts) FROM messages WHERE chat_id = ?1 AND from_me = 0),
             last_out_at = (SELECT MAX(ts) FROM messages WHERE chat_id = ?1 AND from_me = 1)
           WHERE id = ?1`, chatId);
      if (t.liveCustomer) run('UPDATE chats SET unread = unread + 1 WHERE id = ?', chatId);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    log('error', 'whatsapp', `Could not store messages: ${e.message}`);
    return;
  }
  if (!touched.size) return;
  if (!live) return emit('history', { accountId, chats: touched.size });
  for (const [chatId, t] of touched) {
    emit('chat', { chatId });
    if (t.command) handlers.onCommand(chatId, t.command);
    else if (t.liveCustomer) handlers.onCustomer(chatId);
    else if (t.liveOwner) handlers.onOwner(chatId);
  }
}

// ---------- sending ----------
/** Send one bubble and record it. `by` is ai | owner | followup. */
export async function sendText(chatId, text, by = 'ai') {
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat) throw new Error('Chat not found');
  const conn = connectors.get(chat.account_id);
  if (!conn || statusOf(chat.account_id).state !== 'connected') throw new Error('This WhatsApp number is not connected');
  const entry = { text, by, at: now() };
  pendingBot.set(chatId, [...(pendingBot.get(chatId) || []).filter((p) => now() - p.at < 120_000), entry]);
  let waId;
  try {
    waId = await conn.sendText(chat.jid, text, { lastInAt: chat.last_in_at });
  } catch (e) {
    takePending(chatId, text);
    throw e;
  }
  const ts = now();
  run('INSERT OR IGNORE INTO messages (chat_id, wa_id, from_me, by, type, text, ts) VALUES (?,?,1,?,?,?,?)', chatId, waId || `local-${ts}`, by, 'text', text, ts);
  run('UPDATE chats SET last_out_at = ?, last_msg_at = ?, last_text = ?, unread = 0 WHERE id = ?', ts, ts, text.slice(0, 200), chatId);
  emit('chat', { chatId });
  return waId;
}

export const typing = (chat, on) => connectors.get(chat.account_id)?.typing(chat.jid, on) ?? Promise.resolve();
export const markRead = (chat) => {
  run('UPDATE chats SET unread = 0 WHERE id = ?', chat.id);
  return connectors.get(chat.account_id)?.markRead(chat.jid) ?? Promise.resolve();
};
/** Business profile text of every connected number that can provide one. */
export async function profiles() {
  const out = [];
  for (const [id, conn] of connectors) {
    if (statusOf(id).state !== 'connected' || !conn.profile) continue;
    const text = await conn.profile().catch(() => '');
    if (text) out.push(text);
  }
  return out.join('\n\n');
}
export const idle = (accountId) => connectors.get(accountId)?.idle?.() ?? Promise.resolve();

/** Test hook: register a fake connector without touching WhatsApp. */
export function attachFake(accountId, conn) {
  connectors.set(accountId, conn);
  statuses.set(accountId, { state: 'connected', since: now() });
  return { deliver: (msgs, live = true) => ingest(accountId, msgs, live) };
}
