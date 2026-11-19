// Proactive messages: automatic nudges for quiet leads, and the "read old chats and follow up" campaign.
// Everything proactive is drip-fed: quiet hours, a daily cap per number, random gaps between sends.
import { all, get, run, now, update } from '../db.js';
import { getSettings, log, emit, sleep, rand, hourIn, isQuiet } from '../core.js';
import * as wa from '../wa/manager.js';
import { decide, CLOSED } from './brain.js';
import { learnFromChats } from './learn.js';
import { notify, who } from './updates.js';
import { eligibility, humanSend, scheduleNextFollowup } from './pipeline.js';
import { hasAnyTag } from './tags.js';
import { nextReadyAt, outOfModels } from '../llm/router.js';
import { taskEvent } from './task-log.js';

/** Read before, and nothing new said since: its stored stage and summary are current. */
export const isFresh = (c) => !!c.analyzed_at && c.analyzed_at >= (c.last_msg_at || 0);

/**
 * Every model is at its limit: wait until one is back, then carry on where we were.
 * Returns false when no model will come back by itself (then the work stops with a clear reason).
 */
async function waitForModels(state) {
  let told = false;
  while (!state.cancel) {
    const until = nextReadyAt('analyze');
    if (!until) { state.waitingUntil = null; return false; } // nothing will come back by itself
    if (until <= now()) break;                               // a model is ready (or was reset by hand)
    if (!told) {
      told = true;
      taskEvent(state.taskId, `Paused: every AI model is at its limit. Continues by itself in about ${Math.ceil((until - now()) / 60_000)} min, from the same chat.`, { kind: 'paused' });
      log('info', 'campaign', `Paused: every model is at its limit. Continuing by itself in about ${Math.ceil((until - now()) / 60_000)} min, from the same chat.`);
    }
    if (state.waitingUntil !== until) { state.waitingUntil = until; emit('campaign', state); emit('tasks'); }
    await sleep(process.env.NODE_ENV === 'test' ? 20 : 5000);
  }
  state.waitingUntil = null;
  emit('campaign', state);
  if (told && !state.cancel) taskEvent(state.taskId, 'A model is free again: carrying on', { kind: 'info' });
  return !state.cancel;
}

/**
 * Keep the CRM current without re-reading everything: chats with something new since they were last read
 * get a fresh stage and summary, a few at a time, once the conversation has settled for a few minutes.
 */
export async function readChanged() {
  const s = getSettings().reading || {};
  if (s.auto === false || campaign.running) return 0;
  if (nextReadyAt('analyze') !== now()) return 0; // models resting: try on a later tick
  const rows = all(`SELECT c.* FROM chats c
      WHERE c.last_msg_at > COALESCE(c.analyzed_at, 0) AND c.last_msg_at < ? AND c.jid NOT LIKE '%@g.us'
        AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0) >= 1
      ORDER BY c.last_msg_at DESC LIMIT ?`, now() - 5 * 60_000, Math.max(1, Number(s.perTick) || 4));
  let n = 0;
  for (const c of rows) {
    try {
      const d = await decide(c.id, 'analyze', { lean: true });
      update('chats', c.id, { stage: c.stage === 'opted_out' ? 'opted_out' : d.stage, summary: d.summary, analyzed_at: now() }, ['stage', 'summary', 'analyzed_at']);
      n++;
    } catch (e) { if (outOfModels(e)) break; }
  }
  if (n) emit('chat', {});
  return n;
}

// Per number: the random gap from Settings spaces the AUTOMATIC follow-ups; your own tasks follow their own
// gap (set when you gave the order) and only keep a short anti-burst pause between any two messages.
const nextSlot = new Map();  // accountId -> earliest time the next automatic follow-up may go out
const burstSlot = new Map(); // accountId -> earliest time any proactive message may go out
let drafting = false;
let sending = false;
// A follow-up that belongs to a task only goes out while that task is active (not paused or removed).
const TASK_ACTIVE = "(f.task_id IS NULL OR (SELECT t.status FROM tasks t WHERE t.id = f.task_id) = 'active')";
export const campaign = { taskId: null, running: false, total: 0, done: 0, drafted: 0, failed: 0, cancel: false, startedAt: null, error: null };

const label = (c) => c.name || c.phone || c.jid;

function queue(chatId, kind, text, reason, status, dueAt = now(), taskId = null) {
  run('INSERT INTO followups (chat_id, kind, text, reason, status, due_at, task_id, created_at) VALUES (?,?,?,?,?,?,?,?)', chatId, kind, text, reason, status, Math.round(dueAt), taskId, now());
  emit('followups');
}

/**
 * Change a batch that is already running: what the messages say, the gap between them, whether they go out by
 * themselves. Messages already written but not sent yet are spaced again and, for a new instruction, rewritten.
 */
export async function changeBatch(taskId, { instruction, interval, autoApprove, audience = 'all', startIn = null } = {}) {
  const mine = campaign.taskId === taskId && campaign.running;
  const changed = [];
  if (instruction) { if (mine) campaign.instruction = instruction; changed.push('message instruction'); }
  if (typeof autoApprove === 'boolean') {
    if (mine) campaign.autoApprove = autoApprove;
    taskEvent(taskId, autoApprove ? 'Messages now go out by themselves' : 'Messages now wait for your approval', { kind: 'changed' });
    run(`UPDATE followups SET status = ? WHERE task_id = ? AND status = ?`, autoApprove ? 'approved' : 'pending', taskId, autoApprove ? 'pending' : 'approved');
    changed.push(autoApprove ? 'messages go out by themselves' : 'messages wait for your approval');
  }
  const waiting = () => all("SELECT * FROM followups WHERE task_id = ? AND status IN ('pending','approved') ORDER BY due_at, id", taskId);
  if (startIn != null && !interval) {
    // Keep the gaps they had, move the whole line so the first one goes out after the wait.
    const rows = waiting();
    if (rows.length) {
      const shift = now() + startIn * 60_000 - rows[0].due_at;
      for (const f of rows) update('followups', f.id, { due_at: Math.round(f.due_at + shift) }, ['due_at']);
    }
    if (mine) campaign.startAt = now() + startIn * 60_000;
    taskEvent(taskId, `Start moved: the next message goes out in ${startIn} min`, { kind: 'changed' });
    changed.push(`next message in ${startIn} min`);
  }
  if (interval) {
    const range = Array.isArray(interval) ? interval : null;
    taskEvent(taskId, `Gap changed to ${range ? `${range[0]} to ${range.at(-1)} min (random)` : `${interval} min`}: messages not sent yet were spaced again`, { kind: 'changed' });
    if (mine) { campaign.range = range; campaign.gap = range ? 0 : interval * 60_000; }
    const gapMs = () => (range ? rand(range[0], range.at(-1)) : interval * rand(0.8, 1.2)) * 60_000;
    let due = now() + (startIn || 0) * 60_000;
    for (const f of waiting()) { update('followups', f.id, { due_at: Math.round(due) }, ['due_at']); due += gapMs(); }
    changed.push(range ? `gap ${range[0]} to ${range.at(-1)} min (random)` : `gap ${interval} min`);
    if (startIn) changed.push(`first one in ${startIn} min`);
  }
  emit('followups');
  // Rewrite what is written but not sent, one by one, in the background (pauses at model limits like a batch).
  let rewriting = 0;
  if (instruction) {
    const rows = waiting();
    rewriting = rows.length;
    (async () => {
      const state = { cancel: false, waitingUntil: null, taskId };
      for (const f of rows) {
        for (let tries = 0; ; tries++) {
          const still = get("SELECT status FROM followups WHERE id = ?", f.id);
          if (!still || !['pending', 'approved'].includes(still.status)) break;
          try {
            const d = await decide(f.chat_id, 'analyze', { instruction, audience, history: 12 });
            const c = get('SELECT * FROM chats WHERE id = ?', f.chat_id);
            if (d.skip) { update('followups', f.id, { status: 'skipped', error: d.reason || 'Not right for this person after the change' }, ['status', 'error']); taskEvent(taskId, `Dropped ${who(c)} after the change: ${d.reason || ''}`, { kind: 'skipped', chatId: f.chat_id }); }
            else { update('followups', f.id, { text: d.message, reason: d.reason }, ['text', 'reason']); taskEvent(taskId, `Rewrote the message for ${who(c)}: "${String(d.message).slice(0, 160)}"`, { kind: 'wrote', chatId: f.chat_id }); }
            break;
          } catch (e) {
            if (outOfModels(e) && tries < 20 && (await waitForModels(state))) continue;
            break; // keeps the old text
          }
        }
        emit('followups');
      }
      log('info', 'tasks', `Task #${taskId}: ${rows.length} waiting message${rows.length === 1 ? '' : 's'} rewritten for the new instruction`);
    })();
  }
  return { changed, rewriting, waiting: waiting().length };
}

/**
 * A batch that was still reading chats when the agent restarted (an update, a crash, a reboot): start it again,
 * skipping every chat it already handled. Returns how many chats are left, or null if there is nothing to do.
 */
export async function resumeBatch(task) {
  const p = JSON.parse(task.params || 'null');
  if (!p || p.readDone || campaign.running) return null;
  const done = new Set([
    ...all('SELECT DISTINCT chat_id FROM followups WHERE task_id = ?', task.id).map((r) => r.chat_id),
    ...all("SELECT DISTINCT chat_id FROM task_events WHERE task_id = ? AND chat_id IS NOT NULL AND kind IN ('read','skipped','wrote')", task.id).map((r) => r.chat_id),
  ]);
  const { readDone, ...args } = p;
  await runCampaign({ ...args, taskId: task.id, skipChatIds: done });
  taskEvent(task.id, campaign.total
    ? `The agent restarted: carrying on from where it stopped (${campaign.total} chat${campaign.total === 1 ? '' : 's'} left, ${done.size} already done)`
    : 'The agent restarted: every chat was already handled', { kind: 'info' });
  return campaign.total;
}

/** The next messages a task will send, with who and when (for the owner's reply). */
export function nextOfTask(taskId, n = 3) {
  return all(`SELECT f.due_at, f.status, c.name, c.phone, c.id chat_id FROM followups f JOIN chats c ON c.id = f.chat_id
    WHERE f.task_id = ? AND f.status IN ('pending','approved') ORDER BY f.due_at LIMIT ?`, taskId, n);
}

/** 1) Turn due chats into drafts. */
/**
 * Find leads who went quiet after we (the agent or the owner) answered, and give each one its next follow-up time.
 * This covers chats the owner answered by hand and chats from before the agent was running, not only agent replies.
 */
export function sweepQuiet() {
  const s = getSettings().followup;
  if (!s.enabled || !s.stepsHours?.length) return 0;
  const rows = all(`SELECT c.* FROM chats c
      WHERE c.next_followup_at IS NULL AND c.needs_human = 0
        AND c.stage NOT IN ('purchased','not_interested','opted_out')
        AND c.last_in_at IS NOT NULL AND c.last_out_at IS NOT NULL AND c.last_out_at >= c.last_in_at
        AND c.last_out_at > ? AND c.followup_count < ?
        AND (c.paused_until IS NULL OR c.paused_until < ?)
        AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status IN ('pending','approved'))
      LIMIT 200`, now() - 30 * 86_400_000, s.stepsHours.length, now());
  let n = 0;
  for (const c of rows) {
    const account = get('SELECT * FROM accounts WHERE id = ?', c.account_id);
    if (!account || !eligibility({ ...c, paused_until: null }, account)[0]) continue; // e.g. an old contact on a "new leads only" number
    // Counted from our last message, so a lead who has been quiet for a while is due straight away.
    const due = Math.max(now(), c.last_out_at + s.stepsHours[c.followup_count] * 3_600_000);
    update('chats', c.id, { next_followup_at: due }, ['next_followup_at']);
    n++;
  }
  if (n) emit('followups');
  return n;
}

/** What the follow-up machine is doing, for the Overview page. */
export function followupStatus() {
  const s = getSettings().followup;
  const n = (sql, ...p) => get(sql, ...p).n;
  return {
    enabled: s.enabled, approval: s.approval, steps: s.stepsHours, quietStart: s.quietStart, quietEnd: s.quietEnd, timezone: s.timezone, dailyCap: s.dailyCap,
    scheduled: n('SELECT COUNT(*) n FROM chats WHERE next_followup_at IS NOT NULL'),
    drafts: n("SELECT COUNT(*) n FROM followups WHERE status = 'pending'"),
    queued: n("SELECT COUNT(*) n FROM followups WHERE status = 'approved'"),
    sentToday: n("SELECT COUNT(*) n FROM followups WHERE status = 'sent' AND sent_at > ?", now() - 86_400_000),
    repliedAfter: n("SELECT COUNT(DISTINCT f.chat_id) n FROM followups f WHERE f.status = 'sent' AND f.sent_at > ? AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = f.chat_id AND m.from_me = 0 AND m.ts > f.sent_at)", now() - 7 * 86_400_000),
    next: all(`SELECT c.id, c.name, c.phone, c.jid, c.stage, c.followup_count, c.next_followup_at FROM chats c WHERE c.next_followup_at IS NOT NULL ORDER BY c.next_followup_at LIMIT 6`)
      .map((c) => ({ id: c.id, title: c.name || (c.phone ? `+${c.phone}` : c.jid.split('@')[0]), stage: c.stage, step: c.followup_count + 1, at: c.next_followup_at })),
    why: whyNotSending(null),
  };
}

async function draftDue() {
  if (drafting) return;
  drafting = true;
  try {
    const settings = getSettings();
    if (!settings.followup.enabled || !settings.autopilot) return;
    sweepQuiet();
    const due = all(`SELECT c.* FROM chats c WHERE c.next_followup_at IS NOT NULL AND c.next_followup_at <= ?
                     AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status IN ('pending','approved')) LIMIT 5`, now());
    for (const chat of due) {
      update('chats', chat.id, { next_followup_at: null }, ['next_followup_at']);
      const account = get('SELECT * FROM accounts WHERE id = ?', chat.account_id);
      if (CLOSED.includes(chat.stage) || !eligibility(chat, account, settings)[0]) continue;
      try {
        const d = await decide(chat.id, 'followup');
        update('chats', chat.id, { stage: d.stage, summary: d.summary }, ['stage', 'summary']);
        if (d.skip) { log('info', 'followup', `Skipped ${label(chat)}: ${d.reason || 'not worth a follow-up'}`); continue; }
        queue(chat.id, 'auto', d.message, d.reason, settings.followup.approval ? 'pending' : 'approved');
      } catch (e) {
        log('error', 'followup', `Could not draft a follow-up for ${label(chat)}: ${e.message}`);
        update('chats', chat.id, { next_followup_at: now() + 3_600_000 }, ['next_followup_at']); // try again in an hour
      }
    }
  } finally {
    drafting = false;
  }
}

/** 2) Send approved drafts, one per number per slot. */
async function sendApproved() {
  if (sending) return;
  sending = true;
  try {
    const s = getSettings().followup;
    // In quiet hours only tasks the owner explicitly allowed to run at night may send.
    // A reminder the owner scheduled for an exact time is always sent on time.
    const quietOk = isQuiet(hourIn(s.timezone), s.quietStart, s.quietEnd) ? " AND (f.kind = 'reminder' OR f.task_id IN (SELECT id FROM tasks WHERE ignore_quiet = 1))" : '';
    const accounts = all(`SELECT DISTINCT c.account_id id FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.status = 'approved' AND f.due_at <= ? AND ${TASK_ACTIVE}${quietOk}`, now());
    for (const { id: accountId } of accounts) {
      if ((burstSlot.get(accountId) || 0) > now()) continue;
      if (wa.statusOf(accountId).state !== 'connected') continue;
      const sentToday = get("SELECT COUNT(*) n FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'sent' AND f.sent_at > ?", accountId, now() - 86_400_000).n;
      if (sentToday >= s.dailyCap) continue;
      const f = get(`SELECT f.* FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'approved' AND f.due_at <= ? AND ${TASK_ACTIVE}${quietOk} ORDER BY f.due_at, f.id LIMIT 1`, accountId, now());
      if (!f) continue;
      if (!f.task_id && (nextSlot.get(accountId) || 0) > now()) continue;
      burstSlot.set(accountId, now() + (process.env.NODE_ENV === 'test' ? 0 : rand(30, 60) * 1000));
      if (!f.task_id) nextSlot.set(accountId, now() + rand(s.gapMinSec, s.gapMaxSec) * 1000);
      const chat = get('SELECT * FROM chats WHERE id = ?', f.chat_id);
      if (chat.stage === 'opted_out' || (chat.stage === 'purchased' && f.kind !== 'reminder')) {
        update('followups', f.id, { status: 'skipped', error: `Customer is ${chat.stage.replace('_', ' ')}` }, ['status', 'error']);
        continue;
      }
      try {
        await humanSend(chat, [f.text], 'followup');
        update('followups', f.id, { status: 'sent', sent_at: now() }, ['status', 'sent_at']);
        if (f.kind === 'reminder') notify(`Reminder sent to ${who(chat)}: "${f.text.slice(0, 120)}"`);
        else {
          run('UPDATE chats SET followup_count = followup_count + 1 WHERE id = ?', chat.id);
          scheduleNextFollowup(chat.id);
        }
        if (f.task_id) {
          taskEvent(f.task_id, `Sent to ${who(chat)}: "${f.text.slice(0, 160)}"`, { kind: 'sent', chatId: chat.id });
          // Progress the owner can follow without opening the dashboard: the first message, then the halfway point.
          const c = Object.fromEntries(all('SELECT status, COUNT(*) n FROM followups WHERE task_id = ? GROUP BY status', f.task_id).map((r) => [r.status, r.n]));
          const sentN = c.sent || 0;
          const total = sentN + (c.approved || 0) + (c.pending || 0);
          const thread = get('SELECT thread_id FROM tasks WHERE id = ?', f.task_id)?.thread_id;
          if (sentN === 1 && total > 1) notify(`Task #${f.task_id}: first message sent to ${who(chat)} (1 of ${total}).`, { threadId: thread });
          else if (total >= 4 && sentN === Math.ceil(total / 2)) notify(`Task #${f.task_id}: halfway, ${sentN} of ${total} sent.`, { threadId: thread });
        }
        log('info', 'followup', `Follow-up sent to ${label(chat)}`);
      } catch (e) {
        update('followups', f.id, { status: 'failed', error: e.message.slice(0, 300) }, ['status', 'error']);
        taskEvent(f.task_id, `Not sent to ${who(chat)}: ${e.message.slice(0, 200)}`, { kind: 'failed', chatId: chat.id });
        log('error', 'followup', `Follow-up to ${label(chat)} failed: ${e.message}`);
      }
      emit('followups');
    }
  } finally {
    sending = false;
  }
}

/**
 * Campaign: read past conversations, classify each one, and draft a follow-up for
 * interested people who never bought. Drafts always wait for approval.
 */
/**
 * Extra options (used by owner commands):
 *  instruction      what the owner wants this batch to say / who it is for
 *  autoApprove      queue for sending without the approval step
 *  intervalMinutes  spacing between messages (each one is scheduled, with a little jitter)
 *  stages           only these stages (purchased chats are included only when listed here)
 */
/**
 * Why queued follow-ups of a task (or of everything, when taskId is null) are not going out right now.
 * Returns a short sentence, or null when they are on their way.
 */
export function whyNotSending(taskId = null) {
  const s = getSettings().followup;
  const where = taskId ? 'f.task_id = ?' : '1 = 1';
  const args = taskId ? [taskId] : [];
  const queued = all(`SELECT f.due_at, c.account_id FROM followups f JOIN chats c ON c.id = f.chat_id WHERE ${where} AND f.status = 'approved'`, ...args);
  if (!queued.length) {
    const drafts = get(`SELECT COUNT(*) n FROM followups f WHERE ${where} AND f.status = 'pending'`, ...args).n;
    return drafts ? `${drafts} message${drafts === 1 ? ' is' : 's are'} waiting for your approval on the Follow-ups page.` : null;
  }
  if (taskId && get('SELECT status FROM tasks WHERE id = ?', taskId)?.status === 'paused') return 'Paused.';
  for (const accountId of [...new Set(queued.map((q) => q.account_id))]) {
    if (wa.statusOf(accountId).state !== 'connected') {
      const name = get('SELECT name FROM accounts WHERE id = ?', accountId)?.name || 'The WhatsApp number';
      return `"${name}" is not connected, so nothing can be sent. Open Numbers and link it.`;
    }
    const sentToday = get("SELECT COUNT(*) n FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'sent' AND f.sent_at > ?", accountId, now() - 86_400_000).n;
    if (sentToday >= s.dailyCap) return `The daily limit of ${s.dailyCap} follow-ups per number is reached. Raise it in Settings or wait.`;
  }
  const ignore = taskId && get('SELECT ignore_quiet FROM tasks WHERE id = ?', taskId)?.ignore_quiet;
  if (!ignore && isQuiet(hourIn(s.timezone), s.quietStart, s.quietEnd)) {
    return `Quiet hours (${s.quietStart}:00 to ${s.quietEnd}:00, ${s.timezone}): sending starts at ${s.quietEnd}:00. Change the hours in Settings, or tell the agent to send at night anyway.`;
  }
  const next = Math.min(...queued.map((q) => q.due_at));
  return next > now() ? null : null;
}

export async function runCampaign({ accountId = null, sinceDays = 90, limit = 200, reanalyze = false, instruction = '', autoApprove = false, intervalMinutes = 0, stages = null, taskId = null, analyzeOnly = false, audience = 'all', tags = [], skipChatIds = null, startAt = null } = {}) {
  if (campaign.running) throw new Error('Another batch is still reading chats. Wait for it to finish, or remove it on the Tasks page.');
  // Saved with the task, so the work carries on by itself after a restart (see resumeBatch).
  if (taskId) run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify({ accountId, sinceDays, limit, reanalyze, instruction, autoApprove, intervalMinutes, stages, analyzeOnly, audience, tags, readDone: false }), taskId);
  const since = now() - sinceDays * 86_400_000;
  // Analysis reads every customer chat in the period (buyers included); it sends nothing.
  const tagged = tags?.length > 0;
  let chats = analyzeOnly ? all(`SELECT c.* FROM chats c
      WHERE (?1 IS NULL OR c.account_id = ?1) AND c.last_in_at >= ?2 AND (?4 = 1 OR c.analyzed_at IS NULL OR c.analyzed_at < COALESCE(c.last_msg_at, 0))
        AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0) >= 1
      ORDER BY c.last_in_at DESC LIMIT ?3`, accountId, since, limit, reanalyze ? 1 : 0) : all(`SELECT c.* FROM chats c
      WHERE (?1 IS NULL OR c.account_id = ?1) AND c.last_in_at >= ?2 AND c.stage != 'opted_out'
        AND (?5 != '' OR ?6 = 1 OR c.stage != 'purchased') AND (?5 = '' OR instr(?5, ',' || c.stage || ',') > 0)
        AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
        AND (?3 = 1 OR c.analyzed_at IS NULL)
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0) >= 1
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) >= 2
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status IN ('pending','approved'))
        -- Someone who got a message from us in the last day is not messaged again by another batch.
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status = 'sent' AND f.sent_at > ?7)
      ORDER BY c.last_in_at DESC LIMIT ?4`, accountId, since, reanalyze || instruction ? 1 : 0, tagged ? 5000 : limit, stages?.length ? `,${stages.join(',')},` : '', audience === 'buyers' || tagged ? 1 : 0, now() - (getSettings().followup.repeatGuardHours ?? 24) * 3_600_000);
  if (tagged) chats = chats.filter((c) => hasAnyTag(c, tags)).slice(0, limit);
  if (skipChatIds?.size) chats = chats.filter((c) => !skipChatIds.has(c.id));
  // Chats read before and unchanged since: their stored stage decides who is in, without a model call.
  if (!analyzeOnly && !tagged && !stages?.length) {
    if (audience === 'buyers') chats = chats.filter((c) => !isFresh(c) || c.stage === 'purchased');
    if (audience === 'non_buyers') chats = chats.filter((c) => !isFresh(c) || c.stage !== 'purchased');
    if (audience !== 'buyers') chats = chats.filter((c) => !isFresh(c) || !['not_interested', 'opted_out'].includes(c.stage));
  }
  const range = Array.isArray(intervalMinutes) ? intervalMinutes.map(Number).filter((n) => n > 0).sort((a, b) => a - b) : null;
  const gap = range?.length ? 0 : Math.max(0, Number(intervalMinutes) || 0) * 60_000;
  // "randomly 6 to 25 minutes apart": each gap is picked at random in that range.
  const nextGap = () => (campaign.range?.length ? rand(campaign.range[0], campaign.range.at(-1)) * 60_000 : campaign.gap * rand(0.8, 1.2));
  // Carrying on after a restart: new messages queue up after the ones already waiting.
  let nextDue = Math.max(now(), startAt || 0, (taskId && get("SELECT MAX(due_at) m FROM followups WHERE task_id = ? AND status IN ('pending','approved')", taskId)?.m) || 0);
  Object.assign(campaign, { taskId, analyzeOnly, waitingUntil: null, instruction, autoApprove, range, gap, stages: {}, running: true, total: chats.length, done: 0, drafted: 0, skipped: 0, skipReasons: [], failed: 0, cancel: false, startedAt: now(), error: null });
  emit('campaign', campaign);
  log('info', 'campaign', `Reviewing ${chats.length} past conversations`);
  (async () => {
    // Read one chat; true when it worked.
    const handle = async (chat) => {
      // Already read and unchanged: its summary is in the prompt, so the latest messages are enough to write from.
      const d = await decide(chat.id, 'analyze', { instruction: campaign.instruction, lean: analyzeOnly, audience, history: !analyzeOnly && isFresh(chat) ? 12 : null });
      update('chats', chat.id, { stage: d.stage, summary: d.summary, analyzed_at: now() }, ['stage', 'summary', 'analyzed_at']);
      campaign.stages[d.stage] = (campaign.stages[d.stage] || 0) + 1;
      if (analyzeOnly) { taskEvent(taskId, `Read ${who(chat)}: ${d.stage.replace('_', ' ')}. ${d.summary || ''}`.trim(), { kind: 'read', chatId: chat.id }); return; }
      if (d.skip) {
        taskEvent(taskId, `Skipped ${who(chat)}: ${d.reason || 'not right for this message'}`, { kind: 'skipped', chatId: chat.id }); campaign.skipped++; if (d.reason && campaign.skipReasons.length < 3) campaign.skipReasons.push(`${chat.name || chat.phone || 'someone'}: ${d.reason}`); }
      else {
        queue(chat.id, audience === 'buyers' ? 'reminder' : 'campaign', d.message, d.reason, campaign.autoApprove ? 'approved' : 'pending', nextDue, taskId);
        taskEvent(taskId, `Wrote a message for ${who(chat)}${campaign.autoApprove ? `, goes out around ${new Date(Math.max(nextDue, now())).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getSettings().followup.timezone })}` : ', waiting for your approval'}: "${String(d.message).slice(0, 160)}"`, { kind: 'wrote', chatId: chat.id });
        nextDue = Math.max(nextDue, now()) + nextGap();
        campaign.drafted++;
      }
    };
    const failedOnce = [];
    for (const chat of chats) {
      if (campaign.cancel) break;
      let tries = 0;
      for (;;) {
        try { await handle(chat); } catch (e) {
          // Limits reached: pause and resume from this same chat instead of failing the rest.
          if (outOfModels(e) && tries++ < 20 && (await waitForModels(campaign))) continue;
          failedOnce.push(chat);
          taskEvent(taskId, `Could not read ${who(chat)}: ${String(e.message).slice(0, 200)} (tried again at the end)`, { kind: 'failed', chatId: chat.id });
        campaign.error = e.message;
        // Every model refusing several chats in a row: stop instead of burning through the list.
          if (/No AI model/.test(e.message) || (failedOnce.length >= 4 && failedOnce.length === campaign.done + 1)) { campaign.cancel = true; log('error', 'campaign', `Stopped: ${e.message}`); }
        }
        break;
      }
      campaign.done++;
      emit('campaign', campaign);
      if (taskId) emit('tasks');
      await sleep(rand(400, 1200)); // stay gentle on free-tier rate limits
    }
    // Free models time out or get busy now and then: give the chats that failed one more go after a pause.
    if (failedOnce.length && !campaign.cancel) {
      log('info', 'campaign', `${failedOnce.length} chat${failedOnce.length === 1 ? '' : 's'} failed; trying again after a short pause`);
      await sleep(process.env.NODE_ENV === 'test' ? 50 : 30_000);
      for (const chat of failedOnce) {
        if (campaign.cancel) { campaign.failed++; continue; }
        try { await handle(chat); } catch (e) { campaign.failed++; campaign.error = e.message; }
        await sleep(rand(800, 1600));
      }
    } else campaign.failed += failedOnce.length;
    campaign.running = false;
    emit('campaign', campaign);
    const markRead = () => { if (taskId && !campaign.cancel) { const p = JSON.parse(get('SELECT params FROM tasks WHERE id = ?', taskId)?.params || '{}'); run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify({ ...p, readDone: true }), taskId); } };
    if (!analyzeOnly) markRead();
    if (taskId && analyzeOnly) {
      const mix = Object.entries(campaign.stages).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ');
      let learned = '';
      try { const l = await learnFromChats({}); learned = ` Now learning your offers, prices and tone from ${l.chats} conversations you answered yourself; the result appears on the Knowledge page.`; } catch (e) { learned = ` Could not learn from them: ${e.message}`; }
      run('UPDATE tasks SET last_result = ? WHERE id = ?', `Read ${campaign.done} chat${campaign.done === 1 ? '' : 's'}${mix ? `: ${mix}` : ''}${campaign.failed ? `; ${campaign.failed} failed (${campaign.error})` : ''}.${learned}`.slice(0, 1000), taskId);
      markRead();
      emit('tasks');
      notify(`Task #${taskId}: ${get('SELECT last_result FROM tasks WHERE id = ?', taskId)?.last_result || 'finished reading'}`, { threadId: get('SELECT thread_id FROM tasks WHERE id = ?', taskId)?.thread_id });
    } else if (taskId) {
      const summary = `Read ${campaign.done} chat${campaign.done === 1 ? '' : 's'}: ${campaign.drafted} message${campaign.drafted === 1 ? '' : 's'} ${autoApprove ? 'queued' : 'drafted for approval'}, ${campaign.skipped} skipped${campaign.failed ? `, ${campaign.failed} failed (${campaign.error})` : ''}.${campaign.skipReasons.length ? ` Skipped for example: ${campaign.skipReasons.join(' | ')}` : ''}`;
      run('UPDATE tasks SET last_result = ? WHERE id = ?', summary.slice(0, 1000), taskId);
      emit('tasks');
      if (campaign.drafted) notify(`Task #${taskId}: ${summary} ${autoApprove ? 'Sending starts now, one by one.' : 'Approve them on the Follow-ups page.'}`, { threadId: get('SELECT thread_id FROM tasks WHERE id = ?', taskId)?.thread_id });
    }
    log('info', 'campaign', `Review finished: ${campaign.done} read, ${campaign.drafted} follow-ups drafted, ${campaign.failed} failed`);
  })();
  return campaign;
}

export function startFollowups() {
  const tick = () => draftDue().then(sendApproved).catch((e) => log('error', 'followup', e.message));
  setInterval(tick, 20_000).unref();
  // Reading new conversation turns runs on its own, slower clock.
  setInterval(() => readChanged().catch((e) => log('error', 'reading', e.message)), 3 * 60_000).unref();
}
export const _tick = () => draftDue().then(sendApproved);
