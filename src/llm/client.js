// One call shape for every provider: chat({ provider, system, messages }) -> { text, usage, limits }.
// Failures are normalised into LLMError so the router can decide whether to fail over.
import Anthropic from '@anthropic-ai/sdk';
import { explainFetchError } from '../agent/website.js';

export class LLMError extends Error {
  /** kind: rate_limit | quota | auth | server | network | model_missing | bad_request | refusal | empty */
  constructor(kind, message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const QUOTA_RE = /insufficient[_ ](quota|balance|credit)|exceeded your current quota|quota (has been )?exceeded|out of credits|billing|payment required|daily limit|free tier.*(limit|exhaust)|resource[_ ]exhausted.*(day|quota)/i;

function classify(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (status === 400 && /api[ _-]?key|API_KEY_INVALID/i.test(text)) return 'auth'; // Gemini reports a bad key as 400
  // The configured model was renamed, retired, or is not on this account: the router picks a current one.
  if ((status === 404 || status === 400 || status === 403) && /model[^"]{0,80}(does not exist|not[ _]found|decommission|deprecat|no longer|not supported|do not have access|is not available|unknown)|model_(not_found|decommissioned)|invalid model/i.test(text)) return 'model_missing';
  if (status === 401 || status === 403) return QUOTA_RE.test(text) ? 'quota' : 'auth';
  if (status === 402) return 'quota';
  if (status === 429) return QUOTA_RE.test(text) ? 'quota' : 'rate_limit';
  if (status === 408 || status >= 500) return 'server';
  return 'bad_request';
}

/** "12", "1m30s", "250ms", or an HTTP date -> seconds. */
export function parseDuration(v) {
  if (v == null || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = [...String(v).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (m.length) return m.reduce((sum, [, n, u]) => sum + Number(n) * { ms: 0.001, s: 1, m: 60, h: 3600 }[u], 0);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, (t - Date.now()) / 1000);
}

/** Pull live rate-limit numbers out of response headers (OpenAI-style and Anthropic-style). */
export function readLimits(headers) {
  const h = (name) => headers.get?.(name) ?? null;
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const out = {
    reqRemaining: num(h('x-ratelimit-remaining-requests') ?? h('anthropic-ratelimit-requests-remaining')),
    reqLimit: num(h('x-ratelimit-limit-requests') ?? h('anthropic-ratelimit-requests-limit')),
    tokRemaining: num(h('x-ratelimit-remaining-tokens') ?? h('anthropic-ratelimit-tokens-remaining')),
    tokLimit: num(h('x-ratelimit-limit-tokens') ?? h('anthropic-ratelimit-tokens-limit')),
    resetSec: parseDuration(h('x-ratelimit-reset-requests') ?? h('anthropic-ratelimit-requests-reset')),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

/** Merge consecutive same-role turns and make sure the conversation opens with the customer. */
export function normalize(messages) {
  const out = [];
  for (const m of messages) {
    const content = String(m.content ?? '').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n${content}`;
    else out.push({ role: m.role, content });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(earlier messages not shown)' });
  return out;
}

const base = (p) => String(p.baseUrl || '').replace(/\/+$/, '');
const authHeaders = (p) => (p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {});

async function fetchJson(url, init, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new LLMError('network', e.name === 'TimeoutError' ? `No answer within ${Math.round(timeoutMs / 1000)}s (raise "Give up on a model after" in Settings, or use a faster model)` : explainFetchError(e, new URL(url).hostname));
  }
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  if (!res.ok) {
    const b = Array.isArray(body) ? body[0] : body; // Gemini wraps errors in an array
    const msg = b?.error?.message || b?.message || (typeof b?.error === 'string' ? b.error : null) || String(raw).slice(0, 300) || res.statusText;
    const err = new LLMError(classify(res.status, body), `${res.status} ${msg}`, {
      status: res.status,
      retryAfter: parseDuration(res.headers.get('retry-after')) ?? parseDuration(res.headers.get('x-ratelimit-reset-requests')),
    });
    // Groq rejects output that looks like a tool call when no tools were sent, but includes what the model wrote.
    if (typeof b?.error?.failed_generation === 'string') err.failedGeneration = b.error.failed_generation;
    throw err;
  }
  if (typeof body !== 'object') throw new LLMError('bad_request', `Unexpected non-JSON response from ${new URL(url).host} — check the base URL`);
  return { body, headers: res.headers };
}

// ---------- OpenAI-compatible ----------
async function chatOpenAI(p, { system, messages, maxTokens, timeoutMs, fast }) {
  const payload = {
    model: p.model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
  };
  const post = (extra) =>
    fetchJson(`${base(p)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(p) },
      body: JSON.stringify({ ...payload, ...extra }),
    }, timeoutMs);

  // Gemini 2.5+ "thinks" before answering by default; for chat replies that mostly adds delay.
  const effort = fast && /generativelanguage\.googleapis\.com/.test(p.baseUrl || '') && /flash/i.test(p.model) ? { reasoning_effort: 'low' } : {};
  let out;
  try {
    out = await post({ max_tokens: maxTokens, ...effort });
  } catch (e) {
    if (e.kind !== 'bad_request') throw e;
    if (e.failedGeneration?.trim()) {
      return { text: toolCallToJson(e.failedGeneration), model: p.model, usage: { in: 0, out: 0 }, limits: null };
    }
    // Fall back for endpoints that reject an optional field (newer OpenAI models want max_completion_tokens).
    if (effort.reasoning_effort && /reasoning/i.test(e.message)) out = await post({ max_tokens: maxTokens });
    else if (/max_tokens|max_completion_tokens/i.test(e.message)) out = await post({ max_completion_tokens: maxTokens });
    else throw e;
  }
  const { body, headers } = out;
  const choice = body.choices?.[0];
  const msg = choice?.message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map((part) => part.text || '').join('');
  // Reasoning models may put their thinking inline; only the answer after it matters.
  text = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').replace(/<\|[a-z_]+\|>/g, '').trim();
  // Some models answer through the function-calling channel even when none was offered.
  const call = msg.tool_calls?.[0]?.function || msg.function_call;
  if (!text && call?.name) text = toolCallToJson(JSON.stringify({ name: call.name, arguments: call.arguments }));
  if (!text) {
    throw new LLMError('empty', choice?.finish_reason === 'length'
      ? 'Model ran out of tokens before answering — raise "Max tokens" in Settings'
      : `Model returned no text (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  }
  return {
    text: text.trim(),
    model: body.model || p.model,
    usage: { in: body.usage?.prompt_tokens ?? 0, out: body.usage?.completion_tokens ?? 0 },
    limits: readLimits(headers),
  };
}

const num = (...vals) => { for (const v of vals) { const n = Number(v); if (v != null && v !== '' && Number.isFinite(n) && n > 0) return n; } return null; };

/** One provider model entry -> { id, name, context, maxOutput, priceIn, priceOut, free, chat, owner }. Fields a provider does not publish stay null. */
export function describeModel(m) {
  const id = String(m.id || m.name || '').replace(/^models\//, '');
  const pr = m.pricing || {};
  // OpenRouter-style prices are USD per token; Together-style are already per million.
  const perM = (v, perToken) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) || n < 0 ? null : perToken ? n * 1e6 : n; };
  const priceIn = pr.prompt != null ? perM(pr.prompt, true) : perM(pr.input, false);
  const priceOut = pr.completion != null ? perM(pr.completion, true) : perM(pr.output, false);
  const outputs = m.architecture?.output_modalities;
  return {
    id,
    name: m.display_name || (m.name && m.name !== id ? m.name : null),
    context: num(m.context_window, m.context_length, m.max_context_length, m.top_provider?.context_length, m.inputTokenLimit, m.max_input_tokens, m.limits?.max_input_tokens, m.max_model_len),
    maxOutput: num(m.max_completion_tokens, m.top_provider?.max_completion_tokens, m.outputTokenLimit, m.max_output_tokens, m.max_tokens, m.limits?.max_output_tokens),
    priceIn, priceOut,
    free: /:free$/.test(id) || (priceIn === 0 && priceOut === 0),
    chat: !NOT_CHAT.test(id) && (!outputs || outputs.includes('text')) && m.active !== false,
    owner: m.owned_by || m.owner || null,
  };
}

async function modelsOpenAI(p) {
  const { body } = await fetchJson(`${base(p)}/models`, { headers: authHeaders(p) }, 20000);
  const list = (body.data || body.models || []).map(describeModel).filter((m) => m.id);
  // Gemini's OpenAI-compatible list has no token limits; its own API does.
  if (/generativelanguage\.googleapis\.com/.test(base(p))) {
    try {
      const native = await fetchJson(`${base(p).replace(/\/openai$/, '')}/models?pageSize=1000`, { headers: { 'x-goog-api-key': p.apiKey || '' } }, 20000);
      const byId = new Map((native.body.models || []).map((m) => [String(m.name).replace(/^models\//, ''), m]));
      for (const m of list) {
        const n = byId.get(m.id);
        if (n) Object.assign(m, { context: m.context ?? num(n.inputTokenLimit), maxOutput: m.maxOutput ?? num(n.outputTokenLimit), name: m.name || n.displayName || null });
      }
    } catch { /* limits are a nice-to-have */ }
  }
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- Anthropic (official SDK) ----------
// Models that support the server-side refusal fallback.
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Models that accept output_config.effort. Short chat replies do well at low effort, and it is much faster.
const EFFORT_MODELS = /^claude-(fable-5|opus-5|sonnet-5|haiku-5|opus-4-[5678]|sonnet-4-6)/;

const anthropicClient = (p, timeoutMs) =>
  new Anthropic({ apiKey: p.apiKey, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}), maxRetries: 0, timeout: timeoutMs });

function anthropicError(e) {
  if (e instanceof LLMError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LLMError('network', 'No answer in time (raise "Give up on a model after" in Settings, or use a faster model)');
  if (e instanceof Anthropic.APIConnectionError) return new LLMError('network', explainFetchError(e.cause ? e : { cause: e }, 'api.anthropic.com'));
  if (e instanceof Anthropic.APIError) {
    const kind = classify(e.status ?? 0, e.message);
    return new LLMError(kind, `${e.status ?? ''} ${e.message}`.trim(), { status: e.status ?? 0, retryAfter: parseDuration(e.headers?.get?.('retry-after')) });
  }
  return new LLMError('network', e.message);
}

async function chatAnthropic(p, { system, messages, maxTokens, timeoutMs }) {
  const client = anthropicClient(p, timeoutMs);
  // Thinking shares the max_tokens budget, so leave generous headroom above the reply itself.
  const params = {
    model: p.model, max_tokens: Math.max(maxTokens, 16000), messages, ...(system ? { system } : {}),
    ...(EFFORT_MODELS.test(p.model) ? { output_config: { effort: 'low' } } : {}),
  };
  try {
    const call = FALLBACK_MODELS.has(p.model)
      ? client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.create(params);
    const { data, response } = await call.withResponse();
    if (data.stop_reason === 'refusal') throw new LLMError('refusal', 'Model declined this request');
    const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new LLMError('empty', `Model returned no text (stop_reason: ${data.stop_reason})`);
    return {
      text,
      model: data.model,
      usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 },
      limits: readLimits(response.headers),
    };
  } catch (e) {
    throw anthropicError(e);
  }
}

async function modelsAnthropic(p) {
  try {
    const out = [];
    for await (const m of anthropicClient(p, 20000).models.list()) out.push(describeModel(m));
    return out;
  } catch (e) {
    throw anthropicError(e);
  }
}

// ---------- public ----------
export async function chat(provider, { system = '', messages, maxTokens = 1024, timeoutMs = 45000, fast = false }) {
  if (!provider.model) throw new LLMError('bad_request', 'No model selected for this provider');
  const req = { system, messages: normalize(messages), maxTokens, timeoutMs, fast };
  if (!req.messages.length) throw new LLMError('bad_request', 'Nothing to send');
  const started = Date.now();
  const out = provider.kind === 'anthropic' ? await chatAnthropic(provider, req) : await chatOpenAI(provider, req);
  return { ...out, latencyMs: Date.now() - started };
}

/** Full model descriptions (id, context window, max output, price when published). */
export const listModels = (provider) => (provider.kind === 'anthropic' ? modelsAnthropic(provider) : modelsOpenAI(provider));
/** Just the ids, for picking a replacement model. */
export const listModelIds = async (provider) => (await listModels(provider)).map((m) => m.id);

/** Account balance where the vendor exposes one. Returns null when there is no such endpoint. */
export async function fetchBalance(provider) {
  if (provider.preset === 'openrouter') {
    const { body } = await fetchJson(`${base(provider)}/key`, { headers: authHeaders(provider) }, 15000);
    const d = body.data || {};
    return { label: d.limit == null ? `$${Number(d.usage ?? 0).toFixed(2)} used${d.is_free_tier ? ' · free tier' : ''}` : `$${Number(d.limit_remaining ?? 0).toFixed(2)} of $${Number(d.limit).toFixed(2)} left`,
      remaining: d.limit == null ? null : Number(d.limit_remaining ?? 0) };
  }
  if (provider.preset === 'deepseek') {
    const { body } = await fetchJson(`${base(provider).replace(/\/v1$/, '')}/user/balance`, { headers: authHeaders(provider) }, 15000);
    const b = body.balance_infos?.[0];
    return b ? { label: `${b.total_balance} ${b.currency} left`, remaining: Number(b.total_balance) } : null;
  }
  return null;
}

/** Can this server reach the provider at all? Any HTTP answer counts as reachable. */
export async function probe(provider) {
  const url = provider.kind === 'anthropic' ? `${(provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models` : `${base(provider)}/models`;
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: provider.kind === 'anthropic' ? { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' } : authHeaders(provider) });
    return { ok: true, status: res.status, ms: Date.now() - started, keyOk: res.status < 400, host: new URL(url).hostname };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, host: new URL(url).hostname, error: e.name === 'TimeoutError' ? `${new URL(url).hostname} did not answer within 15s` : explainFetchError(e, new URL(url).hostname) };
  }
}

// Model IDs that are not chat models (speech, images, embeddings, safety filters...).
const NOT_CHAT = /whisper|tts|audio|speech|transcri|embed|guard|moderation|image|vision-preview|dall-e|sora|imagen|veo|rerank|realtime|search-preview|computer-use|aqa|playai|orpheus|prompt-guard|safeguard|ocr/i;
// Signs of a capable, general chat model, best first.
const GOOD = [/gpt-oss-120b/i, /llama-4-maverick|llama-3\.3-70b|70b/i, /qwen3?-.*(32b|235b)|kimi-k2/i, /flash(?!-lite)|sonnet|gpt-4\.1|gpt-4o|large|pro\b/i, /versatile|instruct|chat|turbo/i, /mini|instant|8b|lite/i];

/** Choose the closest current chat model to the one that disappeared. */
export function chooseModel(available, previous = '') {
  const list = [...new Set(available)].filter((m) => m && !NOT_CHAT.test(m));
  if (!list.length) return null;
  const words = String(previous).toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 1);
  const score = (m) => {
    const id = m.toLowerCase();
    const shared = words.filter((w) => id.includes(w)).length;
    const rank = GOOD.findIndex((re) => re.test(m));
    return shared * 3 + (rank === -1 ? 0 : GOOD.length - rank) - (/preview|exp|beta|alpha|test/i.test(m) ? 2 : 0);
  };
  return list.sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

/**
 * Small models sometimes answer in their native tool-call format instead of the JSON we asked for:
 *   <function=stats>{"days": 5}</function>   or   {"name": "stats", "parameters": {"days": 5}}
 * Turn those into {"action": ..., "args": ...}; anything else passes through unchanged.
 */
export function toolCallToJson(text) {
  const t = String(text).trim();
  const fn = t.match(/<function=([\w.-]+)>?\s*(\{[\s\S]*?\})?\s*(<\/function>)?/);
  if (fn) {
    let args = {};
    try { args = fn[2] ? JSON.parse(fn[2]) : {}; } catch { /* keep empty */ }
    return JSON.stringify({ action: fn[1], args });
  }
  try {
    const o = JSON.parse(t.replace(/^```(?:json)?|```$/g, '').trim());
    const call = Array.isArray(o) ? o[0] : o?.tool_calls?.[0]?.function || o;
    if (call && typeof call.name === 'string' && !('action' in call) && !('messages' in call)) {
      let args = call.arguments ?? call.parameters ?? call.args ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      return JSON.stringify({ action: call.name, args });
    }
  } catch { /* not JSON */ }
  return t;
}
