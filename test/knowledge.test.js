// Knowledge files, long-document trimming, owner shortcuts and sharing batch work across models.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kn-'));
Object.assign(process.env, { DATA_DIR: tmp, KNOWLEDGE_DIR: path.join(tmp, 'shipped'), NODE_ENV: 'test', HUB_TOKEN: 'test-hub-token' });
const { run, now } = await import('../src/db.js');
const { getSettings, encrypt } = await import('../src/core.js');
const kf = await import('../src/agent/knowledge-files.js');
const { trimProse } = await import('../src/agent/knowledge.js');
const { shortcut } = await import('../src/agent/shortcuts.js');
const { ordered, chainFor } = await import('../src/llm/router.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A minimal .docx: a zip holding word/document.xml (compressed, like Word does). */
function docx(paragraphs) {
  const xml = Buffer.from(`<?xml version="1.0"?><w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const data = zlib.deflateRawSync(xml);
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

test('uploaded .docx, .md and .txt files become knowledge, and removing one makes the agent forget it', () => {
  assert.equal(kf.docxText(docx(['Delivery & returns', 'We deliver in 2 days.'])), 'Delivery & returns\n\nWe deliver in 2 days.');
  const r = kf.saveUpload('Shop Policies.docx', docx(['Refunds within 7 days.', 'Cash on delivery in Lahore.']));
  assert.equal(r.file, 'Shop-Policies.txt');
  kf.saveUpload('faq.md', Buffer.from('# FAQ\nQ: Warranty?\nA: 30 days.'));
  // A file shipped with the app (the knowledge folder in git) is used too, but cannot be deleted from the dashboard.
  fs.mkdirSync(path.join(tmp, 'shipped'));
  fs.writeFileSync(path.join(tmp, 'shipped', 'shop.md'), 'Shipped with the app.');
  kf.importKnowledgeFiles();
  assert.throws(() => kf.removeFile('shop.md'), /comes with the app/);
  assert.ok(fs.existsSync(path.join(tmp, 'knowledge', 'faq.md')), 'uploads are kept in the data folder');
  assert.match(getSettings().business.learnedWeb, /Source: Shop-Policies\.txt \(saved file\)\nRefunds within 7 days\./);
  assert.match(getSettings().business.learnedWeb, /A: 30 days\./);
  assert.deepEqual(kf.listFiles().map((f) => [f.file, f.builtIn]), [['Shop-Policies.txt', false], ['faq.md', false], ['shop.md', true]]);
  assert.throws(() => kf.saveUpload('old.doc', Buffer.from('x')), /Save as/);
  assert.throws(() => kf.saveUpload('pic.png', Buffer.from('x')), /\.md, \.txt or \.docx/);
  kf.removeFile('Shop-Policies.txt');
  assert.doesNotMatch(getSettings().business.learnedWeb, /Refunds within 7 days/);
  assert.match(getSettings().business.learnedWeb, /A: 30 days\./);
  assert.deepEqual(kf.listFiles().map((f) => f.file), ['faq.md', 'shop.md']);
});

test('a long document sends only the paragraphs that match the question; lists stay whole', () => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about company history and our team in detail, nothing about shipping at all here.`);
  const text = ['Source: notes.txt (saved file)', ...filler.slice(0, 20), 'Shipping to Karachi takes 3 days and costs nothing over 5000.', ...filler.slice(20), '- Item A — one\n- Item B — two'].join('\n\n');
  const out = trimProse(text, 'karachi shipping kitne din', 1500);
  assert.ok(out.length < 1800, `short: ${out.length}`);
  assert.match(out, /Shipping to Karachi takes 3 days/);
  assert.match(out, /^Source: notes\.txt/);
  assert.match(out, /- Item B — two/);
  assert.match(out, /more paragraphs of saved notes are not shown/);
  assert.equal(trimProse('short text', 'x', 1500), 'short text');
});

test('owner shortcuts: taught once, then the short word runs the full instruction', () => {
  assert.match(shortcut('jab main "report" kahun to pichle 1 din ki stats aur pending follow-ups batao').reply, /Yaad kar liya/);
  assert.match(shortcut('When I say leads, show interested chats from the last 3 days').reply, /Yaad kar liya/);
  assert.deepEqual(shortcut('Report'), { text: 'pichle 1 din ki stats aur pending follow-ups batao' });
  assert.deepEqual(shortcut('leads!'), { text: 'show interested chats from the last 3 days' });
  assert.match(shortcut('shortcuts').reply, /"report" → pichle 1 din/);
  assert.equal(shortcut('pichle 5 din ke logon ko follow up bhejo'), null, 'ordinary orders are untouched');
  assert.match(shortcut('report wala shortcut hatao').reply, /hata diya/);
  assert.equal(shortcut('report'), null);
});

test('batch work takes turns over every ready model; customer replies keep the chosen order', () => {
  const add = (name) => Number(run('INSERT INTO providers (preset, name, kind, base_url, api_key, model, priority, created_at) VALUES (?,?,?,?,?,?,?,?)', 'groq', name, 'openai', 'http://127.0.0.1:9/v1', encrypt('k'), 'm', 0, now()).lastInsertRowid);
  const ids = ['Groq 1', 'Groq 2', 'Gemini'].map(add);
  const firsts = Array.from({ length: 6 }, () => ordered('analyze')[0].id);
  assert.deepEqual(new Set(firsts), new Set(ids), 'every model gets a turn');
  assert.equal(ordered('analyze').length, 3, 'the others stay as fallbacks');
  assert.deepEqual(Array.from({ length: 3 }, () => ordered('reply')[0].id), [ids[0], ids[0], ids[0]]);
  assert.equal(chainFor('reply').length, 3);
});

test('tags: set on a chat, used to pick who gets a batch, and exported with the customers to a spreadsheet', async () => {
  const { tagsIn, normTags } = await import('../src/agent/tags.js');
  const { quickIntent } = await import('../src/agent/intent.js');
  const { app } = await import('../src/server.js');
  assert.deepEqual(tagsIn('vip tag walon ko follow up bhejo'), ['vip']);
  assert.deepEqual(tagsIn('tag canva aur ads walon ko reminder bhejo'), ['canva', 'ads']);
  assert.deepEqual(normTags('#VIP, ads  vip'), ['vip', 'ads']);
  assert.deepEqual(quickIntent('vip tag walon ko abhi follow up bhejo').args.tags, ['vip']);

  run('INSERT INTO accounts (id, name, type, created_at) VALUES (1, ?, ?, ?)', 'Line', 'qr', now());
  const add = (jid, name, tags) => Number(run('INSERT INTO chats (account_id, jid, phone, name, stage, tags, summary, last_msg_at, last_in_at, created_at) VALUES (1,?,?,?,?,?,?,?,?,?)', jid, jid.split('@')[0], name, 'interested', tags, 'Asked about "Canva", price', now(), now(), now()).lastInsertRowid);
  const ali = add('923001@s.whatsapp.net', 'Ali', ',vip,');
  add('923002@s.whatsapp.net', 'Sara', null);
  add('120363@g.us', 'Some group', ',vip,');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const h = { 'x-hub-token': 'test-hub-token', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${url}/api/chats/${ali}`, { method: 'PATCH', headers: h, body: JSON.stringify({ tags: 'VIP, eid-ads' }) })).status, 200);
    const chats = await (await fetch(`${url}/api/chats?tag=eid-ads`, { headers: h })).json();
    assert.deepEqual(chats.map((c) => [c.name, c.tagList]), [['Ali', ['vip', 'eid-ads']]]);
    const bytes = Buffer.from(await (await fetch(`${url}/api/chats/export.csv`, { headers: h })).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM so Excel shows Urdu');
    const all = bytes.toString('utf8').slice(1);
    assert.match(all, /^"Name","Phone"/);
    assert.match(all, /"Ali","\+923001","interested","vip eid-ads"/);
    assert.match(all, /"Sara"/);
    assert.match(all, /"Asked about ""Canva"", price"/);
    assert.doesNotMatch(all, /Some group/, 'groups are not customers');
    const vip = await (await fetch(`${url}/api/chats/export.csv?tag=vip`, { headers: h })).text();
    assert.match(vip, /"Ali"/);
    assert.doesNotMatch(vip, /"Sara"/);
    assert.equal((await fetch(`${url}/api/chats/export.csv`)).status, 401, 'needs sign-in');
  } finally { server.close(); }
});

test('follow-ups follow the owner\'s own example message and links', async () => {
  const { buildSystem } = await import('../src/agent/brain.js');
  const { saveSettings } = await import('../src/core.js');
  saveSettings({ business: { followupStyle: 'Assalam o alaikum Sir, aap ne hum se ___ ke liye rabta kiya tha.', links: 'https://shop.test\nhttps://whatsapp.com/channel/x' } });
  const s = getSettings();
  const fu = buildSystem(s, { stage: 'interested', name: 'Ayesha' }, 'followup');
  assert.match(fu, /Assalam o alaikum Sir, aap ne hum se ___ ke liye rabta kiya tha/);
  assert.match(fu, /https:\/\/shop\.test \| https:\/\/whatsapp\.com\/channel\/x/);
  assert.match(fu, /Never mention a product they did not ask about/);
  assert.doesNotMatch(buildSystem(s, { stage: 'interested' }, 'reply'), /How the owner writes follow-ups/, 'live replies are not affected');
});
