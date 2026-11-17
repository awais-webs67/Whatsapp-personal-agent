// Accounts: the hub runs a separate workspace per account, keeps their data apart and lends the admin's models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hub-'));
const port = 20000 + Math.floor(Math.random() * 20000);
Object.assign(process.env, { DATA_DIR: tmp, KNOWLEDGE_DIR: path.join(tmp, 'kn'), NODE_ENV: 'test', PORT: String(port), WORKSPACE_PORT_BASE: String(port + 1) });
fs.mkdirSync(path.join(tmp, 'kn'));
const hub = await import('../src/hub.js');

// The admin's own model: a fake OpenAI-compatible server.
const llmCalls = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
    llmCalls.push(JSON.parse(body));
    res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});

let server;
const base = `http://127.0.0.1:${port}`;
/** A tiny browser: keeps its own cookies. */
function browser() {
  const jar = {};
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const admin = browser();
const ali = browser();
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

before(async () => {
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  server = hub.start(port);
  await new Promise((r) => server.once('listening', r));
});
after(async () => { await hub.stopAll(); server.close(); llm.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let aliId;
test('first visit creates the admin; the admin dashboard is the main workspace', async () => {
  assert.deepEqual((await admin('GET', '/api/auth')).body, { multi: true, setup: true, authed: false });
  assert.equal((await admin('GET', '/api/overview')).status, 401);
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'admin', password: 'short' })).status, 400);
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'admin', password: 'owner-pass-1' })).status, 200);
  assert.equal((await admin('POST', '/api/auth/setup', { username: 'x', password: 'owner-pass-1' })).status, 409);
  const o = await until(async () => { const r = await admin('GET', '/api/overview'); return r.status === 200 && r.body; });
  assert.ok(Array.isArray(o.accounts));
  const me = (await admin('GET', '/api/hub/me')).body;
  assert.equal(me.role, 'admin');
  // The admin's own model, added through the hub like any dashboard request.
  const p = await admin('POST', '/api/providers', { preset: 'custom', name: 'Fake', baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'k', model: 'fake-1' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await admin('PUT', '/api/settings', { business: { name: 'SellMeTools' } })).status, 200);
});

test('a client account gets its own workspace: own settings, no access to accounts, the admin\'s models lent with a limit', async () => {
  const created = await admin('POST', '/api/hub/users', { name: 'Ali Traders', username: 'ali', password: 'ali-pass-12', sharedAi: true, aiDaily: 2 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  aliId = created.body.id;
  assert.equal((await admin('POST', '/api/hub/users', { username: 'ali', password: 'another-pass' })).status, 400, 'username taken');

  assert.equal((await ali('POST', '/api/auth/login', { username: 'ali', password: 'wrong-pass' })).status, 401);
  assert.equal((await ali('POST', '/api/auth/login', { username: 'ali', password: 'ali-pass-12' })).status, 200);
  const providers = await until(async () => { const r = await ali('GET', '/api/providers'); return r.status === 200 && r.body; });
  assert.deepEqual(providers.map((p) => p.model).sort(), ['shared-fast', 'shared-smart'], 'only the lent models, not the admin\'s key');
  assert.equal((await ali('GET', '/api/settings')).body.business.name, '', 'own knowledge, not SellMeTools');
  assert.equal((await ali('GET', '/api/hub/users')).status, 403);
  assert.equal((await ali('POST', '/api/hub/view', { id: aliId })).status, 403);

  // The lent model answers through the admin's chain and counts against the daily limit.
  const fast = providers.find((p) => p.model === 'shared-fast');
  const before = llmCalls.length;
  for (let i = 0; i < 2; i++) {
    const r = await ali('POST', `/api/providers/${fast.id}/test`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.text, 'OK');
  }
  assert.equal(llmCalls.length - before, 2);
  const third = await ali('POST', `/api/providers/${fast.id}/test`);
  assert.notEqual(third.status, 200);
  assert.match(third.body.error, /daily limit/i);
  assert.equal(llmCalls.length - before, 2, 'over the limit nothing reaches the admin\'s model');
  const listed = (await admin('GET', '/api/hub/users')).body.find((u) => u.id === aliId);
  assert.equal(listed.aiUsedToday, 2);
  assert.equal(listed.status, 'running');
  // From outside (through the HTTPS proxy) the shared endpoint refuses even a valid-looking request.
  const out = await fetch(`${base}/ai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', authorization: 'Bearer hub-x' }, body: '{}' });
  assert.equal(out.status, 401);
  // The admin's own list never shows the shared entries.
  assert.deepEqual((await admin('GET', '/api/providers')).body.map((p) => p.name), ['Fake']);
});

test('the admin can open a client\'s dashboard and come back; taking the models back removes them', async () => {
  assert.equal((await admin('POST', '/api/hub/view', { id: aliId })).status, 200);
  assert.equal((await admin('GET', '/api/hub/me')).body.viewing.name, 'Ali Traders');
  assert.deepEqual((await admin('GET', '/api/providers')).body.map((p) => p.model).sort(), ['shared-fast', 'shared-smart']);
  await admin('POST', '/api/hub/view', { id: 0 });
  assert.equal((await admin('GET', '/api/settings')).body.business.name, 'SellMeTools');

  assert.equal((await admin('PATCH', `/api/hub/users/${aliId}`, { sharedAi: false })).status, 200);
  const providers = await until(async () => { const r = await ali('GET', '/api/providers'); return r.status === 200 && r.body; });
  assert.deepEqual(providers, []);
  // Cloud API webhooks reach the right workspace.
  assert.equal((await fetch(`${base}/w/u${aliId}/webhook/cloud/9?hub.mode=subscribe`)).status, 403);
});

test('switching an account off signs it out and stops its agent; a new password signs out old sessions', async () => {
  assert.equal((await admin('PATCH', `/api/hub/users/${aliId}`, { disabled: true })).status, 200);
  assert.equal((await ali('GET', '/api/overview')).status, 401);
  assert.equal((await ali('POST', '/api/auth/login', { username: 'ali', password: 'ali-pass-12' })).status, 403);
  assert.equal((await admin('PATCH', `/api/hub/users/${aliId}`, { disabled: false, password: 'new-pass-123' })).status, 200);
  assert.equal((await ali('POST', '/api/auth/login', { username: 'ali', password: 'new-pass-123' })).status, 200);
  await until(async () => (await ali('GET', '/api/overview')).status === 200);
  assert.equal((await ali('POST', '/api/settings/password', { current: 'new-pass-123', next: 'ali-own-pass' })).status, 200);
  assert.equal((await admin('PATCH', `/api/hub/users/${(await admin('GET', '/api/hub/me')).body.id}`, { disabled: true })).status, 400, 'cannot lock yourself out');

  assert.equal((await admin('DELETE', `/api/hub/users/${aliId}`)).status, 200);
  assert.equal((await ali('GET', '/api/overview')).status, 401);
  assert.ok(fs.readdirSync(path.join(tmp, 'deleted')).some((d) => d.startsWith('ali-')), 'data kept in data/deleted');
});
