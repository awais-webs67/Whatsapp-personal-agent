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
    if (key === 'badkey') return send(401, { error: { message: 'Incorrect API key provided' } });
    send(200, { model: 'fake-1', choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 20 } },
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
  await assert.rejects(complete({ messages: [{ role: 'user', content: 'hi' }] }), /Every model in the chain is unavailable/);
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
