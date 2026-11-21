// Campaigns: the centre of the dashboard. Campaign cards, a step-by-step "new campaign" wizard, and a page per
// campaign: hero header, how it works, switches, people, messages, full settings (instructions, files, format),
// log and history. Everything here can also be done from Command ("campaign 5 ...").
import { h, set, ico, GET, POST, PATCH, DEL, act, toast, modal, field, toggle, select, rel, num, stagePill, leadPill } from './ui.js';
import { S, live } from './state.js';
import { emailWizardData } from './pages-email.js';

// ---------- look ----------
const TYPES = {
  auto: { label: 'Always on', tone: 'auto', icon: 'radio-tower', title: 'Always on, for new leads', hint: 'New leads join by the ad they came from, words in their first message, a label or a number. It answers them with its own instructions and follows up on its own hours.', best: 'Ads and inbound leads' },
  batch: { label: 'One-time', tone: 'once', icon: 'send', title: 'One-time, to people in your chats', hint: 'Pick people already in your chats by period, product, stage or tag. Each one gets a personal message, spaced out.', best: 'Offers, reminders, win-backs' },
  scheduled: { label: 'Scheduled', tone: 'sched', icon: 'calendar-clock', title: 'Scheduled', hint: 'Repeats an instruction on a schedule.', best: 'Daily reports' },
  analysis: { label: 'Reading', tone: 'read', icon: 'book-open', title: 'Reading', hint: 'Reads chats and learns from them.', best: 'Learning' },
  email: { label: 'Email', tone: 'email', icon: 'mail', title: 'Email campaign', hint: 'Personal cold or follow-up emails from your own mailbox: a sequence in one thread, warm-up, office hours, unsubscribe, stops on reply.', best: 'Cold outreach to business emails' },
};
const STATUS = { active: ['Running', 'hot'], paused: ['Paused', 'warn'], done: ['Done', 'ok'], failed: ['Failed', 'bad'] };
const typeOf = (t) => TYPES[t.kind] || TYPES.scheduled;
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (x) => (x % 24 === 0 ? `${x / 24} day${x === 24 ? '' : 's'}` : `${x} h`);
const pill = (t) => { const [l, tone] = STATUS[t.status] || [t.status, '']; return h(`span.pill.${tone}`, {}, t.status === 'active' ? h('i.dia.hot.live') : null, l); };
const badge = (kind, big = false) => { const ty = TYPES[kind] || TYPES.scheduled; return h(`span.cicon.${ty.tone}${big ? '.big' : ''}`, { 'aria-hidden': 'true' }, ico(ty.icon)); };
const accountName = (id) => S.accounts.find((a) => a.id === Number(id))?.name || `Number ${id}`;
const metric = (n, label) => h('div.cmetric', {}, h('b', {}, typeof n === 'number' ? num(n) : n ?? '0'), h('span', {}, label));

/** Numbers and one line that say where a campaign is. */
function stateOf(t) {
  const p = t.progress || {};
  const s = t.stats || {};
  if (t.kind === 'email') return { metrics: [[s.members, 'Contacts'], [s.sent, 'Emails sent'], [s.replied, 'Replied']], pct: s.sent + s.waiting ? (s.sent / (s.sent + s.waiting)) * 100 : t.status === 'done' ? 100 : 0, line: `${s.waiting ? `${num(s.waiting)} to go` : 'All sent'}${s.bounced ? ` · ${num(s.bounced)} bounced` : ''}${s.unsubscribed ? ` · ${num(s.unsubscribed)} unsubscribed` : ''}` };
  if (t.kind === 'auto') return { metrics: [[s.members, 'People'], [s.sent, 'Follow-ups'], [s.bought, 'Bought']], pct: null, line: s.sent ? `${Math.round(((s.replied || 0) / s.sent) * 100)}% replied after a follow-up` : 'Waiting for its first follow-up' };
  if (t.kind === 'batch') {
    const total = (p.sent || 0) + (p.queued || 0);
    if (p.reading) return { metrics: [[p.reading.total, 'People'], [p.sent || 0, 'Sent'], [p.queued || 0, 'To go']], pct: p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0, line: `Writing messages: ${num(p.reading.done)} of ${num(p.reading.total)}` };
    return { metrics: [[total + (p.drafts || 0), 'People'], [p.sent || 0, 'Sent'], [p.queued || 0, 'To go']], pct: total ? (p.sent / total) * 100 : t.status === 'done' ? 100 : 0, line: t.waiting ? 'Not sending right now: open it to see why' : p.drafts ? `${num(p.drafts)} wait for your OK` : total ? `${num(p.sent)} of ${num(total)} sent` : t.last_result || 'Nothing to send' };
  }
  if (t.kind === 'analysis' && p.reading) return { metrics: [[p.reading.total, 'Chats'], [p.reading.done, 'Read']], pct: p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0, line: 'Reading chats' };
  return { metrics: [[t.last_run_at ? `${rel(t.last_run_at)} ago` : 'Not yet', 'Last run'], [t.status === 'active' && t.next_run_at ? when(t.next_run_at) : '—', 'Next run']], pct: null, line: t.scheduleText };
}

// ============================== list ==============================
export function campaigns(arg) {
  if (arg && /^\d+$/.test(arg)) return campaignPage(Number(arg));
  const box = h('div');
  const filterBar = h('div.cfilter');
  let filter = 'all';
  let last = [];
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Campaigns'), h('p', {}, 'Every campaign has its own numbers, people, instructions, files, switches and results. Open one to manage it.')),
      h('button.btn.primary', { onclick: () => wizard() }, '+ New campaign')),
    filterBar, box);

  const draw = (list) => {
    last = list;
    const shown = list.filter((t) => ['active', 'paused', 'done', 'failed'].includes(t.status));
    const counts = { all: shown.length, running: shown.filter((t) => t.status === 'active').length, auto: shown.filter((t) => t.kind === 'auto').length, batch: shown.filter((t) => t.kind === 'batch').length, email: shown.filter((t) => t.kind === 'email').length, done: shown.filter((t) => ['done', 'failed'].includes(t.status)).length };
    set(filterBar, [['all', 'All'], ['running', 'Running'], ['auto', 'Always on'], ['batch', 'One-time'], ['email', 'Email'], ['done', 'Finished']].map(([k, l]) =>
      h(`button${filter === k ? '.on' : ''}`, { onclick: () => { filter = k; draw(last); } }, l, h('span', {}, counts[k]))));
    const pick = shown.filter((t) => filter === 'all' || (filter === 'running' ? t.status === 'active' : filter === 'done' ? ['done', 'failed'].includes(t.status) : t.kind === filter && !['done', 'failed'].includes(t.status)));
    if (!pick.length) {
      return set(box, h('div.cempty', {}, badge('auto', true), h('b', {}, shown.length ? 'Nothing here' : 'Start your first campaign'),
        h('p', {}, 'An always-on campaign for your ad leads, or a one-time message to people already in your chats.'), h('button.btn.primary', { onclick: () => wizard() }, '+ New campaign')));
    }
    const order = (t) => (t.status === 'active' ? 0 : t.status === 'paused' ? 1 : 2) * 10 + (t.kind === 'auto' ? 0 : 1);
    set(box, h('div.camp-grid', {}, pick.sort((a, b) => order(a) - order(b) || b.id - a.id).map(card)));
  };

  function card(t) {
    const ty = typeOf(t);
    const st = stateOf(t);
    const c = t.config || {};
    let pp = {};
    try { pp = typeof t.params === 'string' ? JSON.parse(t.params || '{}') || {} : t.params || {}; } catch { /* none */ }
    const nums_ = t.kind === 'email' ? `${(pp.lists || []).join(', ') || 'Email'} · ${(pp.steps || []).length} email${(pp.steps || []).length === 1 ? '' : 's'}` : c.accountIds?.length ? c.accountIds.map(accountName).join(', ') : (pp.accountIds || []).length ? pp.accountIds.map(accountName).join(', ') : 'All numbers';
    return h(`a.ccard.${ty.tone}`, { href: `#/campaigns/${t.id}` },
      h('div.ccard-top', {}, badge(t.kind), h('div.grow', {}, h('div.ctype', {}, `${ty.label}${c.isDefault ? ' · default' : ''}`), h('div.cid', {}, `#${t.id}`)), pill(t)),
      h('b.ccard-title', { dir: 'auto', title: t.title }, t.title),
      h('div.ccard-meta', {}, h('span', {}, ico(t.kind === 'email' ? 'mail' : 'smartphone', 'sm'), nums_), c.label ? h('span', {}, ico('tag', 'sm'), c.label) : null),
      h('div.cmetrics', {}, st.metrics.map(([n, l]) => metric(n, l))),
      st.pct != null ? h('div.cprog', {}, h('i', { style: `width:${Math.round(st.pct)}%` })) : null,
      h('div.ccard-foot', {}, h('span', {}, st.line), h('span.copen', {}, 'Open →')));
  }

  const load = () => GET('/api/tasks').then(draw).catch((e) => toast(e.message, true));
  for (const ty of ['tasks', 'followups', 'campaign']) live.on(ty, load);
  load();
  return el;
}

// ============================== one campaign ==============================
function campaignPage(id) {
  const hero = h('div');
  const tabsBar = h('div.ctabs', { role: 'tablist' });
  const body = h('div.cbody');
  const el = h('div.page', {}, h('a.cback', { href: '#/campaigns' }, '← All campaigns'), hero, tabsBar, body);
  let tab = 'overview';
  let t = null;

  async function load(redrawBody = true) {
    try { t = await GET(`/api/campaigns/${id}/view`); } catch (e) { return set(body, h('div.note.bad', {}, e.message)); }
    const ty = typeOf(t);
    const c = t.config || {};
    const st = stateOf(t);
    const ctl = (action, label, cls = '') => h(`button.btn${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Remove campaign #${t.id}? Messages it has not sent yet are cancelled; its log and history are kept.`)) && act(e.target, async () => { await PATCH(`/api/tasks/${t.id}`, { action }); if (action === 'remove') location.hash = '#/campaigns'; else load(); }) }, label);
    set(hero, h(`div.chero.${ty.tone}`, {},
      h('div.chero-main', {}, badge(t.kind, true),
        h('div.grow', {}, h('div.ctype', {}, `${ty.label} campaign · #${t.id}${c.isDefault ? ' · default' : ''}`), h('h1', { dir: 'auto' }, t.title),
          h('div.chero-sub', {}, pill(t), h('span', {}, `Created ${when(t.created_at)}`), h('span', {}, `In Command: “campaign ${t.id} …”`))),
        h('div.chero-act', {}, t.status === 'active' ? ctl('pause', 'Pause') : t.status === 'paused' ? ctl('resume', 'Resume', '.primary') : null,
          t.kind === 'scheduled' ? ctl('run', 'Run now') : null, c.isDefault ? null : ctl('remove', 'Remove', '.ghost.danger'))),
      h('div.chero-stats', {}, st.metrics.map(([n, l]) => metric(n, l)), t.stats && ['auto', 'batch'].includes(t.kind) ? metric(t.stats.replied ?? 0, 'Replied') : null, t.kind === 'email' && t.stats ? metric(t.stats.bounced ?? 0, 'Bounced') : null),
      st.pct != null ? h('div.chero-prog', {}, h('div.cprog', {}, h('i', { style: `width:${Math.round(st.pct)}%` })), h('span', {}, `${st.line} · ${Math.round(st.pct)}%`)) : h('div.chero-prog', {}, h('span', {}, st.line))));
    const TABS = [['overview', 'Overview'], ['people', 'People'], ['messages', 'Messages'], ['settings', 'Settings'], ['log', 'Log & history']];
    set(tabsBar, TABS.filter(([k]) => k === 'overview' || k === 'log' || ['auto', 'batch', 'email'].includes(t.kind)).map(([k, label]) => h(`button${tab === k ? '.on' : ''}`, { role: 'tab', 'aria-selected': tab === k, onclick: () => { tab = k; load(); } }, label)));
    if (redrawBody) ({ overview, people, messages, settings: settingsTab, log: logTab }[tab])();
  }

  function overview() {
    const c = t.config || {};
    const p = t.params || {};
    const step = (n, title, lines) => h('div.cstep', {}, h('div.cstep-n', {}, n), h('div', {}, h('b', {}, title), lines.filter(Boolean).map((l) => h('div', { dir: 'auto' }, l))));
    const flow = t.kind === 'email' ? [
      step(1, 'Who', [`Contacts of ${(p.lists || []).join(', ')}`, 'Skips anyone who ever unsubscribed or bounced']),
      step(2, 'Emails', (p.steps || []).map((x, i) => `${i ? `After ${x.days} day${x.days === 1 ? '' : 's'}: ` : 'First: '}${(x.instruction || x.body || '').slice(0, 90)}`)),
      step(3, 'Pace', [`${p.gapMin}–${p.gapMax} min between emails`, `${p.window?.[0] ?? 9}:00–${p.window?.[1] ?? 17}:00${p.weekdays ? ', weekdays' : ''}`, 'Daily cap and warm-up per mailbox']),
      step(4, 'Stops', ['On reply (with IMAP), bounce or unsubscribe', p.mode === 'template' ? 'Your template, filled per contact' : 'Each email written by AI for that person']),
    ] : t.kind === 'auto' ? [
      step(1, 'Who joins', [c.isDefault ? 'Every new lead that no other campaign takes' : [c.labels?.length && `Chat has the label: ${c.labels.join(', ')}`, c.keywords?.length && `First message has: ${c.keywords.join(', ')}`, c.adText?.length && `Came from an ad titled: ${c.adText.join(', ')}`, c.adIds?.length && `Ad ID: ${c.adIds.join(', ')}`].filter(Boolean).join(' · ') || 'Only people you add', `On: ${c.accountIds?.length ? c.accountIds.map(accountName).join(', ') : 'all numbers'}`]),
      step(2, 'First reply', [c.autoReply === false ? 'You answer; the agent stays quiet' : 'The agent answers by itself', c.instructions ? `Using: ${c.instructions.slice(0, 140)}${c.instructions.length > 140 ? '…' : ''}` : 'Using your Knowledge', (t.params?.files || []).length ? `+ ${(t.params.files).length} campaign file(s)` : null]),
      step(3, 'Follow-ups', [c.followups === false ? 'Off' : `After ${(c.steps || []).map(dur).join(', ')} of silence`, c.followups === false ? null : `${Math.round(c.gapMin)}–${Math.round(c.gapMax)} min apart, ${c.approval ? 'waits for your OK' : 'sent by itself'}, ${c.night ? 'also at night' : 'not at night'}`]),
      step(4, 'Stops and labels', ['Stops for anyone who replies, buys or asks not to be contacted', c.label ? `Puts the WhatsApp label “${c.label}”` : null]),
    ] : t.kind === 'scheduled' ? [
      step(1, 'When', [t.scheduleText, t.next_run_at && t.status === 'active' ? `Next run: ${when(t.next_run_at)}` : null]),
      step(2, 'What it does', [t.instruction]),
      step(3, 'Result', ['Shown below after each run, and sent to you if you asked for it']),
    ] : t.kind === 'analysis' ? [
      step(1, 'Reads', [`Chats from the last ${p.sinceDays || p.days || '?'} days`, t.progress?.reading ? `Now: ${num(t.progress.reading.done)} of ${num(t.progress.reading.total)}` : null]),
      step(2, 'Learns', [t.instruction || 'What customers ask, what works, what to improve']),
      step(3, 'Result', [t.status === 'done' ? 'Finished: see below' : 'Shown below when it finishes']),
    ] : [
      step(1, 'Who', [`Chats from the last ${p.sinceDays || '?'} days`, p.keywords?.length ? `About: ${p.keywords.join(', ')}` : null, p.tags?.length ? `Tag: ${p.tags.join(', ')}` : null, p.stages?.length ? `Stage: ${p.stages.join(', ')}` : null, `On: ${p.accountIds?.length ? p.accountIds.map(accountName).join(', ') : 'all numbers'}`]),
      step(2, 'Message', [t.instruction, p.instructions ? `Also: ${p.instructions.slice(0, 120)}` : null, (p.files || []).length ? `+ ${p.files.length} file(s)` : null]),
      step(3, 'Sending', [Array.isArray(p.intervalMinutes) ? `${p.intervalMinutes[0]}–${p.intervalMinutes[1]} min apart (random)` : p.intervalMinutes ? `${p.intervalMinutes} min apart` : null, p.autoApprove === false ? 'Each waits for your OK' : 'Sent by itself', t.ignore_quiet ? 'Also at night' : 'Not at night']),
      step(4, 'Results', ['Replies show in Inbox; buyers are marked automatically', t.waiting ? `Now: ${t.waiting}` : null]),
    ];
    const sw = (on, key, label, hint, invert = false) => h('label.cswitch', {}, h('div', {}, h('b', {}, label), h('span', {}, hint)),
      toggle(on, (v) => act(null, async () => { await PATCH(`/api/campaigns/${t.id}`, { [key]: invert ? !v : v }); load(); }, `${label}: ${v ? 'on' : 'off'}`), label));
    set(body, h('div.stack', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'How it works')), h('div.cflow', {}, flow)),
      t.kind === 'email' ? h('div.note', {}, 'Pause or resume the whole campaign with the buttons above. Replies, bounces and unsubscribes stop each person’s emails by themselves.') : null,
      ['auto', 'batch'].includes(t.kind) ? h('div.card', {}, h('header', {}, h('h2', {}, 'Switches')), h('div.cswitches', {},
        t.kind === 'auto' ? [
          sw(c.autoReply !== false, 'autoReply', 'Auto reply', 'The agent answers this campaign’s leads.'),
          sw(c.followups !== false, 'followups', 'Follow-ups', 'Nudges people who go quiet.'),
        ] : null,
        sw(t.kind === 'auto' ? !c.approval : p.autoApprove !== false, 'approval', 'Send without asking', 'Off: each message waits on the Approvals page.', true),
        sw(t.kind === 'auto' ? !!c.night : !!t.ignore_quiet, 'night', 'Send at night', 'Off: nothing goes out in quiet hours.'))) : null,
      t.waiting ? h('div.note.warn', {}, h('b', {}, 'Not sending right now. '), t.waiting) : null,
      ['scheduled', 'analysis'].includes(t.kind) && t.last_result ? h('div.card', {}, h('header', {}, h('h2', {}, 'Latest result'), t.last_run_at ? h('span.muted', {}, rel(t.last_run_at), ' ago') : null), h('div', { dir: 'auto', style: 'white-space:pre-wrap;line-height:1.55;padding:14px 18px' }, t.last_result)) : null));
  }

  async function people() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/people`).catch(() => []);
    if (t.kind === 'email') {
      const tone = { active: '', replied: 'ok', unsubscribed: 'warn', bounced: 'bad' };
      return set(body, h('div.card', {}, h('div.rtable', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Contact', 'Company', 'Status', 'Emails sent', 'Next email'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, h('td', {}, h('b', {}, [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email), h('div.muted', { style: 'font-size:11.5px' }, r.email)),
          h('td.n', {}, r.company || '—'), h('td.n', {}, h(`span.pill.${tone[r.status] || ''}`, {}, r.status)), h('td.n', {}, r.last_step || 0), h('td.n', {}, r.next_due ? when(r.next_due) : '—'))) : h('tr', {}, h('td.muted', { colspan: 5 }, 'Nobody yet.')))))));
    }
    const msg = (m) => (!m ? h('span.muted', {}, '—') : m.status === 'sent' ? h('span.pill.ok', {}, `Sent ${when(m.sent_at)}`) : m.status === 'approved' ? h('span.pill.hot', {}, `Goes ${when(m.due_at)}`) : m.status === 'pending' ? h('span.pill.warn', {}, 'Needs your OK') : h('span.pill', {}, m.status));
    const labelIn = h('input', { type: 'text', placeholder: 'Label name' });
    // A sheet with phone, name, tags, notes: updates people already in your chats (and adds them to an always-on campaign).
    const importer = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none', onchange: () => act(null, async () => {
      const file = importer.files[0];
      if (!file) return;
      const res = await fetch(`/api/campaigns/${t.id}/import`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file });
      const j = await res.json().catch(() => ({}));
      importer.value = '';
      if (!res.ok) throw new Error(j.error || `Import failed (${res.status})`);
      toast(`${j.matched} of ${j.rows} matched people in your chats${j.added ? `, ${j.added} joined` : ''}.${j.notInChats ? ` ${j.notInChats} numbers never wrote to you, so they are not messaged on WhatsApp (use an email campaign for cold outreach).` : ''}`);
      people();
    }) });
    const labelBtn = h('button.btn', { onclick: () => act(labelBtn, async () => { const r = await POST(`/api/campaigns/${t.id}/label`, { label: labelIn.value }); toast(`"${r.label}" goes on ${r.chats} chats, one by one.`); }) }, 'Label everyone');
    set(body, h('div.stack', {},
      h('div.card', {}, h('div.pad.row.wrap', { style: 'justify-content:space-between' }, h('span', {}, h('b', {}, num(rows.length)), ' people in this campaign'),
        h('div.row.wrap', {}, labelIn, labelBtn,
          h('a.btn', { href: `/api/campaigns/${t.id}/export.csv`, download: '' }, ico('download', 'sm'), 'Export CSV'),
          h('button.btn', { onclick: () => importer.click() }, ico('upload', 'sm'), 'Import CSV'), importer))),
      h('div.card', {}, h('div.rtable', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Person', 'Stage', 'Last message', 'Their message', t.kind === 'auto' ? 'Next follow-up' : 'Tags'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.length ? rows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/inbox/${r.id}` }, h('b', {}, r.title)), r.ad ? h('div.muted', { style: 'font-size:11.5px' }, `Ad: ${r.ad}`) : null),
          h('td.n', {}, stagePill(r.stage), ' ', leadPill(r.lead)), h('td.n', {}, r.lastAt ? rel(r.lastAt) : '—'), h('td.n', {}, msg(r.message)),
          h('td.n', {}, t.kind === 'auto' ? (r.nextFollowup ? when(r.nextFollowup) : '—') : r.tags.join(', ') || '—'))) : h('tr', {}, h('td.muted', { colspan: 5 }, 'Nobody yet.'))))))));
  }

  async function messages() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/messages`).catch(() => []);
    if (t.kind === 'email') {
      return set(body, rows.length ? h('div.cmsgs', {}, rows.map((m) => h('div.cmsg.mail', {},
        h('div.cmsg-top', {}, h('b', {}, m.email), h('span.muted', {}, `Email ${m.step}${m.from_email ? ` · from ${m.from_email}` : ''}`), h(`span.pill.${m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : ''}`, {}, m.status), h('time', {}, when(m.sent_at || m.due_at))),
        m.subject ? h('div', { style: 'font-weight:600;color:var(--ink)' }, m.subject) : null,
        m.body ? h('div.cmsg-text', { dir: 'auto' }, m.body) : null,
        m.error ? h('div.muted', { style: 'font-size:12px' }, m.error) : null))) : h('div.cempty', {}, h('b', {}, 'No emails yet'), h('p', {}, 'Each email shows here once it is written, before and after it goes out.')));
    }
    const tone = { sent: 'ok', approved: 'hot', pending: 'warn', failed: 'bad', skipped: '' };
    const label = { sent: 'Sent', approved: 'Queued', pending: 'Needs your OK', failed: 'Failed', skipped: 'Skipped' };
    set(body, rows.length ? h('div.cmsgs', {}, rows.map((m) => h('div.cmsg', {},
      h('div.cmsg-top', {}, h('a', { href: `#/inbox/${m.chat_id}` }, h('b', {}, m.who)), h(`span.pill.${tone[m.status] || ''}`, {}, label[m.status] || m.status), h('time', {}, m.status === 'sent' ? when(m.sent_at) : when(m.due_at))),
      h('div.cmsg-text', { dir: 'auto' }, m.text),
      m.error ? h('div.muted', { style: 'font-size:12px' }, m.error) : null))) : h('div.cempty', {}, h('b', {}, 'No messages yet'), h('p', {}, 'Messages this campaign writes show up here before and after they go out.')));
  }

  function settingsTab() { set(body, t.kind === 'email' ? emailSettings(t, () => load()) : settingsForm(t, () => load())); }

  async function logTab() {
    const [steps, changes] = await Promise.all([GET(`/api/tasks/${t.id}/events`).catch(() => []), GET(`/api/campaigns/${t.id}/changes`).catch(() => [])]);
    const show = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v === false ? 'no' : String(v).slice(0, 120));
    set(body, h('div.grid2', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'What it did')), h('div.pad', {}, steps.length ? h('ol.tlog', {}, steps.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.kind), h('span', { dir: 'auto' }, r.text, r.chat_id ? h('a', { href: `#/inbox/${r.chat_id}`, style: 'margin-left:6px' }, 'chat') : null)))) : h('div.muted', {}, 'Nothing yet.'))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Settings history')), h('div.pad', {}, changes.length ? h('ol.tlog', {}, changes.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.source), h('span', { dir: 'auto' }, `${r.field}: ${show(r.before)} → ${show(r.after)}`)))) : h('div.muted', {}, 'No changes yet.')))));
  }

  live.on('tasks', () => { if (tab === 'overview') load(); else load(false); });
  live.on('followups', () => { if (tab === 'overview') load(); });
  load();
  return el;
}

// ---------- settings of one campaign (both kinds) ----------
function settingsForm(t, done) {
  const auto = t.kind === 'auto';
  const c = auto ? t.config || {} : { ...(t.params || {}), approval: (t.params || {}).autoApprove === false, night: !!t.ignore_quiet };
  const files = (t.params || {}).files || [];
  const inp = (v, attrs = {}) => h('input', { type: 'text', value: v ?? '', ...attrs });
  const area = (v, rows, ph) => h('textarea', { rows, dir: 'auto', value: v || '', placeholder: ph });
  const gap = Array.isArray(c.intervalMinutes) ? c.intervalMinutes : [c.gapMin ?? c.intervalMinutes ?? 5, c.gapMax ?? c.intervalMinutes ?? 10];
  const f = {
    name: inp(t.title),
    message: auto ? null : area(t.instruction, 3, 'What each message should say'),
    instructions: area(c.instructions, 4, 'Business rules for this campaign: the offer, prices to mention, what to push, what never to say'),
    format: area(c.format, 4, 'One rule per line, e.g.\nGreeting on its own line\nLink on its own line at the end'),
    followupStyle: area(c.followupStyle, 3, 'An example message in your words. Use ___ for the product and {name} for their name.'),
    gapMin: inp(Math.round(gap[0]), { type: 'number', min: 0 }), gapMax: inp(Math.round(gap[1]), { type: 'number', min: 0 }),
    steps: auto ? inp((c.steps || []).join(', ')) : null,
    keywords: inp((c.keywords || []).join(', ')), adText: inp((c.adText || []).join(', ')), adIds: inp((c.adIds || []).join(', ')), labels: inp((c.labels || []).join(', ')),
    label: inp(c.label || ''), priority: inp(c.priority ?? 100, { type: 'number' }),
    templateFallback: h('input', { type: 'checkbox', checked: c.templateFallback !== false }),
  };
  const numbers = h('div.checks', {}, S.accounts.length ? S.accounts.map((a) => h('label', {}, h('input', { type: 'checkbox', value: a.id, checked: (c.accountIds || []).includes(a.id) }), a.name)) : h('span.muted', {}, 'No number linked yet.'));
  const fileList = h('div.cfiles', {}, files.length ? files.map((x) => h('div.cfile', {}, h('span', {}, ico('file-text', 'sm'), ' ', h('b', {}, x.name), h('span.muted', {}, ` · ${num(x.text.length)} characters`)),
    h('button.btn.sm.ghost.danger', { onclick: (e) => act(e.target, async () => { await DEL(`/api/campaigns/${t.id}/files/${encodeURIComponent(x.name)}`); done(); }, 'File removed') }, 'Remove'))) : h('div.muted', {}, 'No files yet.'));
  const picker = h('input', { type: 'file', multiple: true, accept: '.md,.txt,.docx', style: 'display:none', onchange: () => act(null, async () => {
    for (const file of picker.files) {
      const res = await fetch(`/api/campaigns/${t.id}/files`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${file.name}: ${j.error || res.status}`);
    }
    done();
  }, 'Files added. Every message of this campaign uses them.') });
  const sec = (title, hint, ...kids) => h('div.card.csec', {}, h('header', {}, h('div', {}, h('h2', {}, title), hint ? h('p.muted', {}, hint) : null)), h('div.pad.stack', {}, kids));
  const save = h('button.btn.primary', { onclick: () => act(save, async () => {
    const body = { name: f.name.value, instructions: f.instructions.value, format: f.format.value, followupStyle: f.followupStyle.value, gapMin: Number(f.gapMin.value), gapMax: Number(f.gapMax.value) };
    if (auto) {
      Object.assign(body, { steps: f.steps.value, label: f.label.value, templateFallback: f.templateFallback.checked });
      if (!c.isDefault) Object.assign(body, { keywords: f.keywords.value, adText: f.adText.value, adIds: f.adIds.value, labels: f.labels.value, priority: Number(f.priority.value), accountIds: [...numbers.querySelectorAll('input:checked')].map((i) => Number(i.value)) });
    } else body.instruction = f.message.value;
    const r = await PATCH(`/api/campaigns/${t.id}`, body);
    toast(r.changed?.length ? `Saved: ${r.changed.join('; ')}` : 'Nothing changed');
    done();
  }) }, 'Save changes');
  return h('div.stack', {},
    sec('Name', null, field('Campaign name', f.name)),
    auto && !c.isDefault ? sec('Who joins', 'Any one of these is enough. Leave all empty to take every new lead on the chosen numbers.',
      field('Numbers', numbers, 'None ticked = all numbers.'),
      h('div.grid2', {}, field('Words in their first message', f.keywords, 'Give each ad its own pre-filled message and use a word from it.'), field('Words in the ad title', f.adText)),
      h('div.grid2', {}, field('Meta ad IDs', f.adIds), field('Chat already has the WhatsApp label', f.labels)),
      field('Priority', f.priority, 'Lower wins when two campaigns match.')) : auto ? sec('Who joins', null, h('div.note', {}, 'Default campaign: every new lead that no other campaign takes.')) : null,
    sec('Instructions and files', 'Used in every reply and message of this campaign, on top of your Knowledge. The AI reads them each time, so it never forgets them.',
      auto ? null : field('What each message should say', f.message, 'Changing it rewrites the messages not sent yet.'),
      field('Campaign instructions', f.instructions),
      h('label.f', {}, 'Files with business instructions (.md, .txt, .docx)', h('div.row', {}, h('button.btn', { type: 'button', onclick: () => picker.click() }, 'Upload files'), picker), fileList)),
    sec('Message format', 'How this campaign’s messages are laid out. Empty = your general format from Knowledge.',
      field('Layout rules', f.format), field('Example message', f.followupStyle), auto ? h('label.row', {}, f.templateFallback, h('span', {}, 'When no AI model can write, send this example (name and product filled in)')) : null),
    sec('Timing', null,
      auto ? field('Follow up after (hours)', f.steps, 'One number per follow-up, e.g. 2, 24, 72') : null,
      h('div.grid2', {}, field('Gap between messages, min (minutes)', f.gapMin), field('Gap max (minutes)', f.gapMax))),
    auto ? sec('Labels', null, field('Put this WhatsApp label on each lead', f.label, 'WhatsApp Business (QR-linked). Made on the phone if missing; your own labels are never removed.')) : null,
    h('div.csave', {}, save, h('span.muted', {}, 'Every change is kept in Log & history.')));
}

function emailSettings(t, done) {
  const p = t.params || {};
  const inp = (v, attrs = {}) => h('input', { type: 'text', value: v ?? '', ...attrs });
  const name = inp(t.title), instructions = h('textarea', { rows: 4, dir: 'auto', value: p.instructions || '' });
  const gapMin = inp(p.gapMin, { type: 'number', min: 1 }), gapMax = inp(p.gapMax, { type: 'number', min: 1 });
  const ws = inp(p.window?.[0] ?? 9, { type: 'number', min: 0, max: 23 }), we = inp(p.window?.[1] ?? 17, { type: 'number', min: 1, max: 24 });
  const weekdays = h('input', { type: 'checkbox', checked: p.weekdays !== false });
  const steps = (p.steps || []).map((x, i) => ({ days: inp(x.days, { type: 'number', min: 1 }), instruction: h('textarea', { rows: 3, dir: 'auto', value: x.instruction || x.body || '' }), i }));
  const save = h('button.btn.primary', { onclick: () => act(save, async () => {
    const r = await PATCH(`/api/campaigns/${t.id}`, { name: name.value, instructions: instructions.value, gapMin: Number(gapMin.value), gapMax: Number(gapMax.value), windowStart: Number(ws.value), windowEnd: Number(we.value), weekdays: weekdays.checked, steps: steps.map((x) => ({ days: Number(x.days.value), instruction: x.instruction.value })) });
    toast(r.changed?.length ? 'Saved. Emails not written yet use it.' : 'Nothing changed'); done();
  }) }, 'Save changes');
  return h('div.stack', {},
    h('div.card.csec', {}, h('header', {}, h('h2', {}, 'Name and instructions')), h('div.pad.stack', {}, field('Campaign name', name), field('Campaign instructions', instructions, 'Who you are, what you offer them, the one link, what never to claim.'))),
    h('div.card.csec', {}, h('header', {}, h('h2', {}, 'The emails')), h('div.pad.stack', {}, steps.map((x) => h('div.estep', {}, h('b', {}, x.i ? `Email ${x.i + 1}` : 'Email 1'), x.i ? field('Days after the previous one', x.days) : null, field('What it should say', x.instruction))))),
    h('div.card.csec', {}, h('header', {}, h('h2', {}, 'Pace')), h('div.pad.stack', {}, h('div.grid2', {}, field('Gap min (minutes)', gapMin), field('Gap max (minutes)', gapMax)),
      h('div.grid2', {}, field('Send from (hour)', ws), field('Until (hour)', we)), h('label.row', {}, weekdays, h('span', {}, 'Weekdays only')))),
    h('div.csave', {}, save, h('span.muted', {}, 'Every change is kept in Log & history.')));
}

// ============================== new campaign wizard ==============================
function wizard() {
  const st = { emailAccounts: [], lists: [], mode: 'ai', seq: [{ days: 0, instruction: '' }, { days: 3, instruction: '' }], windowStart: 9, windowEnd: 17, weekdays: true, emailIds: [], list: '', type: 'auto', accountIds: [], keywords: '', adText: '', labels: '', days: 7, products: '', stages: [], tags: '', name: '', instruction: '', instructions: '', steps: '2, 24, 72', gapMin: 5, gapMax: 10, startIn: 0, autoReply: true, followups: true, send: true, night: false, label: '' };
  let step = 0;
  const stepsBox = h('div.wsteps');
  const body = h('div.stack.wbody');
  const foot = h('div.row', { style: 'justify-content:space-between;width:100%' });
  const STEPS = ['Type', 'Numbers', 'Who', 'Message', 'Review'];
  const inp = (key, attrs = {}) => h('input', { type: 'text', value: st[key], oninput: (e) => { st[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; }, ...attrs });
  const area = (key, rows, ph) => h('textarea', { rows, dir: 'auto', value: st[key], placeholder: ph, oninput: (e) => { st[key] = e.target.value; } });
  const chk = (key, label, hint) => h('label.cswitch', {}, h('div', {}, h('b', {}, label), hint ? h('span', {}, hint) : null), h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => { st[key] = e.target.checked; } }));

  // Email campaigns have their own steps: mailboxes, list, the emails, review.
  const EMAIL = [
    () => h('div.wtypes', {}, ['auto', 'batch', 'email'].map((k) => { const ty = TYPES[k]; return h(`button.wtype.${ty.tone}${st.type === k ? '.on' : ''}`, { type: 'button', onclick: () => { st.type = k; draw(); } }, badge(k, true), h('div', {}, h('b', {}, ty.title), h('span', {}, ty.hint), h('em', {}, `Best for: ${ty.best}`)), st.type === k ? h('i.wcheck', {}, '✓') : null); })),
    () => st.emailAccounts.length ? h('div.stack', {}, h('p.muted', { style: 'margin:0' }, 'Which mailboxes send it? Several are used in turn, each within its own daily limit.'),
      h('div.wnums', {}, st.emailAccounts.map((a) => h('label.wnum', {}, h('input', { type: 'checkbox', checked: st.emailIds.includes(a.id), onchange: (e) => { st.emailIds = e.target.checked ? [...st.emailIds, a.id] : st.emailIds.filter((x) => x !== a.id); } }),
        h('div', {}, h('b', {}, a.from_email), h('span', {}, `${a.limitToday} a day now`), h('span', {}, a.last_error ? '✕ Last send failed' : '● Ready'))))))
      : h('div.note.warn', {}, 'No mailbox yet. Add one on the Email page, then come back.', h('div', { style: 'margin-top:8px' }, h('a.btn.sm', { href: '#/email' }, 'Open Email'))),
    () => st.lists.length ? h('div.stack', {}, h('p.muted', { style: 'margin:0' }, 'Which list do you email?'), h('div.wnums', {}, st.lists.map((l) => h('label.wnum', {}, h('input', { type: 'radio', name: 'wlist', checked: st.list === l.list, onchange: () => { st.list = l.list; } }), h('div', {}, h('b', {}, l.list), h('span', {}, `${num(l.active)} active contacts`))))))
      : h('div.note.warn', {}, 'No contacts yet. Import a CSV on the Email page.', h('div', { style: 'margin-top:8px' }, h('a.btn.sm', { href: '#/email' }, 'Open Email'))),
    () => h('div.stack', {},
      field('Name', inp('name', { placeholder: 'For example: the audience and the month' })),
      field('Campaign instructions', area('instructions', 3, 'Who you are, what you offer these people, the one link to use, what never to claim')),
      ...st.seq.map((x, i) => h('div.estep', {}, h('div.row', { style: 'justify-content:space-between' }, h('b', {}, `Email ${i + 1}`), i > 1 ? h('button.btn.sm.ghost', { type: 'button', onclick: () => { st.seq.splice(i, 1); draw(); } }, 'Remove') : null),
        i ? field('Days after the previous one', h('input', { type: 'number', min: 1, value: x.days, oninput: (e) => { x.days = Number(e.target.value); } })) : null,
        field(i ? 'What this follow-up should say' : 'What the first email should say', h('textarea', { rows: 2, dir: 'auto', value: x.instruction, placeholder: i ? 'A short nudge with one new reason to reply' : 'Introduce one thing that helps them, then ask one easy question', oninput: (e) => { x.instruction = e.target.value; } })))),
      st.seq.length < 5 ? h('button.btn.sm', { type: 'button', onclick: () => { st.seq.push({ days: 4, instruction: '' }); draw(); } }, '+ Add a follow-up') : null,
      h('div.grid3', {}, field('Gap min (min)', inp('gapMin', { type: 'number', min: 1 })), field('Gap max (min)', inp('gapMax', { type: 'number', min: 1 })), field('Writing', select([['ai', 'AI writes each one'], ['template', 'My text, filled per contact']], st.mode, (v) => { st.mode = v; }))),
      h('div.grid3', {}, field('Send from (hour)', inp('windowStart', { type: 'number', min: 0, max: 23 })), field('Until (hour)', inp('windowEnd', { type: 'number', min: 1, max: 24 })), h('label.row', { style: 'align-self:end;padding-bottom:10px' }, h('input', { type: 'checkbox', checked: st.weekdays, onchange: (e) => { st.weekdays = e.target.checked; } }), h('span', {}, 'Weekdays only'))),
      h('p.muted', { style: 'margin:0;font-size:12.5px' }, 'With “My text”, use {first_name}, {company} and {Hi|Hello} style choices so no two emails are the same.')),
    () => h('div.wreview', {}, [['Type', 'Email campaign'], ['Mailboxes', st.emailAccounts.filter((a) => st.emailIds.includes(a.id)).map((a) => a.from_email).join(', ') || '—'], ['List', st.list || '—'],
      ['Emails', st.seq.filter((x) => x.instruction).map((x, i) => (i ? `+${x.days}d` : 'Day 0')).join(' → ')], ['Pace', `${st.gapMin}–${st.gapMax} min apart, ${st.windowStart}:00–${st.windowEnd}:00${st.weekdays ? ', weekdays' : ''}`], ['Writing', st.mode === 'ai' ? 'AI, for each person' : 'Your text, filled per contact']]
      .map(([k, v]) => h('div.kv', {}, k, h('b', { dir: 'auto' }, v)))),
  ];
  emailWizardData().then((d) => { st.emailAccounts = d.accounts; st.lists = d.lists; st.emailIds = d.accounts.length === 1 ? [d.accounts[0].id] : st.emailIds; if (d.lists.length === 1) st.list = d.lists[0].list; if (st.type === 'email') draw(); });

  const pages = [
    () => h('div.wtypes', {}, ['auto', 'batch', 'email'].map((k) => {
      const ty = TYPES[k];
      return h(`button.wtype.${ty.tone}${st.type === k ? '.on' : ''}`, { type: 'button', onclick: () => { st.type = k; draw(); } },
        badge(k, true), h('div', {}, h('b', {}, ty.title), h('span', {}, ty.hint), h('em', {}, `Best for: ${ty.best}`)), st.type === k ? h('i.wcheck', {}, '✓') : null);
    })),
    () => S.accounts.length ? h('div.stack', {}, h('p.muted', { style: 'margin:0' }, 'Which WhatsApp numbers does it use? None ticked = all numbers.'),
      h('div.wnums', {}, S.accounts.map((a) => h('label.wnum', {}, h('input', { type: 'checkbox', checked: st.accountIds.includes(a.id), onchange: (e) => { st.accountIds = e.target.checked ? [...st.accountIds, a.id] : st.accountIds.filter((x) => x !== a.id); } }),
        h('div', {}, h('b', {}, a.name), h('span', {}, a.status?.me ? `+${a.status.me}` : a.type === 'cloud' ? 'Cloud API' : 'QR'), h('span', {}, a.status?.state === 'connected' ? '● Connected' : '○ Not connected'))))))
      : h('div.note.warn', {}, 'No WhatsApp number is linked yet. Link one on the Numbers page; the campaign will use it.'),
    () => st.type === 'auto' ? h('div.stack', {},
      h('p.muted', { style: 'margin:0' }, 'A new lead joins when any one of these matches. Leave all empty to take every new lead on the chosen numbers.'),
      field('Words in their first message', inp('keywords', { placeholder: 'words from your ad’s pre-filled message' }), 'Tip: give each ad its own pre-filled message, then put one of its words here.'),
      h('div.grid2', {}, field('Words in the ad title', inp('adText', { placeholder: 'a word from the ad title' })), field('Chat has the WhatsApp label', inp('labels', { placeholder: 'label name' }))))
      : h('div.stack', {},
        h('div.grid2', {}, field('Chats from the last (days)', inp('days', { type: 'number', min: 1 })), field('About these products or words', inp('products', { placeholder: 'product names, comma separated' }), 'Found in their messages, summary or customer card.')),
        h('div.grid2', {}, field('Stage', select([['', 'Everyone except buyers'], ['interested', 'Interested or negotiating'], ['purchased', 'Bought (reminders)']], st.stages[0] || '', (v) => { st.stages = v === 'interested' ? ['interested', 'negotiating'] : v ? [v] : []; })),
          field('Tag', inp('tags', { placeholder: 'tag name' })))),
    () => h('div.stack', {},
      field('Name', inp('name', { placeholder: st.type === 'auto' ? 'For example: the ad or offer it is for' : 'For example: the offer and the month' })),
      st.type === 'auto'
        ? field('How to answer these leads', area('instructions', 3, 'The offer, what to explain, which link to send, what never to promise'))
        : field('What each message should say', area('instruction', 3, 'For example: remind them of the offer they asked about, with its link')),
      st.type === 'auto' ? h('div.grid3', {}, field('Follow up after (hours)', inp('steps')), field('Gap min (min)', inp('gapMin', { type: 'number', min: 0 })), field('Gap max (min)', inp('gapMax', { type: 'number', min: 0 })))
        : h('div.grid3', {}, field('Start after (minutes)', inp('startIn', { type: 'number', min: 0 })), field('Gap min (min)', inp('gapMin', { type: 'number', min: 1 })), field('Gap max (min)', inp('gapMax', { type: 'number', min: 1 }))),
      h('div.cswitches', {},
        st.type === 'auto' ? [chk('autoReply', 'Auto reply', 'The agent answers them by itself'), chk('followups', 'Follow-ups', 'Nudge them when they go quiet')] : null,
        chk('send', 'Send without asking', 'Off: each message waits for your OK'), chk('night', 'Send at night', 'Off: nothing in quiet hours')),
      st.type === 'auto' ? field('WhatsApp label for these leads (optional)', inp('label', { placeholder: 'label name' })) : null,
      h('p.muted', { style: 'margin:0;font-size:12.5px' }, 'After creating it you can add files with business instructions and its own message format in Settings.')),
    () => h('div.wreview', {},
      [['Type', TYPES[st.type].title], ['Numbers', st.accountIds.length ? st.accountIds.map(accountName).join(', ') : 'All numbers'],
        st.type === 'auto' ? ['Who joins', [st.keywords && `words: ${st.keywords}`, st.adText && `ad: ${st.adText}`, st.labels && `label: ${st.labels}`].filter(Boolean).join(' · ') || 'Every new lead'] : ['Who', `Last ${st.days} days${st.products ? `, about ${st.products}` : ''}${st.tags ? `, tag ${st.tags}` : ''}`],
        ['Message', (st.type === 'auto' ? st.instructions : st.instruction) || '—'],
        st.type === 'auto' ? ['Follow-ups', st.followups ? `after ${st.steps} hours, ${st.gapMin}–${st.gapMax} min apart` : 'off'] : ['Sending', `${st.startIn ? `starts in ${st.startIn} min, ` : ''}${st.gapMin}–${st.gapMax} min apart`],
        ['Approval', st.send ? 'Sent by itself' : 'Each waits for your OK']].map(([k, v]) => h('div.kv', {}, k, h('b', { dir: 'auto' }, v)))),
  ];

  async function create(btn) {
    await act(btn, async () => {
      if (st.type === 'email') {
        const r = await POST('/api/campaigns/email', { name: st.name || `Email: ${st.list}`, accountIds: st.emailIds, lists: [st.list], instructions: st.instructions, mode: st.mode,
          steps: st.seq.filter((x, i) => i === 0 || x.instruction.trim()).map((x) => (st.mode === 'template' ? { days: x.days, body: x.instruction, subject: '' } : { days: x.days, instruction: x.instruction })),
          gapMin: st.gapMin, gapMax: st.gapMax, windowStart: st.windowStart, windowEnd: st.windowEnd, weekdays: st.weekdays });
        m.close(); toast(`Email campaign started for ${r.contacts} contacts.`); location.hash = `#/campaigns/${r.id}`;
        return;
      }
      if (st.type === 'auto') {
        const t = await POST('/api/campaigns', { name: st.name || 'New campaign', accountIds: st.accountIds, keywords: st.keywords, adText: st.adText, labels: st.labels, instructions: st.instructions, steps: st.steps, gapMin: st.gapMin, gapMax: st.gapMax, approval: !st.send, night: st.night, autoReply: st.autoReply, followups: st.followups, label: st.label });
        m.close(); location.hash = `#/campaigns/${t.id}`;
      } else {
        const r = await POST('/api/campaigns/once', { name: st.name || st.instruction.slice(0, 60), accountIds: st.accountIds, days: st.days, keywords: st.products, stages: st.stages, tags: st.tags, instruction: st.instruction, gapMin: st.gapMin, gapMax: st.gapMax, startInMinutes: st.startIn, send: st.send, night: st.night });
        m.close(); toast(`Started: ${r.chats} chats are being read and messaged.`); location.hash = `#/campaigns/${r.id}`;
      }
    });
  }

  function draw() {
    const STEPS = st.type === 'email' ? ['Type', 'Mailboxes', 'List', 'Emails', 'Review'] : ['Type', 'Numbers', 'Who', 'Message', 'Review'];
    const pages_ = st.type === 'email' ? EMAIL : pages;
    set(stepsBox, STEPS.map((s, i) => h(`span${i === step ? '.on' : i < step ? '.done' : ''}`, {}, h('i', {}, i < step ? '✓' : i + 1), s)));
    set(body, pages_[step]());
    const next = step < STEPS.length - 1
      ? h('button.btn.primary', { onclick: () => { if (step === 3 && st.type === 'batch' && !st.instruction.trim()) return toast('Write what each message should say', true); if (st.type === 'email' && step === 1 && !st.emailIds.length) return toast('Choose a mailbox', true); if (st.type === 'email' && step === 2 && !st.list) return toast('Choose a list', true); if (st.type === 'email' && step === 3 && !st.seq[0].instruction.trim()) return toast('Write what the first email should say', true); step++; draw(); } }, 'Next →')
      : h('button.btn.primary', { onclick: (e) => create(e.target) }, st.type === 'auto' ? 'Create campaign' : st.type === 'email' ? 'Start email campaign' : 'Start campaign');
    set(foot, step ? h('button.btn', { onclick: () => { step--; draw(); } }, '← Back') : h('span'), next);
  }
  const m = modal('New campaign', [stepsBox, body], () => [foot]);
  m.el.querySelector('.modal')?.classList.add('wide');
  draw();
}
