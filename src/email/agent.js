// The email agent's judgement: checks addresses before sending, finds an address on a contact's website,
// reads their website for one personal line, checks each email for spam signs, and understands replies
// (interested, a question, "not now", out of office, unsubscribe, wrong person) and drafts an answer.
import dns from 'node:dns/promises';
import { all, get, run, now, update } from '../db.js';
import { getSettings, emit, log } from '../core.js';
import { complete } from '../llm/router.js';
import { extractJson } from '../agent/brain.js';
import { publicUrl, fetchPage, htmlToText } from '../agent/website.js';
import { taskEvent } from '../agent/task-log.js';
import { notify } from '../agent/updates.js';

const DAY = 86_400_000;
const test = process.env.NODE_ENV === 'test';
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DISPOSABLE = /@(mailinator|guerrillamail|10minutemail|tempmail|temp-mail|yopmail|trashmail|getnada|sharklasers|dispostable|maildrop)\./i;
const ROLE = /^(info|sales|support|contact|hello|admin|office|team|help|enquiries|inquiries|marketing|hr|jobs|careers|billing|accounts|noreply|no-reply)@/i;

// ---------------- 1. checking addresses ----------------
const mxCache = new Map(); // domain -> { ok, note, at }
async function domainAccepts(domain) {
  const hit = mxCache.get(domain);
  if (hit && now() - hit.at < DAY) return hit;
  let r;
  try {
    const mx = await dns.resolveMx(domain);
    r = mx.length ? { ok: true, note: '' } : { ok: false, note: 'the domain has no mail server' };
  } catch (e) {
    if (['ENOTFOUND', 'ENODATA', 'ENOTIMP'].includes(e.code)) {
      // No MX record: some domains still take mail on their main address.
      try { await dns.resolve4(domain); r = { ok: true, note: 'no mail server record, may not receive email' }; } catch { r = { ok: false, note: 'the domain does not exist or has no mail server' }; }
    } else r = { ok: true, note: '' }; // a DNS hiccup is not a reason to drop someone
  }
  mxCache.set(domain, { ...r, at: now() });
  return r;
}

/** Check one address: ok, risky (still sent) or invalid (never sent). */
export async function verifyAddress(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(e)) return { verified: 'invalid', note: 'not a valid address' };
  if (DISPOSABLE.test(e)) return { verified: 'invalid', note: 'a throw-away mailbox' };
  const d = await domainAccepts(e.split('@')[1]);
  if (!d.ok) return { verified: 'invalid', note: d.note };
  if (ROLE.test(e)) return { verified: 'risky', note: 'a shared inbox (info@, sales@…): fewer replies' };
  return { verified: d.note ? 'risky' : 'ok', note: d.note };
}

/** Check every address of a list (in the background after an import). Invalid ones are never emailed. */
export async function verifyList(list) {
  const rows = all("SELECT id, email FROM email_contacts WHERE list = ? AND status = 'active' AND verified IS NULL AND email NOT LIKE 'pending:%'", list);
  let invalid = 0, risky = 0;
  for (const c of rows) {
    const v = await verifyAddress(c.email);
    update('email_contacts', c.id, { verified: v.verified, verify_note: v.note || null }, ['verified', 'verify_note']);
    if (v.verified === 'invalid') { run("UPDATE email_contacts SET status = 'invalid' WHERE id = ?", c.id); invalid++; }
    if (v.verified === 'risky') risky++;
  }
  if (rows.length) { log('info', 'email', `List "${list}": ${rows.length} addresses checked, ${invalid} invalid (skipped), ${risky} risky`); emit('email', {}); }
  return { checked: rows.length, invalid, risky };
}

// ---------------- 2. finding an address on a website ----------------
/** The best address on a business website: same domain first, then a person's, then a shared inbox. */
export async function findEmailOnSite(site) {
  let start;
  try { start = publicUrl(site); } catch { return null; }
  const host = start.hostname.replace(/^www\./, '');
  const found = new Set();
  for (const path of ['', '/contact', '/contact-us', '/about', '/about-us']) {
    try {
      const html = await fetchPage(new URL(path, start).href, { timeout: 12_000 });
      for (const m of String(html).replace(/&#64;|\[at\]|\(at\)/gi, '@').matchAll(EMAIL_RE)) found.add(m[0].toLowerCase().replace(/\.$/, ''));
    } catch { /* page missing: try the next */ }
    if ([...found].some((e) => e.endsWith(`@${host}`))) break;
  }
  const list = [...found].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/example\.|sentry|wixpress|godaddy/.test(e));
  const score = (e) => (e.endsWith(`@${host}`) ? 0 : 2) + (ROLE.test(e) ? 1 : 0);
  return list.sort((a, b) => score(a) - score(b))[0] || null;
}

/** Contacts imported with only a website: look for their address, then check it. */
export async function findEmails(list) {
  const rows = all("SELECT * FROM email_contacts WHERE list = ? AND status = 'no_email' AND website IS NOT NULL", list);
  let found = 0;
  for (const c of rows) {
    const email = await findEmailOnSite(c.website).catch(() => null);
    if (!email || get('SELECT 1 x FROM email_contacts WHERE list = ? AND email = ?', list, email)) { update('email_contacts', c.id, { verify_note: 'no address found on the website' }, ['verify_note']); continue; }
    const v = await verifyAddress(email);
    update('email_contacts', c.id, { email, status: v.verified === 'invalid' ? 'invalid' : 'active', verified: v.verified, verify_note: v.note ? `found on the website; ${v.note}` : 'found on the website' }, ['email', 'status', 'verified', 'verify_note']);
    if (v.verified !== 'invalid') found++;
  }
  if (rows.length) { log('info', 'email', `List "${list}": addresses found for ${found} of ${rows.length} websites`); emit('email', {}); }
  return { looked: rows.length, found };
}

// ---------------- 3. one personal line from their website ----------------
/** A short summary of what a contact's website says (read once, kept with the contact). */
export async function researchOf(contact) {
  if (contact.research) return contact.research;
  if (!contact.website || test) return '';
  try {
    const html = await fetchPage(publicUrl(contact.website).href, { timeout: 12_000 });
    const text = htmlToText(html).replace(/\s+/g, ' ').slice(0, 1500);
    update('email_contacts', contact.id, { research: text || '-' }, ['research']);
    return text;
  } catch {
    update('email_contacts', contact.id, { research: '-' }, ['research']);
    return '';
  }
}

// ---------------- 4. spam check ----------------
const SPAM_WORDS = /\b(free|guarantee[d]?|risk[- ]free|act now|limited time|winner|cash|100%|click here|buy now|urgent|congratulations|no obligation|best price|order now|earn money|double your|million|lowest price)\b/i;
/** Signs an email may land in spam. An empty list means it looks like a normal personal email. */
export function spamCheck(subject = '', body = '') {
  const issues = [];
  const text = `${subject}\n${body}`;
  if (SPAM_WORDS.test(text)) issues.push(`spam word "${text.match(SPAM_WORDS)[0]}"`);
  if ((body.match(/https?:\/\//g) || []).length > 1) issues.push('more than one link');
  if (/[A-Z]{6,}/.test(text.replace(/https?:\/\/\S+/g, ''))) issues.push('words in CAPITALS');
  if ((text.match(/!/g) || []).length > 1) issues.push('more than one exclamation mark');
  if (/[\u{1F300}-\u{1FAFF}]/u.test(text)) issues.push('emojis');
  const words = body.trim().split(/\s+/).length;
  if (words > 180) issues.push(`long (${words} words)`);
  if (subject.length > 60) issues.push('long subject');
  if (/\$\d|rs\.?\s?\d|\d+\s?% off/i.test(text)) issues.push('prices or discounts in the first email');
  return issues;
}

// ---------------- 5. understanding replies ----------------
const READ = `You read one reply to a cold sales email and decide what kind of answer it is.
Return ONLY JSON: {"kind": "interested | question | not_now | not_interested | unsubscribe | wrong_person | out_of_office | other",
"summary": "one short line in English: what they said and want",
"resume_on": "YYYY-MM-DD when they said to write again or when they are back (not_now / out_of_office), else null",
"phone": "a phone or WhatsApp number they gave, digits with country code, else null"}
interested = wants details, a call, a price or to go ahead. question = asks something before deciding. not_now = maybe later.
not_interested = a clear no. unsubscribe = asks to stop or be removed. wrong_person = not their job, or points to someone else.
out_of_office = an automatic away message.`;

const DRAFT = (b, p) => `You answer a reply to a cold email, as ${b.persona || 'the sender'} from ${b.name || 'our business'}. Write like a person: short, warm, specific to what they said.
What we offer: ${String(b.catalog || b.about || '').slice(0, 2500)}
${b.policies ? `Our terms: ${String(b.policies).slice(0, 800)}` : ''}
${p?.instructions ? `Campaign instructions from the owner: ${p.instructions}` : ''}
Rules: answer their exact question or next step first; 40 to 120 words; plain text; no markdown; never invent prices, dates or promises that are not written above (say you will confirm instead); end with one clear next step (a time for a call, or a link if one is given above). Sign with the sender's first name.
Return ONLY JSON: {"body": "the email text"}`;

/** Store a reply, understand it, act on it, and draft an answer when one is needed. */
export async function handleReply({ from, subject = '', text = '', messageId = null, accountId = null }) {
  const contact = get("SELECT * FROM email_contacts WHERE email = ? ORDER BY id DESC LIMIT 1", from);
  const send = contact && get("SELECT * FROM email_sends WHERE contact_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1", contact.id);
  const ins = run('INSERT OR IGNORE INTO email_replies (contact_id, task_id, account_id, from_email, subject, message_id, text, created_at) VALUES (?,?,?,?,?,?,?,?)',
    contact?.id || null, send?.task_id || null, accountId || send?.account_id || null, from, String(subject).slice(0, 300), messageId || `${from}:${now()}`, String(text).slice(0, 8000), now());
  if (!ins.changes) return null; // already handled
  const id = Number(ins.lastInsertRowid);
  let r = { kind: 'other', summary: '', resume_on: null, phone: null };
  try {
    const out = await complete({ system: READ, messages: [{ role: 'user', content: `Subject: ${subject}\n\n${String(text).slice(0, 4000)}` }], maxTokens: 300 }, { purpose: 'email' });
    r = { ...r, ...(extractJson(out.text) || {}) };
  } catch (e) { log('warn', 'email', `Could not read the reply from ${from}: ${e.message}`); }
  const kind = ['interested', 'question', 'not_now', 'not_interested', 'unsubscribe', 'wrong_person', 'out_of_office', 'other'].includes(r.kind) ? r.kind : 'other';
  const resume = r.resume_on && Date.parse(r.resume_on) > now() ? Date.parse(r.resume_on) : null;
  const phone = r.phone ? String(r.phone).replace(/\D/g, '').slice(0, 15) || null : null;
  update('email_replies', id, { kind, summary: String(r.summary || '').slice(0, 300), phone, resume_at: resume }, ['kind', 'summary', 'phone', 'resume_at']);

  const t = send?.task_id;
  const say = (line) => t && taskEvent(t, line, { kind: 'info' });
  if (contact) {
    if (kind === 'unsubscribe') { run("UPDATE email_contacts SET status = 'unsubscribed' WHERE email = ?", from); say(`${from} asked to be removed: never emailed again.`); }
    if (kind === 'wrong_person' || kind === 'not_interested') { run("UPDATE email_contacts SET status = ? WHERE email = ? AND status IN ('active','replied')", kind === 'wrong_person' ? 'wrong_person' : 'not_interested', from); say(`${from}: ${kind.replace('_', ' ')}. Their emails stopped.`); }
    // Away or "write me later": the sequence carries on from where it stopped, on the day they named.
    if ((kind === 'out_of_office' || kind === 'not_now') && send) {
      const due = resume || now() + (kind === 'out_of_office' ? 5 : 30) * DAY;
      run("UPDATE email_contacts SET status = 'active' WHERE id = ?", contact.id);
      const next = get("SELECT id FROM email_sends WHERE contact_id = ? AND task_id = ? AND status = 'skipped' AND error = 'They replied' ORDER BY step LIMIT 1", contact.id, send.task_id);
      if (next) update('email_sends', next.id, { status: 'queued', error: null, due_at: due }, ['status', 'error', 'due_at']);
      update('email_replies', id, { status: 'done' }, ['status']);
      say(`${from}: ${kind === 'out_of_office' ? 'away' : 'later'}. Next email on ${new Date(due).toISOString().slice(0, 10)}.`);
    }
  }
  // Interested or asking: an answer is drafted for the owner to check and send.
  if (['interested', 'question', 'other'].includes(kind)) {
    try {
      const p = t ? JSON.parse(get('SELECT params FROM tasks WHERE id = ?', t)?.params || '{}') : null;
      const out = await complete({ system: DRAFT(getSettings().business, p), messages: [{ role: 'user', content: `Our email: ${String(send?.body || '').slice(0, 1200)}\n\nTheir reply: ${String(text).slice(0, 3000)}` }], maxTokens: 600 }, { purpose: 'email' });
      const body = String(extractJson(out.text)?.body || '').trim();
      if (body) update('email_replies', id, { draft: body }, ['draft']);
    } catch (e) { log('warn', 'email', `Could not draft an answer to ${from}: ${e.message}`); }
  }
  if (['interested', 'question'].includes(kind)) notify(`📧 ${from} ${kind === 'interested' ? 'is interested' : 'asked something'}: ${r.summary || String(text).slice(0, 140)}${phone ? ` · WhatsApp ${phone}` : ''}. A drafted answer is ready on the Email page.`, { key: `email-reply:${id}` });
  emit('email', {});
  return { id, kind };
}

export const listReplies = (status = 'open') => all(`SELECT r.*, c.first_name, c.last_name, c.company, t.title campaign FROM email_replies r
  LEFT JOIN email_contacts c ON c.id = r.contact_id LEFT JOIN tasks t ON t.id = r.task_id
  ${status === 'open' ? "WHERE r.status = 'new'" : ''} ORDER BY r.created_at DESC LIMIT 200`);
