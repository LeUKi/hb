import { sweepActivityLifecycle } from "./activities/lifecycle";
import { settleEndedWithdrawals } from "./balance/withdrawal-settlement";
import type { ApiBindings } from "./env";
import { migrateJudgesOf } from "./judge/judges";
import { pruneJudgeUsage } from "./judge/usage";
import { endLapsedResends } from "./payments/resend";
import { sweepPayments } from "./payments/scheduler";
import { recoverCredentialChecks } from "./payments/verification";
import { inMaintenanceMode } from "./runtime/maintenance-mode";
import { maintenanceObject } from "./runtime/objects";

export async function runScheduled(
  event: ScheduledController,
  env: ApiBindings,
  _ctx: ExecutionContext,
) {
  console.log("scheduled", {
    cron: event.cron,
    scheduledTime: event.scheduledTime,
  });
  // 维护模式: the run is skipped; the next one after it catches up.
  if (inMaintenanceMode(env)) {
    console.log("scheduled.skipped", { reason: "maintenance_mode" });
    return;
  }
  const coordinator = maintenanceObject(env);
  const response = await coordinator.fetch(
    "https://activity.internal/internal/maintenance",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledAt: event.scheduledTime }),
    },
  );
  if (!response.ok) throw new Error("MAINTENANCE_JOB_FAILED");
}

// Cron only wakes this DO. Its independent job observations and D1 conditions
// remain the source of truth, including retries of the same scheduled event.
export async function runMaintenance(env: ApiBindings, scheduledAt: number) {
  return runScheduledJobs(env.DB, scheduledAt, [
    {
      name: "identity",
      run: () => cleanupExpiredIdentityRows(env.DB, new Date(scheduledAt)),
    },
    { name: "activities", run: () => sweepActivityLifecycle(env) },
    {
      name: "payments",
      run: async () => {
        const woken = await sweepPayments(env);
        // A 转出 left 发放中 after its payment ended (it should never be).
        await settleEndedWithdrawals(env);
        // A payment refused for want of a Credit account, past its resend.
        await endLapsedResends(env);
        return woken;
      },
    },
    { name: "credentials", run: () => recoverCredentialChecks(env) },
    // 代码判定红包's 用量记录 are kept 90 days (programmable-hongbao §7).
    { name: "judge_usage", run: () => pruneJudgeUsage(env, scheduledAt) },
    // 红包 sent before 判定器, moved over a few at a time (judge-square §14.3).
    { name: "judge_migration", run: () => migrateJudgesOf(env) },
  ]);
}

type MaintenanceJob = { name: string; run: () => Promise<unknown> };

export async function runScheduledJobs(
  database: D1Database,
  scheduledAt: number,
  jobs: MaintenanceJob[],
) {
  if (!jobs.length) return [];
  const scans = jobs.map((job) => ({ ...job, startedAt: Date.now() }));
  try {
    await database
      .prepare(
        `INSERT INTO maintenance_runs (job,scheduled_at,started_at,finished_at,status,reason)
         SELECT json_extract(value,'$.job'),?,json_extract(value,'$.startedAt'),NULL,'running',NULL
         FROM json_each(?) WHERE 1
         ON CONFLICT(job) DO UPDATE SET scheduled_at=excluded.scheduled_at,
          started_at=excluded.started_at,finished_at=NULL,status='running',reason=NULL
         WHERE excluded.scheduled_at>maintenance_runs.scheduled_at
          OR (excluded.scheduled_at=maintenance_runs.scheduled_at AND excluded.started_at>=maintenance_runs.started_at)`,
      )
      .bind(
        scheduledAt,
        JSON.stringify(
          scans.map((job) => ({ job: job.name, startedAt: job.startedAt })),
        ),
      )
      .run();
  } catch {
    for (const job of scans)
      console.log("maintenance.observation_failed", {
        job: job.name,
        reason: "database",
      });
  }
  // Start observations share one round trip; finishes stay independent so a
  // stalled job cannot hide already-completed work or delay its durable result.
  const outcomes = await Promise.allSettled(
    scans.map(async (job) => {
      const { startedAt } = job;
      let status: "succeeded" | "failed" = "succeeded";
      try {
        await job.run();
      } catch {
        status = "failed";
      }
      const finishedAt = Date.now();
      try {
        await database
          .prepare(
            `UPDATE maintenance_runs SET finished_at=?,status=?,reason=?
         WHERE job=? AND scheduled_at=? AND started_at=?`,
          )
          .bind(
            finishedAt,
            status,
            status === "failed" ? "job_failed" : null,
            job.name,
            scheduledAt,
            startedAt,
          )
          .run();
      } catch {
        console.log("maintenance.observation_failed", {
          job: job.name,
          reason: "database",
        });
      }
      console.log("maintenance.result", {
        job: job.name,
        status,
        durationMs: finishedAt - startedAt,
      });
      return { job: job.name, status };
    }),
  );
  return outcomes.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { job: jobs[index]?.name ?? "unknown", status: "failed" as const },
  );
}

export async function cleanupExpiredIdentityRows(
  database: D1Database,
  now = new Date(),
) {
  const cutoff = now.getTime();
  await database.batch([
    database
      .prepare("DELETE FROM oauth_attempts WHERE expires_at<?")
      .bind(cutoff),
    database.prepare("DELETE FROM sessions WHERE expires_at<?").bind(cutoff),
  ]);
}
