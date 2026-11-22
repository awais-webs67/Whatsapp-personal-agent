// Owns every connected number and is the single place messages enter and leave the database.
import { db, all, get, run, now, parse, update } from '../db.js';
import { decrypt, emit, log, kvGet, kvSet } from '../core.js';
import { QrConnector } from './baileys.js';
import { CloudConnector } from './cloud.js';

const connectors = new Map(); // accountId -> connector
const statuses = new Map();   // accountId -> { state, qr, pairingCode, me, error }
const pendingBot = new Map(); // chatId -> [{ text, by, at }] sends in flight, to recognise our own echoes
let handlers = { onCustomer: () => {}, onOwner: () => {}, onCommand: () => {}, onChatCommand: () => {} };
const CHAT_COMMAND = /^[/#!][a-z]+\b/i; // the exact list is checked by the handler
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
    onLabel: (l) => onLabel(account.id, l),
    // No labels known for this number yet (and not tried in the last day): load them from WhatsApp once.
    needsLabels: () => !get('SELECT 1 x FROM wa_label_chats WHERE account_id = ? LIMIT 1', account.id) && now() - (Number(kvGet(`labelsTried:${account.id}`)) || 0) > 86_400_000 && (kvSet(`labelsTried:${account.id}`, now()), true),
    onLabelsLoaded: () => { const n = get('SELECT COUNT(*) n FROM wa_labels WHERE account_id = ? AND deleted = 0', account.id).n; log('info', 'whatsapp', `${account.name}: ${n} WhatsApp label${n === 1 ? '' : 's'} loaded`); emit('labels', { accountId: account.id }); },
    onLabelChat: (jid, labelId, type) => onLabelChat(account.id, jid, labelId, type),
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
  const voicesOf = {};
  const account = get('SELECT connected_at, self_jid FROM accounts WHERE id = ?', accountId);
  const touched = new Map();
  db.exec('BEGIN');
  try {
    for (const m of msgs) {
      const chat = upsertChat(accountId, m, live);
      const pending = m.fromMe ? takePending(chat.id, m.text) : null;
      // "/stop", "#bought", "/remind 2h …" typed by the owner in a customer's chat: a command for the agent.
      // It is not stored as part of the conversation, and the handler deletes it for everyone.
      if (live && m.fromMe && !pending && CHAT_COMMAND.test(m.text) && !connectors.get(accountId)?.isSelf?.(m.jid) && handlers.isChatCommand?.(m.text)) {
        (touched.get(chat.id) || touched.set(chat.id, { chat, last: null, liveCustomer: false, liveOwner: false }).get(chat.id)).chatCommands = [
          ...((touched.get(chat.id)?.chatCommands) || []), { text: m.text, key: m.raw?.key, jid: m.jid }];
        continue;
      }
      const by = m.fromMe ? (pending?.by || 'owner') : 'customer';
      const quotedText = m.replyTo ? (m.replyText || get('SELECT text FROM messages WHERE chat_id = ? AND wa_id = ?', chat.id, m.replyTo)?.text || null) : null;
      const res = run('INSERT OR IGNORE INTO messages (chat_id, wa_id, from_me, by, type, text, ts, reply_to, reply_text) VALUES (?,?,?,?,?,?,?,?,?)', chat.id, m.waId, m.fromMe ? 1 : 0, by, m.type, m.text, m.ts, m.replyTo || null, quotedText ? String(quotedText).slice(0, 300) : null);
      if (!res.changes) continue; // duplicate (already stored, or our own send echoed back)
      if (live && (m.audio || m.image) && !m.fromMe) (voicesOf[chat.id] ||= []).push(m);
      if (m.ad && !m.fromMe) run('UPDATE chats SET ad_id = COALESCE(ad_id, ?), ad_title = COALESCE(ad_title, ?) WHERE id = ?', m.ad.id, m.ad.title, chat.id);
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
      if (!t.last) continue; // only commands arrived in this chat
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
  // Voice notes start turning into text now; the reply to that chat waits for them.
  for (const [chatId, list] of Object.entries(voicesOf)) for (const m of list) {
    if (m.audio) handlers.onVoice?.(Number(chatId), m.waId, m.audio.fetch, m.audio.mime);
    else handlers.onImage?.(Number(chatId), m.waId, m.image.fetch, m.image.mime);
  }
  for (const [chatId, t] of touched) {
    for (const c of t.chatCommands || []) handlers.onChatCommand(chatId, c.text, { accountId, key: c.key, jid: c.jid });
    if (!t.last) continue;
    emit('chat', { chatId });
    if (t.command) handlers.onCommand(chatId, t.command);
    else if (t.liveCustomer) handlers.onCustomer(chatId);
    else if (t.liveOwner) handlers.onOwner(chatId);
  }
}

// ---------- sending ----------
/** Send one bubble and record it. `by` is ai | owner | followup. */
export async function sendText(chatId, text, by = 'ai', { replyTo = null } = {}) {
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat) throw new Error('Chat not found');
  const conn = connectors.get(chat.account_id);
  if (!conn || statusOf(chat.account_id).state !== 'connected') throw new Error('This WhatsApp number is not connected');
  const entry = { text, by, at: now() };
  pendingBot.set(chatId, [...(pendingBot.get(chatId) || []).filter((p) => now() - p.at < 120_000), entry]);
  // Replying to one message: quote it on WhatsApp too.
  const q = replyTo ? get('SELECT wa_id, from_me, text FROM messages WHERE id = ? AND chat_id = ?', Number(replyTo), chatId) : null;
  const quote = q && !String(q.wa_id).startsWith('local-') ? { id: q.wa_id, fromMe: !!q.from_me, text: q.text } : null;
  let waId;
  try {
    waId = await conn.sendText(chat.jid, text, { lastInAt: chat.last_in_at, quote });
  } catch (e) {
    takePending(chatId, text);
    throw e;
  }
  const ts = now();
  run('INSERT OR IGNORE INTO messages (chat_id, wa_id, from_me, by, type, text, ts, reply_to, reply_text) VALUES (?,?,1,?,?,?,?,?,?)', chatId, waId || `local-${ts}`, by, 'text', text, ts, q?.wa_id || null, q ? String(q.text || '').slice(0, 300) : null);
  run('UPDATE chats SET last_out_at = ?, last_msg_at = ?, last_text = ?, unread = 0 WHERE id = ?', ts, ts, text.slice(0, 200), chatId);
  emit('chat', { chatId });
  return waId;
}

// ---------- WhatsApp Business labels <-> the agent's tags ----------
// A label "Canva Ad" on the phone is the tag "canva-ad" in the agent, so "canva-ad label walon ko bhejo" works.
export const labelTag = (name) => String(name || '').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const tagsOfChat = (c) => String(c?.tags || '').split(',').filter(Boolean);
const setTags = (chatId, list) => run('UPDATE chats SET tags = ? WHERE id = ?', list.length ? `,${[...new Set(list)].join(',')},` : null, chatId);

export function onLabel(accountId, l) {
  if (!l?.id) return;
  const before = get('SELECT * FROM wa_labels WHERE account_id = ? AND label_id = ?', accountId, String(l.id));
  run(`INSERT INTO wa_labels (account_id, label_id, name, color, deleted) VALUES (?,?,?,?,?)
       ON CONFLICT(account_id, label_id) DO UPDATE SET name = excluded.name, color = excluded.color, deleted = excluded.deleted`,
  accountId, String(l.id), l.name || before?.name || '', l.color ?? before?.color ?? null, l.deleted ? 1 : 0);
  // A label renamed on the phone: chats keep it under its new name.
  if (before && l.name && before.name !== l.name) {
    const oldTag = labelTag(before.name);
    for (const c of all('SELECT id, tags FROM chats WHERE account_id = ? AND tags LIKE ?', accountId, `%,${oldTag},%`)) setTags(c.id, tagsOfChat(c).map((t) => (t === oldTag ? labelTag(l.name) : t)));
  }
}

function chatByJid(accountId, jid) {
  return get('SELECT * FROM chats WHERE account_id = ? AND (jid = ? OR jid = ? OR phone = ?)', accountId, jid, String(jid).split('@')[0] + '@s.whatsapp.net', String(jid).split('@')[0]);
}

export function onLabelChat(accountId, jid, labelId, type) {
  // The phone's own record first, even for a chat or label we do not know yet.
  if (jid) {
    if (type === 'remove') run('DELETE FROM wa_label_chats WHERE account_id = ? AND label_id = ? AND jid = ?', accountId, String(labelId), String(jid));
    else run('INSERT OR IGNORE INTO wa_label_chats (account_id, label_id, jid) VALUES (?,?,?)', accountId, String(labelId), String(jid));
  }
  const label = get('SELECT * FROM wa_labels WHERE account_id = ? AND label_id = ?', accountId, String(labelId));
  const chat = chatByJid(accountId, jid);
  if (!label?.name || !chat) return;
  const tag = labelTag(label.name);
  const now_ = tagsOfChat(chat);
  setTags(chat.id, type === 'remove' ? now_.filter((t) => t !== tag) : [...now_, tag]);
  emit('chat', { chatId: chat.id });
}

/** "Flow Google", "google flow", "Google-Flow" are the same label: case, punctuation and word order do not matter. */
export const labelKey = (name) => String(name || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');
/** The labels of one number whose name means `name` (several when the phone has duplicates). */
export function findLabels(accountId, name) {
  const rows = all('SELECT * FROM wa_labels WHERE account_id = ? AND deleted = 0 ORDER BY CAST(label_id AS INTEGER)', accountId);
  // The exact name (any case) wins: "Google Flow" never means a different label called "Flow Google".
  const exact = rows.filter((l) => l.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
  return exact.length ? exact : rows.filter((l) => labelKey(l.name) === labelKey(name));
}
/** Every label on every number, with how many chats carry it. */
export function labelsList() {
  return all('SELECT l.*, a.name account FROM wa_labels l JOIN accounts a ON a.id = l.account_id WHERE l.deleted = 0 ORDER BY a.id, l.name').map((l) => ({
    account: l.account, accountId: l.account_id, id: l.label_id, name: l.name,
    // As the phone counts them.
    chats: get('SELECT COUNT(*) n FROM wa_label_chats WHERE account_id = ? AND label_id = ?', l.account_id, l.label_id).n,
  }));
}

/** Make each chat's label tags match the phone exactly: tags the phone does not have are taken off, missing ones added. */
export function reconcileLabelTags(accountId) {
  for (const l of all('SELECT * FROM wa_labels WHERE account_id = ?', accountId)) {
    const tag = labelTag(l.name);
    const onPhone = new Set(all('SELECT jid FROM wa_label_chats WHERE account_id = ? AND label_id = ?', accountId, l.label_id).map((r) => chatByJid(accountId, r.jid)?.id).filter(Boolean));
    for (const c of all('SELECT id, tags FROM chats WHERE account_id = ? AND tags LIKE ?', accountId, `%,${tag},%`)) if (l.deleted || !onPhone.has(c.id)) setTags(c.id, tagsOfChat(c).filter((t) => t !== tag));
    if (!l.deleted) for (const id of onPhone) { const c = get('SELECT id, tags FROM chats WHERE id = ?', id); if (!tagsOfChat(c).includes(tag)) setTags(id, [...tagsOfChat(c), tag]); }
  }
  emit('chat', {});
}
const making = new Map(); // accountId -> promise: one label is made at a time, so two orders never make two copies

/**
 * Put a label on a customer's chat on the phone (WhatsApp Business, QR-linked). An existing label with the same
 * name (any case or word order) is used; a new one is made only with { create: true }. Returns false when it
 * could not be put on.
 */
export async function applyLabel(chat, name, { create = false } = {}) {
  const conn = connectors.get(chat.account_id);
  if (!conn?.addChatLabel || !name) return false;
  try {
    let label = findLabels(chat.account_id, name)[0];
    if (!label) {
      if (!create) return false;
      const prev = making.get(chat.account_id) || Promise.resolve();
      const job = prev.then(async () => {
        const again = findLabels(chat.account_id, name)[0];
        if (again) return again;
        // Only on a number whose labels have synced: otherwise a new id could overwrite a label we do not know about.
        if (!get('SELECT 1 x FROM wa_labels WHERE account_id = ? LIMIT 1', chat.account_id)) throw new Error('the labels of this number have not synced yet');
        const max = get('SELECT MAX(CAST(label_id AS INTEGER)) m FROM wa_labels WHERE account_id = ?', chat.account_id).m || 0;
        const id = String(Number(max) + 1);
        await conn.createLabel(id, name);
        onLabel(chat.account_id, { id, name, color: 0 });
        return get('SELECT * FROM wa_labels WHERE account_id = ? AND label_id = ?', chat.account_id, id);
      });
      making.set(chat.account_id, job.catch(() => {}));
      label = await job;
    }
    await conn.addChatLabel(chat.jid, label.label_id);
    onLabelChat(chat.account_id, chat.jid, label.label_id, 'add');
    return true;
  } catch (e) {
    log('warn', 'whatsapp', `Could not put the label "${name}" on ${chat.name || chat.jid}: ${e.message}`);
    return false;
  }
}

/** Take one label off one chat on the phone. */
export async function removeLabel(chat, label) {
  const conn = connectors.get(chat.account_id);
  if (!conn?.removeChatLabel) return false;
  try {
    await conn.removeChatLabel(chat.jid, label.label_id);
    onLabelChat(chat.account_id, chat.jid, label.label_id, 'remove');
    return true;
  } catch (e) {
    log('warn', 'whatsapp', `Could not take the label "${label.name}" off ${chat.name || chat.jid}: ${e.message}`);
    return false;
  }
}

/** Load the labels of one number (or every connected number) from WhatsApp again. Returns how many are known. */
export async function refreshLabels(accountId = null) {
  const ids = accountId ? [Number(accountId)] : [...connectors.keys()];
  for (const id of ids) {
    const conn = connectors.get(id);
    if (!conn?.refreshLabels) continue;
    // Start from the phone's full list: old records are dropped, then the snapshot fills them again.
    const keep = all('SELECT * FROM wa_label_chats WHERE account_id = ?', id);
    run('DELETE FROM wa_label_chats WHERE account_id = ?', id);
    try {
      await conn.refreshLabels();
    } catch (e) {
      for (const r of keep) run('INSERT OR IGNORE INTO wa_label_chats (account_id, label_id, jid) VALUES (?,?,?)', r.account_id, r.label_id, r.jid);
      throw e;
    }
    reconcileLabelTags(id);
  }
  return get(`SELECT COUNT(*) n FROM wa_labels WHERE deleted = 0${accountId ? ' AND account_id = ?' : ''}`, ...(accountId ? [Number(accountId)] : [])).n;
}

/** Delete a label on the phone; WhatsApp takes it off every chat. */
export async function deleteLabel(accountId, label) {
  const conn = connectors.get(accountId);
  if (!conn?.deleteLabel) return false;
  await conn.deleteLabel(label.label_id, label.name, label.color || 0);
  onLabel(accountId, { id: label.label_id, name: label.name, color: label.color, deleted: true });
  return true;
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
/** Remove one of our own messages for everyone in the chat (used to hide an owner's command from the customer). */
export const deleteForEveryone = (accountId, jid, key) => connectors.get(accountId)?.deleteForEveryone?.(jid, key) ?? Promise.resolve();
export const idle = (accountId) => connectors.get(accountId)?.idle?.() ?? Promise.resolve();

/** Test hook: register a fake connector without touching WhatsApp. */
export function attachFake(accountId, conn) {
  connectors.set(accountId, conn);
  statuses.set(accountId, { state: 'connected', since: now() });
  return { deliver: (msgs, live = true) => ingest(accountId, msgs, live) };
}
