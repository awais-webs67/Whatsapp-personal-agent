import { h, set, svg, GET, POST, PUT, act, toggle, field, toast } from './ui.js';
import { S, subs } from './state.js';
import { overview, inbox } from './pages-main.js';
import { followups, numbers, models } from './pages-ops.js';
import { playground, knowledge, settings, activity } from './pages-config.js';
import { command } from './pages-command.js';
import { tasks } from './pages-tasks.js';
import { clients, viewingBanner } from './pages-hub.js';

const root = document.getElementById('root');
const PRIMARY = ['overview', 'inbox', 'command', 'tasks']; // in the phone's bottom bar

const ROUTES = [
  ['overview', 'Overview', 'M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z', overview],
  ['command', 'Command', 'M2 3h12v10H2zM4 6l3 2-3 2M8 10h4', command],
  ['tasks', 'Campaigns', 'M3 3h10v10H3zM5 6l1.5 1.5L9 5M5 10.5h6', tasks],
  ['inbox', 'Inbox', 'M2 3h12v8H7l-3 3v-3H2z', inbox],
  ['followups', 'Follow-ups', 'M8 2a6 6 0 1 0 6 6M8 5v3l2 2M11 2h3v3', followups],
  ['numbers', 'Numbers', 'M5 1h6v14H5zM7 12h2', numbers],
  ['models', 'Models', 'M2 8h3M11 8h3M5 5h6v6H5zM8 2v3M8 11v3', models],
  ['playground', 'Live test', 'M4 2l9 6-9 6z', playground],
  ['knowledge', 'Knowledge', 'M3 2h8l2 2v10H3zM5 6h6M5 9h6M5 12h4', knowledge],
  ['settings', 'Settings', 'M2 4h8M12 4h2M2 8h2M6 8h8M2 12h6M10 12h4M10 2v4M4 6v4M8 10v4', settings],
  ['activity', 'Activity', 'M1 8h3l2-5 3 10 2-5h4', activity],
];

function shell(me) {
  const navLinks = {};
  const outlet = h('main');
  // Accounts (hub): the admin also manages clients; a client sees how much shared AI is left today.
  if (me?.role === 'admin' && !ROUTES.some((r) => r[0] === 'clients')) ROUTES.push(['clients', 'Clients', 'M5 6a2.5 2.5 0 1 0 0-.1M1 14c0-2.5 1.8-4 4-4s4 1.5 4 4M11 7a2 2 0 1 0 0-.1M10 10.2c2.5-.6 5 .8 5 3.8', clients]);
  const banner = viewingBanner(me);
  const who = me ? h('small.muted', {}, me.viewing ? `Signed in as ${me.username}` : `${me.name || me.username}${!me.viewing && me.role === 'client' && me.sharedAi ? ` · AI today ${me.aiUsedToday}${me.aiDaily ? `/${me.aiDaily}` : ''}` : ''}`) : null;
  const pilot = toggle(S.autopilot, async (on) => {
    await act(null, () => PUT('/api/settings', { autopilot: on }), on ? 'Autopilot on: the agent replies by itself' : 'Autopilot off: nothing is sent automatically');
    S.autopilot = on;
  }, 'Autopilot');
  const reader = toggle(true, async (on) => {
    await act(null, () => PUT('/api/settings', { reading: { auto: on } }), on ? 'The agent keeps reading chats that change' : 'Reading new chats is off');
  }, 'Read new chats');
  const foot = h('div.foot', {},
    h('div.pilot', {}, h('span', {}, 'Autopilot', h('small', {}, 'Agent replies on its own')), pilot),
    h('div.pilot', {}, h('span', {}, 'Read chats', h('small', {}, 'Keeps notes on chats that change')), reader),
    who,
    h('button.linkbtn', { onclick: () => POST('/api/auth/logout').then(() => location.reload()) }, 'Sign out'));
  // Phones: four main pages in the bottom bar; everything else (and the switches) under "More".
  const more = h('button.more', { type: 'button', 'aria-label': 'More pages and switches', onclick: () => openMore() }, svg('M3 4h10M3 8h10M3 12h10'), h('span', {}, 'More'));
  const aside = h('aside.nav', {},
    h('div.brand', {}, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'AivraSol'), h('small', {}, 'Agent desk'))),
    h('nav', { 'aria-label': 'Main' }, ROUTES.map(([id, label, icon]) => (navLinks[id] = h(`a${PRIMARY.includes(id) ? '' : '.sec'}`, { href: `#/${id}` }, svg(icon), h('span', {}, label)))), more),
    foot);
  function openMore() {
    const close = () => { veil.remove(); aside.append(foot); removeEventListener('hashchange', close); };
    const veil = h('div.sheet-veil', { onmousedown: (e) => e.target === veil && close() },
      h('div.sheet', { role: 'dialog', 'aria-label': 'More' },
        h('div.sheet-links', {}, ROUTES.filter(([id]) => !PRIMARY.includes(id)).map(([id, label, icon]) =>
          h(`a${location.hash.startsWith(`#/${id}`) ? '.on' : ''}`, { href: `#/${id}` }, svg(icon), h('span', {}, label)))),
        foot,
        h('button.btn', { type: 'button', onclick: () => close() }, 'Close')));
    addEventListener('hashchange', close);
    document.body.append(veil);
  }
  const el = h('div.shell', {},
    aside,
    banner ? h('div', { style: 'display:flex;flex-direction:column;min-width:0' }, banner, outlet) : outlet);

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
    badge('tasks', o.stats.activeTasks);
  };

  function route() {
    if (location.hash.startsWith('#/command')) { updatesUnseen = 0; badge('command', 0); }
    const [, id = 'overview', arg] = location.hash.split('/');
    const r = ROUTES.find((x) => x[0] === id) || ROUTES[0];
    subs.clear();
    for (const [key, a] of Object.entries(navLinks)) { a.classList.toggle('on', key === r[0]); a.toggleAttribute('aria-current', key === r[0]); }
    more.classList.toggle('on', !PRIMARY.includes(r[0]));
    set(outlet, r[3](arg));
    document.title = `${r[1]} · AivraSol Agent Desk`;
  }
  addEventListener('hashchange', route);

  // One event stream for everything; reconnects by itself.
  const es = new EventSource('/api/events');
  let badgeTimer;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'accounts') S.accounts = e.data;
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
