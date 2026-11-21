// Voice notes and pictures. Voice notes: the audio is turned into text with a Whisper model (Groq's is free and fast; OpenAI works too),
// so the agent answers what the customer said instead of "[voice note]". Pictures (payment proofs, screenshots,
// product photos) are described by a vision model. Each can be switched off in Settings to save tokens.
// The reply waits for them briefly.
import { all, get, run } from '../db.js';
import { getSettings, log, emit } from '../core.js';
import { hydrate } from '../llm/router.js';

const pending = new Map(); // chatId -> Promise (transcriptions still running)
const MODELS = { groq: 'whisper-large-v3-turbo', openai: 'whisper-1' };

/** A provider that can transcribe: a saved Groq or OpenAI key. */
function transcriber() {
  const row = all("SELECT * FROM providers WHERE enabled = 1 AND preset IN ('groq','openai') ORDER BY CASE preset WHEN 'groq' THEN 0 ELSE 1 END, priority")[0];
  return row ? hydrate(row) : null;
}

export async function transcribe(buffer, mime = 'audio/ogg') {
  const p = transcriber();
  if (!p) throw new Error('No Groq or OpenAI key saved: voice notes cannot be turned into text');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), mime.includes('mp4') ? 'voice.m4a' : 'voice.ogg');
  form.append('model', MODELS[p.preset] || 'whisper-1');
  form.append('response_format', 'json');
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}` }, body: form, signal: AbortSignal.timeout(45_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Transcription failed (${res.status})`);
  return String(json.text || '').trim();
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
  if (getSettings().images?.read !== true || !fetchImage) return;
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
  if (getSettings().voice?.transcribe === false || !fetchAudio) return;
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
export const mediaStatus = () => ({ voice: transcriber()?.name || null, images: viewer()?.name || null });
export const hasTranscriber = () => !!get("SELECT 1 FROM providers WHERE enabled = 1 AND preset IN ('groq','openai') LIMIT 1");
