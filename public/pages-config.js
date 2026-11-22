import { h, set, ico, GET, POST, PUT, DEL, act, toast, modal, field, toggle, select, clock, num, stagePill, rel } from './ui.js';
import { S, live } from './state.js';
import { logRow } from './pages-main.js';

// ============================== Compare models ==============================
/** Send one message to several models side by side. Talking to a campaign's agent is in that campaign's Test tab. */
export function playground() {
  return h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Compare models'), h('p', {}, 'Send one message to several models and compare their answers and speed. To talk to a campaign’s agent, open the campaign and use its Test tab.')),
      h('a.btn', { href: '#/models' }, '← AI models')),
    compare());
}

function compare() {
  const picked = new Set(S.providers.filter((p) => p.enabled).slice(0, 3).map((p) => p.id));
  const system = h('textarea', { rows: 2, placeholder: 'Optional. e.g. You are a friendly sales assistant for a clothing store.' });
  const prompt = h('textarea', { rows: 3, placeholder: 'The message to send to every selected model' });
  const out = h('div.cmp');
  const run = h('button.btn.primary', { onclick: () => act(run, async () => {
    set(out, ...[...picked].map(() => h('div.card', {}, h('div.pad.muted', {}, 'Waiting…'))));
    const results = await POST('/api/playground/compare', { providerIds: [...picked], system: system.value, messages: [{ role: 'user', content: prompt.value }] });
    set(out, ...results.sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9)).map((r) => h('div.card', {},
      h('header', {}, h('div', {}, h('b', { style: 'color:var(--ink)' }, r.name), r.model ? h('div.mono.muted', {}, r.model) : null), r.ok ? h('span.pill.ok', {}, `${(r.latencyMs / 1000).toFixed(1)}s`) : h('span.pill.bad', {}, (r.kind || 'failed').replace('_', ' '))),
      h('div.pad', {}, r.ok ? [h('pre', {}, r.text), h('div.muted', { style: 'margin-top:10px;font-size:12px' }, `${num(r.usage.in)} tokens in · ${num(r.usage.out)} out`)] : h('div', { style: 'color:var(--danger)' }, r.error)))));
  }) }, 'Run on selected models');
  if (!S.providers.length) return h('div.card', {}, h('div.empty', {}, h('b', {}, 'No models yet'), 'Add one first.', h('div', {}, h('a.btn.primary', { href: '#/models' }, 'Add a model'))));
  return h('div.stack', {},
    h('div.card', {}, h('div.pad.stack', {},
      h('label.f', {}, 'Models', h('div.checks', {}, S.providers.map((p) => h('label', {}, h('input', { type: 'checkbox', checked: picked.has(p.id), onchange: (e) => (e.target.checked ? picked.add(p.id) : picked.delete(p.id)) }), p.name)))),
      field('System instruction', system), field('Message', prompt), h('div', {}, run))),
    out);
}

// ============================== Settings ==============================
export function settings() {
  const el = h('div.page', {}, h('div.head', {}, h('div', {}, h('h1', {}, 'Account'), h('p', {}, 'Master switches, safety limits and defaults for your whole account. Everything about one campaign is set inside that campaign.'))),
    h('div.scope', {},
      h('div', {}, h('div.scope-t', {}, ico('shield-check'), h('b', {}, 'Account (this page)')), h('span', {}, 'Only what is true for the whole account: the master switch, safety limits that protect each WhatsApp number, time zone, notifications and your password.')),
      h('div', {}, h('div.scope-t', {}, ico('megaphone'), h('b', {}, 'Everything else is per campaign')), h('span', {}, 'Knowledge, products and prices, numbers, replies, voice and pictures, reply speed, follow-ups, quiet hours, labels: open a campaign on ', h('a', { href: '#/campaigns' }, 'Campaigns'), ' and use its tabs.'))));
  Promise.all([GET('/api/settings'), GET('/api/settings/media').catch(() => ({}))]).then(([s, media]) => {
    // The switches save at once; each says whether it spends AI tokens.
    const sw = (on, label, hint, cost, patchOf) => h('label.cswitch', {}, h('div', {}, h('b', {}, label, ' ', h(`span.cost.${cost[0]}`, {}, cost[1])), h('span', {}, hint)),
      toggle(on, (v) => act(null, () => PUT('/api/settings', patchOf(v)), `${label}: ${v ? 'on' : 'off'}`), label));
    const head = (title, hint) => h('header', {}, h('div', {}, h('h2', {}, title), h('p.muted', { style: 'margin:3px 0 0;font-size:12.5px;text-transform:none;letter-spacing:0' }, hint)));
    el.append(
      h('div.card', { style: 'margin-bottom:16px' }, head('Master switches', 'For the whole account. Off here stops it in every campaign.'), h('div.cswitches.wide', {},
        sw(s.autopilot, 'Agent on (master switch)', 'Off: nothing is sent by itself in any campaign: no replies, no follow-ups. Each campaign also has its own switches.', ['mid', 'Tokens per reply'], (v) => ({ autopilot: v })),
        sw(s.reading?.auto !== false, 'Read chats in the background', 'Keeps each customer’s stage, summary and profile up to date. Off saves the most tokens; replies still work.', ['high', 'Most tokens'], (v) => ({ reading: { auto: v } })),
        sw(s.llm.tokenSaver !== false, 'Token saver', 'With a long product list, only the products this customer asks about are sent in full.', ['save', 'Saves tokens'], (v) => ({ llm: { tokenSaver: v } })))));
    const inputs = [];
    const n = (group, key, label, hint, step = 1) => { const i = h('input', { type: 'number', step, min: 0, value: s[group][key] }); inputs.push([group, key, i]); return field(label, i, hint); };
    const pair = (group, a, b, label, hint) => {
      const x = h('input', { type: 'number', min: 0, step: 'any', value: s[group][a], 'aria-label': `${label} from` }), y = h('input', { type: 'number', min: 0, step: 'any', value: s[group][b], 'aria-label': `${label} to` });
      inputs.push([group, a, x], [group, b, y]);
      return h('label.f', {}, label, h('div.row', {}, x, h('span.muted', {}, 'to'), y), hint && h('small', {}, hint));
    };
    const notifyWa = toggle(s.notifyWhatsApp !== false, () => {}, 'Send agent updates to my WhatsApp');
    const digest = h('input', { type: 'number', min: -1, max: 23, value: s.digestHour ?? 21 });
    const tz = h('input', { type: 'text', value: s.followup.timezone });
    const save = h('button.btn.primary', { onclick: () => act(save, async () => {
      const patch = { human: {}, followup: {}, llm: {} };
      for (const [g, k, i] of inputs) patch[g][k] = Number(i.value) || 0;
      patch.notifyWhatsApp = notifyWa.querySelector('input').checked;
      patch.digestHour = Number(digest.value);
      Object.assign(patch.followup, { timezone: tz.value.trim() });
      await PUT('/api/settings', patch);
    }, 'Settings saved') }, 'Save settings');
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' });
    el.append(h('div.stack', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'Number safety: limits for every campaign')), h('div.pad.stack', {},
        h('div.note', {}, 'Each campaign sets its own follow-up times, gap, quiet hours and daily limit in its Settings → Sending. These limits protect each WhatsApp number and always apply on top.'),
        h('div.grid3', {}, n('followup', 'dailyCap', 'Max proactive messages per day, per number'), n('followup', 'repeatGuardHours', 'One batch message per person per (hours)', 'A new batch skips people messaged this recently.'), field('Time zone', tz, 'e.g. Asia/Karachi')),
        h('div.grid3', {}, n('human', 'maxRepliesPerHour', 'Max AI replies per hour, per number', 'A safety brake. Past this, chats wait for you.'), n('human', 'handoffMinutes', 'Stay quiet after I reply (min)', 'When you answer from your phone, the agent steps back in that chat.'), h('div')),
        h('div.grid3', {}, pair('followup', 'quietStart', 'quietEnd', 'Default quiet hours (24h clock)', 'Used by campaigns that have no quiet hours of their own.')))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Agent updates')), h('div.pad.stack', {},
        h('div.row', {}, notifyWa, h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, 'Also send updates to my WhatsApp'), h('div.muted', {}, 'Task progress, customers who need you, sales and the daily summary go to your “Message yourself” chat (write anything there once so the agent knows it). They always appear on the Command page.'))),
        h('div.grid3', {}, field('Daily summary at (hour, 0–23; -1 = off)', digest, 'Uses the time zone below.')))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Model calls')), h('div.pad.stack', {},
        h('div.grid3', {},
        n('llm', 'historyMessages', 'Messages of history per reply', 'More context, more tokens. 12 is plenty for most sales chats.'), n('llm', 'maxTokens', 'Max tokens per reply', 'Raise this if a reasoning model returns empty answers.'), n('llm', 'timeoutSec', 'Give up on a model after (sec)', 'Then the next model in the chain is tried.')))),
      h('div', {}, save),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Owner password')), h('div.pad', {}, h('div.grid3', { style: 'align-items:end' }, field('Current password', cur), field('New password', next),
        h('button.btn', { onclick: (e) => act(e.target, async () => { await POST('/api/settings/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; }, 'Password changed') }, 'Change password'))))));
  });
  return el;
}

// ============================== Activity ==============================
export function activity() {
  const box = h('div.logs');
  const el = h('div.page', {}, h('div.head', {}, h('div', {}, h('h1', {}, 'Activity'), h('p', {}, 'What the agent did and why: model switches, handoffs, follow-ups and connection changes.'))), h('div.card', {}, box));
  GET('/api/logs').then((logs) => set(box, ...(logs.length ? logs.map(logRow) : [h('div.empty', { style: 'display:block' }, 'Nothing yet.')])));
  live.on('log', (l) => { box.querySelector('.empty')?.remove(); box.prepend(logRow(l)); while (box.children.length > 400) box.lastChild.remove(); });
  return el;
}
export { clock };
