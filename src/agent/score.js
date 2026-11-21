// Lead score: who is closest to buying right now, from what is already known (no AI call).
// 0-100, with a label: hot (talk to them now), warm (keep nurturing), cold (low priority).
const H = 3_600_000;

export function leadScore(c, at = Date.now()) {
  if (!c) return { score: 0, label: 'cold', why: [] };
  if (['purchased'].includes(c.stage)) return { score: 100, label: 'customer', why: ['Bought'] };
  if (['opted_out', 'not_interested'].includes(c.stage)) return { score: 0, label: 'cold', why: [c.stage === 'opted_out' ? 'Asked not to be contacted' : 'Not interested'] };
  let p = {};
  try { p = JSON.parse(c.profile || '{}') || {}; } catch { /* none */ }
  let s = { new: 15, engaged: 30, interested: 55, negotiating: 75 }[c.stage] ?? 15;
  const why = [];
  const age = c.last_in_at ? (at - c.last_in_at) / H : Infinity;
  if (age < 2) { s += 15; why.push('Wrote in the last 2 hours'); } else if (age < 24) { s += 8; why.push('Wrote today'); } else if (age > 24 * 7) { s -= 15; why.push('Quiet for over a week'); }
  if (p.wants?.length) { s += 5; why.push(`Asked about ${p.wants.slice(0, 2).join(', ')}`); }
  if (p.budget) { s += 6; why.push(`Budget: ${p.budget}`); }
  if (p.promised) { s += 4; why.push(`Waiting on: ${p.promised}`); }
  if (p.objections?.length) { s -= 6; why.push(`Holding back: ${p.objections.slice(0, 2).join(', ')}`); }
  if ((c.followup_count || 0) >= 2 && age > 48) { s -= 8; why.push(`${c.followup_count} follow-ups without a reply`); }
  if (c.needs_human) { s += 5; why.push('Waiting for you'); }
  s = Math.max(1, Math.min(99, Math.round(s)));
  return { score: s, label: s >= 65 ? 'hot' : s >= 40 ? 'warm' : 'cold', why };
}
