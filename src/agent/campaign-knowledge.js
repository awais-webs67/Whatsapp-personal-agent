// Every campaign has its own knowledge: brand, products and prices, FAQs, policies, examples, tone, rules,
// what it learned from chats and websites, and how it writes. The default campaign's knowledge is the one stored
// in the account settings (so older installs keep everything); a new campaign starts as a copy of it and is
// then fully its own. An empty field falls back to the default campaign, so nothing is ever blank by accident.
import { get, run } from '../db.js';
import { getSettings, saveSettings, emit } from '../core.js';
import { recordChange, setKnowledge } from './campaigns.js';
import { taskEvent } from './task-log.js';

/** [campaign field, account (default campaign) field, label, max length] */
export const KNOW = [
  ['brand', 'name', 'Brand name', 120],
  ['persona', 'persona', 'Who the agent is', 300],
  ['goal', 'goal', 'Goal of the chats', 600],
  ['about', 'about', 'About the business', 4000],
  ['offer', 'catalog', 'Products, services and prices', 20000],
  ['faqs', 'faqs', 'Questions and answers', 12000],
  ['policies', 'policies', 'Delivery, payment, refunds', 6000],
  ['examples', 'examples', 'Example replies', 6000],
  ['tone', 'tone', 'Tone', 600],
  ['language', 'language', 'Language', 600],
  ['purchaseSignal', 'purchaseSignal', 'What counts as a sale', 300],
  ['instructions', null, 'Rules for this campaign', 3000],
  ['memory', 'memory', 'Things you told it to remember', 6000],
  ['learned', 'learned', 'Learned from your chats', 12000],
  ['learnedWeb', 'learnedWeb', 'From your website and WhatsApp profile', 30000],
  ['format', 'format', 'Message layout', 1500],
  ['followupStyle', 'followupStyle', 'Example follow-up', 1000],
  ['links', 'links', 'Links it may send', 1000],
  ['prices', 'prices', 'Prices: say them or send the link', 10],
  ['shopLink', 'shopLink', 'Link when a product has none', 300],
  ['offTopic', 'offTopic', 'Unrelated questions', 10],
];
const parse = (t) => { try { return JSON.parse(t?.params || '{}') || {}; } catch { return {}; } };
const taskOf = (id) => get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(id));
export const isDefault = (t) => !!parse(t).isDefault;
const clean = (k, v, max) => (k === 'prices' ? (['quote', 'link'].includes(v) ? v : '') : k === 'offTopic' ? (['redirect', 'brief'].includes(v) ? v : '') : String(v ?? '').trim().slice(0, max));

/** A campaign's knowledge, field by field (its own values; the default campaign's live in the account). */
export function knowledgeOf(id) {
  const t = taskOf(id);
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const p = parse(t);
  const b = getSettings().business;
  const values = {};
  for (const [k, bk] of KNOW) values[k] = p.isDefault && bk ? (p[k] || b[bk] || '') : (p[k] || '');
  return { id: t.id, title: t.title, isDefault: !!p.isDefault, values, learnedAt: p.isDefault ? b.learnedAt : p.learnedAt || null, fields: KNOW.map(([k, , label]) => ({ key: k, label })) };
}

/** Change some knowledge of a campaign. mode "add" appends a line instead of replacing. */
export function saveKnowledge(id, patch = {}, source = 'dashboard', { mode = 'replace' } = {}) {
  const t = taskOf(id);
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const p = parse(t);
  const cur = knowledgeOf(id).values;
  const history = {};
  const toAccount = {};
  for (const [k, bk, , max] of KNOW) {
    if (patch[k] === undefined) continue;
    let v = clean(k, patch[k], max);
    if (mode === 'add' && v && cur[k]) v = clean(k, `${cur[k]}\n${v}`, max);
    if (v === (cur[k] || '')) continue;
    history[k] = [cur[k] || '', v];
    if (p.isDefault && bk) { toAccount[bk] = v; delete p[k]; } else p[k] = v;
  }
  if (!Object.keys(history).length) return { changed: [] };
  if (patch.learnedAt) p.learnedAt = patch.learnedAt;
  if (Object.keys(toAccount).length) saveSettings({ business: toAccount });
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify(p), t.id);
  recordChange(t.id, source, history);
  const names = Object.keys(history).map((k) => KNOW.find((x) => x[0] === k)[2].toLowerCase());
  taskEvent(t.id, `Knowledge changed (${source}): ${names.join(', ')}`, { kind: 'changed' });
  emit('tasks');
  return { changed: names };
}

/** Start a campaign's knowledge as a copy of another campaign's (by default the default campaign). */
export function copyKnowledge(fromId, toId, source = 'dashboard') {
  const from = knowledgeOf(fromId).values;
  const patch = {};
  for (const [k] of KNOW) if (from[k] && k !== 'instructions') patch[k] = from[k]; // its own rules stay its own
  return saveKnowledge(toId, patch, source);
}

/** The settings a message of this campaign is written with: each knowledge field the campaign has replaces the account's. */
export function knowledgeSettings(settings, taskId) {
  const t = taskId && taskOf(taskId);
  if (!t) return settings;
  const p = parse(t);
  const b = { ...settings.business };
  for (const [k, bk] of KNOW) if (bk && p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') b[bk] = p[k];
  return { ...settings, business: b };
}

/** Add or replace one "Source: …" block in a campaign's website knowledge. */
export function saveSourceBlock(taskId, key, block) {
  const prev = taskId ? knowledgeOf(taskId).values.learnedWeb : getSettings().business.learnedWeb || '';
  const kept = String(prev || '').split(/\n\n(?=Source: )/).filter((x) => x.trim() && !x.startsWith(`Source: ${key}`));
  const text = [...kept, block].join('\n\n');
  if (taskId) saveKnowledge(taskId, { learnedWeb: text }, 'learning');
  else saveSettings({ business: { learnedWeb: text } });
}

setKnowledge(knowledgeSettings);
