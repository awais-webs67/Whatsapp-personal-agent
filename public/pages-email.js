// Email: the mailboxes you send from (with a deliverability check) and your contact lists.
import { h, set, ico, GET, POST, PATCH, DEL, act, toast, modal, field, select, num, rel } from './ui.js';
import { live } from './state.js';

export function emailPage() {
  const accBox = h('div.stack');
  const listBox = h('div.stack');
  const replyBox = h('div.stack');
  let showAll = false;
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Email'), h('p', {}, 'Send cold and follow-up emails from your own mailbox. Each email is written for one person and sent at a person’s pace, with warm-up, office hours, unsubscribe and stop-on-reply built in.')),
      h('a.btn.primary', { href: '#/campaigns' }, ico('megaphone', 'sm'), 'Email campaigns')),
    h('div.estrip', {}, [
      ['shield-check', 'Inbox, not spam', 'SPF, DKIM, DMARC check, plain text, no tracking pixels'],
      ['gauge', 'Warm-up', 'New mailboxes start at 10 a day and grow slowly'],
      ['clock', 'Office hours', 'Random gaps, weekdays, your time zone'],
      ['reply', 'Stops on reply', 'Replies, bounces and unsubscribes end the sequence'],
    ].map(([i, t, d]) => h('div', {}, ico(i), h('b', {}, t), h('span', {}, d)))),
    h('div.card', {}, h('header', {}, h('div', {}, h('h2', {}, 'Replies'), h('p.muted', { style: 'margin:3px 0 0;font-size:12.5px' }, 'The agent reads each reply, says what kind it is, and drafts an answer. Away and “later” replies continue the sequence on the right day by themselves.')),
      h('label.row', { style: 'font-size:12.5px;gap:6px' }, h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; loadReplies(); } }), 'Show answered too')), replyBox),
    h('div.card', {}, h('header', {}, h('h2', {}, 'Sending mailboxes'), h('button.btn.sm.primary', { onclick: () => accountForm() }, '+ Add mailbox')), accBox),
    h('div.card', {}, h('header', {}, h('h2', {}, 'Contact lists'), h('button.btn.sm.primary', { onclick: () => importList() }, ico('upload', 'sm'), 'Import CSV')), listBox));

  async function load() {
    const [accs, lists] = await Promise.all([GET('/api/email/accounts').catch(() => []), GET('/api/email/lists').catch(() => [])]);
    set(accBox, accs.length ? accs.map((a) => h('div.erow', {},
      h('div.cicon.email', {}, ico('mail')),
      h('div.grow', {}, h('b', {}, `${a.from_name} <${a.from_email}>`),
        h('div.muted', { style: 'font-size:12.5px' }, `${a.smtp_host}:${a.smtp_port} · ${num(a.sentToday)} of ${num(a.limitToday)} sent today${a.warmup && a.limitToday < a.daily_limit ? ` (warming up to ${a.daily_limit})` : ''} · replies ${a.hasImap ? 'watched' : 'not watched (add IMAP)'}`),
        a.last_error ? h('div', { style: 'font-size:12.5px;color:var(--danger)' }, a.last_error) : a.last_ok_at ? h('div', { style: 'font-size:12.5px;color:var(--success)' }, `Working · last OK ${rel(a.last_ok_at)} ago`) : null),
      h('div.row.wrap', {},
        h('button.btn.sm', { onclick: (e) => act(e.target, async () => { const r = await POST(`/api/email/accounts/${a.id}/test`); toast(`Sending: ${r.smtp === 'ok' ? 'works' : r.smtp}${r.imap ? ` · Replies: ${r.imap === 'ok' ? 'works' : r.imap}` : ''}`, r.smtp !== 'ok'); load(); }) }, 'Test'),
        h('button.btn.sm', { onclick: () => domainCheck(a.from_email) }, 'Check domain'),
        h('button.btn.sm', { onclick: () => accountForm(a) }, 'Edit'),
        h('button.btn.sm.ghost.danger', { onclick: (e) => confirm(`Remove ${a.from_email}? Its queued emails are cancelled.`) && act(e.target, async () => { await DEL(`/api/email/accounts/${a.id}`); load(); }) }, 'Remove'))))
      : h('div.cempty', { style: 'border:0' }, h('b', {}, 'No mailbox yet'), h('p', {}, 'Add the email address you send from. For cold email, a separate domain (like yourbrand-mail.com) keeps your main domain safe.')));
    set(listBox, lists.length ? h('div.rtable', {}, h('table', {},
      h('thead', {}, h('tr', {}, ['List', 'Contacts', 'Active', 'Replied', 'Unsubscribed', 'Bounced', 'Not valid', 'Need email', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, lists.map((l) => h('tr', {}, h('td', {}, h('b', {}, l.list), l.unchecked ? h('div.muted', { style: 'font-size:11.5px' }, `${num(l.unchecked)} not checked yet`) : l.risky ? h('div.muted', { style: 'font-size:11.5px' }, `${num(l.risky)} risky (still sent)`) : null), h('td.n', {}, num(l.total)), h('td.n', {}, num(l.active)), h('td.n', {}, num(l.replied)), h('td.n', {}, num(l.unsubscribed)), h('td.n', {}, num(l.bounced)), h('td.n', {}, num(l.invalid || 0)), h('td.n', {}, num(l.no_email || 0)),
        h('td.n', {}, h('button.btn.sm', { title: 'Check every address, and look up missing ones on their websites', onclick: (e) => act(e.target, async () => { const r = await POST(`/api/email/lists/${encodeURIComponent(l.list)}/verify`); toast(`${r.checked} checked, ${r.invalid} not valid${r.looked ? `, ${r.found} of ${r.looked} found on websites` : ''}`); load(); }) }, 'Check addresses'), ' ', h('a.btn.sm', { href: `/api/email/lists/${encodeURIComponent(l.list)}/export.csv`, download: '' }, 'Export'), ' ',
          h('button.btn.sm.ghost.danger', { onclick: (e) => confirm(`Delete the active contacts of "${l.list}"? People who unsubscribed or bounced are kept so they are never emailed again.`) && act(e.target, async () => { await DEL(`/api/email/lists/${encodeURIComponent(l.list)}`); load(); }) }, 'Delete')))))))
      : h('div.cempty', { style: 'border:0' }, h('b', {}, 'No contacts yet'), h('p', {}, 'Import a CSV with an email column. First name, last name, company, website and title are used to write each email.')));
  }

  function accountForm(a = null) {
    const f = {};
    const inp = (k, v, attrs = {}) => (f[k] = h('input', { type: 'text', value: v ?? '', ...attrs }));
    const presets = h('div.chips');
    const help = h('div.note', {}, 'Choose your email provider to fill in the servers.');
    GET('/api/email/presets').then((p) => set(presets, Object.entries(p).map(([k, x]) => h('button.chip', { type: 'button', onclick: () => {
      f.smtp_host.value = x.smtp_host; f.smtp_port.value = x.smtp_port; f.smtp_secure.checked = !!x.smtp_secure; f.imap_host.value = x.imap_host; f.imap_port.value = x.imap_port; set(help, x.help);
    } }, x.label)))).catch(() => {});
    f.smtp_secure = h('input', { type: 'checkbox', checked: a ? !!a.smtp_secure : true });
    f.warmup = h('input', { type: 'checkbox', checked: a ? !!a.warmup : true });
    modal(a ? `Edit ${a.from_email}` : 'Add a sending mailbox', [
      presets, help,
      h('div.grid2', {}, field('Your name (shown as sender)', inp('from_name', a?.from_name, { placeholder: 'First and last name' })), field('Email address', inp('from_email', a?.from_email, { placeholder: 'you@yourdomain.com' }))),
      h('div.grid3', {}, field('SMTP server', inp('smtp_host', a?.smtp_host)), field('Port', inp('smtp_port', a?.smtp_port ?? 465, { type: 'number' })), h('label.row', { style: 'align-self:end;padding-bottom:10px' }, f.smtp_secure, h('span', {}, 'SSL (port 465)'))),
      h('div.grid2', {}, field('Login (usually the email)', inp('smtp_user', a?.smtp_user)), field('Password or app password', inp('smtp_pass', '', { type: 'password', placeholder: a ? 'Leave empty to keep' : '' }))),
      h('div.grid2', {}, field('IMAP server (to see replies)', inp('imap_host', a?.imap_host)), field('IMAP port', inp('imap_port', a?.imap_port ?? 993, { type: 'number' }))),
      field('Footer: business name and address', inp('footer', a?.footer, { placeholder: 'Business name, street, city, country' }), 'Shown under every email. The law in most countries asks for it, and it helps deliverability.'),
      h('div.grid2', {}, field('Most emails per day', inp('daily_limit', a?.daily_limit ?? 40, { type: 'number', min: 1 }), 'Start low: 30 to 50 for a mailbox; more only after weeks of good replies.'), h('label.row', { style: 'align-self:end;padding-bottom:10px' }, f.warmup, h('span', {}, 'Warm up slowly (recommended)'))),
    ], (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
      const body = Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : i.value]));
      if (a) await PATCH(`/api/email/accounts/${a.id}`, body); else await POST('/api/email/accounts', body);
      close(); load(); toast('Saved. Press Test to check it can send.');
    }) }, 'Save')]);
  }

  async function domainCheck(address) {
    const sel = h('input', { type: 'text', placeholder: 'DKIM selector, if you know it' });
    const out = h('div.stack', {}, h('div.muted', {}, 'Checking…'));
    const run = async () => {
      const r = await GET(`/api/email/check?email=${encodeURIComponent(address)}&selector=${encodeURIComponent(sel.value)}`);
      set(out, h('div.stack', { style: 'gap:8px' },
        r.checks.map((c) => h('div.echeck', {}, h(`span.pill.${c.ok ? 'ok' : 'bad'}`, {}, c.ok ? '✓' : '✕', ` ${c.name}`), h('span', { style: 'overflow-wrap:anywhere' }, c.detail))),
        h(`div.note${r.score === 4 ? '' : '.warn'}`, {}, r.advice)));
    };
    modal(`Deliverability: ${address.split('@')[1]}`, [out, h('div.row', {}, sel, h('button.btn.sm', { onclick: (e) => act(e.target, run) }, 'Check again'))]);
    run().catch((e) => set(out, h('div.note.bad', {}, e.message)));
  }

  function importList() {
    const name = h('input', { type: 'text', placeholder: 'For example: the market and the month' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv' });
    modal('Import contacts', [field('List name', name), field('CSV file', file, 'Columns: email, first_name, last_name, company, website, title. A row with only a website is fine: the agent finds the address on the site. Other columns are kept and used for writing.'),
      h('div.note', {}, 'Only import people it is fair to email: business addresses relevant to what you offer. Anyone who ever unsubscribed or bounced is skipped automatically.')],
    (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
      if (!file.files[0]) throw new Error('Choose a CSV file');
      const res = await fetch(`/api/email/lists/import?list=${encodeURIComponent(name.value)}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file.files[0] });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `Import failed (${res.status})`);
      close(); load();
      toast(`${j.added} added, ${j.updated} updated${j.invalid ? `, ${j.invalid} not valid` : ''}${j.suppressed ? `, ${j.suppressed} skipped (unsubscribed or bounced before)` : ''}${j.noEmail ? `, ${j.noEmail} without an address: looking on their websites` : ''}. Addresses are being checked.`);
    }) }, 'Import')]);
  }

  const KIND = { interested: ['Interested', 'ok'], question: ['Question', 'hot'], not_now: ['Later', 'warn'], out_of_office: ['Away', ''], not_interested: ['Not interested', ''], unsubscribe: ['Unsubscribed', 'bad'], wrong_person: ['Wrong person', ''], other: ['Reply', ''] };
  async function loadReplies() {
    const rows = await GET(`/api/email/replies${showAll ? '?all=1' : ''}`).catch(() => []);
    set(replyBox, rows.length ? rows.map((r) => {
      const [label, tone] = KIND[r.kind] || ['Reading…', ''];
      const draft = h('textarea', { rows: 5, dir: 'auto', value: r.draft || '', placeholder: r.kind ? 'Write your answer' : 'The agent is reading this reply…' });
      return h(`div.ereply${r.status !== 'new' ? '.done' : ''}`, {},
        h('div.ereply-top', {}, h('b', {}, [r.first_name, r.last_name].filter(Boolean).join(' ') || r.from_email), h('span.muted', {}, [r.company, [r.first_name, r.last_name].some(Boolean) ? r.from_email : null, r.campaign].filter(Boolean).join(' · ')), h(`span.pill.${tone}`, {}, label), h('time.muted', {}, /^\d/.test(rel(r.created_at)) ? `${rel(r.created_at)} ago` : 'just now')),
        r.summary ? h('div', { style: 'color:var(--ink)' }, r.summary) : null,
        h('details', {}, h('summary.muted', { style: 'cursor:pointer;font-size:12.5px' }, 'Their email'), h('div.cmsg-text', { dir: 'auto', style: 'margin-top:6px' }, r.text || '(no text)')),
        r.resume_at ? h('div.muted', { style: 'font-size:12.5px' }, `Next email on ${new Date(r.resume_at).toLocaleDateString()}`) : null,
        r.status === 'new' && ['interested', 'question', 'other', null].includes(r.kind) ? [draft, h('div.row.wrap', {},
          h('button.btn.sm.primary', { onclick: (e) => act(e.target, async () => { await POST(`/api/email/replies/${r.id}/send`, { text: draft.value }); loadReplies(); }, 'Answer sent') }, ico('send', 'sm'), 'Send answer'),
          h('button.btn.sm', { onclick: (e) => act(e.target, async () => { await PATCH(`/api/email/replies/${r.id}`, { draft: draft.value }); }, 'Draft saved') }, 'Save draft'),
          h('button.btn.sm.ghost', { onclick: (e) => act(e.target, async () => { await PATCH(`/api/email/replies/${r.id}`, { status: 'done' }); loadReplies(); }) }, 'Mark done'),
          r.phone ? h('a.btn.sm', { href: `https://wa.me/${r.phone}`, target: '_blank', rel: 'noopener' }, ico('message-circle', 'sm'), `WhatsApp ${r.phone}`) : null)] : null);
    }) : h('div.cempty', { style: 'border:0' }, h('b', {}, showAll ? 'No replies yet' : 'Nothing to answer'), h('p', {}, 'Replies arrive here when a mailbox has IMAP set up. Each is read, sorted and given a drafted answer.')));
  }
  live.on('email', () => { load(); loadReplies(); });
  load();
  loadReplies();
  return el;
}

/** The email part of the new-campaign wizard: mailboxes, list, the sequence, pace. */
export async function emailWizardData() {
  const [accounts, lists] = await Promise.all([GET('/api/email/accounts').catch(() => []), GET('/api/email/lists').catch(() => [])]);
  return { accounts, lists };
}
export { select };
