// Campaigns: the centre of the dashboard. A list of campaign cards, a step-by-step "new campaign" wizard,
// and a page per campaign with its own switches, progress, people, messages, settings, log and history.
import { h, set, GET, POST, PATCH, act, toast, modal, field, toggle, select, rel, num, stagePill } from './ui.js';
import { S, live } from './state.js';

const STATUS = { active: ['Running', 'hot'], paused: ['Paused', 'warn'], done: ['Done', 'ok'], failed: ['Failed', 'bad'] };
const KIND = { auto: ['Always on', 'New leads join by its rules'], batch: ['One-time', 'People already in your chats'], analysis: ['Reading', 'Reads chats and learns'], scheduled: ['Scheduled', 'Repeats an instruction'] };
const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (x) => (x % 24 === 0 ? `${x / 24}d` : `${x}h`);
const pill = (t) => { const [l, tone] = STATUS[t.status] || [t.status, '']; return h(`span.pill.${tone}`, {}, t.status === 'active' ? h('i.dia.hot.live') : null, l); };
const accountName = (id) => S.accounts.find((a) => a.id === Number(id))?.name || `Number ${id}`;

/** One line that says where a campaign is. */
function progressLine(t) {
  const p = t.progress || {};
  if (t.kind === 'auto') return { pct: null, text: `${num(t.stats?.members)} leads · ${num(t.stats?.sent)} follow-ups sent · ${num(t.stats?.replied)} replied · ${num(t.stats?.bought)} bought` };
  if (p.reading) return { pct: p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0, text: `Reading and writing: ${num(p.reading.done)} of ${num(p.reading.total)}` };
  if (t.kind === 'batch') {
    const total = (p.sent || 0) + (p.queued || 0);
    return { pct: total ? (p.sent / total) * 100 : t.status === 'done' ? 100 : 0, text: total ? `${num(p.sent)} of ${num(total)} sent${p.drafts ? ` · ${num(p.drafts)} wait for your OK` : ''}` : p.drafts ? `${num(p.drafts)} wait for your OK` : t.last_result || 'Nothing to send' };
  }
  return { pct: null, text: t.scheduleText };
}

// ============================== list ==============================
export function campaigns(arg) {
  if (arg && /^\d+$/.test(arg)) return campaignPage(Number(arg));
  const box = h('div.camp-grid');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Campaigns'), h('p', {}, 'Each campaign has its own numbers, people, messages, switches and results. Open one to see everything about it.')),
      h('button.btn.primary', { onclick: () => wizard() }, 'New campaign')),
    box);
  const draw = (list) => {
    const shown = list.filter((t) => ['active', 'paused', 'done', 'failed'].includes(t.status));
    if (!shown.length) return set(box, h('div.card', {}, h('div.empty', {}, h('b', {}, 'No campaigns yet'), 'Start one for your ad leads, or message people already in your chats.', h('div', {}, h('button.btn.primary', { onclick: () => wizard() }, 'New campaign')))));
    const order = (t) => (t.kind === 'auto' ? 0 : t.status === 'active' ? 1 : t.status === 'paused' ? 2 : 3);
    set(box, shown.sort((a, b) => order(a) - order(b) || b.id - a.id).map((t) => {
      const pr = progressLine(t);
      const [kind, kindHint] = KIND[t.kind] || [t.kind, ''];
      const numbers = t.config?.accountIds?.length ? t.config.accountIds.map(accountName).join(', ') : t.kind === 'auto' ? 'All numbers' : '';
      return h('a.card.ccard', { href: `#/campaigns/${t.id}` },
        h('div.row', { style: 'justify-content:space-between;gap:8px' }, h('span.muted.mono', {}, `#${t.id}`), pill(t)),
        h('b.ccard-title', { dir: 'auto' }, t.title),
        h('div.muted', { style: 'font-size:12.5px' }, `${kind}${t.config?.isDefault ? ' · default' : ''} · ${kindHint}${numbers ? ` · ${numbers}` : ''}`),
        pr.pct != null ? h('div.bar', {}, h('i', { style: `width:${Math.round(pr.pct)}%` })) : null,
        h('div', { style: 'font-size:13px;color:var(--ink)' }, pr.text));
    }));
  };
  const load = () => GET('/api/tasks').then(draw).catch((e) => toast(e.message, true));
  live.on('tasks', load); live.on('followups', load); live.on('campaign', load);
  load();
  return el;
}

// ============================== one campaign ==============================
function campaignPage(id) {
  const head = h('div.head');
  const tabsBar = h('div.tabs');
  const body = h('div');
  const el = h('div.page', {}, h('a.muted', { href: '#/campaigns', style: 'font-size:13px' }, '← All campaigns'), head, tabsBar, body);
  let tab = 'overview';
  let t = null;
  const TABS = [['overview', 'Overview'], ['people', 'People'], ['messages', 'Messages'], ['settings', 'Settings'], ['log', 'Log and history']];

  async function load() {
    try { t = await GET(`/api/campaigns/${id}/view`); } catch (e) { return set(body, h('div.note.bad', {}, e.message)); }
    const c = t.config || {};
    const ctl = (action, label, cls = '') => h(`button.btn${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Remove campaign #${t.id}? Messages it has not sent yet are cancelled; its log and history are kept.`)) && act(e.target, async () => { await PATCH(`/api/tasks/${t.id}`, { action }); if (action === 'remove') location.hash = '#/campaigns'; else load(); }) }, label);
    set(head, h('div', {}, h('div.row.wrap', { style: 'gap:8px' }, h('h1', { dir: 'auto' }, t.title), pill(t)),
      h('p', {}, `${(KIND[t.kind] || [t.kind])[0]} campaign #${t.id}${c.isDefault ? ' · default' : ''} · created ${when(t.created_at)} · in Command say “campaign ${t.id} …”`)),
    h('div.row.wrap', {},
      t.status === 'active' ? ctl('pause', 'Pause') : ['paused'].includes(t.status) ? ctl('resume', 'Resume', '.primary') : null,
      t.kind === 'scheduled' ? ctl('run', 'Run now') : null,
      c.isDefault ? null : ctl('remove', 'Remove', '.ghost.danger')));
    set(tabsBar, TABS.filter(([k]) => k !== 'settings' || t.kind === 'auto' || t.kind === 'batch').map(([k, label]) => h(`button${tab === k ? '.on' : ''}`, { onclick: () => { tab = k; load(); } }, label)));
    ({ overview, people, messages, settings: settingsTab, log: logTab }[tab])();
  }

  function overview() {
    const c = t.config || {};
    const s = t.stats || {};
    const p = t.params || {};
    const pr = progressLine(t);
    const sw = (on, key, label, hint, invert = false) => h('div.row', {}, toggle(on, (v) => act(null, async () => { await PATCH(`/api/campaigns/${t.id}`, { [key]: invert ? !v : v }); load(); }, `${label}: ${v ? 'on' : 'off'}`), label), h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, label), h('div.muted', { style: 'font-size:12.5px' }, hint)));
    set(body, h('div.stack', {},
      h('div.tiles', {}, [['People', s.members], ['Follow-ups sent', s.sent], ['Waiting', s.waiting], ['Replied after one', s.replied], ['Bought', s.bought], ['Reply rate', s.sent ? `${Math.round((s.replied / s.sent) * 100)}%` : '—']]
        .map(([label, n]) => h('div.tile', {}, h('b', {}, typeof n === 'number' ? num(n) : n ?? 0), h('span', {}, label)))),
      pr.pct != null ? h('div.card', {}, h('div.pad.stack', {}, h('div.bar.big', {}, h('i', { style: `width:${Math.round(pr.pct)}%` })), h('div.row', { style: 'justify-content:space-between' }, h('span', {}, pr.text), h('b', {}, `${Math.round(pr.pct)}%`)),
        t.waiting ? h('div.note.warn', {}, t.waiting) : null)) : null,
      t.kind === 'auto' ? h('div.card', {}, h('header', {}, h('h2', {}, 'Switches')), h('div.pad.stack', {},
        sw(c.autoReply !== false, 'autoReply', 'Auto reply', 'The agent answers this campaign’s leads by itself. Off: you answer, it only follows up.'),
        sw(c.followups !== false, 'followups', 'Follow-ups', `Nudge quiet leads after ${(c.steps || []).map(dur).join(', ')}, ${Math.round(c.gapMin)}–${Math.round(c.gapMax)} min apart.`),
        sw(!c.approval, 'approval', 'Send without asking', 'Off: every follow-up waits for your OK on the Approvals page.', true),
        sw(!!c.night, 'night', 'Send at night too', 'Off: nothing goes out in the quiet hours from Settings.'))) : null,
      h('div.card', {}, h('header', {}, h('h2', {}, 'How it works')), h('div.pad.stack', { style: 'gap:6px' },
        t.kind === 'auto' ? [
          h('div.kv', {}, 'Who joins', h('b', {}, c.isDefault ? 'Every new lead no other campaign takes' : [c.labels?.length ? `label: ${c.labels.join(', ')}` : null, c.keywords?.length ? `words: ${c.keywords.join(', ')}` : null, c.adText?.length ? `ad: ${c.adText.join(', ')}` : null, c.adIds?.length ? `ad ID: ${c.adIds.join(', ')}` : null].filter(Boolean).join(' · ') || 'People you add by hand')),
          h('div.kv', {}, 'Numbers', h('b', {}, c.accountIds?.length ? c.accountIds.map(accountName).join(', ') : 'All numbers')),
          c.label ? h('div.kv', {}, 'Puts the WhatsApp label', h('b', {}, c.label)) : null,
          c.instructions ? h('div', { dir: 'auto' }, h('span.muted', {}, 'Instructions: '), c.instructions) : null,
        ] : [
          h('div', { dir: 'auto' }, h('span.muted', {}, 'Message: '), t.instruction),
          p.sinceDays ? h('div.kv', {}, 'Chats from the last', h('b', {}, `${p.sinceDays} days`)) : null,
          p.keywords?.length ? h('div.kv', {}, 'About', h('b', {}, p.keywords.join(', '))) : null,
          p.accountIds?.length ? h('div.kv', {}, 'Numbers', h('b', {}, p.accountIds.map(accountName).join(', '))) : null,
          p.tags?.length ? h('div.kv', {}, 'Tags', h('b', {}, p.tags.join(', '))) : null,
          p.intervalMinutes ? h('div.kv', {}, 'Gap', h('b', {}, Array.isArray(p.intervalMinutes) ? `${p.intervalMinutes[0]}–${p.intervalMinutes[1]} min (random)` : `${p.intervalMinutes} min`)) : null,
        ]))));
  }

  async function people() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/people`).catch(() => []);
    const msg = (m) => (!m ? '—' : m.status === 'sent' ? `Sent ${when(m.sent_at)}` : m.status === 'approved' ? `Goes ${when(m.due_at)}` : m.status === 'pending' ? 'Waits for your OK' : m.status);
    set(body, h('div.card', {}, h('div.pad', {}, h('div.rtable', {}, h('table', {},
      h('thead', {}, h('tr', {}, ['Person', 'Stage', 'Last message', 'Message', t.kind === 'auto' ? 'Next follow-up' : 'Tags'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.length ? rows.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/inbox/${r.id}` }, r.title), r.ad ? h('div.muted', { style: 'font-size:11.5px' }, `ad: ${r.ad}`) : null),
        h('td.n', {}, stagePill(r.stage)), h('td.n', {}, r.lastAt ? rel(r.lastAt) : '—'), h('td.n', {}, msg(r.message)),
        h('td.n', {}, t.kind === 'auto' ? (r.nextFollowup ? when(r.nextFollowup) : '—') : r.tags.join(', ') || '—'))) : h('tr', {}, h('td.muted', { colspan: 5 }, 'Nobody yet.'))))))));
  }

  async function messages() {
    set(body, h('div.muted', {}, 'Loading…'));
    const rows = await GET(`/api/campaigns/${t.id}/messages`).catch(() => []);
    const tone = { sent: 'ok', approved: 'hot', pending: 'warn', failed: 'bad', skipped: '' };
    set(body, h('div.stack', {}, rows.length ? rows.map((m) => h('div.card', {}, h('div.pad.stack', { style: 'gap:6px' },
      h('div.row', { style: 'justify-content:space-between' }, h('a', { href: `#/inbox/${m.chat_id}` }, h('b', {}, m.who)), h('span.row', {}, h(`span.pill.${tone[m.status] || ''}`, {}, m.status), h('span.muted', { style: 'font-size:12px' }, m.status === 'sent' ? when(m.sent_at) : when(m.due_at)))),
      h('div', { dir: 'auto', style: 'white-space:pre-wrap' }, m.text),
      m.error ? h('div.muted', { style: 'font-size:12px' }, m.error) : null))) : h('div.card', {}, h('div.empty', {}, 'No messages yet.'))));
  }

  function settingsTab() {
    if (t.kind === 'batch') {
      set(body, h('div.card', {}, h('div.pad.stack', {}, h('p', {}, 'A one-time campaign is changed by telling Command what to change. Messages not sent yet are rewritten or re-spaced:'),
        h('pre.out', {}, `campaign ${t.id} mein gap 5 to 7 minute kar do\ncampaign ${t.id} ke message mein discount ka zikr bhi karo\ncampaign ${t.id} raat ko bhi bhejo`),
        h('a.btn', { href: '#/command' }, 'Open Command'))));
      return;
    }
    set(body, autoForm(t, load));
  }

  async function logTab() {
    const [steps, changes] = await Promise.all([GET(`/api/tasks/${t.id}/events`).catch(() => []), GET(`/api/campaigns/${t.id}/changes`).catch(() => [])]);
    const show = (v) => (v == null ? '—' : Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v === false ? 'no' : String(v));
    set(body, h('div.grid2', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'What it did')), h('div.pad', {}, steps.length ? h('ol.tlog', {}, steps.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.kind), h('span', { dir: 'auto' }, r.text, r.chat_id ? h('a', { href: `#/inbox/${r.chat_id}`, style: 'margin-left:6px' }, 'chat') : null)))) : h('div.muted', {}, 'Nothing yet.'))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Settings history')), h('div.pad', {}, changes.length ? h('ol.tlog', {}, changes.map((r) => h('li', {}, h('time', {}, when(r.ts)), h('span.pill', {}, r.source), h('span', { dir: 'auto' }, `${r.field}: ${show(r.before)} → ${show(r.after)}`)))) : h('div.muted', {}, 'No changes yet.')))));
  }

  for (const type of ['tasks', 'followups', 'campaign']) live.on(type, () => { if (tab === 'overview') load(); });
  load();
  return el;
}

/** Settings of an automatic campaign, on its own page. */
function autoForm(t, done) {
  const c = t.config || {};
  const inp = (v, attrs = {}) => h('input', { type: 'text', value: v ?? '', ...attrs });
  const f = {
    name: inp(t.title), keywords: inp((c.keywords || []).join(', ')), adText: inp((c.adText || []).join(', ')), adIds: inp((c.adIds || []).join(', ')),
    labels: inp((c.labels || []).join(', ')), label: inp(c.label || ''), steps: inp((c.steps || []).join(', ')), gapMin: inp(c.gapMin, { type: 'number', min: 0 }), gapMax: inp(c.gapMax, { type: 'number', min: 0 }),
    instructions: h('textarea', { rows: 3, dir: 'auto', value: c.instructions || '' }), followupStyle: h('textarea', { rows: 3, dir: 'auto', value: c.followupStyle || '' }),
    templateFallback: h('input', { type: 'checkbox', checked: c.templateFallback !== false }), priority: inp(c.priority, { type: 'number' }),
  };
  const numbers = h('div.checks', {}, S.accounts.map((a) => h('label', {}, h('input', { type: 'checkbox', value: a.id, checked: (c.accountIds || []).includes(a.id) }), a.name)));
  const save = h('button.btn.primary', { onclick: () => act(save, async () => {
    const accountIds = [...numbers.querySelectorAll('input:checked')].map((i) => Number(i.value));
    await PATCH(`/api/campaigns/${t.id}`, { name: f.name.value, steps: f.steps.value, gapMin: Number(f.gapMin.value), gapMax: Number(f.gapMax.value), instructions: f.instructions.value, followupStyle: f.followupStyle.value,
      templateFallback: f.templateFallback.checked, label: f.label.value,
      ...(c.isDefault ? {} : { keywords: f.keywords.value, adText: f.adText.value, adIds: f.adIds.value, labels: f.labels.value, priority: Number(f.priority.value), accountIds }) });
    done();
  }, 'Saved. The change is in the history.') }, 'Save settings');
  return h('div.stack', {},
    h('div.card', {}, h('header', {}, h('h2', {}, 'Name and who joins')), h('div.pad.stack', {}, field('Name', f.name),
      c.isDefault ? h('div.note', {}, 'Default campaign: every new lead no other campaign takes joins it.') : [
        field('Numbers', numbers, 'None ticked = all numbers.'),
        h('div.grid2', {}, field('Words in their first message', f.keywords), field('Words in the ad title', f.adText)),
        h('div.grid2', {}, field('Meta ad IDs', f.adIds), field('Chat already has WhatsApp label', f.labels)),
        field('Priority', f.priority, 'Lower wins when two campaigns match.')],
      field('Put this WhatsApp label on its leads', f.label, 'WhatsApp Business (QR) only.'))),
    h('div.card', {}, h('header', {}, h('h2', {}, 'Follow-ups')), h('div.pad.stack', {},
      h('div.grid3', {}, field('After (hours)', f.steps, '2, 24, 72'), field('Gap min (minutes)', f.gapMin), field('Gap max (minutes)', f.gapMax)),
      h('label.row', {}, f.templateFallback, h('span', {}, 'When no AI model can write, send my example follow-up')))),
    h('div.card', {}, h('header', {}, h('h2', {}, 'How it talks')), h('div.pad.stack', {},
      field('Reply instructions', f.instructions, 'Added to every reply and follow-up for this campaign’s leads.'), field('Example follow-up in your words', f.followupStyle, 'Use ___ for the product and {name} for their name.'))),
    h('div.row', {}, save));
}

// ============================== new campaign wizard ==============================
function wizard() {
  const st = { type: 'auto', accountIds: [], keywords: '', adText: '', labels: '', days: 7, products: '', stages: [], tags: '', name: '', instruction: '', steps: '2, 24, 72', gapMin: 5, gapMax: 10, startIn: 0, autoReply: true, followups: true, send: true, night: false, label: '' };
  let step = 0;
  const stepsBox = h('div.wsteps');
  const body = h('div.stack');
  const foot = h('div.row', { style: 'justify-content:space-between;width:100%' });
  const STEPS = ['Type', 'Numbers', 'Who', 'Messages', 'Review'];
  const inp = (key, attrs = {}) => h('input', { type: 'text', value: st[key], oninput: (e) => { st[key] = attrs.type === 'number' ? Number(e.target.value) : e.target.value; }, ...attrs });
  const chk = (key, label) => h('label.row', {}, h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => { st[key] = e.target.checked; } }), h('span', {}, label));

  const pages = [
    () => h('div.wtypes', {}, [
      ['auto', 'Always on, for new leads', 'Leads from an ad, with certain words, or on a number join it. It answers them with its instructions and follows up by its hours.'],
      ['batch', 'One-time, to people in your chats', 'For example: everyone from the last 7 days who asked about Canva. Each gets a personal message, spaced out.'],
      ['email', 'Email campaign', 'Cold or follow-up emails from your own sending account. Coming next: not available yet.'],
    ].map(([k, title, hint]) => h(`button.wtype${st.type === k ? '.on' : ''}`, { type: 'button', disabled: k === 'email', onclick: () => { st.type = k; draw(); } }, h('b', {}, title), h('span', {}, hint)))),
    () => S.accounts.length ? h('div.stack', {}, h('p.muted', { style: 'margin:0' }, 'Which WhatsApp numbers does this campaign use? None ticked = all numbers.'),
      h('div.checks', {}, S.accounts.map((a) => h('label', {}, h('input', { type: 'checkbox', checked: st.accountIds.includes(a.id), onchange: (e) => { st.accountIds = e.target.checked ? [...st.accountIds, a.id] : st.accountIds.filter((x) => x !== a.id); } }), `${a.name}${a.status?.me ? ` (+${a.status.me})` : ''}`))))
      : h('div.note.warn', {}, 'No WhatsApp number is linked yet. Link one on the Numbers page; the campaign will use it.'),
    () => st.type === 'auto' ? h('div.stack', {},
      h('p.muted', { style: 'margin:0' }, 'A new lead joins when any one of these matches. Leave all empty to take every new lead on the chosen numbers.'),
      field('Words in their first message', inp('keywords', { placeholder: 'canva, canva pro' }), 'Give each ad its own pre-filled message, then put a word from it here.'),
      h('div.grid2', {}, field('Words in the ad title', inp('adText', { placeholder: 'eid' })), field('Chat has WhatsApp label', inp('labels', { placeholder: 'New customer' }))))
      : h('div.stack', {},
        h('div.grid2', {}, field('Chats from the last (days)', inp('days', { type: 'number', min: 1 })), field('About these products or words', inp('products', { placeholder: 'canva, chatgpt' }), 'Found in their messages, summary or customer card.')),
        h('div.grid2', {}, field('Only these stages', select([['', 'Everyone except buyers'], ['interested', 'Interested / negotiating'], ['purchased', 'Bought (reminders)']], st.stages[0] || '', (v) => { st.stages = v === 'interested' ? ['interested', 'negotiating'] : v ? [v] : []; })),
          field('Only these tags', inp('tags', { placeholder: 'vip' })))),
    () => h('div.stack', {},
      field('Name', inp('name', { placeholder: st.type === 'auto' ? 'Eid Canva ad' : 'Canva follow-up, last week' })),
      st.type === 'auto' ? [
        field('How to answer these leads', h('textarea', { rows: 3, dir: 'auto', value: st.instruction, oninput: (e) => { st.instruction = e.target.value; }, placeholder: 'Canva Pro yearly offer batao, link bhejo, Eid discount ka zikr karo' })),
        h('div.grid3', {}, field('Follow up after (hours)', inp('steps')), field('Gap min (min)', inp('gapMin', { type: 'number', min: 0 })), field('Gap max (min)', inp('gapMax', { type: 'number', min: 0 }))),
        chk('autoReply', 'Auto reply: the agent answers them by itself'), chk('followups', 'Follow up when they go quiet'),
        field('Put this WhatsApp label on them', inp('label', { placeholder: 'Canva Ad' })),
      ] : [
        field('What the message should say', h('textarea', { rows: 3, dir: 'auto', value: st.instruction, oninput: (e) => { st.instruction = e.target.value; }, placeholder: 'Jinhon ne Canva poocha tha unhein yaad dilao ke Eid offer chal raha hai, link bhejo' })),
        h('div.grid3', {}, field('Start after (minutes)', inp('startIn', { type: 'number', min: 0 })), field('Gap min (min)', inp('gapMin', { type: 'number', min: 1 })), field('Gap max (min)', inp('gapMax', { type: 'number', min: 1 }))),
      ],
      chk('send', 'Send by itself (off: every message waits for my OK)'), chk('night', 'May send at night')),
    () => h('div.stack', { style: 'gap:6px' },
      h('div.kv', {}, 'Type', h('b', {}, st.type === 'auto' ? 'Always on, for new leads' : 'One-time, to people in your chats')),
      h('div.kv', {}, 'Numbers', h('b', {}, st.accountIds.length ? st.accountIds.map(accountName).join(', ') : 'All numbers')),
      st.type === 'auto' ? h('div.kv', {}, 'Who joins', h('b', {}, [st.keywords && `words: ${st.keywords}`, st.adText && `ad: ${st.adText}`, st.labels && `label: ${st.labels}`].filter(Boolean).join(' · ') || 'every new lead'))
        : h('div.kv', {}, 'Who', h('b', {}, `last ${st.days} days${st.products ? `, about ${st.products}` : ''}${st.tags ? `, tag ${st.tags}` : ''}`)),
      h('div.kv', {}, 'Gap', h('b', {}, `${st.gapMin}–${st.gapMax} min`)),
      st.type === 'auto' ? h('div.kv', {}, 'Follow-ups', h('b', {}, st.followups ? `after ${st.steps} hours` : 'off')) : h('div.kv', {}, 'Starts', h('b', {}, st.startIn ? `in ${st.startIn} min` : 'now')),
      h('div.kv', {}, 'Sending', h('b', {}, st.send ? 'by itself' : 'waits for your OK'))),
  ];

  async function create(btn) {
    await act(btn, async () => {
      const name = st.name || (st.type === 'auto' ? 'New campaign' : st.instruction.slice(0, 60));
      if (st.type === 'auto') {
        const t = await POST('/api/campaigns', { name, accountIds: st.accountIds, keywords: st.keywords, adText: st.adText, labels: st.labels, instructions: st.instruction, steps: st.steps, gapMin: st.gapMin, gapMax: st.gapMax, approval: !st.send, night: st.night, autoReply: st.autoReply, followups: st.followups, label: st.label });
        m.close(); location.hash = `#/campaigns/${t.id}`;
      } else {
        const r = await POST('/api/campaigns/once', { name, accountIds: st.accountIds, days: st.days, keywords: st.products, stages: st.stages, tags: st.tags, instruction: st.instruction, gapMin: st.gapMin, gapMax: st.gapMax, startInMinutes: st.startIn, send: st.send, night: st.night });
        m.close(); toast(`Campaign started: ${r.chats} chats are being read and messaged.`); location.hash = `#/campaigns/${r.id}`;
      }
    });
  }

  function draw() {
    set(stepsBox, STEPS.map((s, i) => h(`span${i === step ? '.on' : i < step ? '.done' : ''}`, {}, `${i + 1}. ${s}`)));
    set(body, pages[step]());
    const next = step < STEPS.length - 1
      ? h('button.btn.primary', { onclick: () => { if (step === 3 && !st.instruction.trim() && st.type === 'batch') return toast('Write what the message should say', true); step++; draw(); } }, 'Next')
      : h('button.btn.primary', { onclick: (e) => create(e.target) }, st.type === 'auto' ? 'Create campaign' : 'Start campaign');
    set(foot, step ? h('button.btn', { onclick: () => { step--; draw(); } }, 'Back') : h('span'), next);
  }
  const m = modal('New campaign', [stepsBox, body], () => [foot]);
  draw();
}
