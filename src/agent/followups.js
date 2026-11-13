// Proactive messages: automatic nudges for quiet leads, and the "read old chats and follow up" campaign.
// Everything proactive is drip-fed: quiet hours, a daily cap per number, random gaps between sends.
import { all, get, run, now, update } from '../db.js';
import { getSettings, log, emit, sleep, rand, hourIn, isQuiet } from '../core.js';
import * as wa from '../wa/manager.js';
import { decide, CLOSED } from './brain.js';
import { eligibility, humanSend, scheduleNextFollowup } from './pipeline.js';

const nextSlot = new Map(); // accountId -> earliest time the next proactive message may go out
let drafting = false;
let sending = false;
export const campaign = { running: false, total: 0, done: 0, drafted: 0, failed: 0, cancel: false, startedAt: null, error: null };

const label = (c) => c.name || c.phone || c.jid;

function queue(chatId, kind, text, reason, status) {
  run('INSERT INTO followups (chat_id, kind, text, reason, status, due_at, created_at) VALUES (?,?,?,?,?,?,?)', chatId, kind, text, reason, status, now(), now());
  emit('followups');
}

/** 1) Turn due chats into drafts. */
async function draftDue() {
  if (drafting) return;
  drafting = true;
  try {
    const settings = getSettings();
    if (!settings.followup.enabled || !settings.autopilot) return;
    const due = all(`SELECT c.* FROM chats c WHERE c.next_followup_at IS NOT NULL AND c.next_followup_at <= ?
                     AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status IN ('pending','approved')) LIMIT 5`, now());
    for (const chat of due) {
      update('chats', chat.id, { next_followup_at: null }, ['next_followup_at']);
      const account = get('SELECT * FROM accounts WHERE id = ?', chat.account_id);
      if (CLOSED.includes(chat.stage) || !eligibility(chat, account, settings)[0]) continue;
      try {
        const d = await decide(chat.id, 'followup');
        update('chats', chat.id, { stage: d.stage, summary: d.summary }, ['stage', 'summary']);
        if (d.skip) { log('info', 'followup', `Skipped ${label(chat)}: ${d.reason || 'not worth a follow-up'}`); continue; }
        queue(chat.id, 'auto', d.message, d.reason, settings.followup.approval ? 'pending' : 'approved');
      } catch (e) {
        log('error', 'followup', `Could not draft a follow-up for ${label(chat)}: ${e.message}`);
        update('chats', chat.id, { next_followup_at: now() + 3_600_000 }, ['next_followup_at']); // try again in an hour
      }
    }
  } finally {
    drafting = false;
  }
}

/** 2) Send approved drafts, one per number per slot. */
async function sendApproved() {
  if (sending) return;
  sending = true;
  try {
    const s = getSettings().followup;
    if (isQuiet(hourIn(s.timezone), s.quietStart, s.quietEnd)) return;
    const accounts = all("SELECT DISTINCT c.account_id id FROM followups f JOIN chats c ON c.id = f.chat_id WHERE f.status = 'approved' AND f.due_at <= ?", now());
    for (const { id: accountId } of accounts) {
      if ((nextSlot.get(accountId) || 0) > now()) continue;
      if (wa.statusOf(accountId).state !== 'connected') continue;
      const sentToday = get("SELECT COUNT(*) n FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'sent' AND f.sent_at > ?", accountId, now() - 86_400_000).n;
      if (sentToday >= s.dailyCap) continue;
      const f = get("SELECT f.* FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.account_id = ? AND f.status = 'approved' AND f.due_at <= ? ORDER BY f.due_at, f.id LIMIT 1", accountId, now());
      if (!f) continue;
      nextSlot.set(accountId, now() + rand(s.gapMinSec, s.gapMaxSec) * 1000);
      const chat = get('SELECT * FROM chats WHERE id = ?', f.chat_id);
      if (chat.stage === 'opted_out' || chat.stage === 'purchased') {
        update('followups', f.id, { status: 'skipped', error: `Customer is ${chat.stage.replace('_', ' ')}` }, ['status', 'error']);
        continue;
      }
      try {
        await humanSend(chat, [f.text], 'followup');
        update('followups', f.id, { status: 'sent', sent_at: now() }, ['status', 'sent_at']);
        run('UPDATE chats SET followup_count = followup_count + 1 WHERE id = ?', chat.id);
        scheduleNextFollowup(chat.id);
        log('info', 'followup', `Follow-up sent to ${label(chat)}`);
      } catch (e) {
        update('followups', f.id, { status: 'failed', error: e.message.slice(0, 300) }, ['status', 'error']);
        log('error', 'followup', `Follow-up to ${label(chat)} failed: ${e.message}`);
      }
      emit('followups');
    }
  } finally {
    sending = false;
  }
}

/**
 * Campaign: read past conversations, classify each one, and draft a follow-up for
 * interested people who never bought. Drafts always wait for approval.
 */
export async function runCampaign({ accountId = null, sinceDays = 90, limit = 200, reanalyze = false } = {}) {
  if (campaign.running) throw new Error('A review is already running');
  const since = now() - sinceDays * 86_400_000;
  const chats = all(`SELECT c.* FROM chats c
      WHERE (?1 IS NULL OR c.account_id = ?1) AND c.last_in_at >= ?2 AND c.stage NOT IN ('purchased','opted_out')
        AND (?3 = 1 OR c.analyzed_at IS NULL)
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0) >= 1
        AND (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) >= 2
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.status IN ('pending','approved'))
      ORDER BY c.last_in_at DESC LIMIT ?4`, accountId, since, reanalyze ? 1 : 0, limit);
  Object.assign(campaign, { running: true, total: chats.length, done: 0, drafted: 0, failed: 0, cancel: false, startedAt: now(), error: null });
  emit('campaign', campaign);
  log('info', 'campaign', `Reviewing ${chats.length} past conversations`);
  (async () => {
    for (const chat of chats) {
      if (campaign.cancel) break;
      try {
        const d = await decide(chat.id, 'analyze');
        update('chats', chat.id, { stage: d.stage, summary: d.summary, analyzed_at: now() }, ['stage', 'summary', 'analyzed_at']);
        if (!d.skip) { queue(chat.id, 'campaign', d.message, d.reason, 'pending'); campaign.drafted++; }
      } catch (e) {
        campaign.failed++;
        campaign.error = e.message;
        if (/Every model in the chain|No AI model/.test(e.message)) { campaign.cancel = true; log('error', 'campaign', `Stopped: ${e.message}`); }
      }
      campaign.done++;
      emit('campaign', campaign);
      await sleep(rand(400, 1200)); // stay gentle on free-tier rate limits
    }
    campaign.running = false;
    emit('campaign', campaign);
    log('info', 'campaign', `Review finished: ${campaign.done} read, ${campaign.drafted} follow-ups drafted, ${campaign.failed} failed`);
  })();
  return campaign;
}

export function startFollowups() {
  const tick = () => draftDue().then(sendApproved).catch((e) => log('error', 'followup', e.message));
  setInterval(tick, 20_000).unref();
}
export const _tick = () => draftDue().then(sendApproved);
