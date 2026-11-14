import { h, set, svg, GET, POST, PUT, act, toggle, field } from './ui.js';
import { S, subs } from './state.js';
import { overview, inbox } from './pages-main.js';
import { followups, numbers, models } from './pages-ops.js';
import { playground, knowledge, settings, activity } from './pages-config.js';
import { command } from './pages-command.js';
import { tasks } from './pages-tasks.js';

const root = document.getElementById('root');

const ROUTES = [
  ['overview', 'Overview', 'M2 2h5v6H2zM9 2h5v3H9zM9 7h5v7H9zM2 10h5v4H2z', overview],
  ['command', 'Command', 'M2 3h12v10H2zM4 6l3 2-3 2M8 10h4', command],
  ['tasks', 'Tasks', 'M3 3h10v10H3zM5 6l1.5 1.5L9 5M5 10.5h6', tasks],
  ['inbox', 'Inbox', 'M2 3h12v8H7l-3 3v-3H2z', inbox],
  ['followups', 'Follow-ups', 'M8 2a6 6 0 1 0 6 6M8 5v3l2 2M11 2h3v3', followups],
  ['numbers', 'Numbers', 'M5 1h6v14H5zM7 12h2', numbers],
  ['models', 'Models', 'M2 8h3M11 8h3M5 5h6v6H5zM8 2v3M8 11v3', models],
  ['playground', 'Live test', 'M4 2l9 6-9 6z', playground],
  ['knowledge', 'Knowledge', 'M3 2h8l2 2v10H3zM5 6h6M5 9h6M5 12h4', knowledge],
  ['settings', 'Settings', 'M2 4h8M12 4h2M2 8h2M6 8h8M2 12h6M10 12h4M10 2v4M4 6v4M8 10v4', settings],
  ['activity', 'Activity', 'M1 8h3l2-5 3 10 2-5h4', activity],
];

function shell() {
  const navLinks = {};
  const outlet = h('main');
  const pilot = toggle(S.autopilot, async (on) => {
    await act(null, () => PUT('/api/settings', { autopilot: on }), on ? 'Autopilot on: the agent replies by itself' : 'Autopilot off: nothing is sent automatically');
    S.autopilot = on;
  }, 'Autopilot');
  const el = h('div.shell', {},
    h('aside.nav', {},
      h('div.brand', {}, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'AivraSol'), h('small', {}, 'Agent desk'))),
      h('nav', { 'aria-label': 'Main' }, ROUTES.map(([id, label, icon]) => (navLinks[id] = h('a', { href: `#/${id}` }, svg(icon), h('span', {}, label))))),
      h('div.foot', {},
        h('div.pilot', {}, h('span', {}, 'Autopilot', h('small', {}, 'Agent replies on its own')), pilot),
        h('button.linkbtn', { onclick: () => POST('/api/auth/logout').then(() => location.reload()) }, 'Sign out'))),
    outlet);

  const badge = (id, n) => {
    navLinks[id].querySelector('.count')?.remove();
    if (n > 0) navLinks[id].append(h('span.count', {}, n));
  };
  const refreshBadges = async () => {
    const o = await GET('/api/overview').catch(() => null);
    if (!o) return;
    Object.assign(S, { accounts: o.accounts, providers: o.providers, autopilot: o.settings.autopilot, stats: o.stats });
    pilot.querySelector('input').checked = S.autopilot;
    badge('inbox', o.stats.needsHuman);
    badge('followups', o.stats.pendingFollowups);
    badge('tasks', o.stats.activeTasks);
  };

  function route() {
    const [, id = 'overview', arg] = location.hash.split('/');
    const r = ROUTES.find((x) => x[0] === id) || ROUTES[0];
    subs.clear();
    for (const [key, a] of Object.entries(navLinks)) { a.classList.toggle('on', key === r[0]); a.toggleAttribute('aria-current', key === r[0]); }
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
    if (['chat', 'followups', 'campaign', 'tasks'].includes(e.type)) { clearTimeout(badgeTimer); badgeTimer = setTimeout(refreshBadges, 600); }
  };
  refreshBadges().then(route);
  return el;
}

function authScreen(setup) {
  const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : 1 });
  const btn = h('button.btn.primary', { type: 'submit' }, setup ? 'Create password' : 'Sign in');
  return h('div.auth', {},
    h('aside', {},
      h('div.brand', { style: 'border:0;padding:0' }, h('img', { src: '/favicon.svg', alt: '' }), h('div', {}, h('b', {}, 'AivraSol'), h('small', {}, 'Agent desk'))),
      h('div', {}, h('h1', {}, 'Every chat answered', h('br'), h('span', {}, 'like you would.')),
        h('p', {}, 'Your WhatsApp numbers, your sales knowledge and any AI model you choose, working one conversation at a time.'))),
    h('form', { onsubmit: (e) => { e.preventDefault(); act(btn, async () => { await POST(setup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value }); location.reload(); }); } },
      h('h2', {}, setup ? 'Set an owner password' : 'Welcome back'),
      setup && h('p.muted', {}, 'This dashboard controls your WhatsApp numbers. Pick a strong password; it is the only way in.'),
      field('Password', pw, setup ? 'At least 8 characters' : null), btn));
}

const auth = await GET('/api/auth').catch(() => ({ setup: false, authed: false }));
set(root, auth.authed ? shell() : authScreen(auth.setup));
if (!auth.authed) root.querySelector('input')?.focus();
