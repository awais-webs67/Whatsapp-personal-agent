import dns from 'node:dns';
import net from 'node:net';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, now, parse, update } from './db.js';
import { bus, emit, log, getSettings, saveSettings, kvGet, kvSet, encrypt, SECRET, PACING, migrateSettings } from './core.js';
import { PRESETS, preset } from './llm/catalog.js';
import { listModels, probe, LLMError } from './llm/client.js';
import { listProviders, publicProvider, callProvider, complete, hydrate, syncBalances, startRouterTicker } from './llm/router.js';
import { chooseModel } from './llm/client.js';
import * as wa from './wa/manager.js';
import { STAGES, decide, buildSystem } from './agent/brain.js';
import { startPipeline, onOwner, eligibility, answerNow } from './agent/pipeline.js';
import { runChatCommand, COMMANDS } from './agent/chat-commands.js';
import { startFollowups, runCampaign, campaign, whyNotSending, followupStatus } from './agent/followups.js';
import { learnFromChats, learnFromWebsite, learnFromProfile, learning } from './agent/learn.js';
import { normTags, tagString, tagsOf } from './agent/tags.js';
import { parseCsv, toCsv, normPhone } from './csv.js';
import { taskEvent } from './agent/task-log.js';
import { importKnowledgeFiles, saveUpload, listFiles, removeFile, fileToText } from './agent/knowledge-files.js';
import { updateCampaign } from './agent/campaign-edit.js';
import { labelChats } from './agent/labeling.js';
import { leadScore } from './agent/score.js';
import { mediaStatus } from './agent/voice.js';
import { knowledgeOf, saveKnowledge, copyKnowledge, KNOW } from './agent/campaign-knowledge.js';
import * as email from './email/index.js';
import { setEmailStats } from './agent/tasks.js';
import { handleCommand, startCommander, listThreads, newThread, campaignThread } from './agent/commander.js';
import { listTasks, createTask, controlTask, startTasks } from './agent/tasks.js';
import { taskEvents } from './agent/task-log.js';
import { startWatchdog, health } from './agent/watchdog.js';
import { report } from './agent/reports.js';
import { ensureDefaultCampaign, updateAuto, createAuto, changesOf, AUTO_FIELDS, setLabeler, statsOf as campaignStats, addCampaignFile, removeCampaignFile } from './agent/campaigns.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// On slow or IPv6-broken connections Node's fetch gives up after 250 ms per address and reports
// only "fetch failed". Prefer IPv4 and give each connection attempt more time.
dns.setDefaultResultOrder(process.env.DNS_ORDER || 'ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---------- auth: one owner password, signed cookie ----------
const COOKIE = 'wa_agent';
const WEEK = 7 * 86_400_000;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
function checkPw(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Run by the hub (src/hub.js): the hub signs people in and forwards their requests with this token.
// The workspace listens on 127.0.0.1 only, so nobody else can send it.
const HUB_TOKEN = process.env.HUB_TOKEN || '';
function fromHub(req) {
  const t = String(req.headers['x-hub-token'] || '');
  return !!HUB_TOKEN && t.length === HUB_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(HUB_TOKEN));
}
function authed(req) {
  if (fromHub(req)) return true;
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function startSession(req, res) {
  const exp = String(now() + WEEK);
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${WEEK / 1000}${req.secure ? '; Secure' : ''}`);
}
const attempts = new Map(); // ip -> { n, until }
function throttle(req) {
  const a = attempts.get(req.ip) || { n: 0, until: 0 };
  if (a.until > now()) throw Object.assign(new Error('Too many attempts. Try again in a minute.'), { status: 429 });
  return {
    fail: () => attempts.set(req.ip, { n: a.n + 1, until: a.n + 1 >= 5 ? now() + 60_000 : 0 }),
    ok: () => attempts.delete(req.ip),
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const need = (row, what = 'Item') => { if (!row) throw bad(`${what} not found`, 404); return row; };

app.get('/api/auth', (req, res) => res.json({ setup: !kvGet('password'), authed: authed(req) }));
app.post('/api/auth/setup', wrap((req, res) => {
  if (kvGet('password')) throw bad('Already set up', 409);
  if (String(req.body.password || '').length < 8) throw bad('Use at least 8 characters');
  kvSet('password', hashPw(req.body.password));
  startSession(req, res);
  return { ok: true };
}));
app.post('/api/auth/login', wrap((req, res) => {
  const t = throttle(req);
  if (!checkPw(req.body.password, kvGet('password'))) { t.fail(); throw bad('Wrong password', 401); }
  t.ok();
  startSession(req, res);
  return { ok: true };
}));
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// ---------- Cloud API webhook (public: Meta calls it) ----------
function cloudFor(id) {
  const row = get("SELECT * FROM accounts WHERE id = ? AND type = 'cloud'", Number(id));
  return row ? { row, cfg: parse(row.config), conn: wa.connectorOf(row.id) } : null;
}
app.get('/webhook/cloud/:id', (req, res) => {
  const c = cloudFor(req.params.id);
  if (c && req.query['hub.mode'] === 'subscribe' && c.cfg.verifyToken && req.query['hub.verify_token'] === c.cfg.verifyToken) return res.type('text').send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
app.post('/webhook/cloud/:id', (req, res) => {
  const c = cloudFor(req.params.id);
  if (!c?.conn?.handleWebhook) return res.sendStatus(404);
  if (!c.conn.verifySignature(req.rawBody || Buffer.alloc(0), req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  res.sendStatus(200);
  try { c.conn.handleWebhook(req.body || {}); } catch (e) { log('error', 'whatsapp', `Webhook error: ${e.message}`); }
});

// Shared AI: the hub lends the admin's models to other accounts through this workspace's model chain.
app.post('/internal/ai', wrap(async (req) => {
  if (!fromHub(req)) throw bad('Not allowed', 403);
  const { system = '', messages = [], maxTokens, purpose } = req.body || {};
  const out = await complete({ system: String(system), messages: Array.isArray(messages) ? messages : [], maxTokens: Number(maxTokens) || undefined }, { purpose: purpose === 'reply' ? 'reply' : 'shared' });
  return { text: out.text, model: out.model, usage: out.usage };
}));

// Unsubscribe from email campaigns: a link in every email and the one-click header (no sign-in).
const unsubPage = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;color:#191F24"><h1 style="font-size:22px">${msg}</h1></body>`;
app.get('/u/:token', (req, res) => { const who = email.unsubscribe(req.params.token); res.type('html').send(unsubPage(who ? 'You are unsubscribed. You will not get these emails again.' : 'This link is not valid any more.')); });
app.post('/u/:token', (req, res) => { email.unsubscribe(req.params.token); res.sendStatus(200); });

app.use(express.static(path.join(here, '../public'), { extensions: ['html'] }));
// Lucide icons (ISC licence), used by the dashboard as CSS masks so they take the text colour.
app.use('/icons', express.static(path.join(here, '../node_modules/lucide-static/icons'), { maxAge: '7d' }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Sign in required' })));
// The address people use to open the dashboard, for links that go out in emails (unsubscribe).
let knownUrl = null;
app.use('/api', (req, _res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const url = host && !/^(127\.|localhost|\[::1\])/.test(host) ? `${proto}://${host}` : null;
  if (url && url !== knownUrl) { knownUrl = url; kvSet('publicUrl', url); }
  next();
});

// ---------- live events ----------
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', send);
  req.on('close', () => { clearInterval(ping); bus.off('event', send); });
});

// ---------- overview ----------
app.get('/api/overview', wrap(() => {
  const since = now() - 86_400_000;
  const count = (sql, ...p) => get(sql, ...p).n;
  return {
    settings: { autopilot: getSettings().autopilot, reading: getSettings().reading?.auto !== false },
    webhookBase: process.env.WEBHOOK_PREFIX || '',
    accounts: wa.listAccounts(),
    providers: listProviders().map(publicProvider),
    stats: {
      chats: count('SELECT COUNT(*) n FROM chats'),
      newLeads24h: count('SELECT COUNT(*) n FROM chats WHERE is_new = 1 AND created_at > ?', since),
      inbound24h: count('SELECT COUNT(*) n FROM messages WHERE from_me = 0 AND ts > ?', since),
      aiReplies24h: count("SELECT COUNT(*) n FROM messages WHERE by = 'ai' AND ts > ?", since),
      followups24h: count("SELECT COUNT(*) n FROM messages WHERE by = 'followup' AND ts > ?", since),
      needsHuman: count('SELECT COUNT(*) n FROM chats WHERE needs_human = 1'),
      pendingFollowups: count("SELECT COUNT(*) n FROM followups WHERE status = 'pending'"),
      purchased: count("SELECT COUNT(*) n FROM chats WHERE stage = 'purchased'"),
      activeTasks: count("SELECT COUNT(*) n FROM tasks WHERE status = 'active'"),
    },
    stages: all('SELECT stage, COUNT(*) n FROM chats GROUP BY stage'),
    followups: followupStatus(),
    campaign,
  };
}));

// ---------- accounts ----------
function cloudConfig(body, prev = {}) {
  const c = body.cloud || {};
  return {
    phoneNumberId: String(c.phoneNumberId ?? prev.phoneNumberId ?? '').trim(),
    verifyToken: String(c.verifyToken ?? prev.verifyToken ?? '').trim() || crypto.randomBytes(12).toString('hex'),
    template: String(c.template ?? prev.template ?? '').trim(),
    templateLang: String(c.templateLang ?? prev.templateLang ?? 'en').trim(),
    accessToken: c.accessToken ? encrypt(c.accessToken.trim()) : prev.accessToken || '',
    appSecret: c.appSecret ? encrypt(c.appSecret.trim()) : prev.appSecret || '',
  };
}
const REPLY_MODES = ['all', 'new_only', 'manual'];
app.get('/api/accounts', wrap(() => wa.listAccounts()));
app.post('/api/accounts', wrap(async (req) => {
  const { name, type } = req.body;
  if (!String(name || '').trim()) throw bad('Give this number a name');
  if (!['qr', 'cloud'].includes(type)) throw bad('Unknown connection type');
  const mode = REPLY_MODES.includes(req.body.replyMode) ? req.body.replyMode : type === 'cloud' ? 'all' : 'new_only';
  const { lastInsertRowid } = run('INSERT INTO accounts (name, type, config, reply_mode, created_at) VALUES (?,?,?,?,?)', name.trim(), type, JSON.stringify(type === 'cloud' ? cloudConfig(req.body) : {}), mode, now());
  const id = Number(lastInsertRowid);
  if (type === 'cloud') await wa.connect(id);
  emit('accounts', wa.listAccounts());
  return { id };
}));
app.patch('/api/accounts/:id', wrap(async (req) => {
  const row = need(get('SELECT * FROM accounts WHERE id = ?', Number(req.params.id)), 'Number');
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim() || row.name;
  if (REPLY_MODES.includes(req.body.replyMode)) patch.reply_mode = req.body.replyMode;
  if (req.body.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;
  if (req.body.cloud && row.type === 'cloud') patch.config = JSON.stringify(cloudConfig(req.body, parse(row.config)));
  update('accounts', row.id, patch, ['name', 'reply_mode', 'enabled', 'config']);
  if (patch.config) await wa.connect(row.id);
  emit('accounts', wa.listAccounts());
  return { ok: true };
}));
app.post('/api/accounts/:id/connect', wrap(async (req) => {
  const row = need(get('SELECT * FROM accounts WHERE id = ?', Number(req.params.id)), 'Number');
  const phone = String(req.body.pairPhone || '').replace(/\D/g, '');
  if (req.body.pairPhone && phone.length < 8) throw bad('Enter the full number with country code, digits only');
  await wa.connect(row.id, { pairPhone: phone || null });
  return { ok: true };
}));
app.post('/api/accounts/:id/disconnect', wrap(async (req) => { await wa.disconnect(Number(req.params.id), { logout: !!req.body.logout }); return { ok: true }; }));
app.delete('/api/accounts/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  await wa.disconnect(id, { logout: true });
  run('DELETE FROM accounts WHERE id = ?', id);
  emit('accounts', wa.listAccounts());
  return { ok: true };
}));

// ---------- chats ----------
const chatView = (c) => {
  const account = get('SELECT * FROM accounts WHERE id = ?', c.account_id);
  const [auto, reason] = eligibility(c, account);
  return { ...c, lead: leadScore(c), tagList: tagsOf(c), title: c.name || (c.phone ? `+${c.phone}` : c.jid.split('@')[0]), accountName: account?.name, accountType: account?.type, auto, autoReason: reason };
};
app.get('/api/chats', wrap((req) => {
  const { q = '', stage = '', account = '', filter = '', tag = '', campaign = '' } = req.query;
  const where = ['c.last_msg_at IS NOT NULL'];
  const params = [];
  const t = normTags(tag)[0];
  if (t) { where.push('c.tags LIKE ?'); params.push(`%,${t},%`); }
  if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.last_text LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (STAGES.includes(stage)) { where.push('c.stage = ?'); params.push(stage); }
  if (account) { where.push('c.account_id = ?'); params.push(Number(account)); }
  if (campaign) { where.push('(c.campaign_id = ? OR EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.task_id = ?))'); params.push(Number(campaign), Number(campaign)); }
  if (filter === 'needs_human') where.push('c.needs_human = 1');
  if (filter === 'unread') where.push('c.unread > 0');
  if (filter === 'hot') return all(`SELECT c.* FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.last_msg_at DESC LIMIT 1000`, ...params).map(chatView).filter((c) => c.lead.label === 'hot').sort((a, b) => b.lead.score - a.lead.score).slice(0, 300);
  return all(`SELECT c.* FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.last_msg_at DESC LIMIT 300`, ...params).map(chatView);
}));
/** Your own customers as a spreadsheet (opens in Excel / Google Sheets). Optional ?tag= and ?stage= filters. */
app.get('/api/chats/export.csv', wrap((req, res) => {
  const where = ["c.jid NOT LIKE '%@g.us'", "c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')"];
  const params = [];
  const t = normTags(req.query.tag)[0];
  if (t) { where.push('c.tags LIKE ?'); params.push(`%,${t},%`); }
  if (STAGES.includes(req.query.stage)) { where.push('c.stage = ?'); params.push(req.query.stage); }
  const rows = all(`SELECT c.* FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.last_msg_at DESC`, ...params);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
  const lines = [['Name', 'Phone', 'Stage', 'Tags', 'Last message', 'Last message from customer', 'Summary', 'Notes'].map(cell).join(','),
    ...rows.map((c) => [c.name, c.phone ? `+${c.phone}` : '', c.stage, tagsOf(c).join(' '), date(c.last_msg_at), date(c.last_in_at), c.summary, c.notes].map(cell).join(','))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers${t ? `-${t}` : ''}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`); // BOM: Excel shows Urdu correctly
}));
app.get('/api/chats/:id', wrap((req) => {
  const chat = need(get('SELECT * FROM chats WHERE id = ?', Number(req.params.id)), 'Chat');
  const messages = all('SELECT id, from_me, by, type, text, ts FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 400) ORDER BY ts, id', chat.id);
  const followups = all("SELECT * FROM followups WHERE chat_id = ? AND status IN ('pending','approved') ORDER BY id", chat.id);
  return { chat: chatView(chat), messages, followups };
}));
app.patch('/api/chats/:id', wrap((req) => {
  const chat = need(get('SELECT * FROM chats WHERE id = ?', Number(req.params.id)), 'Chat');
  const b = req.body;
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 120);
  if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 2000);
  if (b.tags !== undefined) patch.tags = tagString(normTags(b.tags));
  if (STAGES.includes(b.stage)) patch.stage = b.stage;
  if (b.aiEnabled !== undefined) patch.ai_enabled = b.aiEnabled === null ? null : b.aiEnabled ? 1 : 0;
  if (b.resume) Object.assign(patch, { needs_human: 0, handoff_reason: null, paused_until: null });
  if (b.read) patch.unread = 0;
  update('chats', chat.id, patch, ['name', 'notes', 'tags', 'stage', 'ai_enabled', 'needs_human', 'handoff_reason', 'paused_until', 'unread']);
  emit('chat', { chatId: chat.id });
  return { ok: true };
}));
app.post('/api/chats/:id/send', wrap(async (req) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Message is empty');
  const id = Number(req.params.id);
  need(get('SELECT id FROM chats WHERE id = ?', id), 'Chat');
  await wa.sendText(id, text, 'owner');
  onOwner(id);
  return { ok: true };
}));
/** Send this exact message to this customer at a set time (a reminder). */
app.post('/api/chats/:id/remind', wrap((req) => {
  const chat = need(get('SELECT id, stage FROM chats WHERE id = ?', Number(req.params.id)), 'Chat');
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Write the message to send');
  if (chat.stage === 'opted_out') throw bad('This person asked not to be contacted');
  const at = req.body.at ? Date.parse(req.body.at) : now();
  if (Number.isNaN(at)) throw bad('Pick a date and time');
  if (at > now() + 366 * 86_400_000) throw bad('That is more than a year away');
  run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, created_at) VALUES (?, 'reminder', ?, 'Scheduled by you', 'approved', ?, ?)", chat.id, text.slice(0, 1500), Math.max(at, now()), now());
  emit('followups');
  emit('chat', { chatId: chat.id });
  return { ok: true, at: Math.max(at, now()) };
}));
/** "/stop", "/bought", "/remind 2h …" typed in the Inbox: run it for this chat, never send it to the customer. */
app.post('/api/chats/:id/command', wrap((req) => {
  const chat = need(get('SELECT id FROM chats WHERE id = ?', Number(req.params.id)), 'Chat');
  return { reply: runChatCommand(chat.id, String(req.body.text || ''), { answerNow }) };
}));
app.get('/api/chat-commands', wrap(() => COMMANDS.map(([cmd, about]) => ({ cmd, about }))));
app.post('/api/chats/:id/suggest', wrap(async (req) => {
  const d = await decide(Number(req.params.id), 'reply');
  return { messages: d.messages, provider: d.provider, model: d.model, handoff: d.handoff, handoffReason: d.handoffReason };
}));

// ---------- providers ----------
function providerInput(body, prev = null) {
  const p = preset(body.preset || prev?.preset) || preset('custom');
  const out = {
    preset: p.id, kind: p.kind,
    name: String(body.name ?? prev?.name ?? p.name).trim() || p.name,
    base_url: String(body.baseUrl ?? prev?.base_url ?? p.baseUrl).trim(),
    model: String(body.model ?? prev?.model ?? p.model).trim(),
    daily_limit: body.dailyLimit === undefined ? prev?.daily_limit ?? null : Number(body.dailyLimit) > 0 ? Math.round(Number(body.dailyLimit)) : null,
  };
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (['all', 'replies', 'background'].includes(body.useFor)) out.use_for = body.useFor;
  if (body.apiKey) out.api_key = encrypt(String(body.apiKey).trim());
  if (out.kind === 'openai' && !/^https?:\/\//.test(out.base_url)) throw bad('Base URL must start with http:// or https://');
  return out;
}
const broadcastProviders = () => emit('providers', listProviders().map(publicProvider));
app.get('/api/presets', wrap(() => PRESETS));
app.get('/api/providers', wrap(() => listProviders().map(publicProvider)));
app.post('/api/providers', wrap(async (req) => {
  const p = providerInput(req.body);
  if (!p.api_key && !preset(p.preset)?.noKey) throw bad('API key is required');
  // Suggested model IDs go stale; if the provider no longer lists this one, start with the closest that it does.
  try {
    const models = await listModels({ ...p, baseUrl: p.base_url, apiKey: String(req.body.apiKey || '').trim() });
    if (models.length && !models.some((m) => m.id === p.model)) p.model = chooseModel(models, p.model) || p.model;
  } catch { /* the test call right after saving reports key or network problems */ }
  const max = get('SELECT COALESCE(MAX(priority), -1) m FROM providers').m;
  const { lastInsertRowid } = run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, daily_limit, priority, use_for, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    p.preset, p.name, p.kind, p.base_url, p.api_key || '', p.model, p.daily_limit, max + 1, p.use_for || 'all', now());
  broadcastProviders();
  syncBalances().catch(() => {});
  return { id: Number(lastInsertRowid) };
}));
app.patch('/api/providers/:id', wrap((req) => {
  const row = need(get('SELECT * FROM providers WHERE id = ?', Number(req.params.id)), 'Model');
  const p = providerInput(req.body, row);
  // A new key or a manual reset clears a bad-key / cooldown state.
  if (p.api_key || req.body.reset || p.model !== row.model) p.state = JSON.stringify({ ...parse(row.state), status: 'ready', cooldownUntil: null, lastError: null });
  update('providers', row.id, p, ['name', 'base_url', 'model', 'daily_limit', 'enabled', 'api_key', 'state', 'use_for']);
  broadcastProviders();
  return { ok: true };
}));
app.delete('/api/providers/:id', wrap((req) => { run('DELETE FROM providers WHERE id = ?', Number(req.params.id)); broadcastProviders(); return { ok: true }; }));
app.post('/api/providers/reorder', wrap((req) => {
  (req.body.ids || []).forEach((id, i) => run('UPDATE providers SET priority = ? WHERE id = ?', i, Number(id)));
  broadcastProviders();
  return { ok: true };
}));
app.get('/api/providers/:id/models', wrap(async (req) => {
  const row = need(get('SELECT * FROM providers WHERE id = ?', Number(req.params.id)), 'Model');
  return { models: await listModels(hydrate(row)) };
}));
/** List models for a key that is not saved yet (the "add model" form). */
app.post('/api/providers/models', wrap(async (req) => {
  const p = providerInput(req.body);
  return { models: await listModels({ ...p, baseUrl: p.base_url, apiKey: String(req.body.apiKey || '').trim() }) };
}));
/** Network check: can this server reach each enabled provider? (No model call, no tokens used.) */
app.post('/api/providers/check', wrap(async () => Promise.all(listProviders().filter((r) => r.enabled).map(async (row) => ({ id: row.id, name: row.name, ...(await probe(hydrate(row))) })))));
app.post('/api/providers/:id/test', wrap(async (req) => {
  const row = need(get('SELECT * FROM providers WHERE id = ?', Number(req.params.id)), 'Model');
  const out = await callProvider(row, { messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }, { purpose: 'test' });
  return { ok: true, text: out.text.slice(0, 200), latencyMs: out.latencyMs, model: out.model };
}));

// ---------- playground ----------
app.post('/api/playground/compare', wrap(async (req) => {
  const ids = (req.body.providerIds || []).map(Number);
  const messages = (req.body.messages || []).filter((m) => m.content);
  if (!ids.length) throw bad('Pick at least one model');
  if (!messages.length) throw bad('Write a message first');
  const rows = listProviders().filter((r) => ids.includes(r.id));
  return Promise.all(rows.map(async (row) => {
    try {
      const out = await callProvider(row, { system: String(req.body.system || ''), messages });
      return { providerId: row.id, name: row.name, ok: true, text: out.text, latencyMs: out.latencyMs, model: out.model, usage: out.usage };
    } catch (e) {
      return { providerId: row.id, name: row.name, ok: false, error: e.message, kind: e.kind };
    }
  }));
}));
/** Talk to the real agent as if you were a customer. Nothing is sent to WhatsApp or saved. */
app.post('/api/playground/agent', wrap(async (req) => {
  const turns = (req.body.messages || []).filter((m) => m.content).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  if (!turns.length) throw bad('Write a message first');
  const fake = { id: 0, name: 'Test customer', stage: req.body.stage || 'new', summary: '', notes: '', last_in_at: now(), followup_count: 0 };
  const d = await decide(0, 'reply', { turns, chatOverride: fake });
  return d;
}));
app.get('/api/playground/prompt', wrap(() => ({
  system: buildSystem(getSettings(), { name: 'Test customer', stage: 'new', summary: '', notes: '', last_in_at: now() }, 'reply'),
})));

// ---------- settings ----------
app.get('/api/settings', wrap(() => getSettings()));
app.get('/api/pacing', wrap(() => PACING));
app.get('/api/learn', wrap(() => learning));
app.post('/api/learn/website', wrap(async (req) => learnFromWebsite(String(req.body.url || ''))));
app.post('/api/learn/files', wrap(() => importKnowledgeFiles({ force: true })));
// Knowledge files (.md, .txt, .docx) uploaded from the Knowledge page: the body is the file itself.
app.get('/api/knowledge/files', wrap(() => listFiles()));
app.post('/api/knowledge/files', express.raw({ type: () => true, limit: '15mb' }), wrap((req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty file');
  return saveUpload(decodeURIComponent(String(req.headers['x-file-name'] || 'notes.txt')), req.body);
}));
app.delete('/api/knowledge/files/:name', wrap((req) => removeFile(req.params.name)));
app.post('/api/learn/profile', wrap(async () => learnFromProfile(await wa.profiles())));

// ---------- tasks ----------
app.get('/api/tasks', wrap(() => listTasks()));
app.post('/api/tasks', wrap((req) => ({ id: createTask({ kind: 'scheduled', title: req.body.title, instruction: req.body.instruction, schedule: req.body.schedule }) })));
// Automatic campaigns: their own settings, entry rules and history.
app.get('/api/health', wrap(() => health()));
app.get('/api/reports', wrap((req) => report(Number(req.query.days) || 30)));
app.get('/api/labels', wrap(() => all('SELECT a.id account_id, a.name account, l.label_id id, l.name, l.color FROM wa_labels l JOIN accounts a ON a.id = l.account_id WHERE l.deleted = 0 ORDER BY a.id, l.name')));
// One campaign's own dashboard: its numbers, people, messages.
const campaignRow = (id) => (id === 'default' ? ensureDefaultCampaign() : need(get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(id)), 'Campaign'));
app.get('/api/campaigns/:id/view', wrap((req) => {
  const t = campaignRow(req.params.id);
  let params = {};
  try { params = JSON.parse(t.params || '{}') || {}; } catch { /* none */ }
  const next = get("SELECT f.due_at, c.name, c.phone, c.id chat_id FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.task_id = ? AND f.status = 'approved' ORDER BY f.due_at LIMIT 1", t.id);
  const nextSend = next && t.status === 'active' ? { at: next.due_at, who: next.name || (next.phone ? `+${next.phone}` : `chat ${next.chat_id}`), chatId: next.chat_id } : null;
  return { ...listTasks().find((x) => x.id === t.id), params, nextSend, stats: t.kind === 'email' ? email.emailStats(t.id) : campaignStats(t.id) };
}));
app.get('/api/campaigns/:id/people', wrap((req) => {
  const t = campaignRow(req.params.id);
  const rows = t.kind === 'auto'
    ? all('SELECT c.* FROM chats c WHERE c.campaign_id = ? ORDER BY c.last_msg_at DESC LIMIT 500', t.id)
    : all('SELECT DISTINCT c.* FROM chats c JOIN followups f ON f.chat_id = c.id WHERE f.task_id = ? ORDER BY c.last_msg_at DESC LIMIT 500', t.id);
  if (t.kind === 'email') return email.emailPeople(t.id);
  return rows.map((c) => {
    const f = get('SELECT status, due_at, sent_at FROM followups WHERE task_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1', t.id, c.id);
    return { id: c.id, lead: leadScore(c), title: c.name || (c.phone ? `+${c.phone}` : `chat ${c.id}`), stage: c.stage, tags: tagsOf(c), lastAt: c.last_msg_at, lastIn: c.last_in_at, ad: c.ad_title, nextFollowup: c.next_followup_at, followups: c.followup_count, message: f || null };
  });
}));
app.get('/api/campaigns/:id/messages', wrap((req) => {
  const t = campaignRow(req.params.id);
  if (t.kind === 'email') return email.emailMessages(t.id);
  return all(`SELECT f.id, f.chat_id, f.kind, f.text, f.reason, f.status, f.error, f.due_at, f.sent_at, COALESCE(c.name, '+' || c.phone, 'chat ' || c.id) who
              FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.task_id = ? ORDER BY COALESCE(f.sent_at, f.due_at) DESC LIMIT 500`, t.id);
}));
// A one-time campaign from the wizard: people already in your chats, picked by number, period, products, stage or tag.
app.post('/api/campaigns/once', wrap(async (req) => {
  const b = req.body || {};
  const instruction = String(b.instruction || '').trim();
  if (!instruction) throw bad('Write what the message should say');
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  const lo = Math.max(1, Number(b.gapMin) || 5), hi = Math.max(lo, Number(b.gapMax) || lo);
  const id = createTask({ kind: 'batch', title: String(b.name || instruction).slice(0, 120), instruction, ignoreQuiet: !!b.night });
  startKnowledge(id, b.knowledgeFrom);
  const c = await runCampaign({ taskId: id, sinceDays: Math.max(1, Number(b.days) || 7), limit: Math.min(500, Number(b.limit) || 200), reanalyze: true, instruction,
    autoApprove: b.send !== false, intervalMinutes: lo === hi ? lo : [lo, hi], stages: list(b.stages), audience: ['buyers', 'non_buyers'].includes(b.audience) ? b.audience : 'all',
    tags: normTags(b.tags), accountIds: list(b.accountIds).map(Number), keywords: list(b.keywords), startAt: Number(b.startInMinutes) > 0 ? now() + Number(b.startInMinutes) * 60_000 : null });
  if (!c.total) { run("UPDATE tasks SET status = 'removed' WHERE id = ?", id); throw bad('No chats match. Try more days, other words, or another number.'); }
  return { id, chats: c.total };
}));
// ---------- email ----------
app.get('/api/email/presets', wrap(() => email.PRESETS));
app.get('/api/email/accounts', wrap(() => email.listAccounts()));
app.post('/api/email/accounts', wrap((req) => email.saveAccount(req.body || {})));
app.patch('/api/email/accounts/:id', wrap((req) => email.saveAccount(req.body || {}, Number(req.params.id))));
app.delete('/api/email/accounts/:id', wrap((req) => email.deleteAccount(Number(req.params.id))));
app.post('/api/email/accounts/:id/test', wrap((req) => email.testAccount(Number(req.params.id))));
app.get('/api/email/check', wrap((req) => email.checkDomain(String(req.query.email || ''), String(req.query.selector || ''))));
app.get('/api/email/lists', wrap(() => email.listLists()));
app.post('/api/email/lists/import', express.raw({ type: () => true, limit: '20mb' }), wrap((req) => email.importContacts(String(req.query.list || ''), req.body.toString('utf8'))));
app.get('/api/email/lists/:list/export.csv', wrap((req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.list.replace(/[^\w.-]+/g, '-')}.csv"`);
  res.send(email.exportList(req.params.list));
}));
app.delete('/api/email/lists/:list', wrap((req) => email.deleteList(req.params.list)));
app.post('/api/campaigns/email', wrap((req) => { const r = email.createEmailCampaign(req.body || {}, createTask); const id = r?.id || r?.taskId; if (id) startKnowledge(id, req.body?.knowledgeFrom); return r; }));

app.get('/api/campaigns/fields', wrap(() => AUTO_FIELDS));
app.post('/api/campaigns', wrap((req) => { const t = createAuto(req.body || {}, 'dashboard'); startKnowledge(t.id, req.body?.knowledgeFrom); return t; }));
// ---------- one campaign's own knowledge, learning and test chat ----------
/** A new campaign starts with a copy of another campaign's knowledge (the default one unless told otherwise, or none). */
function startKnowledge(id, from) {
  if (from === 'none') return;
  const src = Number(from) || ensureDefaultCampaign().id;
  if (src !== Number(id)) { try { copyKnowledge(src, id, 'created'); } catch (e) { log('warn', 'campaigns', `Could not copy knowledge: ${e.message}`); } }
}
app.get('/api/campaigns/:id/knowledge', wrap((req) => ({ ...knowledgeOf(campaignRow(req.params.id).id), files: (JSON.parse(campaignRow(req.params.id).params || '{}').files || []).map((f) => ({ name: f.name, chars: f.text.length })) })));
app.put('/api/campaigns/:id/knowledge', wrap((req) => saveKnowledge(campaignRow(req.params.id).id, req.body || {}, 'dashboard')));
app.post('/api/campaigns/:id/knowledge/copy', wrap((req) => copyKnowledge(Number(req.body.from), campaignRow(req.params.id).id, 'dashboard')));
app.post('/api/campaigns/:id/learn', wrap((req) => learnFromChats({ campaignId: campaignRow(req.params.id).id, maxChats: Math.min(1000, Math.max(1, Number(req.body.maxChats) || 150)) })));
app.post('/api/campaigns/:id/learn/website', wrap(async (req) => learnFromWebsite(String(req.body.url || ''), { campaignId: campaignRow(req.params.id).id })));
app.post('/api/campaigns/:id/learn/profile', wrap(async (req) => learnFromProfile(await wa.profiles(), { campaignId: campaignRow(req.params.id).id })));
/** Chat with this campaign as if you were a new lead of it. Nothing is sent or saved. */
app.post('/api/campaigns/:id/test', wrap(async (req) => {
  const t = campaignRow(req.params.id);
  const turns = (req.body.messages || []).filter((m) => m.content).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  if (!turns.length) throw bad('Write a message first');
  const fake = { id: 0, name: 'Test customer', stage: req.body.stage || 'new', summary: '', notes: '', last_in_at: now(), followup_count: 0, campaign_id: t.id };
  return decide(0, req.body.mode === 'followup' ? 'followup' : 'reply', { turns, chatOverride: fake, campaignId: t.id });
}));
app.get('/api/campaigns/:id/prompt', wrap((req) => ({ system: buildSystem(getSettings(), { id: 0, name: 'Test customer', stage: 'new', summary: '', notes: '', last_in_at: now(), campaign_id: campaignRow(req.params.id).id }, 'reply', '', { campaignId: campaignRow(req.params.id).id }) })));
app.patch('/api/campaigns/:id', wrap((req) => updateCampaign(Number(req.params.id), req.body || {}, 'dashboard')));
// Files with business instructions for one campaign (.md, .txt, .docx): used in every message it writes.
app.post('/api/campaigns/:id/files', express.raw({ type: () => true, limit: '15mb' }), wrap((req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty file');
  const name = decodeURIComponent(String(req.headers['x-file-name'] || 'notes.txt')).slice(0, 80);
  return addCampaignFile(Number(req.params.id), name, fileToText(name, req.body).text, 'dashboard');
}));
app.post('/api/campaigns/:id/label', wrap((req) => labelChats(req.body?.label, { campaignId: Number(req.params.id) }, { taskId: Number(req.params.id) })));
// A campaign's people as a spreadsheet, and a spreadsheet back in: names, tags and notes for people already in
// your chats (matched by phone). Numbers that never wrote to you are not messaged: that is cold WhatsApp and
// gets numbers banned; use an email campaign for cold outreach.
app.get('/api/campaigns/:id/export.csv', wrap((req, res) => {
  const t = campaignRow(req.params.id);
  const rows = t.kind === 'auto'
    ? all('SELECT c.* FROM chats c WHERE c.campaign_id = ? ORDER BY c.last_msg_at DESC', t.id)
    : all('SELECT DISTINCT c.* FROM chats c JOIN followups f ON f.chat_id = c.id WHERE f.task_id = ? ORDER BY c.last_msg_at DESC', t.id);
  const last = (c) => get('SELECT status, sent_at, text FROM followups WHERE task_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1', t.id, c.id);
  const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
  let prof = (c) => { try { return JSON.parse(c.profile || '{}'); } catch { return {}; } };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-${t.id}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(rows, [['name', 'Name'], [(c) => (c.phone ? `+${c.phone}` : ''), 'Phone'], ['stage', 'Stage'], [(c) => tagsOf(c).join(' '), 'Tags'], ['ad_title', 'Ad'],
    [(c) => (prof(c).wants || []).join(', '), 'Asked about'], [(c) => (prof(c).bought || []).join(', '), 'Bought'], ['summary', 'Summary'], [(c) => date(c.last_msg_at), 'Last message'],
    [(c) => last(c)?.status || '', 'Campaign message'], [(c) => `${leadScore(c).label} ${leadScore(c).score}`, 'Lead score'], [(c) => date(last(c)?.sent_at), 'Sent at'], ['notes', 'Notes']]));
}));
app.post('/api/campaigns/:id/import', express.raw({ type: () => true, limit: '10mb' }), wrap((req) => {
  const t = campaignRow(req.params.id);
  const rows = parseCsv(req.body.toString('utf8'));
  if (!rows.length) throw bad('The file has no rows. The first line must be the column names, e.g. phone,name,tags,notes');
  let matched = 0, added = 0;
  const missing = [];
  for (const r of rows) {
    const phone = normPhone(r.phone || r.number || r.whatsapp || r.mobile);
    if (!phone) continue;
    const c = get('SELECT * FROM chats WHERE phone = ? OR jid = ? ORDER BY last_msg_at DESC LIMIT 1', phone, `${phone}@s.whatsapp.net`);
    if (!c) { missing.push(phone); continue; }
    matched++;
    const tags = [...new Set([...tagsOf(c), ...normTags(r.tags || r.tag || r.label || '')])];
    const note = String(r.notes || r.note || '').trim();
    update('chats', c.id, { name: c.name || r.name || r.first_name || null, tags: tagString(tags), notes: note ? [c.notes, note].filter(Boolean).join('\n').slice(-2000) : c.notes }, ['name', 'tags', 'notes']);
    if (t.kind === 'auto' && c.campaign_id !== t.id) { run('UPDATE chats SET campaign_id = ? WHERE id = ?', t.id, c.id); added++; }
  }
  taskEvent(t.id, `Imported a sheet: ${matched} people matched${added ? `, ${added} joined this campaign` : ''}${missing.length ? `, ${missing.length} numbers are not in your chats (not messaged)` : ''}`, { kind: 'changed' });
  emit('chat', {});
  return { rows: rows.length, matched, added, notInChats: missing.length, examples: missing.slice(0, 5) };
}));
app.delete('/api/campaigns/:id/files/:name', wrap((req) => removeCampaignFile(Number(req.params.id), req.params.name, 'dashboard')));
app.get('/api/campaigns/:id/changes', wrap((req) => changesOf(Number(req.params.id))));
app.get('/api/tasks/:id/events', wrap((req) => taskEvents(Number(req.params.id), Number(req.query.limit) || 300)));
app.patch('/api/tasks/:id', wrap((req) => controlTask(Number(req.params.id), String(req.body.action || ''))));

// ---------- owner commands ----------
app.get('/api/commands/threads', wrap(() => listThreads()));
// The command chat inside one campaign: whatever is written there is about that campaign.
app.get('/api/campaigns/:id/commands', wrap((req) => {
  const thread = campaignThread(campaignRow(req.params.id).id);
  return { thread, items: all('SELECT * FROM (SELECT * FROM commands WHERE thread_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', thread).map((c) => ({ ...c, steps: parse(c.steps, []) })) };
}));
app.post('/api/campaigns/:id/commands', wrap(async (req) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Write a command first');
  return handleCommand(text.slice(0, 2000), { campaignId: campaignRow(req.params.id).id });
}));
app.post('/api/commands/threads', wrap(() => ({ id: newThread() })));
app.patch('/api/commands/threads/:id', wrap((req) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) throw bad('Give the chat a name');
  run('UPDATE command_threads SET title = ? WHERE id = ?', title, Number(req.params.id));
  return { ok: true };
}));
app.delete('/api/commands/threads/:id', wrap((req) => {
  run('DELETE FROM commands WHERE thread_id = ?', Number(req.params.id));
  run('DELETE FROM command_threads WHERE id = ?', Number(req.params.id));
  return { ok: true };
}));
app.get('/api/commands', wrap((req) => all('SELECT * FROM (SELECT * FROM commands WHERE thread_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id', Number(req.query.thread) || 0).map((c) => ({ ...c, steps: parse(c.steps, []) }))));
app.post('/api/commands', wrap(async (req) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Write a command first');
  const thread = Number(req.body.thread) || null;
  if (thread && !get('SELECT 1 x FROM command_threads WHERE id = ?', thread)) throw bad('That chat was deleted', 404);
  return handleCommand(text.slice(0, 2000), { threadId: thread });
}));
app.post('/api/learn', wrap((req) => learnFromChats({ accountId: req.body.accountId ? Number(req.body.accountId) : null, maxChats: Math.min(1000, Math.max(1, Number(req.body.maxChats) || 150)) })));
app.get('/api/settings/media', wrap(() => mediaStatus()));
app.put('/api/settings', wrap((req) => {
  const s = saveSettings(req.body || {});
  if (req.body?.business?.prices) kvSet('pricesChosen', true); // the owner decided; saved shop files no longer switch it
  log('info', 'settings', 'Settings updated');
  return s;
}));
app.post('/api/settings/password', wrap((req) => {
  if (!checkPw(req.body.current, kvGet('password'))) throw bad('Current password is wrong', 401);
  if (String(req.body.next || '').length < 8) throw bad('Use at least 8 characters');
  kvSet('password', hashPw(req.body.next));
  return { ok: true };
}));

// ---------- follow-ups ----------
app.get('/api/followups', wrap((req) => {
  const status = ['pending', 'approved', 'sent', 'skipped', 'failed'].includes(req.query.status) ? req.query.status : 'pending';
  return all(`SELECT f.*, c.name, c.phone, c.jid, c.stage, c.summary, c.last_in_at, a.name account_name FROM followups f
              JOIN chats c ON c.id = f.chat_id JOIN accounts a ON a.id = c.account_id
              WHERE f.status = ? ORDER BY f.id DESC LIMIT 300`, status)
    .map((f) => ({ ...f, title: f.name || (f.phone ? `+${f.phone}` : f.jid.split('@')[0]) }));
}));
app.patch('/api/followups/:id', wrap((req) => {
  const f = need(get('SELECT * FROM followups WHERE id = ?', Number(req.params.id)), 'Follow-up');
  if (!['pending', 'approved'].includes(f.status)) throw bad('This follow-up was already handled');
  const patch = {};
  if (req.body.text !== undefined) { patch.text = String(req.body.text).trim(); if (!patch.text) throw bad('Message is empty'); }
  if (['pending', 'approved', 'skipped'].includes(req.body.status)) patch.status = req.body.status;
  update('followups', f.id, patch, ['text', 'status']);
  emit('followups');
  return { ok: true };
}));
app.post('/api/followups/bulk', wrap((req) => {
  const status = { approve: 'approved', skip: 'skipped' }[req.body.action];
  if (!status) throw bad('Unknown action');
  for (const id of req.body.ids || []) run("UPDATE followups SET status = ? WHERE id = ? AND status = 'pending'", status, Number(id));
  emit('followups');
  return { ok: true };
}));
app.get('/api/campaign', wrap(() => campaign));
app.get('/api/sending-status', wrap(() => ({ reason: whyNotSending(null) })));
app.post('/api/campaign', wrap((req) => {
  if (req.body.cancel) { campaign.cancel = true; return campaign; }
  return runCampaign({
    accountId: req.body.accountId ? Number(req.body.accountId) : null,
    sinceDays: Math.min(3650, Math.max(1, Number(req.body.sinceDays) || 90)),
    limit: Math.min(2000, Math.max(1, Number(req.body.limit) || 200)),
    reanalyze: !!req.body.reanalyze,
  });
}));

// ---------- activity ----------
app.get('/api/logs', wrap(() => all('SELECT * FROM logs ORDER BY id DESC LIMIT 300')));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 && !(err instanceof LLMError) ? err.status : err instanceof LLMError ? 502 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Something went wrong', kind: err.kind });
});

/** Models lent by the hub's admin show up as two ordinary providers; they go away when access is taken back. */
export function syncSharedAI(url = process.env.SHARED_AI_URL, key = process.env.SHARED_AI_KEY) {
  const rows = all("SELECT * FROM providers WHERE preset = 'shared'");
  if (!url || !key) { if (rows.length) run("DELETE FROM providers WHERE preset = 'shared'"); return; }
  for (const [name, model, useFor] of [['AivraSol AI (replies)', 'shared-fast', 'replies'], ['AivraSol AI (background)', 'shared-smart', 'background']]) {
    const row = rows.find((r) => r.model === model);
    if (row) run("UPDATE providers SET base_url = ?, api_key = ?, state = '{}' WHERE id = ?", url, encrypt(key), row.id);
    else run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, use_for, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      'shared', name, 'openai', url, encrypt(key), model, get('SELECT COALESCE(MAX(priority), -1) m FROM providers').m + 1, useFor, now());
  }
}

export function start(port = Number(process.env.PORT) || 3000) {
  migrateSettings();
  syncSharedAI();
  const def = ensureDefaultCampaign();
  // Once: every campaign gets its own knowledge (a copy of the default campaign's), so each can be changed alone.
  if (!kvGet('knowledgeSplit2')) {
    const base = knowledgeOf(def.id).values;
    for (const t of all("SELECT id, params FROM tasks WHERE kind IN ('auto','batch') AND status != 'removed' AND id != ?", def.id)) {
      const p = JSON.parse(t.params || '{}') || {};
      const fill = Object.fromEntries(KNOW.filter(([k]) => !p[k] && base[k] && k !== 'instructions').map(([k]) => [k, base[k]]));
      if (Object.keys(fill).length) { try { saveKnowledge(t.id, fill, 'split'); } catch (e) { log('warn', 'campaigns', e.message); } }
    }
    kvSet('knowledgeSplit2', true);
  }
  setLabeler((chat, name) => wa.applyLabel(chat, name, { create: true })); // a campaign's own label is made if missing
  // Started by the hub: stop together with it, and tell it when requests can be forwarded.
  if (process.send) process.on('disconnect', () => process.exit(0));
  // Once on upgrade: re-read saved shop files so an existing install also picks up the price mode they imply.
  try { importKnowledgeFiles({ force: !kvGet('priceModeChecked') }); kvSet('priceModeChecked', true); } catch (e) { log('error', 'learn', `Could not load knowledge files: ${e.message}`); }
  startPipeline();
  startCommander();
  startTasks();
  startFollowups();
  startRouterTicker();
  startWatchdog();
  setEmailStats(email.emailStats);
  email.startEmail();
  wa.startAll();
  syncBalances().catch(() => {});
  // HOST=127.0.0.1 keeps the app reachable only through the HTTPS proxy on a server.
  const host = process.env.HOST || undefined;
  return app.listen(port, host, () => { log('info', 'server', `Dashboard ready on http://${host || 'localhost'}:${port}`); process.send?.({ ready: true }); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('unhandledRejection', (e) => log('error', 'server', `Unhandled: ${e?.message || e}`));
  start();
}
