import { PAYOUT_SAFE_SHARE_MINOR, QUOTA_MORE_TRIES } from "@hb/contracts";
import { tellPaymentWatchers } from "../activities/live";
import type { ApiBindings } from "../env";
import { noticePayoutOverLimit } from "../notices/events";
import { nextBeijingMidnight } from "../runtime/day";

// Credit's daily limit (“已超过每日限额”). The limit is the paying account's,
// summed over its whole day; a refusal says only that what is left today is
// less than that payment, so a smaller one may still go
// (docs/payout-cap-design.md §2). The refused payment waits for the day to
// turn; the merchant goes on with what is smaller than the smallest refused,
// a few more at most, then waits too. A share over 800 LDC, refused again
// on the next day, is more than the account can pay in a day: it ends
// failed (§3).
//
// Credit counts the day in its process's time zone; its image sets
// Asia/Shanghai (linux-do/credit Dockerfile, `ARG TZ=Asia/Shanghai`), which
// keeps no daylight saving: the same day as this site's own (runtime/day.ts).

/** After the turn of the day, so the first try lands in the new one. */
const RESUME_MIN_MS = 5 * 60_000;
/** Spread over this, so merchants do not all send at the same moment. */
const RESUME_SPREAD_MS = 25 * 60_000;

/** The next midnight in Shanghai after `now`. */
export function nextQuotaReset(now: number) {
  return nextBeijingMidnight(now);
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

type QuotaDay = { quotaUntil: number | null };

/**
 * The day's limit refused one of this merchant's payments: when it sends
 * again. Every payment refused the same day resumes at the same time.
 */
export function quotaResumeOf(merchant: QuotaDay, now: number) {
  return merchant.quotaUntil !== null && merchant.quotaUntil > now
    ? merchant.quotaUntil
    : quotaResumeAt(now);
}

/**
 * Keeps the refusal on the merchant (§2): until when, the smallest amount
 * refused, how many were. A new day starts over. Under the lease `token`.
 */
export function quotaRefusalStatement(
  env: ApiBindings,
  merchantId: string,
  token: string,
  amountMinor: number,
  resumeAt: number,
  now: number,
) {
  return env.DB.prepare(
    `UPDATE merchants SET
        quota_below=CASE WHEN quota_until>?1 THEN MIN(COALESCE(quota_below,?2),?2) ELSE ?2 END,
        quota_refusals=CASE WHEN quota_until>?1 THEN quota_refusals+1 ELSE 1 END,
        quota_until=?3
      WHERE id=?4 AND lease_token=?5`,
  ).bind(now, amountMinor, resumeAt, merchantId, token);
}

/**
 * SQL: payment `p` of merchant `m` may be tried at `now` as far as the day's
 * limit goes: not one refused and waiting for the day to turn, and, on a
 * day the limit refused one, smaller than the smallest refused while the
 * merchant has tries left.
 */
export function quotaOpenSql(p: string, m: string, now: number) {
  const at = Math.floor(now);
  return `NOT (${p}.status='waiting' AND ${p}.reason='quota' AND ${p}.next_run_at>${at})
    AND (${m}.quota_until IS NULL OR ${m}.quota_until<=${at}
      OR (${p}.amount_minor<${m}.quota_below AND ${m}.quota_refusals<=${QUOTA_MORE_TRIES}))`;
}

/**
 * SQL: when payment `p` of merchant `m` may be tried: its own next run, or,
 * kept back by the day's limit, not before the day turns for the merchant.
 */
export function quotaDueSql(p: string, m: string, now: number) {
  return `CASE WHEN ${quotaOpenSql(p, m, now)} THEN ${p}.next_run_at
    ELSE MAX(${p}.next_run_at, COALESCE(${m}.quota_until, ${p}.next_run_at)) END`;
}

export type QuotaHold = {
  /** When the day turns for it: everything it holds is tried again. */
  resumeAt: number;
  /** Payments from this amount up wait until then. */
  below: number;
  /** No tries left today: every payment waits. */
  exhausted: boolean;
};

/** The merchants among `merchantIds` the day's limit refused today. */
export async function quotaHolds(
  env: ApiBindings,
  merchantIds: string[],
  now = Date.now(),
): Promise<Map<string, QuotaHold>> {
  const ids = [...new Set(merchantIds)];
  if (!ids.length) return new Map();
  const rows = await env.DB.prepare(
    `SELECT id, quota_until AS resumeAt, quota_below AS below, quota_refusals AS refusals
      FROM merchants WHERE id IN (SELECT value FROM json_each(?)) AND quota_until>?`,
  )
    .bind(JSON.stringify(ids), now)
    .all<{
      id: string;
      resumeAt: number;
      below: number | null;
      refusals: number;
    }>();
  return new Map(
    rows.results.map((row) => [
      row.id,
      {
        resumeAt: row.resumeAt,
        below: row.below ?? 0,
        exhausted: row.refusals > QUOTA_MORE_TRIES,
      },
    ]),
  );
}

/** This open payment waits for the day to turn (§2), or may still go today. */
export function heldByQuota(
  payment: { status: string; reason: string | null; amountMinor: number },
  hold: QuotaHold | undefined,
) {
  if (!hold) return false;
  return (
    (payment.status === "waiting" && payment.reason === "quota") ||
    hold.exhausted ||
    payment.amountMinor >= hold.below
  );
}

/**
 * A share over 800 LDC the day's limit refused on two days ends failed
 * (§3): never sent, nothing in flight, its merchant not mid-send. Its
 * sender and the claimant hear it; the merchant goes on. Each minute, from
 * the payments job.
 */
export async function sweepQuotaFailures(env: ApiBindings, now = Date.now()) {
  const failed = await env.DB.prepare(
    `UPDATE payment_tasks SET status='failed',reason='quota',send_block_reason='quota',
        next_action='none',next_send_at=NULL,updated_at=?1
      WHERE status='waiting' AND reason='quota' AND source='claim' AND amount_minor>?2
        AND unknown_outcome=0 AND external_order_id IS NULL AND order_observed_at IS NULL
        AND send_acknowledged_at IS NULL
        AND (SELECT COUNT(*) FROM payment_attempts a WHERE a.task_id=payment_tasks.id
          AND a.operation='send' AND a.reason='quota'
          AND (payment_tasks.mode='simulation' OR a.no_order_evidence='protocol_rejection_v1'))>=2
        AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=payment_tasks.id AND a.finished_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM merchants m WHERE m.id=payment_tasks.merchant_id AND m.lease_token IS NOT NULL)
      RETURNING id, merchant_id AS merchantId`,
  )
    .bind(now, PAYOUT_SAFE_SHARE_MINOR)
    .all<{ id: string; merchantId: string }>();
  if (!failed.results.length) return 0;
  // A merchant still holding one of them from before (it kept the refused
  // payment as its active one) lets go of it.
  await env.DB.prepare(
    `UPDATE merchants SET active_task_id=NULL,paused_reason=NULL
      WHERE active_task_id IN (SELECT value FROM json_each(?)) AND lease_token IS NULL`,
  )
    .bind(JSON.stringify(failed.results.map((row) => row.id)))
    .run();
  for (const row of failed.results) {
    console.info(
      JSON.stringify({
        event: "ldc_payout_over_limit",
        taskId: row.id,
        merchantId: row.merchantId,
      }),
    );
    await tellPaymentWatchers(env, row.id).catch(() => {});
    await noticePayoutOverLimit(env, row.id);
  }
  return failed.results.length;
}
