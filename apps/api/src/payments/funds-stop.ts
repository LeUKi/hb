// 奖励发放：余额不足终止 (docs/payout-stop-design.md §1, §6, §7). A merchant
// whose Credit balance ran short is retried as before; this keeps when its
// wait began, and three days on stops what it never sent. The payment
// engines are not changed: the payments job runs this each minute, from
// what the tables say. The wait ends only when nothing is left to send.
import { PAYOUT_FUNDS_WAIT_MS } from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { tellPaymentWatchers } from "../activities/live";
import type { ApiBindings } from "../env";
import { noticePayoutStopped, noticePayoutWaiting } from "../notices/events";
import { activityObject } from "../runtime/objects";

/** Its wait, when its merchant is waiting on funds: when it stops (ms). */
export async function fundsStopAt(env: ApiBindings, merchantId: string) {
  const row = await env.DB.prepare(
    "SELECT funds_wait_since AS since FROM merchants WHERE id=? AND funds_wait_since IS NOT NULL",
  )
    .bind(merchantId)
    .first<{ since: number }>();
  return row ? row.since + PAYOUT_FUNDS_WAIT_MS : null;
}

/**
 * A 商户直发红包 whose merchant waits on funds takes no new claim or
 * sign-up until its payments go through (docs/payout-stop-design.md §6).
 */
export async function assertMerchantFunded(
  env: ApiBindings,
  activity: { funding: string; merchantId: string | null },
) {
  if (activity.funding !== "merchant" || !activity.merchantId) return;
  if ((await fundsStopAt(env, activity.merchantId)) === null) return;
  throw new ActivityError(
    409,
    "MERCHANT_FUNDS_PAUSED",
    "红包作者的 LDC 商户余额不足，领取已暂停。未发放的奖励全部发出后，领取将自动恢复。",
  );
}

/** A 红包's page: its claims wait on its merchant's funds, until when. */
export async function fundsPausedOf(
  env: ApiBindings,
  activity: {
    funding: string;
    merchantId: string | null;
    openedAt: number | null;
    endedAt: number | null;
  },
) {
  if (
    activity.funding !== "merchant" ||
    !activity.merchantId ||
    activity.openedAt === null ||
    activity.endedAt !== null
  )
    return {};
  const stopAt = await fundsStopAt(env, activity.merchantId);
  return stopAt === null
    ? {}
    : { fundsPaused: { stopAt: new Date(stopAt).toISOString() } };
}

/** The merchants among `merchantIds` waiting on funds, with when they stop. */
export async function fundsHolds(
  env: ApiBindings,
  merchantIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(merchantIds)];
  if (!ids.length) return new Map();
  const rows = await env.DB.prepare(
    `SELECT id, funds_wait_since AS since FROM merchants
      WHERE id IN (SELECT value FROM json_each(?)) AND funds_wait_since IS NOT NULL`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; since: number }>();
  return new Map(
    rows.results.map((row) => [row.id, row.since + PAYOUT_FUNDS_WAIT_MS]),
  );
}

/**
 * Each minute: a wait begins once a payment is held by 余额不足, counted
 * from the merchant's oldest payment still unsent (one or two paid through
 * now and then, as a balance that trickles in allows, do not restart it);
 * its sender is told once; a wait with nothing left to send is dropped;
 * pages open on its 红包 hear each wait begin and end; and a wait three
 * days old stops. Returns how many payments stopped.
 */
export async function sweepFundsWaits(env: ApiBindings, now = Date.now()) {
  const began = await env.DB.prepare(
    `UPDATE merchants SET funds_wait_since=COALESCE((
        SELECT MIN(t.created_at) FROM payment_tasks t
        WHERE t.merchant_id=merchants.id AND t.source='claim'
          AND t.status IN ('pending','sending','reconciling','waiting')),?1)
      WHERE id IN (SELECT DISTINCT merchant_id FROM payment_tasks
          WHERE status='waiting' AND reason='funds' AND source='claim')
        AND kind='author' AND funds_wait_since IS NULL
      RETURNING id`,
  )
    .bind(now)
    .all<{ id: string }>();
  // Its sender hears of each wait once, with until when (payout-stop §4);
  // one already past its three days (a wait from before this rule) only
  // hears that it stopped.
  const told = await env.DB.prepare(
    `UPDATE merchants SET funds_noticed_at=funds_wait_since
      WHERE funds_wait_since IS NOT NULL AND funds_noticed_at IS NOT funds_wait_since
      RETURNING id, funds_wait_since AS since`,
  ).all<{ id: string; since: number }>();
  for (const merchant of told.results)
    if (merchant.since + PAYOUT_FUNDS_WAIT_MS > now)
      await noticePayoutWaiting(env, merchant.id, merchant.since);
  const over = await env.DB.prepare(
    `UPDATE merchants SET funds_wait_since=NULL
      WHERE funds_wait_since IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_tasks t
        WHERE t.merchant_id=merchants.id AND t.source='claim'
          AND t.status IN ('pending','sending','reconciling','waiting'))
      RETURNING id`,
  ).all<{ id: string }>();
  await announceFundsChange(env, [
    ...began.results.map((row) => row.id),
    ...over.results.map((row) => row.id),
  ]);
  const due = await env.DB.prepare(
    `SELECT id, funds_wait_since AS since FROM merchants
      WHERE funds_wait_since IS NOT NULL AND funds_wait_since<=? AND lease_token IS NULL
      ORDER BY funds_wait_since LIMIT 5`,
  )
    .bind(now - PAYOUT_FUNDS_WAIT_MS)
    .all<{ id: string; since: number }>();
  let stopped = 0;
  for (const merchant of due.results)
    stopped += await stopMerchant(env, merchant.id, merchant.since, now);
  return stopped;
}

/**
 * A wait began or ended: the open 红包 of these merchants show claims
 * paused (fundsPaused) or going on again, and their pages hear it pushed.
 * The change is on the merchant, not on any 红包's row, so nothing else
 * would push it, and a page on the live channel does not poll: claims
 * stayed paused there after the wait ended (sweep 2026-11-21, F1). As
 * fundsPausedOf picks them; the merchant is the sender's own, as a claim
 * on it needs (claim-service.ts), so the author index finds them.
 */
async function announceFundsChange(env: ApiBindings, merchantIds: string[]) {
  if (!merchantIds.length) return;
  const open = await env.DB.prepare(
    `SELECT a.id FROM merchants m
      JOIN activities a ON a.author_id=m.author_id AND a.merchant_id=m.id
      WHERE m.id IN (SELECT value FROM json_each(?)) AND a.funding='merchant'
        AND a.deleted_at IS NULL AND a.opened_at IS NOT NULL AND a.ended_at IS NULL`,
  )
    .bind(JSON.stringify(merchantIds))
    .all<{ id: string }>();
  for (const { id } of open.results) {
    try {
      await (
        await activityObject(env, id).fetch(
          `https://activity.internal/internal/activities/${encodeURIComponent(id)}/live/announce`,
          { method: "POST" },
        )
      ).arrayBuffer();
    } catch {
      // Its pages catch up as they read it again (a reload, a guest's poll).
    }
  }
}

/**
 * Three days short: every payment of it never sent, or held by 余额不足
 * with nothing in flight, ends failed (reason funds); one with an order or
 * an unknown end is left to its checks. Its open 红包 end. One batch, so a
 * lease taken meanwhile (a send starting) leaves it all for the next run.
 */
async function stopMerchant(
  env: ApiBindings,
  merchantId: string,
  since: number,
  now: number,
) {
  const held = `EXISTS(SELECT 1 FROM merchants m WHERE m.id=?2 AND m.lease_token IS NULL AND m.funds_wait_since=?3)`;
  const [tasks, ended] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE payment_tasks SET status='failed',reason='funds',send_block_reason='funds',
          next_action='none',updated_at=?1
        WHERE merchant_id=?2 AND source='claim' AND unknown_outcome=0
          AND external_order_id IS NULL AND order_observed_at IS NULL AND send_acknowledged_at IS NULL
          AND ((status='pending' AND first_send_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=payment_tasks.id))
            OR (status='waiting' AND reason='funds'
              AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=payment_tasks.id AND a.finished_at IS NULL)))
          AND ${held}
        RETURNING id`,
    ).bind(now, merchantId, since),
    env.DB.prepare(
      `UPDATE activities SET ended_at=?1,end_reason='funds',version=version+1,updated_at=?1
        WHERE merchant_id=?2 AND funding='merchant' AND reward_type='ldc' AND deleted_at IS NULL
          AND opened_at IS NOT NULL AND ended_at IS NULL AND ${held}
        RETURNING id`,
    ).bind(now, merchantId, since),
    env.DB.prepare(
      `UPDATE merchants SET funds_wait_since=NULL,
          active_task_id=CASE WHEN EXISTS(SELECT 1 FROM payment_tasks t WHERE t.id=merchants.active_task_id AND t.status='failed') THEN NULL ELSE active_task_id END,
          paused_reason=CASE WHEN active_task_id IS NULL OR EXISTS(SELECT 1 FROM payment_tasks t WHERE t.id=merchants.active_task_id AND t.status='failed') THEN NULL ELSE paused_reason END
        WHERE id=?1 AND lease_token IS NULL AND funds_wait_since=?2`,
    ).bind(merchantId, since),
  ]);
  const taskIds = (tasks?.results ?? []) as { id: string }[];
  const activityIds = ((ended?.results ?? []) as { id: string }[]).map(
    (row) => row.id,
  );
  if (!taskIds.length && !activityIds.length) return 0;
  console.info(
    JSON.stringify({
      event: "ldc_payout_funds_stopped",
      merchantId,
      payments: taskIds.length,
      activities: activityIds.length,
    }),
  );
  // Pages open on them hear it; a timed draw closes with no draw.
  for (const id of activityIds) await refreshEnded(env, id);
  for (const { id } of taskIds)
    await tellPaymentWatchers(env, id).catch(() => {});
  await noticePayoutStopped(
    env,
    merchantId,
    since,
    taskIds.map((row) => row.id),
  );
  return taskIds.length;
}

/** An ended 红包's object: its lifecycle runs, and every page re-reads. */
async function refreshEnded(env: ApiBindings, activityId: string) {
  const object = activityObject(env, activityId);
  const path = `https://activity.internal/internal/activities/${encodeURIComponent(activityId)}`;
  try {
    await (
      await object.fetch(`${path}/refresh`, { method: "POST" })
    ).arrayBuffer();
    // The push a 三方积分 stop uses: everyone's page hears it ended.
    await (
      await object.fetch(`${path}/live/points`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [], ended: true }),
      })
    ).arrayBuffer();
  } catch {
    // The lifecycle sweep and the page's own reads catch up.
  }
}
