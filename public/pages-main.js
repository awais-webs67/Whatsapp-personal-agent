import { h, set, GET, POST, PATCH, act, toast, select, rel, clock, dayLabel, num, STAGES, stagePill, PROVIDER_STATUS } from './ui.js';
import { S, live } from './state.js';

const ACCOUNT_STATE = { connected: ['Connected', 'ok'], connecting: ['Connecting', 'warn'], qr: ['Scan QR', 'hot'], pairing: ['Enter code', 'hot'], logged_out: ['Logged out', 'bad'], error: ['Error', 'bad'], disconnected: ['Offline', ''] };
export const accountPill = (a) => { const [label, tone] = ACCOUNT_STATE[a.status.state] || ACCOUNT_STATE.disconnected; return h(`span.pill${tone ? `.${tone}` : ''}`, {}, label); };

/** The failover chain drawn as a line with stops; the first ready stop is the one serving now. */
export function chainRail(providers) {
  const enabled = providers.filter((p) => p.enabled);
  if (!enabled.length) return h('div.empty', {}, h('b', {}, 'No AI model yet'), 'The agent needs at least one model to think with.', h('div', {}, h('a.btn.primary', { href: '#/models' }, 'Add a model')));
  const active = enabled.find((p) => p.status === 'ready');
  return h('div.rail', {}, enabled.map((p) => {
    const down = p.status !== 'ready';
    const [label] = PROVIDER_STATUS[p.status] || [p.status];
    return h(`div.stop${p === active ? '.active' : ''}${down ? '.down' : ''}`, {},
      h(`i.dia${p === active ? '.live' : down ? '.bad' : ''}`),
      h('b', { title: p.name }, p.name), h('span', { title: p.model }, p.model),
      h('em', {}, p === active ? 'Serving now' : down ? `${label}${p.cooldownUntil ? ` · back ${rel(p.cooldownUntil)}` : ''}` : 'Standby'));
  }));
}

export function overview() {
  const el = h('div.page');
  let logs = [];
  const draw = (o) => {
    const s = o.stats;
    const total = o.stages.reduce((n, x) => n + x.n, 0) || 1;
    const needsSetup = !o.accounts.length || !o.providers.length;
    set(el, 
      h('div.head', {}, h('div', {}, h('h1', {}, 'Overview'), h('p', {}, o.settings.autopilot ? 'The agent is answering new leads on its own.' : 'Autopilot is off. Messages are stored, nothing is sent automatically.'))),
      h('div.stack', {},
        needsSetup && h('div.card', {}, h('header', {}, h('h2', {}, 'Get started')),
          h('div.pad.stack', {}, [
            ['Add an AI model', 'Paste an API key from any provider. Add two or more and the agent switches when one runs out.', '#/models', o.providers.length > 0],
            ['Teach it your business', 'Products, prices, FAQs and how you talk to customers.', '#/knowledge', false],
            ['Link a WhatsApp number', 'Scan a QR code, or connect the official Business API.', '#/numbers', o.accounts.length > 0],
          ].map(([t, d, href, done], i) => h('div.row', {}, h(`i.dia${done ? '.ok' : '.hot'}`), h('div.grow', {}, h('b', { style: 'color:var(--ink)' }, `${i + 1}. ${t}`), h('div.muted', {}, d)), h('a.btn.sm', { href }, done ? 'Review' : 'Open'))))),
        h('div.tiles', {}, [
          ['New leads', s.newLeads24h], ['Messages in', s.inbound24h], ['AI replies', s.aiReplies24h], ['Follow-ups', s.followups24h], ['Need you', s.needsHuman, true], ['Purchased', s.purchased],
        ].map(([label, n, alert]) => h(`div.tile${alert && n ? '.alert' : ''}`, {}, h('b', {}, num(n)), h('span', {}, label, label === 'Purchased' || label === 'Need you' ? '' : ' · 24h')))),
        h('div.card', {}, h('header', {}, h('h2', {}, 'Model chain'), h('a.btn.sm', { href: '#/models' }, 'Manage')), h('div', { id: 'rail' }, chainRail(o.providers))),
        h('div.grid2', {},
          h('div.card', {}, h('header', {}, h('h2', {}, 'Numbers'), h('a.btn.sm', { href: '#/numbers' }, 'Manage')),
            o.accounts.length ? o.accounts.map((a) => h('div.acct', {}, h('div', {}, h('h3', {}, a.name), h('div.muted', {}, a.status.me ? `+${a.status.me}` : a.type === 'qr' ? 'WhatsApp app (QR)' : 'Business Cloud API', ` · ${num(a.chats)} chats`)), accountPill(a)))
              : h('div.empty', {}, h('b', {}, 'No number linked'), 'Link one to start receiving chats.')),
          h('div.card', {}, h('header', {}, h('h2', {}, 'Pipeline'), h('span.muted', {}, `${num(s.chats)} contacts`)),
            h('div.pad', {},
              h('div.stagebar', {}, o.stages.map((x) => h('i', { style: `width:${(x.n / total) * 100}%;background:${STAGES[x.stage]?.[1] || '#ccc'}`, title: `${STAGES[x.stage]?.[0]}: ${x.n}` }))),
              h('div.legend', {}, Object.entries(STAGES).map(([k, [label, color]]) => h('span', {}, h('i.dia', { style: `background:${color}` }), label, h('b', {}, num(o.stages.find((x) => x.stage === k)?.n || 0)))))))),
        h('div.card', {}, h('header', {}, h('h2', {}, 'Latest activity'), h('a.btn.sm', { href: '#/activity' }, 'All activity')),
          logs.length ? h('div.logs', {}, logs.slice(0, 8).map(logRow)) : h('div.empty', {}, 'Nothing yet.'))));
  };
  const load = async () => { const [o, l] = await Promise.all([GET('/api/overview'), GET('/api/logs')]); logs = l; draw(o); };
  load().catch((e) => toast(e.message, true));
  let t;
  const soon = () => { clearTimeout(t); t = setTimeout(() => load().catch(() => {}), 500); };
  for (const type of ['chat', 'accounts', 'followups', 'settings', 'history']) live.on(type, soon);
  live.on('providers', (p) => { const r = el.querySelector('#rail'); if (r) set(r, chainRail(p)); });
  return el;
}

export const logRow = (l) => h('div', {}, h('time', {}, clock(l.ts)), h('span.sc', {}, l.scope), h(`span.${l.level}`, {}, l.msg));

// ---------------------------------------------------------------------------------------------
export function inbox(openId) {
  const st = { q: '', stage: '', filter: '', id: openId ? Number(openId) : null, chats: [] };
  const list = h('div.chatlist', { role: 'list' });
  const threadCol = h('section.threadcol');
  const side = h('aside.side');
  const el = h(`div.inbox${st.id ? '.open' : ''}`);

  const chip = (label, patch, on) => h(`button.chip${on ? '.on' : ''}`, { onclick: () => { Object.assign(st, patch); drawHead(); loadList(); } }, label);
  const headChips = h('div.chips');
  const drawHead = () => set(headChips, 
    chip('All', { stage: '', filter: '' }, !st.stage && !st.filter),
    chip('Needs you', { stage: '', filter: 'needs_human' }, st.filter === 'needs_human'),
    chip('Unread', { stage: '', filter: 'unread' }, st.filter === 'unread'),
    ['interested', 'negotiating', 'purchased', 'not_interested'].map((s) => chip(STAGES[s][0], { stage: s, filter: '' }, st.stage === s)));
  let qt;
  const listCol = h('section.listcol', {},
    h('div.list-head', {}, h('h1', {}, 'Inbox'),
      h('input', { type: 'search', placeholder: 'Search name, number or text', 'aria-label': 'Search chats', oninput: (e) => { st.q = e.target.value; clearTimeout(qt); qt = setTimeout(loadList, 250); } }),
      headChips),
    list);
  el.append(listCol, threadCol, side);

  function drawList() {
    if (!st.chats.length) return set(list, h('div.empty', {}, h('b', {}, st.q || st.stage || st.filter ? 'No chats match' : 'No chats yet'), st.q || st.stage || st.filter ? 'Try another filter.' : 'Chats appear here as soon as a linked number receives a message.'));
    set(list, ...st.chats.map((c) => h(`div.chatrow${c.id === st.id ? '.on' : ''}`, { role: 'listitem', tabindex: 0, onclick: () => open(c.id), onkeydown: (e) => e.key === 'Enter' && open(c.id) },
      h('b', {}, c.title), h('time', {}, rel(c.last_msg_at)),
      h('p', {}, c.last_text || ''),
      h('div.tags', {}, c.needs_human ? h('i.dia.bad', { title: 'Needs you' }) : c.auto ? h('i.dia.hot', { title: 'Agent is handling this chat' }) : null, c.unread ? h('span.badge', {}, c.unread) : null))));
  }
  async function loadList() {
    const p = new URLSearchParams({ q: st.q, stage: st.stage, filter: st.filter });
    st.chats = await GET(`/api/chats?${p}`);
    drawList();
  }

  function open(id) {
    st.id = id;
    history.replaceState(null, '', `#/inbox/${id}`);
    el.classList.add('open');
    drawList();
    loadThread(true);
  }

  async function loadThread(scroll) {
    if (!st.id) {
      set(threadCol, h('div.empty', { style: 'margin:auto' }, h('b', {}, 'Pick a conversation'), 'Read it, step in, or let the agent carry on.'));
      set(side, );
      return;
    }
    const { chat, messages, followups } = await GET(`/api/chats/${st.id}`);
    if (chat.unread) PATCH(`/api/chats/${chat.id}`, { read: true }).catch(() => {});
    const patch = (body, msg) => act(null, () => PATCH(`/api/chats/${chat.id}`, body), msg).then(() => loadThread());

    const prevThread = threadCol.querySelector('.thread');
    const stick = scroll || !prevThread || prevThread.scrollHeight - prevThread.scrollTop - prevThread.clientHeight < 80;
    const draft = threadCol.querySelector('textarea')?.value || '';

    const bubbles = [];
    let lastDay = '';
    for (const m of messages) {
      const d = dayLabel(m.ts);
      if (d !== lastDay) { bubbles.push(h('div.day', {}, d)); lastDay = d; }
      const who = { ai: 'Agent', owner: 'You', followup: 'Follow-up', customer: '' }[m.by];
      bubbles.push(h(`div.msg${m.from_me ? `.me.${m.by}` : ''}`, {}, m.text, h('small', {}, [who, clock(m.ts)].filter(Boolean).join(' · '))));
    }
    for (const f of followups) bubbles.push(h('div.msg.me.followup', {}, f.text, h('small', {}, f.status === 'pending' ? 'Follow-up draft · waiting for your approval' : 'Follow-up · queued to send')));
    const thread = h('div.thread', {}, bubbles.length ? bubbles : h('div.empty', {}, 'No messages stored for this chat.'));

    const input = h('textarea', { rows: 1, placeholder: 'Write a reply. Enter to send, Shift+Enter for a new line.', 'aria-label': 'Reply', value: draft,
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); } } });
    const sendBtn = h('button.btn.primary', { onclick: () => { const text = input.value.trim(); if (text) act(sendBtn, async () => { await POST(`/api/chats/${chat.id}/send`, { text }); input.value = ''; }); } }, 'Send');
    const suggestBtn = h('button.btn', { title: 'Let the agent draft a reply for you to edit', onclick: () => act(suggestBtn, async () => { const d = await POST(`/api/chats/${chat.id}/suggest`); input.value = d.messages.join('\n\n'); input.focus(); toast(`Draft from ${d.provider}`); }) }, 'Draft');

    set(threadCol, 
      h('div.thread-head', {},
        h('button.btn.ghost.sm', { class: 'back', onclick: () => { st.id = null; el.classList.remove('open'); history.replaceState(null, '', '#/inbox'); drawList(); loadThread(); } }, 'Back'),
        h('div.grow', {}, h('h2', {}, chat.title), h('div.muted', { style: 'font-size:12px' }, chat.phone ? `+${chat.phone} · ` : '', chat.accountName)),
        stagePill(chat.stage),
        h(`span.pill${chat.auto ? '.hot' : ''}`, { title: chat.autoReason || 'The agent answers this chat on its own' }, chat.auto ? 'Agent on' : 'Agent off')),
      chat.needs_human ? h('div.banner.bad', {}, h('div.grow', {}, h('b', {}, 'Needs you. '), chat.handoff_reason || 'The agent asked for help.'), h('button.btn.sm', { onclick: () => patch({ resume: true }, 'Agent resumed') }, 'Hand back to agent')) : null,
      !chat.needs_human && chat.paused_until > Date.now() ? h('div.banner.warn', {}, h('div.grow', {}, `You replied by hand, so the agent is quiet until ${clock(chat.paused_until)}.`), h('button.btn.sm', { onclick: () => patch({ resume: true }, 'Agent resumed') }, 'Resume now')) : null,
      thread,
      h('div.composer', {}, input, suggestBtn, sendBtn));
    if (stick) thread.scrollTop = thread.scrollHeight;

    const notes = h('textarea', { rows: 4, placeholder: 'Anything the agent should know about this customer', value: chat.notes || '', onblur: (e) => e.target.value !== (chat.notes || '') && patch({ notes: e.target.value }, 'Notes saved') });
    set(side, 
      h('section', {}, h('h2', {}, 'Stage'), select(Object.entries(STAGES).map(([k, [l]]) => [k, l]), chat.stage, (v) => patch({ stage: v }), { 'aria-label': 'Stage' })),
      h('section', {}, h('h2', {}, 'Agent on this chat'),
        select([['auto', `Follow the number's rule`], ['on', 'Always answer'], ['off', 'Never answer']], chat.ai_enabled === null ? 'auto' : chat.ai_enabled ? 'on' : 'off', (v) => patch({ aiEnabled: v === 'auto' ? null : v === 'on' }), { 'aria-label': 'Agent mode' }),
        !chat.auto && chat.autoReason ? h('div.muted', { style: 'font-size:12px' }, `Not answering: ${chat.autoReason}.`) : null),
      h('section', {}, h('h2', {}, 'Summary'), h('div', { style: 'color:var(--ink)' }, chat.summary || h('span.muted', {}, 'The agent writes this as the chat goes on.'))),
      h('section', {}, h('h2', {}, 'Notes for the agent'), notes),
      h('section', {}, h('h2', {}, 'Details'),
        h('div.kv', {}, 'Lead type', h('b', {}, chat.is_new ? 'New (after linking)' : 'Existing contact')),
        h('div.kv', {}, 'Last from them', h('b', {}, rel(chat.last_in_at))),
        h('div.kv', {}, 'Follow-ups sent', h('b', {}, chat.followup_count)),
        h('div.kv', {}, 'Next follow-up', h('b', {}, chat.next_followup_at ? rel(chat.next_followup_at) : 'None'))));
  }

  let lt;
  live.on('chat', ({ chatId }) => { clearTimeout(lt); lt = setTimeout(loadList, 300); if (chatId === st.id) loadThread(); });
  live.on('history', () => { clearTimeout(lt); lt = setTimeout(loadList, 800); });
  live.on('followups', () => st.id && loadThread());
  drawHead();
  loadList().catch((e) => toast(e.message, true));
  loadThread(true).catch((e) => toast(e.message, true));
  return el;
}
export { S };
