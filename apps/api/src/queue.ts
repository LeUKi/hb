export type QueueResult = "ack" | "retry";

import type { ApiBindings } from "./env";
import { wakePayment } from "./payments/scheduler";
import { runPointsPayment } from "./points/payments";
import {
  inMaintenanceMode,
  MAINTENANCE_QUEUE_DELAY_SECONDS,
} from "./runtime/maintenance-mode";

export type QueueProbeMessage = {
  type: "synthetic.probe";
  id: string;
};

function isProbeMessage(value: unknown): value is QueueProbeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "synthetic.probe" &&
    "id" in value &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(value.id)
  );
}

export async function handleQueueMessage(
  message: Message<unknown>,
  env?: ApiBindings,
): Promise<QueueResult> {
  // 维护模式: every message waits in the queue.
  if (env && inMaintenanceMode(env)) {
    message.retry({ delaySeconds: MAINTENANCE_QUEUE_DELAY_SECONDS });
    return "retry";
  }
  if (isProbeMessage(message.body)) {
    if (!env) {
      message.retry();
      return "retry";
    }
    try {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO queue_probes (id,requested_at,consumed_at,last_seen_at,delivery_count)
         VALUES (?,?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET
          consumed_at=COALESCE(queue_probes.consumed_at,excluded.consumed_at),
          last_seen_at=excluded.last_seen_at,
          delivery_count=queue_probes.delivery_count+1`,
      )
        .bind(message.body.id, message.timestamp.getTime(), now, now)
        .run();
      message.ack();
      return "ack";
    } catch {
      console.log("queue.probe_retry", { reason: "database" });
      message.retry();
      return "retry";
    }
  }

  const value = message.body;
  if (
    env &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "payment.wake" &&
    "taskId" in value &&
    typeof value.taskId === "string"
  ) {
    try {
      await wakePayment(env, value.taskId);
      message.ack();
      return "ack";
    } catch {
      message.retry();
      return "retry";
    }
  }

  // 三方积分's payouts (docs/third-party-points-design.md §13).
  if (
    env &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "points.run" &&
    "id" in value &&
    typeof value.id === "string" &&
    /^pp_[a-f0-9-]{36}$/.test(value.id)
  ) {
    try {
      await runPointsPayment(env, value.id);
      message.ack();
      return "ack";
    } catch (error) {
      console.error("points_payment_run_failed", {
        id: value.id,
        error: String(error),
      });
      message.retry({ delaySeconds: 30 });
      return "retry";
    }
  }

  message.retry();
  return "retry";
}
