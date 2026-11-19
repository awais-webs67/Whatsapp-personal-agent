import { tagsIn } from './tags.js';
// Understands the owner's most common orders directly, without asking a model to decide:
// "follow-up / reminder bhejo", "rok do", "chats parho aur seekho", "roz 9 baje ...".
// The owner said it once; that is the go-ahead. Small models tend to ask "should I?" forever,
// so these orders never reach them. Anything not recognised here still goes to the model.

const num = (m, d) => (m && m[1] ? Number(m[1]) : d);

// A request to message people (a follow-up, a reminder, an offer nudge)...
const FOLLOW = /follow[\s-]?ups?|followup|reminders?|remind|yaad\s*dila|offer\s*(yaad|bata|bhej)|confirm\s*kar/i;
// ...phrased as an order.
const DO_IT = /bh[ae]?j|send|kar\s*do|kardo|karo|kar\s*de|start|shuru|chala|laga\s*do/i;
// Questions are not orders.
const QUESTION = /\?\s*$|^(kya|kitne|kitni|kis|kab|kaun|kyun|kahan|how|what|which|did|is|are|why)\b|kitne|status|report|haal|progress/i;
const STOP = /(follow[\s-]?ups?|reminders?|messages?|msgs?|sab\s*kuch|sab|tasks?|bhejna).{0,25}(rok|band\s*kar|stop|cancel|khatam)|^(stop|rok\s*do|band\s*karo)\b/i;
const ANALYSE = /(chats?|conversations?|history|baat[\s-]?cheet|messages?|msgs?).{0,40}(parh|read|analy|review|check|scan|samjh|dekh)|(parh|read|analy|review|scan).{0,30}(chats?|conversations?|history)|\b(train|seekh|learn)/i;
// Words that mean "people in general" before "ko" (to). Any other word there is one named person.
const GROUP = new Set(['logon', 'log', 'logo', 'customers', 'customer', 'clients', 'client', 'leads', 'lead', 'sab', 'sabko', 'sabhi', 'un', 'in', 'unhein', 'inhein', 'walon', 'waalon', 'buyers', 'users', 'unhe', 'unko', 'inko', 'everyone', 'all', 'people', 'unn', 'jin', 'jinhon', 'dino', 'din']);

// "jinhon ne X khareeda / buy kiya / order kiya / le liya" = buyers. With "nahi/ni/not" = people who did not buy.
const BOUGHT = /(jinh?[oa][nm]?\s*(ne|na|nay)|jis\s*(ne|na)|jo\s*log|who|whoever|customers?\s*who|buyers?|khareedar|purchas(ed|ers?))\b[\s\S]{0,60}?(buy|bought|khar[ie]+d|kharid|purchas|order|le\s*li|liya|li\s*h|subscri)/i;
const NOT_BOUGHT = /(nahi|nahin|nhi|ni|not|never|na\s+hi)\s*(buy|khar|purchas|order|liya|li\b|kiya|ki\b)|(buy|khar[ie]+d|kharid|purchas|order)\w*\s*(nahi|nahin|nhi|ni|not)\b|didn'?t\s*(buy|purchase|order)|not\s*(yet\s*)?(bought|purchased)/i;

/** Who the order is about: people who bought, people who did not, or everyone talking to the shop. */
export function audienceOf(t) {
  if (NOT_BOUGHT.test(t)) return 'non_buyers';
  if (BOUGHT.test(t) || /\b(buyers|customers who bought|purchased customers|khareedaron)\b/i.test(t)) return 'buyers';
  return 'all';
}

/** Days of chats the order covers. */
export function parseDays(t, fallback = 7) {
  const s = t.toLowerCase();
  let m;
  if ((m = s.match(/(\d+)\s*(din|dino|dinon|days?)\b/))) return Number(m[1]);
  if ((m = s.match(/(\d+)?\s*(hafte|hafta|hafton|weeks?)\b/))) return 7 * num(m, 1);
  if ((m = s.match(/(\d+)?\s*(mahine|mahina|maheene|mahinon|months?)\b/))) return 30 * num(m, 1);
  if (/\b(aaj|today)\b/.test(s)) return 1;
  if (/\b(kal|yesterday)\b/.test(s) && !/kal\s+(subah|sham|raat|\d)/.test(s)) return 2;
  return fallback;
}

/** Minutes between messages. */
/**
 * "10 minute baad bhejna", "2 ghante baad", "aadhe ghante baad", "kal subah" (no) -> minutes to wait before the first
 * message; null when the text only says how far apart they go ("har 10 minute", "10 minute ka gap").
 */
export function startDelay(t) {
  const s = t.toLowerCase();
  if (/\b(abhi|foran|fauran|right\s*now|immediately)\b/.test(s) && !/baad|bad|after/.test(s)) return 0;
  const m = /(?<!har\s|every\s|each\s)\b(\d+(?:\.\d+)?|aadh[ae]|adh[ae]|ek|do|teen)\s*(minute|minutes|mins?|mint|mnt|ghante|ghanta|ghantay|hours?|hrs?)\s*(?:ke|k|ka)?\s*(?:baad|bad|after|later)\b/.exec(s);
  if (!m) return null;
  if (/\b(gap|waqf|farq|fasl|interval)/.test(s.slice(m.index, m.index + m[0].length + 12))) return null;
  const n = { aadha: 0.5, aadhe: 0.5, adha: 0.5, adhe: 0.5, ek: 1, do: 2, teen: 3 }[m[1]] ?? Number(m[1]);
  return Math.round(/^(ghant|hour|hr)/.test(m[2]) ? n * 60 : n);
}

/** A message about timing only ("ab 30 minute baad bhejna", "gap 10 minute kar do"): no new audience in it. */
export const TIMING_ONLY = (t) => /(minute|mint|mnt|ghant|hour|baad|gap|waqf|farq|random)/i.test(t)
  && !/\b(pichle|last|din|days?|hafte|weeks?|logon|logo|sab\s*ko|customers?|leads?|buyers?|khareed|tag)\b/i.test(t) && t.length < 160;

export function parseInterval(t, fallback = 5) {
  const s = t.toLowerCase();
  let m;
  if ((m = s.match(/(?:har|every|each)\s+(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/))) return Number(m[1]);
  if ((m = s.match(/(\d+)\s*(?:minute|minutes|mins?|mint|mnt)\s*(?:ke|ka|k|ki)?\s*(?:gap|waqfe|waqfa|waqfay|interval|farq|fasle|fasla)/))) return Number(m[1]);
  if ((m = s.match(/(?:gap|waqfa|waqfe|waqfay|farq|fasla|fasle|interval)\s*(?:of|ko|ka|ki)?\s*(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/))) return Number(m[1]);
  // "har 10 minute baad" is a gap; plain "10 minute baad" (no har/every) means start later: see startDelay.
  if ((m = s.match(/(?:har|every|each)\s+(\d+)\s*(?:minute|minutes|mins?|mint|mnt)\s*(?:ke|ka|k|ki)?\s*(?:baad|bad)/))) return Number(m[1]);
  if ((m = s.match(/(?:har|every)\s+(\d+)?\s*(?:ghante|ghanta|hours?)/))) return 60 * num(m, 1);
  return fallback;
}

/** A clock time in the text -> "HH:MM", or null. */
export function parseClock(t) {
  const s = t.toLowerCase();
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(baje|bajay|am|pm|a\.m\.|p\.m\.|o'?clock)/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const pm = /pm|p\.m\./.test(m[3]) || (/sham|shaam|dopahar|dopehar|evening|afternoon/.test(s) && h < 12) || (/raat|night/.test(s) && h >= 5 && h < 12);
  const am = /am|a\.m\./.test(m[3]) || /subah|morning/.test(s);
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (/raat|night/.test(s) && h === 12 && !am) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Is the order aimed at one named person ("Ali ko reminder bhejo")? Those need the model to find the chat. */
function namesOnePerson(t) {
  for (const m of t.matchAll(/([\p{L}\p{N}+]+)\s+ko\b/giu)) {
    const w = m[1].toLowerCase();
    if (!GROUP.has(w) && !/^(raat|subah|sham|abhi|aaj|kal|baad|pehle|unhy|unhay|unhen|inhen|inhy)$/.test(w)) return true;
  }
  return /\+?\d{10,13}/.test(t);
}

/**
 * Returns { action, args } for an order the app can carry out by itself, or null.
 * `scheduled` = this text is a scheduled task running now (so do not schedule it again).
 */
const TASK_REF = /\b(is|iss|isi|ye|yeh|us|usi|wahi|current|running|same)\s+(task|kaam|batch)\b|\b(task|kaam|batch)\s*#?\s*\d+|#\d+\b|chal(ta|te|ti|ne)\s*(hue|hua|wale|wala|wali)?\s*(task|kaam|batch)|\b(isko|isse|isme|is\s*mein|is\s*me)\b/i;
const OFF = /\b(band|off|bnd|disable)\b/i;
const HALT = /\b(rok|ruk|stop)\b/i; // "follow ups rok do" stops the running batch (stop_followups), it does not switch them off
const ON = /\b(on|chalu|start|shuru|enable|chala|khol)\b/i;
/** "follow up band karo", "auto reply on karo", "chats parhna band karo" -> which switch, on or off. */
export function switchIntent(t) {
  if (t.length > 120 || QUESTION.test(t) || /\d/.test(t)) return null;
  let on = OFF.test(t) ? false : ON.test(t) ? true : null;
  if (on === null && HALT.test(t) && !/follow\s*-?\s*ups?/i.test(t)) on = false;
  if (on === null) return null;
  if (/auto\s*-?\s*(reply|replies|jawab)|autopilot|customers?\s*ko\s*(jawab|reply)|auto\s*handl/i.test(t)) return { autopilot: on };
  if (/(chats?|messages?)\s*(parh|padh|read|reading)|reading/i.test(t)) return { reading: on };
  if (/follow\s*-?\s*ups?/i.test(t) && !/\b(bhej|send|ko)\b/i.test(t)) return { followups: on };
  return null;
}
/** "randomly 10,15,6,25 minutes" / "6 se 25 minute random" -> [6, 25] */
export function randomMinutes(t) {
  // "5 to 7 minutes", "5-7 min", "5 se 7 minute" is a range even without the word random.
  const r = /(\d+)\s*(?:to|-|–|se|sy|tak)\s*(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/i.exec(t);
  if (r && Number(r[1]) > 0 && Number(r[2]) > 0 && r[1] !== r[2]) return [Math.min(+r[1], +r[2]), Math.max(+r[1], +r[2])];
  if (!/random|randomly|alag\s*alag|kabhi/i.test(t)) return null;
  const m = /((?:\d+\s*(?:,|se|to|-|aur|and|or|\/)\s*)+\d+)\s*(?:minute|minutes|mins?|mint|mnt)/i.exec(t);
  const list = m ? m[1].split(/[^\d]+/).map(Number).filter((n) => n > 0) : [];
  return list.length >= 2 ? [Math.min(...list), Math.max(...list)] : null;
}

export function quickIntent(text, { scheduled = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return null;
  // "is task mein gap 10 minute kar do", "chalte task ko raat ko bhi bhejne do": change, never a new task.
  // ("is task ..." starts like an English question, so questions are told apart by ? and question words only.)
  if (TASK_REF.test(t) && !/\?\s*$|^(kya|kitne|kitni|kis|kab|kaun|kyun|kahan|how|what|which|why)\b|\bkitne\b|\bkitni\b/i.test(t)) {
    const args = {};
    const id = /(?:task|kaam)\s*#?\s*(\d+)|#(\d+)/i.exec(t);
    if (id) args.id = Number(id[1] || id[2]);
    const gap = randomMinutes(t) || (/(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/i.test(t) ? parseInterval(t, Number(/(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/i.exec(t)[1])) : null);
    if (gap && !(startDelay(t) && !/\b(har|every|gap|waqf|farq|interval)\b/i.test(t))) args.interval_minutes = gap;
    if (startDelay(t) != null) args.start_in_minutes = startDelay(t);
    if (/raat\s*ko\s*bhi|night\s*too/i.test(t)) args.ignore_quiet_hours = true;
    if (/\b(pause|rok\s*do|ruk\s*jao)\b/i.test(t)) args.pause = true;
    if (/\b(resume|dobara\s*shuru|phir\s*se\s*chala|continue)\b/i.test(t)) args.resume = true;
    // Only what can be read for sure goes straight through; anything about the wording goes to the model.
    const wording = /likh|bol|mention|zikr|message\s*mein|msg\s*mein|text|offer|discount|link|naam|tone|andaz/i.test(t);
    return !wording && Object.keys(args).some((k) => k !== 'id') ? { action: 'update_task', args } : null;
  }
  const sw = switchIntent(t);
  if (sw) return { action: 'change_settings', args: sw };
  const gap = randomMinutes(t);
  if (gap && !/\b(pichle|last|din|days?|logon|logo|customers?|leads?)\b/i.test(t)) return { action: 'change_settings', args: { followup_gap_minutes: gap } };
  if (STOP.test(t) && !/mat\s*(rok|band)/i.test(t)) return { action: 'stop_followups', args: {} };

  const wantsSend = FOLLOW.test(t) && DO_IT.test(t) && !QUESTION.test(t);
  const wantsAnalysis = ANALYSE.test(t) && !QUESTION.test(t);
  if (!wantsSend && !wantsAnalysis) return null;
  if (wantsSend && namesOnePerson(t)) return null;

  // "roz 9 baje ...", "kal subah 10 baje ..." -> set it up as a task for later.
  if (!scheduled) {
    const clock = parseClock(t);
    const daily = /\b(roz|rozana|daily|every\s*day|har\s*(din|roz|subah|sham|raat))\b/i.test(t);
    if (clock && daily) return { action: 'schedule_task', args: { instruction: t, daily_at: clock } };
    if (clock) return { action: 'schedule_task', args: { instruction: t, at: clock } };
    if (daily) return null; // repeating, but no time given: let the model ask for it
  }

  if (wantsSend) {
    return {
      action: 'start_followups',
      args: {
        // Tagged customers are picked by the tag, not by how recent they are: look back a year unless a period is named.
        days: tagsIn(t).length ? parseDays(t, 365) : parseDays(t), interval_minutes: randomMinutes(t) || Math.max(1, parseInterval(t)),
        ...(startDelay(t) ? { start_in_minutes: startDelay(t) } : {}), instruction: t,
        stages: /\binterested\b/i.test(t) ? ['interested', 'negotiating'] : [],
        audience: audienceOf(t),
        tags: tagsIn(t),
        send: !/\b(draft|approval|approve|pehle\s*dikha|review\s*kar(wa|ne))\b/i.test(t),
        ignore_quiet_hours: /raat\s*ko\s*bhi|night\s*too|abhi|foran|fauran|right\s*now|immediately|quiet\s*hours?\s*(ignore|ke\s*bawajood)/i.test(t),
      },
    };
  }
  return { action: 'analyse_chats', args: { days: parseDays(t, 90), again: /dobara|dubara|phir\s*se|again|re-?read|naye\s*sire\s*se/i.test(t) } };
}

// The model asked for permission instead of acting.
export const ASKS_PERMISSION = /\?\s*$|kya\s*(main|mein|me)\b|kar\s*d(u|oo)n|karun|bhej\s*d(u|oo)n|shuru\s*kar(u|oo)n|should i|shall i|do you want|would you like|confirm|ijazat|permission|go ahead\?/i;
