import { h, set, GET, POST, PUT, DEL, act, toggle, clock } from './ui.js';
import { S, live } from './state.js';

const EXAMPLES = [
  'Pichle 5 din ki chats check karo, jin logon ne purchase nahi kiya unhein har 5 minute baad follow-up bhejo',
  'Aaj kitne naye log aaye aur kis ko meri zaroorat hai?',
  'Jo log website package ke liye aaye thay unhein confirm karo ke offer abhi bhi available hai',
  'Remember: is hafte sab packages par 10% discount hai',
  'Meri website https://example.com se products seekh lo',
];
const STEP = { stats: 'Looked at the numbers', find_chats: 'Searched chats', read_chat: 'Read a chat', count_targets: 'Counted who this reaches', start_followups: 'Started a follow-up batch', stop_followups: 'Stopped follow-ups',
  send_message: 'Sent a message', update_chat: 'Updated a chat', remember: 'Saved an instruction', learn: 'Learned', set_autopilot: 'Changed autopilot' };

/** Tell the agent what to do in plain language. The same works from WhatsApp's "Message yourself" chat. */
export function command() {
  const thread = h('div.thread', { style: 'flex:1' });
  const input = h('textarea', { dir: 'auto', rows: 2, placeholder: 'Tell the agent what to do, in your own words', 'aria-label': 'Command',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
  let waiting = false;
  let note = '';
  let lastRows = [];
  const draw = (rows) => {
    set(thread, rows.length ? rows.map((r) => r.role === 'owner'
      ? h('div.msg.me', { dir: 'auto' }, r.text, h('small', {}, clock(r.ts)))
      : h('div.msg', { dir: 'auto' }, r.text,
        r.steps?.length ? h('div.steps', {}, r.steps.map((s) => h(`div.step${s.result?.error ? '.bad' : ''}`, { title: JSON.stringify(s.args) }, h('i.dia' + (s.result?.error ? '.bad' : '.ok')), STEP[s.action] || s.action, s.result?.error ? `: ${s.result.error}` : ''))) : null,
        h('small', {}, clock(r.ts))))
      : h('div.empty', { style: 'margin:auto;max-width:560px' }, h('b', {}, 'Give the agent a job'),
        'It can read chats, report numbers, run follow-ups on a schedule, message a customer, remember offers and learn from your site.',
        h('div.stack', { style: 'margin-top:16px;text-align:left' }, EXAMPLES.map((x) => h('button.chip', { style: 'white-space:normal;text-align:left;padding:8px 10px', onclick: () => { input.value = x; input.focus(); } }, x)))),
    waiting ? h('div.msg', { style: 'opacity:.7' }, 'Working on it…', note ? h('small', {}, note) : null) : null);
    thread.scrollTop = thread.scrollHeight;
  };
  const load = () => GET('/api/commands').then((rows) => { lastRows = rows; draw(rows); });
  const send = h('button.btn.primary', { onclick: () => {
    const text = input.value.trim();
    if (!text || waiting) return;
    input.value = ''; waiting = true; note = '';
    act(send, () => POST('/api/commands', { text })).finally(() => { waiting = false; load(); });
  } }, 'Send');
  const viaWa = toggle(true, (on) => act(null, () => PUT('/api/settings', { commandsViaWhatsApp: on }), on ? 'Commands from WhatsApp are on' : 'Commands from WhatsApp are off'), 'Accept commands from WhatsApp');
  GET('/api/settings').then((s) => { viaWa.querySelector('input').checked = s.commandsViaWhatsApp; });
  live.on('command', load);
  // Show what the agent is doing while it waits (rate-limit pauses, model switches).
  live.on('log', (l) => { if (waiting && ['router', 'command'].includes(l.scope)) { note = l.msg; draw(lastRows); } });
  load();
  return h('div.page', { style: 'display:flex;flex-direction:column;height:100vh;padding-bottom:24px' },
    h('div.head', {}, h('div', {}, h('h1', {}, 'Command'), h('p', {}, 'Tell the agent what to do. Anything that messages customers in bulk is confirmed with you first, and daily caps and quiet hours still apply.')),
      h('div.row', {}, h('button.btn.sm', { onclick: (e) => confirm('Clear this conversation?') && act(e.target, () => DEL('/api/commands')).then(load) }, 'Clear'))),
    h('div.card', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, thread, h('div.composer', {}, input, send)),
    h('div.row', { style: 'margin-top:12px' }, viaWa, h('div.grow.muted', {}, 'Also take commands from WhatsApp: open “Message yourself” on a linked phone',
      S.accounts.some((a) => a.type === 'qr') ? '' : ' (needs a QR-linked number)', ' and type the same things there. The agent answers in that chat.')));
}
