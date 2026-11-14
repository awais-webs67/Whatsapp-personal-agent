// Owner commands in plain language ("check the last 5 days and follow up every 5 minutes").
// The model picks one tool at a time, sees the result, and continues until it can answer.
// Works with any provider: tools are requested as plain JSON, no vendor tool-calling API needed.
import { all, get, run, now, update } from '../db.js';
import { getSettings, saveSettings, emit, log } from '../core.js';
import { complete } from '../llm/router.js';
import { toolCallToJson } from '../llm/client.js';
import * as wa from '../wa/manager.js';
import { STAGES, extractJson } from './brain.js';
import { runCampaign, campaign } from './followups.js';
import { humanSend } from './pipeline.js';
import { learnFromChats, learnFromWebsite, learnFromProfile } from './learn.js';

const MAX_STEPS = 8;
const DAY = 86_400_000;
const clip = (t, n) => { const v = String(t ?? '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
const title = (c) => c.name || (c.phone ? `+${c.phone}` : c.jid.split('@')[0]);
const days = (v, d = 7) => Math.min(3650, Math.max(0.01, Number(v) || d));
const stageList = (v) => (Array.isArray(v) ? v.filter((s) => STAGES.includes(s)) : []);

function targets({ days: d, stages }) {
  const st = stageList(stages);
  return all(`SELECT c.* FROM chats c WHERE c.last_in_at >= ? AND c.stage != 'opted_out'
              AND c.jid != COALESCE((SELECT a.self_jid FROM accounts a WHERE a.id = c.account_id), '')
              ${st.length ? `AND c.stage IN (${st.map(() => '?').join(',')})` : "AND c.stage != 'purchased'"}
              ORDER BY c.last_in_at DESC LIMIT 500`, now() - days(d) * DAY, ...st);
}

const TOOLS = {
  stats: {
    doc: 'stats {"days": 7} - numbers for the period: new chats, messages, replies, stages.',
    run: ({ days: d }) => {
      const since = now() - days(d) * DAY;
      const n = (sql, ...p) => get(sql, ...p).n;
      return {
        chats_active: n('SELECT COUNT(*) n FROM chats WHERE last_in_at >= ?', since),
        messages_in: n('SELECT COUNT(*) n FROM messages WHERE from_me = 0 AND ts >= ?', since),
        agent_replies: n("SELECT COUNT(*) n FROM messages WHERE by = 'ai' AND ts >= ?", since),
        followups_sent: n("SELECT COUNT(*) n FROM messages WHERE by = 'followup' AND ts >= ?", since),
        needs_owner: n('SELECT COUNT(*) n FROM chats WHERE needs_human = 1'),
        followups_waiting_approval: n("SELECT COUNT(*) n FROM followups WHERE status = 'pending'"),
        followups_queued: n("SELECT COUNT(*) n FROM followups WHERE status = 'approved'"),
        by_stage: Object.fromEntries(all('SELECT stage, COUNT(*) n FROM chats WHERE last_in_at >= ? GROUP BY stage', since).map((r) => [r.stage, r.n])),
      };
    },
  },
  find_chats: {
    doc: `find_chats {"days": 5, "stages": ["interested"], "text": "website", "limit": 20} - list chats active in the period. "stages" and "text" are optional. Stages: ${STAGES.join(', ')}.`,
    run: ({ days: d, stages, text, limit }) => {
      const st = stageList(stages);
      const rows = all(`SELECT * FROM chats WHERE last_in_at >= ? ${st.length ? `AND stage IN (${st.map(() => '?').join(',')})` : ''}
                        ${text ? 'AND (name LIKE ? OR phone LIKE ? OR summary LIKE ? OR last_text LIKE ?)' : ''} ORDER BY last_in_at DESC LIMIT ?`,
        now() - days(d) * DAY, ...st, ...(text ? Array(4).fill(`%${text}%`) : []), Math.min(25, Number(limit) || 10));
      const total = get(`SELECT COUNT(*) n FROM chats WHERE last_in_at >= ? ${st.length ? `AND stage IN (${st.map(() => '?').join(',')})` : ''}`, now() - days(d) * DAY, ...st).n;
      return { total, shown: rows.length, chats: rows.map((c) => ({ id: c.id, name: title(c), stage: c.stage, about: clip(c.summary || c.last_text, 90), hours_ago: Math.round((now() - c.last_in_at) / 3_600_000), ...(c.needs_human ? { needs_owner: true } : {}) })) };
    },
  },
  read_chat: {
    doc: 'read_chat {"chat_id": 12} - the last 30 messages of one chat.',
    run: ({ chat_id }) => {
      const c = get('SELECT * FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      const rows = all('SELECT from_me, by, text, ts FROM (SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT 16) ORDER BY ts, id', c.id);
      return { name: title(c), stage: c.stage, summary: c.summary, messages: rows.map((m) => `${m.from_me ? (m.by === 'owner' ? 'Owner' : 'Agent') : 'Customer'}: ${clip(m.text, 200)}`) };
    },
  },
  count_targets: {
    doc: 'count_targets {"days": 5, "stages": []} - how many people a follow-up batch would reach (purchased and opted-out are excluded unless a stage is listed). Use before start_followups.',
    run: (a) => { const t = targets(a); return { people: t.length, examples: t.slice(0, 5).map(title) }; },
  },
  start_followups: {
    doc: 'start_followups {"days": 5, "stages": [], "instruction": "what to say / who it is for", "interval_minutes": 5, "limit": 100, "send": true} - read each matching chat, write a personal message following the instruction, and schedule them one by one with the interval. "send": true queues them to go out automatically; false leaves them as drafts for the owner to approve.',
    run: async (a) => {
      const t = targets(a);
      if (!t.length) return { started: false, reason: 'No chats match' };
      const s = getSettings().followup;
      const interval = Math.max(1, Number(a.interval_minutes) || 5);
      await runCampaign({ sinceDays: days(a.days), limit: Math.min(500, Number(a.limit) || 100), reanalyze: true, instruction: String(a.instruction || '').slice(0, 600), autoApprove: !!a.send, intervalMinutes: interval, stages: stageList(a.stages) });
      return { started: true, chats_being_read: Math.min(t.length, Number(a.limit) || 100), interval_minutes: interval, mode: a.send ? 'sends automatically' : 'drafts wait for approval',
        limits: `at most ${s.dailyCap} per number per day; nothing is sent between ${s.quietStart}:00 and ${s.quietEnd}:00 (${s.timezone}); people who would not benefit are skipped` };
    },
  },
  stop_followups: {
    doc: 'stop_followups {} - stop the running batch and cancel everything queued to send.',
    run: () => {
      campaign.cancel = true;
      const { changes } = run("UPDATE followups SET status = 'skipped', error = 'Cancelled by owner' WHERE status = 'approved'");
      emit('followups');
      return { cancelled: Number(changes) };
    },
  },
  send_message: {
    doc: 'send_message {"chat_id": 12, "text": "..."} - send one message to one customer now, typed at a human pace.',
    run: async ({ chat_id, text }) => {
      const c = get('SELECT * FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      if (c.stage === 'opted_out') return { error: 'This person asked not to be contacted' };
      if (!String(text || '').trim()) return { error: 'Empty message' };
      await humanSend(c, [String(text).trim().slice(0, 1200)], 'ai');
      return { sent_to: title(c) };
    },
  },
  update_chat: {
    doc: `update_chat {"chat_id": 12, "stage": "purchased", "notes": "...", "agent": "on|off|auto"} - change a chat's stage, notes for the agent, or whether the agent answers it. All fields optional.`,
    run: ({ chat_id, stage, notes, agent }) => {
      const c = get('SELECT id FROM chats WHERE id = ?', Number(chat_id));
      if (!c) return { error: 'No such chat' };
      const patch = {};
      if (STAGES.includes(stage)) patch.stage = stage;
      if (notes !== undefined) patch.notes = String(notes).slice(0, 2000);
      if (['on', 'off', 'auto'].includes(agent)) Object.assign(patch, { ai_enabled: agent === 'auto' ? null : agent === 'on' ? 1 : 0, ...(agent !== 'off' ? { needs_human: 0, paused_until: null } : {}) });
      update('chats', c.id, patch, ['stage', 'notes', 'ai_enabled', 'needs_human', 'paused_until']);
      emit('chat', { chatId: c.id });
      return { updated: Object.keys(patch) };
    },
  },
  remember: {
    doc: 'remember {"text": "Eid sale: 20% off all packages until 30 June"} - save a fact or rule the agent must use in every customer chat from now on.',
    run: ({ text }) => {
      const line = String(text || '').trim().slice(0, 600);
      if (!line) return { error: 'Nothing to remember' };
      const prev = getSettings().business.memory || '';
      saveSettings({ business: { memory: `${prev ? `${prev}\n` : ''}- ${line}` } });
      return { remembered: line };
    },
  },
  learn: {
    doc: 'learn {"source": "chats|website|profile", "url": "https://..."} - train the agent: from the owner\'s past chats, from a website (url required), or from the WhatsApp business profile and catalogue.',
    run: async ({ source, url }) => {
      if (source === 'website') { const r = await learnFromWebsite(String(url || '')); return { pages_read: r.pages, learned: r.text.slice(0, 700) }; }
      if (source === 'profile') { const r = await learnFromProfile(await wa.profiles()); return { learned: r.text.slice(0, 700) }; }
      const l = await learnFromChats({});
      return { started: true, conversations: l.chats, note: 'Runs in the background; the result appears on the Knowledge page.' };
    },
  },
  set_autopilot: {
    doc: 'set_autopilot {"on": true} - turn automatic replying on or off for every number.',
    run: ({ on }) => { saveSettings({ autopilot: !!on }); return { autopilot: !!on }; },
  },
};

function systemPrompt() {
  const s = getSettings();
  return `You are the operations assistant of ${s.business.name || 'a business'}'s WhatsApp agent. The business OWNER is talking to you (not a customer). Carry out what they ask using the actions below, then report back briefly in the owner's language.

Today is ${new Date().toLocaleString('en-GB', { timeZone: s.followup.timezone, dateStyle: 'full', timeStyle: 'short' })}. Autopilot is ${s.autopilot ? 'on' : 'off'}.

## Actions you can take
${Object.values(TOOLS).map((t) => `- ${t.doc}`).join('\n')}

## How to answer
Reply with ONLY one JSON object each turn, as plain text (no function-calling syntax):
- to take an action: {"action": "stats", "args": {"days": 5}}
- when finished or when you need something from the owner: {"reply": "your message to the owner"}
You get the result back and can then take another action or reply. At most ${MAX_STEPS} actions per request.

## Rules
- Before a batch that sends automatically ("send": true), take count_targets and tell the owner how many people it reaches, what the message is about and the interval, then wait for their yes. Skip the question only when the owner's message already said to send without asking, or is itself the yes to your earlier question.
- Never promise the owner something an action result did not confirm. Report what the tool result says, including limits.
- Batches skip people who bought or opted out unless the owner asks for a stage by name; people who asked not to be contacted are never messaged.
- "Every N minutes" means interval_minutes N. Only use the actions listed above.
- Talk to the owner in plain words. Never mention action names, arguments or JSON in your reply; say what you did or what you need instead ("I could not open the site: …", not "use the remember tool").`;
}

/** Run one owner request through the tool loop. */
export async function runCommand(text, history = []) {
  const messages = [...history, { role: 'user', content: text }];
  const steps = [];
  let corrections = 0;
  for (let i = 0; i <= MAX_STEPS; i++) {
    // A step is one short JSON object; the final reply to the owner rarely needs more than a few sentences.
    const out = await complete({ system: systemPrompt(), messages, maxTokens: 450 }, { purpose: 'command' });
    const obj = extractJson(toolCallToJson(out.text));
    const usable = obj && (TOOLS[obj.action] || (!obj.action && typeof obj.reply === 'string' && obj.reply.trim()));
    if (!usable) {
      // Plain prose with no JSON is still an answer to the owner.
      if (!obj && out.text.trim() && !/^\s*[{[<]/.test(out.text)) return { reply: out.text.trim(), steps };
      if (corrections++ < 3) {
        messages.push({ role: 'assistant', content: out.text.slice(0, 500) || '(empty)' });
        messages.push({ role: 'user', content: `That was not usable${obj?.action ? `: "${obj.action}" is not one of the actions` : ''}. Answer with exactly one JSON object: {"action": "<one of: ${Object.keys(TOOLS).join(', ')}>", "args": {...}} or {"reply": "..."}.` });
        i--;
        continue;
      }
      return { reply: 'The model kept answering in a form I could not use. Try again, or give Commands a larger model on the Models page.', steps };
    }
    if (!obj.action) return { reply: String(obj.reply).trim(), steps };
    const tool = TOOLS[obj.action];
    let result;
    try {
      result = tool ? await tool.run(obj.args || {}) : { error: `Unknown tool "${obj.action}"` };
    } catch (e) {
      result = { error: e.message };
    }
    steps.push({ action: obj.action, args: obj.args || {}, result });
    log('info', 'command', `${obj.action} ${JSON.stringify(obj.args || {}).slice(0, 200)}`);
    messages.push({ role: 'assistant', content: JSON.stringify({ action: obj.action, args: obj.args || {} }) });
    messages.push({ role: 'user', content: `[result of ${obj.action}] ${JSON.stringify(result).slice(0, 2000)}${i === MAX_STEPS - 1 ? '\nThat was the last tool you may use. Reply to the owner now.' : ''}` });
  }
  return { reply: 'I used every step I am allowed for one request. Here is what happened so far; tell me how to continue.', steps };
}

let queue = Promise.resolve();
/** Handle a command from the dashboard or from the owner's own WhatsApp chat; requests run one at a time. */
export function handleCommand(text, { chatId = null } = {}) {
  const job = queue.then(async () => {
    const history = all("SELECT role, text FROM (SELECT * FROM commands ORDER BY id DESC LIMIT 6) ORDER BY id").map((r) => ({ role: r.role === 'owner' ? 'user' : 'assistant', content: r.role === 'owner' ? clip(r.text, 300) : JSON.stringify({ reply: clip(r.text, 300) }) }));
    run('INSERT INTO commands (role, text, ts) VALUES (?,?,?)', 'owner', text, now());
    emit('command');
    let out;
    try {
      out = await runCommand(text, history);
    } catch (e) {
      out = { reply: `I could not do that: ${e.message}`, steps: [] };
    }
    run('INSERT INTO commands (role, text, steps, ts) VALUES (?,?,?,?)', 'agent', out.reply, JSON.stringify(out.steps), now());
    emit('command');
    if (chatId) await wa.sendText(chatId, out.reply, 'ai').catch((e) => log('error', 'command', `Could not answer in WhatsApp: ${e.message}`));
    return out;
  });
  queue = job.catch(() => {});
  return job;
}

export function startCommander() {
  wa.setHandlers({ onCommand: (chatId, text) => { if (getSettings().commandsViaWhatsApp) handleCommand(text, { chatId }); } });
}
