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
import { startPipeline, onOwner, eligibility } from './agent/pipeline.js';
import { startFollowups, runCampaign, campaign } from './agent/followups.js';
import { learnFromChats, learnFromWebsite, learnFromProfile, learning } from './agent/learn.js';
import { importKnowledgeFiles } from './agent/knowledge-files.js';
import { handleCommand, startCommander } from './agent/commander.js';
import { listTasks, createTask, controlTask, startTasks } from './agent/tasks.js';

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
function authed(req) {
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

app.use(express.static(path.join(here, '../public'), { extensions: ['html'] }));
app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Sign in required' })));

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
    settings: { autopilot: getSettings().autopilot },
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
  return { ...c, title: c.name || (c.phone ? `+${c.phone}` : c.jid.split('@')[0]), accountName: account?.name, accountType: account?.type, auto, autoReason: reason };
};
app.get('/api/chats', wrap((req) => {
  const { q = '', stage = '', account = '', filter = '' } = req.query;
  const where = ['c.last_msg_at IS NOT NULL'];
  const params = [];
  if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.last_text LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (STAGES.includes(stage)) { where.push('c.stage = ?'); params.push(stage); }
  if (account) { where.push('c.account_id = ?'); params.push(Number(account)); }
  if (filter === 'needs_human') where.push('c.needs_human = 1');
  if (filter === 'unread') where.push('c.unread > 0');
  return all(`SELECT c.* FROM chats c WHERE ${where.join(' AND ')} ORDER BY c.last_msg_at DESC LIMIT 300`, ...params).map(chatView);
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
  if (STAGES.includes(b.stage)) patch.stage = b.stage;
  if (b.aiEnabled !== undefined) patch.ai_enabled = b.aiEnabled === null ? null : b.aiEnabled ? 1 : 0;
  if (b.resume) Object.assign(patch, { needs_human: 0, handoff_reason: null, paused_until: null });
  if (b.read) patch.unread = 0;
  update('chats', chat.id, patch, ['name', 'notes', 'stage', 'ai_enabled', 'needs_human', 'handoff_reason', 'paused_until', 'unread']);
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
app.post('/api/learn/profile', wrap(async () => learnFromProfile(await wa.profiles())));

// ---------- tasks ----------
app.get('/api/tasks', wrap(() => listTasks()));
app.post('/api/tasks', wrap((req) => ({ id: createTask({ kind: 'scheduled', title: req.body.title, instruction: req.body.instruction, schedule: req.body.schedule }) })));
app.patch('/api/tasks/:id', wrap((req) => controlTask(Number(req.params.id), String(req.body.action || ''))));

// ---------- owner commands ----------
app.get('/api/commands', wrap(() => all('SELECT * FROM (SELECT * FROM commands ORDER BY id DESC LIMIT 100) ORDER BY id').map((c) => ({ ...c, steps: parse(c.steps, []) }))));
app.post('/api/commands', wrap(async (req) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw bad('Write a command first');
  return handleCommand(text.slice(0, 2000));
}));
app.delete('/api/commands', wrap(() => { run('DELETE FROM commands'); return { ok: true }; }));
app.post('/api/learn', wrap((req) => learnFromChats({ accountId: req.body.accountId ? Number(req.body.accountId) : null, maxChats: Math.min(1000, Math.max(1, Number(req.body.maxChats) || 150)) })));
app.put('/api/settings', wrap((req) => {
  const s = saveSettings(req.body || {});
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

export function start(port = Number(process.env.PORT) || 3000) {
  migrateSettings();
  try { importKnowledgeFiles(); } catch (e) { log('error', 'learn', `Could not load knowledge files: ${e.message}`); }
  startPipeline();
  startCommander();
  startTasks();
  startFollowups();
  startRouterTicker();
  wa.startAll();
  syncBalances().catch(() => {});
  return app.listen(port, () => log('info', 'server', `Dashboard ready on http://localhost:${port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('unhandledRejection', (e) => log('error', 'server', `Unhandled: ${e?.message || e}`));
  start();
}
