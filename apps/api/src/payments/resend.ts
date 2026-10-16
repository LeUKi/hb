import { PAYMENT_RESEND_LIMIT } from "@hb/contracts";
import { and, eq } from "drizzle-orm";
import { ActivityError, activityNotFound } from "../activities/errors";
import { tellPaymentWatchers } from "../activities/live";
import { createDb } from "../db/client";
import { claims, paymentTasks } from "../db/schema";
import type { ApiBindings } from "../env";
import { allowsRealSending, readPlatformControls } from "../runtime/controls";
import { effectiveClaimPaymentTask } from "./identity";
import { realQueryDecision } from "./policy";
import {
  heldForRecipient,
  recipientRejections,
  resendDeadline,
} from "./resend-rules";
import { flushPaymentOutbox } from "./scheduler";

// When the upstream answers a claim's payment with 收款人不存在 (the
// recipient has no LINUX DO Credit account; the answer proves no order was
// made), the payment stops in attention. Its claimant may send it again
// after opening an account: within PAYMENT_RESEND_WINDOW_MS of the first
// such answer, once (PAYMENT_RESEND_LIMIT). A resend is the recovery the
// pipeline already does for an order it cannot vouch for: look the order up
// (there is none), then send it under the same 业务号. Nothing retries it by
// itself, and past the window it is not paid (user's rule).

/**
 * The claimant asks for their payment again. Returns once it is on its
 * way; the merchant cycle does the rest and the page hears of it live.
 */
export async function resendClaimPayment(
  env: ApiBindings,
  userId: string,
  claimId: string,
) {
  const row = await createDb(env.DB)
    .select({ task: paymentTasks })
    .from(paymentTasks)
    .innerJoin(claims, eq(claims.id, paymentTasks.claimId))
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.userId, userId),
        eq(paymentTasks.source, "claim"),
      ),
    )
    .get();
  if (!row) activityNotFound();
  const { task } = row;
  const now = Date.now();
  const rejections = (await recipientRejections(env, [task.id])).get(task.id);
  if (resendDeadline(task, rejections, now) === null) {
    if (!heldForRecipient(task))
      throw new ActivityError(
        409,
        "PAYMENT_RESEND_NOT_NEEDED",
        "这笔付款不需要重新发送。",
      );
    throw new ActivityError(
      409,
      "PAYMENT_RESEND_CLOSED",
      rejections && rejections.count > PAYMENT_RESEND_LIMIT
        ? "已经重新发送过一次，这笔不再补发。"
        : "重新发送的时间已过（被拒后 5 分钟内有效），这笔不再补发。",
    );
  }
  // It goes out only as it first went: under the same merchant application.
  const effective = await effectiveClaimPaymentTask(env, task);
  const merchant = await env.DB.prepare(
    "SELECT client_id FROM merchants WHERE id=?",
  )
    .bind(task.merchantId)
    .first<{ client_id: string }>();
  if (merchant?.client_id !== effective.clientId)
    throw new ActivityError(
      409,
      "PAYMENT_RESEND_CLOSED",
      "发红包的人已更换收款配置，这笔不能重新发送。",
    );
  if (
    !allowsRealSending(env, await readPlatformControls(env)) ||
    !(await realQueryDecision(env, task)).allowed
  )
    throw new ActivityError(
      503,
      "PAYMENT_RESEND_UNAVAILABLE",
      "暂时不能发送付款，请稍后再试。",
    );
  const due = Math.max(now, task.queryRetryAfterAt ?? 0);
  const changed = await env.DB.batch([
    // Looked up first; a user's own request starts the send waits over.
    env.DB.prepare(
      `UPDATE payment_tasks SET status='reconciling',reason='resend',send_block_reason=NULL,
        next_action='query',next_query_at=?,next_run_at=?,send_backoff_count=0,updated_at=?
        WHERE id=? AND updated_at=? AND status='attention' AND send_block_reason='recipient'
          AND unknown_outcome=0 AND external_order_id IS NULL AND order_observed_at IS NULL
          AND send_acknowledged_at IS NULL`,
    ).bind(due, due, now, task.id, task.updatedAt),
    // A task keeps one wake in the Outbox: the claim's, made due again.
    env.DB.prepare(
      `INSERT INTO payment_outbox (id,task_id,created_at) SELECT ?,?,?
        WHERE EXISTS(SELECT 1 FROM payment_tasks WHERE id=? AND status='reconciling' AND reason='resend' AND updated_at=?)
        ON CONFLICT(task_id) DO UPDATE SET created_at=excluded.created_at,delivered_at=NULL`,
    ).bind(crypto.randomUUID(), task.id, now, task.id, now),
  ]);
  // Pressed twice, or it moved meanwhile: the first one stands.
  if (!changed[0]?.meta.changes)
    throw new ActivityError(
      409,
      "PAYMENT_RESEND_NOT_NEEDED",
      "这笔付款不需要重新发送。",
    );
  console.info(
    JSON.stringify({ event: "ldc_payment_resend_requested", taskId: task.id }),
  );
  // The committed Outbox and the Cron sweep stay responsible if these fail.
  await flushPaymentOutbox(env, task.id).catch(() => {
    console.error("payment_resend_wake_failed", { taskId: task.id });
  });
  await tellPaymentWatchers(env, task.id).catch(() => {});
}
