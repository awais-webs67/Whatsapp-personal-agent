// Voice notes: the audio is turned into text with a Whisper model (Groq's is free and fast; OpenAI works too),
// so the agent answers what the customer said instead of "[voice note]". The reply waits for it briefly.
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
  const all_ = Promise.all([pending.get(chatId), job].filter(Boolean)).then(() => {});
  pending.set(chatId, all_);
  all_.finally(() => { if (pending.get(chatId) === all_) pending.delete(chatId); });
}

/** Used before replying: wait for voice notes of this chat that are still being turned into text. */
export async function voiceReady(chatId, maxMs = 25_000) {
  const p = pending.get(chatId);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, maxMs))]);
}

export const _pending = pending;
export const hasTranscriber = () => !!get("SELECT 1 FROM providers WHERE enabled = 1 AND preset IN ('groq','openai') LIMIT 1");
