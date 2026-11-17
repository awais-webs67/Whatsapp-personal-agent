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
export function parseInterval(t, fallback = 5) {
  const s = t.toLowerCase();
  let m;
  if ((m = s.match(/(?:har|every|each)\s+(\d+)\s*(?:minute|minutes|mins?|mint|mnt)/))) return Number(m[1]);
  if ((m = s.match(/(\d+)\s*(?:minute|minutes|mins?|mint|mnt)\s*(?:ke|ka|k|ki)?\s*(?:baad|bad|gap|waqfe|waqfa|interval)/))) return Number(m[1]);
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
export function quickIntent(text, { scheduled = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return null;
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
        days: parseDays(t), interval_minutes: Math.max(1, parseInterval(t)), instruction: t,
        stages: /\binterested\b/i.test(t) ? ['interested', 'negotiating'] : [],
        audience: audienceOf(t),
        send: !/\b(draft|approval|approve|pehle\s*dikha|review\s*kar(wa|ne))\b/i.test(t),
        ignore_quiet_hours: /raat\s*ko\s*bhi|night\s*too|abhi|foran|fauran|right\s*now|immediately|quiet\s*hours?\s*(ignore|ke\s*bawajood)/i.test(t),
      },
    };
  }
  return { action: 'analyse_chats', args: { days: parseDays(t, 90) } };
}

// The model asked for permission instead of acting.
export const ASKS_PERMISSION = /\?\s*$|kya\s*(main|mein|me)\b|kar\s*d(u|oo)n|karun|bhej\s*d(u|oo)n|shuru\s*kar(u|oo)n|should i|shall i|do you want|would you like|confirm|ijazat|permission|go ahead\?/i;
