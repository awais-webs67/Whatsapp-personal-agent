// Owner's own words for jobs: "jab main 'report' kahun to pichle 1 din ki stats aur pending follow-ups batao".
// Taught once in Command; afterwards the short word runs the full instruction (often without any model call,
// because the full instruction is usually something the quick order reader understands by itself).
import { kvGet, kvSet } from '../core.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/["“”'‘’`.,!?؟]+/g, ' ').replace(/\s+/g, ' ').trim();
const Q = `["“'‘]?`;
const QE = `["”'’]?`;
const TEACH = [
  new RegExp(`^\\s*(?:jab|agar)\\s+(?:main|mein|me|mai|mei)\\s+${Q}(.{1,60}?)${QE}\\s+(?:kahun|kahu|kahoon|kahon|likhun|likhu|likhoon|bolun|bolu|boloon|bhejun|bhejoon|type\\s*karun)\\s*,?\\s*(?:to|tou|tw|toh)\\s+(.{3,600})$`, 'is'),
  // Without quotes the short word must end at a comma or "then": "when I say leads, show ...".
  new RegExp(`^\\s*when\\s+i\\s+(?:say|type|write|send)\\s+(?:["“'‘](.{1,60}?)["”'’]|(.{1,60}?)(?=\\s*,|\\s+then\\b))\\s*,?\\s*(?:then\\s+)?(.{3,600})$`, 'is'),
  new RegExp(`^\\s*shortcut\\s*:?\\s*${Q}(.{1,60}?)${QE}\\s*(?:=|->|matlab)\\s*(.{3,600})$`, 'is'),
];
const LIST = /^\s*(?:shortcuts?|mere\s+shortcuts|shortcut\s+list|list\s+shortcuts|my\s+shortcuts)\s*\??\s*$/i;
const REMOVE = [
  /^\s*["“'‘]?(.{1,60}?)["”'’]?\s+(?:wala\s+|ka\s+)?shortcut\s+(?:hatao|hata\s*do|delete\s*karo|delete|remove|khatam\s*karo|band\s*karo)\s*$/i,
  /^\s*(?:delete|remove)\s+(?:the\s+)?shortcut\s+["“'‘]?(.{1,60}?)["”'’]?\s*$/i,
];

export const listShortcuts = () => kvGet('shortcuts', {});

/**
 * Returns { reply } when the message taught, listed or removed a shortcut,
 * { text } with the full instruction when it used one, or null when it has nothing to do with shortcuts.
 */
export function shortcut(message) {
  const all = listShortcuts();
  if (LIST.test(message)) {
    const rows = Object.entries(all);
    return { reply: rows.length ? `Aap ke shortcuts:\n${rows.map(([k, v]) => `• "${k}" → ${v}`).join('\n')}` : 'Abhi koi shortcut nahi. Aise sikhayein: jab main "report" kahun to pichle 1 din ki stats batao' };
  }
  for (const re of REMOVE) {
    const m = re.exec(message);
    if (!m) continue;
    const key = norm(m[1]);
    if (!all[key]) return { reply: `"${key}" naam ka koi shortcut nahi mila. "shortcuts" likh kar list dekhein.` };
    delete all[key];
    kvSet('shortcuts', all);
    return { reply: `"${key}" wala shortcut hata diya.` };
  }
  for (const re of TEACH) {
    const m = re.exec(message);
    if (!m) continue;
    const key = norm(m.slice(1, -1).find((g) => g !== undefined));
    const instruction = m.at(-1).trim().replace(/^(?:ye|yeh|yah)\s+(?:karna|karo|kar\s*do)\s*:?\s*/i, '');
    if (!key || key.length > 60) return null;
    all[key] = instruction;
    kvSet('shortcuts', all);
    return { reply: `Yaad kar liya. Jab aap "${key}" likhenge to main yeh karunga: ${instruction}` };
  }
  const used = all[norm(message)];
  return used ? { text: used } : null;
}
