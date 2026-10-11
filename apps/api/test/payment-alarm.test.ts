import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  evictDurableObject,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  ARCHIVE_DELAY_MS,
  type ClaimResult,
  emptyActivityInput,
  type LdcActivityInput,
  type SimulationScenario,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import worker from "../src/index";
import { createMerchant } from "../src/payments/merchants";
import { flushPaymentOutbox } from "../src/payments/scheduler";
import { resetMerchantHistory } from "./reset-merchant-history";

const merchantStubs: ReturnType<typeof env.MERCHANT_DO.get>[] = [];

async function user() {
  const id = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    officialConnectVerified: true,
    id,
    externalId: id,
    username: id,
    displayName: "alarm test",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function fixture(
  count = 1,
  scenario: SimulationScenario = "normal",
  initialClaims = count,
) {
  const owner = await user();
  const merchant = await createMerchant(env, owner, {
    requestId: crypto.randomUUID(),
    clientId: `alarm_${crypto.randomUUID()}`,
    label: "Alarm 模拟商户",
    secret: "test-only-secret",
  });
  await env.DB.prepare(
    "UPDATE simulation_controls SET scenario=? WHERE merchant_id=?",
  )
    .bind(scenario, merchant.id)
    .run();
  const {
    rewards: _rewards,
    rewardType: _type,
    ...common
  } = emptyActivityInput();
  const input: LdcActivityInput = {
    ...common,
    title: "Alarm 付款活动",
    rewardType: "ldc",
    passwords: ["Answer123"],
    merchantId: merchant.id,
    money: { mode: "fixed", totalAmount: String(count), count },
  };
  const draft = await createActivity(env, owner, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  const activity = await openActivity(env, draft.id, owner, draft.version);
  const taskIds: string[] = [];
  for (let i = 0; i < initialClaims; i++) {
    const result = await claimActivity(env, activity.id, await user(), {
      submissionId: crypto.randomUUID(),
      password: "Answer123",
    });
    if (!("claim" in result) || result.claim.rewardType !== "ldc")
      throw new Error("Expected LDC claim");
    taskIds.push(result.claim.payment.id);
  }
  const stub = env.MERCHANT_DO.get(
    env.MERCHANT_DO.idFromName(merchant.clientId),
  );
  merchantStubs.push(stub);
  async function wake() {
    const response = await stub.fetch(
      "https://merchant.internal/internal/payments/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId: merchant.id }),
      },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  return { activity, merchant, stub, taskIds, wake };
}

async function task(id: string) {
  const row = await env.DB.prepare(
    "SELECT status,unknown_outcome,attempt_count,reconciliation_count,external_order_id FROM payment_tasks WHERE id=?",
  )
    .bind(id)
    .first<{
      status: string;
      unknown_outcome: number;
      attempt_count: number;
      reconciliation_count: number;
      external_order_id: string | null;
    }>();
  if (!row) throw new Error("Expected payment task");
  return row;
}

async function countOrders() {
  return (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM simulation_orders").first<{
      n: number;
    }>()
  )?.n;
}

async function makeDue(id: string) {
  await env.DB.prepare("UPDATE payment_tasks SET next_run_at=0 WHERE id=?")
    .bind(id)
    .run();
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  vi.restoreAllMocks();
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
});

afterEach(async () => {
  for (const stub of merchantStubs.splice(0)) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  vi.restoreAllMocks();
});

describe("MerchantDO alarms and durable payment recovery", () => {
  it("late or empty scheduling snapshots never postpone or erase an earlier wake", async () => {
    const f = await fixture();
    const id = f.taskIds[0] as string;
    const earlier = Date.now() + 60_000;
    await env.DB.prepare("UPDATE payment_tasks SET next_run_at=? WHERE id=?")
      .bind(earlier + 60_000, id)
      .run();
    await runInDurableObject(f.stub, async (_instance, state) => {
      await state.storage.setAlarm(earlier);
    });
    await f.wake();
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(earlier);
    await makeDue(id);
    await f.wake();
    expect((await task(id)).status).toBe("confirmed");
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).toBe(earlier);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await runDurableObjectAlarm(f.stub)).toBe(false);
    expect(await countOrders()).toBe(1);
  });

  it("a scheduled Alarm sends a due pending task and removes its completed alarm", async () => {
    const f = await fixture();
    const id = f.taskIds[0] as string;
    await env.DB.prepare("UPDATE payment_tasks SET next_run_at=? WHERE id=?")
      .bind(Date.now() + 60_000, id)
      .run();
    await f.wake();
    expect((await task(id)).status).toBe("pending");
    expect(await countOrders()).toBe(0);
    expect(
      await runInDurableObject(f.stub, (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    await makeDue(id);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await task(id)).status).toBe("confirmed");
    expect(await countOrders()).toBe(1);
    expect(await runDurableObjectAlarm(f.stub)).toBe(false);
  });

  it("after eviction an Alarm reconstructs an unknown order from D1 using only the stored merchantId", async () => {
    const f = await fixture(1, "response_lost");
    const id = f.taskIds[0] as string;
    await f.wake();
    expect(await task(id)).toMatchObject({
      status: "reconciling",
      unknown_outcome: 1,
      attempt_count: 1,
    });
    expect(await countOrders()).toBe(1);
    const saved = await runInDurableObject(f.stub, async (_instance, state) => {
      // Keep wall-clock timers out of this deterministic eviction test.
      await state.storage.setAlarm(Date.now() + 60_000);
      return Object.fromEntries(await state.storage.list());
    });
    expect(saved).toEqual({ merchantId: f.merchant.id });
    await evictDurableObject(f.stub);
    await makeDue(id);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect(await task(id)).toMatchObject({
      status: "confirmed",
      unknown_outcome: 0,
      attempt_count: 1,
      reconciliation_count: 1,
    });
    expect(await countOrders()).toBe(1);
    const attempts = await env.DB.prepare(
      "SELECT operation,outcome FROM payment_attempts WHERE task_id=? ORDER BY started_at,id",
    )
      .bind(id)
      .all();
    expect(attempts.results).toEqual([
      { operation: "send", outcome: "unknown" },
      { operation: "query", outcome: "succeeded" },
    ]);
  });

  it("duplicate Queue wakes and Cron recover every delivered-but-unconsumed task across two merchants", async () => {
    const a = await fixture(24);
    const b = await fixture(3);
    vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect(await flushPaymentOutbox(env)).toBe(20);
    expect(await countOrders()).toBe(0);
    const delivered = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM payment_outbox WHERE delivered_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(delivered?.n).toBe(20);
    expect(await flushPaymentOutbox(env)).toBe(7);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM payment_outbox WHERE delivered_at IS NOT NULL",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(27);
    const messages = [a.taskIds[0], b.taskIds[0]].flatMap((taskId, index) =>
      [1, 2, 3].map((duplicate) => ({
        id: `merchant-${index}-duplicate-${duplicate}`,
        timestamp: new Date(),
        attempts: duplicate,
        body: { type: "payment.wake", taskId },
      })),
    );
    const batch = createMessageBatch("hb-local-tasks", messages);
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks.sort()).toEqual(
      messages.map((message) => message.id).sort(),
    );
    const scheduled = createScheduledController({
      cron: "* * * * *",
      scheduledTime: Date.now(),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let cycle = 0; cycle < 24; cycle++) {
      await worker.scheduled(scheduled, env, createExecutionContext());
      if ((await countOrders()) === 27) break;
    }
    const summary = await env.DB.prepare(
      "SELECT status,COUNT(*) AS n FROM payment_tasks GROUP BY status",
    ).all();
    expect(summary.results).toEqual([{ status: "confirmed", n: 27 }]);
    expect(await countOrders()).toBe(27);
    const badOrders =
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_tasks p
      LEFT JOIN simulation_orders o ON o.client_id=p.client_id AND o.business_no=p.business_no
      WHERE o.id IS NULL OR o.id!=p.external_order_id OR o.amount_minor!=p.amount_minor OR o.recipient_id!=p.recipient_id`).first<{
        n: number;
      }>();
    expect(badOrders?.n).toBe(0);
    const replay = createMessageBatch("hb-local-tasks", messages);
    await worker.queue(replay, env);
    await worker.scheduled(scheduled, env, createExecutionContext());
    expect(await countOrders()).toBe(27);
  }, 30_000);

  it("Cron still pays rewards after activity end and archive", async () => {
    const ended = await fixture();
    const archived = await fixture();
    const endedAt = Date.now() - ARCHIVE_DELAY_MS - 1000;
    await env.DB.prepare(
      "UPDATE activities SET ended_at=?,archived_at=NULL WHERE id=?",
    )
      .bind(endedAt, archived.activity.id)
      .run();
    vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(
      createScheduledController({
        cron: "* * * * *",
        scheduledTime: Date.now(),
      }),
      env,
      createExecutionContext(),
    );
    const status = await env.DB.prepare(
      "SELECT ended_at,archived_at FROM activities WHERE id=?",
    )
      .bind(archived.activity.id)
      .first<{ ended_at: number; archived_at: number }>();
    expect(status?.archived_at).toBe(endedAt + ARCHIVE_DELAY_MS);
    for (const id of [...ended.taskIds, ...archived.taskIds])
      expect((await task(id)).status).toBe("confirmed");
    expect(await countOrders()).toBe(2);
  });

  it("a successful ActivityDO claim immediately dispatches its committed Outbox event", async () => {
    const f = await fixture(1, "normal", 0);
    const recipient = await user();
    const activityStub = env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName(f.activity.id),
    );
    const result = await runInDurableObject(
      activityStub,
      async (instance, state) => {
        const pending: Promise<unknown>[] = [];
        const waitUntil = state.waitUntil.bind(state);
        const wait = vi
          .spyOn(state, "waitUntil")
          .mockImplementation((promise) => {
            pending.push(promise);
            waitUntil(promise);
          });
        try {
          const response = await instance.fetch(
            new Request(
              `https://activity.internal/internal/activities/${f.activity.id}/claim`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  userId: recipient,
                  submissionId: crypto.randomUUID(),
                  password: "Answer123",
                }),
              },
            ),
          );
          await Promise.all(pending);
          return {
            status: response.status,
            result: (await response.json()) as ClaimResult,
            backgroundTasks: pending.length,
          };
        } finally {
          wait.mockRestore();
        }
      },
    );
    expect(result.status).toBe(200);
    expect(result.backgroundTasks).toBe(1);
    if (!("claim" in result.result) || result.result.claim.rewardType !== "ldc")
      throw new Error("Expected committed LDC claim");
    const outbox = await env.DB.prepare(
      "SELECT delivered_at FROM payment_outbox WHERE task_id=?",
    )
      .bind(result.result.claim.payment.id)
      .first<{ delivered_at: number | null }>();
    expect(outbox?.delivered_at).toEqual(expect.any(Number));
  });
});
