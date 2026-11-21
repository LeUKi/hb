// The site's day is Beijing's (UTC+8, no daylight saving): daily limits,
// “今天” on the panels and Credit's own daily limit (payments/quota.ts) all
// turn over at midnight there. One copy, so they cannot drift apart
// (sweep 2026-11-21).

export const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Midnight in Beijing, today: where daily limits start again. */
export function startOfBeijingDay(now = Date.now()) {
  return (
    Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
  );
}

/** The next midnight in Beijing after `now` (midnight itself is a new day). */
export function nextBeijingMidnight(now = Date.now()) {
  return startOfBeijingDay(now) + DAY_MS;
}
