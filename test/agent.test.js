// End-to-end checks with a fake LLM server and a fake WhatsApp connector: no network, no real number.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';

const { run, get, all, now } = await import('../src/db.js');
const { encrypt, saveSettings, isQuiet } = await import('../src/core.js');
const { complete, listProviders, publicProvider } = await import('../src/llm/router.js');
const { parseDuration, normalize } = await import('../src/llm/client.js');
const { parseDecision, extractJson } = await import('../src/agent/brain.js');
const wa = await import('../src/wa/manager.js');
const pipeline = await import('../src/agent/pipeline.js');
const followups = await import('../src/agent/followups.js');

// ---- fake OpenAI-compatible server: behaviour is switched per API key ----
const calls = [];
let cmdReplies = [];
let flakyCount = 0;
let tpmCount = 0;
let busyCount = 0;
let flakyBatch = 0;
let quotaOnce = 0;
const budget = { left: 3000, resetAt: 0 }; // scripted answers for the owner-command prompt
let reply = JSON.stringify({ messages: ['Hi! The price is 2500.', 'Want me to book it?'], stage: 'interested', summary: 'Asked price', handoff: false });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace('Bearer ', '');
    calls.push({ key, body: body ? JSON.parse(body) : null });
    const send = (status, json, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(json)); };
    if (key === 'limited') return send(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '120' });
    if (key === 'broke') return send(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details' } });
    if (key === 'batchonly' && req.url.endsWith('/models')) return send(200, { data: [{ id: 'deepseek/deepseek-v4-flash-0731:batch' }, { id: 'deepseek/deepseek-v4-flash-0731', context_length: 128000 }, { id: 'qwen/qwen3-8b', context_length: 32000 }] });
    if (key === 'batchonly' && /:batch$/.test(body && JSON.parse(body).model)) return send(404, { error: { message: `${JSON.parse(body).model} cannot be used with the chat/completions endpoint (adapter DeepInfraBatchAdapter).`, code: 404 } });
    if (key === 'busy' && (busyCount = (busyCount || 0) + 1) <= 2) return send(429, { error: { message: 'Provider returned error', code: 429, metadata: { raw: 'rate-limited upstream' } } }, { 'retry-after': '1' });
    if (key === 'orfree' && req.url.endsWith('/models')) return send(200, { data: [{ id: 'meta/llama-3.3-70b:free', context_length: 131072, pricing: { prompt: '0', completion: '0' } }, { id: 'qwen/qwen3-32b:free', context_length: 40000, pricing: { prompt: '0', completion: '0' } }, { id: 'tiny/model-1b:free', context_length: 4000, pricing: { prompt: '0', completion: '0' } }, { id: 'paid/model', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' } }] });
    if (key === 'flakybatch' && /operations assistant/.test(JSON.parse(body || '{}').messages?.[0]?.content || '') === false && (flakyBatch = (flakyBatch || 0) + 1) === 2) { res.destroy(); return; }
    if (key === 'badkey') return send(401, { error: { message: 'Incorrect API key provided' } });
    if (key === 'flaky' && (flakyCount = (flakyCount || 0) + 1) === 1) return send(200, { model: 'small', choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    if (key === 'toolcalls') return send(200, { model: 'small', choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'stats', arguments: '{"days":3}' } }] }, finish_reason: 'stop' }] });
    if (key === 'think') return send(200, { model: 'qwen', choices: [{ message: { content: '<think>the user wants stats</think>\n{"reply": "Sab theek hai."}' }, finish_reason: 'stop' }] });
    if (key === 'tpm' && (tpmCount = (tpmCount || 0) + 1) === 1) return send(429, { error: { message: 'Rate limit reached for model `llama-3.1-8b-instant` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Used 4500, Requested 2951. Please try again in 1.2s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing', type: 'tokens', code: 'rate_limit_exceeded' } });
    if (key === 'budget') {
      // Like Groq's free tier: a small per-minute token budget that refills shortly, enforced with a 429.
      const need = Math.ceil(JSON.stringify(JSON.parse(body).messages).length / 3.5) + (JSON.parse(body).max_tokens || 0);
      const nowMs = Date.now();
      if (nowMs > budget.resetAt) Object.assign(budget, { left: 3000, resetAt: nowMs + 1500 });
      if (need > budget.left) return send(429, { error: { message: `Rate limit reached on tokens per minute (TPM): Limit 3000, Used ${3000 - budget.left}, Requested ${need}. Please try again in 1.5s.` } });
      budget.left -= need;
      return send(200, { model: 'small', choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: need, completion_tokens: 5 } },
        { 'x-ratelimit-remaining-tokens': String(budget.left), 'x-ratelimit-limit-tokens': '3000', 'x-ratelimit-reset-tokens': `${((budget.resetAt - nowMs) / 1000).toFixed(2)}s` });
    }
    if (key === 'htmlbase' && !req.url.startsWith('/v1/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><html><body>Our website</body></html>'); }
    if (key === 'quotaonce' && !req.url.endsWith('/models') && (quotaOnce = (quotaOnce || 0) + 1) === 1) return send(402, { error: { message: 'Insufficient balance' } });
    if (key === 'cnappid') return send(401, { error: { message: '无效的AppId' } });
    if (key === 'cnbusy') return send(429, { error: { message: '请求过于频繁，请稍后再试' } });
    if (key === 'cnbroke') return send(402, { error: { message: '余额不足' } });
    if (key === 'gone') return send(410, { type: 'about:blank', title: 'Gone', status: 410, detail: "The model 'meta/llama-3.3-70b-instruct' has reached its end of life on 2026-10-01." });
    if (key === 'geo') return send(403, { error: { message: 'Access denied. Please check your network settings.' } });
    if (key === 'short') {
      const mt = JSON.parse(body).max_tokens;
      if (mt < 1000) return send(200, { model: 'small', choices: [{ message: { content: '{"reply": "Pichle 5 din mein' }, finish_reason: 'length' }] });
      return send(200, { model: 'small', choices: [{ message: { content: `{"reply": "done with ${mt}"}` }, finish_reason: 'stop' }] });
    }
    if (key === 'tiny') {
      // Groq free tier: one request may not exceed the per-minute token limit.
      const j = JSON.parse(body);
      const requested = Math.ceil(JSON.stringify(j.messages).length / 4) + (j.max_tokens || 0);
      if (requested > 2000) return send(413, { error: { message: `Request too large for model \`openai/gpt-oss-20b\` in organization \`org_x\` service tier \`on_demand\` on tokens per minute (TPM): Limit 2000, Requested ${requested}, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`, type: 'tokens', code: 'rate_limit_exceeded' } });
      return send(200, { model: 'small', choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: requested, completion_tokens: 5 } });
    }
    if (key === 'groqtool') return send(400, { error: { message: 'Tool choice is none, but model called a tool', type: 'invalid_request_error', code: 'tool_use_failed', failed_generation: '<function=stats>{"days": 5}</function>' } });
    if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'llama-4-70b-versatile' }, { id: 'openai/gpt-oss-120b' }] });
    if (key === 'retired' && calls.at(-1).body?.model === 'llama-3.3-70b-versatile') return send(404, { error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' } });
    send(200, { model: 'fake-1', choices: [{ message: { content: /operations assistant/.test(JSON.parse(body).messages[0].content) && cmdReplies.length ? cmdReplies.shift() : reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } },
      { 'x-ratelimit-remaining-requests': '42', 'x-ratelimit-limit-requests': '100' });
  });
});
let baseUrl;
const addProvider = (name, key, priority) =>
  Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'custom', name, 'openai', baseUrl, encrypt(key), 'fake-1', priority, now()).lastInsertRowid);

const sent = [];
const fake = { sendText: async (jid, text) => { sent.push({ jid, text }); return `out-${sent.length}`; }, typing: async () => {}, markRead: async () => {}, idle: async () => {} };
let deliver;
const until = async (cond, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); } };

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  // Near-instant "human" timings so the suite stays fast.
  saveSettings({ human: { debounceMin: 0.05, debounceMax: 0.05, readMin: 0, readMax: 0, typingCpsMin: 9000, typingCpsMax: 9000, gapMin: 0, gapMax: 0 }, followup: { quietStart: 0, quietEnd: 0, gapMinSec: 0, gapMaxSec: 0, approval: true } });
  run('INSERT INTO accounts (id, name, type, reply_mode, connected_at, created_at) VALUES (1, ?, ?, ?, ?, ?)', 'Test line', 'qr', 'new_only', now() - 10_000, now());
  deliver = wa.attachFake(1, fake).deliver;
  pipeline.startPipeline();
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('helpers', () => {
  assert.equal(parseDuration('12'), 12);
  assert.equal(parseDuration('1m30s'), 90);
  assert.equal(isQuiet(23, 21, 9), true);
  assert.equal(isQuiet(12, 21, 9), false);
  assert.deepEqual(normalize([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }]).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  const chat = { stage: 'new', summary: '' };
  assert.deepEqual(parseDecision('Hello there', 'reply', chat).messages, ['Hello there']);
  assert.throws(() => parseDecision('{"messages": ["broken', 'reply', chat));
  assert.equal(parseDecision('{"messages":["x"],"stage":"nonsense"}', 'reply', chat).stage, 'new');
});

test('router fails over and benches providers with the right reason', async () => {
  const a = addProvider('Limited', 'limited', 0);
  const b = addProvider('Broke', 'broke', 1);
  const c = addProvider('BadKey', 'badkey', 2);
  const d = addProvider('Healthy', 'good', 3);
  const out = await complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.providerName, 'Healthy');
  assert.deepEqual(out.hops.map((h) => h.error), ['rate_limit', 'quota', 'auth']);
  const status = Object.fromEntries(listProviders().map(publicProvider).map((p) => [p.id, p]));
  assert.equal(status[a].status, 'rate_limited');
  assert.ok(status[a].cooldownUntil - Date.now() > 100_000, 'honours retry-after');
  assert.equal(status[b].status, 'quota_exhausted');
  assert.equal(status[c].status, 'invalid_key');
  assert.equal(status[d].status, 'ready');
  assert.equal(status[d].limits.reqRemaining, 42);
  assert.equal(status[d].usage.tokens_in, 50);
  // Benched providers are skipped without being called again.
  const before = calls.length;
  const again = await complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(calls.length, before + 1);
  assert.deepEqual(again.hops.map((h) => h.skipped), ['rate_limited', 'quota_exhausted', 'invalid_key']);
});

test('daily limit benches a provider', async () => {
  const id = listProviders().find((p) => p.name === 'Healthy').id;
  run('UPDATE providers SET daily_limit = 1 WHERE id = ?', id);
  await assert.rejects(complete({ messages: [{ role: 'user', content: 'hi' }] }), /No model could answer. .*Healthy: daily cap reached/);
  run('UPDATE providers SET daily_limit = NULL WHERE id = ?', id);
});

test('new lead gets a human-paced AI reply; several quick messages get one answer', async () => {
  deliver([{ jid: '111@s.whatsapp.net', phone: '111', name: 'Ali', waId: 'in-1', fromMe: false, text: 'hello', type: 'text', ts: now() }]);
  deliver([{ jid: '111@s.whatsapp.net', phone: '111', name: 'Ali', waId: 'in-2', fromMe: false, text: 'price?', type: 'text', ts: now() + 1 }]);
  await until(() => sent.length === 2);
  assert.deepEqual(sent.map((s) => s.text), ['Hi! The price is 2500.', 'Want me to book it?']);
  const chat = get('SELECT * FROM chats WHERE jid = ?', '111@s.whatsapp.net');
  assert.equal(chat.stage, 'interested');
  assert.equal(chat.is_new, 1);
  assert.ok(chat.next_followup_at > now(), 'follow-up scheduled');
  assert.equal(all("SELECT * FROM messages WHERE chat_id = ? AND by = 'ai'", chat.id).length, 2);
  // The model saw both customer messages merged into the conversation.
  assert.match(calls.at(-1).body.messages.at(-1).content, /hello\nprice\?/);
});

test('existing contacts are left alone in "new leads only" mode', async () => {
  const n = sent.length;
  deliver([{ jid: '222@s.whatsapp.net', phone: '222', name: 'Old friend', waId: 'h-1', fromMe: false, text: 'see you tomorrow', type: 'text', ts: now() - 30 * 86_400_000 }], false);
  deliver([{ jid: '222@s.whatsapp.net', phone: '222', name: 'Old friend', waId: 'in-3', fromMe: false, text: 'are you free?', type: 'text', ts: now() }]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, n);
});

test('owner replying by hand pauses the AI', async () => {
  const n = sent.length;
  deliver([{ jid: '111@s.whatsapp.net', waId: 'own-1', fromMe: true, text: 'Ali bhai, I will call you', type: 'text', ts: now() }]);
  const chat = get('SELECT * FROM chats WHERE jid = ?', '111@s.whatsapp.net');
  assert.ok(chat.paused_until > now());
  assert.equal(get('SELECT by FROM messages WHERE wa_id = ?', 'own-1').by, 'owner');
  deliver([{ jid: '111@s.whatsapp.net', waId: 'in-4', fromMe: false, text: 'ok', type: 'text', ts: now() }]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, n);
  run('UPDATE chats SET paused_until = NULL WHERE id = ?', chat.id);
});

test('handoff flags the chat and stops the AI', async () => {
  reply = JSON.stringify({ messages: ['Let me confirm that with the team.'], stage: 'negotiating', summary: 'Wants refund', handoff: true, handoff_reason: 'Refund request' });
  const n = sent.length;
  deliver([{ jid: '111@s.whatsapp.net', waId: 'in-5', fromMe: false, text: 'I want a refund', type: 'text', ts: now() }]);
  await until(() => sent.length === n + 1);
  await until(() => get('SELECT needs_human FROM chats WHERE jid = ?', '111@s.whatsapp.net').needs_human === 1);
  deliver([{ jid: '111@s.whatsapp.net', waId: 'in-6', fromMe: false, text: 'hello??', type: 'text', ts: now() }]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, n + 1);
  run('UPDATE chats SET needs_human = 0 WHERE jid = ?', '111@s.whatsapp.net');
});

test('opt-out stops follow-ups', () => {
  deliver([{ jid: '333@s.whatsapp.net', phone: '333', waId: 'in-7', fromMe: false, text: 'msg mat karo', type: 'text', ts: now() }]);
  assert.equal(get('SELECT stage FROM chats WHERE jid = ?', '333@s.whatsapp.net').stage, 'opted_out');
});

test('due follow-up is drafted, waits for approval, then sends', async () => {
  await until(() => !get("SELECT 1 x FROM chats WHERE jid = '333@s.whatsapp.net' AND last_out_at IS NULL"), 4000).catch(() => {});
  reply = JSON.stringify({ skip: false, message: 'Hi Ali, the offer is still open if you want it.', stage: 'interested', summary: 'Asked price', reason: 'Interested, went quiet' });
  const chat = get('SELECT * FROM chats WHERE jid = ?', '111@s.whatsapp.net');
  run('UPDATE chats SET next_followup_at = ?, stage = ? WHERE id = ?', now() - 1, 'interested', chat.id);
  const n = sent.length;
  await followups._tick();
  const f = get("SELECT * FROM followups WHERE chat_id = ? AND status = 'pending'", chat.id);
  assert.ok(f, 'draft created');
  assert.equal(sent.length, n, 'nothing sent before approval');
  run("UPDATE followups SET status = 'approved' WHERE id = ?", f.id);
  await followups._tick();
  assert.equal(sent.at(-1).text, 'Hi Ali, the offer is still open if you want it.');
  assert.equal(get('SELECT status FROM followups WHERE id = ?', f.id).status, 'sent');
  assert.equal(get('SELECT followup_count FROM chats WHERE id = ?', chat.id).followup_count, 1);
});

test('campaign reviews old chats and drafts follow-ups for approval', async () => {
  const hist = (jid, waId, fromMe, text, daysAgo) => ({ jid, phone: jid.split('@')[0], waId, fromMe, text, type: 'text', ts: now() - daysAgo * 86_400_000 });
  deliver([hist('444@s.whatsapp.net', 'c-1', false, 'How much for the website package?', 10), hist('444@s.whatsapp.net', 'c-2', true, 'It is 50k', 10)], false);
  reply = JSON.stringify({ stage: 'interested', summary: 'Asked about website package, no reply after price', should_followup: true, message: 'Hi! Still thinking about the website package?', reason: 'Interested, never bought' });
  await followups.runCampaign({ sinceDays: 30 });
  await until(() => !followups.campaign.running);
  const chat = get('SELECT * FROM chats WHERE jid = ?', '444@s.whatsapp.net');
  assert.equal(chat.stage, 'interested');
  assert.equal(get("SELECT status FROM followups WHERE chat_id = ? AND kind = 'campaign'", chat.id).status, 'pending');
});

test('learns the owner\'s offers and voice from chats they handled, and the agent is told about it', async () => {
  const { learnFromChats, learning } = await import('../src/agent/learn.js');
  const { buildSystem } = await import('../src/agent/brain.js');
  const { getSettings } = await import('../src/core.js');
  const m = (waId, fromMe, text) => ({ jid: '555@s.whatsapp.net', phone: '555', waId, fromMe, text, type: 'text', ts: now() - 5 * 86_400_000 });
  deliver([m('l-1', false, 'logo ka kya rate hai?'), m('l-2', true, 'Logo design 5000 ka hai bhai, 2 din mein'), m('l-3', false, 'advance?'), m('l-4', true, '50% advance, baqi delivery par')], false);
  reply = JSON.stringify({ offers: ['Logo design - Rs 5000 - 2 days'], faqs: [{ q: 'Advance?', a: '50% advance, rest on delivery' }], policies: [], style: 'Short Roman Urdu, says bhai', examples: ['Logo design 5000 ka hai bhai, 2 din mein'] });
  await learnFromChats();
  await until(() => !learning.running);
  assert.equal(learning.error, null);
  const learned = getSettings().business.learned;
  assert.match(learned, /Logo design - Rs 5000/);
  assert.match(calls.at(-1).body.messages.at(-1).content, /Me: Logo design 5000 ka hai bhai/);
  assert.match(buildSystem(getSettings(), { stage: 'new' }, 'reply'), /Logo design - Rs 5000/);
});

test('owner command: counts, asks nothing extra when told to send, and schedules a spaced batch', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  cmdReplies = [
    JSON.stringify({ action: 'count_targets', args: { days: 30 } }),
    JSON.stringify({ action: 'start_followups', args: { days: 30, instruction: 'Confirm the offer is still open', interval_minutes: 5, send: true } }),
    JSON.stringify({ reply: 'Started: messages go out every 5 minutes.' }),
  ];
  reply = JSON.stringify({ stage: 'interested', summary: 's', should_followup: true, message: 'Offer abhi bhi open hai!', reason: 'owner asked' });
  const out = await runCommand('last 30 din ki chats ko har 5 minute baad follow-up bhejo, pooche baghair');
  assert.deepEqual(out.steps.map((s) => s.action), ['count_targets', 'start_followups']);
  assert.ok(out.steps[0].result.people >= 2);
  assert.match(out.reply, /^Started: messages go out every 5 minutes\.\n📋 Task #\d+ started: reading \d+ chats, one message every 5 min, sends automatically/, 'the app adds what really happened');
  await until(() => !followups.campaign.running);
  const queued = all("SELECT f.due_at, c.stage, c.jid FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.status = 'approved' ORDER BY f.due_at");
  assert.ok(queued.length >= 2, 'batch queued for sending');
  assert.ok(queued[1].due_at - queued[0].due_at >= 4 * 60_000 * 0.99, 'spaced about 5 minutes apart');
  assert.ok(!queued.some((q) => q.jid === '333@s.whatsapp.net'), 'opted-out person is never messaged');
  // The system prompt for the batch carried the owner's instruction.
  assert.ok(calls.some((c) => /Confirm the offer is still open/.test(JSON.stringify(c.body?.messages?.at(-1) || ''))), 'drafts were written with the owner instruction');
  run("UPDATE followups SET status = 'skipped' WHERE status = 'approved'");
});

test('owner command: remember adds a standing instruction the agent sees', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  const { buildSystem } = await import('../src/agent/brain.js');
  const { getSettings } = await import('../src/core.js');
  cmdReplies = [JSON.stringify({ action: 'remember', args: { text: '10% off this week' } }), JSON.stringify({ reply: 'Yaad rakh liya.' })];
  const out = await runCommand('yaad rakho is hafte 10% discount hai');
  assert.equal(out.reply, 'Yaad rakh liya.\n📝 Saved: 10% off this week');
  assert.match(buildSystem(getSettings(), { stage: 'new' }, 'reply'), /10% off this week/);
});

test('a message typed in "Message yourself" is run as a command and answered there', async () => {
  const { startCommander } = await import('../src/agent/commander.js');
  startCommander();
  fake.isSelf = (jid) => jid === '999@s.whatsapp.net';
  cmdReplies = [JSON.stringify({ action: 'stats', args: { days: 1 } }), JSON.stringify({ reply: 'Aaj 3 log aaye.' })];
  const n = sent.length;
  deliver([{ jid: '999@s.whatsapp.net', waId: 'self-1', fromMe: true, text: 'aaj kitne log aaye?', type: 'text', ts: now() }]);
  await until(() => sent.length === n + 1);
  assert.deepEqual(sent.at(-1), { jid: '999@s.whatsapp.net', text: 'Aaj 3 log aaye.' });
  // The agent's own answer echoing back must not start another command.
  deliver([{ jid: '999@s.whatsapp.net', waId: 'out-echo', fromMe: true, text: 'Aaj 3 log aaye.', type: 'text', ts: now() }]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, n + 1);
});

test('website text extraction and profile learning', async () => {
  const { htmlToText, learnFromProfile } = await import('../src/agent/learn.js');
  const { getSettings } = await import('../src/core.js');
  assert.equal(htmlToText('<html><style>x{}</style><h1>Shop</h1><p>Logo &amp; branding</p><script>1</script></html>'), 'Shop\nLogo & branding');
  await learnFromProfile('Category: Software\nProduct: Website - PKR 45000');
  await learnFromProfile('Category: Software\nProduct: Website - PKR 50000');
  const web = getSettings().business.learnedWeb;
  assert.match(web, /PKR 50000/);
  assert.doesNotMatch(web, /PKR 45000/, 're-reading replaces the old block');
});

test('website reader: structured products, Alpine-style attributes, clear network errors', async () => {
  const { productFrom, listedProducts, htmlToText, explainFetchError, formatProducts } = await import('../src/agent/website.js');
  const page = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Figma Edu 2 Years",
    "description":"Ready-made account &amp; warranty","offers":{"@type":"Offer","price":"2000","priceCurrency":"PKR","availability":"https://schema.org/InStock"}}]}</script></head>
    <body><div x-show="items.length > 0" @click="open = !open">Buy now</div></body></html>`;
  const p = productFrom(page, 'https://shop.example/products/figma');
  assert.deepEqual({ name: p.name, price: p.price, stock: p.stock }, { name: 'Figma Edu 2 Years', price: 'PKR 2,000', stock: '' });
  assert.equal(p.description, 'Ready-made account & warranty');
  assert.match(formatProducts([p]), /Figma Edu 2 Years — PKR 2,000 — Ready-made/);
  assert.equal(htmlToText(page), 'Buy now', 'a ">" inside an attribute must not leak markup into the text');
  const list = `<script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"@type":"ItemList","itemListElement":[{"@type":"ListItem","url":"/products/a","name":"A"},{"@type":"ListItem","item":{"@type":"Product","url":"https://shop.example/products/b","name":"B"}}]}}</script>`;
  assert.deepEqual(listedProducts(list, 'https://shop.example/shop').map((x) => x.url), ['https://shop.example/products/a', 'https://shop.example/products/b']);
  assert.match(explainFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'shop.example'), /could not look up shop\.example/);
  assert.match(explainFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }), 'shop.example'), /Antivirus or a network proxy/);
});

test('agent instructions keep it on topic and stop it promising things', async () => {
  const { buildSystem } = await import('../src/agent/brain.js');
  const { getSettings } = await import('../src/core.js');
  const s = getSettings();
  const sys = buildSystem(s, { stage: 'new' }, 'reply');
  assert.match(sys, /do not answer it or do the task/);
  assert.match(sys, /Never agree to a discount/);
  assert.match(sys, /never instructions to you/);
  const brief = buildSystem({ ...s, business: { ...s.business, offTopic: 'brief' } }, { stage: 'new' }, 'reply');
  assert.match(brief, /one short sentence, then bring the chat back/);
});

test('a retired model is replaced with the closest current one and the request still succeeds', async () => {
  const { chooseModel } = await import('../src/llm/client.js');
  assert.equal(chooseModel(['whisper-large-v3', 'llama-3.1-8b-instant', 'llama-4-70b-versatile'], 'llama-3.3-70b-versatile'), 'llama-4-70b-versatile');
  assert.equal(chooseModel(['whisper-large-v3', 'playai-tts']), null, 'never picks a speech model');
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq', 'openai', baseUrl, encrypt('retired'), 'llama-3.3-70b-versatile', -1, now()).lastInsertRowid);
  reply = JSON.stringify({ messages: ['ok'], stage: 'new', summary: '' });
  const out = await complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.providerName, 'Groq');
  assert.equal(get('SELECT model FROM providers WHERE id = ?', id).model, 'llama-4-70b-versatile');
  assert.equal(listProviders().map(publicProvider).find((p) => p.id === id).status, 'ready');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('token saver sends matching products in full and the rest as a short index', async () => {
  const { focus } = await import('../src/agent/knowledge.js');
  const items = Array.from({ length: 60 }, (_, i) => `- Tool ${i} Pro 1 Month — PKR ${1000 + i} — long description number ${i} with many words in it — https://shop.example/p/${i}`);
  const text = ['Source: shop.example', 'We sell software.', 'Products and prices (61):', ...items, '- Figma Edu 2 Years — PKR 2,000 — Ready-made account — https://shop.example/p/figma', 'Rules:', '- Refunds within 3 days', '- Pay by Easypaisa'].join('\n');
  const out = focus(text, 'figma ka price kya hai?');
  assert.ok(out.length < text.length / 2, `much shorter (${out.length} vs ${text.length})`);
  assert.match(out, /Figma Edu 2 Years — PKR 2,000 — Ready-made account — https:\/\/shop\.example\/p\/figma/, 'asked-about product in full');
  assert.match(out, /Tool 3 Pro 1 Month — PKR 1003;/, 'others as name and price');
  assert.doesNotMatch(out, /long description number 3 /, 'without their descriptions');
  assert.match(out, /- Refunds within 3 days\n- Pay by Easypaisa/, 'short lists (rules) stay whole');
  assert.match(out, /We sell software\./);
  assert.equal(focus('- a\n- b', 'x'), '- a\n- b', 'short lists untouched');
});

test('Groq "model called a tool" errors are recovered into a normal command step', async () => {
  const { toolCallToJson } = await import('../src/llm/client.js');
  assert.deepEqual(JSON.parse(toolCallToJson('<function=stats>{"days": 5}</function>')), { action: 'stats', args: { days: 5 } });
  assert.deepEqual(JSON.parse(toolCallToJson('{"name": "remember", "parameters": {"text": "x"}}')), { action: 'remember', args: { text: 'x' } });
  assert.deepEqual(JSON.parse(toolCallToJson('[{"name": "stats", "arguments": "{\\"days\\": 2}"}]')), { action: 'stats', args: { days: 2 } });
  assert.equal(toolCallToJson('{"reply": "done"}'), '{"reply": "done"}', 'our own format passes through');
  assert.equal(toolCallToJson('{"messages": ["hi"], "stage": "new"}'), '{"messages": ["hi"], "stage": "new"}');

  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq small', 'openai', baseUrl, encrypt('groqtool'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  const out = await complete({ messages: [{ role: 'user', content: 'aaj ka haal?' }] }, { purpose: 'command' });
  assert.equal(out.providerName, 'Groq small');
  assert.deepEqual(JSON.parse(out.text), { action: 'stats', args: { days: 5 } });
  assert.equal(listProviders().map(publicProvider).find((p) => p.id === id).status, 'ready', 'not counted as a failure');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('unreliable small-model answers are retried or understood instead of failing', async () => {
  run('UPDATE providers SET enabled = 0');
  const add = (name, key, useFor = 'all') => Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, use_for, created_at) VALUES (?,?,?,?,?,?,?,?,?)', 'groq', name, 'openai', baseUrl, encrypt(key), 'small', -1, useFor, now()).lastInsertRowid);
  const only = (id) => { run('UPDATE providers SET enabled = 0'); run('UPDATE providers SET enabled = 1 WHERE id = ?', id); };
  const ids = [add('Flaky', 'flaky'), add('Tool calls', 'toolcalls'), add('Thinker', 'think')];

  only(ids[0]);
  reply = '{"reply": "ok"}';
  assert.equal((await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' })).text, '{"reply": "ok"}', 'empty first answer is retried');

  only(ids[1]);
  assert.deepEqual(JSON.parse((await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' })).text), { action: 'stats', args: { days: 3 } });

  only(ids[2]);
  assert.equal((await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' })).text, '{"reply": "Sab theek hai."}', '<think> is stripped');
  for (const id of ids) run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('a command that gets an unusable answer is corrected, not abandoned', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  cmdReplies = ['{"action": "make_coffee", "args": {}}', JSON.stringify({ reply: 'Ho gaya.' })];
  const out = await runCommand('kuch karo');
  assert.equal(out.reply, 'Ho gaya.');
  assert.equal(out.steps.length, 0);
  cmdReplies = ['Aaj sab normal hai, koi masla nahi.'];
  assert.equal((await runCommand('haal?')).reply, 'Aaj sab normal hai, koi masla nahi.', 'plain prose is accepted as the answer');
});

test('"Use for" sends customer replies and background work to different models', async () => {
  const { chainFor } = await import('../src/llm/router.js');
  const rows = [{ id: 1, enabled: 1, use_for: 'replies' }, { id: 2, enabled: 1, use_for: 'background' }, { id: 3, enabled: 1, use_for: 'all' }];
  assert.deepEqual(chainFor('reply', rows).map((r) => r.id), [1, 3]);
  assert.deepEqual(chainFor('command', rows).map((r) => r.id), [2, 3]);
  assert.deepEqual(chainFor('command', [{ id: 1, enabled: 1, use_for: 'replies' }]).map((r) => r.id), [1], 'never left with no model');
});

test('model lists keep context window, max output and price from each provider format', async () => {
  const { describeModel } = await import('../src/llm/client.js');
  const groq = describeModel({ id: 'llama-3.1-8b-instant', object: 'model', owned_by: 'Meta', active: true, context_window: 131072, max_completion_tokens: 131072 });
  assert.deepEqual([groq.context, groq.maxOutput, groq.chat, groq.priceIn], [131072, 131072, true, null]);
  const orr = describeModel({ id: 'x/y:free', name: 'X: Y (free)', context_length: 1048576, pricing: { prompt: '0', completion: '0' }, top_provider: { max_completion_tokens: 32000 }, architecture: { output_modalities: ['text'] } });
  assert.deepEqual([orr.context, orr.maxOutput, orr.free, orr.name], [1048576, 32000, true, 'X: Y (free)']);
  const paid = describeModel({ id: 'a/b', context_length: 32768, pricing: { prompt: '0.0000008', completion: '0.0000016' } });
  assert.ok(Math.abs(paid.priceIn - 0.8) < 1e-9 && Math.abs(paid.priceOut - 1.6) < 1e-9, 'per-token prices become per million');
  const together = describeModel({ id: 'meta/llama', context_length: 8192, pricing: { input: 0.18, output: 0.18 } });
  assert.equal(together.priceIn, 0.18);
  const claude = describeModel({ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 128000 });
  assert.deepEqual([claude.context, claude.maxOutput, claude.name], [1000000, 128000, 'Claude Haiku 5.5']);
  assert.equal(describeModel({ id: 'whisper-large-v3' }).chat, false);
  assert.equal(describeModel({ id: 'old-model', active: false }).chat, false, 'retired models are not offered as chat models');
});

test('a per-minute limit is a short pause, not an exhausted quota, and the request still goes through', async () => {
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq TPM', 'openai', baseUrl, encrypt('tpm'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  reply = '{"reply": "ok"}';
  const started = Date.now();
  const out = await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' });
  assert.equal(out.text, '{"reply": "ok"}');
  const waited = Date.now() - started;
  assert.ok(waited >= 1000 && waited < 8000, `waited about as long as Groq asked (${waited}ms)`);
  assert.equal(listProviders().map(publicProvider).find((p) => p.id === id).status, 'ready', 'not benched for an hour');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('automatic model choice skips tiny-context and single-language models', async () => {
  const { chooseModel } = await import('../src/llm/client.js');
  const groq = [
    { id: 'allam-2-7b', context: 4096, chat: true },
    { id: 'llama-3.1-8b-instant', context: 131072, chat: true },
    { id: 'whisper-large-v3', chat: false },
    { id: 'openai/gpt-oss-20b', context: 131072, chat: true },
  ];
  assert.equal(chooseModel(groq, 'llama-3.1-8b-instant-old'), 'llama-3.1-8b-instant');
  assert.notEqual(chooseModel(groq, ''), 'allam-2-7b');
  assert.notEqual(chooseModel(['allam-2-7b', 'qwen/qwen3-32b'], ''), 'allam-2-7b', 'even without context info');
  assert.equal(chooseModel([{ id: 'allam-2-7b', context: 4096 }]), null, 'never picks a model too small for the prompt');
});

test('commands reserve few tokens per step and wait for the per-minute budget instead of failing', async () => {
  const { outputBudget } = await import('../src/llm/router.js');
  assert.equal(outputBudget('llama-3.1-8b-instant', 450, 'command', 1024), 450);
  assert.equal(outputBudget('llama-3.1-8b-instant', undefined, 'reply', 1024), 500);
  assert.equal(outputBudget('openai/gpt-oss-120b', 450, 'command', 1024), 1024, 'reasoning models keep room to think');

  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq budget', 'openai', baseUrl, encrypt('budget'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  reply = '{"reply": "ok"}';
  const big = 'x'.repeat(4000); // ~1150 tokens + 450 reserved per call: two fit in 3000, the third must wait
  for (let i = 0; i < 4; i++) {
    const out = await complete({ system: big, messages: [{ role: 'user', content: 'haal?' }], maxTokens: 450 }, { purpose: 'command' });
    assert.equal(out.text, '{"reply": "ok"}');
  }
  const state = listProviders().map(publicProvider).find((p) => p.id === id);
  assert.equal(state.status, 'ready');
  assert.equal(state.usage.errors, 0, 'paced itself: no 429 ever reached the provider');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('a VPN or country block is reported as a network problem, not a bad key', async () => {
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq geo', 'openai', baseUrl, encrypt('geo'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  await assert.rejects(complete({ messages: [{ role: 'user', content: 'x' }] }), /blocking this connection, most likely because of the VPN/);
  const st = listProviders().map(publicProvider).find((p) => p.id === id);
  assert.equal(st.status, 'unreachable', 'retried after a short pause, not benched as a bad key');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('tasks: a follow-up batch can be paused, resumed and removed', async () => {
  const tasks = await import('../src/agent/tasks.js');
  const id = tasks.createTask({ kind: 'batch', title: 'Test batch', instruction: 'confirm offer' });
  const chat = get("SELECT id FROM chats WHERE jid = '111@s.whatsapp.net'");
  run("UPDATE chats SET stage = 'interested' WHERE id = ?", chat.id);
  run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, task_id, created_at) VALUES (?, 'campaign', 'Paused one', '', 'approved', ?, ?, ?)", chat.id, now() - 1000, id, now());
  tasks.controlTask(id, 'pause');
  const n = sent.length;
  await followups._tick();
  assert.equal(sent.length, n, 'paused task sends nothing');
  assert.equal(tasks.listTasks().find((t) => t.id === id).progress.queued, 1);
  tasks.controlTask(id, 'resume');
  await followups._tick();
  assert.equal(sent.at(-1).text, 'Paused one', 'resumed task sends');
  assert.equal(tasks.listTasks().find((t) => t.id === id).progress.sent, 1);
  run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, task_id, created_at) VALUES (?, 'campaign', 'Never sent', '', 'approved', ?, ?, ?)", chat.id, now() + 60_000, id, now());
  tasks.controlTask(id, 'remove');
  assert.equal(get("SELECT status FROM followups WHERE text = 'Never sent'").status, 'skipped');
  assert.ok(!tasks.listTasks().some((t) => t.id === id), 'removed tasks are hidden');
});

test('tasks: a repeating task runs on time, can be paused, and reports its result', async () => {
  const tasks = await import('../src/agent/tasks.js');
  const { startCommander } = await import('../src/agent/commander.js');
  startCommander();
  const id = tasks.createTask({ kind: 'scheduled', title: 'Stats every 30 min', instruction: 'aaj ka haal batao', schedule: { type: 'every', minutes: 30 } });
  let t = tasks.listTasks().find((x) => x.id === id);
  assert.equal(t.scheduleText, 'Every 30 minutes');
  assert.ok(Math.abs(t.next_run_at - (now() + 30 * 60_000)) < 5000);
  run('UPDATE tasks SET next_run_at = ? WHERE id = ?', now() - 1, id);
  cmdReplies = [JSON.stringify({ action: 'stats', args: { days: 1 } }), JSON.stringify({ reply: 'Aaj 4 log aaye.' })];
  await tasks._tick();
  t = tasks.listTasks().find((x) => x.id === id);
  assert.equal(t.runs, 1);
  assert.equal(t.last_result, 'Aaj 4 log aaye.');
  assert.equal(t.status, 'active');
  assert.ok(t.next_run_at > now() + 29 * 60_000, 'scheduled again in 30 minutes');
  assert.match(get("SELECT text FROM commands WHERE role = 'owner' ORDER BY id DESC LIMIT 1").text, /Task #\d+: Stats every 30 min/);
  tasks.controlTask(id, 'pause');
  run('UPDATE tasks SET next_run_at = ? WHERE id = ?', now() - 1, id);
  await tasks._tick();
  assert.equal(tasks.listTasks().find((x) => x.id === id).runs, 1, 'paused task does not run');
  tasks.controlTask(id, 'remove');

  const once = tasks.createTask({ kind: 'scheduled', instruction: 'ek dafa', schedule: { type: 'once' } });
  cmdReplies = [JSON.stringify({ reply: 'Ho gaya.' })];
  await tasks._tick();
  assert.equal(tasks.listTasks().find((x) => x.id === once).status, 'done');
});

test('tasks: schedule times', async () => {
  const { nextRun, normaliseSchedule } = await import('../src/agent/tasks.js');
  const from = now();
  const daily = nextRun({ type: 'daily', time: '10:00' }, from);
  assert.ok(daily > from && daily <= from + 24 * 3_600_000);
  assert.equal(nextRun({ type: 'every', minutes: 5 }, from), from + 5 * 60_000);
  assert.equal(nextRun({ type: 'once' }, from, { ranBefore: true }), null);
  assert.throws(() => normaliseSchedule({ type: 'daily', time: 'morning' }));
  assert.throws(() => normaliseSchedule({ type: 'every', minutes: 0 }));
});

test('"OK, I am on it" without doing anything is not accepted', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  cmdReplies = [JSON.stringify({ reply: 'Ok, main kaam kar raha hun.' }), JSON.stringify({ reply: 'Theek hai, ho gaya.' }), JSON.stringify({ reply: 'Ok ji.' }), JSON.stringify({ reply: 'Kar raha hun.' })];
  const out = await runCommand('Ali ko offer wala message bhejo');
  assert.equal(out.steps.length, 0);
  assert.match(out.reply, /^I could not start this, so nothing was sent/);
  cmdReplies = [JSON.stringify({ reply: 'Pichle hafte 12 log aaye.' })];
  assert.equal((await runCommand('kitne log aaye?')).reply, 'Pichle hafte 12 log aaye.', 'plain questions are answered normally');
});

test('the agent says why queued messages are not going out', async () => {
  const { whyNotSending } = await import('../src/agent/followups.js');
  const tasks = await import('../src/agent/tasks.js');
  const { saveSettings } = await import('../src/core.js');
  const id = tasks.createTask({ kind: 'batch', title: 'Night batch', instruction: 'x' });
  const chat = get("SELECT id FROM chats WHERE jid = '111@s.whatsapp.net'");
  run("INSERT INTO followups (chat_id, kind, text, reason, status, due_at, task_id, created_at) VALUES (?, 'campaign', 'Night msg', '', 'approved', ?, ?, ?)", chat.id, now() - 1000, id, now());
  saveSettings({ followup: { quietStart: 0, quietEnd: 24 } }); // quiet all day
  assert.match(whyNotSending(id), /^Quiet hours \(0:00 to 24:00/);
  const n = sent.length;
  await followups._tick();
  assert.equal(sent.length, n, 'nothing goes out in quiet hours');
  run('UPDATE tasks SET ignore_quiet = 1 WHERE id = ?', id);
  assert.equal(whyNotSending(id), null);
  await followups._tick();
  assert.equal(sent.at(-1).text, 'Night msg', 'a task allowed to run at night sends');
  saveSettings({ followup: { quietStart: 0, quietEnd: 0 } });
  tasks.controlTask(id, 'remove');
});

test('an answer cut off by the token limit is retried with more room', async () => {
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq short', 'openai', baseUrl, encrypt('short'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  const out = await complete({ messages: [{ role: 'user', content: 'haal?' }], maxTokens: 450 }, { purpose: 'command' });
  assert.equal(out.text, '{"reply": "done with 1350"}', 'retried with three times the room');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('command conversations are saved separately and each remembers its own history', async () => {
  const { handleCommand, listThreads, newThread } = await import('../src/agent/commander.js');
  const a = newThread();
  const b = newThread();
  cmdReplies = [JSON.stringify({ reply: 'Noted: Canva.' })];
  await handleCommand('Mera focus Canva Pro par hai', { threadId: a });
  cmdReplies = [JSON.stringify({ reply: 'Noted: Figma.' })];
  await handleCommand('Mera focus Figma par hai', { threadId: b });
  cmdReplies = [JSON.stringify({ reply: 'Canva Pro.' })];
  await handleCommand('Mera focus kis par tha?', { threadId: a });
  const asked = calls.filter((c) => /operations assistant/.test(c.body?.messages?.[0]?.content || '')).at(-1).body.messages.map((m) => m.content).join(' | ');
  assert.match(asked, /Canva Pro par hai/, 'remembers this conversation');
  assert.doesNotMatch(asked, /Figma par hai/, 'not another one');
  const threads = listThreads();
  const ta = threads.find((t) => t.id === a);
  assert.equal(ta.title, 'Mera focus Canva Pro par hai', 'named after its first message');
  assert.equal(ta.messages, 4);
  assert.ok(threads.some((t) => t.kind === 'whatsapp'), 'WhatsApp self-chat commands have their own conversation');
});

test('orders are understood directly: days, interval, night, one person, questions', async () => {
  const { quickIntent, parseClock } = await import('../src/agent/intent.js');
  const a = quickIntent('Pichle 5 din ki chats check karo, jin logon ne purchase nahi kiya unhein har 10 minute baad follow-up bhejo');
  assert.equal(a.action, 'start_followups');
  assert.deepEqual([a.args.days, a.args.interval_minutes, a.args.send, a.args.ignore_quiet_hours], [5, 10, true, false]);
  const b = quickIntent('sab customers ko reminder bhjo raat ko bhi, pichle 2 hafte');
  assert.deepEqual([b.action, b.args.days, b.args.ignore_quiet_hours], ['start_followups', 14, true]);
  assert.equal(quickIntent('interested logon ko follow up bhejo').args.stages.join(), 'interested,negotiating');
  assert.equal(quickIntent('Ali ko reminder bhejo'), null, 'one named person goes to the model, never to everyone');
  assert.equal(quickIntent('923001234567 ko follow up bhejo'), null);
  assert.equal(quickIntent('kitne follow-up bheje gaye?'), null, 'questions are not orders');
  assert.equal(quickIntent('follow ups rok do').action, 'stop_followups');
  assert.deepEqual(quickIntent('saari chats parho, analysis karo aur un se seekho'), { action: 'analyse_chats', args: { days: 90, again: false } });
  assert.equal(quickIntent('pichle 30 din ki chats dobara parho').args.again, true);
  assert.deepEqual(quickIntent('roz raat 9 baje naye logon ko follow up bhejo').args.daily_at, '21:00');
  assert.equal(quickIntent('roz raat 9 baje naye logon ko follow up bhejo', { scheduled: true }).action, 'start_followups', 'when the scheduled task runs, it sends instead of scheduling again');
  assert.equal(parseClock('subah 10:30 baje'), '10:30');
  assert.equal(parseClock('sham 6 baje'), '18:00');
  assert.equal(parseClock('5 din'), null);
});

test('one order starts the work at once, without any model question', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  await until(() => !followups.campaign.running, 20000);
  cmdReplies = [JSON.stringify({ reply: 'Kya main follow-up bhej dun?' })]; // would be the model's answer; it must never be asked
  reply = JSON.stringify({ stage: 'interested', summary: 's', should_followup: true, message: 'Offer open hai.', reason: 'asked' });
  const before = calls.length;
  const out = await runCommand('pichle 30 din ke logon ko har 5 minute baad follow up bhejo');
  assert.equal(out.steps[0].action, 'start_followups');
  assert.match(out.reply, /^Theek hai, shuru kar diya\.\n📋 Task #\d+ started: reading \d+ chat/);
  assert.equal(calls.slice(before).filter((c) => /operations assistant/.test(c.body?.messages?.[0]?.content || '')).length, 0, 'the command model was not consulted');
  assert.equal(cmdReplies.length, 1);
  cmdReplies = [];
  await until(() => !followups.campaign.running, 20000);
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
});

test('a model that asks "should I?" is told the owner already said yes', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  cmdReplies = [JSON.stringify({ reply: 'Kya main Ali ko message bhej dun?' }), JSON.stringify({ action: 'remember', args: { text: 'Ali wants a callback' } }), JSON.stringify({ reply: 'Ho gaya.' })];
  const out = await runCommand('Ali ko offer wala message bhejo');
  assert.equal(out.steps.length, 1, 'acted after being told not to ask');
  assert.match(JSON.stringify(calls.filter((c) => /operations assistant/.test(c.body?.messages?.[0]?.content || '')).at(-2).body.messages), /do not ask again/);
});

test('"read the chats and learn" runs as a task: every chat gets a stage and summary, then learning starts', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  const tasks = await import('../src/agent/tasks.js');
  await until(() => !followups.campaign.running);
  reply = JSON.stringify({ stage: 'negotiating', summary: 'Wants a discount on the website package', should_followup: false, message: '', reason: '' });
  const n = sent.length;
  const out = await runCommand('saari chats dobara parho, analysis karo aur un se seekho');
  assert.equal(out.steps[0].action, 'analyse_chats');
  const id = out.steps[0].result.task_id;
  await until(() => !followups.campaign.running, 8000);
  await until(() => /^Read \d+ chats?/.test(tasks.listTasks().find((t) => t.id === id)?.last_result || ''), 8000);
  const t = tasks.listTasks().find((x) => x.id === id);
  assert.equal(t.kind, 'analysis');
  assert.match(t.last_result, /negotiating/);
  assert.equal(get("SELECT summary FROM chats WHERE jid = '444@s.whatsapp.net'").summary, 'Wants a discount on the website package');
  assert.equal(sent.length, n, 'analysis sends nothing');
  assert.equal(get("SELECT COUNT(*) n FROM followups WHERE task_id = ?", id).n, 0);
  // Asked again without "dobara": everything is already read and unchanged, so no model is called.
  const before = calls.length;
  const again = await runCommand('saari chats parho aur analysis karo');
  assert.equal(again.steps[0].result.started, false);
  assert.match(again.reply, /already read and nothing new/);
  assert.equal(calls.length, before);
});

test('a request larger than the provider allows is shortened and sent, not failed', async () => {
  const { fitRequest, estimateTokens } = await import('../src/llm/router.js');
  const big = { system: `RULES-START ${'catalogue line. '.repeat(900)} OUTPUT-FORMAT-END`, messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(200)}` })), maxTokens: 1024 };
  const fitted = fitRequest(big, 2500);
  assert.ok(estimateTokens(fitted) + fitted.maxTokens <= 2500, 'fits the budget');
  assert.match(fitted.system, /^RULES-START/); assert.match(fitted.system, /OUTPUT-FORMAT-END$/, 'the start and end of the instructions survive');
  assert.equal(fitted.messages.at(-1).content, big.messages.at(-1).content, 'the latest message is kept whole');
  assert.equal(fitRequest({ system: 'short', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 }, 8000).shortened, undefined, 'small requests are untouched');

  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', 'Groq tiny', 'openai', baseUrl, encrypt('tiny'), 'llama-3.1-8b-instant', -1, now()).lastInsertRowid);
  reply = '{"reply": "ok"}';
  const out = await complete({ system: big.system, messages: big.messages, maxTokens: 1024 }, { purpose: 'analyze' });
  assert.equal(out.text, '{"reply": "ok"}');
  const row = get('SELECT state FROM providers WHERE id = ?', id);
  assert.equal(JSON.parse(row.state).tpm, 2000, 'the limit from the error is remembered');
  assert.equal(listProviders().map(publicProvider).find((p) => p.id === id).status, 'ready');
  // The next big request is shortened before sending: no second 413.
  const before = calls.length;
  await complete({ system: big.system, messages: big.messages, maxTokens: 1024 }, { purpose: 'analyze' });
  assert.equal(calls.length, before + 1, 'fitted on the first try');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('reading a chat for analysis sends the conversation, not the product catalogue', async () => {
  const { decide, leanSystem } = await import('../src/agent/brain.js');
  const { getSettings, saveSettings } = await import('../src/core.js');
  saveSettings({ business: { catalog: Array.from({ length: 40 }, (_, i) => `- Product ${i} — Rs ${i}00 — long description — https://x/p${i}`).join('\n') } });
  assert.ok(leanSystem(getSettings()).length < 1500, 'a short instruction');
  reply = JSON.stringify({ stage: 'interested', summary: 'Asked the price', should_followup: false, message: '', reason: '' });
  const chat = get("SELECT id FROM chats WHERE jid = '444@s.whatsapp.net'");
  const d = await decide(chat.id, 'analyze', { lean: true });
  assert.equal(d.stage, 'interested');
  const sent = calls.at(-1).body;
  assert.doesNotMatch(sent.messages[0].content, /Product 7 /, 'no catalogue in the instructions');
  assert.match(JSON.stringify(sent.messages), /website package/, 'the conversation itself is there');
  assert.equal(sent.max_tokens, 400);
  saveSettings({ business: { catalog: '' } });
});

test('the agent reports on its own: task updates go to the conversation that started the task', async () => {
  const { handleCommand, listThreads } = await import('../src/agent/commander.js');
  const tasks = await import('../src/agent/tasks.js');
  const { newThread } = await import('../src/agent/commander.js');
  await until(() => !followups.campaign.running, 20000);
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  const thread = newThread();
  reply = JSON.stringify({ stage: 'interested', summary: 's', should_followup: true, message: 'Offer abhi bhi open hai.', reason: 'asked' });
  const out = await handleCommand('pichle 30 din ke logon ko har 1 minute baad follow up bhejo', { threadId: thread });
  const taskId = out.steps[0].result.task_id;
  assert.equal(get('SELECT thread_id FROM tasks WHERE id = ?', taskId).thread_id, thread, 'the task remembers where it was asked for');
  await until(() => !followups.campaign.running, 20000);
  const says = () => all('SELECT text FROM commands WHERE thread_id = ? AND role = ? ORDER BY id', thread, 'agent').map((r) => r.text).join('\n');
  assert.match(says(), new RegExp(`Task #${taskId}: Read \\d+ chats?: \\d+ messages? queued`), 'says when reading is done');
  // Make everything due, send, then let the task finish.
  run('UPDATE followups SET due_at = ? WHERE task_id = ?', now() - 1, taskId);
  for (let i = 0; i < 8 && get("SELECT COUNT(*) n FROM followups WHERE task_id = ? AND status = 'approved'", taskId).n; i++) { await followups._tick(); await new Promise((r) => setTimeout(r, 5)); }
  run("UPDATE followups SET status = 'skipped' WHERE task_id = ? AND status = 'approved'", taskId);
  run('UPDATE tasks SET created_at = ? WHERE id = ?', now() - 60_000, taskId);
  await tasks._tick();
  assert.match(says(), /first message sent to/);
  assert.match(says(), new RegExp(`Task #${taskId} finished`), 'says when it is finished');
  assert.ok(listThreads().some((t) => t.id === thread));
});

test('the agent tells the owner when a customer needs them, and reminders go out on time even at night', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  const { saveSettings } = await import('../src/core.js');
  const updatesThread = () => get("SELECT id FROM command_threads WHERE kind = 'updates'")?.id;
  // A handoff in a live chat produces an update.
  const { kvSet } = await import('../src/core.js');
  kvSet('updateKeys', {}); // an earlier test already reported Ali's handoff; the same news is sent once per 30 minutes
  reply = JSON.stringify({ messages: ['Main team se confirm karti hun.'], stage: 'negotiating', summary: 'refund', handoff: true, handoff_reason: 'Wants a refund' });
  run("UPDATE chats SET needs_human = 0, paused_until = NULL, ai_enabled = 1 WHERE jid = '111@s.whatsapp.net'");
  deliver([{ jid: '111@s.whatsapp.net', waId: `in-h-${now()}`, fromMe: false, text: 'refund chahiye', type: 'text', ts: now() }]);
  await until(() => updatesThread() && /needs you: Wants a refund/.test(all('SELECT text FROM commands WHERE thread_id = ?', updatesThread()).map((r) => r.text).join('\n')), 6000);

  run("UPDATE chats SET needs_human = 0, ai_enabled = NULL WHERE jid = '111@s.whatsapp.net'");

  // "Ali ko ... yaad dilao" goes through the model, which uses the remind action.
  saveSettings({ followup: { quietStart: 0, quietEnd: 24 } }); // quiet all day
  cmdReplies = [JSON.stringify({ action: 'remind', args: { customer: 'Ali', text: 'Aap ka order kal expire ho raha hai.', at: 'in 0 minutes' } }), JSON.stringify({ reply: 'Reminder laga diya.' })];
  const out = await runCommand('Ali ko yaad dilao ke order kal expire ho raha hai');
  assert.match(out.reply, /⏰ Reminder for Ali/);
  const n = sent.length;
  await followups._tick();
  assert.equal(sent.at(-1)?.text, 'Aap ka order kal expire ho raha hai.', 'sent despite quiet hours');
  assert.ok(sent.length > n);
  saveSettings({ followup: { quietStart: 0, quietEnd: 0 } });
});

test('AgentRouter-style "unauthorized client" is reported as the provider refusing this app, not a bad key', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'unauthorized client detected, contact support for assistance at https://discord.gg/xyz' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    run('UPDATE providers SET enabled = 0');
    const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'agentrouter', 'AgentRouter', 'openai', 'https://agentrouter.org/v1', encrypt('k'), 'm', -1, now()).lastInsertRowid);
    await assert.rejects(complete({ messages: [{ role: 'user', content: 'x' }] }), /only accepts requests from the apps it has approved/);
    assert.equal(listProviders().map(publicProvider).find((p) => p.id === id).status, 'client_blocked');
    run('DELETE FROM providers WHERE id = ?', id);
  } finally {
    globalThis.fetch = realFetch;
    run('UPDATE providers SET enabled = 1');
  }
});

test('daily summary', async () => {
  const { digest } = await import('../src/agent/updates.js');
  const d = digest();
  assert.match(d, /^Daily summary: \d+ new leads, \d+ messages in, \d+ agent replies, \d+ follow-ups sent\./);
});

test('a batch-only model is never offered for chat, and one already set is swapped for its chat version', async () => {
  const { describeModel, chooseModel } = await import('../src/llm/client.js');
  assert.equal(describeModel({ id: 'deepseek/deepseek-v4-flash-0731:batch' }).chat, false);
  assert.equal(chooseModel(['deepseek/deepseek-v4-flash-0731:batch', 'deepseek/deepseek-v4-flash-0731'], 'deepseek/deepseek-v4-flash-0731:batch'), 'deepseek/deepseek-v4-flash-0731');
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'openrouter', 'OpenRouter', 'openai', baseUrl, encrypt('batchonly'), 'deepseek/deepseek-v4-flash-0731:batch', -1, now()).lastInsertRowid);
  reply = '{"reply": "ok"}';
  const out = await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' });
  assert.equal(out.text, '{"reply": "ok"}');
  assert.equal(get('SELECT model FROM providers WHERE id = ?', id).model, 'deepseek/deepseek-v4-flash-0731');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('"jinhon ne khareeda unko reminder bhejo" targets buyers; "jinhon ne nahi khareeda" targets the others', async () => {
  const { quickIntent, audienceOf } = await import('../src/agent/intent.js');
  const q = quickIntent('read karo chats last 30 days ki then jinho na ya cheez buy ki ha then un ko reminder bhjo');
  assert.deepEqual([q.action, q.args.days, q.args.audience], ['start_followups', 30, 'buyers']);
  assert.equal(audienceOf('jinhon ne purchase nahi kiya unhein follow up bhejo'), 'non_buyers');
  assert.equal(audienceOf('jinho ne Canva khareeda unko renewal reminder bhejo'), 'buyers');
  assert.equal(audienceOf('sab ko offer bhejo'), 'all');
});

test('a reminder batch to buyers reaches people marked purchased, and skips those who never bought', async () => {
  const { runCommand } = await import('../src/agent/commander.js');
  await until(() => !followups.campaign.running, 20000);
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  run("UPDATE chats SET stage = 'purchased' WHERE jid = '444@s.whatsapp.net'");
  run("UPDATE chats SET stage = 'interested' WHERE jid = '555@s.whatsapp.net'");
  // The model decides from each conversation who bought.
  const realReply = reply;
  reply = JSON.stringify({ stage: 'purchased', summary: 'Bought', should_followup: true, message: 'Aap ka plan jald expire ho raha hai, renew karna ho to bata dein.', reason: 'bought' });
  const out = await runCommand('read karo chats last 30 days ki then jinho na ya cheez buy ki ha then un ko reminder bhjo');
  assert.equal(out.steps[0].args.audience, 'buyers');
  await until(() => !followups.campaign.running, 20000);
  const taskId = out.steps[0].result.task_id;
  const queued = all("SELECT f.kind, c.jid FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.task_id = ? AND f.status = 'approved'", taskId);
  assert.ok(queued.some((x) => x.jid === '444@s.whatsapp.net'), 'the buyer is included');
  assert.ok(queued.every((x) => x.kind === 'reminder'), 'sent as reminders, so the purchased stage does not block them');
  run('UPDATE followups SET due_at = ? WHERE task_id = ?', now() - 1, taskId);
  const n = sent.length;
  await followups._tick();
  assert.ok(sent.length > n, 'a reminder went out to a buyer');
  assert.equal(sent.at(-1).text, 'Aap ka plan jald expire ho raha hai, renew karna ho to bata dein.');
  run("UPDATE followups SET status = 'skipped' WHERE task_id = ? AND status = 'approved'", taskId);
  reply = realReply;
});

test('background work waits out repeated rate limits instead of failing', async () => {
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'openrouter', 'Busy free', 'openai', baseUrl, encrypt('busy'), 'some/model:free', -1, now()).lastInsertRowid);
  reply = '{"reply": "ok"}';
  const out = await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'learn' });
  assert.equal(out.text, '{"reply": "ok"}', 'succeeded on the third try');
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('OpenRouter free models get two other free models to fall back on in the same request', async () => {
  const { openRouterFallbacks } = await import('../src/llm/router.js');
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'openrouter', 'OR free', 'openai', baseUrl, encrypt('orfree'), 'deepseek/deepseek-chat:free', -1, now()).lastInsertRowid);
  const fb = await openRouterFallbacks(get('SELECT * FROM providers WHERE id = ?', id));
  assert.equal(fb.length, 2);
  assert.ok(!fb.includes('tiny/model-1b:free') && !fb.includes('paid/model'), 'only roomy free models');
  reply = '{"reply": "ok"}';
  await complete({ messages: [{ role: 'user', content: 'x' }] }, { purpose: 'command' });
  assert.deepEqual(calls.at(-1).body.models, ['deepseek/deepseek-chat:free', ...fb]);
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
});

test('a chat that fails in a batch (timeout, dropped connection) is tried again at the end', async () => {
  const { runCampaign, campaign } = followups;
  await until(() => !campaign.running, 20000);
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'openrouter', 'Flaky', 'openai', baseUrl, encrypt('flakybatch'), 'm', -1, now()).lastInsertRowid);
  reply = JSON.stringify({ stage: 'interested', summary: 's', should_followup: true, message: 'Hi again', reason: 'r' });
  await runCampaign({ sinceDays: 60, limit: 3, reanalyze: true, instruction: 'say hi', autoApprove: false });
  await until(() => !campaign.running, 30000);
  assert.equal(campaign.failed, 0, 'the failed chat succeeded on the second go');
  assert.equal(campaign.drafted, campaign.total);
  run('DELETE FROM providers WHERE id = ?', id);
  run('UPDATE providers SET enabled = 1');
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
});

test('ad lead goes quiet after the owner answered by hand: the agent follows up on its own', async () => {
  const { sweepQuiet, followupStatus } = followups;
  const { saveSettings, getSettings } = await import('../src/core.js');
  await until(() => !followups.campaign.running, 20000);
  run("UPDATE followups SET status = 'skipped' WHERE status IN ('pending','approved')");
  saveSettings({ followup: { approval: false, enabled: true, quietStart: 0, quietEnd: 0 } });
  assert.equal(getSettings().followup.approval, false);
  // A new lead from an ad writes, the owner answers from the phone, then silence.
  const linkedAt = get('SELECT connected_at FROM accounts WHERE id = 1').connected_at;
  run('UPDATE accounts SET connected_at = ? WHERE id = 1', now() - 48 * 3_600_000); // the number was linked before the ad lead wrote
  const jid = '777@s.whatsapp.net';
  run('UPDATE chats SET ai_enabled = 0 WHERE jid = ?', jid); // keep the live auto-reply out of this test
  deliver([{ jid, phone: '777', name: 'Ad lead', waId: 'ad-1', fromMe: false, text: 'Ad dekha, Canva Pro ka price?', type: 'text', ts: now() - 30 * 3_600_000 }]);
  const chat = get('SELECT * FROM chats WHERE jid = ?', jid);
  run('UPDATE chats SET ai_enabled = NULL WHERE id = ?', chat.id);
  deliver([{ jid, waId: 'own-ad-1', fromMe: true, text: 'Rs 1,200 ka hai, 1 saal ka.', type: 'text', ts: now() - 29 * 3_600_000 }]);
  run('UPDATE chats SET paused_until = NULL WHERE id = ?', chat.id); // the owner's hand-off pause has long passed
  assert.equal(get('SELECT next_followup_at FROM chats WHERE id = ?', chat.id).next_followup_at, null, 'nothing scheduled yet');
  assert.ok(sweepQuiet() >= 1, 'the sweep finds the quiet lead');
  const due = get('SELECT next_followup_at FROM chats WHERE id = ?', chat.id).next_followup_at;
  assert.ok(due && due <= now() + 1000, 'already 29h quiet, so the first nudge (24h) is due now');
  reply = JSON.stringify({ skip: false, message: 'Canva Pro ka offer abhi bhi hai, chahiye to bata dein.', stage: 'interested', summary: 'Asked Canva price', reason: 'quiet after price' });
  const n = sent.length;
  await followups._tick();
  assert.equal(sent.at(-1)?.jid, jid, 'sent without waiting for approval');
  assert.equal(sent.at(-1).text, 'Canva Pro ka offer abhi bhi hai, chahiye to bata dein.');
  assert.ok(sent.length > n);
  assert.equal(get('SELECT followup_count FROM chats WHERE id = ?', chat.id).followup_count, 1);
  assert.ok(get('SELECT next_followup_at FROM chats WHERE id = ?', chat.id).next_followup_at > now() + 70 * 3_600_000, 'the second nudge is set for 3 days later');
  const st = followupStatus();
  assert.equal(st.approval, false);
  assert.ok(st.sentToday >= 1);
  saveSettings({ followup: { approval: true } });
  run('UPDATE accounts SET connected_at = ? WHERE id = 1', linkedAt);
});

test('chat commands: stop, start, bought, follow-up, reminder, note, info', async () => {
  const { parseChatCommand, runChatCommand, parseWhen } = await import('../src/agent/chat-commands.js');
  assert.equal(parseChatCommand('/xyz hello'), null, 'unknown words are ordinary messages');
  assert.equal(parseChatCommand('price kya hai /stop'), null, 'only at the start');
  assert.deepEqual(parseChatCommand('#remind 2h Order ready'), { cmd: 'remind', rest: '2h Order ready' });
  const chat = get("SELECT * FROM chats WHERE jid = '555@s.whatsapp.net'");
  let answered = 0;
  const hooks = { answerNow: () => { answered++; } };
  assert.match(runChatCommand(chat.id, '/stop', hooks), /Agent stopped/);
  assert.equal(get('SELECT ai_enabled FROM chats WHERE id = ?', chat.id).ai_enabled, 0);
  assert.match(runChatCommand(chat.id, '/start', hooks), /Agent is on/);
  assert.equal(get('SELECT ai_enabled FROM chats WHERE id = ?', chat.id).ai_enabled, 1);
  assert.match(runChatCommand(chat.id, '/followup now', hooks), /written now/);
  assert.ok(get('SELECT next_followup_at FROM chats WHERE id = ?', chat.id).next_followup_at <= now() + 1000);
  assert.match(runChatCommand(chat.id, '/bought', hooks), /purchased/);
  assert.equal(get('SELECT stage, next_followup_at FROM chats WHERE id = ?', chat.id).next_followup_at, null);
  assert.match(runChatCommand(chat.id, '/remind 2h Aap ka order ready hai', hooks), /Reminder for/);
  const r = get("SELECT * FROM followups WHERE chat_id = ? AND kind = 'reminder' ORDER BY id DESC LIMIT 1", chat.id);
  assert.equal(r.text, 'Aap ka order ready hai');
  assert.ok(Math.abs(r.due_at - (now() + 2 * 3_600_000)) < 5000);
  assert.ok(parseWhen('kal 10 baje Payment yaad rakhna').at > now(), 'Roman Urdu times work');
  assert.match(runChatCommand(chat.id, '/note Sirf Urdu mein baat karein', hooks), /Note saved/);
  assert.match(get('SELECT notes FROM chats WHERE id = ?', chat.id).notes, /Sirf Urdu/);
  assert.match(runChatCommand(chat.id, '/info', hooks), /purchased[\s\S]*Notes: .*Sirf Urdu[\s\S]*Queued: reminder/);
  assert.match(runChatCommand(chat.id, '/help', hooks), /\/stop – /);
  run("UPDATE followups SET status = 'skipped' WHERE chat_id = ? AND status = 'approved'", chat.id);
  run("UPDATE chats SET ai_enabled = NULL, stage = 'interested' WHERE id = ?", chat.id);
});

test('a command typed in a customer chat on WhatsApp is run, hidden from the customer, and confirmed to the owner', async () => {
  const deleted = [];
  fake.deleteForEveryone = async (jid, key) => { deleted.push({ jid, key }); };
  const chat = get("SELECT * FROM chats WHERE jid = '555@s.whatsapp.net'");
  const before = get('SELECT COUNT(*) n FROM messages WHERE chat_id = ?', chat.id).n;
  const n = sent.length;
  deliver([{ jid: '555@s.whatsapp.net', waId: 'cmd-1', fromMe: true, text: '/stop', type: 'text', ts: now(), raw: { key: { id: 'cmd-1', fromMe: true, remoteJid: '555@s.whatsapp.net' } } }]);
  await until(() => deleted.length === 1, 3000);
  assert.equal(deleted[0].key.id, 'cmd-1', 'deleted for everyone');
  assert.equal(get('SELECT ai_enabled FROM chats WHERE id = ?', chat.id).ai_enabled, 0, 'the agent stopped for this customer');
  assert.equal(get('SELECT COUNT(*) n FROM messages WHERE chat_id = ?', chat.id).n, before, 'the command is not part of the conversation');
  assert.equal(get('SELECT paused_until FROM chats WHERE id = ?', chat.id).paused_until, chat.paused_until, 'not treated as the owner replying');
  assert.ok(sent.slice(n).every((s) => s.jid !== '555@s.whatsapp.net'), 'nothing was sent to the customer');
  const updates = get("SELECT id FROM command_threads WHERE kind = 'updates'").id;
  assert.match(get('SELECT text FROM commands WHERE thread_id = ? ORDER BY id DESC LIMIT 1', updates).text, /Agent stopped for/);
  // An ordinary owner message that merely starts with a slash-like word is still a normal message.
  deliver([{ jid: '555@s.whatsapp.net', waId: 'own-normal', fromMe: true, text: '/price list attached', type: 'text', ts: now() }]);
  assert.equal(get('SELECT COUNT(*) n FROM messages WHERE chat_id = ?', chat.id).n, before + 1);
  run('UPDATE chats SET ai_enabled = NULL, paused_until = NULL WHERE id = ?', chat.id);
});

test('"send the link" price mode: no prices reach the model or the customer, the product link does', async () => {
  const { decide, buildSystem } = await import('../src/agent/brain.js');
  const { getSettings, saveSettings } = await import('../src/core.js');
  saveSettings({ business: { prices: 'link', shopLink: 'https://shop.test/shop', catalog: '- ChatGPT Plus 1 Month — Rs 1,760 (≈ $5.97 USDT) — in stock — private account — https://shop.test/products/chatgpt-plus' } });
  const sys = buildSystem(getSettings(), { stage: 'interested' }, 'reply', 'chatgpt price');
  assert.doesNotMatch(sys, /1,760|5\.97|in stock/);
  assert.match(sys, /https:\/\/shop\.test\/products\/chatgpt-plus/);
  assert.match(sys, /Never write a price/);
  assert.match(sys, /https:\/\/shop\.test\/shop/);
  // The model still slips a price in: it is asked again, and a price in the second answer is removed.
  const chat = get("SELECT id FROM chats WHERE jid = '444@s.whatsapp.net'");
  const prompts = calls.length;
  reply = JSON.stringify({ messages: ['ChatGPT Plus Rs 1,760 ka hai', 'Link: https://shop.test/products/chatgpt-plus'], stage: 'interested', summary: 'price', handoff: false });
  const d = await decide(chat.id, 'reply');
  assert.equal(calls.length - prompts, 2, 'asked again once');
  assert.match(calls.at(-1).body.messages.at(-1).content, /contained a price/);
  assert.ok(d.messages.every((m) => !/1,760/.test(m)), d.messages.join(' | '));
  assert.ok(d.messages.some((m) => m.includes('https://shop.test/products/chatgpt-plus')));
  saveSettings({ business: { prices: 'quote', shopLink: '', catalog: '' } });
});

test('Chinese error messages are explained, and a model past its end of life is replaced like a missing one', async () => {
  const { chat } = await import('../src/llm/client.js');
  const ask = (key) => chat({ kind: 'openai', baseUrl, apiKey: key, model: 'm' }, { messages: [{ role: 'user', content: 'hi' }] });
  await assert.rejects(ask('cnappid'), (e) => e.kind === 'auth' && /无效的AppId \(invalid AppId: .*Copy the API key again/.test(e.message));
  await assert.rejects(ask('cnbusy'), (e) => e.kind === 'rate_limit' && /rate limit/.test(e.message));
  await assert.rejects(ask('cnbroke'), (e) => e.kind === 'quota');
  await assert.rejects(ask('gone'), (e) => e.kind === 'model_missing');
});

test('a base URL without /v1 that returns a web page is corrected and saved', async () => {
  const { callProvider } = await import('../src/llm/router.js');
  const root = baseUrl.replace(/\/v1$/, '');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)', 'custom', 'Custom', 'openai', root, encrypt('htmlbase'), 'fake-1', 50, 0, now()).lastInsertRowid);
  const out = await callProvider(get('SELECT * FROM providers WHERE id = ?', id), { messages: [{ role: 'user', content: 'hi' }] }, { purpose: 'test' });
  assert.ok(out.text);
  assert.equal(get('SELECT base_url FROM providers WHERE id = ?', id).base_url, `${root}/v1`);
  run('DELETE FROM providers WHERE id = ?', id);
});

test('settings and switches by command: follow-ups, auto replies, reading, random gaps', async () => {
  const { quickIntent } = await import('../src/agent/intent.js');
  const { runCommand } = await import('../src/agent/commander.js');
  const { getSettings, saveSettings } = await import('../src/core.js');
  assert.deepEqual(quickIntent('follow up band karo'), { action: 'change_settings', args: { followups: false } });
  assert.deepEqual(quickIntent('auto reply on karo').args, { autopilot: true });
  assert.deepEqual(quickIntent('chats parhna band karo').args, { reading: false });
  assert.deepEqual(quickIntent('follow up randomly 10,15,6,25 minutes ke gap se bhejna').args, { followup_gap_minutes: [6, 25] });
  assert.deepEqual(quickIntent('pichle 5 din ke logon ko follow up bhejo, 6 se 25 minute random').args.interval_minutes, [6, 25]);
  const before = calls.length;
  const r = await runCommand('follow up randomly 10,15,6,25 minutes ke gap se bhejna');
  assert.match(r.reply, /spaced randomly 6 to 25 minutes apart/);
  assert.equal(calls.length, before, 'no model call needed');
  assert.deepEqual([getSettings().followup.gapMinSec, getSettings().followup.gapMaxSec], [360, 1500]);
  assert.match((await runCommand('chats parhna band karo')).reply, /reading new chats off/);
  assert.equal(getSettings().reading.auto, false);
  assert.match((await runCommand('follow up band karo')).reply, /automatic follow-ups off/);
  assert.equal(getSettings().followup.enabled, false);
  await runCommand('follow up on karo');
  assert.equal(getSettings().followup.enabled, true);
  saveSettings({ followup: { gapMinSec: 0, gapMaxSec: 0 }, reading: { auto: true } });
});

test('a long command conversation is remembered: recent messages in full, everything the owner said before in short', async () => {
  const { threadMemory } = await import('../src/agent/commander.js');
  for (let i = 1; i <= 30; i++) run('INSERT INTO commands (role, text, thread_id, ts) VALUES (?,?,?,?)', i % 2 ? 'owner' : 'agent', i === 1 ? 'mera naam Awais hai, SellMeTools chalata hun' : `message ${i}`, 9999, now() + i);
  const mem = threadMemory(9999);
  assert.equal(mem[0].role, 'user');
  assert.match(mem[0].content, /Earlier in this conversation[\s\S]*mera naam Awais hai/);
  assert.match(mem.at(-1).content, /message 30/);
  assert.equal(mem.length, 18);
});

test('when every model hits its limit a batch pauses and carries on from the same chat; changed chats are read again by themselves', async () => {
  const { runCampaign, campaign, readChanged } = await import('../src/agent/followups.js');
  const on = all('SELECT id FROM providers WHERE enabled = 1').map((r) => r.id);
  run('UPDATE providers SET enabled = 0');
  const id = Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'custom', 'Resting', 'openai', baseUrl, encrypt('quotaonce'), 'fake-1', -5, now()).lastInsertRowid);
  try {
    reply = JSON.stringify({ stage: 'interested', summary: 'Asked about the website package', should_followup: false, message: '', reason: '' });
    runCampaign({ analyzeOnly: true, sinceDays: 3650, reanalyze: true, limit: 2 });
    await until(() => campaign.waitingUntil, 8000);
    assert.equal(campaign.done, 0, 'paused on the first chat, nothing skipped');
    run("UPDATE providers SET state = '{}' WHERE id = ?", id); // the limit is over
    await until(() => !campaign.running, 8000);
    assert.equal(campaign.failed, 0);
    assert.equal(campaign.done, 2);
    // Only chats with something new since they were read are read again.
    const fresh = get("SELECT id FROM chats WHERE analyzed_at IS NOT NULL ORDER BY analyzed_at DESC LIMIT 1");
    run('UPDATE chats SET analyzed_at = 0, last_msg_at = ? WHERE id = ?', now() - 10 * 60_000, fresh.id);
    const n = await readChanged();
    assert.ok(n >= 1);
    assert.ok(get('SELECT analyzed_at FROM chats WHERE id = ?', fresh.id).analyzed_at > 0);
  } finally {
    run('DELETE FROM providers WHERE id = ?', id);
    for (const p of on) run('UPDATE providers SET enabled = 1 WHERE id = ?', p);
  }
});
