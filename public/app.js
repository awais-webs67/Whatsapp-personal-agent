import { h, set, svg, ico, GET, POST, PUT, act, toggle, field, toast } from './ui.js';
import { S, subs } from './state.js';
import { inbox } from './pages-main.js';
import { followups, numbers, models } from './pages-ops.js';
import { playground, settings, activity } from './pages-config.js';
import { command } from './pages-command.js';
import { clients, viewingBanner } from './pages-hub.js';
import { reports } from './pages-reports.js';
import { campaigns } from './pages-campaigns.js';
import { emailPage } from './pages-email.js';

const root = document.getElementById('root');
const PRIMARY = ['campaigns', 'inbox', 'numbers', 'command']; // in the phone's bottom bar

// Sidebar sections: work every day, setup once, see results.
const ROUTES = [
  ['campaigns', 'Campaigns', 'megaphone', campaigns, 'Manage'],
  ['inbox', 'Inbox', 'message-square-text', inbox, 'Manage'],
  ['numbers', 'Numbers', 'smartphone', numbers, 'Manage'],
  ['command', 'Command', 'terminal', command, 'Manage'],
  ['followups', 'Approvals', 'circle-check-big', followups, 'Manage'],
  ['email', 'Email', 'mail', emailPage, 'Assets'],
  ['models', 'AI models', 'cpu', models, 'Assets'],
  ['reports', 'Reports', 'chart-column', reports, 'Insights'],
  ['activity', 'Activity', 'activity', activity, 'Insights'],
  ['settings', 'Account', 'settings-2', settings, 'Account'],
];
// Pages reached from inside another page, not from the menu.
const HIDDEN = { playground: ['models', 'Compare models', 'flask-conical', playground] };

function shell(me) {
  const navLinks = {};
  const outlet = h('main');
  // Accounts (hub): the admin also manages clients; a client sees how much shared AI is left today.
  if (me?.role === 'admin' && !ROUTES.some((r) => r[0] === 'clients')) ROUTES.push(['clients', 'Clients', 'users', clients, 'Admin']);
  const banner = viewingBanner(me);
  const who = me ? h('small.muted', {}, me.viewing ? `Signed in as ${me.username}` : `${me.name || me.username}${!me.viewing && me.role === 'client' && me.sharedAi ? ` · AI today ${me.aiUsedToday}${me.aiDaily ? `/${me.aiDaily}` : ''}` : ''}`) : null;
  const pilot = toggle(S.autopilot, async (on) => {
    await act(null, () => PUT('/api/settings', { autopilot: on }), on ? 'Autopilot on: the agent replies by itself' : 'Autopilot off: nothing is sent automatically');
    S.autopilot = on;
  }, 'Agent on');
  const reader = toggle(true, async (on) => {
    await act(null, () => PUT('/api/settings', { reading: { auto: on } }), on ? 'The agent keeps reading chats that change' : 'Reading new chats is off');
  }, 'Read new chats');
  const foot = h('div.foot', {},
    h('div.pilot', {}, h('span', {}, 'Agent on', h('small', {}, 'Master switch for all campaigns')), pilot),
    h('div.pilot', {}, h('span', {}, 'Read chats', h('small', {}, 'Keeps notes on chats that change')), reader),
    who,
    h('button.linkbtn', { onclick: () => POST('/api/auth/logout').then(() => location.reload()) }, 'Sign out'));
  // Phones: four main pages in the bottom bar; everything else (and the switches) under "More".
  const more = h('button.more', { type: 'button', 'aria-label': 'More pages and switches', onclick: () => openMore() }, ico('menu'), h('span', {}, 'More'));
  const aside = h('aside.nav', {},
    h('div.brand', {}, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'AivraSol'), h('small', {}, 'Agent desk'))),
    h('nav', { 'aria-label': 'Main' }, ROUTES.flatMap(([id, label, icon, , group], i) => [group && group !== ROUTES[i - 1]?.[4] ? h('div.navsec', {}, group) : null, (navLinks[id] = h(`a${PRIMARY.includes(id) ? '' : '.sec'}`, { href: `#/${id}` }, ico(icon), h('span', {}, label)))]).filter(Boolean), more),
    foot);
  function openMore() {
    const close = () => { veil.remove(); aside.append(foot); removeEventListener('hashchange', close); };
    const veil = h('div.sheet-veil', { onmousedown: (e) => e.target === veil && close() },
      h('div.sheet', { role: 'dialog', 'aria-label': 'More' },
        h('div.sheet-links', {}, ROUTES.filter(([id]) => !PRIMARY.includes(id)).map(([id, label, icon]) =>
          h(`a${location.hash.startsWith(`#/${id}`) ? '.on' : ''}`, { href: `#/${id}` }, ico(icon), h('span', {}, label)))),
        foot,
        h('button.btn', { type: 'button', onclick: () => close() }, 'Close')));
    addEventListener('hashchange', close);
    document.body.append(veil);
  }
  // Problems that need the owner (number disconnected, no model can answer, daily cap): always on top.
  const healthBox = h('div.health');
  const drawHealth = (list) => set(healthBox, (list || []).map((p) => h(`a.banner.${p.level === 'warn' ? 'warn' : 'bad'}`, { href: p.link || '#/campaigns', style: 'text-decoration:none' }, h('b', {}, '⚠ '), h('span', {}, p.text))));
  GET('/api/health').then(drawHealth).catch(() => {});
  const el = h('div.shell', {},
    aside,
    h('div', { style: 'display:flex;flex-direction:column;min-width:0' }, banner, healthBox, outlet));

  const badge = (id, n) => {
    navLinks[id].querySelector('.count')?.remove();
    if (n > 0) navLinks[id].append(h('span.count', {}, n));
  };
  let updatesUnseen = 0;
  const refreshBadges = async () => {
    const o = await GET('/api/overview').catch(() => null);
    if (!o) return;
    Object.assign(S, { accounts: o.accounts, providers: o.providers, autopilot: o.settings.autopilot, stats: o.stats, webhookBase: o.webhookBase });
    pilot.querySelector('input').checked = S.autopilot;
    reader.querySelector('input').checked = o.settings.reading !== false;
    badge('inbox', o.stats.needsHuman);
    badge('followups', o.stats.pendingFollowups);
    badge('campaigns', o.stats.activeTasks);
  };

  function route() {
    if (location.hash.startsWith('#/command')) { updatesUnseen = 0; badge('command', 0); }
    let [, id = 'campaigns', arg, sub] = location.hash.split('/');
    // Old addresses: everything about a campaign now lives inside the campaign.
    if (id === 'tasks' || id === 'overview' || id === '') id = 'campaigns';
    if (id === 'knowledge') { location.replace('#/campaigns/default/knowledge'); return; }
    const hidden = HIDDEN[id];
    const r = hidden ? [hidden[0], hidden[1], hidden[2], hidden[3]] : ROUTES.find((x) => x[0] === id) || ROUTES[0];
    subs.clear();
    for (const [key, a] of Object.entries(navLinks)) { a.classList.toggle('on', key === r[0]); a.toggleAttribute('aria-current', key === r[0]); }
    more.classList.toggle('on', !PRIMARY.includes(r[0]));
    set(outlet, r[3](arg, sub));
    document.title = `${r[1]} · AivraSol Agent Desk`;
  }
  addEventListener('hashchange', route);

  // One event stream for everything; reconnects by itself.
  const es = new EventSource('/api/events');
  let badgeTimer;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'accounts') S.accounts = e.data;
    if (e.type === 'health') drawHealth(e.data);
    if (e.type === 'providers') S.providers = e.data;
    for (const s of [...subs]) if (s.type === e.type || s.type === '*') s.fn(e.data, e);
    if (e.type === 'update') {
      // The agent reporting on its own: show it, and make it one click away.
      const note = h('div.toast.update', { role: 'status', onclick: () => { location.hash = '#/command'; note.remove(); } }, h('b', {}, 'Agent update'), h('div', { dir: 'auto' }, e.data.text.slice(0, 280)));
      document.getElementById('toasts').append(note);
      setTimeout(() => note.remove(), 12000);
      if (!location.hash.startsWith('#/command')) { updatesUnseen++; badge('command', updatesUnseen); }
    }
    if (['chat', 'followups', 'campaign', 'tasks'].includes(e.type)) { clearTimeout(badgeTimer); badgeTimer = setTimeout(refreshBadges, 600); }
  };
  refreshBadges().then(route);
  fixTimezone();
  return el;
}

/**
 * Servers usually run on UTC, which would put quiet hours (no messages at night) in the wrong place.
 * When the agent still uses UTC and this browser is elsewhere, use the browser's time zone.
 */
async function fixTimezone() {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const s = await GET('/api/settings').catch(() => null);
  if (!s || !here || !/^(UTC|Etc\/UTC|Etc\/GMT|GMT)$/i.test(s.followup?.timezone || '') || /^(UTC|Etc\/UTC|Etc\/GMT|GMT)$/i.test(here)) return;
  await PUT('/api/settings', { followup: { timezone: here } }).catch(() => null);
  toast(`Time zone set to ${here}: quiet hours and schedules now follow your local time. Change it in Settings.`);
}

function authScreen(setup, multi) {
  const user = multi ? h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', required: true, value: setup ? 'admin' : '' }) : null;
  const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : 1 });
  const btn = h('button.btn.primary', { type: 'submit' }, setup ? 'Create password' : 'Sign in');
  return h('div.auth', {},
    h('aside', {},
      h('div.brand', { style: 'border:0;padding:0' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'AivraSol'), h('small', {}, 'Agent desk'))),
      h('div', {}, h('h1', {}, 'Every chat answered', h('br'), h('span', {}, 'like you would.')),
        h('p', {}, 'Your WhatsApp numbers, your sales knowledge and any AI model you choose, working one conversation at a time.'))),
    h('form', { onsubmit: (e) => { e.preventDefault(); act(btn, async () => { await POST(setup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value, ...(user ? { username: user.value.trim() } : {}) }); location.reload(); }); } },
      h('h2', {}, setup ? (multi ? 'Create the admin account' : 'Set an owner password') : 'Welcome back'),
      setup && h('p.muted', {}, 'This dashboard controls your WhatsApp numbers. Pick a strong password; it is the only way in.'),
      user && field('Username', user, setup ? 'You manage the other accounts with it.' : null),
      field('Password', pw, setup ? 'At least 8 characters' : null), btn));
}

const auth = await GET('/api/auth').catch(() => ({ setup: false, authed: false }));
const me = auth.authed && auth.multi ? await GET('/api/hub/me').catch(() => null) : null;
set(root, auth.authed ? shell(me) : authScreen(auth.setup, auth.multi));
if (!auth.authed) root.querySelector('input')?.focus();
