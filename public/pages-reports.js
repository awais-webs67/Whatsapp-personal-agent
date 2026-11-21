// Reports: from first message to sale, per campaign and per ad, follow-ups, answer speed and AI use.
import { h, set, GET, toast, select, num } from './ui.js';

const secs = (s) => (s == null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

export function reports() {
  const box = h('div.stack');
  let days = 30;
  const period = select([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']], days, (v) => { days = Number(v); load(); }, { 'aria-label': 'Period', style: 'width:auto;align-self:flex-start' });
  const el = h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Reports'), h('p', {}, 'Where leads come from, how far they get, which campaigns and ads bring sales, and whether follow-ups bring people back.')), period),
    box);

  const table = (head, rows) => h('div.rtable', {}, h('table', {},
    h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))),
    h('tbody', {}, rows.length ? rows.map((r) => h('tr', {}, r.map((c, i) => h(i ? 'td.n' : 'td', { dir: 'auto' }, c)))) : h('tr', {}, h('td.muted', { colspan: head.length }, 'Nothing in this period yet.')))));

  async function load() {
    let r;
    try { r = await GET(`/api/reports?days=${days}`); } catch (e) { return toast(e.message, true); }
    const bought = r.funnel.at(-1).n;
    set(box,
      h('div.tiles', {}, [
        ['New leads', r.leads], ['Bought', bought], ['Lead → sale', `${r.funnel.at(-1).pct}%`],
        ['Replied after a follow-up', `${r.followups.replyRate}%`], ['First answer (median)', secs(r.replies.medianSeconds)], ['AI replies', r.replies.aiReplies],
      ].map(([label, n]) => h('div.tile', {}, h('b', {}, typeof n === 'number' ? num(n) : n), h('span', {}, label)))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'From first message to sale')), h('div.pad',
        {}, table(['Step', 'People', 'Of all leads'], r.funnel.map((f) => [f.step, num(f.n), `${f.pct}%`])))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Campaigns')), h('div.pad', {},
        table(['Campaign', 'Leads', 'Follow-ups sent', 'Replied after one', 'Reply rate', 'Bought'],
          r.campaigns.map((c) => [h('a', { href: '#/tasks' }, `#${c.id} ${c.name}${c.kind === 'batch' ? ' (one-time)' : ''}`), num(c.members), num(c.sent), num(c.replied), `${c.replyRate}%`, num(c.bought)])))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'Ads')), h('div.pad', {},
        h('p.muted', { style: 'margin:0 0 10px;font-size:12.5px' }, 'Leads that came from a Click-to-WhatsApp ad. Always known on the Cloud API; on a QR-linked number only when WhatsApp passes the ad along.'),
        table(['Ad', 'Leads', 'Bought', 'Sale rate'], r.ads.map((a) => [a.ad, num(a.leads), num(a.bought), `${a.rate}%`])))),
      h('div.grid2', {},
        h('div.card', {}, h('header', {}, h('h2', {}, 'Follow-ups')), h('div.pad.stack', { style: 'gap:6px' },
          h('div.kv', {}, 'Sent', h('b', {}, num(r.followups.sent))),
          h('div.kv', {}, 'People who replied after one', h('b', {}, `${num(r.followups.replied)} (${r.followups.replyRate}%)`)),
          h('div.kv', {}, 'Of them bought', h('b', {}, num(r.followups.bought))))),
        h('div.card', {}, h('header', {}, h('h2', {}, 'Answers')), h('div.pad.stack', { style: 'gap:6px' },
          h('div.kv', {}, 'New leads answered', h('b', {}, num(r.replies.answered))),
          h('div.kv', {}, 'First answer by the agent', h('b', {}, num(r.replies.byAgent))),
          h('div.kv', {}, 'Median time to first answer', h('b', {}, secs(r.replies.medianSeconds))),
          h('div.kv', {}, 'Waiting for you now', h('b', {}, num(r.replies.handoffs)))))),
      h('div.card', {}, h('header', {}, h('h2', {}, 'AI use')), h('div.pad', {},
        table(['Model', 'Requests', 'Errors', 'Tokens in', 'Tokens out'], r.ai.map((a) => [a.name, num(a.requests), num(a.errors), num(a.tin), num(a.tout)])))));
  }
  load();
  return el;
}
