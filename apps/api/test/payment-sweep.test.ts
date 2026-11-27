import { env, runInDurableObject } from "cloudflare:test";
import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { flushPaymentOutbox, sweepPayments } from "../src/payments/scheduler";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

let recipient: string;
async function user() {
  const id = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    id,
    externalId: id,
    username: id,
    displayName: "本地测试",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}
async function fixture(count = 1) {
  const owner = await user();
  const merchant = await createMerchant(env, owner, {
    requestId: crypto.randomUUID(),
    clientId: `sweep_${crypto.randomUUID()}`,
    label: "模拟商户",
    secret: "dummy-secret",
  });
  const base = emptyActivityInput();
  const config: LdcActivityInput = {
    ...base,
    rewardType: "ldc",
    title: "补偿测试",
    merchantId: merchant.id,
    passwords: ["Correct123"],
    money: { mode: "fixed", count, totalAmount: String(count) },
  };
  const draft = await createActivity(env, owner, {
    requestId: crypto.randomUUID(),
    activity: config,
  });
  const activity = await openActivity(env, draft.id, owner, draft.version);
  async function claim(account = recipient) {
    const result = await claimActivity(env, activity.id, account, {
      submissionId: crypto.randomUUID(),
      password: "Correct123",
    });
    if (!("claim" in result) || result.claim.rewardType !== "ldc")
      throw new Error("Missing payment");
    await advanceAttemptCooldown(env.DB, account);
    return result.claim.payment?.id ?? "";
  }
  return { merchant, taskId: await claim(), claim };
}
function fakeQueue() {
  return vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  });
}
function fakeWakes(failedMerchant?: string) {
  const attempts: string[] = [];
  const responses: Response[] = [];
  vi.spyOn(env.MERCHANT_DO, "get").mockImplementation(
    () =>
      ({
        fetch: async (_url: string, init: RequestInit) => {
          const { merchantId } = JSON.parse(String(init.body)) as {
            merchantId: string;
          };
          attempts.push(merchantId);
          const response = new Response("wake result", {
            status: merchantId === failedMerchant ? 503 : 200,
          });
          responses.push(response);
          return response;
        },
      }) as unknown as ReturnType<typeof env.MERCHANT_DO.get>,
  );
  return { attempts, responses };
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "merchant_credentials",
      "simulation_controls",
      "simulation_orders",
      "global_redemptions",
      "attempt_events",
      "redemption_submissions",
      "claims",
      "activity_passwords",
      "reward_inventory",
      "activities",
      "merchants",
      "sessions",
      "oauth_attempts",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  recipient = await user();
});
afterEach(() => vi.restoreAllMocks());

describe("bounded payment recovery sweeps", () => {
  it("advances across more than twenty due merchants despite failed wakes within a fixed D1 budget", async () => {
    const fixtures = [];
    for (let index = 0; index < 25; index++) fixtures.push(await fixture());
    const ordered = fixtures.map((item) => item.merchant.id).sort();
    const failedId = ordered[0];
    const queue = fakeQueue();
    const wakes = fakeWakes(failedId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Even when two sweeps see the same clock value, the selected set advances.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    const prepare = vi.spyOn(env.DB, "prepare");

    expect(await sweepPayments(env)).toBe(19);
    expect(queue).toHaveBeenCalledTimes(20);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(23);
    expect(new Set(wakes.attempts)).toEqual(new Set(ordered.slice(0, 20)));
    expect(wakes.responses.every((response) => response.bodyUsed)).toBe(true);
    prepare.mockClear();
    queue.mockClear();
    wakes.attempts.length = 0;
    wakes.responses.length = 0;

    await sweepPayments(env);
    expect(queue).toHaveBeenCalledTimes(5);
    expect(wakes.attempts).toHaveLength(20);
    expect(new Set(wakes.attempts).size).toBe(20);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(8);
    for (const id of ordered.slice(20)) expect(wakes.attempts).toContain(id);
    expect(wakes.responses.every((response) => response.bodyUsed)).toBe(true);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM merchants WHERE recovery_scanned_at>0",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(25);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM payment_outbox WHERE delivered_at IS NULL",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  }, 30_000);

  it("deduplicates merchant wakes, skips terminal or future-only tasks, and ignores prior Outbox delivery", async () => {
    const due = await fixture(2);
    await due.claim(await user());
    const future = await fixture();
    const confirmed = await fixture();
    const attention = await fixture();
    await env.DB.batch([
      env.DB.prepare("UPDATE payment_outbox SET delivered_at=1"),
      env.DB.prepare("UPDATE payment_tasks SET next_run_at=? WHERE id=?").bind(
        Date.now() + 3600000,
        future.taskId,
      ),
      env.DB.prepare(
        "UPDATE payment_tasks SET status='confirmed' WHERE id=?",
      ).bind(confirmed.taskId),
      env.DB.prepare(
        "UPDATE payment_tasks SET status='attention' WHERE id=?",
      ).bind(attention.taskId),
    ]);
    const queue = fakeQueue();
    const wakes = fakeWakes();
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(await sweepPayments(env)).toBe(1);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
    expect(wakes.attempts).toEqual([due.merchant.id]);
    expect(queue).not.toHaveBeenCalled();
    expect(wakes.responses.every((response) => response.bodyUsed)).toBe(true);
  });

  it("leaves a merchant held by the daily limit alone until it resumes", async () => {
    const held = await fixture(2);
    await held.claim(await user());
    const other = await fixture();
    const resume = Date.now() + 3_600_000;
    const amount = (
      await env.DB.prepare("SELECT amount_minor FROM payment_tasks WHERE id=?")
        .bind(held.taskId)
        .first<{ amount_minor: number }>()
    )?.amount_minor;
    await env.DB.batch([
      env.DB.prepare("UPDATE payment_outbox SET delivered_at=1"),
      env.DB.prepare(
        "UPDATE payment_tasks SET status='waiting',reason='quota',next_run_at=? WHERE id=?",
      ).bind(resume, held.taskId),
      // The day's limit refused one of this size (docs/payout-cap-design.md §2).
      env.DB.prepare(
        "UPDATE merchants SET quota_until=?,quota_below=?,quota_refusals=1 WHERE id=?",
      ).bind(resume, amount, held.merchant.id),
    ]);
    fakeQueue();
    const wakes = fakeWakes();
    // The claim after it has long been due, but is no smaller: it waits too.
    expect(await sweepPayments(env)).toBe(1);
    expect(wakes.attempts).toEqual([other.merchant.id]);
    // Had the one refused been bigger, it would still go today.
    wakes.attempts.length = 0;
    await env.DB.prepare("UPDATE merchants SET quota_below=? WHERE id=?")
      .bind((amount ?? 0) + 1, held.merchant.id)
      .run();
    await sweepPayments(env);
    expect(wakes.attempts).toContain(held.merchant.id);
    // Five more refused that day: nothing more until it turns.
    wakes.attempts.length = 0;
    await env.DB.prepare("UPDATE merchants SET quota_refusals=6 WHERE id=?")
      .bind(held.merchant.id)
      .run();
    await sweepPayments(env);
    expect(wakes.attempts).not.toContain(held.merchant.id);
    // From then on it is swept again, should its own alarm be lost.
    wakes.attempts.length = 0;
    vi.spyOn(Date, "now").mockReturnValue(resume);
    await sweepPayments(env);
    expect(wakes.attempts).toContain(held.merchant.id);
  });

  it("reads only due payments and due duplicate probes, never every confirmed payment", async () => {
    // B4 (sweep 2026-11-21): with p.mode and status='confirmed' open to the
    // planner, SQLite walked every payment of the mode, nearly all
    // confirmed, through payment_tasks_admin_mode_status_time_idx.
    fakeQueue();
    fakeWakes();
    const production = {
      ...env,
      APP_ENV: "production",
      LDC_NETWORK_MODE: "live",
    } as ApiBindings;
    const runtimes: ApiBindings[] = [env, production];
    for (const bindings of runtimes) {
      const prepare = vi.spyOn(env.DB, "prepare");
      await sweepPayments(bindings);
      const sql = prepare.mock.calls
        .map(([text]) => text)
        .find((text) =>
          text.includes("JOIN merchants m ON m.id=p.merchant_id"),
        );
      prepare.mockRestore();
      if (!sql) throw new Error("Missing the sweep's query");
      const now = Date.now();
      const plan = (
        await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(now, now)
          .all<{ detail: string }>()
      ).results.map((row) => row.detail);
      expect(plan.join("\n")).toContain("payment_tasks_due_idx");
      expect(plan.join("\n")).toContain("payment_duplicate_probes_due_idx");
      expect(
        plan.filter((detail) =>
          /payment_tasks_admin_|^SCAN p\b|^SEARCH p USING INDEX payment_tasks_\w+ \((mode|status)=\?\)$/.test(
            detail,
          ),
        ),
      ).toEqual([]);
    }
  });

  it("recovers a delivered but unexecuted task through the real MerchantDO", async () => {
    const item = await fixture();
    await env.DB.prepare(
      "UPDATE payment_outbox SET delivered_at=1 WHERE task_id=?",
    )
      .bind(item.taskId)
      .run();
    const queue = fakeQueue();
    expect(await sweepPayments(env)).toBe(1);
    expect(queue).not.toHaveBeenCalled();
    expect(
      (
        await env.DB.prepare("SELECT status FROM payment_tasks WHERE id=?")
          .bind(item.taskId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("confirmed");
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM simulation_orders",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
    const stub = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName(item.merchant.clientId),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });

  it("retains failed Outbox deliveries and supports an exact-task retry", async () => {
    const item = await fixture();
    const queue = fakeQueue().mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await flushPaymentOutbox(env)).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT delivered_at FROM payment_outbox WHERE task_id=?",
        )
          .bind(item.taskId)
          .first<{ delivered_at: number | null }>()
      )?.delivered_at,
    ).toBeNull();
    queue.mockClear();
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(await flushPaymentOutbox(env, item.taskId)).toBe(1);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
    expect(queue).toHaveBeenCalledExactlyOnceWith({
      type: "payment.wake",
      taskId: item.taskId,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT delivered_at FROM payment_outbox WHERE task_id=?",
        )
          .bind(item.taskId)
          .first<{ delivered_at: number | null }>()
      )?.delivered_at,
    ).not.toBeNull();
  });
});
