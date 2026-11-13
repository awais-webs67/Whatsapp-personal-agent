import { h, set, GET, POST, PUT, act, toast, modal, field, toggle, select, clock, num, stagePill } from './ui.js';
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
      last.usage ? h('div.kv', {}, 'Tokens used', h('b', {}, `${num(last.usage.in)} in · ${num(last.usage.out)} out`)) : null,
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
        h('label.f', {}, 'What the agent is for',
          h('div.chips', {}, Object.entries(GOALS).map(([label, text]) => h('button.chip', { type: 'button', onclick: () => { f.goal.value = text; } }, label))),
          (f.goal = h('textarea', { rows: 2, value: b.goal || '' })), h('small', {}, 'Pick a starting point or write your own. This decides what the agent tries to achieve in every chat.')),
        h('label.f', {}, 'When someone asks something unrelated', (f.offTopic = select([['redirect', 'Politely decline and steer back (recommended)'], ['brief', 'Answer quick harmless questions in one line, then steer back']], b.offTopic || 'redirect', null)),
          h('small', {}, 'Either way it never agrees to discounts, deals or promises that are not written on this page.')),
        area('about', 'About the business', 'One short paragraph: what you do, who for, where.', 3))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'What you sell')), h('div.pad.stack', {},
        area('catalog', 'Products, services and prices', 'One per line works best. Include price, what is included, delivery time.', 8, 'Business website (5 pages) — Rs 45,000 — delivered in 7 days\nOnline store — Rs 90,000 — 14 days — includes payment setup'),
        area('faqs', 'Common questions and your answers', null, 6, 'Q: Do you offer installments?\nA: Yes, 50% advance and 50% on delivery.'),
        area('policies', 'Payment, delivery and refund rules', null, 4),
        line('purchaseSignal', 'What counts as a sale', 'The agent marks a chat “Purchased” when it sees this.'))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'How it should sound')), h('div.pad.stack', {},
        area('tone', 'Tone', null, 2), area('language', 'Language', null, 2),
        area('examples', 'A few real replies of yours', 'Paste 5 to 15 messages you actually sent customers. This is the strongest way to make it sound like you.', 7))),
      learnCard(f, b),
      h('div.row', {}, save, h('a.btn', { href: '#/playground' }, 'Try it in Live test'))));
  });
  return el;
}

const GOALS = {
  Sales: 'Answer questions about what we offer and help the customer buy, without pressure.',
  Support: 'Help existing customers with questions and problems about their order or service. Solve what you can from the information here and hand over to the owner for anything else.',
  Bookings: 'Help the person book an appointment: find out what they need, offer the available options listed here, and confirm the details.',
  'Personal assistant': 'Reply on the owner\'s behalf: answer simple questions from the information here, take a message for anything else, and tell the person the owner will get back to them.',
};

/** Reads the owner's own past replies and writes down how they answer; the result stays editable. */
function learnCard(f, b) {
  f.learned = h('textarea', { rows: 10, placeholder: 'Nothing learned yet.', value: b.learned || '' });
  f.learnedWeb = h('textarea', { rows: 8, placeholder: 'Nothing read yet.', value: b.learnedWeb || '' });
  f.memory = h('textarea', { rows: 4, placeholder: '- Eid offer: 20% off until 30 June', value: b.memory || '' });
  const url = h('input', { type: 'text', inputmode: 'url', placeholder: 'https://yourshop.com' });
  const refill = async (msg) => { const s = await GET('/api/settings'); f.learnedWeb.value = s.business.learnedWeb || ''; toast(msg); };
  const webNote = h('div.muted', { style: 'font-size:12.5px' });
  const webBtn = h('button.btn', { onclick: () => act(webBtn, async () => {
    try {
      const r = await POST('/api/learn/website', { url: url.value });
      set(webNote, `${r.site}: ${r.products} products and ${r.pages} other pages read.${r.warning ? ` ${r.warning}` : ''}`);
      await refill(`Read ${r.products} products from ${r.site}. Check the text below.`);
    } catch (e) { set(webNote, h('span', { style: 'color:var(--danger)' }, e.message)); throw e; }
  }) }, 'Read website');
  live.on('weblearn', (w) => w.running && w.total && set(webNote, `Reading product pages: ${w.done} of ${w.total}…`));
  const profBtn = h('button.btn', { title: 'Uses the business profile and catalogue of your connected WhatsApp Business number', onclick: () => act(profBtn, async () => { await POST('/api/learn/profile'); await refill('Profile read. Check the text below.'); }) }, 'Read WhatsApp profile');
  const status = h('div');
  const btn = h('button.btn.dark', { onclick: () => act(btn, async () => draw(await POST('/api/learn', {}))) }, b.learned ? 'Learn again' : 'Learn from my chats');
  const draw = (l) => {
    if (l.running) return set(status, h('div.stack', {}, h('div.bar', {}, h('i', { style: `width:${l.total ? (l.done / l.total) * 100 : 0}%` })), h('span.muted', {}, `Reading ${num(l.chats)} conversations…`)));
    if (l.error) return set(status, h('div.note.bad', {}, l.error));
    if (l.finishedAt) { GET('/api/settings').then((s) => { f.learned.value = s.business.learned || ''; }); return set(status, h('div.note', {}, `Learned from ${num(l.chats)} conversations. Review the text below: old chats can contain old prices.`)); }
    set(status);
  };
  live.on('learning', draw);
  GET('/api/learn').then((l) => l.running && draw(l));
  return h('div.card', {}, h('header', {}, h('h2', {}, 'Train the agent'), btn), h('div.pad.stack', {},
    h('p', {}, 'Three ways to teach it without typing everything: your own past chats, your website, and your WhatsApp Business profile. Each one fills a text box you can edit. Old chats and pages can hold old prices, so skim the result.'),
    status,
    field('From your chats', f.learned, b.learnedAt ? `Last updated ${new Date(b.learnedAt).toLocaleString()}. Anything you write in the sections above wins over this.` : 'Needs a linked number with synced history.'),
    h('div.row.wrap', { style: 'align-items:flex-end' }, h('div.grow', { style: 'min-width:220px' }, field('Website to read', url, 'Reads every product (name, price, description) the site publishes, plus its about, FAQ and policy pages. Your shop or home page link is enough.')),
      h('div', { style: 'padding-bottom:22px' }, h('div.row', {}, webBtn, profBtn))),
    webNote,
    field('From your website and WhatsApp profile', f.learnedWeb),
    field('Standing instructions', f.memory, 'Things you told the agent to remember, e.g. a running offer. One per line. You can also add these by command: “remember that…”.')));
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
    const saver = toggle(s.llm.tokenSaver !== false, () => {}, 'Token saver');
    const fuOn = toggle(s.followup.enabled, () => {}, 'Automatic follow-ups'), fuApprove = toggle(s.followup.approval, () => {}, 'Approve before sending');
    const steps = h('input', { type: 'text', value: s.followup.stepsHours.join(', ') });
    const tz = h('input', { type: 'text', value: s.followup.timezone });
    const save = h('button.btn.primary', { onclick: () => act(save, async () => {
      const patch = { human: {}, followup: {}, llm: {} };
      for (const [g, k, i] of inputs) patch[g][k] = Number(i.value) || 0;
      patch.llm.tokenSaver = saver.querySelector('input').checked;
      Object.assign(patch.followup, { enabled: fuOn.querySelector('input').checked, approval: fuApprove.querySelector('input').checked, timezone: tz.value.trim(),
        stepsHours: steps.value.split(/[,\s]+/).map(Number).filter((x) => x > 0) });
      await PUT('/api/settings', patch);
    }, 'Settings saved') }, 'Save settings');
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }), next = h('input', { type: 'password', autocomplete: 'new-password' });
    el.append(h('div.stack', {},
      h('div.card', {}, h('header', {}, h('h2', {}, 'Reply pacing'), h('div.row', {}, h('span.muted', {}, 'Preset'), [['instant', 'Instant'], ['fast', 'Fast'], ['natural', 'Natural']].map(([id, label]) =>
        h('button.btn.sm', { title: { instant: 'Answers as soon as the model does', fast: 'A few seconds, still looks typed', natural: 'Slowest, most human-looking' }[id], onclick: (e) => act(e.target, async () => { const p = (await GET('/api/pacing'))[id]; for (const [g, k, i] of inputs) if (g === 'human' && k in p) i.value = p[k]; }, `${label} pacing filled in. Save to apply.`) }, label)))), h('div.pad.stack', {},
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
      h('div.card', {}, h('header', {}, h('h2', {}, 'Model calls')), h('div.pad.stack', {},
        h('div.row', {}, saver, h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, 'Token saver'), h('div.muted', {}, 'With long product lists, send only the products this customer is asking about in full, and the rest as name and price. Uses about 4 times fewer tokens with a large catalogue.'))),
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
