import type { ApiBindings } from "../env";

// 维护模式 (MAINTENANCE_MODE = "true"), while D1 moves
// (docs/d1-apac-migration.md): nothing may write to it. The API answers 503
// except its health check, the cron skips its run, payment wakes wait in
// the queue and Durable Object alarms come back a minute later. (Not the
// cron's maintenance jobs, which this pauses.)

export function inMaintenanceMode(env: Pick<ApiBindings, "MAINTENANCE_MODE">) {
  return env.MAINTENANCE_MODE === "true";
}

/** How long an alarm waits before it looks again. */
export const MAINTENANCE_ALARM_DELAY_MS = 60_000;

/**
 * How long a queued message waits. Each wait counts against the queue's
 * max_retries (5), so five of these outlast a maintenance window well; a
 * wake lost anyway is found again by the cron's payment sweep.
 */
export const MAINTENANCE_QUEUE_DELAY_SECONDS = 600;

export const maintenanceResponse = {
  error: { code: "MAINTENANCE", message: "系统维护中，请稍后再试。" },
} as const;
