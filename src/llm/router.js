// Failover router. Providers form an ordered chain; a request walks the chain until one
// answers. A provider that hits its rate limit, runs out of quota or has a bad key is
// benched (with a reason and a timer) and the next one takes over automatically.
import { all, get, run, now, parse, update } from '../db.js';
import { decrypt, mask, emit, log, dayKey, getSettings } from '../core.js';
import { chat, fetchBalance, listModels, chooseModel, LLMError } from './client.js';

const MIN = 60_000;

/** Decrypted provider row, ready for the client. */
export function hydrate(row) {
  return { ...row, baseUrl: row.base_url, apiKey: decrypt(row.api_key), state: parse(row.state) };
}

export function usageToday(id) {
  return get('SELECT requests, errors, tokens_in, tokens_out FROM usage WHERE provider_id = ? AND day = ?', id, dayKey())
    || { requests: 0, errors: 0, tokens_in: 0, tokens_out: 0 };
}

/** Why a provider can't serve right now, or null if it can. */
export function blockedReason(row, state = parse(row.state), t = now()) {
  if (!row.enabled) return 'disabled';
  if (state.status === 'invalid_key') return 'invalid_key';
  if (state.status === 'model_missing') return 'model_missing';
  if (state.cooldownUntil && state.cooldownUntil > t) return state.status || 'cooldown';
  if (row.daily_limit && usageToday(row.id).requests >= row.daily_limit) return 'daily_limit';
  return null;
}

/** Shape sent to the dashboard: no secrets, live status included. */
export function publicProvider(row) {
  const state = parse(row.state);
  const blocked = blockedReason(row, state);
  return {
    id: row.id, preset: row.preset, name: row.name, kind: row.kind, baseUrl: row.base_url, model: row.model,
    enabled: !!row.enabled, priority: row.priority, dailyLimit: row.daily_limit, keyHint: mask(row.api_key), useFor: row.use_for || 'all',
    status: blocked || 'ready',
    cooldownUntil: state.cooldownUntil && state.cooldownUntil > now() ? state.cooldownUntil : null,
    lastError: state.lastError || null, lastOkAt: state.lastOkAt || null, lastLatencyMs: state.lastLatencyMs || null,
    limits: state.limits || null, balance: state.balance || null,
    usage: usageToday(row.id),
  };
}

export const listProviders = () => all('SELECT * FROM providers ORDER BY priority, id');
const broadcast = () => emit('providers', listProviders().map(publicProvider));

function setState(id, patch) {
  const row = get('SELECT state FROM providers WHERE id = ?', id);
  if (!row) return;
  update('providers', id, { state: JSON.stringify({ ...parse(row.state), ...patch }) }, ['state']);
}

function bump(id, { requests = 0, errors = 0, tin = 0, tout = 0 }) {
  run(`INSERT INTO usage (provider_id, day, requests, errors, tokens_in, tokens_out) VALUES (?,?,?,?,?,?)
       ON CONFLICT(provider_id, day) DO UPDATE SET requests = requests + excluded.requests, errors = errors + excluded.errors,
       tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
    id, dayKey(), requests, errors, tin, tout);
}

/** How long to bench a provider after a failure. */
export function cooldownFor(err) {
  const hinted = err.retryAfter ? Math.min(err.retryAfter * 1000, 24 * 60 * MIN) : null;
  switch (err.kind) {
    case 'rate_limit': return { status: 'rate_limited', ms: hinted != null ? Math.max(hinted, 1000) : MIN };
    case 'quota': return { status: 'quota_exhausted', ms: hinted ?? 60 * MIN };
    case 'auth': return { status: 'invalid_key', ms: 0 };
    case 'server': return { status: 'provider_down', ms: hinted ?? 30_000 };
    case 'network': return { status: 'unreachable', ms: 30_000 };
    case 'model_missing': return { status: 'model_missing', ms: 0 };
    default: return null; // bad_request / refusal / empty: this request's problem, not the provider's
  }
}

export function recordSuccess(id, out) {
  bump(id, { requests: 1, tin: out.usage.in, tout: out.usage.out });
  setState(id, { status: 'ready', cooldownUntil: null, lastError: null, lastOkAt: now(), lastLatencyMs: out.latencyMs, ...(out.limits ? { limits: { ...out.limits, at: now() } } : {}) });
}

export function recordFailure(row, err) {
  bump(row.id, { requests: 1, errors: 1 });
  const cd = cooldownFor(err);
  setState(row.id, {
    lastError: { kind: err.kind, message: err.message.slice(0, 300), at: now() },
    ...(cd ? { status: cd.status, cooldownUntil: cd.ms ? now() + cd.ms : null } : {}),
  });
  return cd;
}

/** Call one specific provider (used by "Test" and the playground). Still records usage/state. */
export async function callProvider(row, req, { purpose = 'reply' } = {}) {
  const s = getSettings().llm;
  // Live replies use the short timeout from Settings; background work (commands, learning, reviews) can take longer.
  const live = purpose === 'reply' || purpose === 'test';
  const timeoutMs = (live ? s.timeoutSec : Math.max(s.timeoutSec, 90)) * 1000;
  await waitForBudget(row, req);
  const once = (r) => chat(hydrate(r), { maxTokens: s.maxTokens, timeoutMs, fast: purpose === 'reply', ...req });
  // Small models now and then return an empty answer; a second sample almost always works.
  const call = async (r) => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(r); } catch (e) {
        if (attempt >= 2 || !(e instanceof LLMError) || e.kind !== 'empty' || /ran out of tokens/.test(e.message)) throw e;
      }
    }
  };
  try {
    let out;
    try {
      out = await call(row);
    } catch (e) {
      const fixed = e instanceof LLMError && e.kind === 'model_missing' ? await replaceModel(row) : null;
      if (!fixed) throw e;
      row = fixed;
      out = await call(row);
    }
    recordSuccess(row.id, out);
    return { ...out, providerId: row.id, providerName: row.name };
  } catch (e) {
    const err = e instanceof LLMError ? e : new LLMError('network', e.message);
    recordFailure(row, err);
    throw err;
  } finally {
    broadcast();
  }
}

/** Rough token count of a request (about 3.5 characters per token for mixed English / Roman Urdu). */
export const estimateTokens = (req) => Math.ceil((String(req.system || '').length + (req.messages || []).reduce((n, m) => n + String(m.content || '').length, 0)) / 3.5) + 300;

/**
 * Providers like Groq report how many tokens are left this minute and when that refills.
 * If this request clearly will not fit and the refill is near, wait instead of hitting a 429.
 */
async function waitForBudget(row, req, maxWaitMs = 30_000) {
  const l = parse(row.state).limits;
  if (!l || l.tokRemaining == null || !l.at) return;
  const refillAt = l.at + (l.tokResetSec ?? 60) * 1000;
  if (now() >= refillAt) return; // budget has refilled since we last looked
  const need = estimateTokens(req);
  if (need <= l.tokRemaining) return;
  const wait = refillAt - now() + 250;
  if (wait > 0 && wait <= maxWaitMs) {
    log('info', 'router', `${row.name}: waiting ${(wait / 1000).toFixed(1)}s for its per-minute token limit to refill`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** The provider no longer has this model: ask it for its current list and switch to the closest one. */
export async function replaceModel(row) {
  let models;
  try { models = await listModels(hydrate(row)); } catch { return null; }
  const next = chooseModel(models, row.model);
  if (!next || next === row.model) return null;
  update('providers', row.id, { model: next }, ['model']);
  log('warn', 'router', `${row.name}: model "${row.model}" is no longer available, switched to "${next}"`);
  return get('SELECT * FROM providers WHERE id = ?', row.id);
}

/** Walk the chain until a provider answers. Returns the reply plus which hops were tried. */
/** Which models may serve this kind of work. Customer replies vs. everything else (commands, learning, reviews). */
export function chainFor(purpose, rows = listProviders()) {
  const live = purpose === 'reply';
  const fits = rows.filter((r) => !r.use_for || r.use_for === 'all' || (live ? r.use_for === 'replies' : r.use_for === 'background'));
  // Never strand a request: if nothing is assigned to this kind of work, any enabled model may serve it.
  return fits.some((r) => r.enabled) ? fits : rows;
}

export async function complete(req, { purpose = 'reply' } = {}) {
  try {
    return await completeOnce(req, purpose);
  } catch (e) {
    const soon = chainFor(purpose).filter((r) => r.enabled && blockedReason(r) === 'rate_limited')
      .map((r) => parse(r.state).cooldownUntil).filter(Boolean).sort((a, b) => a - b)[0];
    const wait = soon ? soon - now() + 300 : null;
    if (!(e instanceof LLMError) || wait == null || wait > 35_000) throw e;
    log('info', 'router', `${purpose}: every model is briefly rate limited, retrying in ${(wait / 1000).toFixed(1)}s`);
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    return completeOnce(req, purpose);
  }
}

async function completeOnce(req, purpose) {
  const chain = chainFor(purpose);
  if (!chain.some((r) => r.enabled)) throw new LLMError('bad_request', 'No AI model is configured. Add one on the Models page.');
  const hops = [];
  for (const row of chain) {
    const blocked = blockedReason(row);
    if (blocked) {
      if (blocked !== 'disabled') hops.push({ provider: row.name, skipped: blocked });
      continue;
    }
    try {
      const out = await callProvider(row, req, { purpose });
      if (hops.some((h) => h.error)) log('info', 'router', `${purpose}: served by ${row.name} after failover`);
      return { ...out, hops };
    } catch (err) {
      hops.push({ provider: row.name, error: err.kind, message: err.message });
      const next = chain.slice(chain.indexOf(row) + 1).find((r) => !blockedReason(r));
      log('warn', 'router', `${row.name} failed (${err.kind}): ${err.message}${next ? ` — switching to ${next.name}` : ''}`);
    }
  }
  const why = { rate_limited: 'rate limited', quota_exhausted: 'quota used up', invalid_key: 'API key rejected', daily_limit: 'daily cap reached', provider_down: 'provider down', unreachable: 'not reachable from this server', cooldown: 'cooling down', model_missing: 'model not found (pick another on the Models page)' };
  const detail = hops.map((h) => `${h.provider}: ${h.skipped ? why[h.skipped] || h.skipped : h.message || h.error}`).join('; ');
  const weak = hops.some((h) => h.error === 'empty' || h.error === 'bad_request');
  const tip = weak && purpose !== 'reply'
    ? ' The model gave an unusable answer. Small models (8B) struggle with multi-step commands: add a larger model and set "Use this model for" to "Commands, learning and reviews only" on the Models page.'
    : chain.filter((r) => r.enabled).length < 2 ? ' Add a second model from another provider so one can cover when the other fails.' : '';
  throw new LLMError('quota', `No model could answer. ${detail}.${tip}`);
}

/** Refresh account balances where the vendor has an endpoint for it. */
export async function syncBalances() {
  for (const row of listProviders().filter((r) => r.enabled)) {
    try {
      const balance = await fetchBalance(hydrate(row));
      if (balance) setState(row.id, { balance: { ...balance, at: now() } });
    } catch { /* balance is best-effort */ }
  }
  broadcast();
}

// Cooldowns expire silently; nudge dashboards so the status flips back without a refresh.
let lastSig = '';
export function startRouterTicker() {
  // Earlier versions mistook per-minute limits for an exhausted quota and benched the model for an hour.
  for (const row of listProviders()) {
    const st = parse(row.state);
    if (st.status === 'quota_exhausted' && /per (minute|second)|\b(TPM|RPM)\b|try again in \d/i.test(st.lastError?.message || '')) {
      setState(row.id, { status: 'ready', cooldownUntil: null });
    }
  }
  const tick = () => {
    const sig = listProviders().map((r) => `${r.id}:${blockedReason(r) || 'ready'}`).join('|');
    if (sig !== lastSig) { lastSig = sig; broadcast(); }
  };
  setInterval(tick, 5000).unref();
  setInterval(() => syncBalances().catch(() => {}), 5 * MIN).unref();
}
