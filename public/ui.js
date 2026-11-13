// Tiny DOM toolkit. Everything goes through textContent / attributes, so customer text can never inject HTML.
export function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += ` ${v}`;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** Replace an element's children. Unlike replaceChildren, skips null/false and flattens arrays. */
export function set(el, ...kids) {
  el.replaceChildren();
  add(el, kids);
  return el;
}
export const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
};

export async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth') && !url.includes('password')) { location.reload(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
export const GET = (u) => api('GET', u);
export const POST = (u, b = {}) => api('POST', u, b);
export const PATCH = (u, b) => api('PATCH', u, b);
export const PUT = (u, b) => api('PUT', u, b);
export const DEL = (u) => api('DELETE', u);

export function toast(msg, bad = false) {
  const t = h(`div.toast${bad ? '.bad' : ''}`, { role: bad ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

/** Run an async action behind a button: spinner while it runs, toast on failure. */
export async function act(btn, fn, okMsg) {
  if (btn?.classList.contains('busy')) return;
  btn?.classList.add('busy');
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn?.classList.remove('busy');
  }
}

export function modal(title, body, footer = () => []) {
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  const veil = h('div.veil', { onmousedown: (e) => e.target === veil && close() },
    h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', {}, h('h3', {}, title), h('button.btn.ghost.sm', { onclick: close, 'aria-label': 'Close' }, 'Close')),
      h('div.body', {}, body),
      h('footer', {}, footer(close))));
  document.addEventListener('keydown', onKey);
  document.body.append(veil);
  veil.querySelector('input, select, textarea')?.focus();
  return { close, el: veil };
}

export const field = (label, control, hint) => h('label.f', {}, label, control, hint && h('small', {}, hint));
export const toggle = (checked, onchange, label) => h('label.switch', { title: label }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked), 'aria-label': label }), h('i'));
export const select = (options, value, onchange, attrs = {}) =>
  h('select', { ...attrs, onchange: (e) => onchange?.(e.target.value) }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));

export function rel(ts) {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 0) { const m = -s / 60; return m < 60 ? `in ${Math.ceil(m)}m` : m < 1440 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`; }
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const dayLabel = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const num = (n) => Number(n || 0).toLocaleString();

export const STAGES = {
  new: ['New', '#CFD3D6'], engaged: ['Talking', '#8A9298'], interested: ['Interested', '#FFB09C'], negotiating: ['Negotiating', '#FF5B35'],
  purchased: ['Purchased', '#1E7A4C'], not_interested: ['Not interested', '#333F48'], opted_out: ['Opted out', '#B3261E'],
};
export const stagePill = (s) => h(`span.pill${s === 'purchased' ? '.ok' : s === 'opted_out' ? '.bad' : ['interested', 'negotiating'].includes(s) ? '.hot' : ''}`, {}, STAGES[s]?.[0] || s);

export const PROVIDER_STATUS = {
  ready: ['Ready', 'ok'], disabled: ['Off', ''], rate_limited: ['Rate limited', 'warn'], quota_exhausted: ['Quota used up', 'bad'],
  invalid_key: ['Key rejected', 'bad'], provider_down: ['Provider down', 'warn'], unreachable: ['Unreachable', 'warn'], daily_limit: ['Daily cap hit', 'warn'], cooldown: ['Cooling down', 'warn'],
};
