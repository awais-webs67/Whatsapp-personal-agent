// Email campaigns from your own mailbox (SMTP), written one by one like a person would, at a person's pace.
//
// Deliverability, built in: a daily cap per mailbox that warms up slowly, office hours only, a random gap between
// any two emails, plain text (no tracking pixels, no images), one-click unsubscribe (header and link), your
// business address in the footer, follow-ups in the same thread, stop on reply (IMAP), stop on bounce, and a
// global "never email again" for anyone who unsubscribed or bounced. Plus an SPF / DKIM / DMARC / MX check.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { all, get, run, now, update } from '../db.js';
import { getSettings, encrypt, decrypt, emit, log, kvGet, SECRET, rand, hourIn } from '../core.js';
import { complete, outOfModels } from '../llm/router.js';
import { extractJson } from '../agent/brain.js';
import { parseCsv, toCsv } from '../csv.js';
import { taskEvent } from '../agent/task-log.js';
import { notify } from '../agent/updates.js';

const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const test = process.env.NODE_ENV === 'test';

// ---------------- sending accounts ----------------
export const PRESETS = {
  gmail: { label: 'Gmail / Google Workspace', smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.gmail.com', imap_port: 993, help: 'Turn on 2-step verification, then make an App password (Google Account → Security → App passwords) and use it here.' },
  outlook: { label: 'Outlook / Microsoft 365', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: 0, imap_host: 'outlook.office365.com', imap_port: 993, help: 'SMTP sending must be allowed for the mailbox (Microsoft 365 admin → user → Mail → Authenticated SMTP).' },
  zoho: { label: 'Zoho Mail', smtp_host: 'smtp.zoho.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.zoho.com', imap_port: 993, help: 'Use an app-specific password if two-factor login is on.' },
  hostinger: { label: 'Hostinger email', smtp_host: 'smtp.hostinger.com', smtp_port: 465, smtp_secure: 1, imap_host: 'imap.hostinger.com', imap_port: 993, help: 'Your full email address and its password.' },
  custom: { label: 'Other (SMTP)', smtp_host: '', smtp_port: 465, smtp_secure: 1, imap_host: '', imap_port: 993, help: 'Ask your email host for the SMTP and IMAP server names.' },
};

const publicAccount = (a) => ({ ...a, smtp_pass: undefined, imap_pass: undefined, hasImap: !!(a.imap_host && a.imap_user && a.imap_pass), sentToday: sentToday(a.id), limitToday: limitToday(a) });
export const listAccounts = () => all('SELECT * FROM email_accounts ORDER BY id').map(publicAccount);

export function saveAccount(b, id = null) {
  const prev = id ? get('SELECT * FROM email_accounts WHERE id = ?', id) : null;
  if (id && !prev) throw Object.assign(new Error('Email account not found'), { status: 404 });
  const from = String(b.from_email ?? prev?.from_email ?? '').trim();
  if (!EMAIL_RE.test(from)) throw Object.assign(new Error('Enter the email address you send from'), { status: 400 });
  const row = {
    name: String(b.name ?? prev?.name ?? from).trim().slice(0, 80) || from,
    from_name: String(b.from_name ?? prev?.from_name ?? '').trim().slice(0, 80) || from.split('@')[0],
    from_email: from,
    smtp_host: String(b.smtp_host ?? prev?.smtp_host ?? '').trim(),
    smtp_port: Number(b.smtp_port ?? prev?.smtp_port ?? 465),
    smtp_secure: (b.smtp_secure ?? prev?.smtp_secure ?? 1) ? 1 : 0,
    smtp_user: String(b.smtp_user ?? prev?.smtp_user ?? from).trim(),
    smtp_pass: b.smtp_pass ? encrypt(String(b.smtp_pass)) : prev?.smtp_pass,
    imap_host: String(b.imap_host ?? prev?.imap_host ?? '').trim() || null,
    imap_port: Number(b.imap_port ?? prev?.imap_port ?? 993) || 993,
    imap_user: String(b.imap_user ?? prev?.imap_user ?? b.smtp_user ?? from).trim() || null,
    imap_pass: b.imap_pass ? encrypt(String(b.imap_pass)) : b.smtp_pass && !prev?.imap_pass ? encrypt(String(b.smtp_pass)) : prev?.imap_pass ?? null,
    daily_limit: Math.max(1, Math.min(500, Number(b.daily_limit ?? prev?.daily_limit ?? 40))),
    warmup: (b.warmup ?? prev?.warmup ?? 1) ? 1 : 0,
    footer: String(b.footer ?? prev?.footer ?? '').trim().slice(0, 400),
    enabled: (b.enabled ?? prev?.enabled ?? 1) ? 1 : 0,
  };
  if (!row.smtp_host) throw Object.assign(new Error('Enter the SMTP server (e.g. smtp.gmail.com)'), { status: 400 });
  if (!row.smtp_pass) throw Object.assign(new Error('Enter the password (an app password for Gmail)'), { status: 400 });
  if (!row.footer) throw Object.assign(new Error('Add your business name and address for the footer: the law in most countries asks for it, and it helps you stay out of spam'), { status: 400 });
  if (prev) { update('email_accounts', id, row, Object.keys(row)); transports.delete(id); return publicAccount(get('SELECT * FROM email_accounts WHERE id = ?', id)); }
  const keys = Object.keys(row);
  const { lastInsertRowid } = run(`INSERT INTO email_accounts (${keys.join(',')}, created_at) VALUES (${keys.map(() => '?').join(',')}, ?)`, ...keys.map((k) => row[k]), now());
  return publicAccount(get('SELECT * FROM email_accounts WHERE id = ?', Number(lastInsertRowid)));
}
export function deleteAccount(id) {
  run("UPDATE email_sends SET status = 'skipped', error = 'Email account removed' WHERE account_id = ? AND status = 'queued'", id);
  run('DELETE FROM email_accounts WHERE id = ?', id);
  transports.delete(id);
  return { ok: true };
}

const transports = new Map();
function transportOf(a) {
  if (!transports.has(a.id)) transports.set(a.id, nodemailer.createTransport({ host: a.smtp_host, port: a.smtp_port, secure: !!a.smtp_secure, auth: { user: a.smtp_user, pass: decrypt(a.smtp_pass) }, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 30_000 }));
  return transports.get(a.id);
}

/** Can we log in to send (and to read replies)? */
export async function testAccount(id) {
  const a = get('SELECT * FROM email_accounts WHERE id = ?', id);
  if (!a) throw Object.assign(new Error('Email account not found'), { status: 404 });
  const out = { smtp: null, imap: null };
  try { await transportOf(a).verify(); out.smtp = 'ok'; update('email_accounts', a.id, { last_ok_at: now(), last_error: null }, ['last_ok_at', 'last_error']); } catch (e) { out.smtp = e.message; update('email_accounts', a.id, { last_error: e.message.slice(0, 300) }, ['last_error']); }
  if (a.imap_host && a.imap_pass) {
    const c = imapClient(a);
    try { await c.connect(); out.imap = 'ok'; await c.logout(); } catch (e) { out.imap = e.message; }
  }
  return out;
}

/** SPF, DKIM, DMARC and MX for the sending domain: what decides inbox or spam. */
export async function checkDomain(email, selector = '') {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) throw Object.assign(new Error('No domain in that address'), { status: 400 });
  const txt = async (name) => { try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; } };
  const free = /^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol)\./.test(domain);
  const mx = await dns.resolveMx(domain).catch(() => []);
  const spf = (await txt(domain)).find((r) => /^v=spf1/i.test(r));
  const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => /^v=DMARC1/i.test(r));
  const selectors = [selector, 'google', 'default', 'selector1', 'selector2', 'zoho', 'k1', 'mail', 'hostingermail-a', 'hostingermail1'].filter(Boolean);
  let dkim = null;
  for (const s of selectors) { const r = (await txt(`${s}._domainkey.${domain}`)).find((x) => /v=DKIM1|k=rsa|p=/i.test(x)); if (r) { dkim = s; break; } }
  const checks = [
    { name: 'MX', ok: mx.length > 0, detail: mx.length ? mx.map((m) => m.exchange).slice(0, 3).join(', ') : 'No mail server: replies cannot arrive. Add MX records at your domain host.' },
    { name: 'SPF', ok: !!spf, detail: spf || 'Missing. Add a TXT record on the domain, e.g. "v=spf1 include:_spf.google.com ~all" for Google (your email host gives the exact value).' },
    { name: 'DKIM', ok: !!dkim, detail: dkim ? `Found (selector "${dkim}")` : 'Not found. Turn on DKIM signing in your email host and add the TXT record it gives you. If you use another selector, enter it to check.' },
    { name: 'DMARC', ok: !!dmarc, detail: dmarc || 'Missing. Add a TXT record "_dmarc" with "v=DMARC1; p=none; rua=mailto:you@yourdomain".' },
  ];
  return { domain, free, checks, score: checks.filter((c) => c.ok).length, advice: free ? 'You send from a free address: fine to start, but for cold email use your own domain (ideally a separate one like yourbrand-mail.com) so your main domain stays safe.' : checks.every((c) => c.ok) ? 'All set. Keep the daily limit low for new mailboxes and let warm-up run.' : 'Fix the red ones before sending cold email; missing records are the main reason mail lands in spam.' };
}

// ---------------- contact lists ----------------
export function importContacts(list, csvText) {
  const name = String(list || '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('Name the list'), { status: 400 });
  const rows = parseCsv(csvText);
  if (!rows.length) throw Object.assign(new Error('The file has no rows. The first line must be column names, e.g. email,first_name,company,website'), { status: 400 });
  let added = 0, updated = 0, invalid = 0, suppressed = 0;
  for (const r of rows) {
    const email = String(r.email || r.email_address || r.e_mail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid++; continue; }
    if (get("SELECT 1 x FROM email_contacts WHERE email = ? AND status IN ('unsubscribed','bounced') LIMIT 1", email)) { suppressed++; continue; }
    const first = r.first_name || r.firstname || (r.name || r.full_name || '').split(' ')[0] || null;
    const last = r.last_name || r.lastname || (r.name || r.full_name || '').split(' ').slice(1).join(' ') || null;
    const known = ['email', 'email_address', 'e_mail', 'first_name', 'firstname', 'last_name', 'lastname', 'name', 'full_name', 'company', 'company_name', 'organization', 'website', 'url', 'domain', 'title', 'job_title', 'position', 'phone'];
    const extra = Object.fromEntries(Object.entries(r).filter(([k, v]) => v && !known.includes(k)));
    const vals = [first, last, r.company || r.company_name || r.organization || null, r.website || r.url || r.domain || null, r.title || r.job_title || r.position || null, r.phone || null, JSON.stringify(extra)];
    const prev = get('SELECT id FROM email_contacts WHERE list = ? AND email = ?', name, email);
    if (prev) { run('UPDATE email_contacts SET first_name = ?, last_name = ?, company = ?, website = ?, title = ?, phone = ?, extra = ? WHERE id = ?', ...vals, prev.id); updated++; }
    else { run('INSERT INTO email_contacts (list, email, first_name, last_name, company, website, title, phone, extra, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', name, email, ...vals, now()); added++; }
  }
  emit('email', {});
  return { list: name, rows: rows.length, added, updated, invalid, suppressed };
}
export const listLists = () => all(`SELECT list, COUNT(*) total, SUM(status = 'active') active, SUM(status = 'replied') replied,
  SUM(status = 'unsubscribed') unsubscribed, SUM(status = 'bounced') bounced, MAX(created_at) updated_at FROM email_contacts GROUP BY list ORDER BY updated_at DESC`);
export function exportList(list) {
  const rows = all('SELECT * FROM email_contacts WHERE list = ? ORDER BY id', list);
  return toCsv(rows, [['email', 'email'], ['first_name', 'first_name'], ['last_name', 'last_name'], ['company', 'company'], ['website', 'website'], ['title', 'title'], ['phone', 'phone'], ['status', 'status']]);
}
export function deleteList(list) { run("UPDATE email_sends SET status = 'skipped', error = 'List deleted' WHERE status = 'queued' AND contact_id IN (SELECT id FROM email_contacts WHERE list = ? AND status = 'active')", list); run("DELETE FROM email_contacts WHERE list = ? AND status = 'active'", list); emit('email', {}); return { ok: true }; }

// ---------------- unsubscribe ----------------
const sign = (id) => crypto.createHmac('sha256', SECRET).update(`unsub:${id}`).digest('base64url').slice(0, 22);
export const unsubToken = (contactId) => `${contactId}.${sign(contactId)}`;
export function unsubscribeLink(contactId) {
  const base = kvGet('publicUrl', '');
  return base ? `${base}${process.env.WEBHOOK_PREFIX || ''}/u/${unsubToken(contactId)}` : '';
}
/** The link or one-click header was used: never email this address again, from any list. */
export function unsubscribe(token) {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig || sign(id) !== sig) return null;
  const c = get('SELECT * FROM email_contacts WHERE id = ?', Number(id));
  if (!c) return null;
  run("UPDATE email_contacts SET status = 'unsubscribed' WHERE email = ?", c.email);
  run("UPDATE email_sends SET status = 'skipped', error = 'Unsubscribed' WHERE status = 'queued' AND contact_id IN (SELECT id FROM email_contacts WHERE email = ?)", c.email);
  log('info', 'email', `${c.email} unsubscribed`);
  emit('email', {});
  return c.email;
}

// ---------------- campaigns ----------------
const paramsOf = (t) => { try { return JSON.parse(t.params || '{}') || {}; } catch { return {}; } };

/**
 * Start an email campaign: every active contact of the lists gets email 1 (then each follow-up step in the same
 * thread, unless they reply, unsubscribe or bounce). Mailboxes are shared out in turn.
 */
export function createEmailCampaign(b, createTask) {
  const accountIds = (b.accountIds || []).map(Number).filter((id) => get('SELECT 1 x FROM email_accounts WHERE id = ? AND enabled = 1', id));
  if (!accountIds.length) throw Object.assign(new Error('Choose at least one sending mailbox (add one on the Email page)'), { status: 400 });
  const lists = (Array.isArray(b.lists) ? b.lists : [b.lists]).map((x) => String(x || '').trim()).filter(Boolean);
  const steps = (b.steps || []).map((s, i) => ({ days: i === 0 ? 0 : Math.max(1, Number(s.days) || 3), instruction: String(s.instruction || '').trim(), subject: String(s.subject || '').trim(), body: String(s.body || '').trim() }))
    .filter((s, i) => i === 0 || s.instruction || s.body);
  if (!steps.length || !(steps[0].instruction || steps[0].body)) throw Object.assign(new Error('Write what the first email should say'), { status: 400 });
  const contacts = all(`SELECT * FROM email_contacts c WHERE c.list IN (${lists.map(() => '?').join(',') || "''"}) AND c.status = 'active'
                        AND NOT EXISTS (SELECT 1 FROM email_contacts x WHERE x.email = c.email AND x.status IN ('unsubscribed','bounced'))
                        GROUP BY c.email ORDER BY c.id`, ...lists);
  if (!contacts.length) throw Object.assign(new Error('No active contacts in the chosen lists'), { status: 400 });
  const params = {
    accountIds, lists, steps, mode: b.mode === 'template' ? 'template' : 'ai', instructions: String(b.instructions || '').trim(),
    gapMin: Math.max(1, Number(b.gapMin) || 4), gapMax: Math.max(1, Number(b.gapMax) || 9), window: [Number(b.windowStart ?? 9), Number(b.windowEnd ?? 17)],
    weekdays: b.weekdays !== false, stopOnReply: b.stopOnReply !== false,
  };
  const id = createTask({ kind: 'email', title: String(b.name || 'Email campaign').slice(0, 120), instruction: steps[0].instruction || steps[0].subject || 'Email campaign' });
  run('UPDATE tasks SET params = ? WHERE id = ?', JSON.stringify(params), id);
  const start = Number(b.startInMinutes) > 0 ? now() + Number(b.startInMinutes) * 60_000 : now();
  contacts.forEach((c, i) => run("INSERT INTO email_sends (task_id, contact_id, account_id, step, status, due_at, created_at) VALUES (?,?,?,1,'queued',?,?)", id, c.id, accountIds[i % accountIds.length], start, now()));
  taskEvent(id, `Email campaign created: ${contacts.length} contacts from ${lists.join(', ')}, ${steps.length} email${steps.length === 1 ? '' : 's'} each, from ${accountIds.length} mailbox${accountIds.length === 1 ? '' : 'es'}`, { kind: 'info' });
  emit('tasks');
  return { id, contacts: contacts.length };
}

export function emailStats(taskId) {
  const n = (sql, ...p) => get(sql, ...p).n;
  return {
    members: n('SELECT COUNT(DISTINCT contact_id) n FROM email_sends WHERE task_id = ?', taskId),
    sent: n("SELECT COUNT(*) n FROM email_sends WHERE task_id = ? AND status = 'sent'", taskId),
    waiting: n("SELECT COUNT(*) n FROM email_sends WHERE task_id = ? AND status = 'queued'", taskId),
    replied: n("SELECT COUNT(DISTINCT s.contact_id) n FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id WHERE s.task_id = ? AND c.status = 'replied'", taskId),
    bounced: n("SELECT COUNT(DISTINCT s.contact_id) n FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id WHERE s.task_id = ? AND c.status = 'bounced'", taskId),
    unsubscribed: n("SELECT COUNT(DISTINCT s.contact_id) n FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id WHERE s.task_id = ? AND c.status = 'unsubscribed'", taskId),
    bought: 0,
  };
}
export const emailPeople = (taskId) => all(`SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.status,
    MAX(CASE WHEN s.status = 'sent' THEN s.step END) last_step, MAX(s.sent_at) last_sent, MIN(CASE WHEN s.status = 'queued' THEN s.due_at END) next_due
  FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id WHERE s.task_id = ? GROUP BY c.id ORDER BY last_sent DESC NULLS LAST LIMIT 1000`, taskId);
export const emailMessages = (taskId) => all(`SELECT s.id, s.step, s.subject, s.body, s.status, s.due_at, s.sent_at, s.error, c.email, c.first_name, c.company, a.from_email
  FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id LEFT JOIN email_accounts a ON a.id = s.account_id
  WHERE s.task_id = ? AND (s.status != 'queued' OR s.subject IS NOT NULL) ORDER BY COALESCE(s.sent_at, s.due_at) DESC LIMIT 500`, taskId);

// ---------------- writing ----------------
/** {Hi|Hello} picks one; {first_name} etc. are filled from the contact. */
export function fillEmail(text, c) {
  const vars = { first_name: c.first_name || 'there', last_name: c.last_name || '', name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there', company: c.company || 'your company', website: c.website || '', title: c.title || '' };
  return String(text || '').replace(/\{(first_name|last_name|name|company|website|title)\}/gi, (_, k) => vars[k.toLowerCase()])
    .replace(/\{([^{}]*\|[^{}]*)\}/g, (_, opts) => { const o = opts.split('|'); return o[Math.floor(Math.random() * o.length)]; });
}

async function writeEmail(t, p, send, contact, prev) {
  const step = p.steps[send.step - 1];
  if (p.mode === 'template' || !step.instruction) {
    return { subject: send.step > 1 && prev ? `Re: ${prev.subject}` : fillEmail(step.subject || 'Quick question', contact), body: fillEmail(step.body || step.instruction, contact) };
  }
  const s = getSettings();
  const b = s.business;
  const acc = get('SELECT from_name FROM email_accounts WHERE id = ?', send.account_id);
  const system = `You write one short cold email from ${acc?.from_name || 'the sender'} at ${b.name || 'our business'} to one person. It must read like a real person wrote it to them alone.
About us: ${b.about || b.goal || ''}
${b.catalog ? `What we offer (use only what fits this person): ${String(b.catalog).slice(0, 1500)}` : ''}
${p.instructions ? `Campaign instructions from the owner (follow exactly): ${p.instructions}` : ''}
${send.step > 1 ? `This is follow-up ${send.step - 1} in the same thread; they did not answer the earlier email${prev ? `: "${String(prev.body || '').slice(0, 600)}"` : ''}. Do not repeat it; add one new, useful reason to reply, shorter than before.` : 'This is the first email.'}
What this email should do: ${step.instruction}

Rules for inbox, not spam:
- Plain text, 50 to 120 words, 2 to 4 short paragraphs. No markdown, no bullet lists, no emojis, no ALL CAPS, at most one exclamation mark.
- Open with something specific to them (their company, website, role) when you know it; never "I hope this email finds you well".
- No spam words: free, guarantee, risk-free, act now, limited time, winner, cash, $$$, 100%, click here, buy now.
- At most one link, and only if the instructions give one. Never invent prices, numbers, names or claims.
- End with one easy, low-pressure question. Sign off with just the sender's first name (${(acc?.from_name || '').split(' ')[0] || 'the sender'}).
- Write in the language the instructions are written in, unless the contact's details suggest otherwise.
Return ONLY JSON: {"subject": "2 to 6 words, lower-case, no punctuation tricks", "body": "the email text"}`;
  const who = `The person: ${[contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(name unknown)'}${contact.title ? `, ${contact.title}` : ''}${contact.company ? ` at ${contact.company}` : ''}${contact.website ? ` (${contact.website})` : ''}${contact.extra && contact.extra !== '{}' ? `. More: ${contact.extra}` : ''}`;
  const out = await complete({ system, messages: [{ role: 'user', content: who }], maxTokens: 700 }, { purpose: 'email' });
  const j = extractJson(out.text) || {};
  const body = String(j.body || '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
  if (!body) throw new Error('The model returned no email');
  return { subject: send.step > 1 && prev ? `Re: ${prev.subject}` : String(j.subject || 'quick question').replace(/[\r\n]+/g, ' ').trim().slice(0, 90), body };
}

// ---------------- sending ----------------
function sentToday(accountId) { return get("SELECT COUNT(*) n FROM email_sends WHERE account_id = ? AND status = 'sent' AND sent_at > ?", accountId, now() - DAY).n; }
/** New mailboxes start at 10 a day and add 5 a day up to their limit (warm-up). */
function limitToday(a) {
  if (!a.warmup) return a.daily_limit;
  const first = get("SELECT MIN(sent_at) t FROM email_sends WHERE account_id = ? AND status = 'sent'", a.id).t;
  const days = first ? Math.floor((now() - first) / DAY) : 0;
  return Math.min(a.daily_limit, 10 + 5 * days);
}
const nextSlot = new Map(); // accountId -> earliest time for its next email

function inWindow(p) {
  const tz = getSettings().followup.timezone;
  const hour = hourIn(tz);
  const [from, to] = p.window || [9, 17];
  if (hour < from || hour >= to) return false;
  if (p.weekdays) { const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: tz }).format(new Date()); if (day === 'Sat' || day === 'Sun') return false; }
  return true;
}

let sending = false;
export async function sendTick() {
  if (sending) return;
  sending = true;
  try {
    for (const a of all('SELECT * FROM email_accounts WHERE enabled = 1')) {
      if (!test && (nextSlot.get(a.id) || 0) > now()) continue;
      if (sentToday(a.id) >= limitToday(a)) continue;
      const s = get(`SELECT s.* FROM email_sends s JOIN tasks t ON t.id = s.task_id WHERE s.account_id = ? AND s.status = 'queued' AND s.due_at <= ? AND t.status = 'active' ORDER BY s.due_at, s.id LIMIT 1`, a.id, now());
      if (!s) continue;
      const t = get('SELECT * FROM tasks WHERE id = ?', s.task_id);
      const p = paramsOf(t);
      if (!test && !inWindow(p)) continue;
      const c = get('SELECT * FROM email_contacts WHERE id = ?', s.contact_id);
      if (!c || c.status !== 'active' || get("SELECT 1 x FROM email_contacts WHERE email = ? AND status IN ('unsubscribed','bounced') LIMIT 1", c.email)) {
        update('email_sends', s.id, { status: 'skipped', error: `Contact is ${c?.status || 'gone'}` }, ['status', 'error']);
        continue;
      }
      nextSlot.set(a.id, now() + rand(p.gapMin || 4, p.gapMax || 9) * 60_000);
      const prev = s.step > 1 ? get("SELECT * FROM email_sends WHERE task_id = ? AND contact_id = ? AND step = ? AND status = 'sent'", s.task_id, s.contact_id, s.step - 1) : null;
      let mail;
      try {
        mail = s.subject && s.body ? { subject: s.subject, body: s.body } : await writeEmail(t, p, s, c, prev);
        update('email_sends', s.id, mail, ['subject', 'body']);
      } catch (e) {
        if (outOfModels(e)) { taskEvent(t.id, 'Every AI model is busy: emails wait and continue by themselves', { kind: 'paused', }); nextSlot.set(a.id, now() + 10 * 60_000); continue; }
        update('email_sends', s.id, { status: 'failed', error: `Could not write: ${e.message}`.slice(0, 300) }, ['status', 'error']);
        continue;
      }
      const unsub = unsubscribeLink(c.id);
      const text = `${mail.body}\n\n--\n${a.footer}\n${unsub ? `Not interested? ${unsub}` : 'Not interested? Reply "unsubscribe".'}`;
      try {
        const info = await transportOf(a).sendMail({
          from: { name: a.from_name, address: a.from_email }, to: c.first_name ? { name: [c.first_name, c.last_name].filter(Boolean).join(' '), address: c.email } : c.email,
          subject: mail.subject, text,
          ...(prev?.message_id ? { inReplyTo: prev.message_id, references: [prev.message_id] } : {}),
          headers: { 'List-Unsubscribe': unsub ? `<${unsub}>, <mailto:${a.from_email}?subject=unsubscribe>` : `<mailto:${a.from_email}?subject=unsubscribe>`, ...(unsub ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}) },
        });
        update('email_sends', s.id, { status: 'sent', sent_at: now(), message_id: info.messageId || null }, ['status', 'sent_at', 'message_id']);
        update('email_accounts', a.id, { last_ok_at: now(), last_error: null }, ['last_ok_at', 'last_error']);
        taskEvent(t.id, `Email ${s.step} sent to ${c.email}: "${mail.subject}"`, { kind: 'sent' });
        // The next email in the sequence, same mailbox, same thread.
        const nextStep = p.steps[s.step];
        if (nextStep) run("INSERT INTO email_sends (task_id, contact_id, account_id, step, status, due_at, created_at) VALUES (?,?,?,?,'queued',?,?)", t.id, c.id, a.id, s.step + 1, now() + nextStep.days * DAY + rand(0, 3) * 3_600_000, now());
      } catch (e) {
        const hard = e.responseCode >= 550 || /user unknown|does not exist|no such user|mailbox unavailable|recipient address rejected/i.test(e.message);
        update('email_sends', s.id, { status: 'failed', error: e.message.slice(0, 300) }, ['status', 'error']);
        if (hard) { run("UPDATE email_contacts SET status = 'bounced' WHERE email = ?", c.email); taskEvent(t.id, `Bounced: ${c.email} (${e.message.slice(0, 120)}). Never emailed again.`, { kind: 'failed' }); }
        else { update('email_accounts', a.id, { last_error: e.message.slice(0, 300) }, ['last_error']); taskEvent(t.id, `Could not send to ${c.email}: ${e.message.slice(0, 160)}`, { kind: 'failed' }); }
      }
      emit('email', { taskId: t.id });
    }
    // Finished: nothing left to send.
    for (const t of all("SELECT id, title FROM tasks WHERE kind = 'email' AND status = 'active'")) {
      if (!get("SELECT 1 x FROM email_sends WHERE task_id = ? AND status = 'queued' LIMIT 1", t.id)) {
        const st = emailStats(t.id);
        update('tasks', t.id, { status: 'done', last_result: `${st.sent} emails sent, ${st.replied} replied, ${st.bounced} bounced, ${st.unsubscribed} unsubscribed.`, last_run_at: now() }, ['status', 'last_result', 'last_run_at']);
        taskEvent(t.id, `Finished: ${st.sent} emails sent, ${st.replied} replied.`, { kind: 'done' });
        emit('tasks');
      }
    }
  } catch (e) {
    log('error', 'email', e.message);
  } finally {
    sending = false;
  }
}

// ---------------- replies (IMAP) ----------------
function imapClient(a) {
  return new ImapFlow({ host: a.imap_host, port: a.imap_port || 993, secure: true, auth: { user: a.imap_user || a.smtp_user, pass: decrypt(a.imap_pass) }, logger: false, socketTimeout: 30_000 });
}
/** Someone answered: stop their sequence everywhere and tell the owner. */
export function markReplied(email, snippet = '') {
  const rows = all("SELECT DISTINCT s.task_id, c.id FROM email_sends s JOIN email_contacts c ON c.id = s.contact_id WHERE c.email = ? AND s.status IN ('sent','queued')", email);
  if (!rows.length) return 0;
  run("UPDATE email_contacts SET status = 'replied' WHERE email = ? AND status = 'active'", email);
  run("UPDATE email_sends SET status = 'skipped', error = 'They replied' WHERE status = 'queued' AND contact_id IN (SELECT id FROM email_contacts WHERE email = ?)", email);
  for (const r of rows) taskEvent(r.task_id, `${email} replied${snippet ? `: "${snippet.slice(0, 120)}"` : ''}. Their follow-ups stopped.`, { kind: 'info' });
  notify(`📧 ${email} replied to your email campaign${snippet ? `: "${snippet.slice(0, 160)}"` : ''}. Answer them from your mailbox.`, { key: `email-reply:${email}`, everyMs: DAY });
  emit('email', {});
  return rows.length;
}
export async function checkReplies() {
  for (const a of all("SELECT * FROM email_accounts WHERE enabled = 1 AND imap_host IS NOT NULL AND imap_pass IS NOT NULL")) {
    if (!get("SELECT 1 x FROM email_sends WHERE account_id = ? AND status = 'sent' AND sent_at > ? LIMIT 1", a.id, now() - 30 * DAY)) continue;
    const c = imapClient(a);
    try {
      await c.connect();
      const lock = await c.getMailboxLock('INBOX');
      try {
        const since = new Date((a.imap_checked_at || now() - 3 * DAY) - 3_600_000);
        for await (const m of c.fetch({ since }, { envelope: true })) {
          const from = m.envelope?.from?.[0]?.address?.toLowerCase();
          if (!from || from === a.from_email.toLowerCase()) continue;
          if (/mailer-daemon|postmaster/.test(from)) continue;
          markReplied(from, m.envelope?.subject || '');
        }
      } finally { lock.release(); }
      await c.logout();
      update('email_accounts', a.id, { imap_checked_at: now() }, ['imap_checked_at']);
    } catch (e) {
      log('warn', 'email', `${a.from_email}: could not read replies (${e.message})`);
    }
  }
}

export function startEmail() {
  setInterval(() => sendTick().catch((e) => log('error', 'email', e.message)), 30_000).unref();
  setInterval(() => checkReplies().catch((e) => log('error', 'email', e.message)), 5 * 60_000).unref();
}
