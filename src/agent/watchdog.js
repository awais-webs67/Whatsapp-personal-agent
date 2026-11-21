// Health check every minute: a number that stays disconnected, no AI model able to answer customers, a number
// that hit its daily cap. Problems show as a red bar on the dashboard and are sent to the owner once.
import { all, get, now } from '../db.js';
import { getSettings, log, emit } from '../core.js';
import * as wa from '../wa/manager.js';
import { nextReadyAt, chainFor, blockedReason } from '../llm/router.js';
import { notify } from './updates.js';

const downSince = new Map(); // accountId -> when it stopped being connected
let modelsDownSince = null;
let last = [];

const at = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getSettings().followup.timezone });

/** Everything that needs the owner, now. */
export function health() {
  const problems = [];
  for (const a of all('SELECT * FROM accounts ORDER BY id')) {
    const s = wa.statusOf(a.id);
    if (s.state === 'connected') { downSince.delete(a.id); continue; }
    if (s.state === 'disconnected' && !a.connected_at) continue; // never linked yet: not an outage
    if (!downSince.has(a.id)) downSince.set(a.id, now());
    const since = downSince.get(a.id);
    const logged = s.state === 'logged_out';
    if (logged || now() - since > 10 * 60_000) {
      problems.push({ key: `wa:${a.id}:${logged ? 'out' : 'down'}`, level: 'bad', link: '#/numbers',
        text: logged ? `${a.name} was logged out from the phone. Link it again on the Numbers page; until then nothing is sent or answered on it.`
          : `${a.name} has been disconnected since ${at(since)}${s.error ? ` (${s.error})` : ''}. Messages wait until it is back.` });
    }
  }
  const chain = chainFor('reply').filter((r) => r.enabled);
  if (!chain.length) problems.push({ key: 'ai:none', level: 'bad', link: '#/models', text: 'No AI model is set up, so customers get no replies. Add one on the Models page.' });
  else if (nextReadyAt('reply') !== now()) {
    modelsDownSince ??= now();
    if (now() - modelsDownSince > 10 * 60_000) {
      const back = nextReadyAt('reply');
      const why = chain.map((r) => `${r.name}: ${String(blockedReason(r)).replace(/_/g, ' ')}`).join(', ');
      problems.push({ key: 'ai:down', level: 'bad', link: '#/models', text: `No AI model can answer customers since ${at(modelsDownSince)} (${why}).${back ? ` The first is back around ${at(back)}.` : ' None comes back by itself: check the keys or add another model.'}` });
    }
  } else modelsDownSince = null;
  const cap = getSettings().followup.dailyCap;
  for (const a of all('SELECT id, name FROM accounts')) {
    const sent = get("SELECT COUNT(*) n FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'sent' AND f.sent_at > ?", a.id, now() - 86_400_000).n;
    const waiting = get("SELECT COUNT(*) n FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'approved' AND f.due_at <= ?", a.id, now()).n;
    if (sent >= cap && waiting) problems.push({ key: `cap:${a.id}:${new Date().toISOString().slice(0, 10)}`, level: 'warn', link: '#/settings', text: `${a.name} reached its daily limit of ${cap} follow-ups; ${waiting} wait until tomorrow. Raise it in Settings if the number is old and trusted.` });
  }
  return problems;
}

function check() {
  let list;
  try { list = health(); } catch (e) { return log('error', 'watchdog', e.message); }
  // Tell the owner about each new problem once (and again every 3 hours while it lasts).
  for (const p of list) notify(`⚠️ ${p.text}`, { key: p.key, everyMs: 3 * 3_600_000 });
  if (JSON.stringify(list) !== JSON.stringify(last)) { last = list; emit('health', list); }
}

export function startWatchdog() { setInterval(check, 60_000).unref(); setTimeout(check, 15_000).unref(); }
export const _check = check;
