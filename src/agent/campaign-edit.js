// One way to change any campaign, from the dashboard or from Command, with every change in its history.
// Automatic campaigns keep their settings in their own params; a one-time campaign also re-spaces or rewrites
// the messages it has not sent yet.
import { get, run } from '../db.js';
import { emit } from '../core.js';
import { updateAuto, recordChange, CAMPAIGN_CLEAN } from './campaigns.js';
import { changeBatch } from './followups.js';
import { editTask } from './tasks.js';
import { taskEvent } from './task-log.js';

const text = (v, n) => String(v ?? '').trim().slice(0, n);

export async function updateCampaign(id, patch = {}, source = 'dashboard') {
  const t = get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(id));
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  if (t.kind === 'auto') return updateAuto(t.id, patch, source);
  if (t.kind === 'email') return updateEmail(t, patch, source);

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
  // Its own offer, price mode, links, quiet hours, daily limit and end date.
  const LABEL = { offer: 'offer and prices', prices: 'price mode', links: 'links', shopLink: 'shop link', quietStart: 'quiet hours', quietEnd: 'quiet hours', dailyCap: 'daily limit', endsAt: 'end date' };
  for (const k of Object.keys(LABEL)) {
    if (patch[k] === undefined) continue;
    const v = CAMPAIGN_CLEAN[k](patch[k]);
    if (JSON.stringify(v) === JSON.stringify(p[k] ?? (k === 'dailyCap' ? 0 : ['offer', 'prices', 'links', 'shopLink'].includes(k) ? '' : null))) continue;
    history[k] = [p[k] ?? null, v];
    p[k] = v;
    if (!changed.includes(LABEL[k])) changed.push(LABEL[k]);
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

/** An email campaign: its instructions, pace, office hours and the wording of emails not written yet. */
function updateEmail(t, patch, source) {
  let p = {};
  try { p = JSON.parse(t.params || '{}') || {}; } catch { /* none */ }
  const history = {};
  const set_ = (k, v) => { if (JSON.stringify(v) !== JSON.stringify(p[k])) { history[k] = [p[k], v]; p[k] = v; } };
  if (patch.instructions !== undefined) set_('instructions', text(patch.instructions, 1500));
  if (patch.gapMin != null) set_('gapMin', Math.max(1, Number(patch.gapMin) || 4));
  if (patch.gapMax != null) set_('gapMax', Math.max(1, Number(patch.gapMax) || 9));
  if (patch.windowStart != null || patch.windowEnd != null) set_('window', [Number(patch.windowStart ?? p.window?.[0] ?? 9), Number(patch.windowEnd ?? p.window?.[1] ?? 17)]);
  if (typeof patch.weekdays === 'boolean') set_('weekdays', patch.weekdays);
  if (Array.isArray(patch.steps)) {
    const steps = (p.steps || []).map((s, i) => ({ ...s, ...(patch.steps[i] ? { instruction: text(patch.steps[i].instruction ?? s.instruction, 1500), days: i ? Math.max(1, Number(patch.steps[i].days ?? s.days) || 3) : 0 } : {}) }));
    set_('steps', steps);
  }
  if (patch.name && text(patch.name, 120) !== t.title) { history.name = [t.title, text(patch.name, 120)]; editTask(t, { title: history.name[1] }); }
  if (!Object.keys(history).length) return { changed: [] };
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify(p), t.id);
  recordChange(t.id, source, history);
  taskEvent(t.id, `Settings changed (${source}): ${Object.keys(history).join(', ')}. Emails not written yet use the new settings.`, { kind: 'changed' });
  emit('tasks');
  return { changed: Object.keys(history) };
}
