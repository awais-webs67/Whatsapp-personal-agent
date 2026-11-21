// One way to change any campaign, from the dashboard or from Command, with every change in its history.
// Automatic campaigns keep their settings in their own params; a one-time campaign also re-spaces or rewrites
// the messages it has not sent yet.
import { get, run } from '../db.js';
import { emit } from '../core.js';
import { updateAuto, recordChange } from './campaigns.js';
import { changeBatch } from './followups.js';
import { editTask } from './tasks.js';
import { taskEvent } from './task-log.js';

const text = (v, n) => String(v ?? '').trim().slice(0, n);

export async function updateCampaign(id, patch = {}, source = 'dashboard') {
  const t = get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(id));
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  if (t.kind === 'auto') return updateAuto(t.id, patch, source);

  let p = {};
  try { p = JSON.parse(t.params || '{}') || {}; } catch { /* none */ }
  const changed = [];
  const history = {};
  // Extra instructions, layout and example: saved with the campaign, used for every message it writes.
  for (const k of ['instructions', 'format', 'followupStyle']) {
    if (patch[k] === undefined) continue;
    const v = text(patch[k], 1500);
    if (v === (p[k] || '')) continue;
    history[k] = [p[k] || '', v];
    p[k] = v;
    changed.push(k === 'instructions' ? 'campaign instructions' : k === 'format' ? 'message format' : 'example message');
  }
  if (Object.keys(history).length) run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify(p), t.id);
  if (patch.name && text(patch.name, 120) !== t.title) { history.name = [t.title, text(patch.name, 120)]; editTask(t, { title: history.name[1] }); changed.push('name'); }
  if (typeof patch.night === 'boolean' && !!t.ignore_quiet !== patch.night) { history.night = [!!t.ignore_quiet, patch.night]; editTask(t, { ignoreQuiet: patch.night }); changed.push(patch.night ? 'sends at night too' : 'quiet at night'); }

  // What the messages say, the gap and approval: messages not sent yet follow.
  const message = patch.instruction !== undefined && text(patch.instruction, 600) !== t.instruction ? text(patch.instruction, 600) : undefined;
  if (message) { history.message = [t.instruction, message]; editTask(t, { instruction: message }); }
  const lo = patch.gapMin != null ? Number(patch.gapMin) : null;
  const hi = patch.gapMax != null ? Number(patch.gapMax) : null;
  const interval = lo || hi ? (lo && hi && lo !== hi ? [Math.min(lo, hi), Math.max(lo, hi)] : (lo || hi)) : null;
  const autoApprove = typeof patch.approval === 'boolean' ? !patch.approval : undefined;
  if (message || interval || autoApprove !== undefined || patch.startInMinutes != null) {
    const r = await changeBatch(t.id, { instruction: message, interval, autoApprove, startIn: patch.startInMinutes != null ? Number(patch.startInMinutes) : null });
    changed.push(...r.changed);
    if (interval) history.gap = [null, interval];
    if (autoApprove !== undefined) history.approval = [null, !autoApprove];
  }
  if (Object.keys(history).length) recordChange(t.id, source, history);
  if (changed.length && !message && !interval) taskEvent(t.id, `Settings changed (${source}): ${changed.join('; ')}`, { kind: 'changed' });
  emit('tasks');
  return { changed };
}
