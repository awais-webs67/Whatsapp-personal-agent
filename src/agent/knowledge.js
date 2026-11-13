// Token saver: instead of sending every product and every Q&A with each reply, send the ones that
// match what the customer is talking about in full, and the rest as a short "name — price" index.

const STOP = new Set(('the and for you your are with this that have has was what how much price prices rate ' +
  'kya hai hain ka ki ke ko se me mein main aap ap koi kar karo kr krna bhai sir please plz hello assalam alaikum walaikum ' +
  'acha ok okay yes no nahi han haan bhi chahiye chaiye mujhe muje ye yeh wo woh is us iss').split(' '));

export function words(text) {
  return [...new Set(String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}.+]+/u).map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length >= 2 && !STOP.has(w)))];
}

const isItem = (line) => /^\s*[-*•]\s+\S/.test(line) || /^\s*Product:\s/i.test(line);
const nameOf = (line) => line.replace(/^\s*([-*•]|Product:)\s*/i, '').split(/\s+[—–-]\s+|\s\|\s/)[0];
/** "Name — PKR 2,000 — description — url" -> "Name — PKR 2,000" */
const short = (line) => {
  const parts = line.replace(/^\s*([-*•]|Product:)\s*/i, '').split(/\s+[—–]\s+/);
  const price = parts.slice(1).find((p) => /\d/.test(p) && p.length <= 30);
  return `${parts[0]}${price ? ` — ${price}` : ''}`;
};

function score(line, query) {
  if (!query.length) return 0;
  const name = nameOf(line).toLowerCase();
  const rest = line.toLowerCase();
  let s = 0;
  for (const w of query) {
    if (name.includes(w)) s += /\d/.test(w) ? 2 : 4;
    else if (rest.includes(w)) s += 1;
  }
  return s;
}

function trimBlock(head, items, q, { full, keepAll, indexChars }) {
  if (items.length <= keepAll) return [...head, ...items];
  const label = (head.at(-1) || 'items').replace(/\s*\(\d+\)\s*:?\s*$|:\s*$/g, '').toLowerCase() || 'items';
  const ranked = items.map((line, i) => ({ line, i, s: score(line, q) }));
  const top = new Set([...ranked].sort((a, b) => b.s - a.s || a.i - b.i).filter((r) => r.s > 0).slice(0, full).map((r) => r.i));
  const index = [];
  let used = 0;
  let hidden = 0;
  for (const r of ranked) {
    if (top.has(r.i)) continue;
    const c = short(r.line);
    if (used + c.length + 2 > indexChars) { hidden++; continue; }
    index.push(c);
    used += c.length + 2;
  }
  return [
    ...head,
    ...(top.size ? ['Matching what this customer is talking about (full details):', ...items.filter((_, i) => top.has(i))] : []),
    `Other ${label}, name and price only (${items.length - top.size}; full details exist, ask the customer what they need)${index.length ? `: ${index.join('; ')}` : ''}${hidden ? `; and ${hidden} more not listed here` : ''}`,
  ];
}

/**
 * Keep prose as it is; in any list longer than `keepAll` items, send the items matching `query`
 * in full and the rest as a compact "name — price" index capped at `indexChars`.
 */
export function focus(text, query, { full = 8, keepAll = 12, indexChars = 1600 } = {}) {
  const src = String(text || '').trim();
  if (!src) return '';
  const q = words(query);
  const blocks = [];
  let cur = { head: [], items: [] };
  for (const line of src.split('\n')) {
    if (isItem(line)) cur.items.push(line);
    else {
      if (cur.items.length) { blocks.push(cur); cur = { head: [], items: [] }; }
      cur.head.push(line);
    }
  }
  blocks.push(cur);
  return blocks.flatMap((b) => trimBlock(b.head, b.items, q, { full, keepAll, indexChars })).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
