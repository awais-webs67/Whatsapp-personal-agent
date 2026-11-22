// Campaigns: every follow-up flow is one campaign with its own settings, data and history.
//
//   auto       always on. New leads join it by its entry rules (which ad they came from, words in their
//              first message, which number). Its follow-up steps, gap, approval and reply instructions
//              apply to its members only. The "default" one (any lead) takes its timings from Settings.
//   batch      a one-time job from Command or the dashboard (see followups.runCampaign).
//   analysis   reading chats and learning from them.
//   scheduled  repeats an instruction on a schedule.
//
// Campaigns live in the tasks table (kind = campaign type); an auto campaign keeps its settings in `params`.
import { all, get, run, now, update } from '../db.js';
import { getSettings, saveSettings, emit, log, PACING } from '../core.js';
import { taskEvent } from './task-log.js';

const DEFAULT_NAME = 'New leads (automatic)';
// Set by the server (wa/manager.applyLabel) so this module stays free of WhatsApp code.
let labeler = null;
export const setLabeler = (fn) => { labeler = fn; };

/** What an auto campaign can be set to. Unset fields of the default campaign come from Settings. */
export const AUTO_FIELDS = {
  steps: 'hours after the last message before each follow-up, e.g. [24, 72, 168]',
  gapMin: 'minimum minutes between two follow-ups of this campaign',
  gapMax: 'maximum minutes between two follow-ups of this campaign',
  approval: 'true = follow-ups wait for your OK',
  instructions: 'extra instructions for replies to people in this campaign (the offer, what to push, which link)',
  followupStyle: 'an example follow-up message in your words',
  format: 'how this campaign\'s messages are laid out (replaces the general layout rules), one rule per line',
  keywords: 'join when the first message contains one of these words',
  adIds: 'join when the lead came from one of these Meta ad IDs',
  adText: 'join when the ad title contains one of these words',
  accountIds: 'join only for leads on these numbers',
  priority: 'lower number wins when several campaigns match',
  night: 'true = may send in quiet hours',
  autoReply: 'true = the agent answers its leads by itself; false = you answer, the campaign only follows up',
  followups: 'true = it follows up with quiet leads; false = replies only',
  templateFallback: 'true = when no AI model can write, send the example follow-up with name and product filled in',
  label: 'WhatsApp Business label put on every lead that joins (made if it does not exist)',
  labels: 'join when the chat already has one of these WhatsApp labels',
  // Everything below can differ per campaign; empty (null) = the account default from Settings.
  replySpeed: 'instant | fast | natural; empty = the account default',
  voice: 'true/false = listen to voice notes in this campaign; null = account default',
  images: 'true/false = look at pictures in this campaign; null = account default',
  quietStart: 'hour (0-23) after which this campaign sends no follow-ups; null = account quiet hours',
  quietEnd: 'hour (0-23) when this campaign may send again',
  dailyCap: 'most follow-ups this campaign sends per day (0 = only the number\'s limit)',
  offer: 'the products, prices and offer for this campaign (used before the shared Knowledge)',
  prices: 'quote | link: say prices, or never say a price and send the link; empty = account default',
  links: 'links this campaign may send (one per line)',
  shopLink: 'the link sent when a product has no link of its own',
  endsAt: 'timestamp when this campaign pauses by itself (null = runs until you pause it)',
};
/** Fields of the default campaign that are its own (its timings come from Settings). */
const OWN_DEFAULT = ['format', 'instructions', 'followupStyle', 'night', 'templateFallback', 'autoReply', 'followups', 'replySpeed', 'voice', 'images', 'quietStart', 'quietEnd', 'dailyCap', 'offer', 'prices', 'links', 'shopLink', 'endsAt'];

const parseParams = (t) => { try { return JSON.parse(t?.params || '{}') || {}; } catch { return {}; } };
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);

/** The automatic campaign everyone joins when nothing more specific matches. Made once, from today's settings. */
export function ensureDefaultCampaign() {
  let t = get("SELECT * FROM tasks WHERE kind = 'auto' AND json_extract(params, '$.isDefault') = 1 AND status != 'removed' ORDER BY id LIMIT 1");
  if (t) return t;
  const s = getSettings().followup;
  const { lastInsertRowid } = run('INSERT INTO tasks (title, instruction, kind, schedule, status, next_run_at, runs, ignore_quiet, params, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    DEFAULT_NAME, 'Follow up with leads who go quiet, at the times set in this campaign.', 'auto', null, s.enabled ? 'active' : 'paused', null, 0, 0,
    JSON.stringify({ isDefault: true, priority: 1000 }), now());
  const id = Number(lastInsertRowid);
  taskEvent(id, 'Campaign created: automatic follow-ups for every new lead that no other campaign takes', { kind: 'info' });
  // Chats that were already being followed up belong to it.
  run("UPDATE chats SET campaign_id = ? WHERE campaign_id IS NULL", id);
  return get('SELECT * FROM tasks WHERE id = ?', id);
}

/** Settings that apply to one auto campaign (the default one reads Settings, the others their own values). */
export function configOf(t) {
  const p = parseParams(t);
  const f = getSettings().followup;
  const base = { steps: f.stepsHours, gapMin: f.gapMinSec / 60, gapMax: f.gapMaxSec / 60, approval: f.approval, night: false, templateFallback: true, autoReply: true, followups: true, instructions: '', followupStyle: '',
    replySpeed: '', voice: null, images: null, quietStart: null, quietEnd: null, dailyCap: 0, offer: '', prices: '', links: '', shopLink: '', endsAt: null };
  const own = p.isDefault ? Object.fromEntries(OWN_DEFAULT.map((k) => [k, p[k]])) : p;
  const c = { ...base };
  for (const [k, v] of Object.entries(own)) if (v !== undefined && v !== null && k in AUTO_FIELDS) c[k] = v;
  return { ...c, isDefault: !!p.isDefault, label: p.label || '', labels: list(p.labels), keywords: list(p.keywords), adIds: list(p.adIds), adText: list(p.adText), accountIds: list(p.accountIds).map(Number), priority: Number(p.priority ?? 100) };
}

export const autoCampaigns = (statuses = ['active', 'paused']) =>
  all(`SELECT * FROM tasks WHERE kind = 'auto' AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`, ...statuses);

/**
 * What a campaign adds to the AI's instructions, for any campaign kind: its instructions, its message format,
 * its example follow-up and the text of its uploaded files. Sent with every reply, follow-up and message it writes.
 */
export function campaignContext(taskId) {
  const t = taskId && get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", taskId);
  if (!t) return null;
  const p = parseParams(t);
  const c = t.kind === 'auto' ? configOf(t) : p;
  // A task inside a campaign carries the campaign's instructions, files and layout too.
  const parent = t.parent_id ? campaignContext(t.parent_id) : null;
  if (parent) {
    return { ...parent, id: t.id, title: parent.title, kind: t.kind, isDefault: parent.isDefault,
      instructions: [parent.instructions, String(c.instructions || '').trim()].filter(Boolean).join('\n'), format: String(c.format || '').trim() || parent.format,
      followupStyle: String(c.followupStyle || '').trim() || parent.followupStyle, files: [...parent.files, ...(Array.isArray(p.files) ? p.files : [])] };
  }
  return { id: t.id, title: t.title, kind: t.kind, isDefault: !!p.isDefault, instructions: String(c.instructions || '').trim(), format: String(c.format || '').trim(),
    followupStyle: String(c.followupStyle || '').trim(), files: Array.isArray(p.files) ? p.files : [],
    offer: String(c.offer || '').trim(), prices: c.prices || '', links: String(c.links || '').trim(), shopLink: String(c.shopLink || '').trim() };
}

/** The settings a message of this campaign is written with: the account settings plus the campaign's own price mode and links. */
export function withCampaign(settings, taskId) {
  return knowledgeRef ? knowledgeRef(settings, taskId) : settings;
}
// Set by campaign-knowledge.js (which imports this module), so the two never import each other at load time.
let knowledgeRef = null;
export const setKnowledge = (fn) => { knowledgeRef = fn; };

/** How human replies look in this chat's campaign (its reply speed, else the account pacing). */
export function humanFor(chat) {
  const h = getSettings().human;
  const speed = chat ? campaignOf(chat).config.replySpeed : '';
  return speed && PACING[speed] ? { ...h, ...PACING[speed] } : h;
}

/** Whether this chat's voice notes / pictures are read: the campaign's choice, else the account default. */
export function mediaFor(chat) {
  const s = getSettings();
  const c = chat ? campaignOf(chat).config : {};
  return { voice: c.voice ?? s.voice?.transcribe !== false, images: c.images ?? s.images?.read === true };
}

/** A campaign's own quiet hours and daily limit, else the account ones. */
export function deliveryOf(taskId) {
  const s = getSettings().followup;
  const t = taskId && get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) return { quietStart: s.quietStart, quietEnd: s.quietEnd, dailyCap: 0, night: false, own: false };
  const c = t.kind === 'auto' ? configOf(t) : parseParams(t);
  const own = c.quietStart != null && c.quietEnd != null;
  return { quietStart: own ? Number(c.quietStart) : s.quietStart, quietEnd: own ? Number(c.quietEnd) : s.quietEnd, dailyCap: Number(c.dailyCap) || 0, night: !!t.ignore_quiet, own };
}

/** Campaigns with an end date pause themselves when it passes. */
export function endCampaigns() {
  for (const t of all("SELECT * FROM tasks WHERE kind IN ('auto','batch','email') AND status = 'active' AND json_extract(params, '$.endsAt') IS NOT NULL AND json_extract(params, '$.endsAt') <= ?", now())) {
    update('tasks', t.id, { status: 'paused' }, ['status']);
    taskEvent(t.id, 'Paused by itself: its end date was reached. Change the end date or press Resume to run it longer.', { kind: 'paused' });
    log('info', 'campaigns', `Campaign #${t.id} reached its end date and paused`);
    emit('tasks');
  }
}

const MAX_FILES_CHARS = 120_000;
/** Add a file's text to a campaign (any kind). */
export function addCampaignFile(taskId, name, text, source = 'dashboard') {
  const t = get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", taskId);
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const p = parseParams(t);
  const files = (Array.isArray(p.files) ? p.files : []).filter((f) => f.name !== name);
  const total = files.reduce((n, f) => n + f.text.length, 0) + text.length;
  if (total > MAX_FILES_CHARS) throw Object.assign(new Error(`This campaign's files would be too long (${Math.round(total / 1000)}k characters; up to ${MAX_FILES_CHARS / 1000}k). Remove one or upload a shorter file.`), { status: 400 });
  files.push({ name, text, at: now() });
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify({ ...p, files }), t.id);
  recordChange(t.id, source, { file: [null, name] });
  taskEvent(t.id, `File added: ${name} (${text.length} characters). Used in every message of this campaign.`, { kind: 'changed' });
  emit('tasks');
  return { name, chars: text.length };
}
export function removeCampaignFile(taskId, name, source = 'dashboard') {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const p = parseParams(t);
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify({ ...p, files: (p.files || []).filter((f) => f.name !== name) }), t.id);
  recordChange(t.id, source, { file: [name, null] });
  taskEvent(t.id, `File removed: ${name}`, { kind: 'changed' });
  emit('tasks');
  return { ok: true };
}

/** Which campaign a lead belongs to: the first matching entry rule by priority, else the default one. */
export function matchCampaign(chat, firstText = '') {
  const text = String(firstText || '').toLowerCase();
  const rows = autoCampaigns(['active', 'paused']).map((t) => ({ t, c: configOf(t) })).filter((x) => !x.c.isDefault).sort((a, b) => a.c.priority - b.c.priority || a.t.id - b.t.id);
  for (const { t, c } of rows) {
    if (c.accountIds.length && !c.accountIds.includes(chat.account_id)) continue;
    const hasRule = c.keywords.length || c.adIds.length || c.adText.length || c.labels.length;
    if (!hasRule && !c.accountIds.length) continue; // a campaign with no entry rule only gets people added by hand
    if (!hasRule) return t; // "every lead on this number"
    if (c.adIds.length && chat.ad_id && c.adIds.includes(String(chat.ad_id))) return t;
    if (c.adText.length && chat.ad_title && c.adText.some((w) => chat.ad_title.toLowerCase().includes(w.toLowerCase()))) return t;
    if (c.keywords.length && c.keywords.some((w) => text.includes(w.toLowerCase()))) return t;
    const tags = String(chat.tags || '').split(',');
    if (c.labels.length && c.labels.some((l) => tags.includes(String(l).toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-')))) return t;
  }
  return ensureDefaultCampaign();
}

/** Put a lead in its campaign the first time they write (or now, for a lead that has none yet). */
export function assignCampaign(chatId) {
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat || chat.campaign_id) return chat?.campaign_id || null;
  const first = get('SELECT text FROM messages WHERE chat_id = ? AND from_me = 0 ORDER BY ts, id LIMIT 1', chatId)?.text || '';
  const t = matchCampaign(chat, first);
  update('chats', chatId, { campaign_id: t.id }, ['campaign_id']);
  const lab = configOf(t).label;
  if (lab && labeler) labeler(get('SELECT * FROM chats WHERE id = ?', chatId), lab).then((ok) => ok && taskEvent(t.id, `Label "${lab}" put on ${chat.name || chat.phone || `chat ${chat.id}`}`, { kind: 'info', chatId })).catch(() => {});
  if (!configOf(t).isDefault) taskEvent(t.id, `New lead joined: ${chat.name || (chat.phone ? `+${chat.phone}` : `chat ${chat.id}`)}${chat.ad_title ? ` (from the ad "${chat.ad_title}")` : ''}`, { kind: 'info', chatId });
  return t.id;
}

/** The campaign of a chat (auto only), with its settings. */
export function campaignOf(chat) {
  if (!chat) return null;
  const t = chat.campaign_id ? get("SELECT * FROM tasks WHERE id = ? AND kind = 'auto' AND status != 'removed'", chat.campaign_id) : null;
  const camp = t || ensureDefaultCampaign();
  return { task: camp, config: configOf(camp) };
}

/** Record what changed, by whom, so nothing is lost and any change can be undone by hand. */
export function recordChange(taskId, source, changes) {
  for (const [field, [before, after]] of Object.entries(changes)) {
    run('INSERT INTO campaign_changes (task_id, ts, source, field, before, after) VALUES (?,?,?,?,?,?)', taskId, now(), source, field, JSON.stringify(before ?? null), JSON.stringify(after ?? null));
  }
}
export const changesOf = (taskId, limit = 100) =>
  all('SELECT ts, source, field, before, after FROM campaign_changes WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit)
    .map((r) => ({ ...r, before: JSON.parse(r.before), after: JSON.parse(r.after) }));

const clean = {
  steps: (v) => { const n = (Array.isArray(v) ? v : String(v).split(/[^\d.]+/)).map(Number).filter((x) => x > 0 && x <= 24 * 60); if (!n.length) throw new Error('Steps: hours like 24, 72, 168'); return n.slice(0, 8); },
  gapMin: (v) => Math.max(0, Math.min(24 * 60, Number(v) || 0)),
  gapMax: (v) => Math.max(0, Math.min(24 * 60, Number(v) || 0)),
  approval: (v) => !!v,
  night: (v) => !!v,
  autoReply: (v) => !!v,
  followups: (v) => !!v,
  templateFallback: (v) => !!v,
  instructions: (v) => String(v || '').trim().slice(0, 1500),
  followupStyle: (v) => String(v || '').trim().slice(0, 1000),
  format: (v) => String(v || '').trim().slice(0, 1500),
  keywords: (v) => list(v).slice(0, 30),
  adIds: (v) => list(v).slice(0, 30),
  adText: (v) => list(v).slice(0, 30),
  label: (v) => String(v || '').trim().slice(0, 40),
  labels: (v) => list(v).slice(0, 30),
  accountIds: (v) => list(v).map(Number).filter((n) => n > 0),
  priority: (v) => Math.round(Number(v) || 100),
  replySpeed: (v) => (['instant', 'fast', 'natural'].includes(v) ? v : ''),
  voice: (v) => tri(v),
  images: (v) => tri(v),
  quietStart: (v) => hour(v),
  quietEnd: (v) => hour(v),
  dailyCap: (v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0))),
  offer: (v) => String(v || '').trim().slice(0, 4000),
  prices: (v) => (['quote', 'link'].includes(v) ? v : ''),
  links: (v) => String(v || '').trim().slice(0, 1000),
  shopLink: (v) => String(v || '').trim().slice(0, 300),
  endsAt: (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return v && Number.isFinite(n) ? n : null; },
};
/** On, off, or empty = use the account default. */
function tri(v) { return v === null || v === undefined || v === '' || v === 'default' ? null : v === true || v === 'on' || v === 'true' || v === 1; }
function hour(v) { if (v === null || v === undefined || v === '') return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 24 ? n % 24 : null; }
export const CAMPAIGN_CLEAN = clean;

/** Change an auto campaign's settings. The default campaign's timings are stored in Settings (one source). */
export function updateAuto(taskId, patch, source = 'dashboard') {
  const t = get("SELECT * FROM tasks WHERE id = ? AND kind = 'auto'", taskId);
  if (!t) throw Object.assign(new Error('Campaign not found'), { status: 404 });
  const p = parseParams(t);
  const before = configOf(t);
  const changes = {};
  const next = { ...p };
  const toSettings = {};
  for (const [k, raw] of Object.entries(patch || {})) {
    if (!(k in clean)) continue;
    const v = clean[k](raw);
    if (JSON.stringify(v) === JSON.stringify(before[k] ?? (typeof v === 'string' ? '' : before[k]))) continue; // empty = unset
    changes[k] = [before[k], v];
    if (p.isDefault && k === 'steps') toSettings.stepsHours = v;
    else if (p.isDefault && k === 'gapMin') toSettings.gapMinSec = Math.round(v * 60);
    else if (p.isDefault && k === 'gapMax') toSettings.gapMaxSec = Math.round(v * 60);
    else if (p.isDefault && k === 'approval') toSettings.approval = v;
    else next[k] = v;
  }
  if (changes.gapMin || changes.gapMax) { // keep min <= max
    const lo = Math.min(changes.gapMin?.[1] ?? before.gapMin, changes.gapMax?.[1] ?? before.gapMax);
    const hi = Math.max(changes.gapMin?.[1] ?? before.gapMin, changes.gapMax?.[1] ?? before.gapMax);
    if (p.isDefault) Object.assign(toSettings, { gapMinSec: Math.round(lo * 60), gapMaxSec: Math.round(hi * 60) });
    else Object.assign(next, { gapMin: lo, gapMax: hi });
  }
  if (patch.name && String(patch.name).trim() !== t.title) { changes.name = [t.title, String(patch.name).trim().slice(0, 120)]; update('tasks', t.id, { title: changes.name[1] }, ['title']); }
  if (!Object.keys(changes).length) return { changed: [] };
  if (Object.keys(toSettings).length) saveSettings({ followup: toSettings });
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify(next), t.id);
  if (changes.night) run('UPDATE tasks SET ignore_quiet = ? WHERE id = ?', changes.night[1] ? 1 : 0, t.id);
  recordChange(t.id, source, changes);
  const said = Object.entries(changes).map(([k, [, v]]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v === false ? 'no' : v}`);
  taskEvent(t.id, `Settings changed (${source}): ${said.join('; ')}`.slice(0, 480), { kind: 'changed' });
  log('info', 'campaigns', `Campaign #${t.id} changed: ${Object.keys(changes).join(', ')}`);
  emit('tasks');
  return { changed: said };
}

/** A new automatic campaign with its own entry rules and settings. */
export function createAuto({ name, ...settings }, source = 'dashboard') {
  const title = String(name || '').trim() || 'Ad campaign';
  const { lastInsertRowid } = run('INSERT INTO tasks (title, instruction, kind, schedule, status, next_run_at, runs, ignore_quiet, params, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    title.slice(0, 120), 'Leads that match the entry rules join this campaign and get its replies and follow-ups.', 'auto', null, 'active', null, 0, 0, JSON.stringify({ priority: 100 }), now());
  const id = Number(lastInsertRowid);
  taskEvent(id, `Campaign created (${source})`, { kind: 'info' });
  updateAuto(id, settings, source);
  emit('tasks');
  return get('SELECT * FROM tasks WHERE id = ?', id);
}

/** Numbers for the campaign card: members, follow-ups sent, people who answered after one, sales. */
export function statsOf(taskId) {
  const n = (sql, ...p) => get(sql, ...p).n;
  return {
    members: n('SELECT COUNT(*) n FROM chats WHERE campaign_id = ?', taskId),
    sent: n("SELECT COUNT(*) n FROM followups WHERE task_id = ? AND status = 'sent'", taskId),
    waiting: n("SELECT COUNT(*) n FROM followups WHERE task_id = ? AND status IN ('pending','approved')", taskId),
    replied: n(`SELECT COUNT(DISTINCT f.chat_id) n FROM followups f WHERE f.task_id = ? AND f.status = 'sent'
                AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = f.chat_id AND m.from_me = 0 AND m.ts > f.sent_at)`, taskId),
    bought: n("SELECT COUNT(*) n FROM chats WHERE campaign_id = ? AND stage = 'purchased'", taskId),
  };
}

/** Switch every automatic campaign on or off at once ("follow up band karo"). */
export function setAllAuto(on, source = 'command') {
  ensureDefaultCampaign();
  const rows = autoCampaigns([on ? 'paused' : 'active']);
  for (const t of rows) {
    update('tasks', t.id, { status: on ? 'active' : 'paused' }, ['status']);
    recordChange(t.id, source, { status: [on ? 'paused' : 'active', on ? 'active' : 'paused'] });
    taskEvent(t.id, on ? 'Switched on' : 'Switched off', { kind: 'changed' });
  }
  saveSettings({ followup: { enabled: on } });
  emit('tasks');
  return rows.length;
}
