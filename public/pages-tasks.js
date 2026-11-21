import { h, set, GET, POST, PATCH, act, toast, modal, field, select, rel, num } from './ui.js';
import { live } from './state.js';

const STATUS = { active: ['Running', 'hot'], paused: ['Paused', 'warn'], done: ['Done', 'ok'], failed: ['Failed', 'bad'] };
const when = (ts) => (!ts ? '—' : ts <= Date.now() + 30_000 ? 'Due now' : `${new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${rel(ts)})`);

/** Everything the agent has been asked to do, with progress and controls. */
export function tasks() {
  const box = h('div.stack');
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Campaigns'), h('p', {}, 'Automatic campaigns run all the time: new leads join one by the ad they came from, the words they write or the number, and get its replies and follow-ups. One-time tasks message people already in your chats. Every campaign has its own settings, log and history. In Command, use its number: “campaign 3 mein gap 5 to 7 minute kar do”.')),
      h('div.row.wrap', {}, h('button.btn', { onclick: newTask }, 'One-time task'), h('button.btn.primary', { onclick: () => editAuto(null) }, 'New automatic campaign'))),
    box);

  /** Where a task is, as one bar plus a sentence: what is happening and what comes next. */
  function progressOf(t) {
    if (t.kind === 'analysis') {
      const r = t.progress?.reading;
      if (r) return { step: 1, pct: r.total ? (r.done / r.total) * 100 : 0, label: `Reading chats in full: ${num(r.done)} of ${num(r.total)}` };
      return { step: t.status === 'done' ? 3 : 2, pct: 100, label: t.status === 'done' ? 'Finished. See Details for what it found.' : 'Learning from the chats…' };
    }
    if (t.kind === 'batch') {
      const p = t.progress || {};
      const toSend = p.sent + p.queued;
      if (p.reading) {
        return { step: 1, pct: p.reading.total ? (p.reading.done / p.reading.total) * 100 : 0, label: `Reading chats and writing messages: ${num(p.reading.done)} of ${num(p.reading.total)}` };
      }
      if (t.status === 'done') return { step: 3, pct: 100, label: t.last_result || `${num(p.sent)} sent` };
      if (!toSend && p.drafts) return { step: 2, pct: 0, label: `${num(p.drafts)} message${p.drafts === 1 ? '' : 's'} written, waiting for your approval` };
      return {
        step: toSend ? 3 : 2,
        pct: toSend ? (p.sent / toSend) * 100 : 0,
        label: toSend ? `${num(p.sent)} of ${num(toSend)} sent${p.queued && t.status === 'active' && t.next_run_at ? ` · next ${t.next_run_at <= Date.now() + 30_000 ? 'now' : rel(t.next_run_at)}` : ''}` : 'Nothing to send',
      };
    }
    const s = t.schedule || {};
    if (t.status === 'done' || t.status === 'failed') return { pct: 100, label: `Ran ${num(t.runs)} time${t.runs === 1 ? '' : 's'}${t.last_run_at ? `, last ${rel(t.last_run_at)} ago` : ''}` };
    if (t.status === 'paused') return { pct: 0, label: 'Paused' };
    if (!t.next_run_at) return { pct: 100, label: 'Running now…' };
    const period = s.type === 'every' ? s.minutes * 60_000 : s.type === 'daily' ? 86_400_000 : Math.max(1, t.next_run_at - t.created_at);
    const left = t.next_run_at - Date.now();
    return { pct: left <= 0 ? 100 : Math.max(0, Math.min(100, (1 - left / period) * 100)), label: left <= 30_000 ? 'Running now…' : `Next run ${rel(t.next_run_at)} (${new Date(t.next_run_at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` };
  }

  // Step-by-step log of a task: what it did and when, newest first.
  const openIds = new Set();
  const KIND = { read: ['Read', ''], wrote: ['Wrote', 'hot'], sent: ['Sent', 'ok'], skipped: ['Skipped', ''], failed: ['Failed', 'bad'], paused: ['Paused', 'warn'], changed: ['Changed', 'warn'], done: ['Done', 'ok'], info: ['Info', ''] };
  const when = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  async function loadSteps(id, box) {
    const rows = await GET(`/api/tasks/${id}/events`).catch(() => []);
    set(box, rows.length ? h('ol.tlog', {}, rows.map((r) => {
      const [label, tone] = KIND[r.kind] || [r.kind, ''];
      return h('li', {}, h('time', { title: new Date(r.ts).toLocaleString() }, when(r.ts)), h(`span.pill${tone ? `.${tone}` : ''}`, {}, label),
        h('span', { dir: 'auto' }, r.text, r.chat_id ? h('a', { href: `#/inbox/${r.chat_id}`, style: 'margin-left:6px' }, 'open chat') : null));
    })) : h('div.muted', {}, 'No steps recorded yet.'));
  }

  // ---------- automatic campaigns ----------
  const dur = (h_) => (h_ % 24 === 0 ? `${h_ / 24}d` : `${h_}h`);
  function autoCard(t) {
    const c = t.config || {};
    const s = t.stats || {};
    const [label, tone] = STATUS[t.status] || [t.status, ''];
    const ctl = (action, text, cls = '') => h(`button.btn.sm${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Remove campaign #${t.id} "${t.title}"? Its leads go back to the default campaign; its log and history are kept.`)) && act(e.target, () => PATCH(`/api/tasks/${t.id}`, { action })) }, text);
    const who = c.isDefault ? 'Every new lead that no other campaign takes'
      : [c.keywords?.length ? `first message has: ${c.keywords.join(', ')}` : null, c.adText?.length ? `ad title has: ${c.adText.join(', ')}` : null, c.adIds?.length ? `ad ID: ${c.adIds.join(', ')}` : null].filter(Boolean).join(' · ') || 'Only people you add by hand';
    const tile = (n, l) => h('div.ctile', {}, h('b', {}, num(n)), h('small', {}, l));
    const hist = h('div');
    const log_ = h('div.tlog-box');
    const open = openIds.has(t.id);
    if (open) { loadSteps(t.id, log_); loadHistory(t.id, hist); }
    return h(`div.card.task.camp.${t.status}`, {},
      h('div.task-top', {},
        h('div.grow', {},
          h('div.row.wrap', { style: 'gap:8px' }, h('span.pill', { style: 'font-family:var(--mono, monospace)' }, `#${t.id}`), h('b.task-title', { dir: 'auto' }, t.title),
            c.isDefault ? h('span.pill', {}, 'Default') : null, h(`span.pill.${tone}`, {}, t.status === 'active' ? h('i.dia.hot.live') : null, label)),
          h('div.muted', { style: 'font-size:12.5px;margin-top:4px' }, h('b', {}, 'Who joins: '), who)),
        h('div.row', {},
          t.status === 'active' ? ctl('pause', 'Pause') : ctl('resume', 'Resume', '.primary'),
          h('button.btn.sm', { onclick: () => editAuto(t) }, 'Edit'),
          c.isDefault ? null : ctl('remove', 'Remove', '.ghost.danger'))),
      h('div.chips.camp-set', {},
        h('span.chip', {}, `Follow up after ${(c.steps || []).map(dur).join(', ') || '—'}`),
        h('span.chip', {}, `Gap ${Math.round(c.gapMin)}–${Math.round(c.gapMax)} min`),
        h('span.chip', {}, c.approval ? 'Waits for your OK' : 'Sends by itself'),
        h('span.chip', {}, c.night ? 'Also at night' : 'Quiet at night'),
        c.instructions ? h('span.chip', { title: c.instructions }, 'Has reply instructions') : null),
      h('div.ctiles', {}, tile(s.members, 'Leads'), tile(s.sent, 'Follow-ups sent'), tile(s.waiting, 'Waiting'), tile(s.replied, 'Replied after one'), tile(s.bought, 'Bought')),
      h('details.task-more', { open, ontoggle: (e) => { if (e.target.open) { openIds.add(t.id); loadSteps(t.id, log_); loadHistory(t.id, hist); } else openIds.delete(t.id); } }, h('summary', {}, 'Instructions, log and history'),
        h('div.stack', { style: 'gap:10px;padding-top:8px' },
          c.instructions ? h('div', { dir: 'auto', style: 'white-space:pre-wrap' }, h('span.muted', {}, 'Reply instructions: '), c.instructions) : null,
          c.followupStyle ? h('div', { dir: 'auto', style: 'white-space:pre-wrap' }, h('span.muted', {}, 'Follow-up example: '), c.followupStyle) : null,
          h('div', {}, h('b', {}, 'Log'), log_),
          h('div', {}, h('b', {}, 'Settings history'), hist))));
  }

  async function loadHistory(id, box_) {
    const rows = await GET(`/api/campaigns/${id}/changes`).catch(() => []);
    const show = (v) => (v == null ? '—' : Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v === false ? 'no' : String(v));
    set(box_, rows.length ? h('ol.tlog', {}, rows.map((r) => h('li', {}, h('time', {}, when_(r.ts)), h('span.pill', {}, r.source), h('span', { dir: 'auto' }, `${r.field}: ${show(r.before)} → ${show(r.after)}`)))) : h('div.muted', {}, 'No changes yet.'));
  }
  const when_ = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /** Create or edit an automatic campaign: who joins, when it follows up, how it answers. */
  function editAuto(t) {
    const c = t?.config || { steps: [24, 72, 168], gapMin: 5, gapMax: 10, approval: false, night: false, keywords: [], adIds: [], adText: [], instructions: '', followupStyle: '', priority: 100 };
    const inp = (v, attrs = {}) => h('input', { type: 'text', value: v ?? '', ...attrs });
    const f = {
      name: inp(t?.title || '', { placeholder: 'Eid Canva ad' }),
      keywords: inp((c.keywords || []).join(', '), { placeholder: 'canva, canva pro' }),
      adText: inp((c.adText || []).join(', '), { placeholder: 'eid' }),
      adIds: inp((c.adIds || []).join(', '), { placeholder: '120210000000000' }),
      steps: inp((c.steps || []).join(', '), { placeholder: '2, 24, 72' }),
      gapMin: inp(c.gapMin, { type: 'number', min: 0 }),
      gapMax: inp(c.gapMax, { type: 'number', min: 0 }),
      approval: h('input', { type: 'checkbox', checked: !!c.approval }),
      night: h('input', { type: 'checkbox', checked: !!c.night }),
      instructions: h('textarea', { rows: 3, dir: 'auto', value: c.instructions || '', placeholder: 'Canva Pro yearly offer batao, link bhejo, Eid discount ka zikr karo' }),
      followupStyle: h('textarea', { rows: 3, dir: 'auto', value: c.followupStyle || '', placeholder: 'Assalam o alaikum Sir, aap ne Canva ke liye rabta kiya tha…' }),
      priority: inp(c.priority, { type: 'number' }),
    };
    const entry = c.isDefault ? h('div.note', {}, 'This is the default campaign: every new lead that no other campaign takes joins it.')
      : h('div.stack', {}, h('b', {}, 'Who joins (any one is enough)'),
        h('div.grid2', {}, field('Words in their first message', f.keywords, 'Comma separated. Tip: give each ad its own pre-filled message.'), field('Words in the ad title', f.adText)),
        h('div.grid2', {}, field('Meta ad IDs', f.adIds, 'From Ads Manager. Works best on the official Cloud API.'), field('Priority', f.priority, 'Lower wins when two campaigns match.')));
    modal(t ? `Edit campaign #${t.id}` : 'New automatic campaign', [
      field('Name', f.name), entry,
      h('b', {}, 'Follow-ups'),
      h('div.grid2', {}, field('Follow up after (hours)', f.steps, 'One number per follow-up: 2, 24, 72'), h('div.grid2', {}, field('Gap min (minutes)', f.gapMin), field('Gap max (minutes)', f.gapMax))),
      h('label.row', {}, f.approval, h('span', {}, 'Wait for my OK before sending')), h('label.row', {}, f.night, h('span', {}, 'May send during quiet hours')),
      h('b', {}, 'How it talks to these leads'),
      field('Reply instructions', f.instructions, 'Added to every reply and follow-up for people in this campaign.'),
      field('Example follow-up in your words', f.followupStyle),
    ], (close) => [h('button.btn', { onclick: close }, 'Cancel'), h('button.btn.primary', { onclick: (e) => act(e.target, async () => {
      const body = { name: f.name.value, steps: f.steps.value, gapMin: Number(f.gapMin.value), gapMax: Number(f.gapMax.value), approval: f.approval.checked, night: f.night.checked, instructions: f.instructions.value, followupStyle: f.followupStyle.value,
        ...(c.isDefault ? {} : { keywords: f.keywords.value, adText: f.adText.value, adIds: f.adIds.value, priority: Number(f.priority.value) }) };
      if (t) await PATCH(`/api/campaigns/${t.id}`, body); else await POST('/api/campaigns', body);
      close();
      toast(t ? 'Campaign saved. The change is in its history.' : 'Campaign created. New leads that match join it.');
      load();
    }) }, t ? 'Save' : 'Create campaign')]);
  }

  function card(t) {
    const steps_ = h('div.tlog-box');
    if (openIds.has(t.id)) loadSteps(t.id, steps_);
    const [label, tone] = STATUS[t.status] || [t.status, ''];
    const ctl = (action, text, cls = '') => h(`button.btn.sm${cls}`, { onclick: (e) => (action !== 'remove' || confirm(`Remove task #${t.id} "${t.title}"?${t.kind === 'batch' ? ' Messages it has not sent yet are cancelled.' : ''}`)) && act(e.target, () => PATCH(`/api/tasks/${t.id}`, { action })) }, text);
    const pr = progressOf(t);
    const p = t.progress;
    const steps = t.kind !== 'scheduled' ? h('div.tsteps', {}, (t.kind === 'analysis' ? ['Read chats', 'Learn from them'] : ['Read chats', 'Write messages', 'Send']).map((name, i) => h(`span${pr.step > i + 1 || t.status === 'done' ? '.done' : pr.step === i + 1 ? '.now' : ''}`, {}, h('i.dia'), name))) : null;
    return h(`div.card.task.${t.status}`, {},
      h('div.task-top', {},
        h('div.grow', {},
          h('div.row.wrap', { style: 'gap:8px' }, h('span.pill', { title: `In Command, say "task ${t.id}" to change this one`, style: 'font-family:var(--mono, monospace)' }, `#${t.id}`), h('b.task-title', { dir: 'auto' }, t.title), h(`span.pill.${tone}`, {}, t.status === 'active' ? h('i.dia.hot.live') : null, label)),
          h('div.muted', { style: 'font-size:12.5px;margin-top:2px' }, t.kind === 'scheduled' ? t.scheduleText : `${t.scheduleText} · started ${rel(t.created_at)} ago`)),
        h('div.row', {},
          t.status === 'active' ? ctl('pause', 'Pause') : null,
          t.status === 'paused' ? ctl('resume', 'Resume', '.primary') : null,
          t.kind === 'scheduled' ? ctl('run', t.status === 'done' || t.status === 'failed' ? 'Run again' : 'Run now') : null,
          ctl('remove', 'Remove', '.ghost.danger'))),
      steps,
      h('div.task-bar', {}, h(`div.bar.big${t.status === 'paused' ? '.paused' : ''}`, {}, h('i', { style: `width:${Math.round(pr.pct)}%` })), h('div.row', { style: 'justify-content:space-between;margin-top:6px' }, h('span', { dir: 'auto' }, pr.label), h('b', {}, `${Math.round(pr.pct)}%`))),
      t.waiting ? h('div.note.warn', { style: 'margin:0 18px 14px' }, h('b', {}, 'Not sending right now. '), t.waiting) : null,
      p && (p.drafts || p.skipped || p.failed) ? h('div.muted', { style: 'font-size:12.5px;padding:0 18px 12px' }, [p.drafts ? `${num(p.drafts)} waiting for approval` : null, p.skipped ? `${num(p.skipped)} skipped` : null, p.failed ? `${num(p.failed)} failed` : null].filter(Boolean).join(' · '),
        p.drafts ? h('a', { href: '#/followups', style: 'margin-left:8px' }, 'Review drafts') : null) : null,
      h('details.task-more', { open: openIds.has(t.id), ontoggle: (e) => { if (e.target.open) { openIds.add(t.id); loadSteps(t.id, steps_); } else openIds.delete(t.id); } }, h('summary', {}, 'Details and step-by-step log'),
        h('div.stack', { style: 'gap:8px;padding-top:8px' },
          h('div', { dir: 'auto' }, h('span.muted', {}, 'Task: '), t.instruction),
          t.kind === 'scheduled' ? h('div', {}, h('span.muted', {}, 'Runs so far: '), `${num(t.runs)}${t.last_run_at ? `, last ${rel(t.last_run_at)} ago` : ''}`) : null,
          t.last_result ? h('div', { dir: 'auto', style: 'white-space:pre-wrap' }, h('span.muted', {}, 'Last result: '), t.last_result) : null,
          h('div', {}, h('span.muted', {}, 'Created: '), when(t.created_at)),
          steps_)));
  }

  function draw(list) {
    if (!list.length) {
      return set(box, h('div.card', {}, h('div.empty', {}, h('b', {}, 'No tasks yet'),
        'Create one here, or ask on the Command page, e.g. “har 30 minute baad naye leads ko follow-up bhejo” or “roz raat 9 baje aaj ka report do”.',
        h('div', {}, h('button.btn.primary', { onclick: newTask }, 'New task')))));
    }
    const auto = list.filter((t) => t.kind === 'auto').sort((a, b) => (b.config?.isDefault ? 1 : 0) - (a.config?.isDefault ? 1 : 0) || a.id - b.id);
    const rest = list.filter((t) => t.kind !== 'auto');
    const groups = [['Automatic campaigns', auto, autoCard], ['One-time tasks: running and paused', rest.filter((t) => ['active', 'paused'].includes(t.status)), card], ['Finished', rest.filter((t) => ['done', 'failed'].includes(t.status)), card]];
    set(box, groups.filter(([, l]) => l.length).map(([title, l, fn]) => h('div.stack', {}, h('h2', {}, title), l.map(fn))));
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
