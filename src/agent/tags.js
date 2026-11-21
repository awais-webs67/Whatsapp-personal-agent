// Owner's own labels on chats ("vip", "ads-eid", "canva"). Stored as ",vip,canva," so one LIKE finds a tag.
export function normTags(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  return [...new Set(raw.toLowerCase().split(/[,\s#]+/).map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 30)).filter(Boolean))].slice(0, 20);
}
export const tagString = (list) => (list.length ? `,${list.join(',')},` : null);
export const tagsOf = (chat) => String(chat?.tags || '').split(',').filter(Boolean);
export const hasAnyTag = (chat, list) => !list?.length || list.some((t) => tagsOf(chat).includes(t));

/** "vip tag walon ko ...", "tag vip aur ads", "#vip" -> ['vip', ...] */
export function tagsIn(text) {
  const t = String(text || '');
  const found = [];
  for (const m of t.matchAll(/([\p{L}\p{N}_-]+)\s+(?:tag|label)\s*(?:wal[eoiay]n?|wale|wali|walon|walo|ke|ki|waly)\b/giu)) found.push(m[1]);
  // "Canva Ad label walon ko": a label name of several words becomes one tag (canva-ad)
  for (const m of t.matchAll(/["“']([^"”']{2,40})["”']\s*(?:tag|label)/giu)) found.push(m[1].trim().replace(/[^\p{L}\p{N}]+/gu, '-'));
  for (const m of t.matchAll(/\btags?\s*[:=]?\s*#?([\p{L}\p{N}_-]+)(?:\s*(?:,|aur|and|or)\s*#?([\p{L}\p{N}_-]+))?/giu)) found.push(m[1], m[2]);
  for (const m of t.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)) found.push(m[1]);
  return normTags(found.filter((x) => x && !/^(wal|ke|ki|lag|laga|lagao|walon|wale)$/i.test(x)));
}
