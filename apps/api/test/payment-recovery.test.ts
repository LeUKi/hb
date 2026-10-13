import {
  createExecutionContext,
  createMessageBatch,
  env,
  evictDurableObject,
  getQueueResult,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client";
import {
  paymentDuplicateProbes,
  paymentRetryGrants,
  paymentTasks,
  paymentUsernameCorrections,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import worker from "../src/index";
import type { AdapterResult, PaymentAdapter } from "../src/payments/adapter";
import { readMerchantImpact } from "../src/payments/configuration";
import { createMerchant, updateMerchant } from "../src/payments/merchants";
import {
  effectivePaymentTask,
  paymentParameterDigest,
  realSendDecision,
} from "../src/payments/policy";
import {
  runMerchantCycle,
  sweepPayments,
  wakePayment,
} from "../src/payments/scheduler";
import { decryptString } from "../src/security/crypto";

let now: number;
const stubs: ReturnType<typeof env.MERCHANT_DO.get>[] = [];

beforeEach(() => {
  vi.restoreAllMocks();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
  for (const stub of stubs.splice(0))
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  vi.restoreAllMocks();
});

async function fixture(history = true) {
  const owner = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    officialConnectVerified: true,
    id: owner,
    externalId: owner,
    username: owner,
    displayName: "恢复测试",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const merchant = await createMerchant(env, owner, {
    requestId: crypto.randomUUID(),
    mode: "real",
    label: "测试商户",
    clientId: `retry_${crypto.randomUUID()}`,
    secret: "test-only-secret",
  });
  await env.DB.prepare(
    "UPDATE merchant_credentials SET verification_status='passed' WHERE merchant_id=?",
  )
    .bind(merchant.id)
    .run();
  const acceptanceId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const businessNo = `hb_${acceptanceId.replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO payment_acceptances(id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,send_consumed_at,created_at) VALUES(?,?,?,?,'100001','tester7369',10,?,?)",
    ).bind(
      acceptanceId,
      merchant.id,
      merchant.clientId,
      businessNo,
      history ? now - 1 : null,
      now - 2,
    ),
    env.DB.prepare(`INSERT INTO payment_tasks(id,source,claim_id,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,attempt_count,unknown_outcome,next_action,next_run_at,next_query_at,created_at,updated_at)
      SELECT ?,'acceptance',NULL,id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,'real',?,?,?,'query',0,0,?,? FROM payment_acceptances WHERE id=?`).bind(
      taskId,
      history ? "reconciling" : "pending",
      history ? 1 : 0,
      Number(history),
      now - 2,
      now - 1,
      acceptanceId,
    ),
  ]);
  const bindings = {
    ...env,
    APP_ENV: "local",
    LDC_NETWORK_MODE: "acceptance",
    LDC_ACCEPTANCE_ID: acceptanceId,
  } as ApiBindings;
  return { owner, merchant, taskId, acceptanceId, businessNo, bindings };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function task(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, f.taskId))
    .get();
  if (!row) throw new Error("Task missing");
  return row;
}
async function grant(f: Fixture, max = 5, duration = 86_400_000) {
  const row = await task(f);
  await createDb(env.DB)
    .insert(paymentRetryGrants)
    .values({
      taskId: f.taskId,
      parameterDigest: await paymentParameterDigest(row),
      maxAdditionalSends: max,
      expiresAt: now + duration,
      createdAt: now,
    });
  if (row.status !== "confirmed")
    await env.DB.prepare(
      "UPDATE payment_tasks SET next_action='query',next_query_at=0,next_run_at=0,next_send_at=COALESCE(next_send_at,?),recovery_version=recovery_version+1 WHERE id=?",
    )
      .bind(now + 10_000, f.taskId)
      .run();
}
async function makeQueryDue(f: Fixture) {
  await env.DB.prepare(
    "UPDATE payment_tasks SET next_query_at=0,next_run_at=0 WHERE id=?",
  )
    .bind(f.taskId)
    .run();
}
async function consumed(f: Fixture) {
  return (
    await env.DB.prepare(
      "SELECT send_consumed_at FROM payment_acceptances WHERE id=?",
    )
      .bind(f.acceptanceId)
      .first<{ send_consumed_at: number | null }>()
  )?.send_consumed_at;
}
async function used(f: Fixture) {
  return (
    await createDb(env.DB)
      .select()
      .from(paymentRetryGrants)
      .where(eq(paymentRetryGrants.taskId, f.taskId))
      .get()
  )?.usedAdditionalSends;
}

async function correctableFixture() {
  const f = await fixture();
  await grant(f);
  const a = adapter(
    { kind: "not_found" },
    { kind: "rejected", reason: "recipient", httpStatus: 400 },
  );
  await cycle(f, a);
  now += 20_000;
  await cycle(f, a);
  expect((await task(f)).sendBlockReason).toBe("recipient");
  expect(await used(f)).toBe(1);
  return f;
}

async function correctUsername(f: Fixture) {
  const original = await task(f);
  const corrected = { ...original, recipientUsername: "Tester7369" };
  const row = {
    taskId: f.taskId,
    originalUsername: original.recipientUsername ?? "",
    correctedUsername: corrected.recipientUsername,
    originalParameterDigest: await paymentParameterDigest(original),
    correctedParameterDigest: await paymentParameterDigest(corrected),
    createdAt: now,
  };
  await createDb(env.DB).insert(paymentUsernameCorrections).values(row);
  return row;
}
function confirmed(f: Fixture, trade = "TRADE-ORIGINAL"): AdapterResult {
  return {
    kind: "confirmed",
    evidence: {
      source: "query",
      clientId: f.merchant.clientId,
      businessNo: f.businessNo,
      amountMinor: 10,
      externalOrderId: trade,
      status: 1,
    },
  };
}
function adapter(
  query: AdapterResult = { kind: "not_found" },
  send: AdapterResult = { kind: "unknown", reason: "timeout" },
): PaymentAdapter {
  return {
    mode: "real",
    send: vi.fn(async () => send),
    query: vi.fn(async () => query),
  };
}
async function cycle(f: Fixture, a: PaymentAdapter) {
  return runMerchantCycle(f.bindings, f.merchant.id, {
    adapterFactory: () => a,
  });
}

describe("durable same-business-number recovery", () => {
  it("legacy consumed tasks remain query-only without a durable grant", async () => {
    const f = await fixture();
    const a = adapter();
    const firstConsumed = await consumed(f);
    for (let i = 0; i < 3; i++) {
      await makeQueryDue(f);
      await cycle(f, a);
    }
    expect(a.send).not.toHaveBeenCalled();
    expect(a.query).toHaveBeenCalledTimes(3);
    expect((await task(f)).attemptCount).toBe(1);
    expect(await consumed(f)).toBe(firstConsumed);
  });

  it("queries the original task before one retry and preserves every immutable parameter and first-send evidence", async () => {
    const f = await fixture();
    const old = await task(f);
    const firstConsumed = await consumed(f);
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect(a.send).not.toHaveBeenCalled();
    expect((await task(f)).nextAction).toBe("send");
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    now += 20_000;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    const current = await task(f);
    for (const key of [
      "id",
      "merchantId",
      "clientId",
      "businessNo",
      "recipientId",
      "recipientUsername",
      "amountMinor",
    ] as const)
      expect(current[key]).toBe(old[key]);
    expect(current.attemptCount).toBe(2);
    expect(current.unknownOutcome).toBe(true);
    expect(current.nextAction).toBe("query");
    expect(await used(f)).toBe(1);
    expect(await consumed(f)).toBe(firstConsumed);
  });

  it.each<AdapterResult>([
    { kind: "unknown", reason: "network" },
    { kind: "unknown", reason: "timeout" },
    { kind: "unknown", reason: "http", httpStatus: 503 },
  ])(
    "permits authorized same-order recovery after temporary query failure %j",
    async (query) => {
      const f = await fixture();
      await grant(f);
      const a = adapter(query);
      await cycle(f, a);
      now += 20_000;
      await cycle(f, a);
      expect(a.send).toHaveBeenCalledOnce();
      expect((await task(f)).unknownOutcome).toBe(true);
    },
  );

  it.each<AdapterResult>([
    { kind: "unknown", reason: "invalid_response" },
    { kind: "unknown", reason: "redirect" },
    { kind: "unknown", reason: "credentials", httpStatus: 400 },
    { kind: "unknown", reason: "http", httpStatus: 400 },
    { kind: "throttled", reason: "throttled", retryAfterMs: 60_000 },
  ])("never converts query failure %j into send permission", async (query) => {
    const f = await fixture();
    await grant(f);
    const a = adapter(query);
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    expect(await used(f)).toBe(0);
  });

  it("latches complete status-zero evidence even if the next query is not-found", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter({
      kind: "unconfirmed",
      reason: "upstream_pending",
      evidence: {
        source: "query",
        clientId: f.merchant.clientId,
        businessNo: f.businessNo,
        amountMinor: 10,
        externalOrderId: "TRADE-PENDING",
        status: 0,
      },
    });
    await cycle(f, a);
    expect((await task(f)).orderEvidence).toBe("query");
    expect((await task(f)).externalOrderId).toBe("TRADE-PENDING");
    vi.mocked(a.query).mockResolvedValue({ kind: "not_found" });
    now += 60_000;
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    expect((await task(f)).unknownOutcome).toBe(true);
  });

  it.each<AdapterResult>([
    { kind: "duplicate", reason: "duplicate_order" },
    {
      kind: "sent",
      evidence: {
        source: "send",
        businessNo: "replaced-by-test",
        externalOrderId: "TRADE-RECEIPT",
      },
    },
  ])(
    "does not retry after receipt or reliable duplicate evidence %j",
    async (send) => {
      const f = await fixture();
      await grant(f);
      if (send.kind === "sent")
        send = {
          ...send,
          evidence: { ...send.evidence, businessNo: f.businessNo },
        };
      const a = adapter({ kind: "not_found" }, send);
      await cycle(f, a);
      now += 20_000;
      await cycle(f, a);
      const observed = (await task(f)).orderObservedAt;
      now += 60_000;
      await cycle(f, a);
      expect(a.send).toHaveBeenCalledOnce();
      expect(await used(f)).toBe(1);
      expect((await task(f)).orderObservedAt).toBe(observed);
    },
  );

  it("stops retrying after exhaustion, expiry or revocation while retaining query responsibility", async () => {
    for (const boundary of ["exhaustion", "expiry", "revocation"]) {
      const f = await fixture();
      await grant(f, 1, 60_000);
      const a = adapter();
      await cycle(f, a);
      if (boundary === "expiry") now += 60_000;
      else if (boundary === "revocation") {
        await env.DB.prepare(
          "UPDATE payment_retry_grants SET revoked_at=? WHERE task_id=?",
        )
          .bind(now, f.taskId)
          .run();
        now += 20_000;
      } else {
        now += 20_000;
        await cycle(f, a);
        now += 5_000;
      }
      await cycle(f, a);
      now += 20_000;
      await cycle(f, a);
      expect(a.send).toHaveBeenCalledTimes(boundary === "exhaustion" ? 1 : 0);
      expect(a.query).toHaveBeenCalled();
      expect((await task(f)).unknownOutcome).toBe(true);
    }
  });

  it("same-millisecond concurrent retries consume one grant unit and acquire one merchant lease", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    now += 20_000;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => cycle(f, a)),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(a.send).toHaveBeenCalledOnce();
    expect(await used(f)).toBe(1);
    expect((await task(f)).attemptCount).toBe(2);
  });

  it("rolls back a consumed retry budget, task state and lease when attempt insertion fails", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    now += 20_000;
    await env.DB.prepare(
      `CREATE TRIGGER reject_retry_attempt BEFORE INSERT ON payment_attempts WHEN NEW.task_id='${f.taskId}' AND NEW.operation='send' BEGIN SELECT RAISE(ABORT,'injected retry failure'); END`,
    ).run();
    try {
      await expect(cycle(f, a)).rejects.toThrow("retry failure");
      expect(await used(f)).toBe(0);
      expect((await task(f)).attemptCount).toBe(1);
      expect(a.send).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_retry_attempt").run();
    }
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted retry by query without resetting its consumed budget", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    now += 20_000;
    const original = env.DB.batch.bind(env.DB);
    let calls = 0;
    const fault = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (++calls === 2) throw new Error("lost retry result");
        return original(statements);
      });
    await expect(cycle(f, a)).rejects.toThrow("lost retry result");
    fault.mockRestore();
    expect((await task(f)).status).toBe("sending");
    expect(await used(f)).toBe(1);
    await env.DB.prepare("UPDATE merchants SET lease_until=0 WHERE id=?")
      .bind(f.merchant.id)
      .run();
    await makeQueryDue(f);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect(a.query).toHaveBeenCalledTimes(2);
    expect((await task(f)).nextAction).toBe("send");
    // Restored query may schedule an authorized future retry, but cannot replay the interrupted request immediately.
    expect((await task(f)).nextSendAt).toBeGreaterThanOrEqual(now);
  });

  it("an intervening revocation prevents a queued stale send from consuming budget", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    now += 20_000;
    const original = env.DB.batch.bind(env.DB);
    let first = true;
    const spy = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (first) {
          first = false;
          await env.DB.prepare(
            "UPDATE payment_retry_grants SET revoked_at=? WHERE task_id=?",
          )
            .bind(now, f.taskId)
            .run();
        }
        return original(statements);
      });
    await expect(cycle(f, a)).rejects.toThrow();
    spy.mockRestore();
    expect(a.send).not.toHaveBeenCalled();
    expect(await used(f)).toBe(0);
  });

  it.each([
    "recipient",
    "validation",
    "configuration",
    "self_payment",
  ] as const)(
    "first explicit %s rejection creates no unknown payment and releases the merchant",
    async (reason) => {
      const f = await fixture(false);
      const a = adapter({ kind: "not_found" }, { kind: "rejected", reason });
      await cycle(f, a);
      const row = await task(f);
      expect(row.status).toBe("attention");
      expect(row.unknownOutcome).toBe(false);
      expect(row.sendBlockReason).toBe(reason);
      const merchant = await env.DB.prepare(
        "SELECT active_task_id FROM merchants WHERE id=?",
      )
        .bind(f.merchant.id)
        .first<{ active_task_id: string | null }>();
      expect(merchant?.active_task_id).toBeNull();
    },
  );

  it("later definitive rejection cannot erase a historical unknown or release protection", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter(
      { kind: "not_found" },
      { kind: "rejected", reason: "recipient" },
    );
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    const row = await task(f);
    expect(row.unknownOutcome).toBe(true);
    expect(row.status).toBe("reconciling");
    expect(row.sendBlockReason).toBe("recipient");
    now += 60_000;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("unknown send HTTP 400 remains protected, encrypts its safe diagnostic and stops further automatic sends", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter(
      { kind: "not_found" },
      {
        kind: "unknown",
        reason: "http",
        httpStatus: 400,
        upstreamMessage: "未知上游错误 [redacted]",
      },
    );
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    now += 60_000;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect((await task(f)).sendBlockReason).toBe("http");
    const attempt = await env.DB.prepare(
      "SELECT id,diagnostic_ciphertext FROM payment_attempts WHERE task_id=? AND operation='send'",
    )
      .bind(f.taskId)
      .first<{ id: string; diagnostic_ciphertext: string }>();
    expect(attempt?.diagnostic_ciphertext).not.toContain("未知上游错误");
    expect(
      await decryptString(
        attempt?.diagnostic_ciphertext ?? "",
        env,
        `payment-diagnostic:${f.taskId}:${attempt?.id}`,
      ),
    ).toBe("未知上游错误 [redacted]");
  });

  it("query failures do not inflate the independent send backoff", async () => {
    const f = await fixture();
    const a = adapter({ kind: "unknown", reason: "network" });
    for (let i = 0; i < 4; i++) {
      await makeQueryDue(f);
      await cycle(f, a);
    }
    const row = await task(f);
    expect(row.queryBackoffCount).toBe(4);
    expect(row.sendBackoffCount).toBe(0);
    expect((row.nextQueryAt ?? 0) - now).toBeGreaterThanOrEqual(24_000);
    expect((row.nextQueryAt ?? 0) - now).toBeLessThanOrEqual(36_000);
    await grant(f);
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    expect((await task(f)).sendBackoffCount).toBe(1);
    expect(((await task(f)).nextSendAt ?? 0) - now).toBeGreaterThanOrEqual(
      8_000,
    );
    expect(((await task(f)).nextSendAt ?? 0) - now).toBeLessThanOrEqual(12_000);
  });

  it("query intent persists its backoff across interruption and respects the saved due time", async () => {
    const f = await fixture();
    await env.DB.prepare(
      "UPDATE payment_tasks SET query_backoff_count=5 WHERE id=?",
    )
      .bind(f.taskId)
      .run();
    const a = adapter({ kind: "unknown", reason: "network" });
    const original = env.DB.batch.bind(env.DB);
    let calls = 0;
    const fault = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (++calls === 2) throw new Error("lost query result");
        return original(statements);
      });
    await expect(cycle(f, a)).rejects.toThrow("lost query result");
    fault.mockRestore();
    const saved = await task(f);
    expect(saved.queryBackoffCount).toBe(6);
    expect((saved.nextQueryAt ?? 0) - now).toBeGreaterThanOrEqual(240_000);
    now += 31_000;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect((await task(f)).nextQueryAt).toBe(saved.nextQueryAt);
    now = (saved.nextQueryAt ?? now) + 1;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledTimes(2);
    expect((await task(f)).queryBackoffCount).toBe(7);
  });

  it("a temporary 5xx query Retry-After delays both recovery sends and natural query wake-ups", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    vi.mocked(a.query).mockResolvedValueOnce({
      kind: "unknown",
      reason: "http",
      httpStatus: 503,
      retryAfterMs: 60_000,
    });
    await cycle(f, a);
    const due = now + 60_000;
    expect((await task(f)).queryRetryAfterAt).toBe(due);
    expect((await task(f)).nextSendAt).toBeGreaterThanOrEqual(due);
    now += 31_000;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect(a.send).not.toHaveBeenCalled();
    expect(await used(f)).toBe(0);
    now = due + 1;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    now = Math.max(now, (await task(f)).nextQueryAt ?? 0) + 1;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledTimes(2);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("a temporary 5xx send Retry-After remains authoritative during natural reconciliation", async () => {
    const f = await fixture(false);
    const a = adapter(
      { kind: "not_found" },
      {
        kind: "unknown",
        reason: "http",
        httpStatus: 503,
        retryAfterMs: 60_000,
      },
    );
    await cycle(f, a);
    const due = now + 60_000;
    expect((await task(f)).queryRetryAfterAt).toBe(due);
    expect((await task(f)).nextSendAt).toBeGreaterThanOrEqual(due);
    expect((await task(f)).unknownOutcome).toBe(true);
    now += 31_000;
    await cycle(f, a);
    expect(a.query).not.toHaveBeenCalled();
    now = due + 1;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("after 24 hours query-only reconciliation drops to a 30-minute interval", async () => {
    const f = await fixture();
    now += 86_400_000;
    const a = adapter({ kind: "unknown", reason: "network" });
    await cycle(f, a);
    expect((await task(f)).nextQueryAt).toBe(now + 1_800_000);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("funds waiting never shortens a later exponential send backoff", async () => {
    const f = await fixture();
    await env.DB.prepare(
      "UPDATE payment_tasks SET send_backoff_count=4 WHERE id=?",
    )
      .bind(f.taskId)
      .run();
    await grant(f);
    const a = adapter(
      { kind: "not_found" },
      { kind: "waiting", reason: "funds" },
    );
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    expect(((await task(f)).nextSendAt ?? 0) - now).toBeGreaterThanOrEqual(
      720_000,
    );
    expect((await task(f)).sendBlockReason).toBe("funds");
    expect((await task(f)).unknownOutcome).toBe(true);
  });

  it.each(["funds", "quota", "credentials"] as const)(
    "first explicit %s rejection retains a business wait without inventing an unknown payment",
    async (reason) => {
      const f = await fixture(false);
      const a = adapter({ kind: "not_found" }, { kind: "waiting", reason });
      await cycle(f, a);
      expect((await task(f)).unknownOutcome).toBe(false);
      expect((await task(f)).status).toBe("waiting");
      const merchant = await env.DB.prepare(
        "SELECT active_task_id FROM merchants WHERE id=?",
      )
        .bind(f.merchant.id)
        .first<{ active_task_id: string | null }>();
      expect(merchant?.active_task_id).toBe(f.taskId);
    },
  );

  it("a changed task version during a live send rolls back the entire outcome batch and retains its lease for reconciliation", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter(confirmed(f));
    vi.mocked(a.query).mockResolvedValueOnce({ kind: "not_found" });
    await cycle(f, a);
    now += 20_000;
    vi.mocked(a.send).mockImplementation(async () => {
      await env.DB.prepare(
        "UPDATE payment_tasks SET recovery_version=recovery_version+1 WHERE id=?",
      )
        .bind(f.taskId)
        .run();
      return {
        kind: "sent",
        evidence: {
          source: "send",
          businessNo: f.businessNo,
          externalOrderId: "TRADE-ORIGINAL",
        },
      };
    });
    await expect(cycle(f, a)).rejects.toThrow();
    const merchant = await env.DB.prepare(
      "SELECT lease_token,active_task_id FROM merchants WHERE id=?",
    )
      .bind(f.merchant.id)
      .first<{ lease_token: string | null; active_task_id: string | null }>();
    expect(merchant?.lease_token).not.toBeNull();
    expect(merchant?.active_task_id).toBe(f.taskId);
    const attempt = await env.DB.prepare(
      "SELECT outcome FROM payment_attempts WHERE task_id=? AND operation='send'",
    )
      .bind(f.taskId)
      .first<{ outcome: string }>();
    expect(attempt?.outcome).toBe("started");
    expect(await used(f)).toBe(1);
    now += 31_000;
    await cycle(f, a);
    expect((await task(f)).status).toBe("confirmed");
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("concurrent natural cycles respect independent send due and upstream query Retry-After", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter({
      kind: "throttled",
      reason: "throttled",
      retryAfterMs: 60_000,
    });
    await cycle(f, a);
    const before = await task(f);
    const early = await Promise.all([cycle(f, a), cycle(f, a)]);
    expect(early.every((result) => !result.processed)).toBe(true);
    const current = await task(f);
    expect(current.nextSendAt).toBe(before.nextSendAt);
    expect(current.nextQueryAt).toBe(now + 60_000);
    now += 31_000;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect(a.send).not.toHaveBeenCalled();
    now = (before.queryRetryAfterAt ?? now) + 1;
    const due = await Promise.all([cycle(f, a), cycle(f, a)]);
    expect(due.filter((result) => result.processed)).toHaveLength(1);
    expect(a.query).toHaveBeenCalledTimes(2);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("an unverified credential rotation preserves both backoffs and cannot unblock a send", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter(
      { kind: "not_found" },
      { kind: "waiting", reason: "credentials" },
    );
    await cycle(f, a);
    now += 20_000;
    await cycle(f, a);
    const before = await task(f);
    const rotated = await updateMerchant(f.bindings, f.merchant.id, f.owner, {
      confirmationToken: (await readMerchantImpact(f.bindings, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: f.merchant.label,
      secret: "new-test-secret",
    });
    const after = await task(f);
    expect(after.nextSendAt).toBe(before.nextSendAt);
    expect(after.nextQueryAt).toBe(before.nextQueryAt);
    await makeQueryDue(f);
    await cycle(f, a);
    expect((await task(f)).sendBlockReason).toBe("credentials");
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='passed' WHERE merchant_id=? AND version=?",
    )
      .bind(f.merchant.id, rotated.credentialVersion)
      .run();
    await makeQueryDue(f);
    await cycle(f, a);
    expect((await task(f)).nextAction).toBe("send");
    expect((await task(f)).unknownOutcome).toBe(true);
  });

  it("a ready retry adopts query-only protection while rotated credentials remain unverified", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    expect((await task(f)).nextAction).toBe("send");
    await updateMerchant(f.bindings, f.merchant.id, f.owner, {
      confirmationToken: (await readMerchantImpact(f.bindings, f.merchant))
        .confirmationToken,
      version: f.merchant.version,
      label: f.merchant.label,
      secret: "new-unverified-test-secret",
    });
    now += 20_000;
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.query).toHaveBeenCalledTimes(2);
    expect(a.query).toHaveBeenLastCalledWith(expect.anything(), {
      clientId: f.merchant.clientId,
      credentialVersion: 1,
      clientSecret: "test-only-secret",
    });
    expect((await task(f)).nextAction).toBe("query");
    expect(await used(f)).toBe(0);
  });
});

describe("audited recipient username case correction", () => {
  it("preserves original identity, budget and expiry, queries first, and sends only the effective username", async () => {
    const f = await correctableFixture();
    const original = await task(f);
    const firstConsumed = await consumed(f);
    const oldGrant = await createDb(env.DB)
      .select()
      .from(paymentRetryGrants)
      .where(eq(paymentRetryGrants.taskId, f.taskId))
      .get();
    const correction = await correctUsername(f);
    const corrected = await task(f);
    expect(corrected.recipientUsername).toBe("tester7369");
    expect(corrected.unknownOutcome).toBe(true);
    expect(corrected.attemptCount).toBe(original.attemptCount);
    expect(corrected.sendBackoffCount).toBe(original.sendBackoffCount);
    expect(corrected.recoveryVersion).toBe(original.recoveryVersion + 1);
    expect(corrected.queriedRecoveryVersion).toBeNull();
    expect((await realSendDecision(f.bindings, corrected)).allowed).toBe(false);
    expect(
      await createDb(env.DB)
        .select()
        .from(paymentRetryGrants)
        .where(eq(paymentRetryGrants.taskId, f.taskId))
        .get(),
    ).toEqual(oldGrant);
    expect(await consumed(f)).toBe(firstConsumed);
    const effective = await effectivePaymentTask(f.bindings, corrected);
    expect(effective).toEqual({
      ...corrected,
      recipientUsername: "Tester7369",
    });
    const a = adapter(confirmed(f), {
      kind: "sent",
      evidence: {
        source: "send",
        businessNo: f.businessNo,
        externalOrderId: "TRADE-ORIGINAL",
      },
    });
    vi.mocked(a.query).mockResolvedValueOnce({ kind: "not_found" });
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect(vi.mocked(a.query).mock.calls[0]?.[0].recipientUsername).toBe(
      "tester7369",
    );
    expect(a.send).not.toHaveBeenCalled();
    now += 20_000;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    const sent = vi.mocked(a.send).mock.calls[0]?.[0];
    expect(sent?.recipientUsername).toBe("Tester7369");
    for (const key of [
      "id",
      "acceptanceId",
      "recipientId",
      "merchantId",
      "clientId",
      "businessNo",
      "amountMinor",
    ] as const)
      expect(sent?.[key]).toBe(original[key]);
    expect(await used(f)).toBe(2);
    const attempts = await env.DB.prepare(
      "SELECT recipient_username,parameter_digest FROM payment_attempts WHERE task_id=? AND operation='send' ORDER BY started_at,id",
    )
      .bind(f.taskId)
      .all<{ recipient_username: string; parameter_digest: string }>();
    expect(attempts.results).toEqual([
      {
        recipient_username: "tester7369",
        parameter_digest: correction.originalParameterDigest,
      },
      {
        recipient_username: "Tester7369",
        parameter_digest: correction.correctedParameterDigest,
      },
    ]);
    now = Math.max(now, (await task(f)).nextQueryAt ?? now) + 1;
    await cycle(f, a);
    expect((await task(f)).status).toBe("confirmed");
    expect((await task(f)).recipientUsername).toBe("tester7369");
    expect(await consumed(f)).toBe(firstConsumed);
  });

  it.each(["recipientId", "clientId", "businessNo", "amountMinor"] as const)(
    "an effective request cannot use a correction to change immutable %s",
    async (key) => {
      const f = await correctableFixture();
      const correction = await correctUsername(f);
      const row = await task(f);
      const changed = {
        ...row,
        [key]: key === "amountMinor" ? 11 : "different",
      };
      await expect(
        effectivePaymentTask(f.bindings, changed, correction),
      ).rejects.toThrow("Payment username correction identity mismatch");
    },
  );

  it("rejects unaudited parameter digests and different usernames", async () => {
    const f = await correctableFixture();
    const correction = await correctUsername(f);
    const row = await task(f);
    for (const invalid of [
      { ...correction, originalParameterDigest: "a".repeat(64) },
      { ...correction, correctedParameterDigest: "a".repeat(64) },
      { ...correction, correctedUsername: "another-recipient" },
      { ...correction, taskId: crypto.randomUUID() },
    ])
      await expect(
        effectivePaymentTask(f.bindings, row, invalid),
      ).rejects.toThrow("Payment username correction identity mismatch");
  });

  it("a correction arriving after send preparation rolls back permission consumption and requires another query", async () => {
    const f = await fixture();
    await grant(f);
    const a = adapter();
    await cycle(f, a);
    now += 20_000;
    const originalBatch = env.DB.batch.bind(env.DB);
    let inject = true;
    const race = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (inject) {
          inject = false;
          await env.DB.prepare(
            "UPDATE payment_tasks SET send_block_reason='recipient' WHERE id=?",
          )
            .bind(f.taskId)
            .run();
          await correctUsername(f);
        }
        return originalBatch(statements);
      });
    await cycle(f, a);
    race.mockRestore();
    expect(a.send).not.toHaveBeenCalled();
    expect(await used(f)).toBe(0);
    expect((await task(f)).attemptCount).toBe(1);
    expect((await task(f)).nextAction).toBe("query");
    expect((await task(f)).queriedRecoveryVersion).toBeNull();
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledTimes(2);
    now += 20_000;
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect(vi.mocked(a.send).mock.calls[0]?.[0].recipientUsername).toBe(
      "Tester7369",
    );
  });

  it.each(["expiry", "revocation", "exhaustion"] as const)(
    "a correction never resets authorization %s",
    async (boundary) => {
      const f = await correctableFixture();
      await correctUsername(f);
      if (boundary === "expiry") now += 86_400_000;
      else if (boundary === "revocation")
        await env.DB.prepare(
          "UPDATE payment_retry_grants SET revoked_at=? WHERE task_id=?",
        )
          .bind(now, f.taskId)
          .run();
      else
        for (let count = 1; count < 5; count++)
          await env.DB.prepare(
            "UPDATE payment_retry_grants SET used_additional_sends=used_additional_sends+1 WHERE task_id=?",
          )
            .bind(f.taskId)
            .run();
      const a = adapter();
      await cycle(f, a);
      now += 20_000;
      await cycle(f, a);
      expect(a.send).not.toHaveBeenCalled();
      expect((await task(f)).unknownOutcome).toBe(true);
    },
  );

  it("binds the separate duplicate probe to the corrected request without rewriting original payment evidence", async () => {
    const f = await correctableFixture();
    const correction = await correctUsername(f);
    const recovery = adapter(confirmed(f), {
      kind: "sent",
      evidence: {
        source: "send",
        businessNo: f.businessNo,
        externalOrderId: "TRADE-ORIGINAL",
      },
    });
    vi.mocked(recovery.query).mockResolvedValueOnce({ kind: "not_found" });
    await cycle(f, recovery);
    now += 20_000;
    await cycle(f, recovery);
    now = Math.max(now, (await task(f)).nextQueryAt ?? now) + 1;
    await cycle(f, recovery);
    const original = await task(f);
    await createDb(env.DB).insert(paymentDuplicateProbes).values({
      taskId: f.taskId,
      baselineExternalOrderId: "TRADE-ORIGINAL",
      parameterDigest: correction.correctedParameterDigest,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const a = adapter(confirmed(f), {
      kind: "duplicate",
      reason: "duplicate_order",
    });
    await cycle(f, a);
    expect(vi.mocked(a.send).mock.calls[0]?.[0].recipientUsername).toBe(
      "Tester7369",
    );
    now += 5_000;
    await cycle(f, a);
    expect((await probe(f)).protocolVerifiedAt).not.toBeNull();
    expect((await probe(f)).backendVerifiedAt).toBeNull();
    expect((await task(f)).confirmedAt).toBe(original.confirmedAt);
    expect((await task(f)).externalOrderId).toBe(original.externalOrderId);
    expect((await task(f)).attemptCount).toBe(original.attemptCount);
    expect(await used(f)).toBe(2);
    const attempt = await env.DB.prepare(
      "SELECT recipient_username,parameter_digest FROM payment_attempts WHERE task_id=? AND purpose='probe' AND operation='send'",
    )
      .bind(f.taskId)
      .first<{ recipient_username: string; parameter_digest: string }>();
    expect(attempt).toEqual({
      recipient_username: "Tester7369",
      parameter_digest: correction.correctedParameterDigest,
    });
  });

  it("an old order found by the first corrected query does not authorize a probe with the new username", async () => {
    const f = await correctableFixture();
    const correction = await correctUsername(f);
    const a = adapter(confirmed(f));
    await cycle(f, a);
    expect((await task(f)).status).toBe("confirmed");
    expect((await task(f)).sendAcknowledgedAt).toBeNull();
    expect(a.send).not.toHaveBeenCalled();
    await createDb(env.DB).insert(paymentDuplicateProbes).values({
      taskId: f.taskId,
      baselineExternalOrderId: "TRADE-ORIGINAL",
      parameterDigest: correction.correctedParameterDigest,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await cycle(f, a);
    now += 31_000;
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.query).toHaveBeenCalledOnce();
    expect((await probe(f)).permitConsumedAt).toBeNull();
    expect((await task(f)).status).toBe("confirmed");
    expect(await used(f)).toBe(1);
  });
});

async function probeFixture() {
  const f = await fixture();
  const a = adapter(confirmed(f));
  await cycle(f, a);
  await grant(f);
  const row = await task(f);
  await createDb(env.DB)
    .insert(paymentDuplicateProbes)
    .values({
      taskId: f.taskId,
      baselineExternalOrderId: "TRADE-ORIGINAL",
      parameterDigest: await paymentParameterDigest(row),
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    });
  return f;
}
async function probe(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(paymentDuplicateProbes)
    .where(eq(paymentDuplicateProbes.taskId, f.taskId))
    .get();
  if (!row) throw new Error("Probe missing");
  return row;
}

async function attest(f: Fixture) {
  await env.DB.prepare(
    "UPDATE payment_duplicate_probes SET backend_verified_at=?,backend_evidence_digest=?,status='passed',updated_at=? WHERE task_id=?",
  )
    .bind(now, "a".repeat(64), now, f.taskId)
    .run();
}

describe("one-shot duplicate probe after confirmed payment", () => {
  it.each(["expiry", "revocation"] as const)(
    "an unused probe cannot bypass grant %s",
    async (boundary) => {
      const f = await probeFixture();
      if (boundary === "expiry") now += 86_400_000;
      else
        await env.DB.prepare(
          "UPDATE payment_retry_grants SET revoked_at=? WHERE task_id=?",
        )
          .bind(now, f.taskId)
          .run();
      const a = adapter(confirmed(f), {
        kind: "duplicate",
        reason: "duplicate_order",
      });
      await cycle(f, a);
      expect(a.send).not.toHaveBeenCalled();
      expect((await probe(f)).permitConsumedAt).toBeNull();
      expect((await task(f)).status).toBe("confirmed");
    },
  );
  it("consumes its separate permit once, verifies protocol and order evidence, and never mutates confirmed payment", async () => {
    const f = await probeFixture();
    const original = await task(f);
    const a = adapter(confirmed(f), {
      kind: "duplicate",
      reason: "duplicate_order",
      httpStatus: 400,
    });
    await Promise.all(Array.from({ length: 4 }, () => cycle(f, a)));
    expect(a.send).toHaveBeenCalledOnce();
    expect((await probe(f)).permitConsumedAt).not.toBeNull();
    expect((await probe(f)).protocolVerifiedAt).toBeNull();
    now += 5_000;
    await cycle(f, a);
    expect((await probe(f)).status).toBe("awaiting_evidence");
    expect((await probe(f)).protocolVerifiedAt).not.toBeNull();
    expect((await probe(f)).backendVerifiedAt).toBeNull();
    await attest(f);
    await cycle(f, a);
    expect((await probe(f)).status).toBe("passed");
    expect(a.send).toHaveBeenCalledOnce();
    const current = await task(f);
    expect(current.status).toBe("confirmed");
    expect(current.confirmedAt).toBe(original.confirmedAt);
    expect(current.externalOrderId).toBe(original.externalOrderId);
    expect(current.attemptCount).toBe(original.attemptCount);
    expect(await used(f)).toBe(0);
    const rows = await env.DB.prepare(
      "SELECT operation FROM payment_attempts WHERE task_id=? AND purpose='probe'",
    )
      .bind(f.taskId)
      .all<{ operation: string }>();
    expect(rows.results.map((r) => r.operation).sort()).toEqual([
      "query",
      "send",
    ]);
  });

  it("same-order success is accepted only when an independent query matches the original transaction", async () => {
    const f = await probeFixture();
    const a = adapter(confirmed(f), {
      kind: "sent",
      evidence: {
        source: "send",
        businessNo: f.businessNo,
        externalOrderId: "TRADE-ORIGINAL",
      },
    });
    await cycle(f, a);
    expect((await probe(f)).status).toBe("reconciling");
    now += 5_000;
    await cycle(f, a);
    expect((await probe(f)).status).toBe("awaiting_evidence");
    expect((await probe(f)).protocolVerifiedAt).not.toBeNull();
    expect((await probe(f)).backendVerifiedAt).toBeNull();
  });

  it("a timeout or generic 400 cannot prove protocol idempotency even when the old order remains successful", async () => {
    const f = await probeFixture();
    const a = adapter(confirmed(f), {
      kind: "unknown",
      reason: "http",
      httpStatus: 400,
    });
    await cycle(f, a);
    now += 5_000;
    await cycle(f, a);
    expect((await probe(f)).status).toBe("awaiting_evidence");
    expect((await probe(f)).backendVerifiedAt).toBeNull();
    expect((await probe(f)).protocolVerifiedAt).toBeNull();
    now += 10 * 60_000;
    await cycle(f, a);
    expect((await probe(f)).status).toBe("inconclusive");
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect((await task(f)).status).toBe("confirmed");
  });

  it("a different transaction records a probe conflict without rewriting the original confirmed order", async () => {
    const f = await probeFixture();
    const a = adapter(confirmed(f), {
      kind: "sent",
      evidence: {
        source: "send",
        businessNo: f.businessNo,
        externalOrderId: "TRADE-NEW",
      },
    });
    await cycle(f, a);
    expect((await probe(f)).status).toBe("conflict");
    expect((await task(f)).externalOrderId).toBe("TRADE-ORIGINAL");
    expect((await task(f)).status).toBe("confirmed");
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("a process interruption after probe intent consumes no second send and recovers by query", async () => {
    const f = await probeFixture();
    const a = adapter(confirmed(f), {
      kind: "duplicate",
      reason: "duplicate_order",
    });
    const originalBatch = env.DB.batch.bind(env.DB);
    let calls = 0;
    const fault = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (++calls === 2) throw new Error("lost probe outcome");
        return originalBatch(statements);
      });
    await expect(cycle(f, a)).rejects.toThrow("lost probe outcome");
    fault.mockRestore();
    await env.DB.prepare("UPDATE merchants SET lease_until=0 WHERE id=?")
      .bind(f.merchant.id)
      .run();
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect(a.query).toHaveBeenCalledOnce();
    expect((await probe(f)).status).toBe("awaiting_evidence");
    expect((await task(f)).status).toBe("confirmed");
  });

  it("natural cycles never shorten a probe query Retry-After", async () => {
    const f = await probeFixture();
    const a = adapter(
      { kind: "throttled", reason: "throttled", retryAfterMs: 60_000 },
      { kind: "duplicate", reason: "duplicate_order" },
    );
    await cycle(f, a);
    now += 5_000;
    await cycle(f, a);
    expect((await probe(f)).nextRunAt).toBe(now + 60_000);
    now += 20_000;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
  });

  it.each(["send", "query"] as const)(
    "a temporary 5xx probe %s Retry-After remains authoritative during natural cycles",
    async (operation) => {
      const f = await probeFixture();
      const unavailable: AdapterResult = {
        kind: "unknown",
        reason: "http",
        httpStatus: 503,
        retryAfterMs: 60_000,
      };
      const a = adapter(
        confirmed(f),
        operation === "send"
          ? unavailable
          : { kind: "duplicate", reason: "duplicate_order" },
      );
      await cycle(f, a);
      if (operation === "query") {
        vi.mocked(a.query).mockResolvedValueOnce(unavailable);
        now += 5_000;
        await cycle(f, a);
      }
      const queryCount = vi.mocked(a.query).mock.calls.length;
      const due = now + 60_000;
      expect((await task(f)).queryRetryAfterAt).toBe(due);
      expect((await probe(f)).nextRunAt).toBe(due);
      now += 31_000;
      await cycle(f, a);
      expect(a.query).toHaveBeenCalledTimes(queryCount);
      now = due + 1;
      await cycle(f, a);
      expect(a.query).toHaveBeenCalledTimes(queryCount + 1);
      expect(a.send).toHaveBeenCalledOnce();
      expect((await task(f)).status).toBe("confirmed");
    },
  );

  it("a probe whose Retry-After outlives its verification window closes without an early HTTP query", async () => {
    const f = await probeFixture();
    const a = adapter(confirmed(f), {
      kind: "unknown",
      reason: "http",
      httpStatus: 503,
      retryAfterMs: 3_600_000,
    });
    await cycle(f, a);
    now += 10 * 60_000;
    await cycle(f, a);
    expect((await probe(f)).status).toBe("inconclusive");
    expect(a.query).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledOnce();
    expect((await task(f)).status).toBe("confirmed");
  });

  it("delivered Outbox, duplicate Queue, Cron, Alarm and DO eviction continue confirmed-task probes without a second send", async () => {
    const f = await probeFixture();
    await env.DB.prepare(
      "INSERT INTO payment_outbox(id,task_id,created_at,delivered_at) VALUES(?,?,?,1)",
    )
      .bind(crypto.randomUUID(), f.taskId, now)
      .run();
    const stub = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName(f.merchant.clientId),
    );
    stubs.push(stub);
    async function configure() {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: ApiBindings }).env = f.bindings;
      });
    }
    let sends = 0;
    let queries = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/lpay/distribute") {
        sends++;
        return Response.json({
          error_msg: "",
          data: { out_trade_no: f.businessNo, trade_no: "TRADE-ORIGINAL" },
        });
      }
      if (url.pathname === "/epay/api.php") {
        queries++;
        return Response.json({
          code: 1,
          status: 1,
          pid: f.merchant.clientId,
          out_trade_no: f.businessNo,
          trade_no: "TRADE-ORIGINAL",
          money: "0.10",
        });
      }
      throw new Error("Unexpected mock endpoint");
    });
    await configure();
    expect(await sweepPayments(f.bindings)).toBeGreaterThan(0);
    expect(sends).toBe(1);
    const batch = createMessageBatch(
      "hb-local-tasks",
      [1, 2].map((id) => ({
        id: `probe-${id}`,
        timestamp: new Date(),
        attempts: 1,
        body: { type: "payment.wake", taskId: f.taskId },
      })),
    );
    await worker.queue(batch, f.bindings);
    expect(
      (await getQueueResult(batch, createExecutionContext())).explicitAcks,
    ).toHaveLength(2);
    expect(sends).toBe(1);
    await evictDurableObject(stub);
    await configure();
    now += 5_000;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(queries).toBeGreaterThan(0);
    expect((await probe(f)).status).toBe("awaiting_evidence");
    expect((await probe(f)).protocolVerifiedAt).not.toBeNull();
    await attest(f);
    await wakePayment(f.bindings, f.taskId);
    expect(sends).toBe(1);
  });
});
