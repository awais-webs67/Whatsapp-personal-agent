import { h, set, ico, autosize, GET, POST, PUT, PATCH, DEL, act, toggle, clock, rel, copyText, toast } from './ui.js';
import { S, live } from './state.js';

const EXAMPLES = [
  'Pichle 5 din ki chats check karo, jin logon ne purchase nahi kiya unhein har 5 minute baad follow-up bhejo',
  'Aaj kitne naye log aaye aur kis ko meri zaroorat hai?',
  'Jo log logo design ke liye aaye thay unhein batao ke offer abhi bhi available hai',
  'Roz raat 9 baje aaj ka report do',
  'Yaad rakho: is hafte sab packages par 10% discount hai',
];
const STEP = {
  stats: 'Looked at the numbers', find_chats: 'Searched chats', read_chat: 'Read a chat', count_targets: 'Counted who this reaches', start_followups: 'Started a follow-up batch',
  stop_followups: 'Stopped follow-ups', send_message: 'Sent a message', update_chat: 'Updated a chat', remember: 'Saved an instruction', learn: 'Learned', set_autopilot: 'Changed autopilot',
  schedule_task: 'Scheduled a task', remind: 'Scheduled a reminder', analyse_chats: 'Started reading the chats', list_tasks: 'Checked the tasks', pause_task: 'Paused a task', resume_task: 'Resumed a task', remove_task: 'Removed a task',
};
const KIND = { whatsapp: 'WhatsApp', tasks: 'Scheduled', updates: 'Updates' };
const remembered = () => { try { return Number(localStorage.getItem('cmdThread')) || null; } catch { return null; } };
const remember = (id) => { try { localStorage.setItem('cmdThread', String(id || '')); } catch { /* private mode */ } };

/** Conversations with the agent, saved like chats. The same works from WhatsApp's "Message yourself" chat. */
export function command() {
  const st = { threads: [], current: remembered(), rows: [], waiting: false, note: '', reply: null };
  const list = h('div.chatlist', { role: 'list', 'aria-label': 'Conversations' });
  const thread = h('div.thread', { style: 'flex:1' });
  const title = h('h2');
  const input = h('textarea', { dir: 'auto', rows: 1, placeholder: 'Tell the agent what to do, in your own words', 'aria-label': 'Command',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
  autosize(input);
  const wrap = h('div.inbox.cmd');

  function drawList() {
    if (!st.threads.length) return set(list, h('div.empty', {}, 'No conversations yet.'));
    set(list, st.threads.map((t) => h(`div.chatrow${t.id === st.current ? '.on' : ''}`, { role: 'listitem', tabindex: 0, onclick: () => open(t.id), onkeydown: (e) => e.key === 'Enter' && open(t.id) },
      h('b', { dir: 'auto' }, t.title), h('time', {}, rel(t.updated_at)),
      h('p', { dir: 'auto' }, KIND[t.kind] ? `${KIND[t.kind]} · ` : '', t.last_text || 'Empty'),
      h('div.tags', {}, h('button.linkbtn', { title: 'Delete this conversation', 'aria-label': `Delete ${t.title}`, style: 'color:var(--muted)', onclick: (e) => { e.stopPropagation(); remove(t); } }, '✕')))));
  }

  function drawThread() {
    const t = st.threads.find((x) => x.id === st.current);
    set(title, t ? t.title : 'New chat');
    const asking = (r, i) => i === st.rows.length - 1 && r.role !== 'owner' && r.steps?.some((s) => s.result?.confirm);
    const answer = (word) => { input.value = word; send.click(); };
    // Each message can be copied, or answered with a quote of it.
    const actions = (r) => h('div.mact', {},
      h('button', { type: 'button', title: 'Reply to this', 'aria-label': 'Reply', onclick: () => { st.reply = r.text; drawReply(); input.focus(); } }, ico('reply', 'sm')),
      h('button', { type: 'button', title: 'Copy', 'aria-label': 'Copy', onclick: () => copyText(r.text) }, ico('copy', 'sm')));
    const quoteOf = (text) => { const m = /^↪ "([\s\S]*?)"\n([\s\S]*)$/.exec(text); return m ? [m[1], m[2]] : [null, text]; };
    set(thread, st.rows.length ? st.rows.map((r, i) => {
      const [q, text] = quoteOf(r.text);
      return r.role === 'owner'
        ? h('div.cmsg-row.me', {}, h('div.msg.me', { tabindex: 0 }, q ? h('div.quote', { dir: 'auto' }, q) : null, h('div.mtext', { dir: 'auto' }, text), h('small', {}, clock(r.ts)), actions(r)))
        : h('div.cmsg-row', {}, h('span.botav', { 'aria-hidden': 'true' }, ico('bot', 'sm')),
          h('div.msg.agent', { tabindex: 0 }, h('div.mtext', { dir: 'auto' }, r.text),
            asking(r, i) ? h('div.confirm', {}, h('button.btn.sm.primary', { onclick: () => answer('Haan') }, ico('check', 'sm'), 'Haan, kar do'), h('button.btn.sm', { onclick: () => answer('Nahi') }, 'Nahi')) : null,
            r.steps?.length && !asking(r, i) ? h('div.steps', {}, r.steps.map((s) => h(`div.step${s.result?.error ? '.bad' : ''}`, { title: JSON.stringify(s.args) }, h(`i.dia${s.result?.error ? '.bad' : '.ok'}`), STEP[s.action] || s.action.replace(/_/g, ' '), s.result?.error ? `: ${s.result.error}` : ''))) : null,
            h('small', {}, clock(r.ts)), actions(r)));
    })
      : h('div.empty', { style: 'margin:auto;max-width:560px' }, h('b', {}, 'Give the agent a job'),
        'It can read chats, report numbers, run follow-ups on a schedule, message a customer, remember offers and learn from your site. Everything here is saved, and the agent remembers what you said earlier in this chat.',
        h('div.stack', { style: 'margin-top:16px;text-align:left' }, EXAMPLES.map((x) => h('button.chip', { style: 'white-space:normal;text-align:left;padding:8px 10px', onclick: () => { input.value = x; input.focus(); } }, x)))),
    st.waiting ? h('div.cmsg-row', {}, h('span.botav', { 'aria-hidden': 'true' }, ico('bot', 'sm')), h('div.msg.agent.typing', {}, h('span.dots', {}, h('i'), h('i'), h('i')), h('span', {}, st.note || 'Working on it…'))) : null);
    thread.scrollTop = thread.scrollHeight;
  }

  async function loadThreads() { st.threads = await GET('/api/commands/threads'); if (st.current && !st.threads.some((t) => t.id === st.current)) st.current = null; drawList(); }
  async function loadRows() { st.rows = st.current ? await GET(`/api/commands?thread=${st.current}`) : []; drawThread(); }
  function open(id) { st.current = id; remember(id); wrap.classList.add('open'); drawList(); loadRows(); }
  function startNew() { st.current = null; remember(null); st.rows = []; wrap.classList.add('open'); drawList(); drawThread(); input.focus(); }
  function remove(t) {
    if (!confirm(`Delete "${t.title}"? Its messages are removed. Tasks it started keep running.`)) return;
    act(null, () => DEL(`/api/commands/threads/${t.id}`)).then(() => { if (st.current === t.id) startNew(); loadThreads(); });
  }
  function rename() {
    const t = st.threads.find((x) => x.id === st.current);
    const name = t && prompt('Name this conversation', t.title);
    if (name) act(null, () => PATCH(`/api/commands/threads/${t.id}`, { title: name })).then(loadThreads);
  }

  const send = h('button.btn.primary', { onclick: async () => {
    let text = input.value.trim();
    if (!text || st.waiting) return;
    // A reply carries the message it answers, so the agent knows what "this" is.
    if (st.reply) { text = `↪ "${st.reply.slice(0, 400)}"\n${text}`; st.reply = null; drawReply(); }
    if (!st.current) { const { id } = await POST('/api/commands/threads'); st.current = id; remember(id); }
    input.value = ''; input.style.height = ''; st.waiting = true; st.note = '';
    st.rows = [...st.rows, { role: 'owner', text, ts: Date.now() }];
    drawThread();
    act(send, () => POST('/api/commands', { text, thread: st.current })).finally(() => { st.waiting = false; loadRows(); loadThreads(); });
  } }, ico('send', 'sm'), h('span', {}, 'Send'));
  const replyBar = h('div.replybar');
  const drawReply = () => set(replyBar, st.reply ? [ico('reply', 'sm'), h('div.grow', { dir: 'auto' }, h('b', {}, 'Replying to'), h('span', {}, st.reply)), h('button.iconbtn.dark', { type: 'button', 'aria-label': 'Cancel reply', onclick: () => { st.reply = null; drawReply(); } }, ico('x', 'sm'))] : []);

  const viaWa = toggle(true, (on) => act(null, () => PUT('/api/settings', { commandsViaWhatsApp: on }), on ? 'Commands from WhatsApp are on' : 'Commands from WhatsApp are off'), 'Accept commands from WhatsApp');
  GET('/api/settings').then((s) => { viaWa.querySelector('input').checked = s.commandsViaWhatsApp; });

  wrap.append(
    h('section.listcol', {},
      h('div.list-head', {}, h('div.row', {}, h('h1.grow', {}, 'Command'), h('button.btn.sm.primary', { onclick: startNew }, 'New chat')),
        h('label.row', { style: 'font-size:12px;gap:8px;color:var(--muted)' }, viaWa, 'Also take commands in WhatsApp “Message yourself”', S.accounts.some((a) => a.type === 'qr') ? '' : ' (needs a QR-linked number)')),
      list),
    h('section.threadcol', {},
      h('div.thread-head', {},
        h('button.iconbtn.dark', { class: 'back', 'aria-label': 'Back to conversations', onclick: () => wrap.classList.remove('open') }, ico('arrow-left')),
        h('span.botav.big', { 'aria-hidden': 'true' }, ico('bot')),
        h('div.grow.th-name', {}, title, h('div.muted', {}, 'Orders start as soon as you send them. Daily caps and quiet hours still apply.')),
        h('button.iconbtn.dark', { title: 'Rename this conversation', 'aria-label': 'Rename', onclick: rename }, ico('pencil', 'sm'))),
      thread,
      h('div.compose-wrap', {}, replyBar, h('div.composer', {}, input, h('div.composer-act', {}, send)))));

  live.on('command', (d) => { loadThreads(); if (!d?.thread || d.thread === st.current) loadRows(); });
  // Show what the agent is doing while it waits (rate-limit pauses, model switches).
  live.on('log', (l) => {
    if (!st.waiting || !['router', 'command', 'tasks'].includes(l.scope)) return;
    const action = l.scope === 'command' ? l.msg.split(' ')[0] : null;
    st.note = action ? `${STEP[action] || action.replace(/_/g, ' ')}…` : l.msg;
    drawThread();
  });
  loadThreads().then(() => { if (!st.current && st.threads[0]) st.current = st.threads[0].id; drawList(); loadRows(); });
  if (st.current) wrap.classList.add('open');
  return wrap;
}
