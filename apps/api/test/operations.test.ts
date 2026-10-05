import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleQueueMessage } from "../src/queue";
import { cleanupExpiredIdentityRows, runScheduledJobs } from "../src/scheduled";

afterEach(() => vi.restoreAllMocks());

describe("persistent operational observations", () => {
  it("runs real Cron maintenance through its reserved DO and preserves all job observations", async () => {
    const scheduledAt = Date.now();
    await worker.scheduled?.(
      createScheduledController({
        cron: "*/5 * * * *",
        scheduledTime: scheduledAt,
      }),
      env,
      createExecutionContext(),
    );
    const rows = await env.DB.prepare(
      "SELECT job,status,scheduled_at,finished_at FROM maintenance_runs WHERE job IN ('identity','activities','payments','credentials') ORDER BY job",
    ).all();
    expect(rows.results.map((row) => row.job)).toEqual([
      "activities",
      "credentials",
      "identity",
      "payments",
    ]);
    for (const row of rows.results) {
      expect(row).toMatchObject({
        status: "succeeded",
        scheduled_at: scheduledAt,
      });
      expect(row.finished_at).toBeTypeOf("number");
    }
    const otherObject = env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName(crypto.randomUUID()),
    );
    const rejected = await otherObject.fetch(
      "https://activity.internal/internal/maintenance",
      {
        method: "POST",
        body: JSON.stringify({ scheduledAt: scheduledAt + 1000 }),
      },
    );
    expect(rejected.status).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM maintenance_runs WHERE scheduled_at=?",
      )
        .bind(scheduledAt + 1000)
        .first("n"),
    ).toBe(0);
  });

  it("persists probe consumption before ack and preserves first consumption on duplicate delivery", async () => {
    const id = `probe-${crypto.randomUUID()}`;
    const requestedAt = Date.now() - 500;
    const makeBatch = () =>
      createMessageBatch("hb-local-tasks", [
        {
          id,
          timestamp: new Date(requestedAt),
          attempts: 1,
          body: { type: "synthetic.probe", id },
        },
      ]);
    const first = makeBatch();
    await worker.queue?.(first, env);
    expect(
      (await getQueueResult(first, createExecutionContext())).explicitAcks,
    ).toEqual([id]);
    const saved = await env.DB.prepare("SELECT * FROM queue_probes WHERE id=?")
      .bind(id)
      .first();
    expect(saved).toMatchObject({
      requested_at: requestedAt,
      delivery_count: 1,
    });
    expect(saved?.consumed_at).toBeTypeOf("number");
    const second = makeBatch();
    await worker.queue?.(second, env);
    const repeated = await env.DB.prepare(
      "SELECT * FROM queue_probes WHERE id=?",
    )
      .bind(id)
      .first();
    expect(repeated?.consumed_at).toBe(saved?.consumed_at);
    expect(repeated?.delivery_count).toBe(2);
  });

  it("retries a probe when its observation cannot be saved", async () => {
    const retry = vi.fn();
    const ack = vi.fn();
    const message = {
      body: { type: "synthetic.probe", id: "safe-probe" },
      timestamp: new Date(),
      ack,
      retry,
    } as unknown as Message<unknown>;
    const database = {
      prepare: () => {
        throw new Error("credential-bearing-diagnostic");
      },
    } as unknown as D1Database;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await handleQueueMessage(message, { ...env, DB: database })).toBe(
      "retry",
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("credential-bearing");
    log.mockRestore();
  });

  it.each(["identity", "activities", "payments", "credentials"])(
    "runs remaining jobs after %s fails and records independent safe outcomes",
    async (failedJob) => {
      const scheduledAt = Date.now();
      const kinds = ["identity", "activities", "payments", "credentials"];
      const runs = kinds.map((kind) =>
        kind === failedJob
          ? vi.fn().mockRejectedValue(new Error("private-token"))
          : vi.fn().mockResolvedValue(undefined),
      );
      const names = kinds.map((kind) => `isolation-${kind}`);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const results = await runScheduledJobs(
        env.DB,
        scheduledAt,
        names.map((name, index) => ({
          name,
          run: runs[index] as () => Promise<unknown>,
        })),
      );
      expect(results.map((result) => result.status)).toEqual(
        kinds.map((kind) => (kind === failedJob ? "failed" : "succeeded")),
      );
      for (const run of runs) expect(run).toHaveBeenCalledOnce();
      const saved = await env.DB.prepare(
        "SELECT job,status,reason,finished_at FROM maintenance_runs WHERE job LIKE 'isolation-%' ORDER BY job",
      ).all();
      expect(saved.results).toHaveLength(4);
      for (const kind of kinds) {
        const row = saved.results.find(
          (row) => row.job === `isolation-${kind}`,
        );
        expect(row).toMatchObject({
          status: kind === failedJob ? "failed" : "succeeded",
          reason: kind === failedJob ? "job_failed" : null,
        });
        expect(row?.finished_at).toBeTypeOf("number");
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-token");
      log.mockRestore();
    },
  );

  it.each([2000, 1000])(
    "does not let an older completion overwrite a newer scan scheduled at %s",
    async (newScheduledAt) => {
      const name = `overlap-${crypto.randomUUID()}`;
      const clock = vi.spyOn(Date, "now").mockReturnValue(100);
      let finishOld: (() => void) | undefined;
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const old = runScheduledJobs(env.DB, 1000, [
        {
          name,
          run: () => {
            signalStarted?.();
            return new Promise<void>((resolve) => {
              finishOld = resolve;
            });
          },
        },
      ]);
      await started;
      clock.mockReturnValue(200);
      await runScheduledJobs(env.DB, newScheduledAt, [
        {
          name,
          run: async () => {
            throw new Error("failed-newer");
          },
        },
      ]);
      finishOld?.();
      await old;
      expect(
        await env.DB.prepare(
          "SELECT scheduled_at,status FROM maintenance_runs WHERE job=?",
        )
          .bind(name)
          .first(),
      ).toEqual({ scheduled_at: newScheduledAt, status: "failed" });
    },
  );

  it("persists a completed job immediately while another job remains pending", async () => {
    const id = crypto.randomUUID();
    const waitingName = `pending-${id}`,
      finishedName = `finished-${id}`;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runScheduledJobs(env.DB, Date.now(), [
      { name: waitingName, run: () => held },
      { name: finishedName, run: async () => undefined },
    ]);
    try {
      await vi.waitFor(async () => {
        const completed = await env.DB.prepare(
          "SELECT status,finished_at FROM maintenance_runs WHERE job=?",
        )
          .bind(finishedName)
          .first();
        expect(completed?.status).toBe("succeeded");
        expect(completed?.finished_at).toBeTypeOf("number");
      });
      expect(
        await env.DB.prepare(
          "SELECT status,finished_at FROM maintenance_runs WHERE job=?",
        )
          .bind(waitingName)
          .first(),
      ).toEqual({ status: "running", finished_at: null });
    } finally {
      release?.();
    }
    expect(await running).toEqual([
      { job: waitingName, status: "succeeded" },
      { job: finishedName, status: "succeeded" },
    ]);
  });

  it.each(["start", "finish"])(
    "keeps every business job independent when the %s observation fails",
    async (stage) => {
      const prefix = `observation-${crypto.randomUUID()}`;
      const names = ["identity", "activities", "payments", "credentials"].map(
        (name) => `${prefix}-${name}`,
      );
      const runs = names.map(() => vi.fn().mockResolvedValue(undefined));
      const database = {
        prepare: (sql: string) => {
          if (
            sql.includes(
              stage === "start"
                ? "INSERT INTO maintenance_runs"
                : "UPDATE maintenance_runs",
            )
          )
            throw new Error("private-database-diagnostic");
          return env.DB.prepare(sql);
        },
      } as unknown as D1Database;
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(
        await runScheduledJobs(
          database,
          Date.now(),
          names.map((name, index) => ({
            name,
            run: runs[index] as () => Promise<unknown>,
          })),
        ),
      ).toEqual(names.map((job) => ({ job, status: "succeeded" })));
      for (const run of runs) expect(run).toHaveBeenCalledOnce();
      const saved = await env.DB.prepare(
        "SELECT status,finished_at FROM maintenance_runs WHERE job LIKE ?",
      )
        .bind(`${prefix}%`)
        .all();
      expect(saved.results).toHaveLength(stage === "start" ? 0 : 4);
      if (stage === "finish")
        for (const row of saved.results)
          expect(row).toEqual({ status: "running", finished_at: null });
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "private-database-diagnostic",
      );
    },
  );

  it("starts the four observations with one D1 query and persists each finish separately", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    const names = ["identity", "activities", "payments", "credentials"].map(
      (name) => `round-trips-${name}`,
    );
    await runScheduledJobs(
      env.DB,
      Date.now(),
      names.map((name) => ({ name, run: async () => undefined })),
    );
    expect(
      prepare.mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO maintenance_runs"),
      ),
    ).toHaveLength(1);
    expect(
      prepare.mock.calls.filter(([sql]) =>
        sql.includes("UPDATE maintenance_runs"),
      ),
    ).toHaveLength(4);
  });

  it("cleans both expired identity tables in one D1 batch", async () => {
    const batch = vi.spyOn(env.DB, "batch");
    await cleanupExpiredIdentityRows(env.DB, new Date());
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("executes a job even when D1 observation is unavailable", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const database = {
      prepare: () => {
        throw new Error("database offline");
      },
    } as unknown as D1Database;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      await runScheduledJobs(database, Date.now(), [
        { name: "available", run },
      ]),
    ).toEqual([{ job: "available", status: "succeeded" }]);
    expect(run).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
