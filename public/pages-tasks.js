import { h, set, GET, POST, PATCH, act, toast, modal, field, select, rel, num } from './ui.js';
import { live } from './state.js';

const STATUS = { active: ['Running', 'hot'], paused: ['Paused', 'warn'], done: ['Done', 'ok'], failed: ['Failed', 'bad'] };
const when = (ts) => (ts ? `${new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${rel(ts)})` : '—');

/** Everything the agent has been asked to do, with progress and controls. */
export function tasks() {
  const box = h('div.stack');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Tasks'), h('p', {}, 'Jobs you gave the agent: follow-up batches and things it does on a schedule. Pause, resume, run now or remove any of them.')),
      h('button.btn.primary', { onclick: newTask }, 'New task')),
    box);

  function card(t) {
    const [label, tone] = STATUS[t.status] || [t.status, ''];
    const ctl = (action, text, cls = '') => h(`button.btn.sm${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Remove "${t.title}"?${t.kind === 'batch' ? ' Messages it has not sent yet are cancelled.' : ''}`)) && act(e.target, () => PATCH(`/api/tasks/${t.id}`, { action })) }, text);
    const p = t.progress;
    const total = p ? p.sent + p.queued + p.drafts + p.skipped + p.failed : 0;
    return h('div.card', {},
      h('header', {}, h('div.row.wrap', { style: 'gap:8px' }, h('b', { style: 'color:var(--ink);font-size:14.5px' }, t.title), h(`span.pill.${tone}`, {}, t.status === 'active' ? h('i.dia.hot.live') : null, label)),
        h('div.row', {},
          t.status === 'active' ? ctl('pause', 'Pause') : null,
          t.status === 'paused' ? ctl('resume', 'Resume', '.primary') : null,
          t.kind === 'scheduled' && t.status !== 'done' ? ctl('run', 'Run now') : null,
          t.kind === 'scheduled' && t.status === 'done' ? ctl('run', 'Run again') : null,
          ctl('remove', 'Remove', '.ghost.danger'))),
      h('div.pad.stack', {},
        h('div.muted', { dir: 'auto' }, t.instruction),
        h('div.grid3', {},
          h('div.kv', {}, 'Schedule', h('b', {}, t.scheduleText)),
          h('div.kv', {}, t.kind === 'batch' ? 'Next message' : 'Next run', h('b', {}, t.status === 'active' ? when(t.next_run_at) : t.status === 'paused' ? 'Paused' : '—')),
          h('div.kv', {}, t.kind === 'batch' ? 'Started' : 'Runs so far', h('b', {}, t.kind === 'batch' ? when(t.created_at) : `${num(t.runs)}${t.last_run_at ? `, last ${rel(t.last_run_at)}` : ''}`))),
        p ? h('div.stack', { style: 'gap:6px' },
          p.reading ? h('div', {}, h('div.kv', {}, 'Reading chats', h('b', {}, `${num(p.reading.done)} of ${num(p.reading.total)}`)), h('div.bar', {}, h('i', { style: `width:${p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0}%` }))) : null,
          total ? h('div', {}, h('div.kv', {}, 'Messages', h('b', {}, `${num(p.sent)} sent of ${num(total - p.skipped - p.failed)}`)), h('div.bar', {}, h('i', { style: `width:${total ? (p.sent / Math.max(1, total - p.skipped - p.failed)) * 100 : 0}%` }))) : null,
          h('div.muted', { style: 'font-size:12.5px' }, [`${num(p.queued)} queued`, p.drafts ? `${num(p.drafts)} waiting for your approval` : null, p.skipped ? `${num(p.skipped)} skipped` : null, p.failed ? `${num(p.failed)} failed` : null].filter(Boolean).join(' · '),
            p.drafts ? h('a', { href: '#/followups', style: 'margin-left:8px' }, 'Review drafts') : null)) : null,
        t.last_result ? h('div', {}, h('div.muted', { style: 'font-size:12px' }, 'Last result'), h('div', { dir: 'auto', style: 'color:var(--ink);white-space:pre-wrap' }, t.last_result)) : null));
  }

  function draw(list) {
    if (!list.length) {
      return set(box, h('div.card', {}, h('div.empty', {}, h('b', {}, 'No tasks yet'),
        'Create one here, or ask on the Command page, e.g. “har 30 minute baad naye leads ko follow-up bhejo” or “roz raat 9 baje aaj ka report do”.',
        h('div', {}, h('button.btn.primary', { onclick: newTask }, 'New task')))));
    }
    const groups = [['Running and paused', list.filter((t) => ['active', 'paused'].includes(t.status))], ['Finished', list.filter((t) => ['done', 'failed'].includes(t.status))]];
    set(box, groups.filter(([, l]) => l.length).map(([title, l]) => h('div.stack', {}, h('h2', {}, title), l.map(card))));
  }

  function newTask() {
    const instruction = h('textarea', { rows: 3, dir: 'auto', placeholder: 'What should the agent do? e.g. “Jin logon ne pichle 2 din mein price poocha aur nahi khareeda, unhein offer yaad dilao”' });
    const type = select([['once', 'Once, right now'], ['at', 'Once, at a time'], ['every', 'Repeat every N minutes'], ['daily', 'Every day at a time']], 'once', () => drawWhen(), { 'aria-label': 'When' });
    const at = h('input', { type: 'datetime-local' });
    const minutes = h('input', { type: 'number', min: 1, value: 30 });
    const time = h('input', { type: 'time', value: '10:00' });
    const whenBox = h('div');
    const drawWhen = () => set(whenBox, { at: field('Date and time', at), every: field('Every how many minutes', minutes), daily: field('Time of day', time, 'Uses the time zone from Settings.') }[type.value] || null);
    drawWhen();
    modal('New task', [field('Task', instruction, 'Write it the way you would tell a person. The agent works it out each time it runs. Bulk messages still follow your daily cap and quiet hours.'), field('When', type), whenBox],
      (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
        const schedule = type.value === 'every' ? { type: 'every', minutes: Number(minutes.value) }
          : type.value === 'daily' ? { type: 'daily', time: time.value }
          : type.value === 'at' ? { type: 'once', at: at.value ? new Date(at.value).toISOString() : undefined } : { type: 'once' };
        await POST('/api/tasks', { instruction: instruction.value, schedule });
        close();
        toast(type.value === 'once' ? 'Task created. It starts within a few seconds.' : 'Task scheduled.');
      }) }, 'Create task')]);
  }

  const load = () => GET('/api/tasks').then(draw).catch((e) => toast(e.message, true));
  let t;
  const soon = () => { clearTimeout(t); t = setTimeout(load, 400); };
  for (const type of ['tasks', 'followups', 'campaign']) live.on(type, soon);
  load();
  const tick = setInterval(() => (el.isConnected ? load() : clearInterval(tick)), 30_000); // keep "in 5m" fresh
  return el;
}
