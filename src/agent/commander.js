// Owner commands in plain language ("check the last 5 days and follow up every 5 minutes").
// The model picks one tool at a time, sees the result, and continues until it can answer.
// Works with any provider: tools are requested as plain JSON, no vendor tool-calling API needed.
import { all, get, run, now, update } from '../db.js';
import { getSettings, saveSettings, emit, log } from '../core.js';
import { complete } from '../llm/router.js';
import { toolCallToJson } from '../llm/client.js';
import * as wa from '../wa/manager.js';
import { STAGES, extractJson } from './brain.js';
import { runCampaign, campaign, whyNotSending } from './followups.js';
import { createTask, listTasks, taskView, controlTask, setTaskRunner, setCampaign, nextRun } from './tasks.js';
import { quickIntent, ASKS_PERMISSION } from './intent.js';
import { shortcut } from './shortcuts.js';
import { normTags, hasAnyTag } from './tags.js';
import { humanSend } from './pipeline.js';
import { learnFromChats, learnFromWebsite, learnFromProfile } from './learn.js';

const MAX_STEPS = 8;
const DAY = 86_400_000;
const clip = (t, n) => { const v = String(t ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const title = (c) => c.name || (c.phone ? `+${c.phone}` : c.jid.split('@')[0]);
const days = (v, d = 7) => Math.min(3650, Math.max(0.01, Number(v) || d));
const stageList = (v) => (Array.isArray(v) ? v.filter((s) => STAGES.includes(s)) : []);

function targets({ days: d, stages, includePurchased = false, tags = [] }) {
  const st = stageList(stages);
  const tg = normTags(tags);
  // Tagged people are the owner's explicit choice: buyers with that tag are included too.
  if (tg.length && !st.length) includePurchased = true;
  return all(`SELECT c.* FROM chats c WHERE c.last_in_at >= ? AND c.stage != 'opted_out'
              AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
              ${st.length ? `AND c.stage IN (${st.map(() => '?').join(',')})` : includePurchased ? '' : "AND c.stage != 'purchased'"}
              ORDER BY c.last_in_at DESC LIMIT 5000`, now() - days(d) * DAY, ...st).filter((c) => hasAnyTag(c, tg)).slice(0, 500);
}

const TOOLS = {
  stats: {
    doc: 'stats {"days": 7} - numbers for the period: new chats, messages, replies, stages.',
    run: ({ days: d }) => {
      const since = now() - days(d) * DAY;
      const n = (sql, ...p) => get(sql, ...p).n;
      return {
        chats_active: n('SELECT COUNT(*) n FROM chats WHERE last_in_at >= ?', since),
        messages_in: n('SELECT COUNT(*) n FROM messages WHERE from_me = 0 AND ts >= ?', since),
        agent_replies: n("SELECT COUNT(*) n FROM messages WHERE by = 'ai' AND ts >= ?", since),
        followups_sent: n("SELECT COUNT(*) n FROM messages WHERE by = 'followup' AND ts >= ?", since),
        needs_owner: n('SELECT COUNT(*) n FROM chats WHERE needs_human = 1'),
        followups_waiting_approval: n("SELECT COUNT(*) n FROM followups WHERE status = 'pending'"),
        followups_queued: n("SELECT COUNT(*) n FROM followups WHERE status = 'approved'"),
        by_stage: Object.fromEntries(all('SELECT stage, COUNT(*) n FROM chats WHERE last_in_at >= ? GROUP BY stage', since).map((r) => [r.stage, r.n])),
      };
    },
  },
  find_chats: {
    doc: `find_chats {"days": 5, "stages": ["interested"], "text": "website", "limit": 20} - list chats active in the period. "stages" and "text" are optional. Stages: ${STAGES.join(', ')}.`,
    run: ({ days: d, stages, text, limit }) => {
      const st = stageList(stages);
      const rows = all(`SELECT * FROM chats WHERE last_in_at >= ? ${st.length ? `AND stage IN (${st.map(() => '?').join(',')})` : ''}
                        ${text ? 'AND (name LIKE ? OR phone LIKE ? OR summary LIKE ? OR last_text LIKE ?)' : ''} ORDER BY last_in_at DESC LIMIT ?`,
        now() - days(d) * DAY, ...st, ...(text ? Array(4).fill(`%${text}%`) : []), Math.min(25, Number(limit) || 10));
      const total = get(`SELECT COUNT(*) n FROM chats WHERE last_in_at >= ? ${st.length ? `AND stage IN (${st.map(() => '?').join(',')})` : ''}`, now() - days(d) * DAY, ...st).n;
      return { total, shown: rows.length, chats: rows.map((c) => ({ id: c.id, name: title(c), stage: c.stage, about: clip(c.summary || c.last_text, 90), hours_ago: Math.round((now() - c.last_in_at) / 3_600_000), ...(c.needs_human ? { needs_owner: true } : {}) })) };
    },
  },
  read_chat: {
    doc: 'read_chat {"chat_id": 12} - the last 30 messages of one chat.',
    run: ({ chat_id }) => {
      const c = get('SELECT * FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      const rows = all('SELECT from_me, by, text, ts FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 16) ORDER BY ts, id', c.id);
      return { name: title(c), stage: c.stage, summary: c.summary, messages: rows.map((m) => `${m.from_me ? (m.by === 'owner' ? 'Owner' : 'Agent') : 'Customer'}: ${clip(m.text, 200)}`) };
    },
  },
  count_targets: {
    doc: 'count_targets {"days": 5, "stages": [], "tags": []} - how many people a follow-up batch would reach (purchased and opted-out are excluded unless a stage is listed). Use before start_followups.',
    run: (a) => { const t = targets(a); return { people: t.length, examples: t.slice(0, 5).map(title) }; },
  },
  start_followups: {
    doc: 'start_followups {"days": 5, "stages": [], "instruction": "what to say / who it is for", "interval_minutes": 5, "limit": 100, "send": true, "ignore_quiet_hours": false, "audience": "all|buyers|non_buyers", "tags": []} - read each matching chat, write a personal message following the instruction, and schedule them one by one with the interval. "send": true queues them to go out automatically; false leaves them as drafts for the owner to approve. Set "ignore_quiet_hours": true only if the owner says to send at night too. "audience": "buyers" when the owner means people who already bought (a renewal or after-sale reminder), "non_buyers" for people who did not buy, "all" otherwise. "tags": only customers with one of these tags (labels the owner put on chats, e.g. ["vip"]); give "days": 365 with tags unless the owner names a period.',
    run: async (a) => {
      const audience = ['buyers', 'non_buyers'].includes(a.audience) ? a.audience : 'all';
      const t = targets({ ...a, includePurchased: audience === 'buyers' });
      const tags = normTags(a.tags);
      if (!t.length) return { started: false, reason: 'No chats match' };
      const s = getSettings().followup;
      const range = nums(a.interval_minutes).filter((n) => n > 0);
      const interval = range.length >= 2 ? [Math.min(...range), Math.max(...range)] : Math.max(1, range[0] || 5);
      const taskId = createTask({ kind: 'batch', threadId: activeThread, ignoreQuiet: !!a.ignore_quiet_hours, title: `${audience === 'buyers' ? 'Reminders to buyers' : 'Follow-ups'}: ${String(a.instruction || 'quiet leads').slice(0, 80)}`, instruction: `${{ buyers: 'People who bought, ', non_buyers: 'People who did not buy, ', all: '' }[audience]}last ${days(a.days)} days${stageList(a.stages).length ? `, stages ${stageList(a.stages).join(', ')}` : ''}, every ${interval} min, ${a.send ? 'sends automatically' : 'drafts for approval'}. ${a.instruction || ''}`.trim() });
      await runCampaign({ taskId, sinceDays: days(a.days), limit: Math.min(500, Number(a.limit) || 100), reanalyze: true, instruction: String(a.instruction || '').slice(0, 600), autoApprove: !!a.send, intervalMinutes: interval, stages: stageList(a.stages), audience, tags });
      if (!campaign.total) run("UPDATE tasks SET status = 'removed' WHERE id = ?", taskId); // nothing to do: no empty task left behind
      return { started: campaign.total > 0, ...(campaign.total ? {} : { reason: 'every matching chat already has a follow-up waiting, or has too few messages to follow up on' }), task_id: taskId, chats_being_read: campaign.total, interval_minutes: interval, mode: a.send ? 'sends automatically' : 'drafts wait for approval',
        limits: `at most ${s.dailyCap} per number per day; nothing is sent between ${s.quietStart}:00 and ${s.quietEnd}:00 (${s.timezone}); people who would not benefit are skipped` };
    },
  },
  schedule_task: {
    doc: 'schedule_task {"instruction": "what to do each time, in the owner\'s words", "every_minutes": 30} or {"instruction": "...", "daily_at": "10:00"} or {"instruction": "...", "at": "18:30"} - set up a task that runs later or repeatedly. The instruction is carried out like a new request each time.',
    run: (a) => {
      const schedule = a.every_minutes ? { type: 'every', minutes: Number(a.every_minutes) } : a.daily_at ? { type: 'daily', time: String(a.daily_at) } : { type: 'once', at: a.at ? String(a.at) : undefined };
      const id = createTask({ kind: 'scheduled', threadId: activeThread, instruction: String(a.instruction || ''), title: a.title, schedule });
      const t = taskView(get('SELECT * FROM tasks WHERE id = ?', id));
      return { task_id: id, schedule: t.scheduleText, first_run: t.next_run_at ? new Date(t.next_run_at).toISOString() : null };
    },
  },
  list_tasks: {
    doc: 'list_tasks {} - the owner\'s tasks with status, schedule and progress.',
    run: () => listTasks().slice(0, 15).map((t) => ({ id: t.id, title: t.title, status: t.status, schedule: t.scheduleText, ...(t.progress ? { progress: t.progress } : {}), last_result: clip(t.last_result, 120) })),
  },
  pause_task: { doc: 'pause_task {"id": 3}', run: ({ id }) => ({ status: controlTask(id, 'pause').status }) },
  resume_task: { doc: 'resume_task {"id": 3}', run: ({ id }) => ({ status: controlTask(id, 'resume').status }) },
  remove_task: { doc: 'remove_task {"id": 3} - stop it and cancel its queued messages.', run: ({ id }) => ({ status: controlTask(id, 'remove').status }) },
  remind: {
    doc: 'remind {"customer": "name or phone number", "text": "the exact message to send", "at": "18:30" | "2026-12-01T10:00" | "in 2 hours"} - send one customer a message at a set time (a reminder). Leave "at" out to send it now.',
    run: ({ customer, text, at }) => {
      const q = String(customer || '').trim();
      const body = String(text || '').trim();
      if (!q || !body) return { error: 'Say who to remind and what to tell them' };
      const digits = q.replace(/\D/g, '');
      const found = digits.length >= 7
        ? all("SELECT * FROM chats WHERE phone LIKE ? OR jid LIKE ? ORDER BY last_msg_at DESC LIMIT 5", `%${digits.slice(-10)}%`, `%${digits.slice(-10)}%`)
        : all('SELECT * FROM chats WHERE name LIKE ? ORDER BY last_msg_at DESC LIMIT 5', `%${q}%`);
      if (!found.length) return { error: `No chat found for "${q}"` };
      if (found.length > 1 && !found.some((c) => (c.name || '').toLowerCase() === q.toLowerCase())) return { error: `More than one chat matches "${q}": ${found.map(title).join(', ')}. Say which one.` };
      const c = found.find((x) => (x.name || '').toLowerCase() === q.toLowerCase()) || found[0];
      if (c.stage === 'opted_out') return { error: `${title(c)} asked not to be contacted` };
      const rel = /in\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|ghante|ghanta|day|days|din)/i.exec(String(at || ''));
      const due = !at ? now()
        : rel ? now() + Number(rel[1]) * (/^(hour|hours|ghante|ghanta)$/i.test(rel[2]) ? 3_600_000 : /^(day|days|din)$/i.test(rel[2]) ? 86_400_000 : 60_000)
        : nextRun({ type: 'once', at: String(at) });
      if (!due || Number.isNaN(due)) return { error: `Could not understand the time "${at}"` };
      run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, created_at) VALUES (?, 'reminder', ?, 'Asked by the owner', 'approved', ?, ?)", c.id, body.slice(0, 1500), Math.max(due, now()), now());
      emit('followups');
      return { reminder_for: title(c), at: new Date(Math.max(due, now())).toISOString() };
    },
  },
  analyse_chats: {
    doc: 'analyse_chats {"days": 90, "again": false} - read the customer chats of the period, record each one\'s stage and summary, then learn the owner\'s offers, prices and tone from them. Chats read before with nothing new since are skipped; "again": true reads them all again (only when the owner says again / dobara). Sends nothing.',
    run: async (a) => {
      const taskId = createTask({ kind: 'analysis', threadId: activeThread, title: `Read and learn from chats (last ${days(a.days, 90)} days)`, instruction: 'Read every customer chat, record its stage and summary, then learn offers, prices and tone from the chats the owner answered.' });
      await runCampaign({ taskId, analyzeOnly: true, sinceDays: days(a.days, 90), limit: Math.min(1000, Number(a.limit) || 300), reanalyze: !!a.again });
      if (!campaign.total) run("UPDATE tasks SET status = 'removed' WHERE id = ?", taskId);
      if (campaign.total) return { started: true, task_id: taskId, chats_being_read: campaign.total };
      const read = get('SELECT COUNT(*) n FROM chats WHERE last_in_at >= ? AND analyzed_at >= COALESCE(last_msg_at, 0)', now() - days(a.days, 90) * DAY).n;
      return read
        ? { started: false, already_read: read, reason: `all ${read} chats of this period were already read and nothing new was said since, so no AI requests were needed. Their stage and summary are in the Inbox. Say "dobara parho" to read them all again` }
        : { started: false, reason: 'no customer chats are stored for that period yet. Link a WhatsApp number and let its history sync' };
    },
  },
  change_settings: {
    doc: 'change_settings {"autopilot": true, "followups": true, "reading": true, "ask_before_sending": false, "followup_gap_minutes": [6, 25], "followup_after_hours": [24, 72, 168], "quiet_hours": [21, 9], "daily_cap": 40, "reply_delay_seconds": [2, 4]} - switch things on/off and change timings; send only the keys the owner mentioned. autopilot = the agent answers customers by itself; followups = automatic follow-ups for quiet leads; reading = keep reading chats that changed; followup_gap_minutes = random gap between two follow-up messages; followup_after_hours = when to nudge a quiet lead; quiet_hours = [start, end] hours with no proactive messages; reply_delay_seconds = how long it waits before answering.',
    run: (a) => applySettings(a),
  },
  stop_followups: {
    doc: 'stop_followups {} - stop the running batch and cancel everything queued to send.',
    run: () => {
      campaign.cancel = true;
      const { changes } = run("UPDATE followups SET status = 'skipped', error = 'Cancelled by owner' WHERE status = 'approved'");
      emit('followups');
      return { cancelled: Number(changes) };
    },
  },
  send_message: {
    doc: 'send_message {"chat_id": 12, "text": "..."} - send one message to one customer now, typed at a human pace.',
    run: async ({ chat_id, text }) => {
      const c = get('SELECT * FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      if (c.stage === 'opted_out') return { error: 'This person asked not to be contacted' };
      if (!String(text || '').trim()) return { error: 'Empty message' };
      await humanSend(c, [String(text).trim().slice(0, 1200)], 'ai');
      return { sent_to: title(c) };
    },
  },
  update_chat: {
    doc: `update_chat {"chat_id": 12, "stage": "purchased", "notes": "...", "agent": "on|off|auto"} - change a chat's stage, notes for the agent, or whether the agent answers it. All fields optional.`,
    run: ({ chat_id, stage, notes, agent }) => {
      const c = get('SELECT id FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      const patch = {};
      if (STAGES.includes(stage)) patch.stage = stage;
      if (notes !== undefined) patch.notes = String(notes).slice(0, 2000);
      if (['on', 'off', 'auto'].includes(agent)) Object.assign(patch, { ai_enabled: agent === 'auto' ? null : agent === 'on' ? 1 : 0, ...(agent !== 'off' ? { needs_human: 0, paused_until: null } : {}) });
      update('chats', c.id, patch, ['stage', 'notes', 'ai_enabled', 'needs_human', 'paused_until']);
      emit('chat', { chatId: c.id });
      return { updated: Object.keys(patch) };
    },
  },
  remember: {
    doc: 'remember {"text": "Eid sale: 20% off all packages until 30 June"} - save a fact or rule the agent must use in every customer chat from now on.',
    run: ({ text }) => {
      const line = String(text || '').trim().slice(0, 600);
      if (!line) return { error: 'Nothing to remember' };
      const prev = getSettings().business.memory || '';
      saveSettings({ business: { memory: `${prev ? `${prev}\n` : ''}- ${line}` } });
      return { remembered: line };
    },
  },
  learn: {
    doc: 'learn {"source": "chats|website|profile", "url": "https://..."} - train the agent: from the owner\'s past chats, from a website (url required), or from the WhatsApp business profile and catalogue.',
    run: async ({ source, url }) => {
      if (source === 'website') { const r = await learnFromWebsite(String(url || '')); return { pages_read: r.pages, learned: r.text.slice(0, 700) }; }
      if (source === 'profile') { const r = await learnFromProfile(await wa.profiles()); return { learned: r.text.slice(0, 700) }; }
      const l = await learnFromChats({});
      return { started: true, conversations: l.chats, note: 'Runs in the background; the result appears on the Knowledge page.' };
    },
  },
  set_autopilot: {
    doc: 'set_autopilot {"on": true} - turn automatic replying on or off for every number.',
    run: ({ on }) => { saveSettings({ autopilot: !!on }); return { autopilot: !!on }; },
  },
};

const nums = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
/** Settings the owner can change by talking to the agent. Returns what changed, in plain words. */
export function applySettings(a = {}) {
  const patch = {};
  const done = [];
  const onOff = (v) => (v ? 'on' : 'off');
  if (typeof a.autopilot === 'boolean') { patch.autopilot = a.autopilot; done.push(`auto replies to customers ${onOff(a.autopilot)}`); }
  if (typeof a.followups === 'boolean') {
    patch.followup = { ...patch.followup, enabled: a.followups };
    let cancelled = 0;
    if (!a.followups) { campaign.cancel = true; cancelled = Number(run("UPDATE followups SET status = 'skipped', error = 'Follow-ups switched off' WHERE status IN ('approved','pending')").changes); emit('followups'); }
    done.push(`automatic follow-ups ${onOff(a.followups)}${cancelled ? ` (${cancelled} waiting message${cancelled === 1 ? '' : 's'} cancelled)` : ''}`);
  }
  if (typeof a.reading === 'boolean') { patch.reading = { auto: a.reading }; done.push(`reading new chats ${onOff(a.reading)}`); }
  if (typeof a.ask_before_sending === 'boolean') { patch.followup = { ...patch.followup, approval: a.ask_before_sending }; done.push(a.ask_before_sending ? 'follow-ups wait for your approval' : 'follow-ups go out without asking'); }
  const gap = nums(a.followup_gap_minutes);
  if (gap.length) { const lo = Math.min(...gap), hi = Math.max(...gap); patch.followup = { ...patch.followup, gapMinSec: Math.round(lo * 60), gapMaxSec: Math.round(hi * 60) }; done.push(`follow-ups spaced randomly ${lo} to ${hi} minutes apart`); }
  const after = nums(a.followup_after_hours).filter((n) => n > 0);
  if (after.length) { patch.followup = { ...patch.followup, stepsHours: after.slice(0, 6) }; done.push(`quiet leads nudged after ${after.join(', ')} hours`); }
  const quiet = nums(a.quiet_hours);
  if (quiet.length === 2 && quiet.every((h) => h <= 24)) { patch.followup = { ...patch.followup, quietStart: quiet[0] % 24, quietEnd: quiet[1] % 24 }; done.push(`no proactive messages from ${quiet[0]}:00 to ${quiet[1]}:00`); }
  if (Number(a.daily_cap) > 0) { patch.followup = { ...patch.followup, dailyCap: Math.round(Number(a.daily_cap)) }; done.push(`at most ${Math.round(Number(a.daily_cap))} follow-ups a day per number`); }
  const delay = nums(a.reply_delay_seconds);
  if (delay.length) { const lo = Math.min(...delay), hi = Math.max(...delay); patch.human = { debounceMin: lo, debounceMax: Math.max(hi, lo) }; done.push(`replies after ${lo} to ${hi} seconds`); }
  if (!done.length) return { changed: [], note: 'Nothing recognised to change' };
  saveSettings(patch);
  emit('settings');
  return { changed: done };
}

function systemPrompt(scheduled = false) {
  const s = getSettings();
  return `You are the operations assistant of ${s.business.name || 'a business'}'s WhatsApp agent. The business OWNER is talking to you (not a customer). Carry out what they ask using the actions below, then report back briefly in the owner's language.

Today is ${new Date().toLocaleString('en-GB', { timeZone: s.followup.timezone, dateStyle: 'full', timeStyle: 'short' })} (${s.followup.timezone}). Autopilot is ${s.autopilot ? 'on' : 'off'}.${scheduled ? '\nThis request is a scheduled task the owner set up earlier and already approved: carry it out without asking for confirmation, then report what you did in one or two sentences. Do not create new scheduled tasks from it.' : ''}\nWhen the owner asks for something later or repeatedly ("every 30 minutes", "roz subah 10 baje", "at 6 pm"), use schedule_task. Batches of follow-ups appear as tasks the owner can pause or remove.

## Actions you can take
${Object.values(TOOLS).map((t) => `- ${t.doc}`).join('\n')}

## How to answer
Reply with ONLY one JSON object each turn, as plain text (no function-calling syntax):
- to take an action: {"action": "stats", "args": {"days": 5}}
- when finished or when you need something from the owner: {"reply": "your message to the owner"}
You get the result back and can then take another action or reply. At most ${MAX_STEPS} actions per request.

## Rules
- The owner's message is the go-ahead. Never ask "should I?", "kya main kar dun?" or for confirmation: take the action in the same turn, using sensible defaults for anything not said (last 7 days, one message every 5 minutes, "send": true). Ask a question only when you truly cannot act, for example a time is missing for a daily task or a named customer cannot be found.
- Never promise the owner something an action result did not confirm. Report what the tool result says, including limits.
- Batches skip people who bought or opted out unless the owner asks for a stage by name; people who asked not to be contacted are never messaged.
- "Every N minutes" means interval_minutes N. Only use the actions listed above.
- Talk to the owner in plain words. Never mention action names, arguments or JSON in your reply; say what you did or what you need instead ("I could not open the site: …", not "use the remember tool").`;
}

/** Run one owner request through the tool loop. */
// The owner asked for something to be done (not just a question).
const ACTION_ASK = /bhej|send|follow|remind|yaad|confirm|schedule|har \d|every|daily|roz|start|shuru|pause|roko|band kar|remove|hata|message|msg|offer/i;
// The reply claims work is happening.
const CLAIMS_WORK = /kar raha|kar rahi|kar raha hun|working|on it|started|shuru|ho gaya|done|bhej (diya|di|raha|rahi|deta|dunga)|sending|will send|bhejta|bhejun|scheduled|set up|queued|kar diya|kar deta|theek hai|ok\b|okay/i;

/** What really happened, written by the app (not the model), so the owner can trust it. */
function facts(steps) {
  const out = [];
  for (const s of steps) {
    const r = s.result || {};
    if (r.error) { out.push(`⚠️ ${s.action.replace(/_/g, ' ')} failed: ${r.error}`); continue; }
    if (s.action === 'start_followups') {
      if (!r.started) out.push(`⚠️ Nothing started: ${r.reason || 'no chats matched'}.`);
      else {
        const why = whyNotSending(r.task_id);
        out.push(`📋 Task #${r.task_id} started: reading ${r.chats_being_read} chat${r.chats_being_read === 1 ? '' : 's'}, one message every ${Array.isArray(r.interval_minutes) ? `${r.interval_minutes[0]} to ${r.interval_minutes[1]} min (random)` : `${r.interval_minutes} min`}, ${r.mode}. Progress is on the Tasks page.${why ? `\n⚠️ Not sending yet: ${why}` : ''}`);
      }
    }
    if (s.action === 'analyse_chats' && !r.started && r.reason) out.push(`ℹ️ ${r.reason[0].toUpperCase()}${r.reason.slice(1)}.`);
    if (s.action === 'change_settings') out.push(r.changed?.length ? `⚙️ Changed: ${r.changed.join('; ')}.` : '⚠️ Nothing was changed.');
    if (s.action === 'remind' && r.reminder_for) out.push(`⏰ Reminder for ${r.reminder_for} at ${new Date(r.at).toLocaleString('en-GB', { timeZone: getSettings().followup.timezone, dateStyle: 'medium', timeStyle: 'short' })}. You get a message when it is sent.`);
    if (s.action === 'analyse_chats') out.push(r.started ? `📋 Task #${r.task_id} started: reading ${r.chats_being_read} chat${r.chats_being_read === 1 ? '' : 's'} in full, then learning from them. Progress is on the Tasks page.` : `⚠️ Nothing started: ${r.reason}.`);
    if (s.action === 'schedule_task') out.push(`⏰ Task #${r.task_id}: ${r.schedule}${r.first_run ? `, first run ${new Date(r.first_run).toLocaleString('en-GB', { timeZone: getSettings().followup.timezone, dateStyle: 'medium', timeStyle: 'short' })}` : ''}.`);
    if (s.action === 'send_message' && r.sent_to) out.push(`✉️ Sent to ${r.sent_to}.`);
    if (['pause_task', 'resume_task', 'remove_task'].includes(s.action)) out.push(`Task #${s.args.id}: ${r.status}.`);
    if (s.action === 'stop_followups') out.push(`⏹ ${r.cancelled} queued message${r.cancelled === 1 ? '' : 's'} cancelled.`);
    if (s.action === 'remember') out.push(`📝 Saved: ${r.remembered}`);
  }
  return out;
}
const withFacts = (reply, steps) => [reply, ...facts(steps)].filter(Boolean).join('\n');

export async function runCommand(text, history = [], { scheduled = false } = {}) {
  // The owner's own shortcuts: teach, list, remove, or expand one into the full instruction.
  const sc = shortcut(text);
  if (sc?.reply) return { reply: sc.reply, steps: [] };
  if (sc?.text) text = sc.text;
  // Orders the app understands by itself run straight away: no model, no "should I?".
  const quick = quickIntent(text, { scheduled });
  if (quick && TOOLS[quick.action]) {
    let result;
    try { result = await TOOLS[quick.action].run(quick.args); } catch (e) { result = { error: e.message }; }
    log('info', 'command', `${quick.action} ${JSON.stringify(quick.args).slice(0, 200)}`);
    const steps = [{ action: quick.action, args: quick.args, result }];
    const ok = !result?.error && result?.started !== false;
    const said = quick.action === 'change_settings' ? 'Theek hai, kar diya.' : result?.already_read ? 'Yeh chats pehle se parhi hui hain.' : ok ? 'Theek hai, shuru kar diya.' : 'Yeh shuru nahi ho saka.';
    return { reply: withFacts(said, steps), steps };
  }
  const messages = [...history, { role: 'user', content: text }];
  const steps = [];
  let corrections = 0;
  for (let i = 0; i <= MAX_STEPS; i++) {
    // A step is one short JSON object; the final reply to the owner rarely needs more than a few sentences.
    const out = await complete({ system: systemPrompt(scheduled), messages, maxTokens: 450 }, { purpose: 'command' });
    const obj = extractJson(toolCallToJson(out.text));
    const usable = obj && (TOOLS[obj.action] || (!obj.action && typeof obj.reply === 'string' && obj.reply.trim()));
    if (!usable) {
      // Plain prose with no JSON is still an answer to the owner.
      if (!obj && out.text.trim() && !/^\s*[{[<]/.test(out.text)) return { reply: out.text.trim(), steps };
      if (corrections++ < 3) {
        messages.push({ role: 'assistant', content: out.text.slice(0, 500) || '(empty)' });
        messages.push({ role: 'user', content: `That was not usable${obj?.action ? `: "${obj.action}" is not one of the actions` : ''}. Answer with exactly one JSON object: {"action": "<one of: ${Object.keys(TOOLS).join(', ')}>", "args": {...}} or {"reply": "..."}.` });
        i--;
        continue;
      }
      return { reply: 'The model kept answering in a form I could not use. Try again, or give Commands a larger model on the Models page.', steps };
    }
    if (!obj.action) {
      // The owner already gave the order; asking "should I?" again is not an answer.
      if (!steps.length && ACTION_ASK.test(text) && ASKS_PERMISSION.test(obj.reply) && corrections++ < 3) {
        messages.push({ role: 'assistant', content: JSON.stringify({ reply: obj.reply }) });
        messages.push({ role: 'user', content: 'Yes. I already told you to do it; do not ask again. Take the action now with sensible defaults (last 7 days, every 5 minutes, send true).' });
        i--;
        continue;
      }
      // Small models like to say "OK, I'm on it" without doing anything. Do not let that through.
      if (!steps.length && ACTION_ASK.test(text) && CLAIMS_WORK.test(obj.reply) && corrections++ < 3) {
        messages.push({ role: 'assistant', content: JSON.stringify({ reply: obj.reply }) });
        messages.push({ role: 'user', content: 'You have not taken any action yet, so nothing has happened. Take the action now (for example start_followups, schedule_task or send_message), or reply honestly that you cannot and why.' });
        i--;
        continue;
      }
      if (!steps.length && ACTION_ASK.test(text) && CLAIMS_WORK.test(obj.reply)) {
        return { reply: 'I could not start this, so nothing was sent. Try saying it like: "pichle 5 din ke interested logon ko har 5 minute baad follow-up bhejo".', steps };
      }
      return { reply: withFacts(String(obj.reply).trim(), steps), steps };
    }
    const tool = TOOLS[obj.action];
    let result;
    try {
      result = tool ? await tool.run(obj.args || {}) : { error: `Unknown tool "${obj.action}"` };
    } catch (e) {
      result = { error: e.message };
    }
    steps.push({ action: obj.action, args: obj.args || {}, result });
    log('info', 'command', `${obj.action} ${JSON.stringify(obj.args || {}).slice(0, 200)}`);
    messages.push({ role: 'assistant', content: JSON.stringify({ action: obj.action, args: obj.args || {} }) });
    messages.push({ role: 'user', content: `[result of ${obj.action}] ${JSON.stringify(result).slice(0, 2000)}${i === MAX_STEPS - 1 ? '\nThat was the last tool you may use. Reply to the owner now.' : ''}` });
  }
  return { reply: withFacts('I used every step I am allowed for one request. Here is what actually happened:', steps), steps };
}

let queue = Promise.resolve();
let activeThread = null; // the conversation whose command is running (commands run one at a time)
/** Handle a command from the dashboard or from the owner's own WhatsApp chat; requests run one at a time. */
// ---------- conversations ----------
/** A fixed conversation for WhatsApp self-chat commands or scheduled-task runs, created on first use. */
function fixedThread(kind, title) {
  const t = get('SELECT id FROM command_threads WHERE kind = ? ORDER BY id LIMIT 1', kind);
  if (t) return t.id;
  return Number(run('INSERT INTO command_threads (title, kind, created_at, updated_at) VALUES (?,?,?,?)', title, kind, now(), now()).lastInsertRowid);
}
export function newThread(title = 'New chat') {
  return Number(run("INSERT INTO command_threads (title, kind, created_at, updated_at) VALUES (?, 'chat', ?, ?)", title, now(), now()).lastInsertRowid);
}
/** Messages from before conversations existed go into one "Earlier" conversation. */
export function adoptLooseCommands() {
  if (!get('SELECT 1 x FROM commands WHERE thread_id IS NULL LIMIT 1')) return;
  const id = newThread('Earlier');
  run('UPDATE commands SET thread_id = ? WHERE thread_id IS NULL', id);
}
export const listThreads = () => all(`SELECT t.*, (SELECT COUNT(*) FROM commands c WHERE c.thread_id = t.id) messages,
  (SELECT text FROM commands c WHERE c.thread_id = t.id ORDER BY c.id DESC LIMIT 1) last_text FROM command_threads t ORDER BY t.updated_at DESC LIMIT 200`);

/**
 * What the agent remembers of one command conversation: the latest 16 messages in full, and before them,
 * everything the owner said in short (so "jaisa pehle kaha tha" still works in a long conversation).
 */
export function threadMemory(thread) {
  const rows = all('SELECT role, text FROM commands WHERE thread_id = ? ORDER BY id', thread);
  const recent = rows.slice(-16);
  const older = rows.slice(0, -16).filter((r) => r.role === 'owner').slice(-40);
  const out = recent.map((r) => ({ role: r.role === 'owner' ? 'user' : 'assistant', content: r.role === 'owner' ? clip(r.text, 900) : JSON.stringify({ reply: clip(r.text, 600) }) }));
  if (older.length) {
    out.unshift(
      { role: 'user', content: `[Earlier in this conversation I told you:]\n${older.map((r) => `- ${clip(r.text, 160)}`).join('\n')}` },
      { role: 'assistant', content: JSON.stringify({ reply: 'Noted, I remember all of that.' }) });
  }
  // Chat models want the conversation to start with the owner.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export function handleCommand(text, { chatId = null, scheduled = false, label = null, threadId = null } = {}) {
  const thread = threadId || (chatId ? fixedThread('whatsapp', 'WhatsApp (Message yourself)') : scheduled ? fixedThread('tasks', 'Scheduled tasks') : newThread());
  const job = queue.then(async () => {
    // The agent remembers this conversation (and only this one).
    const history = scheduled ? [] : threadMemory(thread);
    run('INSERT INTO commands (role, text, thread_id, ts) VALUES (?,?,?,?)', 'owner', label || text, thread, now());
    const t = get('SELECT title, kind FROM command_threads WHERE id = ?', thread);
    if (t?.kind === 'chat' && t.title === 'New chat') run('UPDATE command_threads SET title = ? WHERE id = ?', clip(text, 60), thread);
    run('UPDATE command_threads SET updated_at = ? WHERE id = ?', now(), thread);
    emit('command', { thread });
    let out;
    activeThread = scheduled ? null : thread;
    try {
      out = await runCommand(text, history, { scheduled });
    } catch (e) {
      out = { reply: `I could not do that: ${e.message}`, steps: [] };
    }
    run('INSERT INTO commands (role, text, steps, thread_id, ts) VALUES (?,?,?,?,?)', 'agent', out.reply, JSON.stringify(out.steps), thread, now());
    run('UPDATE command_threads SET updated_at = ? WHERE id = ?', now(), thread);
    emit('command', { thread });
    if (chatId) await wa.sendText(chatId, out.reply, 'ai').catch((e) => log('error', 'command', `Could not answer in WhatsApp: ${e.message}`));
    return { ...out, thread };
  });
  queue = job.catch(() => {});
  return job;
}

export function startCommander() {
  adoptLooseCommands();
  setCampaign(campaign, whyNotSending);
  setTaskRunner((t) => handleCommand(t.instruction, { scheduled: true, label: `⏰ Task #${t.id}: ${t.title}` }));
  wa.setHandlers({ onCommand: (chatId, text) => { if (getSettings().commandsViaWhatsApp) handleCommand(text, { chatId }); } });
}
