// A job is a piece of work inside a campaign that runs on its own for a while (putting labels on chats, taking
// them off, bringing people in). It shows in the campaign's Tasks tab with live progress: done of total.
import { get, run, now } from '../db.js';
import { emit } from '../core.js';
import { createTask } from './tasks.js';
import { taskEvent } from './task-log.js';

const last = new Map(); // jobId -> when the dashboard was last told

export function startJob(parentId, title, total, what) {
  return createTask({ kind: 'job', parentId, title, instruction: title, params: { total, done: 0, what } });
}

export function stepJob(id, done) {
  if (!id) return;
  const t = get('SELECT params FROM tasks WHERE id = ?', id);
  if (!t) return;
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(t.params || '{}'), done }), id);
  if (now() - (last.get(id) || 0) > 1000) { last.set(id, now()); emit('tasks'); }
}

export function finishJob(id, result, { failed = false } = {}) {
  if (!id) return;
  const p = JSON.parse(get('SELECT params FROM tasks WHERE id = ?', id)?.params || '{}');
  run('UPDATE tasks SET status = ?, last_result = ?, last_run_at = ?, params = ? WHERE id = ?', failed ? 'failed' : 'done', String(result).slice(0, 1000), now(), JSON.stringify({ ...p, done: p.total || p.done || 0 }), id);
  taskEvent(id, result, { kind: failed ? 'failed' : 'done' });
  last.delete(id);
  emit('tasks');
}
