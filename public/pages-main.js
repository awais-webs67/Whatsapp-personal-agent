import { h, set, GET, POST, PATCH, PUT, act, toast, modal, field, select, rel, clock, dayLabel, num, STAGES, stagePill, leadPill, PROVIDER_STATUS } from './ui.js';
import { S, live } from './state.js';

const ACCOUNT_STATE = { connected: ['Connected', 'ok'], connecting: ['Connecting', 'warn'], qr: ['Scan QR', 'hot'], pairing: ['Enter code', 'hot'], logged_out: ['Logged out', 'bad'], error: ['Error', 'bad'], disconnected: ['Offline', ''] };
export const accountPill = (a) => { const [label, tone] = ACCOUNT_STATE[a.status.state] || ACCOUNT_STATE.disconnected; return h(`span.pill${tone ? `.${tone}` : ''}`, {}, label); };

export const logRow = (l) => h('div', {}, h('time', {}, clock(l.ts)), h('span.sc', {}, l.scope), h(`span.${l.level}`, {}, l.msg));

// ---------------------------------------------------------------------------------------------
export function inbox(openId) {
  // #/inbox/n3 = the chats of number 3; #/inbox/c5 = the chats of campaign 5; #/inbox/42 = open chat 42.
  const byNumber = /^n\d+$/.test(openId || '') ? Number(openId.slice(1)) : '';
  const byCampaign = /^c\d+$/.test(openId || '') ? Number(openId.slice(1)) : '';
  const st = { q: '', stage: '', filter: '', account: byNumber, campaign: byCampaign, id: /^\d+$/.test(openId || '') ? Number(openId) : null, chats: [] };
  const list = h('div.chatlist', { role: 'list' });
  const threadCol = h('section.threadcol');
  const side = h('aside.side');
  const el = h(`div.inbox${st.id ? '.open' : ''}`);

  const chip = (label, patch, on) => h(`button.chip${on ? '.on' : ''}`, { onclick: () => { Object.assign(st, patch); drawHead(); loadList(); } }, label);
  const headChips = h('div.chips');
  const drawHead = () => set(headChips, 
    chip('All', { stage: '', filter: '' }, !st.stage && !st.filter),
    chip('Hot leads', { stage: '', filter: 'hot' }, st.filter === 'hot'),
    chip('Needs you', { stage: '', filter: 'needs_human' }, st.filter === 'needs_human'),
    chip('Unread', { stage: '', filter: 'unread' }, st.filter === 'unread'),
    ['interested', 'negotiating', 'purchased', 'not_interested'].map((s) => chip(STAGES[s][0], { stage: s, filter: '' }, st.stage === s)));
  let qt;
  const campaignPick = h('select', { 'aria-label': 'Campaign', onchange: (e) => { st.campaign = e.target.value; loadList(); } }, h('option', { value: '' }, 'All campaigns'));
  GET('/api/tasks').then((ts) => campaignPick.append(...ts.filter((x) => ['auto', 'batch'].includes(x.kind)).map((x) => h('option', { value: x.id, selected: String(st.campaign) === String(x.id) }, `#${x.id} ${x.title}`)))).catch(() => {});
  const listCol = h('section.listcol', {},
    h('div.list-head', {}, h('h1', {}, 'Inbox'),
      h('input', { type: 'search', placeholder: 'Search name, number or text', 'aria-label': 'Search chats', oninput: (e) => { st.q = e.target.value; clearTimeout(qt); qt = setTimeout(loadList, 250); } }),
      h('div.grid2', { style: 'gap:8px' },
        h('select', { 'aria-label': 'Number', onchange: (e) => { st.account = e.target.value; loadList(); } }, [h('option', { value: '' }, 'All numbers'), ...S.accounts.map((a) => h('option', { value: a.id, selected: String(st.account) === String(a.id) }, a.name))]),
        campaignPick),
      headChips,
      h('a.btn.sm', { href: '/api/chats/export.csv', download: '', title: 'Your customers as a spreadsheet: name, number, stage, tags, summary' }, 'Download customers (CSV)')),
    list);
  el.append(listCol, threadCol, side);

  function drawList() {
    if (!st.chats.length) return set(list, h('div.empty', {}, h('b', {}, st.q || st.stage || st.filter ? 'No chats match' : 'No chats yet'), st.q || st.stage || st.filter ? 'Try another filter.' : 'Chats appear here as soon as a linked number receives a message.'));
    set(list, ...st.chats.map((c) => h(`div.chatrow${c.id === st.id ? '.on' : ''}`, { role: 'listitem', tabindex: 0, onclick: () => open(c.id), onkeydown: (e) => e.key === 'Enter' && open(c.id) },
      h('b', {}, c.title), h('time', {}, rel(c.last_msg_at)),
      h('p', { dir: 'auto' }, c.last_text || ''),
      h('div.tags', {}, leadPill(c.lead), c.needs_human ? h('i.dia.bad', { title: 'Needs you' }) : c.auto ? h('i.dia.hot', { title: 'Agent is handling this chat' }) : null, c.unread ? h('span.badge', {}, c.unread) : null))));
  }
  async function loadList() {
    const p = new URLSearchParams({ q: st.q, stage: st.stage, filter: st.filter, account: st.account || '', campaign: st.campaign || '' });
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
    for (const f of followups) bubbles.push(h('div.msg.me.followup', { dir: 'auto' }, f.text, h('small', {}, f.kind === 'reminder' ? `Reminder · sends ${new Date(f.due_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : f.status === 'pending' ? 'Follow-up draft · waiting for your approval' : 'Follow-up · queued to send')));
    const thread = h('div.thread', {}, bubbles.length ? bubbles : h('div.empty', {}, 'No messages stored for this chat.'));

    const input = h('textarea', { dir: 'auto', rows: 1, placeholder: 'Write a reply, or type / for agent commands (never sent to the customer)', 'aria-label': 'Reply', value: draft,
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); } } });
    const hints = h('div.cmdhints.hide');
    const showHints = () => {
      const v = input.value.trim();
      if (!/^[/#]/.test(v) || v.includes(' ')) return hints.classList.add('hide');
      const q = v.slice(1).toLowerCase();
      GET('/api/chat-commands').then((list) => {
        const rows = list.filter((c) => c.cmd.startsWith(q));
        set(hints, rows.map((c) => h('button.cmdhint', { type: 'button', onclick: () => { input.value = `/${c.cmd.split(' ')[0]} `; input.focus(); hints.classList.add('hide'); } }, h('b.mono', {}, `/${c.cmd}`), h('span', {}, c.about))));
        hints.classList.toggle('hide', !rows.length);
      });
    };
    input.addEventListener('input', showHints);
    const sendBtn = h('button.btn.primary', { onclick: () => {
      const text = input.value.trim();
      if (!text) return;
      // A command for the agent, never sent to the customer.
      if (/^[/#][a-z]+/i.test(text)) return act(sendBtn, async () => { const r = await POST(`/api/chats/${chat.id}/command`, { text }); input.value = ''; hints.classList.add('hide'); toast(r.reply.split('\n')[0]); if (r.reply.includes('\n')) modal('Agent', h('pre.out', {}, r.reply)); });
      act(sendBtn, async () => { await POST(`/api/chats/${chat.id}/send`, { text }); input.value = ''; });
    } }, 'Send');
    const remindBtn = h('button.btn', { title: 'Send this customer a message at a set time', onclick: () => {
      const msg = h('textarea', { rows: 3, dir: 'auto', value: input.value, placeholder: 'e.g. Assalam o alaikum! Aap ka order aaj expire ho raha hai, renew karna ho to bata dein.' });
      const when = h('input', { type: 'datetime-local' });
      const d = new Date(Date.now() + 3_600_000); d.setMinutes(0, 0, 0);
      when.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      modal(`Reminder for ${chat.title}`, [field('Message', msg, 'Sent exactly as written. Quiet hours do not apply to reminders.'), field('When', when)], (close) => [
        h('button.btn', { onclick: close }, 'Cancel'),
        h('button.btn.primary', { onclick: (e) => act(e.target, async () => { await POST(`/api/chats/${chat.id}/remind`, { text: msg.value, at: new Date(when.value).toISOString() }); close(); }, 'Reminder scheduled') }, 'Schedule')]);
    } }, 'Remind');
    const suggestBtn = h('button.btn', { title: 'Let the agent draft a reply for you to edit', onclick: () => act(suggestBtn, async () => { const d = await POST(`/api/chats/${chat.id}/suggest`); input.value = d.messages.join('\n\n'); input.focus(); toast(`Draft from ${d.provider}`); }) }, 'Draft');

    set(threadCol, 
      h('div.thread-head', {},
        h('button.btn.ghost.sm', { class: 'back', onclick: () => { st.id = null; el.classList.remove('open'); history.replaceState(null, '', '#/inbox'); drawList(); loadThread(); } }, 'Back'),
        h('div.grow', {}, h('h2', {}, chat.title), h('div.muted', { style: 'font-size:12px' }, chat.phone ? `+${chat.phone} · ` : '', chat.accountName)),
        leadPill(chat.lead), stagePill(chat.stage),
        h(`span.pill${chat.auto ? '.hot' : ''}`, { title: chat.autoReason || 'The agent answers this chat on its own' }, chat.auto ? 'Agent on' : 'Agent off')),
      chat.needs_human ? h('div.banner.bad', {}, h('div.grow', {}, h('b', {}, 'Needs you. '), chat.handoff_reason || 'The agent asked for help.'), h('button.btn.sm', { onclick: () => patch({ resume: true }, 'Agent resumed') }, 'Hand back to agent')) : null,
      !chat.needs_human && chat.paused_until > Date.now() ? h('div.banner.warn', {}, h('div.grow', {}, `You replied by hand, so the agent is quiet until ${clock(chat.paused_until)}.`), h('button.btn.sm', { onclick: () => patch({ resume: true }, 'Agent resumed') }, 'Resume now')) : null,
      thread,
      h('div', { style: 'position:relative' }, hints, h('div.composer', {}, input, remindBtn, suggestBtn, sendBtn)));
    if (stick) thread.scrollTop = thread.scrollHeight;

    const tagsBox = h('input', { type: 'text', placeholder: 'vip, eid-ad, repeat', value: (chat.tagList || []).join(', '), onblur: (e) => e.target.value !== (chat.tagList || []).join(', ') && patch({ tags: e.target.value }, 'Tags saved') });
    const notes = h('textarea', { rows: 4, placeholder: 'Anything the agent should know about this customer', value: chat.notes || '', onblur: (e) => e.target.value !== (chat.notes || '') && patch({ notes: e.target.value }, 'Notes saved') });
    set(side, 
      h('section', {}, h('h2', {}, 'Stage'), select(Object.entries(STAGES).map(([k, [l]]) => [k, l]), chat.stage, (v) => patch({ stage: v }), { 'aria-label': 'Stage' })),
      h('section', {}, h('h2', {}, 'Agent on this chat'),
        select([['auto', `Follow the number's rule`], ['on', 'Always answer'], ['off', 'Never answer']], chat.ai_enabled === null ? 'auto' : chat.ai_enabled ? 'on' : 'off', (v) => patch({ aiEnabled: v === 'auto' ? null : v === 'on' }), { 'aria-label': 'Agent mode' }),
        !chat.auto && chat.autoReason ? h('div.muted', { style: 'font-size:12px' }, `Not answering: ${chat.autoReason}.`) : null),
      h('section', {}, h('h2', {}, 'Summary'), h('div', { style: 'color:var(--ink)' }, chat.summary || h('span.muted', {}, 'The agent writes this as the chat goes on.'))),
      profileCard(chat),
      h('section', {}, h('h2', {}, 'Tags'), tagsBox, h('div.muted', { style: 'font-size:12px' }, 'Your own labels. Later: "vip tag walon ko follow-up bhejo" in Command.')),
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

/** What the agent remembers about this customer (kept even when the AI model changes). */
function profileCard(chat) {
  let p = {};
  try { p = JSON.parse(chat.profile || '{}') || {}; } catch { /* empty */ }
  const row = (label, v) => (v && (!Array.isArray(v) || v.length) ? h('div.kv', {}, label, h('b', { dir: 'auto' }, Array.isArray(v) ? v.join(', ') : v)) : null);
  const rows = [row('Asked about', p.wants), row('Holding back', p.objections), row('Bought', p.bought), row('We promised', p.promised), row('Budget', p.budget), row('Next step', p.next), row('Came from ad', chat.ad_title)].filter(Boolean);
  return h('section', {}, h('h2', {}, 'Customer card'), rows.length ? h('div.stack', { style: 'gap:6px' }, rows) : h('div.muted', { style: 'font-size:12.5px' }, 'Filled in as the agent reads this chat.'));
}
