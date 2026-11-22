// Campaigns: the centre of the dashboard. Campaign cards, a step-by-step "new campaign" wizard, and a page per
// campaign: hero header, how it works, switches, people, messages, full settings (instructions, files, format),
// log and history. Everything here can also be done from Command ("campaign 5 ...").
import { h, set, ico, GET, POST, PATCH, PUT, DEL, act, toast, modal, field, toggle, select, rel, num, clock, stagePill, leadPill } from './ui.js';
import { S, live } from './state.js';
import { emailWizardData } from './pages-email.js';

// ---------- look ----------
const TYPES = {
  auto: { label: 'Always on', tone: 'auto', icon: 'radio-tower', title: 'Always on, for new leads', hint: 'New leads join by the ad they came from, words in their first message, a label or a number. It answers them with its own instructions and follows up on its own hours.', best: 'Ads and inbound leads' },
  batch: { label: 'One-time', tone: 'once', icon: 'send', title: 'One-time, to people in your chats', hint: 'Pick people already in your chats by period, product, stage or tag. Each one gets a personal message, spaced out.', best: 'Offers, reminders, win-backs' },
  scheduled: { label: 'Scheduled', tone: 'sched', icon: 'calendar-clock', title: 'Scheduled', hint: 'Repeats an instruction on a schedule.', best: 'Daily reports' },
  job: { label: 'Job', tone: 'sched', icon: 'list-checks', title: 'Job', hint: 'Work done for a campaign.', best: '' },
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

// ============================== list (like an ads manager) ==============================
/** The numbers in one row of the table, whatever the campaign type. */
function rowNums(t) {
  const p = t.progress || {};
  const s = t.stats || {};
  if (t.kind === 'auto') return { people: s.members, sent: s.sent, replied: s.replied, bought: s.bought };
  if (t.kind === 'email') return { people: s.members, sent: s.sent, replied: s.replied, bought: null };
  if (t.kind === 'batch') return { people: (p.sent || 0) + (p.queued || 0) + (p.drafts || 0), sent: p.sent || 0, replied: null, bought: null };
  return { people: null, sent: null, replied: null, bought: null };
}

export function campaigns(arg, sub) {
  if (arg && (/^\d+$/.test(arg) || arg === 'default')) return campaignPage(arg, sub);
  const kpis = h('div.kpis');
  const box = h('div');
  const filterBar = h('div.cfilter');
  const search = h('input.csearch', { type: 'search', placeholder: 'Search campaigns', 'aria-label': 'Search campaigns', oninput: () => draw(last) });
  let filter = 'all';
  let last = [];
  const el = h('div.page.wide', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Campaigns'), h('p', {}, 'Each campaign is its own agent: its numbers, knowledge, settings, people and results. Click one to open it.')),
      h('button.btn.primary', { onclick: () => wizard() }, ico('plus', 'sm'), 'Create campaign')),
    kpis, h('div.ctoolbar', {}, filterBar, search), box);

  GET('/api/overview').then((o) => set(kpis, [
    ['user-plus', 'New leads', o.stats.newLeads24h, 'last 24 hours'],
    ['message-square-text', 'Messages in', o.stats.inbound24h, 'last 24 hours'],
    ['bot', 'AI replies', o.stats.aiReplies24h, 'last 24 hours'],
    ['hand', 'Need you', o.stats.needsHuman, 'open the Inbox', '#/inbox'],
    ['badge-check', 'Sales', o.stats.purchased, 'all time'],
  ].map(([i, l, n, hint, href]) => h(href ? 'a.kpi' : 'div.kpi', href ? { href } : {}, h('span.kpi-i', {}, ico(i)), h('div', {}, h('b', {}, num(n || 0)), h('span', {}, l), h('small', {}, hint)))))).catch(() => {});

  const draw = (list) => {
    last = list;
    const q = search.value.trim().toLowerCase();
    const kids = list.filter((t) => t.parent_id).reduce((m, t) => ({ ...m, [t.parent_id]: [...(m[t.parent_id] || []), t] }), {});
    const shown = list.filter((t) => !t.parent_id && ['active', 'paused', 'done', 'failed'].includes(t.status));
    const counts = { all: shown.length, running: shown.filter((t) => t.status === 'active').length, auto: shown.filter((t) => t.kind === 'auto').length, batch: shown.filter((t) => t.kind === 'batch').length, email: shown.filter((t) => t.kind === 'email').length, done: shown.filter((t) => ['done', 'failed'].includes(t.status)).length };
    set(filterBar, [['all', 'All'], ['running', 'Running'], ['auto', 'Always on'], ['batch', 'One-time'], ['email', 'Email'], ['done', 'Finished']].map(([k, l]) =>
      h(`button${filter === k ? '.on' : ''}`, { onclick: () => { filter = k; draw(last); } }, l, h('span', {}, counts[k]))));
    const pick = shown.filter((t) => (filter === 'all' || (filter === 'running' ? t.status === 'active' : filter === 'done' ? ['done', 'failed'].includes(t.status) : t.kind === filter && !['done', 'failed'].includes(t.status)))
      && (!q || `${t.title} #${t.id}`.toLowerCase().includes(q)));
    if (!pick.length) {
      return set(box, h('div.cempty', {}, badge('auto', true), h('b', {}, shown.length ? 'Nothing here' : 'Create your first campaign'),
        h('p', {}, 'An always-on campaign for your ad leads, a one-time message to people already in your chats, or a cold email campaign.'), h('button.btn.primary', { onclick: () => wizard() }, ico('plus', 'sm'), 'Create campaign')));
    }
    const order = (t) => (t.status === 'active' ? 0 : t.status === 'paused' ? 1 : 2) * 10 + (t.kind === 'auto' ? 0 : 1);
    const cell = (v) => (v == null ? h('span.muted', {}, '—') : num(v));
    set(box, h('div.card.ctable-wrap', {}, h('table.ctable', {},
      h('thead', {}, h('tr', {}, ['', 'Campaign', 'Delivery', 'Numbers', 'People', 'Sent', 'Replied', 'Bought', 'Reply rate'].map((x, i) => h(`th${i > 3 ? '.n' : ''}`, {}, x)))),
      h('tbody', {}, pick.sort((a, b) => order(a) - order(b) || b.id - a.id).map((t) => {
        const ty = typeOf(t);
        const c = t.config || {};
        let pp = {};
        try { pp = typeof t.params === 'string' ? JSON.parse(t.params || '{}') || {} : t.params || {}; } catch { /* none */ }
        const n = rowNums(t);
        const st = stateOf(t);
        const where = t.kind === 'email' ? (pp.lists || []).join(', ') || 'Email list' : (c.accountIds?.length ? c.accountIds : pp.accountIds || []).map(accountName).join(', ') || 'All numbers';
        const canSwitch = ['active', 'paused'].includes(t.status);
        const sw = canSwitch ? toggle(t.status === 'active', (on) => act(null, async () => { await PATCH(`/api/tasks/${t.id}`, { action: on ? 'resume' : 'pause' }); load(); }, on ? `#${t.id} on` : `#${t.id} paused`), `Campaign ${t.id} on or off`) : h('span');
        const open = () => { location.hash = `#/campaigns/${t.id}`; };
        return h(`tr.${t.status}`, { onclick: (e) => { if (!e.target.closest('.switch, input, a, button')) open(); } },
          h('td.csw', {}, sw),
          h('td.cname', {}, h('div.cname-in', {}, badge(t.kind), h('div', {}, h('a', { href: `#/campaigns/${t.id}`, dir: 'auto' }, t.title), h('small', {}, `${ty.label}${c.isDefault ? ' · default' : ''} · #${t.id}`, (kids[t.id] || []).filter((k) => k.status === 'active').length ? h('span.ctaskcount', {}, `${(kids[t.id] || []).filter((k) => k.status === 'active').length} running task${(kids[t.id] || []).filter((k) => k.status === 'active').length === 1 ? '' : 's'}`) : null)))),
          h('td.cdel', {}, pill(t), h('small', { dir: 'auto' }, st.line), st.pct != null ? h('div.cprog.thin', {}, h('i', { style: `width:${Math.round(st.pct)}%` })) : null),
          h('td.cnum', {}, h('span', {}, ico(t.kind === 'email' ? 'mail' : 'smartphone', 'sm'), where)),
          h('td.n', {}, cell(n.people)), h('td.n', {}, cell(n.sent)), h('td.n', {}, cell(n.replied)), h('td.n', {}, cell(n.bought)),
          h('td.n', {}, n.sent ? `${Math.round(((n.replied || 0) / n.sent) * 100)}%` : h('span.muted', {}, '—')));
      })))));
  };

  const load = () => GET('/api/tasks').then(draw).catch((e) => toast(e.message, true));
  for (const ty of ['tasks', 'followups', 'campaign']) live.on(ty, load);
  load();
  return el;
}

// ============================== one campaign ==============================
function campaignPage(id, startTab) {
  const hero = h('div');
  const tabsBar = h('div.ctabs', { role: 'tablist' });
  const body = h('div.cbody');
  const el = h('div.page', {}, h('a.cback', { href: '#/campaigns' }, '← All campaigns'), hero, tabsBar, body);
  let tab = startTab || 'overview';
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
    const TABS = [['overview', 'Overview', 'layout-dashboard'], ['tasks', 'Tasks', 'list-checks'], ['knowledge', 'Knowledge', 'book-open-text'], ['settings', 'Settings', 'sliders-horizontal'], ['people', 'People', 'users'], ['messages', 'Messages', 'messages-square'], ['test', 'Test', 'flask-conical'], ['command', 'Command', 'terminal'], ['log', 'Log', 'history']];
    const has = (k) => ['overview', 'command', 'log'].includes(k) || (k === 'tasks' && ['auto', 'batch'].includes(t.kind)) || (['knowledge', 'test'].includes(k) ? ['auto', 'batch'].includes(t.kind) : ['auto', 'batch', 'email'].includes(t.kind));
    if (!has(tab)) tab = 'overview';
    set(tabsBar, TABS.filter(([k]) => has(k)).map(([k, label, icon]) => h(`button${tab === k ? '.on' : ''}`, { role: 'tab', 'aria-selected': tab === k, onclick: () => { tab = k; history.replaceState(null, '', `#/campaigns/${t.id}/${k}`); load(); } }, ico(icon, 'sm'), label)));
    if (redrawBody) ({ overview, tasks: tasksTab, knowledge: knowledgeTab, command: commandTab, people, messages, settings: settingsTab, test: testTab, log: logTab }[tab])();
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
    const liveCard = h('div.card.clive');
    drawLive(liveCard);
    set(body, h('div.stack', {},
      liveCard,
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

  /** A short box at the top of a tab: what it shows, in plain words. */
  const explain = (icon, title, text, ...actions) => h('div.cexplain', {}, h('span.cexplain-i', {}, ico(icon)), h('div.grow', {}, h('b', {}, title), h('p', {}, text)), actions.length ? h('div.row.wrap', {}, actions) : null);

  /** Bring chats that are already in the Inbox into this campaign: pick, see how many, then add. */
  function addExisting() {
    const f = { adText: h('input', { type: 'text', placeholder: 'e.g. google flow' }), keywords: h('input', { type: 'text', placeholder: 'e.g. flow, ultra' }), hours: h('input', { type: 'number', min: 0, placeholder: 'e.g. 5' }), days: h('input', { type: 'number', min: 0, placeholder: 'or days' }), tags: h('input', { type: 'text', placeholder: 'a label or tag' }) };
    const out = h('div');
    const body_ = () => ({ adText: f.adText.value, keywords: f.keywords.value, hours: Number(f.hours.value) || 0, days: Number(f.days.value) || 0, tags: f.tags.value });
    let found = null;
    const check = async () => {
      found = await POST(`/api/campaigns/${t.id}/members`, { ...body_(), dryRun: true });
      set(out, found.error ? h('div.note.bad', {}, found.error) : h('div.note', {}, h('b', {}, `${num(found.chats)} people found`), found.chats ? `: ${found.examples.join(', ')}${found.chats > 5 ? '…' : ''}. Now in: ${Object.entries(found.from).map(([k, n]) => `${k} (${n})`).join(', ')}.` : '. Try other words or a longer period.'));
    };
    modal(`Add people to “${t.title}”`, [
      h('p.muted', {}, 'People already in your chats. They move into this campaign and get its replies, knowledge and follow-ups from now on. Any one filter is enough; together they narrow it down.'),
      h('div.grid2', {}, field('Came from an ad whose title has', f.adText), field('Wrote about', f.keywords)),
      h('div.grid3', {}, field('In the last hours', f.hours), field('In the last days', f.days), field('Has the label', f.tags)),
      out,
    ], (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn', { onclick: (e) => act(e.target, check) }, 'Check how many'),
      h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
        if (!found || found.error) await check();
        if (!found?.chats) return;
        if (!confirm(`Add ${found.chats} people to “${t.title}”?`)) return;
        const r = await POST(`/api/campaigns/${t.id}/members`, body_());
        close(); toast(`${r.added || 0} people added`); load(false); people();
      }) }, 'Add them')]);
  }

  async function people() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/people`).catch(() => []);
    if (t.kind === 'email') {
      const tone = { active: '', replied: 'ok', unsubscribed: 'warn', bounced: 'bad' };
      return set(body, h('div.stack', {}, explain('users', 'Contacts of this email campaign', 'Everyone on its lists, where each one is in the sequence, and when their next email goes. Replies, bounces and unsubscribes stop a person’s emails.'),
        h('div.card', {}, h('div.rtable', {}, h('table', {},
          h('thead', {}, h('tr', {}, ['Contact', 'Company', 'Status', 'Emails sent', 'Next email'].map((x) => h('th', {}, x)))),
          h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, h('td', {}, h('b', {}, [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email), h('div.muted', { style: 'font-size:11.5px' }, r.email)),
            h('td.n', {}, r.company || '—'), h('td.n', {}, h(`span.pill.${tone[r.status] || ''}`, {}, r.status)), h('td.n', {}, r.last_step || 0), h('td.n', {}, r.next_due ? when(r.next_due) : '—'))) : h('tr', {}, h('td.muted', { colspan: 5 }, 'Nobody yet.'))))))));
    }
    const auto = t.kind === 'auto';
    const c = t.config || {};
    const msg = (m) => (!m ? h('span.muted', {}, 'None yet') : m.status === 'sent' ? h('span.pill.ok', {}, `Sent ${when(m.sent_at)}`) : m.status === 'approved' ? h('span.pill.hot', {}, `Goes ${when(m.due_at)}`) : m.status === 'pending' ? h('span.pill.warn', {}, 'Needs your OK') : h('span.pill', {}, m.status));
    const labelIn = h('input', { type: 'text', placeholder: 'An existing WhatsApp label' });
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
    const labelBtn = h('button.btn', { onclick: () => labelIn.value.trim() && confirm(`Put the label “${labelIn.value}” on all ${rows.length} people of this campaign?`) && act(labelBtn, async () => { const r = await POST(`/api/campaigns/${t.id}/label`, { label: labelIn.value }); if (r.error) throw new Error(r.error); toast(`"${r.label}" goes on ${r.chats} chats, one by one.`); }) }, ico('tag', 'sm'), 'Label all');
    const rules = [c.adText?.length && `ad title has “${c.adText.join('”, “')}”`, c.keywords?.length && `first message has “${c.keywords.join('”, “')}”`, c.adIds?.length && 'its Meta ad IDs', c.labels?.length && `label ${c.labels.join(', ')}`].filter(Boolean);
    const intro = auto
      ? explain('users', 'Who is in this campaign', c.isDefault ? 'Every new lead that no other campaign takes. The agent answers them with this campaign’s knowledge and follows up with its timings.' : `New leads join when they first write and ${rules.length ? rules.join(' or ') : '(no Audience rule set yet, so only people you add)'}. Chats from before it was made stay in their old campaign until you add them here.`,
        h('button.btn.primary', { onclick: addExisting }, ico('user-plus', 'sm'), 'Add existing chats'), h('button.btn', { onclick: () => { tab = 'settings'; load(); } }, 'Audience rules'))
      : explain('users', 'Who this campaign wrote to', 'Everyone it read and wrote a message for, with where their message is.');
    set(body, h('div.stack', {}, intro,
      h('div.card', {}, h('div.pad.row.wrap', { style: 'justify-content:space-between' }, h('span', {}, h('b', {}, num(rows.length)), ` ${rows.length === 1 ? 'person' : 'people'}`),
        h('div.row.wrap', {}, labelIn, labelBtn,
          h('a.btn', { href: `/api/campaigns/${t.id}/export.csv`, download: '' }, ico('download', 'sm'), 'Export CSV'),
          h('button.btn', { onclick: () => importer.click() }, ico('upload', 'sm'), 'Import CSV'), importer,
          h('a.btn', { href: `#/inbox/c${t.id}` }, ico('message-square-text', 'sm'), 'Open in Inbox')))),
      rows.length ? h('div.card', {}, h('div.rtable', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Person', 'Stage and score', 'Last activity', 'Message from this campaign', auto ? 'Next follow-up' : 'Labels'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', {}, h('a', { href: `#/inbox/${r.id}` }, h('b', {}, r.title)), r.ad ? h('div.muted', { style: 'font-size:11.5px' }, `Ad: ${r.ad}`) : null),
          h('td.n', {}, stagePill(r.stage), ' ', leadPill(r.lead)), h('td.n', {}, r.lastAt ? `${rel(r.lastAt)} ago` : '—'), h('td.n', {}, msg(r.message)),
          h('td.n', {}, auto ? (r.nextFollowup ? when(r.nextFollowup) : h('span.muted', {}, 'None planned')) : r.tags.join(', ') || '—')))))))
        : h('div.cempty', {}, h('b', {}, 'Nobody in this campaign yet'), h('p', {}, auto ? 'New leads that match its Audience rules appear here as soon as they write. People who wrote before can be added now.' : 'People appear here as the campaign reads chats and writes messages.'),
          auto ? h('button.btn.primary', { onclick: addExisting }, ico('user-plus', 'sm'), 'Add existing chats') : null)));
  }

  async function messages() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/messages`).catch(() => []);
    if (t.kind === 'email') {
      return set(body, h('div.stack', {}, explain('mail', 'Emails of this campaign', 'Every email it writes, before and after it goes out: queued, sent, bounced or failed. Replies arrive in your mailbox.'), rows.length ? h('div.cmsgs', {}, rows.map((m) => h('div.cmsg.mail', {},
        h('div.cmsg-top', {}, h('b', {}, m.email), h('span.muted', {}, `Email ${m.step}${m.from_email ? ` · from ${m.from_email}` : ''}`), h(`span.pill.${m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'bad' : ''}`, {}, m.status), h('time', {}, when(m.sent_at || m.due_at))),
        m.subject ? h('div', { style: 'font-weight:600;color:var(--ink)' }, m.subject) : null,
        m.body ? h('div.cmsg-text', { dir: 'auto' }, m.body) : null,
        m.error ? h('div.muted', { style: 'font-size:12px' }, m.error) : null))) : h('div.cempty', {}, h('b', {}, 'No emails yet'), h('p', {}, 'Each email shows here once it is written.'))));
    }
    const tone = { sent: 'ok', approved: 'hot', pending: 'warn', failed: 'bad', skipped: '' };
    const label = { sent: 'Sent', approved: 'Queued', pending: 'Needs your OK', failed: 'Failed', skipped: 'Skipped' };
    const c = t.config || {};
    const counts = rows.reduce((a, m) => ({ ...a, [m.status]: (a[m.status] || 0) + 1 }), {});
    let pick = '';
    const list = h('div.cmsgs');
    const bar = h('div.cfilter');
    const draw = () => {
      set(bar, [['', 'All', rows.length], ['pending', 'Needs your OK', counts.pending], ['approved', 'Queued', counts.approved], ['sent', 'Sent', counts.sent], ['skipped', 'Skipped', counts.skipped], ['failed', 'Failed', counts.failed]]
        .filter(([k, , n]) => !k || n).map(([k, l, n]) => h(`button${pick === k ? '.on' : ''}`, { onclick: () => { pick = k; draw(); } }, l, h('span', {}, n || 0))));
      set(list, rows.filter((m) => !pick || m.status === pick).map((m) => h('div.cmsg', {},
        h('div.cmsg-top', {}, h('a', { href: `#/inbox/${m.chat_id}` }, h('b', {}, m.who)), h('span.muted', {}, m.kind === 'auto' ? `Follow-up` : m.kind === 'reminder' ? 'Reminder' : 'Campaign message'), h(`span.pill.${tone[m.status] || ''}`, {}, label[m.status] || m.status), h('time', {}, m.status === 'sent' ? when(m.sent_at) : when(m.due_at))),
        h('div.cmsg-text', { dir: 'auto' }, m.text),
        m.reason ? h('div.muted', { style: 'font-size:12px' }, `Why: ${m.reason}`) : null,
        m.error ? h('div.muted', { style: 'font-size:12px;color:var(--danger)' }, m.error) : null)));
    };
    const intro = explain('messages-square', 'Messages this campaign writes', t.kind === 'auto'
      ? `Its follow-ups: one is written when a lead goes quiet for ${(c.steps || []).map(dur).join(', then ')} and goes out ${c.approval ? 'after your OK' : 'by itself'}, ${Math.round(c.gapMin)}–${Math.round(c.gapMax)} min apart. Its live replies to customers are in the Inbox.`
      : 'The message it wrote for each person: waiting for your OK, queued with its time, sent, skipped (with the reason) or failed.',
    counts.pending ? h('a.btn.primary', { href: '#/followups' }, `Approve ${counts.pending}`) : null);
    if (!rows.length) return set(body, h('div.stack', {}, intro, h('div.cempty', {}, h('b', {}, 'No messages yet'), h('p', {}, t.kind === 'auto' ? 'Nobody in this campaign has gone quiet long enough for a follow-up yet.' : 'Messages appear here as the campaign writes them.'))));
    set(body, h('div.stack', {}, intro, bar, list));
    draw();
  }

  async function settingsTab() {
    if (t.kind === 'email') return set(body, emailSettings(t, () => load()));
    const acc = await GET('/api/settings');
    set(body, settingsForm(t, acc, () => load()));
  }

  /** What the campaign is doing right now, and its latest steps as they happen. */
  async function drawLive(box) {
    const p = t.progress || {};
    const now_ = [];
    if (t.status === 'paused') now_.push(['pause', 'Paused. Press Resume, or write “resume” in Command.']);
    if (p.reading) now_.push(['book-open', `Reading chats: ${num(p.reading.done)} of ${num(p.reading.total)}${p.reading.current ? ` · now ${p.reading.current}` : ''}`, p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0]);
    if (t.nextSend) {
      const mins = Math.round((t.nextSend.at - Date.now()) / 60_000);
      now_.push(['send', h('span', {}, 'Next message to ', h('a', { href: `#/inbox/${t.nextSend.chatId}` }, t.nextSend.who), mins <= 0 ? (t.waiting ? ' · goes out as soon as sending can start' : ' · going out now') : ` at ${clock(t.nextSend.at)} · in ${mins} min`)]);
    }
    if (t.waiting) now_.push(['circle-alert', t.waiting]);
    // Tasks running inside this campaign, each with where it is.
    if (['auto', 'batch'].includes(t.kind)) {
      for (const x of (await GET(`/api/campaigns/${t.id}/tasks`).catch(() => [])).filter((k) => k.status === 'active').slice(0, 4)) {
        const n = taskNow(x);
        const mins = x.nextSend ? Math.round((x.nextSend.at - Date.now()) / 60_000) : null;
        now_.push(['list-checks', h('span', {}, h('b', {}, `Task #${x.id} · ${n.phase}: `), n.line, x.nextSend ? ` · next to ${x.nextSend.who} ${mins <= 0 ? 'now' : `in ${mins} min`}` : ''), n.total ? (n.done / n.total) * 100 : null]);
      }
    }
    if (!now_.length && t.status === 'active') now_.push(['radio', t.kind === 'auto' ? 'Waiting for new leads and quiet chats to follow up' : t.kind === 'email' ? `${num(t.stats?.waiting || 0)} emails to go, sent in office hours` : t.kind === 'scheduled' ? `Next run ${t.next_run_at ? `at ${when(t.next_run_at)}` : 'not set'}` : 'Nothing left to send']);
    if (!now_.length) now_.push(['check-check', t.status === 'done' ? 'Finished' : 'Not running']);
    const steps = await GET(`/api/tasks/${t.id}/events?limit=8`).catch(() => []);
    const ICON = { read: 'book-open', wrote: 'pen-line', sent: 'send', skipped: 'skip-forward', failed: 'circle-alert', paused: 'pause', changed: 'settings-2', done: 'check-check', info: 'info' };
    set(box, h('header', {}, h('h2', {}, h(`i.livedot${t.status === 'active' ? '.on' : ''}`), 'Live'), h('button.linkbtn', { onclick: () => { tab = 'log'; load(); } }, 'Full log')),
      h('div.clive-now', {}, now_.map(([i, text, pct]) => h('div', {}, ico(i, 'sm'), h('div.grow', {}, typeof text === 'string' ? h('span', { dir: 'auto' }, text) : text, pct != null ? h('div.cprog', { style: 'margin-top:6px' }, h('i', { style: `width:${Math.round(pct)}%` })) : null)))),
      steps.length ? h('ol.clive-feed', {}, steps.map((r) => h(`li.${r.kind}`, {}, ico(ICON[r.kind] || 'info', 'sm'), h('time', {}, clock(r.ts)), h('span', { dir: 'auto' }, r.text, r.chat_id ? h('a', { href: `#/inbox/${r.chat_id}`, style: 'margin-left:6px' }, 'chat') : null))))
        : h('div.muted', { style: 'padding:12px 18px' }, 'Steps appear here as they happen.'));
  }

  /** This campaign's own knowledge: everything the agent knows and says in it. */
  async function knowledgeTab() {
    set(body, h('div.muted', { style: 'padding:20px' }, 'Loading…'));
    const [k, all_] = await Promise.all([GET(`/api/campaigns/${t.id}/knowledge`), GET('/api/tasks').catch(() => [])]);
    const v = k.values;
    const area = (key, rows, ph) => h('textarea', { rows, dir: 'auto', value: v[key] || '', placeholder: ph, 'data-k': key });
    const inp = (key, ph) => h('input', { type: 'text', value: v[key] || '', placeholder: ph, 'data-k': key });
    const sel = (key, opts) => h('select', { 'data-k': key }, opts.map(([x, l]) => h('option', { value: x, selected: (v[key] || '') === x }, l)));
    const learnBox = h('div.stack');
    const others = all_.filter((x) => x.id !== t.id && ['auto', 'batch', 'email'].includes(x.kind) && x.status !== 'removed');
    const copyFrom = h('select', {}, [h('option', { value: '' }, 'Copy knowledge from…'), ...others.map((x) => h('option', { value: x.id }, `#${x.id} ${x.title}`))]);
    const files = (t.params || {}).files || [];
    const picker = h('input', { type: 'file', multiple: true, accept: '.md,.txt,.docx', style: 'display:none', onchange: () => act(null, async () => {
      for (const file of picker.files) {
        const res = await fetch(`/api/campaigns/${t.id}/files`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${file.name}: ${j.error || res.status}`);
      }
      await load(false); knowledgeTab();
    }, 'Files added to this campaign') });
    const site = h('input', { type: 'url', placeholder: 'https://yourshop.com' });
    const SECTIONS = [
      ['brand', 'badge', 'Brand', 'Who is talking and why.', [
        h('div.grid2', {}, field('Brand name', inp('brand', 'Your shop or brand')), field('Who the agent is', inp('persona', 'e.g. Sana from the sales team'))),
        field('Goal of the chats', area('goal', 2, 'e.g. Answer questions and help them order the right plan, without pressure.'))]],
      ['offer', 'package', 'Products and prices', 'What this campaign sells. The agent never quotes a price that is not here.', [
        field('Products, services and prices', area('offer', 9, 'One per line, e.g.\nPremium plan, 1 year: Rs 2,500\nStandard plan, 6 months: Rs 1,400\nDelivery: within 1 hour after payment')),
        h('div.grid2', {}, field('Prices', sel('prices', [['', 'Say the prices written here'], ['quote', 'Say the prices written here'], ['link', 'Never say a price, send the link']].slice(1))), field('Link when a product has none', inp('shopLink', 'https://…')))]],
      ['answers', 'circle-help', 'Answers and policies', 'What customers usually ask, and your terms.', [
        field('About the business', area('about', 3, 'What you do and for whom, in 2–3 sentences')),
        field('Questions and answers', area('faqs', 6, 'Q: Is it an original account?\nA: Yes, activated on your own email.')),
        field('Delivery, payment, refunds', area('policies', 4, 'Payment: bank transfer or wallet\nRefund: within 3 days if it does not work'))]],
      ['rules', 'list-checks', 'Rules', 'Always followed in this campaign.', [
        field('Rules for this campaign', area('instructions', 4, 'What to push, what to ask, what never to say')),
        field('Things you told it to remember', area('memory', 3, 'Added when you say “yaad rakho …” in this campaign’s Command')),
        field('What counts as a sale', inp('purchaseSignal', 'e.g. They share a payment screenshot or confirm the order'))]],
      ['writing', 'pen-line', 'How it writes', 'Tone, language and the layout of every message.', [
        h('div.grid2', {}, field('Tone', area('tone', 2, 'Short, warm, natural WhatsApp messages')), field('Language', area('language', 2, 'Reply in the customer’s language and script'))),
        field('Message layout (one rule per line)', area('format', 5, 'Greeting on its own line\nOne idea per line\nLink on its own line')),
        field('Example replies in your voice', area('examples', 4, 'Customer: price?\nYou: Assalam o alaikum Sir! …')),
        field('Example follow-up', area('followupStyle', 3, 'Use ___ for the product and {name} for their name')),
        h('div.grid2', {}, field('Links it may send (one per line)', area('links', 2, 'Website, channel…')), field('Unrelated questions', sel('offTopic', [['redirect', 'Politely bring the chat back'], ['brief', 'Answer briefly, then bring it back']])))]],
      ['learned', 'sparkles', 'Learned', 'From this campaign’s chats, your website and WhatsApp profile. You can edit it.', [
        learnBox,
        h('div.row.wrap', {}, h('button.btn', { type: 'button', onclick: (e) => act(e.target, async () => { await POST(`/api/campaigns/${t.id}/learn`, {}); }, 'Learning from this campaign’s chats; it shows here when done.') }, ico('message-square-text', 'sm'), 'Learn from its chats'),
          site, h('button.btn', { type: 'button', onclick: (e) => act(e.target, async () => { const r = await POST(`/api/campaigns/${t.id}/learn/website`, { url: site.value }); toast(`${r.site}: ${r.products} products, ${r.pages} pages read`); knowledgeTab(); }) }, ico('globe', 'sm'), 'Read website'),
          h('button.btn', { type: 'button', onclick: (e) => act(e.target, async () => { await POST(`/api/campaigns/${t.id}/learn/profile`, {}); knowledgeTab(); }, 'WhatsApp profile read') }, ico('smartphone', 'sm'), 'Read WhatsApp profile')),
        field('Learned from your chats', area('learned', 6, 'Empty: press “Learn from its chats”')),
        field('From your website and WhatsApp profile', area('learnedWeb', 6, 'Empty: read a website or your WhatsApp profile'))]],
      ['files', 'file-text', 'Files', 'Price lists, scripts, policies (.md, .txt, .docx). Read with every message of this campaign.', [
        h('div.cfiles', {}, files.length ? files.map((x) => h('div.cfile', {}, h('span', {}, ico('file-text', 'sm'), ' ', h('b', {}, x.name), h('span.muted', {}, ` · ${num(x.text.length)} characters`)),
          h('button.btn.sm.ghost.danger', { onclick: (e) => act(e.target, async () => { await DEL(`/api/campaigns/${t.id}/files/${encodeURIComponent(x.name)}`); await load(false); knowledgeTab(); }, 'File removed') }, 'Remove'))) : h('div.muted', {}, 'No files yet.')),
        h('div', {}, h('button.btn', { type: 'button', onclick: () => picker.click() }, ico('upload', 'sm'), 'Upload files'), picker)]],
    ];
    const drawLearn = (l) => set(learnBox, l?.running ? h('div.note', {}, `Learning from ${l.chats} chats: step ${l.done} of ${l.total}…`) : l?.error ? h('div.note.bad', {}, l.error) : null);
    GET('/api/learn').then(drawLearn).catch(() => {});
    live.on('learning', (l) => { drawLearn(l); if (!l.running && tab === 'knowledge') knowledgeTab(); });
    const form = h('div.stack');
    const save = h('button.btn.primary', { onclick: () => act(save, async () => {
      const patch = Object.fromEntries([...form.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value]));
      const r = await PUT(`/api/campaigns/${t.id}/knowledge`, patch);
      toast(r.changed?.length ? `Saved: ${r.changed.join(', ')}` : 'Nothing changed');
    }) }, 'Save knowledge');
    const nav = h('nav.csnav', { 'aria-label': 'Knowledge sections' }, SECTIONS.map(([sid, icon, title]) => h('a', { href: `#k-${sid}`, onclick: (e) => { e.preventDefault(); document.getElementById(`k-${sid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, ico(icon, 'sm'), title)));
    set(form, SECTIONS.map(([sid, , title, hint, kids], i) => h('div.card.csec', { id: `k-${sid}` },
      h('header', {}, h('div.csec-h', {}, h('span.csec-n', {}, i + 1), h('div', {}, h('h2', {}, title), h('p.muted', {}, hint)))), h('div.pad.stack', {}, kids))));
    set(body, h('div.stack', {},
      h('div.note', {}, h('b', {}, 'Only this campaign uses this knowledge. '), k.isDefault ? 'This is the default campaign: new campaigns start with a copy of it, then each is its own.' : 'It started as a copy; change anything here and only this campaign changes. Empty fields use the default campaign’s.',
        h('div.row', { style: 'margin-top:8px' }, copyFrom, h('button.btn.sm', { onclick: (e) => copyFrom.value && confirm('Replace this campaign’s knowledge with a copy of the other campaign’s?') && act(e.target, async () => { await POST(`/api/campaigns/${t.id}/knowledge/copy`, { from: Number(copyFrom.value) }); knowledgeTab(); }, 'Knowledge copied') }, 'Copy'))),
      h('div.csettings', {}, nav, h('div.stack', {}, form, h('div.csave', {}, save, h('span.muted', {}, 'Every change is kept in Log & history. In Command: “is campaign ki price list mein … add karo”.'))))));
  }

  /** Talk to this campaign as a new lead would. Nothing is sent or saved. */
  function testTab() {
    const turns = [];
    let stage = 'new';
    const feed = h('div.thread.ccmd-feed');
    const input = h('textarea', { dir: 'auto', rows: 2, placeholder: 'Write as a customer would, e.g. “price kya hai?”', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
    const info = h('div.muted', { style: 'font-size:12.5px;padding:0 16px 8px' });
    const draw = (thinking) => {
      set(feed, turns.length ? turns.map((m) => h(`div.msg${m.role === 'user' ? '.me' : ''}`, { dir: 'auto', style: 'white-space:pre-wrap' }, m.content))
        : h('div.cempty', { style: 'border:0;margin:auto' }, h('b', {}, `Test “${t.title}”`), h('p', {}, 'You are a new lead of this campaign. The agent answers with this campaign’s knowledge and settings. Nothing is sent to WhatsApp.')),
      thinking ? h('div.msg', { style: 'opacity:.7' }, 'typing…') : null);
      feed.scrollTop = feed.scrollHeight;
    };
    const ask = async (mode) => {
      draw(true);
      try {
        const d = await POST(`/api/campaigns/${t.id}/test`, { messages: turns, stage, mode });
        const out = d.messages || (d.message ? [d.message] : []);
        for (const m of out) turns.push({ role: 'assistant', content: m });
        stage = d.stage || stage;
        set(info, `Stage: ${stage}${d.handoff ? ' · would hand the chat to you' : ''}${d.provider ? ` · ${d.provider}` : ''}${d.latencyMs ? ` · ${(d.latencyMs / 1000).toFixed(1)} s` : ''}${mode === 'followup' && !out.length ? ' · no follow-up needed' : ''}`);
      } catch (e) { toast(e.message, true); }
      draw(false);
    };
    const send = h('button.btn.primary', { onclick: () => { const x = input.value.trim(); if (!x) return; input.value = ''; turns.push({ role: 'user', content: x }); ask('reply'); } }, ico('send', 'sm'), 'Send');
    set(body, h('div.card.ccmd', {}, feed, info,
      h('div.chips', { style: 'padding:0 14px 10px' },
        h('button.chip', { onclick: () => turns.length && ask('followup') }, 'Write the follow-up it would send'),
        h('button.chip', { onclick: () => act(null, async () => { const { system } = await GET(`/api/campaigns/${t.id}/prompt`); modal('What this campaign’s agent is told', h('pre.out', { style: 'max-height:60vh;overflow:auto;white-space:pre-wrap' }, system)); }) }, 'See its instructions'),
        h('button.chip', { onclick: () => { turns.length = 0; stage = 'new'; set(info, ''); draw(); } }, 'Start over')),
      h('div.composer', {}, input, send)));
    draw();
    input.focus();
  }

  /** Where one task inside the campaign is: its phase (reading, writing, sending), done of total, and what comes next. */
  function taskNow(x) {
    const p = x.progress || {};
    if (x.kind === 'job') {
      const j = p.job || {};
      return { phase: x.status === 'done' ? 'Done' : 'Working', done: j.done, total: j.total, line: x.status === 'done' ? x.last_result : `${num(j.done)} of ${num(j.total)} ${j.what || 'done'}` };
    }
    if (x.kind === 'analysis') {
      if (p.reading) return { phase: 'Reading chats', done: p.reading.done, total: p.reading.total, line: `Reading ${num(p.reading.done)} of ${num(p.reading.total)}${p.reading.current ? ` · now ${p.reading.current}` : ''}` };
      return { phase: x.status === 'done' ? 'Done' : 'Learning', line: x.last_result || 'Learning from what it read' };
    }
    if (x.kind === 'batch') {
      const sent = p.sent || 0, queued = p.queued || 0, drafts = p.drafts || 0;
      if (p.reading) return { phase: 'Reading and writing', done: p.reading.done, total: p.reading.total, line: `Read ${num(p.reading.done)} of ${num(p.reading.total)} chats${p.reading.current ? ` · now ${p.reading.current}` : ''} · ${num(drafts + queued + sent)} messages written` };
      if (drafts && !queued) return { phase: 'Waiting for you', done: sent, total: sent + drafts, line: `${num(drafts)} message${drafts === 1 ? '' : 's'} wait for your OK` };
      if (queued) return { phase: 'Sending', done: sent, total: sent + queued, line: `${num(sent)} of ${num(sent + queued)} sent` };
      return { phase: x.status === 'done' ? 'Done' : 'Finished sending', done: sent, total: sent, line: x.last_result || `${num(sent)} sent` };
    }
    if (x.kind === 'scheduled') return { phase: x.status === 'active' ? 'Scheduled' : 'Done', line: `${x.scheduleText}${x.next_run_at && x.status === 'active' ? ` · next run ${when(x.next_run_at)}` : ''}${x.last_result ? ` · last: ${x.last_result.slice(0, 120)}` : ''}` };
    return { phase: x.status, line: x.last_result || '' };
  }
  const PHASES = { batch: ['Reading and writing', 'Waiting for you', 'Sending', 'Done'], analysis: ['Reading chats', 'Learning', 'Done'] };

  /** Work started inside this campaign (from its Command), each with live progress. */
  async function tasksTab() {
    const list = await GET(`/api/campaigns/${t.id}/tasks`).catch(() => []);
    const ctl = (x, action, label, cls = '') => h(`button.btn.sm${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Stop and remove task #${x.id}? Messages it has not sent are cancelled.`)) && act(e.target, async () => { await PATCH(`/api/tasks/${x.id}`, { action }); tasksTab(); }) }, label);
    const card = (x) => {
      const n = taskNow(x);
      const pct = n.total ? Math.round((n.done / n.total) * 100) : x.status === 'done' ? 100 : null;
      const mins = x.nextSend ? Math.round((x.nextSend.at - Date.now()) / 60_000) : null;
      const phases = PHASES[x.kind];
      return h(`div.card.ctask.${x.status}`, {},
        h('div.ctask-top', {}, badge(x.kind === 'job' ? 'job' : x.kind),
          h('div.grow', {}, h('b', { dir: 'auto' }, x.title), h('small', {}, `Task #${x.id} · started ${rel(x.created_at)} ago`)),
          pill(x),
          h('div.row', {}, x.status === 'active' && x.kind !== 'job' ? ctl(x, 'pause', 'Pause') : x.status === 'paused' ? ctl(x, 'resume', 'Resume', '.primary') : null, ['active', 'paused'].includes(x.status) && x.kind !== 'job' ? ctl(x, 'remove', 'Stop', '.ghost.danger') : null)),
        phases ? h('div.cphases', {}, phases.map((ph) => h(`span${ph === n.phase ? '.on' : phases.indexOf(ph) < phases.indexOf(n.phase) ? '.past' : ''}`, {}, ph))) : null,
        h('div.ctask-now', {}, h('span.ctask-phase', {}, n.phase), h('span', { dir: 'auto' }, n.line)),
        pct != null ? h('div.cprog', {}, h('i', { style: `width:${pct}%` })) : null,
        x.nextSend ? h('div.ctask-next', {}, ico('send', 'sm'), `Next message to ${x.nextSend.who} ${mins <= 0 ? 'now' : `in ${mins} min (${clock(x.nextSend.at)})`}`) : null,
        x.waiting ? h('div.note.warn', { style: 'margin:0' }, x.waiting) : null,
        x.steps?.length ? h('ol.clive-feed', {}, x.steps.map((r) => h(`li.${r.kind}`, {}, ico({ read: 'book-open', wrote: 'pen-line', sent: 'send', skipped: 'skip-forward', failed: 'circle-alert', paused: 'pause', changed: 'settings-2', done: 'check-check', info: 'info' }[r.kind] || 'info', 'sm'), h('time', {}, clock(r.ts)), h('span', { dir: 'auto' }, r.text)))) : null);
    };
    set(body, h('div.stack', {},
      explain('list-checks', 'Tasks of this campaign', 'Work you ask for in this campaign’s Command, such as “last 5 days ki chats parh kar follow-up bhejo” or “in sab ko label do”, runs here as a task. Each shows what it is doing right now (reading, writing, sending), how far it is, and when the next message goes.',
        h('button.btn.primary', { onclick: () => { tab = 'command'; history.replaceState(null, '', `#/campaigns/${t.id}/command`); load(); } }, ico('terminal', 'sm'), 'Give it a task')),
      list.length ? list.map(card) : h('div.cempty', {}, h('b', {}, 'No tasks yet'), h('p', {}, 'Open Command and tell this campaign what to do. Its work shows here with live progress.'))));
  }

  let cmdReload = null;
  /** Commands inside the campaign: everything said here is about this campaign. */
  async function commandTab() {
    const input = h('textarea', { dir: 'auto', rows: 2, placeholder: `Tell campaign #${t.id} what to do`, 'aria-label': 'Command for this campaign',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
    const feed = h('div.thread.ccmd-feed');
    const tips = {
      auto: ['status', 'gap 5 to 7 minute kar do', 'follow ups band karo', 'raat ko bhi bhejo', 'is campaign ke leads ko "Hot" label do'],
      batch: ['status', 'gap 5 to 7 minute kar do', '20 minute baad shuru karo', 'message mein website ka link bhi do', 'pause'],
      email: ['status', 'gap 6 se 12 minute kar do', 'emails aur chhoti likho', 'pause'],
      scheduled: ['status', 'report mein sales ki raqam bhi do', 'pause'],
      analysis: ['status', 'kya seekha?'],
    }[t.kind] || ['status'];
    let waiting = false;
    const draw = (rows) => {
      const asking = (r, i) => i === rows.length - 1 && r.role !== 'owner' && r.steps?.some((s) => s.result?.confirm);
      const answer = (word) => { input.value = word; send.click(); };
      set(feed, rows.length ? rows.map((r, i) => r.role === 'owner'
        ? h('div.msg.me', { dir: 'auto' }, r.text, h('small', {}, clock(r.ts)))
        : h('div.msg', { dir: 'auto', style: 'white-space:pre-wrap' }, r.text,
          asking(r, i) ? h('div.confirm', {}, h('button.btn.sm.primary', { onclick: () => answer('Haan') }, 'Haan, kar do'), h('button.btn.sm', { onclick: () => answer('Nahi') }, 'Nahi')) : null,
          h('small', {}, clock(r.ts))))
        : h('div.cempty', { style: 'border:0;margin:auto' }, h('b', {}, 'Talk to this campaign'), h('p', {}, `Whatever you write here is about campaign #${t.id} only. Short orders like pause, resume, gap and status work at once, without using AI.`)),
      waiting ? h('div.msg', { style: 'opacity:.7' }, 'Working on it…') : null);
      feed.scrollTop = feed.scrollHeight;
    };
    const reload = async () => { const r = await GET(`/api/campaigns/${t.id}/commands`).catch(() => ({ items: [] })); draw(r.items); };
    const send = h('button.btn.primary', { onclick: async () => {
      const text = input.value.trim();
      if (!text || waiting) return;
      input.value = ''; waiting = true; await reload();
      try { await POST(`/api/campaigns/${t.id}/commands`, { text }); } catch (e) { toast(e.message, true); }
      waiting = false; await reload(); load(false);
    } }, ico('send', 'sm'), 'Send');
    set(body, h('div.card.ccmd', {}, feed,
      h('div.chips', { style: 'padding:0 14px' }, tips.map((x) => h('button.chip', { type: 'button', onclick: () => { input.value = x; input.focus(); } }, x))),
      h('div.composer', {}, input, send)));
    cmdReload = reload;
    await reload();
    input.focus();
  }

  async function logTab() {
    const [steps, changes] = await Promise.all([GET(`/api/tasks/${t.id}/events`).catch(() => []), GET(`/api/campaigns/${t.id}/changes`).catch(() => [])]);
    const show = (v) => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v === false ? 'no' : String(v).slice(0, 120));
    set(body, h('div.grid2', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'What it did')), h('div.pad', {}, steps.length ? h('ol.tlog', {}, steps.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.kind), h('span', { dir: 'auto' }, r.text, r.chat_id ? h('a', { href: `#/inbox/${r.chat_id}`, style: 'margin-left:6px' }, 'chat') : null)))) : h('div.muted', {}, 'Nothing yet.'))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Settings history')), h('div.pad', {}, changes.length ? h('ol.tlog', {}, changes.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.source), h('span', { dir: 'auto' }, `${r.field}: ${show(r.before)} → ${show(r.after)}`)))) : h('div.muted', {}, 'No changes yet.')))));
  }

  live.on('tasks', () => { if (tab === 'overview' || tab === 'tasks') load(); else load(false); });
  live.on('command', () => { if (tab === 'command') cmdReload?.(); });
  // The “in N min” countdown stays right while the page is open.
  const tick = setInterval(() => { if (!el.isConnected) return clearInterval(tick); if (tab === 'overview' && t) drawLive(body.querySelector('.clive') || h('div')); }, 30_000);
  live.on('followups', () => { if (tab === 'overview') load(); });
  load();
  return el;
}

// ---------- settings of one campaign: everything about it, in one place (like an ad campaign) ----------
const SPEED = { instant: 'Instant', fast: 'Fast', natural: 'Natural (slowest, most human)' };
function settingsForm(t, acc, done) {
  const auto = t.kind === 'auto';
  const p = t.params || {};
  const c = auto ? t.config || {} : { ...p, approval: p.autoApprove === false, night: !!t.ignore_quiet };
  const inp = (v, attrs = {}) => h('input', { type: 'text', value: v ?? '', ...attrs });
  const area = (v, rows, ph) => h('textarea', { rows, dir: 'auto', value: v || '', placeholder: ph });
  const sel = (opts, v) => h('select', {}, opts.map(([k, l]) => h('option', { value: k, selected: String(v ?? '') === k }, l)));
  const tri = (v, def, onText, offText) => sel([['', `Standard (${def ? onText : offText})`], ['on', onText], ['off', offText]], v === true ? 'on' : v === false ? 'off' : '');
  const check = (on) => h('input', { type: 'checkbox', checked: !!on });
  const gap = Array.isArray(c.intervalMinutes) ? c.intervalMinutes : [c.gapMin ?? c.intervalMinutes ?? 5, c.gapMax ?? c.intervalMinutes ?? 10];
  const ownQuiet = c.quietStart != null && c.quietEnd != null;
  const dateOf = (ts) => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : '');
  const f = {
    name: inp(t.title), endsAt: inp(dateOf(c.endsAt), { type: 'date' }), priority: inp(c.priority ?? 100, { type: 'number' }),
    keywords: inp((c.keywords || []).join(', ')), adText: inp((c.adText || []).join(', ')), adIds: inp((c.adIds || []).join(', ')), labels: inp((c.labels || []).join(', ')),
    message: auto ? null : area(t.instruction, 3, 'What each message should say'),
    autoReply: check(c.autoReply !== false), replySpeed: sel([['', `Standard (${SPEED[Object.keys(SPEED).find((k) => acc.human.debounceMin === { instant: 1, fast: 2, natural: 4 }[k])] || 'custom'})`], ...Object.entries(SPEED)], c.replySpeed),
    voice: tri(c.voice, acc.voice?.transcribe !== false, 'Listen', 'Ignore'), images: tri(c.images, acc.images?.read === true, 'Look at them', 'Ignore'),
    followups: check(c.followups !== false), steps: auto ? inp((c.steps || []).join(', ')) : null,
    gapMin: inp(Math.round(gap[0]), { type: 'number', min: 0 }), gapMax: inp(Math.round(gap[1]), { type: 'number', min: 0 }),
    approval: sel([['send', 'Send by itself'], ['ask', 'Wait for my OK (Approvals page)']], c.approval ? 'ask' : 'send'), night: check(c.night),
    ownQuiet: check(ownQuiet), quietStart: inp(c.quietStart ?? acc.followup.quietStart, { type: 'number', min: 0, max: 23 }), quietEnd: inp(c.quietEnd ?? acc.followup.quietEnd, { type: 'number', min: 0, max: 23 }),
    dailyCap: inp(c.dailyCap || '', { type: 'number', min: 0, placeholder: 'No own limit' }),
    templateFallback: check(c.templateFallback !== false), label: inp(c.label || ''),
  };
  const quietBox = h('div.grid2', {}, field('From (hour, 0–23)', f.quietStart), field('Until (hour)', f.quietEnd));
  const syncQuiet = () => { quietBox.style.display = f.ownQuiet.checked ? '' : 'none'; };
  f.ownQuiet.onchange = syncQuiet; syncQuiet();
  const numbers = h('div.checks', {}, S.accounts.length ? S.accounts.map((a) => h('label', {}, h('input', { type: 'checkbox', value: a.id, checked: (c.accountIds || []).includes(a.id) }), a.name)) : h('span.muted', {}, 'No number linked yet.'));
  const toggleRow = (box, title, hint) => h('label.cswitch', {}, h('div', {}, h('b', {}, title), h('span', {}, hint)), box);

  const SECTIONS = [
    ['basics', 'flag', 'Campaign', 'Name, WhatsApp numbers and how long it runs.', [
      field('Campaign name', f.name),
      auto && !c.isDefault ? field('Numbers', numbers, 'None ticked = all your numbers.') : null,
      h('div.grid2', {}, field('Ends on', f.endsAt, 'Pauses by itself after this day. Empty = runs until you pause it.'), auto && !c.isDefault ? field('Priority', f.priority, 'When two campaigns match a lead, the lower number wins.') : h('div'))]],
    auto ? ['audience', 'users', 'Audience', 'Who joins this campaign.', c.isDefault ? [h('div.note', {}, 'This is the default campaign: every new lead that no other campaign takes joins it.')] : [
      h('div.note', {}, 'Any one of these is enough. Leave all empty to take every new lead on the numbers above.'),
      h('div.grid2', {}, field('Words in their first message', f.keywords, 'Give each ad its own pre-filled message and use a word from it.'), field('Words in the ad title', f.adText)),
      h('div.grid2', {}, field('Meta ad IDs', f.adIds), field('Chat already has the WhatsApp label', f.labels))]] : null,
    auto ? null : ['message', 'message-square-text', 'Message', 'What each message of this campaign says. Products, prices and rules are in the Knowledge tab.', [field('What each message should say', f.message, 'Changing it rewrites the messages not sent yet.')]],
    auto ? ['replies', 'message-circle', 'Replies', 'How the agent answers this campaign’s leads.', [
      h('div.cswitches.wide', { style: 'border:1px solid var(--line);border-radius:10px' }, toggleRow(f.autoReply, 'Auto reply', 'Off: you answer these leads yourself; follow-ups can still run.')),
      h('div.grid3', {}, field('Reply speed', f.replySpeed, 'How long it waits and “types” before answering.'), field('Voice notes', f.voice, 'Turned into text (small cost).'), field('Pictures', f.images, 'Payment proofs, screenshots (one AI call each).'))]] : null,
    ['sending', 'send', auto ? 'Follow-ups and sending' : 'Sending', auto ? 'When quiet leads get a follow-up, and how fast messages go out.' : 'How fast its messages go out.', [
      auto ? h('div.cswitches.wide', { style: 'border:1px solid var(--line);border-radius:10px' }, toggleRow(f.followups, 'Follow-ups', 'Off: replies only, no follow-ups.')) : null,
      auto ? field('Follow up after (hours of silence)', f.steps, 'One number per follow-up, e.g. 2, 24, 72') : null,
      h('div.grid3', {}, field('Gap between messages, from (min)', f.gapMin), field('to (min)', f.gapMax), field('Before sending', f.approval)),
      h('div.grid2', {}, field('Most messages per day', f.dailyCap, `Only for this campaign. The number's own limit (${acc.followup.dailyCap} a day) always applies too.`), h('div')),
      h('div.cswitches.wide', { style: 'border:1px solid var(--line);border-radius:10px' },
        toggleRow(f.night, 'Send at night', 'On: ignores quiet hours.'),
        toggleRow(f.ownQuiet, 'Own quiet hours', `Off: account quiet hours (${acc.followup.quietStart}:00 to ${acc.followup.quietEnd}:00).`)),
      quietBox,
      auto ? h('label.row', {}, f.templateFallback, h('span', {}, 'When no AI model can write, send the example message (name and product filled in)')) : null]],
    auto ? ['labels', 'tag', 'Labels', 'WhatsApp Business labels for this campaign.', [field('Put this WhatsApp label on each lead', f.label, 'QR-linked WhatsApp Business. Made on the phone if missing; your own labels are never removed.')]] : null,
  ].filter(Boolean);

  const save = h('button.btn.primary', { onclick: () => act(save, async () => {
    const body = {
      name: f.name.value,
      gapMin: Number(f.gapMin.value), gapMax: Number(f.gapMax.value), approval: f.approval.value === 'ask', night: f.night.checked, dailyCap: Number(f.dailyCap.value) || 0,
      quietStart: f.ownQuiet.checked ? Number(f.quietStart.value) : '', quietEnd: f.ownQuiet.checked ? Number(f.quietEnd.value) : '',
      endsAt: f.endsAt.value ? new Date(`${f.endsAt.value}T23:59:00`).getTime() : '',
    };
    if (auto) {
      Object.assign(body, { steps: f.steps.value, label: f.label.value, templateFallback: f.templateFallback.checked, autoReply: f.autoReply.checked, followups: f.followups.checked,
        replySpeed: f.replySpeed.value, voice: f.voice.value === '' ? null : f.voice.value === 'on', images: f.images.value === '' ? null : f.images.value === 'on' });
      if (!c.isDefault) Object.assign(body, { keywords: f.keywords.value, adText: f.adText.value, adIds: f.adIds.value, labels: f.labels.value, priority: Number(f.priority.value), accountIds: [...numbers.querySelectorAll('input:checked')].map((i) => Number(i.value)) });
    } else body.instruction = f.message.value;
    const r = await PATCH(`/api/campaigns/${t.id}`, body);
    toast(r.changed?.length ? `Saved: ${r.changed.join('; ')}`.slice(0, 220) : 'Nothing changed');
    done();
  }) }, 'Save changes');
  const nav = h('nav.csnav', { 'aria-label': 'Campaign settings sections' }, SECTIONS.map(([id, icon, title]) => h('a', { href: `#cs-${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`cs-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, ico(icon, 'sm'), title)));
  return h('div.csettings', {}, nav,
    h('div.stack', {}, SECTIONS.map(([id, icon, title, hint, kids], i) => h('div.card.csec', { id: `cs-${id}` },
      h('header', {}, h('div.csec-h', {}, h('span.csec-n', {}, i + 1), h('div', {}, h('h2', {}, title), h('p.muted', {}, hint)))), h('div.pad.stack', {}, kids))),
    h('div.csave', {}, save, h('span.muted', {}, 'Only this campaign changes. Every change is kept in Log & history.'))));
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
