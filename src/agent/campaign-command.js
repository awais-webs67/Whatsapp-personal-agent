// Commands typed inside one campaign. Everything said there is about that campaign: common orders (pause, resume,
// gap, start later, switches, status) run straight away without a model; anything else goes to the command model
// with the campaign as context.
import { get } from '../db.js';
import { getSettings } from '../core.js';
import { controlTask, taskView } from './tasks.js';
import { updateCampaign } from './campaign-edit.js';
import { randomMinutes, startDelay, parseInterval } from './intent.js';

const OFF = /\b(band|off|bnd|disable|mat|nahi|na)\b/i;
const ON = /\b(on|chalu|enable|kholo|karo|kar\s*do|shuru)\b/i;
const QUESTION = /\?\s*$|^(kya|kitne|kitni|kis|kab|kaun|kyun|kahan|how|what|which|why)\b/i;
const at = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getSettings().followup.timezone });

/** One short line on where a campaign is: what it is doing now and what comes next. */
export function campaignStatus(t) {
  const v = taskView(t);
  const state = { active: 'chal raha hai', paused: 'ruka hua hai (paused)', done: 'khatam ho gaya', failed: 'fail ho gaya' }[t.status] || t.status;
  const lines = [`Campaign #${t.id} "${t.title}" ${state}.`];
  const p = v.progress;
  if (p?.reading) lines.push(`Abhi chats parh raha hai: ${p.reading.done} of ${p.reading.total}${p.reading.current ? ` (ab: ${p.reading.current})` : ''}.`);
  if (p) lines.push(`${p.sent} bheje, ${p.queued} line mein${p.drafts ? `, ${p.drafts} aap ki approval ka intezar` : ''}${p.skipped ? `, ${p.skipped} chhor diye` : ''}${p.failed ? `, ${p.failed} fail` : ''}.`);
  if (v.stats && t.kind === 'auto') lines.push(`${v.stats.members || 0} log is mein, ${v.stats.sent || 0} follow-ups gaye, ${v.stats.replied || 0} ne reply kiya, ${v.stats.bought || 0} ne khareeda.`);
  if (v.stats && t.kind === 'email') lines.push(`${v.stats.members || 0} contacts, ${v.stats.sent || 0} emails gayi, ${v.stats.replied || 0} replies, ${v.stats.waiting || 0} baqi.`);
  const next = get("SELECT f.due_at, c.name, c.phone FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.task_id = ? AND f.status = 'approved' ORDER BY f.due_at LIMIT 1", t.id);
  if (next && t.status === 'active') lines.push(`Agla message ${next.name || `+${next.phone}`} ko, ${next.due_at <= Date.now() + 30_000 ? 'abhi' : `${at(next.due_at)} par (${Math.max(1, Math.round((next.due_at - Date.now()) / 60_000))} min mein)`}.`);
  if (v.waiting) lines.push(`Note: ${v.waiting}`);
  if (t.last_result && ['scheduled', 'analysis'].includes(t.kind)) lines.push(`Aakhri result: ${t.last_result.slice(0, 300)}`);
  return lines.join('\n');
}

/** A common order about this campaign, done without a model; null when the model should handle it. */
export async function campaignQuick(id, text) {
  const t = get("SELECT * FROM tasks WHERE id = ? AND status != 'removed'", Number(id));
  if (!t) return { reply: 'Yeh campaign ab mojood nahi.', steps: [] };
  const s = text.trim().toLowerCase();
  const done = (reply, action, args, result) => ({ reply, steps: action ? [{ action, args: { id: t.id, ...args }, result }] : [] });
  if (s.length > 140) return null;

  if (/^(status|progress|haal|update|report)\b|kya\s*(ho\s*raha|chal\s*raha|scene)|kahan\s*tak|kitne\s*(gaye|bhej|sent)/.test(s)) return done(campaignStatus(t));
  if (QUESTION.test(s)) return null;

  // Pause / resume the whole campaign.
  if (/^(pause|rok|ruk|stop|band)\b|\b(campaign|campain|is)\s*(ko)?\s*(rok|pause|band|stop)|^(roko|rok\s*do|band\s*karo|pause\s*karo)$/.test(s) && !/follow|reply|raat|night|approval/.test(s)) {
    if (t.status !== 'active') return done(`Campaign #${t.id} pehle se ruka hua hai.`);
    controlTask(t.id, 'pause');
    return done(`Campaign #${t.id} rok diya. "resume" likho to wahin se chalega.`, 'pause', {}, { ok: true });
  }
  if (/^(resume|chalao|chala\s*do|start|shuru|dobara|phir\s*se)\b|\b(campaign|is)\s*(ko)?\s*(chalao|resume|shuru)/.test(s) && !/follow|reply|raat|night|approval|minute|baad/.test(s)) {
    if (t.status !== 'paused') return done(`Campaign #${t.id} pehle se chal raha hai.`);
    controlTask(t.id, 'resume');
    return done(`Campaign #${t.id} dobara chala diya.`, 'resume', {}, { ok: true });
  }

  // Switches that belong to this campaign only.
  const on = OFF.test(s) ? false : ON.test(s) ? true : null;
  if (on !== null && t.kind === 'auto') {
    if (/follow\s*-?\s*ups?/.test(s)) { const r = await updateCampaign(t.id, { followups: on }, 'command'); return done(`Is campaign ke follow-ups ${on ? 'on' : 'band'} kar diye.`, 'update', { followups: on }, r); }
    if (/auto\s*-?\s*(reply|replies|jawab)|reply/.test(s)) { const r = await updateCampaign(t.id, { autoReply: on }, 'command'); return done(`Is campaign mein auto reply ${on ? 'on' : 'band'}.`, 'update', { autoReply: on }, r); }
  }
  if (on !== null && ['auto', 'batch'].includes(t.kind)) {
    if (/raat|night/.test(s)) { const r = await updateCampaign(t.id, { night: on }, 'command'); return done(on ? 'Ab raat ko bhi bhejega.' : 'Raat ko kuch nahi jayega.', 'update', { night: on }, r); }
    if (/approval|ijazat|pooch|puch|mujh\s*se\s*pooch/.test(s)) { const r = await updateCampaign(t.id, { approval: on }, 'command'); return done(on ? 'Ab har message aap ki approval ka intezar karega.' : 'Ab messages bina pooche jayenge.', 'update', { approval: on }, r); }
  }

  // Timing: "gap 5 to 7 minute", "har 10 minute", "20 minute baad shuru karo".
  if (['auto', 'batch', 'email'].includes(t.kind)) {
    const range = randomMinutes(text);
    const single = !range && /\b(har|every|gap|waqf|farq|fasl|interval)/.test(s) ? parseInterval(text, 0) || null : null;
    const delay = t.kind === 'batch' ? startDelay(text) : null;
    if (range || single || delay != null) {
      const patch = { ...(range ? { gapMin: range[0], gapMax: range[1] } : single ? { gapMin: single, gapMax: single } : {}), ...(delay != null ? { startInMinutes: delay } : {}) };
      const r = await updateCampaign(t.id, patch, 'command');
      const said = [range ? `gap ab ${range[0]} se ${range[1]} minute (random)` : single ? `gap ab ${single} minute` : null, delay != null ? `agla message ${delay} minute mein` : null].filter(Boolean).join(', ');
      return done(`Theek hai: ${said}. ${t.kind === 'email' ? 'Agli emails' : 'Jo messages abhi nahi gaye'} isi hisaab se jayenge.`, 'update', patch, r);
    }
  }
  return null;
}

/** What the command model is told when the owner writes inside a campaign. */
export function campaignBrief(id) {
  const t = get('SELECT * FROM tasks WHERE id = ?', Number(id));
  if (!t) return '';
  let p = {};
  try { p = JSON.parse(t.params || '{}') || {}; } catch { /* none */ }
  const product = [...new Set([...(p.keywords || []), ...(p.adText || [])].map((w) => String(w).trim()).filter(Boolean))];
  return `\n\n## The owner is writing inside campaign #${t.id} "${t.title}" (${t.kind})
You can see and search ALL WhatsApp chats on every number (find_chats, read_chat), not only this campaign's people.
"Is product", "is campaign ka product", "is offer" means what this campaign is about: ${product.length ? `the words ${product.map((w) => `"${w}"`).join(', ')}` : `"${t.title}"`}${product.length ? ` (campaign "${t.title}")` : ''}. Use these as find_chats words (and ad_text) when the owner says that.
To bring found people into this campaign use add_to_campaign with the same filters.
Work the owner asks for here (reading chats and sending follow-ups, labels, schedules) becomes a task of this campaign with live progress. When the owner gives an exact message for new leads of this campaign, save it with edit_knowledge (field followupStyle for follow-ups, or offer/examples for replies) so new people get it too. When the owner says that from now on new people about something should be handled here, add those words to this campaign's keywords or ad_text with update_task (keep the words it already has).
Everything in this conversation is about campaign #${t.id} unless the owner names another number. "Is", "ye", "this" and orders without a number mean campaign #${t.id}: pass id ${t.id} (task_id ${t.id}) to update_task, label_chats and the like. Do not start a new campaign unless the owner clearly asks for a new one.
Where it is now:\n${campaignStatus(t)}`;
}
