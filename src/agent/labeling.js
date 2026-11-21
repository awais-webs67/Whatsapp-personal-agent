// "Jo Eid wali ad se aaye unhein 'Canva Ad' label do": find the chats and put a WhatsApp Business label on each,
// gently paced in the background. The label also becomes the chat's tag, so it works on any number.
import { all, get, run, now } from '../db.js';
import { log, emit } from '../core.js';
import * as wa from '../wa/manager.js';
import { taskEvent } from './task-log.js';

const DAY = 86_400_000;
const list = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

/** The chats a label order means. Any filter left empty does not narrow it. */
export function findChats({ campaignId = null, adText = [], keywords = [], days = 0, tags = [], stage = '' } = {}) {
  const ad = list(adText), words = list(keywords), tg = list(tags);
  let rows = all(`SELECT c.* FROM chats c WHERE c.jid NOT LIKE '%@g.us'
    AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
    AND (?1 = 0 OR c.last_msg_at >= ?2) AND (?3 = '' OR c.stage = ?3)
    AND (?4 IS NULL OR c.campaign_id = ?4 OR EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.task_id = ?4))
    ORDER BY c.last_msg_at DESC LIMIT 2000`, Number(days) > 0 ? 1 : 0, now() - Number(days) * DAY, String(stage || ''), campaignId ? Number(campaignId) : null);
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

/** Put the label on every matching chat. Returns at once with how many; the labels go on one by one. */
export function labelChats(label, filters = {}, { taskId = null, gapMs = 1500 } = {}) {
  const name = String(label || '').trim().slice(0, 40);
  if (!name) throw new Error('Which label? For example: "Canva Ad"');
  const rows = findChats(filters);
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
      if (await wa.applyLabel(c, name).catch(() => false)) ok++;
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 0 : gapMs));
    }
    const line = `Label "${name}": ${ok} of ${rows.length} chats labelled on WhatsApp${ok < rows.length ? ' (the rest got the tag; labels need a WhatsApp Business number linked by QR)' : ''}.`;
    log('info', 'labels', line);
    if (taskId) taskEvent(taskId, line, { kind: 'info' });
  })();
  return { label: name, tag, chats: rows.length, examples: rows.slice(0, 5).map((c) => c.name || (c.phone ? `+${c.phone}` : `chat ${c.id}`)) };
}
