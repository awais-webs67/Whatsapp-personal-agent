// "Learn from my chats": read conversations the owner handled by hand and distil how they
// answer, what they offer and at what price. The result is plain text the owner can review
// and edit; it is added to the agent's instructions. (No model is retrained.)
import { all, now } from '../db.js';
import { getSettings, saveSettings, emit, log, sleep } from '../core.js';
import { complete } from '../llm/router.js';
import { extractJson } from './brain.js';
import { readSite, formatProducts } from './website.js';

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

// ---------- learning from a website ----------
const WEB = `Below is text from a business's website (product listings were already extracted separately; ignore them).
Extract only what the pages actually say. Do not invent anything.
Return ONLY a JSON object:
{"about": "2-3 sentences: what the business does and for whom",
 "faqs": [{"q": "question", "a": "answer"}],
 "policies": ["payment methods, delivery, refund, warranty, contact or ordering rules stated on the site"]}
Leave an array empty when the pages say nothing for it.`;

export { htmlToText } from './website.js';
export const webProgress = { running: false, done: 0, total: 0, site: '' };

/** Replace this source's block in "learned from website/profile", keep the others. */
function saveSourceBlock(key, block) {
  const prev = getSettings().business.learnedWeb || '';
  const kept = prev.split(/\n\n(?=Source: )/).filter((b) => b.trim() && !b.startsWith(`Source: ${key}`));
  saveSettings({ business: { learnedWeb: [...kept, block].join('\n\n') } });
}

export async function learnFromWebsite(raw) {
  if (webProgress.running) throw new Error(`Already reading ${webProgress.site}`);
  Object.assign(webProgress, { running: true, done: 0, total: 0, site: String(raw) });
  emit('weblearn', webProgress);
  try {
    const site = await readSite(raw, { onProgress: (done, total) => { Object.assign(webProgress, { done, total }); if (done % 5 === 0 || done === total) emit('weblearn', webProgress); } });
    const host = new URL(site.start).hostname.replace(/^www\./, '');
    const prose = site.pages.map((p) => `### ${p.url}\n${p.text.slice(0, 5000)}`).join('\n\n').slice(0, 24000);
    let summary = { about: '', faqs: site.faqs, policies: [] };
    let warning = null;
    if (prose.replace(/###.*\n/g, '').trim().length > 200) {
      try {
        const out = await complete({ system: WEB, messages: [{ role: 'user', content: prose }], maxTokens: 2500 }, { purpose: 'learn' });
        const j = extractJson(out.text) || {};
        const n = normalise(j);
        summary = { about: String(j.about || '').trim(), faqs: [...site.faqs, ...n.faqs].slice(0, 40), policies: n.policies };
      } catch (e) {
        warning = `Products were saved, but the summary of the other pages failed: ${e.message}`;
      }
    }
    if (!site.products.length && !summary.about && !summary.policies.length) {
      throw new Error(`Read ${host}, but found no products or business details. If the shop builds its product list with JavaScript, paste the list into Knowledge instead.`);
    }
    const part = (title, lines) => (lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '');
    const block = [
      `Source: ${host} (read ${new Date().toISOString().slice(0, 10)})`,
      summary.about,
      site.products.length ? `Products and prices (${site.products.length}):\n${formatProducts(site.products)}` : '',
      part('Rules', summary.policies),
      part('Questions and answers', summary.faqs.map((f) => `Q: ${f.q} / A: ${f.a}`)),
    ].filter(Boolean).join('\n');
    saveSourceBlock(host, block);
    log('info', 'learn', `Read ${host}: ${site.products.length} products, ${site.pages.length} other pages${warning ? ` (${warning})` : ''}`);
    return { site: host, products: site.products.length, pages: site.pages.length, warning, text: block };
  } catch (e) {
    log('error', 'learn', `Website: ${e.message}`);
    throw e;
  } finally {
    webProgress.running = false;
    emit('weblearn', webProgress);
  }
}

/** WhatsApp Business profile + catalogue of the linked numbers. */
export async function learnFromProfile(profileText) {
  if (!profileText) throw new Error('No business profile found. This needs a connected WhatsApp Business number with a profile or catalogue filled in.');
  const block = `Source: WhatsApp business profile\n${profileText}`;
  saveSourceBlock('WhatsApp business profile', block);
  log('info', 'learn', 'Learned from the WhatsApp business profile');
  return { text: block };
}
