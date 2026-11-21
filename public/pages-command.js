import { h, set, GET, POST, PUT, PATCH, DEL, act, toggle, clock, rel } from './ui.js';
import { S, live } from './state.js';

const EXAMPLES = [
  'Pichle 5 din ki chats check karo, jin logon ne purchase nahi kiya unhein har 5 minute baad follow-up bhejo',
  'Aaj kitne naye log aaye aur kis ko meri zaroorat hai?',
  'Jo log Canva ke liye aaye thay unhein confirm karo ke offer abhi bhi available hai',
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
  const st = { threads: [], current: remembered(), rows: [], waiting: false, note: '' };
  const list = h('div.chatlist', { role: 'list', 'aria-label': 'Conversations' });
  const thread = h('div.thread', { style: 'flex:1' });
  const title = h('h2');
  const input = h('textarea', { dir: 'auto', rows: 2, placeholder: 'Tell the agent what to do, in your own words', 'aria-label': 'Command',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
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
    set(thread, st.rows.length ? st.rows.map((r) => r.role === 'owner'
      ? h('div.msg.me', { dir: 'auto' }, r.text, h('small', {}, clock(r.ts)))
      : h('div.msg', { dir: 'auto' }, r.text,
        r.steps?.length ? h('div.steps', {}, r.steps.map((s) => h(`div.step${s.result?.error ? '.bad' : ''}`, { title: JSON.stringify(s.args) }, h(`i.dia${s.result?.error ? '.bad' : '.ok'}`), STEP[s.action] || s.action, s.result?.error ? `: ${s.result.error}` : ''))) : null,
        h('small', {}, clock(r.ts))))
      : h('div.empty', { style: 'margin:auto;max-width:560px' }, h('b', {}, 'Give the agent a job'),
        'It can read chats, report numbers, run follow-ups on a schedule, message a customer, remember offers and learn from your site. Everything here is saved, and the agent remembers what you said earlier in this chat.',
        h('div.stack', { style: 'margin-top:16px;text-align:left' }, EXAMPLES.map((x) => h('button.chip', { style: 'white-space:normal;text-align:left;padding:8px 10px', onclick: () => { input.value = x; input.focus(); } }, x)))),
    st.waiting ? h('div.msg', { style: 'opacity:.7' }, 'Working on it…', st.note ? h('small', {}, st.note) : null) : null);
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
    const text = input.value.trim();
    if (!text || st.waiting) return;
    if (!st.current) { const { id } = await POST('/api/commands/threads'); st.current = id; remember(id); }
    input.value = ''; st.waiting = true; st.note = '';
    st.rows = [...st.rows, { role: 'owner', text, ts: Date.now() }];
    drawThread();
    act(send, () => POST('/api/commands', { text, thread: st.current })).finally(() => { st.waiting = false; loadRows(); loadThreads(); });
  } }, 'Send');

  const viaWa = toggle(true, (on) => act(null, () => PUT('/api/settings', { commandsViaWhatsApp: on }), on ? 'Commands from WhatsApp are on' : 'Commands from WhatsApp are off'), 'Accept commands from WhatsApp');
  GET('/api/settings').then((s) => { viaWa.querySelector('input').checked = s.commandsViaWhatsApp; });

  wrap.append(
    h('section.listcol', {},
      h('div.list-head', {}, h('div.row', {}, h('h1.grow', {}, 'Command'), h('button.btn.sm.primary', { onclick: startNew }, 'New chat')),
        h('label.row', { style: 'font-size:12px;gap:8px;color:var(--muted)' }, viaWa, 'Also take commands in WhatsApp “Message yourself”', S.accounts.some((a) => a.type === 'qr') ? '' : ' (needs a QR-linked number)')),
      list),
    h('section.threadcol', {},
      h('div.thread-head', {},
        h('button.btn.ghost.sm', { class: 'back', onclick: () => wrap.classList.remove('open') }, 'Back'),
        h('div.grow', {}, title, h('div.muted', { style: 'font-size:12px' }, 'Orders start as soon as you send them, and the agent reports progress here. Daily caps and quiet hours still apply.')),
        h('button.btn.sm', { onclick: rename }, 'Rename'),
        h('a.btn.sm', { href: '#/campaigns' }, 'Campaigns')),
      thread,
      h('div.composer', {}, input, send)));

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
