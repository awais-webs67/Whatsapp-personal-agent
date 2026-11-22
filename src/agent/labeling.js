// "Jo Eid wali ad se aaye unhein 'Flow Google' label do": find the chats and put a WhatsApp Business label on each,
// gently paced in the background. The label also becomes the chat's tag, so it works on any number.
// An existing label is always used when the name matches (any case or word order); a new one is made only when
// the owner asks for a new label. Labels can be taken off again, or deleted.
import { all, get, run, now } from '../db.js';
import { log, emit } from '../core.js';
import * as wa from '../wa/manager.js';
import { taskEvent } from './task-log.js';

const HOUR = 3_600_000;
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const who = (c) => c.name || (c.phone ? `+${c.phone}` : `chat ${c.id}`);

/** The chats an order means. Any filter left empty does not narrow it. `hours` wins over `days`. */
export function findChats({ campaignId = null, adText = [], keywords = [], days = 0, hours = 0, tags = [], stage = '' } = {}) {
  const ad = list(adText), words = list(keywords), tg = list(tags);
  const span = Number(hours) > 0 ? Number(hours) * HOUR : Number(days) > 0 ? Number(days) * 24 * HOUR : 0;
  let rows = all(`SELECT c.* FROM chats c WHERE c.jid NOT LIKE '%@g.us'
    AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
    AND (?1 = 0 OR COALESCE(c.created_at, c.last_msg_at) >= ?2 OR c.last_in_at >= ?2) AND (?3 = '' OR c.stage = ?3)
    AND (?4 IS NULL OR c.campaign_id = ?4 OR EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.task_id = ?4))
    ORDER BY c.last_msg_at DESC LIMIT 3000`, span ? 1 : 0, now() - span, String(stage || ''), campaignId ? Number(campaignId) : null);
  if (ad.length) rows = rows.filter((c) => c.ad_title && ad.some((w) => c.ad_title.toLowerCase().includes(w)));
  if (tg.length) rows = rows.filter((c) => tg.some((t) => String(c.tags || '').includes(`,${t},`)));
  if (words.length) {
    rows = rows.filter((c) => {
      const known = `${c.summary || ''} ${c.profile || ''} ${c.ad_title || ''}`.toLowerCase();
      return words.some((w) => known.includes(w)) || words.some((w) => get('SELECT 1 x FROM messages WHERE chat_id = ? AND lower(text) LIKE ? LIMIT 1', c.id, `%${w}%`));
    });
  }
  return rows;
}

const filtersOf = (a = {}) => ({ adText: a.adText, keywords: a.keywords, campaignId: a.campaignId, days: a.days, hours: a.hours, tags: a.tags, stage: a.stage });
const hasFilter = (f) => !!(list(f.adText).length || list(f.keywords).length || f.campaignId || Number(f.days) > 0 || Number(f.hours) > 0 || list(f.tags).length || f.stage);

/** Which labels with this name exist, per number. */
function existing(name) {
  return all('SELECT id FROM accounts').flatMap((a) => wa.findLabels(a.id, name).map((l) => ({ ...l, accountId: a.id })));
}

/** What putting a label on would do, without doing it. */
export function previewLabel(label, filters = {}, { create = false } = {}) {
  const name = String(label || '').trim().slice(0, 40);
  if (!name) throw new Error('Which label? Say its name as it is on WhatsApp.');
  const found = existing(name);
  const rows = findChats(filters).filter((c) => !String(c.tags || '').includes(`,${wa.labelTag(found[0]?.name || name)},`));
  const all_ = wa.labelsList();
  return {
    label: found[0]?.name || name, exists: found.length > 0, duplicates: found.length > 1 ? found.length : 0, create: !found.length && create,
    chats: rows.length, examples: rows.slice(0, 5).map(who),
    ...(found.length || create ? {} : { error: `There is no label called "${name}" on WhatsApp. Your labels: ${all_.map((l) => l.name).join(', ') || 'none synced yet'}. Say the exact name, or ask to make a new label. If you made it on the phone just now, say "labels refresh karo".` }),
  };
}

/** Put the label on every matching chat that does not have it yet. Returns at once; the labels go on one by one. */
export function labelChats(label, filters = {}, { taskId = null, gapMs = 1500, create = false } = {}) {
  const p = previewLabel(label, filters, { create });
  if (p.error) return p;
  const rows = findChats(filters);
  const name = p.label;
  const tag = wa.labelTag(name);
  // The tag is put on at once (works everywhere); the phone label follows, paced like a person.
  for (const c of rows) {
    const tags = String(c.tags || '').split(',').filter(Boolean);
    if (!tags.includes(tag)) run('UPDATE chats SET tags = ? WHERE id = ?', `,${[...tags, tag].join(',')},`, c.id);
  }
  emit('chat', {});
  (async () => {
    let ok = 0;
    for (const c of rows) {
      if (await wa.applyLabel(c, name, { create }).catch(() => false)) ok++;
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : gapMs));
    }
    const line = `Label "${name}": ${ok} of ${rows.length} chats labelled on WhatsApp${ok < rows.length ? ' (the rest got the tag only)' : ''}.`;
    log('info', 'labels', line);
    if (taskId) taskEvent(taskId, line, { kind: 'info' });
  })();
  return { label: name, tag, chats: p.chats, examples: p.examples, existing: p.exists, made: p.create };
}

/** What taking a label off would do: which labels and how many chats. */
export function previewUnlabel(label, filters = {}, { deleteLabel = false } = {}) {
  const name = String(label || '').trim();
  if (!name) throw new Error('Which label?');
  const found = existing(name);
  if (!found.length) return { error: `There is no label called "${name}". Your labels: ${wa.labelsList().map((l) => l.name).join(', ') || 'none synced yet'}.` };
  const tags = [...new Set(found.map((l) => wa.labelTag(l.name)))];
  const pool = hasFilter(filters) ? findChats(filters) : all('SELECT * FROM chats WHERE tags IS NOT NULL');
  const rows = pool.filter((c) => tags.some((t) => String(c.tags || '').includes(`,${t},`)));
  const remove = deleteLabel && !hasFilter(filters);
  return { label: found[0].name, copies: found.length, chats: rows.length, examples: rows.slice(0, 5).map(who), delete: remove };
}

/**
 * Take a label off chats (those matching the filters, or every chat that has it). With deleteLabel and no
 * filters the label itself is deleted on the phone (every copy of that name), which takes it off every chat.
 */
export function unlabelChats(label, filters = {}, { deleteLabel = false, taskId = null, gapMs = 800 } = {}) {
  const p = previewUnlabel(label, filters, { deleteLabel });
  if (p.error) return p;
  const found = existing(label);
  const tags = [...new Set(found.map((l) => wa.labelTag(l.name)))];
  const pool = hasFilter(filters) ? findChats(filters) : all('SELECT * FROM chats WHERE tags IS NOT NULL');
  const rows = pool.filter((c) => tags.some((t) => String(c.tags || '').includes(`,${t},`)));
  for (const c of rows) {
    const left = String(c.tags || '').split(',').filter((t) => t && !tags.includes(t));
    run('UPDATE chats SET tags = ? WHERE id = ?', left.length ? `,${left.join(',')},` : null, c.id);
  }
  emit('chat', {});
  (async () => {
    let ok = 0;
    if (p.delete) {
      for (const l of found) if (await wa.deleteLabel(l.accountId, l).catch((e) => { log('warn', 'labels', `Could not delete "${l.name}": ${e.message}`); return false; })) ok++;
      const line = `Label "${p.label}" deleted on WhatsApp (${ok} of ${found.length} cop${found.length === 1 ? 'y' : 'ies'}); it is off ${rows.length} chats.`;
      log('info', 'labels', line);
      if (taskId) taskEvent(taskId, line, { kind: 'changed' });
      return;
    }
    for (const c of rows) {
      for (const l of found.filter((x) => x.accountId === c.account_id)) if (await wa.removeLabel(c, l).catch(() => false)) ok++;
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : gapMs));
    }
    const line = `Label "${p.label}" taken off ${ok} of ${rows.length} chats on WhatsApp.`;
    log('info', 'labels', line);
    if (taskId) taskEvent(taskId, line, { kind: 'changed' });
  })();
  return { label: p.label, chats: p.chats, examples: p.examples, deleted: p.delete, copies: p.copies, removed: true };
}

export { filtersOf };
