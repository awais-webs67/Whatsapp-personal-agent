// "Learn from my chats": read conversations the owner handled by hand and distil how they
// answer, what they offer and at what price. The result is plain text the owner can review
// and edit; it is added to the agent's instructions. (No model is retrained.)
import { all, now } from '../db.js';
import { getSettings, saveSettings, emit, log, sleep } from '../core.js';
import { complete } from '../llm/router.js';
import { extractJson } from './brain.js';

export const learning = { running: false, total: 0, done: 0, chats: 0, error: null, finishedAt: null };

const CHUNK_CHARS = 12000;
const EXTRACT = `You are studying WhatsApp conversations between a business owner ("Me") and people who messaged them ("Them").
Extract only what the conversations actually show. Do not invent anything.
Return ONLY a JSON object:
{"offers": ["product or service - price - what is included / delivery time, as the owner stated it"],
 "faqs": [{"q": "a question people ask", "a": "how the owner answers it"}],
 "policies": ["payment, delivery, refund or other rules the owner stated"],
 "style": "2-3 sentences on how the owner writes: language and script, length, greetings, tone, emoji use",
 "examples": ["a real reply the owner sent, copied word for word, that shows their voice"]}
Leave an array empty when the conversations show nothing for it. Skip personal chit-chat unrelated to the business.`;

const MERGE = `Below are notes extracted from several batches of a business owner's WhatsApp conversations.
Merge them into one clean set: remove duplicates, and when prices or rules conflict keep the most frequent one.
Keep at most 40 offers, 30 faqs, 15 policies and 15 examples (prefer short, typical ones).
Return ONLY a JSON object with the same keys: offers, faqs, policies, style, examples.`;

function transcripts(accountId, maxChats) {
  // Chats the owner personally replied in are the ones worth learning from.
  const chats = all(`SELECT c.id FROM chats c
      WHERE (?1 IS NULL OR c.account_id = ?1)
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.by = 'owner') >= 2
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0) >= 1
      ORDER BY c.last_msg_at DESC LIMIT ?2`, accountId, maxChats);
  return chats.map(({ id }) => {
    const rows = all('SELECT from_me, text FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 40) ORDER BY ts, id', id);
    return rows.map((r) => `${r.from_me ? 'Me' : 'Them'}: ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n').slice(0, 2500);
  });
}

function chunk(list) {
  const out = [];
  let cur = '';
  for (const t of list) {
    if (cur && cur.length + t.length > CHUNK_CHARS) { out.push(cur); cur = ''; }
    cur += `${cur ? '\n\n---\n\n' : ''}${t}`;
  }
  if (cur) out.push(cur);
  return out;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const uniq = (list) => [...new Map(list.map((x) => [JSON.stringify(x).toLowerCase(), x])).values()];
function normalise(o) {
  return {
    offers: arr(o?.offers).map(String).filter(Boolean),
    faqs: arr(o?.faqs).filter((f) => f?.q && f?.a).map((f) => ({ q: String(f.q), a: String(f.a) })),
    policies: arr(o?.policies).map(String).filter(Boolean),
    style: String(o?.style || '').trim(),
    examples: arr(o?.examples).map(String).filter(Boolean),
  };
}

export function formatLearned(n) {
  const part = (title, lines) => (lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '');
  return [
    n.style && `How the owner writes: ${n.style}`,
    part('What the owner offers and quotes', n.offers),
    part('How the owner answers common questions', n.faqs.map((f) => `Q: ${f.q} / A: ${f.a}`)),
    part('Rules the owner states', n.policies),
    part('Real replies from the owner (match this voice)', n.examples),
  ].filter(Boolean).join('\n\n');
}

async function ask(system, content) {
  const out = await complete({ system, messages: [{ role: 'user', content }], maxTokens: 3000 }, { purpose: 'learn' });
  const json = extractJson(out.text);
  if (!json) throw new Error('Model did not return valid JSON');
  return normalise(json);
}

export async function learnFromChats({ accountId = null, maxChats = 150 } = {}) {
  if (learning.running) throw new Error('Already learning');
  const list = transcripts(accountId, maxChats);
  if (!list.length) throw new Error('No conversations with your own replies are stored yet. Link a number and let the history sync first.');
  const chunks = chunk(list);
  Object.assign(learning, { running: true, total: chunks.length + (chunks.length > 1 ? 1 : 0), done: 0, chats: list.length, error: null, finishedAt: null });
  emit('learning', learning);
  (async () => {
    try {
      const acc = { offers: [], faqs: [], policies: [], style: [], examples: [] };
      for (const c of chunks) {
        const n = await ask(EXTRACT, c);
        for (const k of ['offers', 'faqs', 'policies', 'examples']) acc[k].push(...n[k]);
        if (n.style) acc.style.push(n.style);
        learning.done++;
        emit('learning', learning);
        await sleep(300);
      }
      let final = { offers: uniq(acc.offers), faqs: uniq(acc.faqs), policies: uniq(acc.policies), style: acc.style.join(' '), examples: uniq(acc.examples).slice(0, 15) };
      if (chunks.length > 1) {
        final = await ask(MERGE, JSON.stringify(final));
        learning.done++;
      }
      const text = formatLearned(final);
      if (!text) throw new Error('The conversations did not contain anything business-related to learn from');
      saveSettings({ business: { learned: text, learnedAt: now() } });
      log('info', 'learn', `Learned from ${list.length} conversations`);
    } catch (e) {
      learning.error = e.message;
      log('error', 'learn', `Learning failed: ${e.message}`);
    } finally {
      learning.running = false;
      learning.finishedAt = now();
      emit('learning', learning);
    }
  })();
  return learning;
}

export const hasLearned = () => !!getSettings().business.learned;
