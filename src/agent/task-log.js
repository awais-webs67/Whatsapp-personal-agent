// What each task did, step by step, with the time: shown under "Details" on the Tasks page.
import { all, run, now } from '../db.js';
import { emit } from '../core.js';

const KEEP = 1000; // newest steps kept per task
let pending = null;

/** kind: info | read | wrote | sent | skipped | failed | paused | changed | done */
export function taskEvent(taskId, text, { kind = 'info', chatId = null } = {}) {
  if (!taskId) return;
  run('INSERT INTO task_events (task_id, ts, kind, text, chat_id) VALUES (?,?,?,?,?)', Number(taskId), now(), kind, String(text).slice(0, 500), chatId);
  if (Math.random() < 0.02) run('DELETE FROM task_events WHERE task_id = ? AND id NOT IN (SELECT id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?)', taskId, taskId, KEEP);
  // Many steps can happen in a second: tell the dashboard once.
  if (!pending) pending = setTimeout(() => { pending = null; emit('tasks'); }, 500);
}

export const taskEvents = (taskId, limit = 300) =>
  all('SELECT id, ts, kind, text, chat_id FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?', Number(taskId), Math.min(1000, Number(limit) || 300));
