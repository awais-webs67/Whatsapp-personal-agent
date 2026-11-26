// Voice notes and pictures. Voice notes: the audio is turned into text by any saved model that can (see transcribe),
// so the agent answers what the customer said instead of "[voice note]". Pictures (payment proofs, screenshots,
// product photos) are described by a vision model. Each can be switched off in Settings to save tokens.
// The reply waits for them briefly.
import { all, get, run } from '../db.js';
import { getSettings, log, emit } from '../core.js';
import { hydrate } from '../llm/router.js';
import { mediaFor } from './campaigns.js';

const chatOf = (chatId) => get('SELECT * FROM chats WHERE id = ?', chatId);

const pending = new Map(); // chatId -> Promise (transcriptions still running)
// Voice notes work with whatever models you have saved. The agent tries each one that might understand audio,
// remembers the first that works, and goes back to searching only if that one stops working.
//   1. a speech-to-text endpoint (/audio/transcriptions): Groq, OpenAI, Together, Mistral, most OpenAI-compatible hosts
//   2. a chat model that listens (audio in the message): Gemini, and Gemini or GPT-4o through OpenRouter
const STT = { groq: ['whisper-large-v3-turbo', 'whisper-large-v3'], openai: ['gpt-4o-mini-transcribe', 'whisper-1'], together: ['openai/whisper-large-v3'], mistral: ['voxtral-mini-latest'], github: [], anthropic: [] };
const LISTEN = { gemini: ['gemini-2.5-flash', 'gemini-2.0-flash'], openrouter: ['google/gemini-2.5-flash', 'openai/gpt-4o-audio-preview'] };
const failedAt = new Map(); // `${providerId}:${how}:${model}` -> when it last failed (skipped for 6 hours)
const FAIL_MS = 6 * 3_600_000;

function candidates() {
  const rows = all('SELECT * FROM providers WHERE enabled = 1 ORDER BY priority, id').map(hydrate).filter((p) => p.kind !== 'anthropic' && p.baseUrl);
  const out = [];
  for (const p of rows) {
    for (const m of STT[p.preset] ?? (p.preset in LISTEN ? [] : ['whisper-1', 'whisper-large-v3'])) out.push({ p, how: 'stt', model: m });
    for (const m of LISTEN[p.preset] || []) out.push({ p, how: 'listen', model: m });
  }
  // The one that worked last time goes first.
  const best = getSettingsKv();
  if (best) out.sort((a, b) => (key(b) === best) - (key(a) === best));
  return out.filter((c) => key(c) === best || Date.now() - (failedAt.get(key(c)) || 0) > FAIL_MS);
}
const key = (c) => `${c.p.id}:${c.how}:${c.model}`;
const getSettingsKv = () => get("SELECT value FROM settings WHERE key = 'voiceRoute'")?.value?.replace(/^"|"$/g, '') || null;
const setBest = (k) => run("INSERT INTO settings (key, value) VALUES ('voiceRoute', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(k));

async function viaStt(c, buffer, mime) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), mime.includes('mp4') ? 'voice.m4a' : mime.includes('mpeg') ? 'voice.mp3' : 'voice.ogg');
  form.append('model', c.model);
  form.append('response_format', 'json');
  const base = String(c.p.baseUrl).replace(/\/+$/, '');
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${c.p.apiKey}` }, body: form, signal: AbortSignal.timeout(45_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `transcription failed (${res.status})`);
  return String(json.text || '').trim();
}

async function viaListen(c, buffer, mime) {
  const base = String(c.p.baseUrl).replace(/\/+$/, '');
  const format = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'mp4' : 'ogg';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.p.apiKey}` }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: c.model, max_tokens: 600, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Write down exactly what is said in this WhatsApp voice note, in the language and script it is spoken in (Roman Urdu if it is Urdu or Hindi). Only the words, nothing else.' },
      { type: 'input_audio', input_audio: { data: Buffer.from(buffer).toString('base64'), format } }] }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `listening failed (${res.status})`);
  return String(json.choices?.[0]?.message?.content || '').trim();
}

/** Turn a voice note into text with the first saved model that can. */
export async function transcribe(buffer, mime = 'audio/ogg') {
  const list = candidates();
  if (!list.length) throw new Error('No saved model can turn voice notes into text yet. Add any model on the AI models page (Groq and Gemini have free keys).');
  let last;
  for (const c of list) {
    try {
      const text = c.how === 'stt' ? await viaStt(c, buffer, mime) : await viaListen(c, buffer, mime);
      if (key(c) !== getSettingsKv()) { setBest(key(c)); log('info', 'voice', `Voice notes now use ${c.p.name} (${c.model})`); }
      return text;
    } catch (e) { failedAt.set(key(c), Date.now()); last = e; }
  }
  throw new Error(`no saved model could turn the voice note into text (${last?.message || 'unknown error'})`);
}

/** Run a job for a chat; the chat's next reply waits for it. */
function track(chatId, job) {
  const all_ = Promise.all([pending.get(chatId), job].filter(Boolean)).then(() => {});
  pending.set(chatId, all_);
  all_.finally(() => { if (pending.get(chatId) === all_) pending.delete(chatId); });
}

// ---------- pictures ----------
// Vision-capable models per provider. Gemini first: its free tier covers a lot of pictures.
const VISION = { gemini: 'gemini-2.5-flash', groq: 'meta-llama/llama-4-scout-17b-16e-instruct', openai: 'gpt-4o-mini', openrouter: 'google/gemini-2.5-flash' };
const ORDER = Object.keys(VISION);
function viewer() {
  const rows = all(`SELECT * FROM providers WHERE enabled = 1 AND preset IN (${ORDER.map(() => '?').join(',')})`, ...ORDER)
    .sort((a, b) => ORDER.indexOf(a.preset) - ORDER.indexOf(b.preset) || a.priority - b.priority);
  return rows[0] ? hydrate(rows[0]) : null;
}
const LOOK = 'A customer sent this picture on WhatsApp to a business. In at most 3 short sentences, in English, say what it shows so a sales agent can answer. A payment receipt or bank screenshot: give the amount, app or bank, date, sender and transaction ID. A screenshot: copy the important text. A product or problem photo: say what it is. Facts only.';

export async function describeImage(buffer, mime = 'image/jpeg') {
  const p = viewer();
  if (!p) throw new Error('No Gemini, Groq, OpenAI or OpenRouter key saved: pictures cannot be read');
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({ model: VISION[p.preset], max_tokens: 220, messages: [{ role: 'user', content: [{ type: 'text', text: LOOK }, { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(buffer).toString('base64')}` } }] }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Picture reading failed (${res.status})`);
  return String(json.choices?.[0]?.message?.content || '').trim();
}

/** Describe one stored picture so the agent knows what it shows; the chat's next reply waits for it. */
export function queueImage(chatId, waId, fetchImage, mime) {
  if (!fetchImage || !mediaFor(chatOf(chatId)).images) return;
  track(chatId, (async () => {
    try {
      const img = await fetchImage();
      if (!img?.length) return;
      if (img.length > 8 * 1024 * 1024) throw new Error('picture too large');
      const text = await describeImage(img, mime);
      if (!text) return;
      run("UPDATE messages SET text = text || ? WHERE chat_id = ? AND wa_id = ?", ` (picture shows: ${text})`.slice(0, 1500), chatId, waId);
      emit('chat', { chatId });
    } catch (e) {
      log('warn', 'images', `Could not read a picture: ${e.message}`);
    }
  })());
}

/** Start turning one stored voice note into text; the chat's next reply waits for it (up to 25 s). */
export function queueVoice(chatId, waId, fetchAudio, mime) {
  if (!fetchAudio || !mediaFor(chatOf(chatId)).voice) return;
  const job = (async () => {
    try {
      const audio = await fetchAudio();
      if (!audio?.length) return;
      if (audio.length > 20 * 1024 * 1024) throw new Error('voice note too long');
      const text = await transcribe(audio, mime);
      if (!text) return;
      run("UPDATE messages SET text = ? WHERE chat_id = ? AND wa_id = ?", `[voice note] ${text}`.slice(0, 4000), chatId, waId);
      run("UPDATE chats SET last_text = ? WHERE id = ? AND last_text LIKE '[voice note]%'", `🎤 ${text}`.slice(0, 200), chatId);
      emit('chat', { chatId });
    } catch (e) {
      log('warn', 'voice', `Could not turn a voice note into text: ${e.message}`);
    }
  })();
  track(chatId, job);
}

/** Used before replying: wait for voice notes of this chat that are still being turned into text. */
export async function voiceReady(chatId, maxMs = 25_000) {
  const p = pending.get(chatId);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, maxMs))]);
}

export const _pending = pending;
/** Which saved key would hear voice notes and see pictures (null = none can). */
/** Which model hears voice notes now (or that one will be found by itself), and which sees pictures. */
export function mediaStatus() {
  const best = getSettingsKv();
  const row = best && get('SELECT name FROM providers WHERE id = ? AND enabled = 1', Number(best.split(':')[0]));
  const any = get("SELECT 1 x FROM providers WHERE enabled = 1 AND kind != 'anthropic' LIMIT 1");
  return { voice: row ? `${row.name} (${best.split(':').slice(2).join(':')})` : any ? 'the first of your models that can (found automatically)' : null, images: viewer()?.name || null };
}
export const hasTranscriber = () => !!get("SELECT 1 x FROM providers WHERE enabled = 1 AND kind != 'anthropic' LIMIT 1");
