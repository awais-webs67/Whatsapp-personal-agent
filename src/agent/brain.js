// The agent's thinking: turns a chat + business knowledge into a structured decision.
import { all, get } from '../db.js';
import { getSettings } from '../core.js';
import { complete } from '../llm/router.js';

export const STAGES = ['new', 'engaged', 'interested', 'negotiating', 'purchased', 'not_interested', 'opted_out'];
export const CLOSED = ['purchased', 'not_interested', 'opted_out'];

const section = (title, body) => (String(body || '').trim() ? `\n## ${title}\n${String(body).trim()}\n` : '');

function ago(ts) {
  if (!ts) return 'never';
  const h = (Date.now() - ts) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function buildSystem(settings, chat, mode) {
  const b = settings.business;
  const who = b.persona?.trim() || 'a member of the sales team';
  const shop = b.name?.trim() || 'this business';
  const out = [`You are ${who}, chatting with a person on WhatsApp on behalf of ${shop}.\nYour job: ${b.goal?.trim() || 'Help the person with what they ask.'}`];

  out.push(section('About the business', b.about));
  out.push(section('Products, services and prices', b.catalog));
  out.push(section('Frequently asked questions', b.faqs));
  out.push(section('Policies (delivery, payment, returns)', b.policies));
  out.push(section('Example replies in our voice', b.examples));
  out.push(section('Learned from the owner\'s own past chats (how they answer, what they quote; if this conflicts with a section above, the section above wins)', b.learned));
  out.push(section('From the business website and WhatsApp profile', b.learnedWeb));
  out.push(section('Standing instructions from the owner (always follow)', b.memory));

  out.push(`
## How to write
- ${b.tone}
- ${b.language}
- Write like a person texting: 1 to 3 short bubbles, plain text, no markdown, no headings, no lists. Ask at most one question at a time.
- Read the whole conversation first. Never repeat something already answered, never re-greet mid-conversation.
- Move the conversation one step toward your job above, without pressure.

## Hard rules
- Only state prices, stock, delivery times, discounts and policies that appear above. If the answer is not there, say you will confirm and set "handoff" to true. Never make something up.
- If the customer sincerely asks whether they are talking to a bot, an AI or a real person, tell the truth: you are an AI assistant for ${shop}, and a team member can step in if they prefer. Do not claim to be human.
- If the customer asks not to be contacted, apologise in one line, confirm, and set "stage" to "opted_out".
- Set "handoff" to true for refunds, complaints, payment disputes, angry customers, custom quotes, or anything you cannot answer from the information above.
- What counts as a purchase: ${b.purchaseSignal}`);

  out.push(`
## This customer
- Name: ${chat.name || 'unknown'}
- Current stage: ${chat.stage}
- Last message from them: ${ago(chat.last_in_at)}
- Summary so far: ${chat.summary || 'none'}${chat.notes ? `\n- Notes from the owner (follow these): ${chat.notes}` : ''}
- Current time: ${new Date().toLocaleString('en-GB', { timeZone: settings.followup.timezone, dateStyle: 'full', timeStyle: 'short' })}`);

  const stageList = STAGES.join(' | ');
  if (mode === 'reply') {
    out.push(`
## Output
Return ONLY a JSON object, nothing before or after it:
{"messages": ["bubble 1", "bubble 2"], "stage": "${stageList}", "summary": "one line: what they want and where things stand", "handoff": false, "handoff_reason": "", "followup_hours": null}
"followup_hours" is optional: how long to wait before a gentle follow-up if they go quiet (a number), or null to use the default schedule.`);
  } else if (mode === 'followup') {
    out.push(`
## Task: follow-up
The customer has gone quiet. Decide whether one short, friendly follow-up makes sense, based on the conversation. It must feel personal to what they asked about, add something useful (an answer, a reminder of what they liked, an offer to help), and be easy to ignore. No guilt, no fake urgency, no "just checking in" filler.
Skip the follow-up if they already bought, clearly declined, asked not to be contacted, or the last message from us already was an unanswered follow-up with nothing new to add.

## Output
Return ONLY a JSON object:
{"skip": false, "message": "the follow-up text", "stage": "${stageList}", "summary": "one line", "reason": "why you are following up or skipping"}`);
  } else {
    out.push(`
## Task: review an old conversation
Read this past conversation and classify it. Then decide whether a follow-up is worth sending now. Follow up only when the customer showed real interest and did not buy, and was not rude or opted out. The message must reference what they actually asked about and work even though time has passed.

## Output
Return ONLY a JSON object:
{"stage": "${stageList}", "summary": "one line: what they wanted and how it ended", "should_followup": true, "message": "the follow-up text, or empty", "reason": "short reason"}`);
  }
  return out.join('').trim();
}

/** Conversation rows -> chat-completion turns. */
export function buildTurns(chatId, limit) {
  const rows = all('SELECT from_me, text, ts FROM messages WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?', chatId, limit).reverse();
  return rows.map((r) => ({ role: r.from_me ? 'assistant' : 'user', content: r.text || '' }));
}

/** Tolerant JSON extraction: models wrap JSON in prose or code fences more often than not. */
export function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

const cleanText = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').trim().slice(0, 1200);
const cleanStage = (s, fallback) => (STAGES.includes(s) ? s : fallback);

export function parseDecision(text, mode, chat) {
  const obj = extractJson(text);
  if (!obj) {
    // A plain-text answer is still a usable reply; half-broken JSON is not something to send a customer.
    if (mode !== 'reply' || /^\s*[{[]/.test(text) || /"messages"\s*:/.test(text)) throw new Error('Model did not return valid JSON');
    return { messages: [cleanText(text)], stage: chat.stage === 'new' ? 'engaged' : chat.stage, summary: chat.summary || '', handoff: false, handoffReason: '', followupHours: null };
  }
  // An opt-out is the customer's decision: a model can never move them back. Only the owner can.
  const stage = chat.stage === 'opted_out' ? 'opted_out' : cleanStage(obj.stage, chat.stage);
  const summary = cleanText(obj.summary).slice(0, 300) || chat.summary || '';
  if (mode === 'reply') {
    const raw = Array.isArray(obj.messages) ? obj.messages : [obj.messages ?? obj.message ?? obj.reply];
    const messages = raw.map(cleanText).filter(Boolean).slice(0, 4);
    if (!messages.length && !obj.handoff) throw new Error('Model returned an empty reply');
    const hours = Number(obj.followup_hours);
    return { messages, stage, summary, handoff: !!obj.handoff, handoffReason: cleanText(obj.handoff_reason).slice(0, 200), followupHours: hours > 0 && hours <= 24 * 30 ? hours : null };
  }
  const message = cleanText(obj.message);
  const skip = mode === 'followup' ? !!obj.skip || !message : !obj.should_followup || !message;
  return { skip, message, stage, summary, reason: cleanText(obj.reason).slice(0, 300) };
}

/**
 * Ask the model chain for a decision about one chat.
 * mode: 'reply' (answer the customer) | 'followup' (nudge a quiet lead) | 'analyze' (classify old chat)
 */
export async function decide(chatId, mode = 'reply', { turns = null, chatOverride = null, instruction = '' } = {}) {
  const settings = getSettings();
  const chat = chatOverride || get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat) throw new Error('Chat not found');
  const messages = turns || buildTurns(chatId, mode === 'analyze' ? Math.max(40, settings.llm.historyMessages) : settings.llm.historyMessages);
  if (mode !== 'reply') {
    messages.push({ role: 'user', content: `[Instruction from the business owner, not from the customer] ${mode === 'followup' ? `The customer has been quiet since ${ago(chat.last_in_at)}. This would be follow-up number ${(chat.followup_count || 0) + 1}.` : 'Review the conversation above.'}${instruction ? ` For this batch the owner asked: "${instruction}". Let that decide who gets a message and what it says (should_followup true whenever the owner's request applies to this person), while keeping every hard rule.` : ''} Respond with the JSON object described in your instructions.` });
  }
  const system = buildSystem(settings, chat, mode);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await complete({ system, messages }, { purpose: mode });
    try {
      return { ...parseDecision(out.text, mode, chat), provider: out.providerName, model: out.model, latencyMs: out.latencyMs, hops: out.hops };
    } catch (e) {
      lastErr = e; // one retry: a second sample usually fixes malformed JSON
    }
  }
  throw lastErr;
}
