// The agent speaks first: task progress, things that need the owner, sales, a daily summary.
// Every update lands in a Command conversation (the one that started the task, or "Agent updates"),
// pops up on the dashboard, and is also sent to the owner's WhatsApp "Message yourself" chat.
import { all, get, run, now } from '../db.js';
import { getSettings, emit, log, kvGet, kvSet, hourIn } from '../core.js';
import * as wa from '../wa/manager.js';

function updatesThread() {
  const t = get("SELECT id FROM command_threads WHERE kind = 'updates' ORDER BY id LIMIT 1");
  if (t) return t.id;
  return Number(run("INSERT INTO command_threads (title, kind, created_at, updated_at) VALUES ('Agent updates', 'updates', ?, ?)", now(), now()).lastInsertRowid);
}

let lastWhatsApp = 0;
const waQueue = [];
let draining = false;
/** Send a line to the owner's own WhatsApp chat (known once they have written in "Message yourself"). */
export async function toWhatsApp(text) {
  if (getSettings().notifyWhatsApp === false) return false;
  waQueue.push(text);
  if (draining) return true;
  draining = true;
  try {
    while (waQueue.length) {
      // Several updates close together go out as one message, at most one every 20 seconds.
      const wait = lastWhatsApp + 20_000 - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const batch = waQueue.splice(0, waQueue.length).join('\n\n');
      const acct = all('SELECT id, self_jid FROM accounts WHERE self_jid IS NOT NULL AND enabled = 1').find((a) => wa.statusOf(a.id).state === 'connected');
      const chat = acct && get('SELECT id FROM chats WHERE account_id = ? AND jid = ?', acct.id, acct.self_jid);
      if (!chat) return false;
      lastWhatsApp = now();
      await wa.sendText(chat.id, batch.slice(0, 3500), 'ai').catch((e) => log('warn', 'updates', `Could not send the update to WhatsApp: ${e.message}`));
    }
  } finally {
    draining = false;
  }
  return true;
}

/**
 * Post an update from the agent.
 *  threadId: the conversation to put it in (defaults to "Agent updates")
 *  key:      updates with the same key are sent once per `everyMs` (no repeats of the same news)
 */
export function notify(text, { threadId = null, key = null, everyMs = 6 * 3_600_000, whatsapp = true } = {}) {
  const line = String(text || '').trim();
  if (!line) return false;
  if (key) {
    const seen = kvGet('updateKeys', {});
    if (seen[key] && now() - seen[key] < everyMs) return false;
    seen[key] = now();
    for (const k of Object.keys(seen)) if (now() - seen[k] > 7 * 86_400_000) delete seen[k];
    kvSet('updateKeys', seen);
  }
  const thread = threadId && get('SELECT 1 x FROM command_threads WHERE id = ?', threadId) ? threadId : updatesThread();
  run('INSERT INTO commands (role, text, steps, thread_id, ts) VALUES (?,?,?,?,?)', 'agent', line, '[]', thread, now());
  run('UPDATE command_threads SET updated_at = ? WHERE id = ?', now(), thread);
  emit('command', { thread });
  emit('update', { text: line, thread });
  if (whatsapp) toWhatsApp(line).catch(() => {});
  return true;
}

/** Show an update on the dashboard and WhatsApp without adding it to a conversation (it is already recorded elsewhere). */
export function announce(text) {
  emit('update', { text });
  toWhatsApp(text).catch(() => {});
}

const who = (c) => c.name || (c.phone ? `+${c.phone}` : String(c.jid || '').split('@')[0]);

/** The day so far, in a few lines. */
export function digest() {
  const since = now() - 86_400_000;
  const n = (sql, ...p) => get(sql, ...p).n;
  const needs = all('SELECT name, phone, jid, handoff_reason FROM chats WHERE needs_human = 1 ORDER BY last_msg_at DESC LIMIT 5');
  const tasks = all("SELECT title FROM tasks WHERE status = 'active' LIMIT 5");
  const lines = [
    `Daily summary: ${n('SELECT COUNT(*) n FROM chats WHERE is_new = 1 AND created_at > ?', since)} new leads, ${n('SELECT COUNT(*) n FROM messages WHERE from_me = 0 AND ts > ?', since)} messages in, ${n("SELECT COUNT(*) n FROM messages WHERE by = 'ai' AND ts > ?", since)} agent replies, ${n("SELECT COUNT(*) n FROM messages WHERE by = 'followup' AND ts > ?", since)} follow-ups sent.`,
    `Sales marked today: ${n("SELECT COUNT(*) n FROM chats WHERE stage = 'purchased' AND last_msg_at > ?", since)}. Interested or negotiating now: ${n("SELECT COUNT(*) n FROM chats WHERE stage IN ('interested','negotiating')")}.`,
    needs.length ? `Waiting for you (${n('SELECT COUNT(*) n FROM chats WHERE needs_human = 1')}): ${needs.map((c) => `${who(c)}${c.handoff_reason ? ` (${c.handoff_reason})` : ''}`).join('; ')}.` : 'Nobody is waiting for you.',
    tasks.length ? `Tasks running: ${tasks.map((t) => t.title).join('; ')}.` : null,
    n("SELECT COUNT(*) n FROM followups WHERE status = 'pending'") ? `${n("SELECT COUNT(*) n FROM followups WHERE status = 'pending'")} follow-up drafts wait for your approval.` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Once a day at the hour set in Settings (default 21:00, -1 turns it off). */
export function maybeDigest() {
  const s = getSettings();
  const hour = Number(s.digestHour ?? 21);
  if (!(hour >= 0 && hour <= 23)) return false;
  const day = new Date().toLocaleDateString('en-CA', { timeZone: s.followup.timezone });
  if (hourIn(s.followup.timezone) < hour || kvGet('digestDay', '') === day) return false;
  kvSet('digestDay', day);
  // Nothing happened and nothing is waiting: stay quiet.
  if (!get('SELECT COUNT(*) n FROM messages WHERE ts > ?', now() - 86_400_000).n && !get('SELECT COUNT(*) n FROM chats WHERE needs_human = 1').n) return false;
  return notify(digest());
}

export { who };
