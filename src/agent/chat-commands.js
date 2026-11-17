// Commands the owner types inside a customer's chat to steer the agent for that one customer.
// On WhatsApp: type "/stop" (or "#stop") in the customer's chat from your phone. The agent acts, deletes the
// command for everyone so the customer does not see it, and confirms in your "Message yourself" chat.
// On the dashboard: type the same in the Inbox reply box; it is never sent to the customer.
import { all, get, run, now, update } from '../db.js';
import { getSettings, emit, log } from '../core.js';
import { parseClock } from './intent.js';

const DUR = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|ghante|ghanta|d|day|days|din)$/i;
const ms = (n, unit) => n * (/^(d|day|days|din)$/i.test(unit) ? 86_400_000 : /^(m|min|mins|minute|minutes)$/i.test(unit) ? 60_000 : 3_600_000);
const title = (c) => c.name || (c.phone ? `+${c.phone}` : String(c.jid).split('@')[0]);

export const COMMANDS = [
  ['stop', 'Agent stops answering this customer and sends no follow-ups'],
  ['start', 'Agent answers this customer again (and replies now if they are waiting)'],
  ['auto', "Agent follows the number's rule for this chat again"],
  ['pause 2h', 'Agent stays quiet in this chat for a while (default 2 hours)'],
  ['reply', 'Agent answers the customer right now'],
  ['bought', 'Mark as purchased: stops follow-ups, counts as a sale'],
  ['lost', 'Mark as not interested: stops follow-ups'],
  ['followup 2h', 'Send a follow-up nudge after this long (or "now")'],
  ['nofollowup', 'No more follow-ups for this customer'],
  ['remind 18:30 message', 'Send this exact message at a time (2h, 1d, 18:30, kal 10 baje)'],
  ['note text', 'Add a note the agent will follow in this chat'],
  ['info', 'Stage, summary and follow-up plan of this chat'],
  ['help', 'This list'],
];
const NAMES = ['stop', 'off', 'band', 'start', 'on', 'chalu', 'auto', 'pause', 'reply', 'jawab', 'bought', 'sold', 'purchased', 'sale', 'lost', 'no', 'followup', 'fu', 'nofollowup', 'nofu', 'remind', 'reminder', 'note', 'info', 'status', 'help'];

/** "/stop", "#remind 2h ..." -> { cmd, rest } when it is one of ours, else null. */
export function parseChatCommand(text) {
  const m = String(text || '').trim().match(/^[/#!]([a-z]+)\b\s*([\s\S]*)$/i);
  if (!m || !NAMES.includes(m[1].toLowerCase())) return null;
  return { cmd: m[1].toLowerCase(), rest: m[2].trim() };
}

/** "2h" | "30m" | "1d" | "18:30" | "kal 10 baje" -> timestamp, plus the text after the time. */
export function parseWhen(rest) {
  const words = rest.split(/\s+/);
  const d = DUR.exec(words[0] || '');
  if (d) return { at: now() + ms(Number(d[1]), d[2]), text: words.slice(1).join(' ') };
  if (/^\d{1,2}:\d{2}$/.test(words[0] || '')) {
    const [h, mi] = words[0].split(':').map(Number);
    return { at: atClock(h, mi, /^(kal|tomorrow)$/i.test(words[1] || '')), text: words.slice(1).join(' ') };
  }
  // "kal 10 baje ...", "aaj sham 6 baje ..."
  const m = rest.match(/^((?:aaj|kal|tomorrow|today)?\s*(?:subah|sham|shaam|raat|dopahar)?\s*\d{1,2}(?::\d{2})?\s*(?:baje|am|pm))\s*([\s\S]*)$/i);
  if (m) {
    const clock = parseClock(m[1]);
    if (clock) { const [h, mi] = clock.split(':').map(Number); return { at: atClock(h, mi, /\b(kal|tomorrow)\b/i.test(m[1])), text: m[2] }; }
  }
  return { at: null, text: rest };
}

function atClock(h, mi, tomorrow) {
  const tz = getSettings().followup.timezone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  let delta = (h * 60 + mi) - (Number(parts.hour) * 60 + Number(parts.minute));
  if (tomorrow) delta += 1440; else if (delta <= 0) delta += 1440;
  return now() + delta * 60_000;
}

const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: getSettings().followup.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const cancelNudges = (chatId) => run("UPDATE followups SET status = 'skipped', error = 'Stopped by the owner' WHERE chat_id = ? AND status IN ('pending','approved') AND kind != 'reminder'", chatId);

/**
 * Run a chat command. `hooks` gives access to the live pipeline without an import cycle:
 * { answerNow(chatId) }. Returns the confirmation text for the owner.
 */
export function runChatCommand(chatId, text, hooks = {}) {
  const c = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!c) return 'Chat not found.';
  const parsed = parseChatCommand(text);
  if (!parsed) return `Not a command. Type /help for the list.`;
  const { cmd, rest } = parsed;
  const name = title(c);
  let out;
  switch (cmd) {
    case 'stop': case 'off': case 'band':
      update('chats', c.id, { ai_enabled: 0, next_followup_at: null }, ['ai_enabled', 'next_followup_at']);
      cancelNudges(c.id);
      out = `Agent stopped for ${name}: no replies, no follow-ups. Send /start to turn it back on.`;
      break;
    case 'start': case 'on': case 'chalu': {
      update('chats', c.id, { ai_enabled: 1, needs_human: 0, handoff_reason: null, paused_until: null }, ['ai_enabled', 'needs_human', 'handoff_reason', 'paused_until']);
      const waiting = c.last_in_at && (!c.last_out_at || c.last_in_at > c.last_out_at);
      if (waiting) hooks.answerNow?.(c.id);
      out = `Agent is on for ${name}.${waiting ? ' They are waiting, so it is answering now.' : ''}`;
      break;
    }
    case 'auto':
      update('chats', c.id, { ai_enabled: null }, ['ai_enabled']);
      out = `${name} now follows the number's rule again.`;
      break;
    case 'pause': {
      const d = DUR.exec(rest.split(/\s+/)[0] || '');
      const until = now() + (d ? ms(Number(d[1]), d[2]) : 2 * 3_600_000);
      update('chats', c.id, { paused_until: until }, ['paused_until']);
      out = `Agent is quiet in ${name}'s chat until ${when(until)}.`;
      break;
    }
    case 'reply': case 'jawab':
      update('chats', c.id, { paused_until: null, needs_human: 0, ...(c.ai_enabled === 0 ? { ai_enabled: 1 } : {}) }, ['paused_until', 'needs_human', 'ai_enabled']);
      hooks.answerNow?.(c.id);
      out = `Agent is answering ${name} now.`;
      break;
    case 'bought': case 'sold': case 'purchased': case 'sale':
      update('chats', c.id, { stage: 'purchased', next_followup_at: null }, ['stage', 'next_followup_at']);
      cancelNudges(c.id);
      out = `${name} marked as purchased. Follow-ups stopped.`;
      break;
    case 'lost': case 'no':
      update('chats', c.id, { stage: 'not_interested', next_followup_at: null }, ['stage', 'next_followup_at']);
      cancelNudges(c.id);
      out = `${name} marked as not interested. Follow-ups stopped.`;
      break;
    case 'followup': case 'fu': {
      const d = DUR.exec(rest.split(/\s+/)[0] || '');
      const at = /^(now|abhi)$/i.test(rest) || !rest ? now() : d ? now() + ms(Number(d[1]), d[2]) : null;
      if (!at) { out = 'Say when, e.g. /followup 3h, /followup 1d or /followup now.'; break; }
      update('chats', c.id, { next_followup_at: at, ...(c.stage === 'not_interested' ? { stage: 'engaged' } : {}) }, ['next_followup_at', 'stage']);
      out = `A follow-up for ${name} will be written ${at <= now() + 60_000 ? 'now' : `at ${when(at)}`}.`;
      break;
    }
    case 'nofollowup': case 'nofu':
      update('chats', c.id, { next_followup_at: null, followup_count: 99 }, ['next_followup_at', 'followup_count']);
      cancelNudges(c.id);
      out = `No more follow-ups for ${name} (until they write again).`;
      break;
    case 'remind': case 'reminder': {
      const { at, text: msg } = parseWhen(rest);
      if (!at || !msg.trim()) { out = 'Write it like: /remind 2h Aap ka order ready hai, or /remind kal 10 baje …'; break; }
      if (c.stage === 'opted_out') { out = `${name} asked not to be contacted.`; break; }
      run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, created_at) VALUES (?, 'reminder', ?, 'Asked by the owner', 'approved', ?, ?)", c.id, msg.trim().slice(0, 1500), at, now());
      out = `Reminder for ${name} at ${when(at)}: "${msg.trim().slice(0, 80)}"`;
      break;
    }
    case 'note': {
      if (!rest) { out = 'Write the note after /note.'; break; }
      const notes = [c.notes, rest].filter(Boolean).join('\n').slice(-2000);
      update('chats', c.id, { notes }, ['notes']);
      out = `Note saved for ${name}. The agent follows it in this chat.`;
      break;
    }
    case 'info': case 'status': {
      const q = all("SELECT kind, due_at FROM followups WHERE chat_id = ? AND status IN ('pending','approved') ORDER BY due_at", c.id);
      out = [`${name} · ${String(c.stage).replace('_', ' ')}${c.ai_enabled === 0 ? ' · agent OFF' : c.ai_enabled === 1 ? ' · agent ON' : ''}${c.needs_human ? ' · needs you' : ''}`,
        c.summary ? `Summary: ${c.summary}` : null,
        c.notes ? `Notes: ${c.notes.slice(0, 200)}` : null,
        c.next_followup_at ? `Next follow-up: ${when(c.next_followup_at)} (${c.followup_count} sent so far)` : `Follow-ups sent: ${c.followup_count > 50 ? 'stopped' : c.followup_count}`,
        q.length ? `Queued: ${q.map((x) => `${x.kind} ${when(x.due_at)}`).join(', ')}` : null].filter(Boolean).join('\n');
      break;
    }
    default:
      out = `Commands for this chat:\n${COMMANDS.map(([k, d]) => `/${k} – ${d}`).join('\n')}`;
  }
  log('info', 'command', `/${cmd} in ${name}'s chat`);
  emit('chat', { chatId: c.id });
  emit('followups');
  return out;
}
