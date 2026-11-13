// Reads a shop's website into plain text the agent can use.
// Products come from the site's own structured data (schema.org JSON-LD: ItemList, Product, Offer),
// found through the page itself and the sitemap, so names and prices are copied exactly, not guessed.
// A model is only used to summarise the "about / policies" prose.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?|\[?f[cd])/i;
const MAX_PRODUCTS = 300;
const CONCURRENCY = 6;

export function publicUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(String(raw).trim()) ? String(raw).trim() : `https://${String(raw).trim()}`); } catch { throw new Error('That does not look like a web address'); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new Error('Only public http(s) websites can be read');
  return u;
}

/** Plain-language reason for a network failure ("fetch failed" alone says nothing). */
export function explainFetchError(e, host) {
  const code = e?.cause?.code || e?.code || '';
  const detail = e?.cause?.message || e?.message || 'unknown error';
  if (e?.name === 'TimeoutError' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) return `${host} did not answer in time from this server (${code || 'timeout'}). Check this server's internet connection or firewall.`;
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `This server could not look up ${host} (${code}). Check the address, or the server's DNS / internet connection.`;
  if (/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return `${host} refused or dropped the connection (${code}). A firewall, VPN or the site's bot protection may be blocking this server.`;
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code + detail)) return `Secure connection to ${host} failed (${code || detail}). Antivirus or a network proxy that inspects HTTPS often causes this; set NODE_EXTRA_CA_CERTS to its certificate, or try another network.`;
  return `Could not reach ${host}: ${code ? `${code} ` : ''}${detail}`;
}

async function get(url, { accept = 'text/html,application/xhtml+xml', timeout = 20000 } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout), headers: { 'user-agent': UA, accept, 'accept-language': 'en' } });
      break;
    } catch (e) {
      if (attempt >= 1) throw new Error(explainFetchError(e, new URL(url).hostname));
      await new Promise((r) => setTimeout(r, 1200)); // one retry: brief network blips are common
    }
  }
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}${res.status === 403 || res.status === 503 ? ' (bot protection may be blocking automated reads)' : ''}`);
  return (await res.text()).slice(0, 2_000_000);
}

// Tags whose quoted attributes may contain ">" (Alpine, Vue: x-show="n > 0") must not be cut there.
const TAG = /<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#039': "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
export const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

export function htmlToText(html) {
  return decode(String(html)
    .replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, '\n')
    .replace(TAG, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n+/g, '\n').trim();
}

/** Every schema.org node in the page's JSON-LD, flattened (handles @graph, arrays, nesting). */
export function jsonLd(html) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n['@type']) out.push(n);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  for (const [, body] of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(body.trim())); } catch { /* skip a broken block */ }
  }
  return out;
}
const isType = (n, t) => [].concat(n['@type']).includes(t);

function money(offer) {
  const o = [].concat(offer || [])[0];
  if (!o) return '';
  const price = o.price ?? o.lowPrice ?? o.priceSpecification?.price;
  if (price == null || price === '') return '';
  const cur = o.priceCurrency || o.priceSpecification?.priceCurrency || '';
  const num = Number(price);
  const shown = Number.isFinite(num) ? num.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(price);
  const high = o.highPrice != null && o.highPrice !== price ? `–${Number(o.highPrice).toLocaleString('en-US')}` : '';
  return `${cur ? `${cur} ` : ''}${shown}${high}`;
}
const stock = (offer) => {
  const a = String([].concat(offer || [])[0]?.availability || '');
  return /OutOfStock|SoldOut|Discontinued/i.test(a) ? 'out of stock' : /PreOrder|BackOrder/i.test(a) ? 'pre-order' : '';
};
const clip = (s, n) => { const t = decode(String(s || '')).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** One product from a product page, or null. */
export function productFrom(html, url) {
  const p = jsonLd(html).find((n) => isType(n, 'Product'));
  if (!p?.name) return null;
  return { name: clip(p.name, 120), price: money(p.offers), stock: stock(p.offers), description: clip(p.description, 220), url: p.url || url };
}

/** Product URLs and names a listing page announces in its ItemList. */
export function listedProducts(html, base) {
  const out = [];
  for (const list of jsonLd(html).filter((n) => isType(n, 'ItemList'))) {
    for (const item of [].concat(list.itemListElement || [])) {
      const target = item.item && typeof item.item === 'object' ? item.item : item;
      const url = target.url || target['@id'] || (typeof item.item === 'string' ? item.item : null);
      if (!url) continue;
      try { out.push({ url: new URL(url, base).href, name: clip(target.name || item.name || '', 120), inline: isType(target, 'Product') ? target : null }); } catch { /* bad url */ }
    }
  }
  return out;
}

const looksLikeProduct = (u) => /\/(products?|item|items|shop\/[^/]+\/?$|p|store\/[^/]+)\/[^/]+/i.test(new URL(u).pathname) || /[?&](product|item)(_id)?=/i.test(u);

/** URLs from sitemap.xml (follows one level of sitemap index). */
async function sitemapUrls(origin) {
  const fromXml = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
  let xml;
  try { xml = await get(`${origin}/sitemap.xml`, { accept: 'application/xml,text/xml', timeout: 12000 }); } catch { return []; }
  let urls = fromXml(xml);
  if (/<sitemapindex/i.test(xml)) {
    const children = urls.sort((a, b) => (/product/i.test(b) ? 1 : 0) - (/product/i.test(a) ? 1 : 0)).slice(0, 5);
    urls = [];
    for (const c of children) urls.push(...fromXml(await get(c, { accept: 'application/xml,text/xml', timeout: 12000 }).catch(() => '')));
  }
  return urls;
}

async function pool(items, fn, n = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
  }));
  return out;
}

/**
 * Read a site. Returns { start, products: [{name, price, stock, description, url}], pages: [{url, text}] }.
 * `onProgress(done, total)` reports product-page progress.
 */
export async function readSite(raw, { onProgress = () => {} } = {}) {
  const start = publicUrl(raw);
  const home = await get(start.href);
  const sameSite = (u) => { try { const x = new URL(u, start); return x.hostname.replace(/^www\./, '') === start.hostname.replace(/^www\./, '') ? x : null; } catch { return null; } };

  // 1. Product candidates: the page's own ItemList, the sitemap, and product-looking links.
  const candidates = new Map();
  const add = (url, name = '') => { const u = sameSite(url); if (u) { const k = u.origin + u.pathname.replace(/\/$/, ''); if (!candidates.has(k)) candidates.set(k, { url: u.href, name }); } };
  const direct = productFrom(home, start.href);
  for (const l of listedProducts(home, start)) add(l.url, l.name);
  const links = [...home.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => decode(m[1]));
  for (const l of links) if (sameSite(l) && looksLikeProduct(sameSite(l).href)) add(l);
  for (const u of await sitemapUrls(start.origin)) if (looksLikeProduct(u)) add(u);

  // 2. Read each product page's structured data.
  const list = [...candidates.values()].slice(0, MAX_PRODUCTS);
  let done = 0;
  const products = (await pool(list, async (c) => {
    const p = productFrom(await get(c.url, { timeout: 15000 }), c.url);
    onProgress(++done, list.length);
    return p || (c.name ? { name: c.name, price: '', stock: '', description: '', url: c.url } : null);
  })).filter(Boolean);
  if (direct) products.unshift(direct);
  const seen = new Set();
  const unique = products.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  // 3. A few prose pages (about, faq, policies, contact) for the summary.
  const prose = [...new Set(links.map((l) => sameSite(l)).filter(Boolean)
    .filter((u) => /about|faq|policy|polic|refund|return|terms|shipping|delivery|warranty|contact|how-to|payment/i.test(u.pathname))
    .map((u) => u.origin + u.pathname))].slice(0, 6);
  const pages = [{ url: start.href, text: htmlToText(home) }];
  for (const [i, html] of (await pool(prose, (u) => get(u, { timeout: 15000 }))).entries()) if (html) pages.push({ url: prose[i], text: htmlToText(html) });
  // FAQ blocks the site already publishes in structured form.
  const faqs = jsonLd(home).filter((n) => isType(n, 'Question')).map((q) => ({ q: clip(q.name, 200), a: clip(q.acceptedAnswer?.text, 400) })).filter((f) => f.q && f.a);

  return { start: start.href, products: unique, pages, faqs };
}

export function formatProducts(products) {
  return products.map((p) => `- ${p.name}${p.price ? ` — ${p.price}` : ''}${p.stock ? ` (${p.stock})` : ''}${p.description ? ` — ${p.description}` : ''} — ${p.url}`).join('\n');
}
