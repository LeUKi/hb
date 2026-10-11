import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  runInDurableObject,
} from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type SimulationScenario,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { merchants, paymentTasks, users } from "../src/db/schema";
import worker from "../src/index";
import type { PaymentAdapter } from "../src/payments/adapter";
import { readMerchantImpact } from "../src/payments/configuration";
import { loadMerchantSecret } from "../src/payments/credentials";
import { createMerchant, updateMerchant } from "../src/payments/merchants";
import {
  flushPaymentOutbox,
  runMerchantCycle,
  sweepPayments,
} from "../src/payments/scheduler";
import { resetMerchantHistory } from "./reset-merchant-history";

async function user() {
  const id = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    officialConnectVerified: true,
    id,
    externalId: id,
    username: id,
    displayName: "test",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}
async function fixture(count = 2, scenario: SimulationScenario = "normal") {
  const owner = await user();
  const recipient = await user();
  const merchant = await createMerchant(env, owner, {
    requestId: crypto.randomUUID(),
    clientId: `sim_${crypto.randomUUID()}`,
    label: "模拟商户",
    secret: "dummy-only",
  });
  await env.DB.prepare(
    `UPDATE simulation_controls SET scenario=? WHERE merchant_id=?`,
  )
    .bind(scenario, merchant.id)
    .run();
  const { rewards: _r, rewardType: _t, ...base } = emptyActivityInput();
  const config: LdcActivityInput = {
    ...base,
    rewardType: "ldc",
    title: "付款测试",
    passwords: ["Correct123"],
    merchantId: merchant.id,
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
      throw new Error("Missing LDC claim");
    return result.claim.payment.id;
  }
  const taskId = await claim();
  return { owner, recipient, merchant, activity, taskId, claim };
}
async function task(id: string) {
  const result = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where((await import("drizzle-orm")).eq(paymentTasks.id, id))
    .get();
  if (!result) throw new Error("No task");
  return result;
}
async function due(id: string) {
  await env.DB.prepare(
    `UPDATE payment_tasks SET next_run_at=0,next_query_at=0 WHERE id=?`,
  )
    .bind(id)
    .run();
}
async function scenario(id: string, value: SimulationScenario) {
  await env.DB.prepare(
    `UPDATE simulation_controls SET scenario=? WHERE merchant_id=?`,
  )
    .bind(value, id)
    .run();
}
async function orders() {
  return (
    await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM simulation_orders",
    ).first<{ count: number }>()
  )?.count;
}
async function clear() {
  // Test-only fixture reset; production must retain its durable one-send evidence.
  await env.DB.prepare(
    "DROP TRIGGER IF EXISTS payment_acceptances_no_delete",
  ).run();
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "payment_acceptances",
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
  await env.DB.prepare(`CREATE TRIGGER payment_acceptances_no_delete BEFORE DELETE ON payment_acceptances
    BEGIN SELECT RAISE(ABORT, 'acceptance authorization cannot be deleted'); END`).run();
}
async function realPaymentFixture() {
  const owner = await user();
  const recipient = await user();
  const now = Date.now();
  const acceptanceId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const merchantId = crypto.randomUUID();
  const clientId = `real_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO merchants (id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at)
        VALUES (?,?,?,?,?,'真实商户','real',?,?)`,
    ).bind(
      merchantId,
      owner,
      crypto.randomUUID(),
      crypto.randomUUID(),
      clientId,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO payment_acceptances
        (id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,send_consumed_at,created_at)
        VALUES (?,?,?,?,'18446744073709551615','lafish',100,?,?)`,
    ).bind(
      acceptanceId,
      merchantId,
      clientId,
      `hb_${acceptanceId.replaceAll("-", "")}`,
      now - 1,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO payment_tasks
        (id,claim_id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,attempt_count,unknown_outcome,next_run_at,created_at,updated_at)
        SELECT ?,NULL,'acceptance',id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,'real','reconciling',1,1,0,?,? FROM payment_acceptances WHERE id=?`,
    ).bind(taskId, now, now, acceptanceId),
  ]);
  return {
    owner,
    recipient,
    taskId,
    merchant: { id: merchantId, clientId },
  };
}
beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  vi.restoreAllMocks();
  await clear();
});

describe("durable simulated payments", () => {
  it("stale pending snapshots cannot release a newer unknown-order protection", async () => {
    const f = await fixture(1, "query_delayed");
    const originalBatch = env.DB.batch.bind(env.DB);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (first) {
        first = false;
        entered();
        await blocked;
      }
      return originalBatch(statements);
    });
    const stale = runMerchantCycle(env, f.merchant.id);
    await captured;
    await runMerchantCycle(env, f.merchant.id);
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    await due(f.taskId);
    await scenario(f.merchant.id, "insufficient_funds");
    release();
    await stale;
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
    const row = await createDb(env.DB)
      .select()
      .from(merchants)
      .where(eq(merchants.id, f.merchant.id))
      .get();
    expect(row?.activeTaskId).toBe(f.taskId);
    expect((await task(f.taskId)).attemptCount).toBe(1);
    expect(await orders()).toBe(1);
  });
  it("confirms exact immutable order once even on concurrent wakes", async () => {
    const f = await fixture();
    await Promise.all([
      runMerchantCycle(env, f.merchant.id),
      runMerchantCycle(env, f.merchant.id),
      runMerchantCycle(env, f.merchant.id),
    ]);
    expect((await task(f.taskId)).status).toBe("confirmed");
    expect(await orders()).toBe(1);
    await runMerchantCycle(env, f.merchant.id);
    expect(await orders()).toBe(1);
    const stored = await env.DB.prepare(
      "SELECT amount_minor,recipient_id FROM simulation_orders",
    ).first<{ amount_minor: number; recipient_id: string }>();
    expect(stored?.amount_minor).toBe(100);
    expect(stored?.recipient_id).toBe(`simulation:${f.recipient}`);
  });
  it("lost response pauses only this merchant and query recovers before the next send", async () => {
    const f = await fixture(2, "response_lost");
    const otherTask = await f.claim(await user());
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("reconciling");
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(otherTask)).status).toBe("pending");
    expect(await orders()).toBe(1);
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("confirmed");
    await scenario(f.merchant.id, "normal");
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(otherTask)).status).toBe("confirmed");
    expect(await orders()).toBe(2);
  });
  it("query delay uses same business number when replaying and never creates another order", async () => {
    const f = await fixture(1, "query_delayed");
    await runMerchantCycle(env, f.merchant.id);
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("confirmed");
    expect(await orders()).toBe(1);
  });
  it("unavailable query remains reconciling without dropping the obligation", async () => {
    const f = await fixture(1, "query_unavailable");
    await runMerchantCycle(env, f.merchant.id);
    for (let i = 0; i < 3; i++) {
      await due(f.taskId);
      await runMerchantCycle(env, f.merchant.id);
    }
    expect((await task(f.taskId)).status).toBe("reconciling");
    expect(await orders()).toBe(1);
    await scenario(f.merchant.id, "normal");
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("confirmed");
  });
  it.each([
    "insufficient_funds",
    "daily_limit",
    "invalid_credentials",
  ] as const)("recovers from %s with original task", async (value) => {
    const f = await fixture(1, value);
    const original = await task(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("waiting");
    expect(await orders()).toBe(0);
    await scenario(f.merchant.id, "normal");
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    const result = await task(f.taskId);
    expect(result.status).toBe("confirmed");
    expect(result.businessNo).toBe(original.businessNo);
    expect(result.amountMinor).toBe(original.amountMinor);
  });
  it("later business rejection cannot erase an earlier unknown send", async () => {
    const f = await fixture();
    await env.DB.prepare(
      "UPDATE payment_tasks SET unknown_outcome=1 WHERE id=?",
    )
      .bind(f.taskId)
      .run();
    await scenario(f.merchant.id, "insufficient_funds");
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("reconciling");
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
  });
  it("conflicting amount protects merchant and cannot be bypassed by credential update", async () => {
    const f = await fixture(2, "conflict");
    const second = await f.claim(await user());
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("attention");
    await updateMerchant(env, f.merchant.id, f.owner, {
      confirmationToken: (await readMerchantImpact(env, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: "updated",
      secret: "rotated-dummy",
    });
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(second)).status).toBe("pending");
    expect(await orders()).toBe(1);
  });
  it("lease expiry enters query first and records interrupted intent", async () => {
    const f = await fixture();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE merchants SET active_task_id=?,lease_token='lost',lease_until=? WHERE id=?",
      ).bind(f.taskId, now - 1, f.merchant.id),
      env.DB.prepare(
        "UPDATE payment_tasks SET status='sending' WHERE id=?",
      ).bind(f.taskId),
      env.DB.prepare(
        "INSERT INTO payment_attempts(id,task_id,token,operation,outcome,credential_version,started_at) VALUES(?,?,'lost','send','started',1,?)",
      ).bind(crypto.randomUUID(), f.taskId, now - 1000),
    ]);
    await runMerchantCycle(env, f.merchant.id);
    expect(await orders()).toBe(0);
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
    const attempts = await env.DB.prepare(
      "SELECT operation,outcome FROM payment_attempts ORDER BY started_at",
    ).all();
    expect(attempts.results).toEqual([
      { operation: "send", outcome: "unknown" },
      { operation: "query", outcome: "succeeded" },
    ]);
  });
  it("credential versions stay encrypted and original orders survive rotation", async () => {
    const f = await fixture(1, "response_lost");
    await runMerchantCycle(env, f.merchant.id);
    await updateMerchant(env, f.merchant.id, f.owner, {
      confirmationToken: (await readMerchantImpact(env, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: "rotated",
      secret: "new-private-secret",
    });
    await due(f.taskId);
    await runMerchantCycle(env, f.merchant.id);
    expect((await task(f.taskId)).status).toBe("confirmed");
    const credentials = await env.DB.prepare(
      "SELECT version,ciphertext FROM merchant_credentials ORDER BY version",
    ).all();
    expect(credentials.results).toHaveLength(2);
    expect(JSON.stringify(credentials.results)).not.toContain(
      "new-private-secret",
    );
    expect(await orders()).toBe(1);
  });
  it("can read a fixed credential version after rotation without exposing ciphertext", async () => {
    const f = await fixture();
    await updateMerchant(env, f.merchant.id, f.owner, {
      confirmationToken: (await readMerchantImpact(env, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: "rotated",
      secret: "new-private-secret",
    });
    await expect(loadMerchantSecret(env, f.merchant.id, 1)).resolves.toBe(
      "dummy-only",
    );
    await expect(loadMerchantSecret(env, f.merchant.id, 2)).resolves.toBe(
      "new-private-secret",
    );
    const stored = await env.DB.prepare(
      "SELECT ciphertext FROM merchant_credentials ORDER BY version",
    ).all();
    expect(JSON.stringify(stored.results)).not.toContain("dummy-only");
    expect(JSON.stringify(stored.results)).not.toContain("new-private-secret");
  });
  it("Outbox send failure keeps event undelivered for compensation", async () => {
    await fixture();
    const send = vi
      .spyOn(env.PAYMENT_QUEUE, "send")
      .mockRejectedValueOnce(new Error("queue offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await flushPaymentOutbox(env);
    expect(
      (
        await env.DB.prepare("SELECT delivered_at FROM payment_outbox").first<{
          delivered_at: number | null;
        }>()
      )?.delivered_at,
    ).toBeNull();
    send.mockResolvedValueOnce({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    await flushPaymentOutbox(env);
    expect(
      (
        await env.DB.prepare("SELECT delivered_at FROM payment_outbox").first<{
          delivered_at: number | null;
        }>()
      )?.delivered_at,
    ).not.toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_tasks").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    log.mockRestore();
  });
  it("queue duplicate messages execute at most one order via real MerchantDO", async () => {
    const f = await fixture(1);
    const batch = createMessageBatch(
      "hb-local-tasks",
      [1, 2].map((n) => ({
        id: `q${n}`,
        timestamp: new Date(),
        attempts: 1,
        body: { type: "payment.wake", taskId: f.taskId },
      })),
    );
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["q1", "q2"]);
    expect(await orders()).toBe(1);
    expect((await task(f.taskId)).status).toBe("confirmed");
  });
  it("Cron handles unrelated merchant while one has unresolved query", async () => {
    const a = await fixture(1, "query_unavailable");
    await runMerchantCycle(env, a.merchant.id);
    const b = await fixture(1);
    vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    await due(a.taskId);
    await sweepPayments(env);
    expect((await task(a.taskId)).status).toBe("reconciling");
    expect((await task(b.taskId)).status).toBe("confirmed");
    const stub = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName(a.merchant.clientId),
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
  it("blocks real mode before recording a send attempt in normal runtime", async () => {
    const f = await realPaymentFixture();
    await expect(runMerchantCycle(env, f.merchant.id)).rejects.toThrow(
      "REAL_LDC_NOT_ENABLED",
    );
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_attempts",
    ).first<{ count: number }>();
    expect(attempts?.count).toBe(0);
  });
  it("keeps real not-found query under reconciliation instead of replaying send", async () => {
    const f = await realPaymentFixture();
    const adapter: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
      query: vi.fn(
        async () =>
          ({
            kind: "not_found",
            reason: "checking_not_found",
          }) as const,
      ),
    };
    await runMerchantCycle(
      { ...env, LDC_NETWORK_MODE: "verify" },
      f.merchant.id,
      {
        adapterFactory: (mode) => (mode === "real" ? adapter : null),
      },
    );
    const updated = await task(f.taskId);
    expect(updated.status).toBe("reconciling");
    expect(updated.reason).toBe("checking_not_found");
    expect(updated.unknownOutcome).toBe(true);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.query).toHaveBeenCalledOnce();
    const row = await createDb(env.DB)
      .select()
      .from(merchants)
      .where(eq(merchants.id, f.merchant.id))
      .get();
    expect(row?.activeTaskId).toBe(f.taskId);
  });
  it("keeps real status-zero query protected and detects conflicting evidence", async () => {
    const f = await realPaymentFixture();
    const statusZero: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
      query: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
    };
    await runMerchantCycle(
      { ...env, LDC_NETWORK_MODE: "verify" },
      f.merchant.id,
      {
        adapterFactory: () => statusZero,
      },
    );
    expect((await task(f.taskId)).status).toBe("reconciling");
    await due(f.taskId);
    const conflict: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
      query: vi.fn(
        async () =>
          ({
            kind: "confirmed",
            evidence: {
              source: "query",
              clientId: f.merchant.clientId,
              businessNo: (await task(f.taskId)).businessNo,
              amountMinor: 999,
              externalOrderId: "TRADE-CONFLICT",
              status: 1,
            },
          }) as const,
      ),
    };
    await runMerchantCycle(
      { ...env, LDC_NETWORK_MODE: "verify" },
      f.merchant.id,
      {
        adapterFactory: () => conflict,
      },
    );
    const updated = await task(f.taskId);
    expect(updated.status).toBe("attention");
    expect(updated.reason).toBe("conflict");
  });
  it("does not confirm real tasks from missing adapter evidence", async () => {
    const f = await realPaymentFixture();
    const adapter: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
      query: vi.fn(
        async () =>
          ({
            kind: "confirmed",
            evidence: { source: "query" },
          }) as const,
      ),
    };
    await runMerchantCycle(
      { ...env, LDC_NETWORK_MODE: "verify" },
      f.merchant.id,
      {
        adapterFactory: () => adapter,
      },
    );
    const updated = await task(f.taskId);
    expect(updated.status).toBe("attention");
    expect(updated.reason).toBe("conflict");
    expect(updated.externalOrderId).toBeNull();
  });
  it("migration and schema preserve immutable payment modes and reject malformed inventory amounts", async () => {
    const f = await fixture();
    await expect(
      env.DB.prepare("UPDATE payment_tasks SET mode='real' WHERE id=?")
        .bind(f.taskId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE merchants SET mode='real' WHERE id=?")
        .bind(f.merchant.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE reward_inventory SET amount_minor=NULL WHERE activity_id=?",
      )
        .bind(f.activity.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE reward_inventory SET amount_minor=1.5 WHERE activity_id=?",
      )
        .bind(f.activity.id)
        .run(),
    ).rejects.toThrow();
  });
});
