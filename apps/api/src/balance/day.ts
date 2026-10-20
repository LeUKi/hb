/** Midnight in Beijing, today: where daily limits start again. */
export function startOfBeijingDay(now = Date.now()) {
  const offset = 8 * 60 * 60_000;
  return Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
}
