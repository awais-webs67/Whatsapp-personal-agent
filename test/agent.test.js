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
let flakyCount = 0; // scripted answers for the owner-command prompt
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
    if (key === 'flaky' && (flakyCount = (flakyCount || 0) + 1) === 1) return send(200, { model: 'small', choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    if (key === 'toolcalls') return send(200, { model: 'small', choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: { name: 'stats', arguments: '{"days":3}' } }] }, finish_reason: 'stop' }] });
    if (key === 'think') return send(200, { model: 'qwen', choices: [{ message: { content: '<think>the user wants stats</think>\n{"reply": "Sab theek hai."}' }, finish_reason: 'stop' }] });
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
  assert.equal(out.reply, 'Started: messages go out every 5 minutes.');
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
  assert.equal(out.reply, 'Yaad rakh liya.');
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
