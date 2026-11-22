// Bring people who are already in your chats into an always-on campaign ("last 5 hours ke Google Flow ad wale
// is campaign mein daal do"). They get its replies, knowledge and follow-ups from now on.
import { get, run } from '../db.js';
import { emit } from '../core.js';
import { CLOSED } from './brain.js';
import { findChats } from './labeling.js';
import { scheduleNextFollowup } from './pipeline.js';
import { recordChange } from './campaigns.js';
import { taskEvent } from './task-log.js';

const who = (c) => c.name || (c.phone ? `+${c.phone}` : `chat ${c.id}`);

/** Who would join: chats matching the filters that are not in this campaign yet. */
export function previewMembers(taskId, filters = {}) {
  const t = get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(taskId));
  if (!t) return { error: 'Campaign not found' };
  if (t.kind !== 'auto') return { error: 'Only an always-on campaign can take people in. A one-time campaign picks its people when it starts.' };
  const any = Object.values(filters).some((v) => (Array.isArray(v) ? v.length : v));
  if (!any) return { error: 'Say who: words of the ad, words they wrote, the last N hours or days, or a label.' };
  const rows = findChats(filters).filter((c) => c.campaign_id !== t.id && c.stage !== 'opted_out');
  const from = {};
  for (const c of rows) { const name = c.campaign_id ? get('SELECT title FROM tasks WHERE id = ?', c.campaign_id)?.title || 'another campaign' : 'no campaign'; from[name] = (from[name] || 0) + 1; }
  return { campaign: t.title, chats: rows.length, examples: rows.slice(0, 5).map(who), from, ids: rows.map((c) => c.id) };
}

/** Move them in. Their next follow-up follows this campaign's timings. */
export function addMembers(taskId, filters = {}, source = 'dashboard') {
  const p = previewMembers(taskId, filters);
  if (p.error || !p.chats) return { ...p, ids: undefined };
  for (const id of p.ids) {
    run('UPDATE chats SET campaign_id = ? WHERE id = ?', Number(taskId), id);
    const c = get('SELECT stage, next_followup_at FROM chats WHERE id = ?', id);
    if (!CLOSED.includes(c.stage)) scheduleNextFollowup(id);
  }
  recordChange(Number(taskId), source, { people: [null, `${p.chats} added`] });
  taskEvent(Number(taskId), `${p.chats} people already in your chats joined (${source}): ${p.examples.join(', ')}${p.chats > 5 ? '…' : ''}`, { kind: 'info' });
  emit('tasks');
  emit('chat', {});
  const { ids, ...out } = p;
  return { ...out, added: p.chats };
}
