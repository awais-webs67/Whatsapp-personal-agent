// Clients: the admin creates accounts, each with its own WhatsApp numbers, knowledge and models,
// and decides whether they may use the admin's AI models (and how many requests a day).
import { h, set, GET, POST, PATCH, DEL, act, toast, modal, field, toggle, num } from './ui.js';

const STATUS = { running: ['Running', 'ok'], starting: ['Starting', 'warn'], stopped: ['Stopped', 'bad'], disabled: ['Switched off', ''] };

export function clients() {
  const list = h('div.stack');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Clients'),
      h('p', {}, 'Each account gets its own dashboard: its own WhatsApp numbers, chats, knowledge and AI models. Nobody sees anyone else\'s data. You can lend them your AI models with a daily limit, or they add their own keys.'))),
    h('div.stack', {}, addCard(() => load()), list));

  async function load() {
    const users = await GET('/api/hub/users').catch((e) => { toast(e.message, true); return []; });
    const clientsOnly = users.filter((u) => u.role === 'client');
    set(list, clientsOnly.length ? clientsOnly.map((u) => row(u, load)) : h('div.card', {}, h('div.pad.muted', {}, 'No client accounts yet. Add one above.')));
  }
  load();
  return el;
}

function addCard(done) {
  const name = h('input', { type: 'text', placeholder: 'Ali Traders' });
  const username = h('input', { type: 'text', placeholder: 'alitraders', autocomplete: 'off', autocapitalize: 'none' });
  const password = h('input', { type: 'text', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
  const shared = h('input', { type: 'checkbox', checked: true });
  const daily = h('input', { type: 'number', min: 0, value: 300 });
  const btn = h('button.btn.primary', { onclick: () => act(btn, async () => {
    await POST('/api/hub/users', { name: name.value, username: username.value, password: password.value, sharedAi: shared.checked, aiDaily: Number(daily.value) || 0 });
    toast(`Account created. Give them: username ${username.value} and the password.`);
    name.value = username.value = password.value = '';
    done();
  }) }, 'Create account');
  return h('div.card', {}, h('header', {}, h('h2', {}, 'Add an account')), h('div.pad.stack', {},
    h('div.grid2', {}, field('Business name', name), field('Username', username, 'They sign in with this.')),
    h('div.grid2', {}, field('Password', password, 'Send it to them; they can change it in Settings.'),
      field('Shared AI requests per day', daily, '0 = no limit. One customer reply is about one request.')),
    h('label.row', {}, shared, h('span', {}, 'Let them use my AI models')),
    h('div.row', {}, btn)));
}

function row(u, reload) {
  const [label, tone] = STATUS[u.status] || [u.status, ''];
  const daily = h('input', { type: 'number', min: 0, value: u.aiDaily, style: 'width:90px', 'aria-label': 'Shared AI requests per day' });
  const save = (patch, msg) => act(null, async () => { await PATCH(`/api/hub/users/${u.id}`, patch); await reload(); }, msg);
  const open = h('button.btn.primary.sm', { disabled: u.disabled, onclick: () => act(open, async () => { await POST('/api/hub/view', { id: u.id }); location.hash = '#/overview'; location.reload(); }) }, 'Open dashboard');
  return h('div.card', {},
    h('header', {}, h('div', {}, h('h2', {}, u.name || u.username), h('small.muted', {}, `Username: ${u.username}`)), h(`span.pill${tone ? `.${tone}` : ''}`, {}, label)),
    h('div.pad.stack', {},
      h('div.row', { style: 'flex-wrap:wrap' },
        h('span', {}, 'Use my AI models'), toggle(u.sharedAi, (on) => save({ sharedAi: on }, on ? 'They can use your models now' : 'Your models were taken back'), 'Use my AI models'),
        h('span.muted', {}, 'Per day'), daily,
        h('button.btn.sm', { onclick: () => save({ aiDaily: Number(daily.value) || 0 }, 'Limit saved') }, 'Save'),
        h('span.muted', {}, `Used today: ${num(u.aiUsedToday)}${u.aiDaily ? ` of ${num(u.aiDaily)}` : ''}`)),
      h('div.row', { style: 'flex-wrap:wrap' },
        open,
        h('button.btn.sm', { disabled: u.disabled, onclick: (e) => act(e.target, async () => { await POST(`/api/hub/users/${u.id}/restart`); await reload(); }, 'Restarted') }, 'Restart'),
        h('button.btn.sm', { onclick: () => resetPassword(u) }, 'New password'),
        h('button.btn.sm', { onclick: () => save({ disabled: !u.disabled }, u.disabled ? 'Switched on' : 'Switched off: their agent stopped and they cannot sign in') }, u.disabled ? 'Switch on' : 'Switch off'),
        h('button.btn.sm.danger', { onclick: () => remove(u, reload) }, 'Delete'))));
}

function resetPassword(u) {
  const pw = h('input', { type: 'text', autocomplete: 'new-password', minlength: 8 });
  modal(`New password for ${u.name || u.username}`, [field('New password', pw, 'At least 8 characters. They are signed out everywhere.')],
    (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => { await PATCH(`/api/hub/users/${u.id}`, { password: pw.value }); close(); }, 'Password changed') }, 'Save')]);
}

function remove(u, reload) {
  modal(`Delete ${u.name || u.username}?`, [h('p', {}, 'Their agent stops and they can no longer sign in. Their data is moved to the data/deleted folder on the server, so it can still be restored by hand.')],
    (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => { await DEL(`/api/hub/users/${u.id}`); close(); await reload(); }, 'Account deleted') }, 'Delete account')]);
}

/** Shown at the top while the admin looks at a client's dashboard. */
export function viewingBanner(me) {
  if (!me?.viewing) return null;
  return h('div.banner.warn', {}, h('span', {}, `You are looking at ${me.viewing.name}'s dashboard. Changes here affect their agent.`),
    h('button.btn.sm', { onclick: () => act(null, async () => { await POST('/api/hub/view', { id: 0 }); location.hash = '#/clients'; location.reload(); }) }, 'Back to mine'));
}
