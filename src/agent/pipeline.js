// Live conversation handling: wait for the customer to finish, think, then answer at a human pace.
import { get, run, now, update } from '../db.js';
import { getSettings, log, emit, sleep, rand } from '../core.js';
import * as wa from '../wa/manager.js';
import { decide, CLOSED } from './brain.js';

const timers = new Map(); // chatId -> debounce timer
const busy = new Set();   // chats currently being answered
const again = new Set();  // chats that got a new message while busy
const explained = new Set(); // "not answering because…" notes already logged

const OPT_OUT = /^\s*(stop|unsubscribe|remove me)\s*[.!]*\s*$|\b(don'?t|do not|dont)\s+(message|msg|text|contact|disturb)\s+me\b|\b(msg|message|messages)\s+(mat|na)\s+(karo|bhejo|bhejna|krna|karna)\b|\bmat\s+bhej/i;

/** Should the AI answer this chat on its own right now? Returns [ok, reason]. */
export function eligibility(chat, account, settings = getSettings()) {
  if (!settings.autopilot) return [false, 'autopilot is off'];
  if (!account?.enabled) return [false, 'number disabled'];
  if (chat.needs_human) return [false, 'waiting for a human'];
  if (chat.ai_enabled === 0) return [false, 'AI turned off for this chat'];
  if (chat.paused_until && chat.paused_until > now()) return [false, 'you replied by hand recently'];
  if (chat.ai_enabled === 1) return [true, ''];
  if (account.reply_mode === 'all') return [true, ''];
  if (account.reply_mode === 'new_only') return chat.is_new ? [true, ''] : [false, 'existing contact (number is set to "new leads only")'];
  return [false, 'number is set to manual'];
}

export function scheduleNextFollowup(chatId, hoursOverride = null) {
  const s = getSettings().followup;
  const chat = get('SELECT stage, followup_count FROM chats WHERE id = ?', chatId);
  if (!chat) return;
  const step = s.stepsHours[chat.followup_count];
  const hours = chat.followup_count === 0 && hoursOverride ? hoursOverride : step;
  const due = s.enabled && hours && !CLOSED.includes(chat.stage) ? now() + hours * 3_600_000 : null;
  update('chats', chatId, { next_followup_at: due }, ['next_followup_at']);
}

/** Called for every live customer message. */
export function onCustomer(chatId) {
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat) return;
  const last = get('SELECT text FROM messages WHERE chat_id = ? AND from_me = 0 ORDER BY ts DESC, id DESC LIMIT 1', chatId);
  // They answered: the follow-up sequence starts over, and queued nudges are no longer relevant.
  run('UPDATE chats SET followup_count = 0, next_followup_at = NULL WHERE id = ?', chatId);
  run("UPDATE followups SET status = 'skipped', error = 'Customer replied first' WHERE chat_id = ? AND status IN ('pending','approved')", chatId);
  if (last?.text && OPT_OUT.test(last.text)) {
    update('chats', chatId, { stage: 'opted_out' }, ['stage']);
    log('info', 'agent', `${chat.name || chat.phone || chat.jid} asked not to be contacted — follow-ups stopped`);
  }
  const account = get('SELECT * FROM accounts WHERE id = ?', chat.account_id);
  const [ok, why] = eligibility(chat, account);
  if (!ok) {
    // Say why, once per chat and reason, so a silent agent is never a mystery.
    const key = `${chatId}:${why}`;
    if (!explained.has(key)) { explained.add(key); log('info', 'agent', `Message from ${chat.name || chat.phone || chat.jid} stored, not answered: ${why}`); }
    return;
  }
  if (busy.has(chatId)) return void again.add(chatId);
  const h = getSettings().human;
  clearTimeout(timers.get(chatId));
  timers.set(chatId, setTimeout(() => { timers.delete(chatId); answer(chatId); }, rand(h.debounceMin, h.debounceMax) * 1000));
}

/** Called when the owner sends a message from their own phone or the inbox. */
export function onOwner(chatId) {
  const minutes = getSettings().human.handoffMinutes;
  clearTimeout(timers.get(chatId));
  timers.delete(chatId);
  update('chats', chatId, { paused_until: now() + minutes * 60_000, next_followup_at: null }, ['paused_until', 'next_followup_at']);
  emit('chat', { chatId });
}

const lastCustomerId = (chatId) => get('SELECT MAX(id) id FROM messages WHERE chat_id = ? AND from_me = 0', chatId)?.id || 0;

/** Send bubbles with read receipt, typing indicator and natural gaps. `spentMs` = thinking time already elapsed. */
export async function humanSend(chat, messages, by, spentMs = 0) {
  const h = getSettings().human;
  for (let i = 0; i < messages.length; i++) {
    const text = messages[i];
    const typeMs = Math.min(h.typingMaxSec, Math.max(1.2, text.length / rand(h.typingCpsMin, h.typingCpsMax))) * 1000;
    const wait = Math.max(600, typeMs - (i === 0 ? spentMs : 0));
    await wa.typing(chat, true);
    await sleep(wait);
    await wa.sendText(chat.id, text, by);
    await wa.typing(chat, false);
    if (i < messages.length - 1) await sleep(rand(h.gapMin, h.gapMax) * 1000);
  }
}

async function answer(chatId) {
  if (busy.has(chatId)) return void again.add(chatId);
  busy.add(chatId);
  try {
    const settings = getSettings();
    const h = settings.human;
    let chat = get('SELECT * FROM chats WHERE id = ?', chatId);
    const account = get('SELECT * FROM accounts WHERE id = ?', chat.account_id);
    const settle = wa.statusOf(account.id).settleUntil || 0;
    if (settle > now()) await sleep(settle - now());
    chat = get('SELECT * FROM chats WHERE id = ?', chatId);
    const [ok, why] = eligibility(chat, account, settings);
    if (!ok) return log('info', 'agent', `Not replying to ${chat.name || chat.phone || chat.jid}: ${why}`);

    const sentLastHour = get("SELECT COUNT(*) n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.account_id = ? AND m.by = 'ai' AND m.ts > ?", account.id, now() - 3_600_000).n;
    if (sentLastHour >= h.maxRepliesPerHour) {
      update('chats', chatId, { needs_human: 1, handoff_reason: 'Hourly reply cap reached' }, ['needs_human', 'handoff_reason']);
      return log('warn', 'agent', `Hourly cap of ${h.maxRepliesPerHour} replies reached on ${account.name}; ${chat.name || chat.jid} left for you`);
    }

    // Start thinking immediately; the read receipt and typing indicator play out while the model works.
    let seen = lastCustomerId(chatId);
    let started = now();
    let pending = decide(chatId, 'reply');
    pending.catch(() => {});
    await sleep(rand(h.readMin, h.readMax) * 1000);
    await wa.markRead(chat);
    await wa.typing(chat, true);
    let decision = await pending;
    for (let round = 0; round < 2 && lastCustomerId(chatId) !== seen; round++) {
      // They wrote more while we were thinking: answer the whole thing instead.
      seen = lastCustomerId(chatId);
      started = now();
      decision = await decide(chatId, 'reply');
    }

    // The owner may have stepped in while the model was thinking.
    chat = get('SELECT * FROM chats WHERE id = ?', chatId);
    if (!eligibility(chat, account)[0]) return void wa.typing(chat, false);

    update('chats', chatId, {
      stage: decision.stage, summary: decision.summary,
      needs_human: decision.handoff ? 1 : 0, handoff_reason: decision.handoff ? decision.handoffReason || 'Agent asked for help' : null,
    }, ['stage', 'summary', 'needs_human', 'handoff_reason']);

    await humanSend(chat, decision.messages, 'ai', now() - started);
    scheduleNextFollowup(chatId, decision.followupHours);
    log('info', 'agent', `Replied to ${chat.name || chat.phone || chat.jid} via ${decision.provider} (${(decision.latencyMs / 1000).toFixed(1)}s)`);
    if (decision.handoff) log('warn', 'agent', `${chat.name || chat.phone || chat.jid} needs you: ${decision.handoffReason || 'agent asked for help'}`);
    emit('chat', { chatId });
  } catch (e) {
    const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
    if (chat) {
      wa.typing(chat, false).catch(() => {});
      update('chats', chatId, { needs_human: 1, handoff_reason: `AI could not reply: ${e.message}`.slice(0, 200) }, ['needs_human', 'handoff_reason']);
      emit('chat', { chatId });
    }
    log('error', 'agent', `Reply failed for chat ${chatId}: ${e.message}`);
  } finally {
    busy.delete(chatId);
    if (again.delete(chatId)) onCustomer(chatId);
  }
}

export function startPipeline() {
  wa.setHandlers({ onCustomer, onOwner });
}
