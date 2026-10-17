import type { ApiBindings } from "../env";

// A merchant stopped by Credit's daily limit (“已超过每日限额”). The limit is
// the paying account's, summed over its whole day, so nothing that merchant
// sends can pass before the day turns: its payments wait together (the
// oldest open one goes first, the rest queue behind it) until then.
//
// Credit counts the day in its process's time zone; its image sets
// Asia/Shanghai (linux-do/credit Dockerfile, `ARG TZ=Asia/Shanghai`), which
// keeps no daylight saving.

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** After the turn of the day, so the first try lands in the new one. */
const RESUME_MIN_MS = 5 * 60_000;
/** Spread over this, so merchants do not all send at the same moment. */
const RESUME_SPREAD_MS = 25 * 60_000;

/** The next midnight in Shanghai after `now`. */
export function nextQuotaReset(now: number) {
  return (
    Math.floor((now + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS +
    DAY_MS -
    SHANGHAI_OFFSET_MS
  );
}

/** When a merchant stopped by its daily limit sends again: 00:05–00:30. */
export function quotaResumeAt(now: number) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return (
    nextQuotaReset(now) +
    RESUME_MIN_MS +
    Math.floor(((random[0] ?? 0) / 2 ** 32) * RESUME_SPREAD_MS)
  );
}

/**
 * The merchants among `merchantIds` that are stopped by the daily limit,
 * with when they send again: their waiting payment's next send.
 */
export async function quotaHolds(
  env: ApiBindings,
  merchantIds: string[],
  now = Date.now(),
): Promise<Map<string, number>> {
  const ids = [...new Set(merchantIds)];
  if (!ids.length) return new Map();
  const rows = await env.DB.prepare(
    `SELECT m.id AS merchantId, COALESCE(h.next_send_at,h.next_run_at) AS resumeAt
      FROM merchants m JOIN payment_tasks h ON h.id=m.active_task_id
      WHERE m.id IN (SELECT value FROM json_each(?)) AND m.paused_reason='quota'
        AND h.status='waiting' AND h.reason='quota'
        AND COALESCE(h.next_send_at,h.next_run_at)>?`,
  )
    .bind(JSON.stringify(ids), now)
    .all<{ merchantId: string; resumeAt: number }>();
  return new Map(rows.results.map((row) => [row.merchantId, row.resumeAt]));
}
