// Tasks: jobs the owner gives the agent, with a schedule, live progress and pause / resume / run now / remove.
//  - batch:     a follow-up batch (read chats, write personal messages, send them one by one)
//  - scheduled: an instruction the agent carries out once at a time, every N minutes, or daily at HH:MM
import { all, get, run, now, parse, update } from '../db.js';
import { getSettings, emit, log } from '../core.js';

const MIN = 60_000;
export const STATUSES = ['active', 'paused', 'done', 'failed', 'removed'];
let runner = null; // set by the commander: (task) => Promise<{ reply }>
export const setTaskRunner = (fn) => { runner = fn; };
let campaignRef = null; // the follow-up batch reader, to report and stop it
export const setCampaign = (c) => { campaignRef = c; };

const tzParts = (tz, d = new Date()) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
  } catch { return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() }; }
};

/** Next time a schedule fires after `from`. Returns null when a one-off has already run. */
export function nextRun(schedule, from = now(), { ranBefore = false } = {}) {
  const tz = getSettings().followup.timezone;
  if (!schedule || schedule.type === 'once') {
    if (ranBefore) return null;
    if (schedule?.at) {
      if (/^\d{1,2}:\d{2}$/.test(schedule.at)) return atClock(schedule.at, tz, from);
      const t = Date.parse(schedule.at);
      return Number.isNaN(t) ? from : t;
    }
    return from;
  }
  if (schedule.type === 'every') return from + Math.max(1, Number(schedule.minutes) || 60) * MIN;
  if (schedule.type === 'daily') return atClock(schedule.time || '10:00', tz, from + 1000);
  return null;
}

/** The next moment the clock in `tz` shows HH:MM (today if still ahead, otherwise tomorrow). */
function atClock(hhmm, tz, from) {
  const [h, m] = hhmm.split(':').map(Number);
  const cur = tzParts(tz, new Date(from));
  let delta = (h * 60 + m) - (cur.h * 60 + cur.m);
  if (delta <= 0) delta += 1440;
  return from + delta * MIN - cur.s * 1000;
}

export function describeSchedule(s) {
  if (!s || s.type === 'once') return s?.at ? `Once at ${s.at}` : 'Once, right away';
  if (s.type === 'every') return `Every ${s.minutes} minute${s.minutes === 1 ? '' : 's'}`;
  if (s.type === 'daily') return `Every day at ${s.time}`;
  return 'Unknown schedule';
}

export function createTask({ title, instruction, kind = 'scheduled', schedule = { type: 'once' } }) {
  const text = String(instruction || '').trim();
  if (!text) throw new Error('Describe what the task should do');
  const sched = kind === 'batch' ? null : normaliseSchedule(schedule);
  const { lastInsertRowid } = run('INSERT INTO tasks (title, instruction, kind, schedule, status, next_run_at, runs, created_at) VALUES (?,?,?,?,?,?,?,?)',
    String(title || text).slice(0, 120), text.slice(0, 1000), kind, JSON.stringify(sched), 'active', kind === 'batch' ? null : nextRun(sched), 0, now());
  const id = Number(lastInsertRowid);
  log('info', 'tasks', `Task #${id} created: ${String(title || text).slice(0, 80)}${sched ? ` (${describeSchedule(sched)})` : ''}`);
  emit('tasks');
  return id;
}

export function normaliseSchedule(s = {}) {
  if (s.type === 'every') {
    const minutes = Math.round(Number(s.minutes));
    if (!(minutes >= 1 && minutes <= 10080)) throw new Error('Repeat every 1 minute to 7 days');
    return { type: 'every', minutes };
  }
  if (s.type === 'daily') {
    if (!/^\d{1,2}:\d{2}$/.test(String(s.time || ''))) throw new Error('Daily time must look like 10:00');
    return { type: 'daily', time: s.time };
  }
  return s.at ? { type: 'once', at: String(s.at) } : { type: 'once' };
}

/** Task with live progress for the dashboard. */
export function taskView(t) {
  const schedule = parse(t.schedule, null);
  const view = { ...t, schedule, scheduleText: t.kind === 'batch' ? 'Follow-up batch' : describeSchedule(schedule) };
  if (t.kind === 'batch') {
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM followups WHERE task_id = ? GROUP BY status', t.id).map((r) => [r.status, r.n]));
    const reading = campaignRef?.taskId === t.id && campaignRef.running ? { done: campaignRef.done, total: campaignRef.total } : null;
    const nextDue = get("SELECT MIN(due_at) d FROM followups WHERE task_id = ? AND status = 'approved'", t.id).d;
    Object.assign(view, { progress: { reading, drafts: counts.pending || 0, queued: counts.approved || 0, sent: counts.sent || 0, skipped: counts.skipped || 0, failed: counts.failed || 0 }, next_run_at: t.status === 'active' ? nextDue : null });
  }
  return view;
}

export const listTasks = (includeRemoved = false) =>
  all(`SELECT * FROM tasks ${includeRemoved ? '' : "WHERE status != 'removed'"} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, id DESC LIMIT 200`).map(taskView);

export function controlTask(id, action) {
  const t = get('SELECT * FROM tasks WHERE id = ?', Number(id));
  if (!t || t.status === 'removed') throw new Error('Task not found');
  if (action === 'pause') {
    if (t.status !== 'active') throw new Error('Only a running task can be paused');
    update('tasks', t.id, { status: 'paused' }, ['status']);
  } else if (action === 'resume') {
    if (t.status !== 'paused') throw new Error('Only a paused task can be resumed');
    const sched = parse(t.schedule, null);
    const next = t.kind === 'batch' ? null : t.next_run_at && t.next_run_at > now() ? t.next_run_at : (sched?.type === 'once' ? now() : nextRun(sched));
    update('tasks', t.id, { status: 'active', next_run_at: next }, ['status', 'next_run_at']);
  } else if (action === 'run') {
    if (t.kind === 'batch') throw new Error('A follow-up batch already runs on its own schedule');
    update('tasks', t.id, { status: 'active', next_run_at: now() }, ['status', 'next_run_at']);
  } else if (action === 'remove') {
    update('tasks', t.id, { status: 'removed', next_run_at: null }, ['status', 'next_run_at']);
    const { changes } = run("UPDATE followups SET status = 'skipped', error = 'Task removed' WHERE task_id = ? AND status IN ('pending','approved')", t.id);
    if (campaignRef?.taskId === t.id && campaignRef.running) campaignRef.cancel = true;
    if (changes) emit('followups');
  } else throw new Error('Unknown action');
  log('info', 'tasks', `Task #${t.id} ${{ pause: 'paused', resume: 'resumed', run: 'started now', remove: 'removed' }[action]}`);
  emit('tasks');
  return taskView(get('SELECT * FROM tasks WHERE id = ?', t.id));
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Batches finish once nothing is left to read, approve or send.
    for (const t of all("SELECT * FROM tasks WHERE kind = 'batch' AND status = 'active'")) {
      const open = get("SELECT COUNT(*) n FROM followups WHERE task_id = ? AND status IN ('pending','approved')", t.id).n;
      const reading = campaignRef?.taskId === t.id && campaignRef.running;
      if (!open && !reading && now() - t.created_at > 5000) {
        const sent = get("SELECT COUNT(*) n FROM followups WHERE task_id = ? AND status = 'sent'", t.id).n;
        update('tasks', t.id, { status: 'done', last_result: `${sent} message${sent === 1 ? '' : 's'} sent`, last_run_at: now() }, ['status', 'last_result', 'last_run_at']);
        emit('tasks');
      }
    }
    const due = get("SELECT * FROM tasks WHERE kind = 'scheduled' AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT 1", now());
    if (!due || !runner) return;
    const sched = parse(due.schedule, null);
    update('tasks', due.id, { next_run_at: null, last_run_at: now() }, ['next_run_at', 'last_run_at']); // never double-fire
    emit('tasks');
    let result;
    let failed = false;
    try {
      result = (await runner(due)).reply;
      failed = /^I could not do that/.test(result || '');
    } catch (e) {
      result = e.message;
      failed = true;
    }
    const fresh = get('SELECT * FROM tasks WHERE id = ?', due.id);
    if (!fresh || fresh.status === 'removed') return;
    const next = fresh.status === 'active' ? nextRun(sched, now(), { ranBefore: true }) : null;
    update('tasks', due.id, {
      runs: (fresh.runs || 0) + 1, last_result: String(result || '').slice(0, 1000),
      next_run_at: fresh.status === 'paused' ? nextRun(sched, now(), { ranBefore: true }) : next,
      status: fresh.status === 'paused' ? 'paused' : next ? 'active' : failed ? 'failed' : 'done',
    }, ['runs', 'last_result', 'next_run_at', 'status']);
    emit('tasks');
  } catch (e) {
    log('error', 'tasks', e.message);
  } finally {
    ticking = false;
  }
}

export function startTasks() {
  setInterval(tick, 15_000).unref();
}
export const _tick = tick;
