import { h, set, GET, POST, PUT, act, toast, modal, field, toggle, clock, num, stagePill } from './ui.js';
import { S, live } from './state.js';
import { logRow } from './pages-main.js';

// ============================== Live test ==============================
export function playground() {
  const st = { tab: 'agent' };
  const tabs = h('div.tabs', { role: 'tablist' });
  const body = h('div');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Live test'), h('p', {}, 'Try things safely. Nothing here is sent to WhatsApp or saved to a chat.'))),
    tabs, body);
  const draw = () => {
    set(tabs, ...[['agent', 'Talk to your agent'], ['compare', 'Compare models']].map(([id, label]) => h(`button${st.tab === id ? '.on' : ''}`, { role: 'tab', 'aria-selected': st.tab === id, onclick: () => { st.tab = id; draw(); } }, label)));
    set(body, st.tab === 'agent' ? agentSim() : compare());
  };
  draw();
  return el;
}

function agentSim() {
  let turns = [];
  let last = null;
  const thread = h('div.thread');
  const info = h('div.card');
  const input = h('textarea', { rows: 1, placeholder: 'Write as a customer would, e.g. “price kya hai?”', 'aria-label': 'Customer message', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
  const drawThread = (thinking) => {
    set(thread, ...(turns.length ? turns.map((t) => h(`div.msg${t.role === 'assistant' ? '.me.ai' : ''}`, {}, t.content)) : [h('div.empty', { style: 'margin:auto' }, h('b', {}, 'Play the customer'), 'Send a message and see exactly what your agent would reply, and which model answered.')]),
      thinking ? h('div.msg.me.ai', { style: 'opacity:.6' }, 'typing…') : '');
    thread.scrollTop = thread.scrollHeight;
  };
  const drawInfo = () => set(info, h('header', {}, h('h2', {}, 'What the agent decided')),
    last ? h('div.pad.stack', {},
      h('div.kv', {}, 'Stage', stagePill(last.stage)),
      h('div.kv', {}, 'Answered by', h('b', {}, last.provider)),
      h('div.kv', {}, 'Model', h('b.mono', {}, last.model)),
      h('div.kv', {}, 'Thinking time', h('b', {}, `${(last.latencyMs / 1000).toFixed(1)}s`)),
      last.followupHours ? h('div.kv', {}, 'Would follow up in', h('b', {}, `${last.followupHours}h`)) : null,
      last.summary ? h('div', {}, h('div.muted', { style: 'font-size:12px' }, 'Summary'), h('div', { style: 'color:var(--ink)' }, last.summary)) : null,
      last.handoff ? h('div.note.bad', {}, h('b', {}, 'Would hand over to you. '), last.handoffReason || '') : null,
      last.hops?.length ? h('div.note.warn', {}, h('b', {}, 'Failover happened. '), last.hops.map((x) => `${x.provider}: ${(x.skipped || x.error).replace('_', ' ')}`).join(' → ')) : null)
      : h('div.empty', {}, 'Stage, summary and the serving model show up here after the first reply.'));
  const send = h('button.btn.primary', { onclick: () => {
    const text = input.value.trim();
    if (!text) return;
    turns.push({ role: 'user', content: text });
    input.value = '';
    drawThread(true);
    act(send, async () => {
      try {
        last = await POST('/api/playground/agent', { messages: turns, stage: last?.stage || 'new' });
        for (const m of last.messages) turns.push({ role: 'assistant', content: m });
      } finally { drawThread(false); drawInfo(); }
    });
  } }, 'Send');
  drawThread(false); drawInfo();
  return h('div.sim', {},
    h('div', {}, thread, h('div.composer', {}, input, send)),
    h('div.stack', {}, info,
      h('div.row', {}, h('button.btn.sm', { onclick: () => { turns = []; last = null; drawThread(false); drawInfo(); } }, 'Start over'),
        h('button.btn.sm', { onclick: (e) => act(e.target, async () => { const { system } = await GET('/api/playground/prompt'); modal('Instructions the agent receives', h('pre.out', { style: 'max-height:60vh;overflow:auto' }, system)); }) }, 'See its instructions'))));
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

// ============================== Knowledge ==============================
export function knowledge() {
  const el = h('div.page', {}, h('div.head', {}, h('div', {}, h('h1', {}, 'Knowledge'), h('p', {}, 'Everything the agent knows about your business comes from this page. It will not quote a price or policy that is not written here; it hands the chat to you instead.'))));
  GET('/api/settings').then((s) => {
    const b = s.business;
    const f = {};
    const area = (key, label, hint, rows = 4, ph = '') => field(label, (f[key] = h('textarea', { rows, placeholder: ph, value: b[key] || '' })), hint);
    const line = (key, label, hint, ph = '') => field(label, (f[key] = h('input', { type: 'text', placeholder: ph, value: b[key] || '' })), hint);
    const save = h('button.btn.primary', { onclick: () => act(save, () => PUT('/api/settings', { business: Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])) }), 'Knowledge saved. The agent uses it from the next message.') }, 'Save knowledge');
    el.append(h('div.stack', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'Who is talking')), h('div.pad.stack', {},
        h('div.grid2', {}, line('name', 'Business name', null, 'AivraSol'), line('persona', 'Agent name and role', 'How it introduces itself.', 'Sara from the sales team')),
        area('about', 'About the business', 'One short paragraph: what you do, who for, where.', 3))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'What you sell')), h('div.pad.stack', {},
        area('catalog', 'Products, services and prices', 'One per line works best. Include price, what is included, delivery time.', 8, 'Business website (5 pages) — Rs 45,000 — delivered in 7 days\nOnline store — Rs 90,000 — 14 days — includes payment setup'),
        area('faqs', 'Common questions and your answers', null, 6, 'Q: Do you offer installments?\nA: Yes, 50% advance and 50% on delivery.'),
        area('policies', 'Payment, delivery and refund rules', null, 4),
        line('purchaseSignal', 'What counts as a sale', 'The agent marks a chat “Purchased” when it sees this.'))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'How it should sound')), h('div.pad.stack', {},
        area('tone', 'Tone', null, 2), area('language', 'Language', null, 2),
        area('examples', 'A few real replies of yours', 'Paste 5 to 15 messages you actually sent customers. This is the strongest way to make it sound like you.', 7))),
      h('div.row', {}, save, h('a.btn', { href: '#/playground' }, 'Try it in Live test'))));
  });
  return el;
}

// ============================== Settings ==============================
export function settings() {
  const el = h('div.page', {}, h('div.head', {}, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Pacing that keeps conversations natural, and limits that keep your numbers safe.'))));
  GET('/api/settings').then((s) => {
    const inputs = [];
    const n = (group, key, label, hint, step = 1) => { const i = h('input', { type: 'number', step, min: 0, value: s[group][key] }); inputs.push([group, key, i]); return field(label, i, hint); };
    const pair = (group, a, b, label, hint) => {
      const x = h('input', { type: 'number', min: 0, step: 'any', value: s[group][a], 'aria-label': `${label} from` }), y = h('input', { type: 'number', min: 0, step: 'any', value: s[group][b], 'aria-label': `${label} to` });
      inputs.push([group, a, x], [group, b, y]);
      return h('label.f', {}, label, h('div.row', {}, x, h('span.muted', {}, 'to'), y), hint && h('small', {}, hint));
    };
    const fuOn = toggle(s.followup.enabled, () => {}, 'Automatic follow-ups'), fuApprove = toggle(s.followup.approval, () => {}, 'Approve before sending');
    const steps = h('input', { type: 'text', value: s.followup.stepsHours.join(', ') });
    const tz = h('input', { type: 'text', value: s.followup.timezone });
    const save = h('button.btn.primary', { onclick: () => act(save, async () => {
      const patch = { human: {}, followup: {}, llm: {} };
      for (const [g, k, i] of inputs) patch[g][k] = Number(i.value) || 0;
      Object.assign(patch.followup, { enabled: fuOn.querySelector('input').checked, approval: fuApprove.querySelector('input').checked, timezone: tz.value.trim(),
        stepsHours: steps.value.split(/[,\s]+/).map(Number).filter((x) => x > 0) });
      await PUT('/api/settings', patch);
    }, 'Settings saved') }, 'Save settings');
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' });
    el.append(h('div.stack', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'Reply pacing')), h('div.pad.stack', {},
        h('div.grid3', {},
          pair('human', 'debounceMin', 'debounceMax', 'Wait for them to finish (sec)', 'Several quick messages get one answer.'),
          pair('human', 'readMin', 'readMax', 'Delay before “read” (sec)'),
          pair('human', 'typingCpsMin', 'typingCpsMax', 'Typing speed (chars/sec)', 'Longer replies show “typing…” longer.')),
        h('div.grid3', {},
          n('human', 'typingMaxSec', 'Longest typing time (sec)'),
          pair('human', 'gapMin', 'gapMax', 'Pause between bubbles (sec)'),
          n('human', 'maxRepliesPerHour', 'Max AI replies per hour, per number', 'A safety brake. Past this, chats wait for you.')),
        h('div.grid3', {}, n('human', 'handoffMinutes', 'Stay quiet after I reply (min)', 'When you answer from your phone, the agent steps back.')))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Follow-ups')), h('div.pad.stack', {},
        h('div.row', {}, fuOn, h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, 'Follow up automatically when a lead goes quiet'))),
        h('div.row', {}, fuApprove, h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, 'Ask me before sending'), h('div.muted', {}, 'Drafts wait in Follow-ups until you approve them. Recommended.'))),
        h('div.grid3', {}, field('Follow up after (hours)', steps, 'One entry per follow-up. “24, 72, 168” = after 1, 3 and 7 days of silence, then stop.'),
          n('followup', 'dailyCap', 'Max follow-ups per day, per number'), pair('followup', 'gapMinSec', 'gapMaxSec', 'Gap between follow-ups (sec)')),
        h('div.grid3', {}, pair('followup', 'quietStart', 'quietEnd', 'Quiet hours (24h clock)', 'No follow-ups are sent between these hours.'), field('Time zone', tz, 'e.g. Asia/Karachi')))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Model calls')), h('div.pad', {}, h('div.grid3', {},
        n('llm', 'historyMessages', 'Messages of history per reply', 'More context, more tokens.'), n('llm', 'maxTokens', 'Max tokens per reply', 'Raise this if a reasoning model returns empty answers.'), n('llm', 'timeoutSec', 'Give up on a model after (sec)', 'Then the next model in the chain is tried.')))),
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
