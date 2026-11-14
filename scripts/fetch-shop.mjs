#!/usr/bin/env node
// Refresh the product list in knowledge/<site>.md from the live shop.
//   node scripts/fetch-shop.mjs https://sellmetools.com/shop
// Only the part between the "products" markers is rewritten; the hand-written policies above it stay.
// The app loads knowledge/*.md into the agent's knowledge when it starts (and from the Knowledge page).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlToText, jsonLd, listedProducts, publicUrl } from '../src/agent/website.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const start = publicUrl(process.argv[2] || 'https://sellmetools.com/shop');
const host = start.hostname.replace(/^www\./, '');
const file = path.join(here, '..', 'knowledge', `${host.split('.')[0]}.md`);

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; shop-reader)' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return '';
}
const clip = (t, n) => { const v = String(t || '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };

const shop = await get(start.href);
if (!shop) { console.error(`Could not open ${start.href}. Check the internet connection or VPN.`); process.exit(1); }
const urls = [...new Set(listedProducts(shop, start).map((p) => p.url))];
const sitemap = await get(`${start.origin}/sitemap.xml`);
for (const m of sitemap.matchAll(/<loc>\s*([^<\s]+\/products?\/[^<\s]+)\s*<\/loc>/g)) if (!urls.includes(m[1])) urls.push(m[1]);

const products = [];
let next = 0;
let done = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < urls.length) {
    const url = urls[next++];
    const html = await get(url);
    done++;
    if (done % 10 === 0 || done === urls.length) process.stdout.write(`\rRead ${done}/${urls.length} product pages`);
    if (!html) continue;
    const nodes = jsonLd(html);
    const p = nodes.find((n) => [].concat(n['@type']).includes('Product'));
    if (!p?.name) continue;
    const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList')?.itemListElement?.map((x) => x.name) || [];
    const text = htmlToText(html);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const after = (label, exact = false) => { const i = lines.findIndex((l) => (exact ? l === label : l.startsWith(label))); return i === -1 ? '' : lines[i + 1] || ''; };
    const offer = [].concat(p.offers || [])[0] || {};
    products.push({
      name: clip(p.name, 90),
      category: crumbs.length >= 3 ? crumbs[crumbs.length - 2] : 'Other',
      price: offer.price ? `Rs ${Number(offer.price).toLocaleString('en-US')}` : '',
      usdt: (text.match(/≈\s*\$\s*([\d.,]+)\s*USDT/) || [])[1] || '',
      stock: /OutOfStock|SoldOut/i.test(String(offer.availability || '')) ? 'OUT OF STOCK' : 'in stock',
      about: clip(after('Product Overview', true) || p.description, 260),
      warranty: clip(after('🛡️ Warranty & Guarantee Terms'), 140),
      url,
    });
  }
}));
process.stdout.write('\n');
if (!products.length) { console.error('No products found.'); process.exit(1); }

const byCat = new Map();
for (const p of products.sort((a, b) => a.name.localeCompare(b.name))) byCat.set(p.category, [...(byCat.get(p.category) || []), p]);
const block = [
  `<!-- products:start (generated ${new Date().toISOString().slice(0, 10)} from ${start.href} by scripts/fetch-shop.mjs) -->`,
  `## Products (${products.length}, prices in PKR with the approximate USDT price)`,
  ...[...byCat].sort((a, b) => b[1].length - a[1].length).flatMap(([cat, list]) => [
    '',
    `### ${cat} (${list.length}):`,
    ...list.map((p) => `- ${p.name} — ${p.price}${p.usdt ? ` (≈ $${p.usdt} USDT)` : ''} — ${p.stock} — ${p.about}${p.warranty ? ` Warranty: ${p.warranty}` : ''} — ${p.url}`),
  ]),
  '<!-- products:end -->',
].join('\n');

fs.mkdirSync(path.dirname(file), { recursive: true });
const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${host}\n\n`;
const next2 = /<!-- products:start[\s\S]*?<!-- products:end -->/.test(prev)
  ? prev.replace(/<!-- products:start[\s\S]*?<!-- products:end -->/, block)
  : `${prev.trimEnd()}\n\n${block}\n`;
fs.writeFileSync(file, next2);
console.log(`Saved ${products.length} products in ${byCat.size} categories to ${path.relative(process.cwd(), file)}. Restart the app (or press "Load saved shop files" on the Knowledge page) to use them.`);
