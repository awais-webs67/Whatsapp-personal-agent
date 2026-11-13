// One call shape for every provider: chat({ provider, system, messages }) -> { text, usage, limits }.
// Failures are normalised into LLMError so the router can decide whether to fail over.
import Anthropic from '@anthropic-ai/sdk';

export class LLMError extends Error {
  /** kind: rate_limit | quota | auth | server | network | bad_request | refusal | empty */
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
    throw new LLMError('network', e.name === 'TimeoutError' ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : `Network error: ${e.cause?.code || e.message}`);
  }
  const raw = await res.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || (typeof body?.error === 'string' ? body.error : null) || String(raw).slice(0, 300) || res.statusText;
    throw new LLMError(classify(res.status, body), `${res.status} ${msg}`, {
      status: res.status,
      retryAfter: parseDuration(res.headers.get('retry-after')) ?? parseDuration(res.headers.get('x-ratelimit-reset-requests')),
    });
  }
  if (typeof body !== 'object') throw new LLMError('bad_request', `Unexpected non-JSON response from ${new URL(url).host} — check the base URL`);
  return { body, headers: res.headers };
}

// ---------- OpenAI-compatible ----------
async function chatOpenAI(p, { system, messages, maxTokens, timeoutMs }) {
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

  let out;
  try {
    out = await post({ max_tokens: maxTokens });
  } catch (e) {
    // Newer OpenAI reasoning models only accept max_completion_tokens.
    if (e.kind === 'bad_request' && /max_tokens|max_completion_tokens/i.test(e.message)) out = await post({ max_completion_tokens: maxTokens });
    else throw e;
  }
  const { body, headers } = out;
  const choice = body.choices?.[0];
  let text = choice?.message?.content;
  if (Array.isArray(text)) text = text.map((part) => part.text || '').join('');
  if (!text?.trim()) {
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

async function modelsOpenAI(p) {
  const { body } = await fetchJson(`${base(p)}/models`, { headers: authHeaders(p) }, 20000);
  const list = body.data || body.models || [];
  return list.map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
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
  if (e instanceof Anthropic.APIConnectionError) return new LLMError('network', `Network error: ${e.message}`);
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
    const ids = [];
    for await (const m of anthropicClient(p, 20000).models.list()) ids.push(m.id);
    return ids;
  } catch (e) {
    throw anthropicError(e);
  }
}

// ---------- public ----------
export async function chat(provider, { system = '', messages, maxTokens = 1024, timeoutMs = 45000 }) {
  if (!provider.model) throw new LLMError('bad_request', 'No model selected for this provider');
  const req = { system, messages: normalize(messages), maxTokens, timeoutMs };
  if (!req.messages.length) throw new LLMError('bad_request', 'Nothing to send');
  const started = Date.now();
  const out = provider.kind === 'anthropic' ? await chatAnthropic(provider, req) : await chatOpenAI(provider, req);
  return { ...out, latencyMs: Date.now() - started };
}

export const listModels = (provider) => (provider.kind === 'anthropic' ? modelsAnthropic(provider) : modelsOpenAI(provider));

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
