import { PAYMENT_RESEND_LIMIT, PAYMENT_RESEND_WINDOW_MS } from "@hb/contracts";
import type { ApiBindings } from "../env";
import type { PaymentTaskRow } from "./adapter";

// Who may send a claim's payment again, and until when (resend.ts).

export type Rejections = { first: number; count: number };

/** Each task's 收款人不存在 answers: when the first came, how many. */
export async function recipientRejections(
  env: ApiBindings,
  taskIds: string[],
): Promise<Map<string, Rejections>> {
  if (taskIds.length === 0) return new Map();
  const rows = await env.DB.prepare(
    `SELECT task_id AS taskId, MIN(finished_at) AS first, COUNT(*) AS count
      FROM payment_attempts
      WHERE task_id IN (${taskIds.map(() => "?").join(",")})
        AND operation='send' AND outcome='rejected' AND reason='recipient'
        AND no_order_evidence='protocol_rejection_v1' AND finished_at IS NOT NULL
      GROUP BY task_id`,
  )
    .bind(...taskIds)
    .all<{ taskId: string; first: number; count: number }>();
  return new Map(
    rows.results.map((row) => [
      row.taskId,
      { first: row.first, count: row.count },
    ]),
  );
}

/** A task stopped by 收款人不存在 alone, with no order anywhere. */
export function heldForRecipient(task: PaymentTaskRow) {
  return (
    task.mode === "real" &&
    task.source === "claim" &&
    task.recoveryPolicy === "claim_same_order_v1" &&
    task.status === "attention" &&
    task.sendBlockReason === "recipient" &&
    !task.unknownOutcome &&
    task.firstSendAt !== null &&
    task.externalOrderId === null &&
    task.orderObservedAt === null &&
    task.sendAcknowledgedAt === null
  );
}

/** A claim's payment that ended 未发出 for want of a Credit account. */
export function unsentForRecipient(task: PaymentTaskRow) {
  return (
    task.source === "claim" &&
    task.status === "failed" &&
    task.sendBlockReason === "recipient"
  );
}

/** Until when its claimant may send it again (ms), or null. */
export function resendDeadline(
  task: PaymentTaskRow,
  rejections: Rejections | undefined,
  now = Date.now(),
) {
  if (
    !heldForRecipient(task) ||
    !rejections ||
    rejections.count > PAYMENT_RESEND_LIMIT
  )
    return null;
  const until = rejections.first + PAYMENT_RESEND_WINDOW_MS;
  return now < until ? until : null;
}
