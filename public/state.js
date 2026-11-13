/** Shared live state. Pages read it and subscribe to server events through `live`. */
export const S = { accounts: [], providers: [], autopilot: true, stats: {} };
export const subs = new Set();
export const live = {
  /** Subscribe until the next navigation. */
  on(type, fn) { const s = { type, fn }; subs.add(s); return () => subs.delete(s); },
};
