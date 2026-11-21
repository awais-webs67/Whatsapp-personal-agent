// Reports: how leads move from first message to sale, which campaigns and ads bring sales,
// whether follow-ups bring people back, how fast the agent answers, and what the AI costs in requests.
import { all, get, now } from '../db.js';
import { STAGES } from './brain.js';
import { statsOf } from './campaigns.js';

const DAY = 86_400_000;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function report(days = 30) {
  const since = now() - Math.max(1, Math.min(365, Number(days) || 30)) * DAY;
  const leadWhere = "c.created_at >= ? AND c.jid NOT LIKE '%@g.us' AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '') AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0)";
  const leads = get(`SELECT COUNT(*) n FROM chats c WHERE ${leadWhere}`, since).n;
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const r of all(`SELECT c.stage, COUNT(*) n FROM chats c WHERE ${leadWhere} GROUP BY c.stage`, since)) byStage[r.stage] = r.n;
  // A funnel counts everyone who got at least this far.
  const reached = (list) => list.reduce((n, s) => n + (byStage[s] || 0), 0);
  const funnel = [
    { step: 'New leads', n: leads },
    { step: 'Talking', n: reached(['engaged', 'interested', 'negotiating', 'purchased']) },
    { step: 'Interested', n: reached(['interested', 'negotiating', 'purchased']) },
    { step: 'Negotiating', n: reached(['negotiating', 'purchased']) },
    { step: 'Bought', n: reached(['purchased']) },
  ].map((f) => ({ ...f, pct: pct(f.n, leads) }));

  const campaigns = all("SELECT id, title, kind, status FROM tasks WHERE kind IN ('auto','batch') AND status != 'removed' ORDER BY kind, id")
    .map((t) => { const s = statsOf(t.id); return { id: t.id, name: t.title, kind: t.kind, status: t.status, ...s, replyRate: pct(s.replied, s.sent) }; });

  const ads = all(`SELECT COALESCE(c.ad_title, '(ad without a title)') ad, COUNT(*) leads, SUM(c.stage = 'purchased') bought
                   FROM chats c WHERE ${leadWhere} AND (c.ad_id IS NOT NULL OR c.ad_title IS NOT NULL) GROUP BY 1 ORDER BY leads DESC LIMIT 30`, since)
    .map((r) => ({ ...r, rate: pct(r.bought, r.leads) }));

  const sent = get("SELECT COUNT(*) n FROM followups WHERE status = 'sent' AND sent_at >= ?", since).n;
  const replied = get(`SELECT COUNT(DISTINCT f.chat_id) n FROM followups f WHERE f.status = 'sent' AND f.sent_at >= ?
                       AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = f.chat_id AND m.from_me = 0 AND m.ts > f.sent_at)`, since).n;
  const boughtAfter = get(`SELECT COUNT(DISTINCT f.chat_id) n FROM followups f JOIN chats c ON c.id = f.chat_id
                           WHERE f.status = 'sent' AND f.sent_at >= ? AND c.stage = 'purchased'`, since).n;

  // First answer time: from a new lead's first message to our first reply (agent or owner).
  const waits = all(`SELECT (SELECT MIN(m2.ts) FROM messages m2 WHERE m2.chat_id = c.id AND m2.from_me = 1 AND m2.ts > f.ts) - f.ts w,
                            (SELECT m3.by FROM messages m3 WHERE m3.chat_id = c.id AND m3.from_me = 1 AND m3.ts > f.ts ORDER BY m3.ts LIMIT 1) by
                     FROM chats c JOIN (SELECT chat_id, MIN(ts) ts FROM messages WHERE from_me = 0 GROUP BY chat_id) f ON f.chat_id = c.id
                     WHERE c.created_at >= ? AND c.is_new = 1`, since).filter((r) => r.w != null && r.w >= 0);
  const median = (list) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const replies = {
    answered: waits.length,
    byAgent: waits.filter((r) => r.by === 'ai').length,
    medianSeconds: median(waits.map((r) => r.w / 1000)) == null ? null : Math.round(median(waits.map((r) => r.w / 1000))),
    aiReplies: get("SELECT COUNT(*) n FROM messages WHERE by = 'ai' AND ts >= ?", since).n,
    handoffs: get('SELECT COUNT(*) n FROM chats WHERE needs_human = 1').n,
  };

  const dayFrom = new Date(since).toISOString().slice(0, 10);
  const ai = all(`SELECT p.name, SUM(u.requests) requests, SUM(u.errors) errors, SUM(u.tokens_in) tin, SUM(u.tokens_out) tout
                  FROM usage u JOIN providers p ON p.id = u.provider_id WHERE u.day >= ? GROUP BY p.id ORDER BY requests DESC`, dayFrom);

  return { days: Math.round((now() - since) / DAY), leads, funnel, stages: byStage, campaigns, ads, followups: { sent, replied, replyRate: pct(replied, sent), bought: boughtAfter }, replies, ai };
}
