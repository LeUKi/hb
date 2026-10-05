import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { checkD1 } from "../src/db/client";
import worker from "../src/index";

describe("api worker", () => {
  it("returns health", async () => {
    const response = await SELF.fetch("https://api.example.com/api/health");

    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.status).toBe(200);
  });

  it("returns JSON 404", async () => {
    const response = await SELF.fetch("https://api.example.com/api/missing");

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "API route not found",
      },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("checks local D1 with SELECT 1", async () => {
    await expect(checkD1(env.DB)).resolves.toBe(true);
  });

  it("serves ActivityDO and MerchantDO internal health", async () => {
    const activity = env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName("activity-health"),
    );
    const merchant = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName("merchant-health"),
    );

    await expect(
      activity
        .fetch("https://do.example.com/internal/health")
        .then((response) => response.json()),
    ).resolves.toEqual({ status: "ok", object: "activity", storage: "ok" });
    await expect(
      merchant
        .fetch("https://do.example.com/internal/health")
        .then((response) => response.json()),
    ).resolves.toEqual({ status: "ok", object: "merchant", storage: "ok" });
  });

  it("acks synthetic queue probes through the Worker queue entry", async () => {
    const batch = createMessageBatch("hb-local-tasks", [
      {
        id: "probe-1",
        timestamp: new Date(),
        attempts: 1,
        body: { type: "synthetic.probe", id: "probe-1" },
      },
    ]);
    const ctx = createExecutionContext();

    await worker.queue?.(batch, env);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["probe-1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries unknown queue messages through the Worker queue entry", async () => {
    const batch = createMessageBatch("hb-local-tasks", [
      {
        id: "payment-1",
        timestamp: new Date(),
        attempts: 1,
        body: { type: "payment.send", id: "payment-1" },
      },
    ]);
    const ctx = createExecutionContext();

    await worker.queue?.(batch, env);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: "payment-1" }]);
  });

  it("runs scheduled Worker entry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduled = createScheduledController({
      cron: "*/5 * * * *",
      scheduledTime: Date.now(),
    });
    const ctx = createExecutionContext();

    await worker.scheduled?.(scheduled, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(log).toHaveBeenCalledWith(
      "scheduled",
      expect.objectContaining({ cron: "*/5 * * * *" }),
    );
    log.mockRestore();
  });
});
