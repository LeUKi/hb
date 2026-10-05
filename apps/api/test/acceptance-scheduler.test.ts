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
import { paymentTasks, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import worker from "../src/index";
import type { PaymentAdapter } from "../src/payments/adapter";
import { createMerchant, updateMerchant } from "../src/payments/merchants";
import { runtimeRealPolicy } from "../src/payments/policy";
import { createRealPaymentAdapter } from "../src/payments/real-protocol";
import { runMerchantCycle, sweepPayments } from "../src/payments/scheduler";

const merchantStubs: ReturnType<typeof env.MERCHANT_DO.get>[] = [];

async function user() {
  const id = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    id,
    externalId: id,
    username: id,
    displayName: "test",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function acceptanceFixture() {
  const owner = await user();
  const now = Date.now();
  const merchant = await createMerchant(env, owner, {
    requestId: crypto.randomUUID(),
    clientId: `real_${crypto.randomUUID()}`,
    label: "真实验收商户",
    secret: "secret-value",
    mode: "real",
  });
  await env.DB.prepare(
    `UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=1`,
  )
    .bind(now, merchant.id)
    .run();
  const acceptanceId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const businessNo = `hb_${acceptanceId.replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payment_acceptances
        (id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,created_at)
        VALUES (?,?,?,?,?,?,10,?)`,
    ).bind(
      acceptanceId,
      merchant.id,
      merchant.clientId,
      businessNo,
      "100001",
      "tester7369",
      now,
    ),
    env.DB.prepare(
      `INSERT INTO payment_tasks
        (id,claim_id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,next_run_at,created_at,updated_at)
        SELECT ?,NULL,'acceptance',id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,'real','pending',0,?,? FROM payment_acceptances WHERE id=?`,
    ).bind(taskId, now, now, acceptanceId),
  ]);
  return { owner, merchant, acceptanceId, taskId, businessNo };
}

async function task(id: string) {
  const result = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, id))
    .get();
  if (!result) throw new Error("No task");
  return result;
}

async function acceptance(id: string) {
  const row = await env.DB.prepare(
    "SELECT send_consumed_at FROM payment_acceptances WHERE id=?",
  )
    .bind(id)
    .first<{ send_consumed_at: number | null }>();
  if (!row) throw new Error("No acceptance");
  return row;
}

function runtime(acceptanceId: string): ApiBindings {
  return {
    ...env,
    APP_ENV: "local",
    LDC_NETWORK_MODE: "acceptance",
    LDC_ACCEPTANCE_ID: acceptanceId,
  } as ApiBindings;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const stub of merchantStubs.splice(0)) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  vi.restoreAllMocks();
});

async function due(taskId: string) {
  await env.DB.prepare(
    "UPDATE payment_tasks SET next_run_at=0,next_query_at=0 WHERE id=?",
  )
    .bind(taskId)
    .run();
}

function protectedAdapter(): PaymentAdapter {
  return {
    mode: "real",
    send: vi.fn(async () => ({ kind: "unknown", reason: "timeout" }) as const),
    query: vi.fn(
      async () =>
        ({ kind: "not_found", reason: "checking_not_found" }) as const,
    ),
  };
}

describe("real LDC acceptance scheduler gate", () => {
  it("does not consume acceptance or send without exact runtime authorization", async () => {
    const f = await acceptanceFixture();
    const adapter: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
      query: vi.fn(
        async () => ({ kind: "unknown", reason: "unknown" }) as const,
      ),
    };
    await expect(
      runMerchantCycle(env, f.merchant.id, { adapterFactory: () => adapter }),
    ).rejects.toThrow("REAL_LDC_NOT_ENABLED");
    expect(adapter.send).not.toHaveBeenCalled();
    expect((await acceptance(f.acceptanceId)).send_consumed_at).toBeNull();
    expect((await task(f.taskId)).attemptCount).toBe(0);
  });

  it("consumes the authorized acceptance before one real send and confirms only by query", async () => {
    const f = await acceptanceFixture();
    const adapter: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async () =>
          ({
            kind: "sent",
            evidence: {
              source: "send",
              businessNo: f.businessNo,
              externalOrderId: "TRADE-1",
            },
          }) as const,
      ),
      query: vi.fn(
        async () =>
          ({
            kind: "confirmed",
            evidence: {
              source: "query",
              clientId: f.merchant.clientId,
              businessNo: f.businessNo,
              amountMinor: 10,
              externalOrderId: "TRADE-1",
              status: 1,
            },
          }) as const,
      ),
    };

    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    const afterSend = await task(f.taskId);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).not.toHaveBeenCalled();
    expect(afterSend.status).toBe("reconciling");
    expect(afterSend.externalOrderId).toBe("TRADE-1");
    expect(afterSend.sendAcknowledgedAt).not.toBeNull();
    expect(afterSend.attemptCount).toBe(1);
    expect((await acceptance(f.acceptanceId)).send_consumed_at).not.toBeNull();

    await due(f.taskId);
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    const confirmed = await task(f.taskId);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).toHaveBeenCalledOnce();
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it.each([undefined, "production", "staging", "invalid"])(
    "requires an explicit local environment for send and query, received %s",
    async (appEnv) => {
      const f = await acceptanceFixture();
      const adapter = protectedAdapter();
      const bindings = {
        ...runtime(f.acceptanceId),
        APP_ENV: appEnv,
      } as ApiBindings;
      expect(runtimeRealPolicy(bindings).appEnv).not.toBe("local");
      await expect(
        runMerchantCycle(bindings, f.merchant.id, {
          adapterFactory: () => adapter,
        }),
      ).rejects.toThrow("REAL_LDC_NOT_ENABLED");
      expect(adapter.send).not.toHaveBeenCalled();
      expect((await acceptance(f.acceptanceId)).send_consumed_at).toBeNull();
      await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
        adapterFactory: () => adapter,
      });
      await due(f.taskId);
      await expect(
        runMerchantCycle(
          { ...bindings, LDC_NETWORK_MODE: "verify" },
          f.merchant.id,
          { adapterFactory: () => adapter },
        ),
      ).rejects.toThrow("REAL_LDC_NOT_ENABLED");
      expect(adapter.send).toHaveBeenCalledOnce();
      expect(adapter.query).not.toHaveBeenCalled();
    },
  );

  it("leaves the sole send permit intact until the pinned credential version passed verification", async () => {
    const f = await acceptanceFixture();
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='unverified' WHERE merchant_id=?",
    )
      .bind(f.merchant.id)
      .run();
    const adapter = protectedAdapter();
    await expect(
      runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
        adapterFactory: () => adapter,
      }),
    ).rejects.toThrow("REAL_LDC_CREDENTIALS_NOT_VERIFIED");
    expect(adapter.send).not.toHaveBeenCalled();
    expect((await acceptance(f.acceptanceId)).send_consumed_at).toBeNull();
    expect((await task(f.taskId)).attemptCount).toBe(0);
  });

  it("atomically rolls back send permission, task and merchant lease if attempt persistence fails", async () => {
    const f = await acceptanceFixture();
    const adapter = protectedAdapter();
    await env.DB.prepare(
      `CREATE TRIGGER fail_acceptance_attempt BEFORE INSERT ON payment_attempts WHEN NEW.task_id='${f.taskId}' BEGIN SELECT RAISE(ABORT, 'injected attempt failure'); END`,
    ).run();
    try {
      await expect(
        runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
          adapterFactory: () => adapter,
        }),
      ).rejects.toThrow("injected attempt failure");
      expect((await acceptance(f.acceptanceId)).send_consumed_at).toBeNull();
      expect((await task(f.taskId)).status).toBe("pending");
      expect((await task(f.taskId)).attemptCount).toBe(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT lease_token,active_task_id FROM merchants WHERE id=?",
          )
            .bind(f.merchant.id)
            .first<{
              lease_token: string | null;
              active_task_id: string | null;
            }>()
        )?.lease_token,
      ).toBeNull();
      expect(adapter.send).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_acceptance_attempt").run();
    }
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("same-millisecond concurrent cycles consume one permit and issue one send", async () => {
    const f = await acceptanceFixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const adapter = protectedAdapter();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
          adapterFactory: () => adapter,
        }),
      ),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect((await task(f.taskId)).attemptCount).toBe(1);
    expect((await acceptance(f.acceptanceId)).send_consumed_at).not.toBeNull();
  });

  it("real rejection, response loss and repeated missing queries never release unknown protection or resend", async () => {
    const f = await acceptanceFixture();
    const adapter = protectedAdapter();
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect((await task(f.taskId)).status).toBe("reconciling");
    for (let i = 0; i < 3; i++) {
      await due(f.taskId);
      await runMerchantCycle(
        { ...runtime(f.acceptanceId), LDC_NETWORK_MODE: "verify" },
        f.merchant.id,
        { adapterFactory: () => adapter },
      );
    }
    const current = await task(f.taskId);
    expect(current.unknownOutcome).toBe(true);
    expect(current.status).toBe("reconciling");
    expect(current.businessNo).toBe(f.businessNo);
    expect(current.amountMinor).toBe(10);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).toHaveBeenCalledTimes(3);
    const merchant = await env.DB.prepare(
      "SELECT active_task_id FROM merchants WHERE id=?",
    )
      .bind(f.merchant.id)
      .first<{ active_task_id: string | null }>();
    expect(merchant?.active_task_id).toBe(f.taskId);
    await expect(
      env.DB.prepare(
        "UPDATE payment_acceptances SET send_consumed_at=NULL WHERE id=?",
      )
        .bind(f.acceptanceId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("DELETE FROM payment_acceptances WHERE id=?")
        .bind(f.acceptanceId)
        .run(),
    ).rejects.toThrow("cannot be deleted");
  });

  it("reconciles a process interruption after send intent instead of replaying the send", async () => {
    const f = await acceptanceFixture();
    const originalBatch = env.DB.batch.bind(env.DB);
    let batches = 0;
    const batch = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        batches++;
        if (batches === 2) throw new Error("injected lost result persistence");
        return originalBatch(statements);
      });
    const adapter = protectedAdapter();
    await expect(
      runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
        adapterFactory: () => adapter,
      }),
    ).rejects.toThrow("lost result persistence");
    batch.mockRestore();
    expect((await task(f.taskId)).status).toBe("sending");
    await env.DB.prepare("UPDATE merchants SET lease_until=0 WHERE id=?")
      .bind(f.merchant.id)
      .run();
    await due(f.taskId);
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).toHaveBeenCalledOnce();
    expect((await task(f.taskId)).status).toBe("reconciling");
    const interrupted = await env.DB.prepare(
      "SELECT outcome,reason FROM payment_attempts WHERE task_id=? AND operation='send'",
    )
      .bind(f.taskId)
      .first<{ outcome: string; reason: string }>();
    expect(interrupted).toEqual({ outcome: "unknown", reason: "interrupted" });
  });

  it("pins each attempt and only adopts a verified rotated version while retaining immutable payment identity", async () => {
    const f = await acceptanceFixture();
    const adapter = protectedAdapter();
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    const rotated = await updateMerchant(env, f.merchant.id, f.owner, {
      version: f.merchant.version,
      label: f.merchant.label,
      secret: "rotated-secret",
    });
    await due(f.taskId);
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(adapter.query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        businessNo: f.businessNo,
        recipientId: "100001",
        recipientUsername: "tester7369",
        amountMinor: 10,
      }),
      { credentialVersion: 1, clientSecret: "secret-value" },
    );
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='passed' WHERE merchant_id=? AND version=?",
    )
      .bind(f.merchant.id, rotated.credentialVersion)
      .run();
    await due(f.taskId);
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    expect(adapter.query).toHaveBeenLastCalledWith(expect.anything(), {
      credentialVersion: 2,
      clientSecret: "rotated-secret",
    });
    expect(adapter.send).toHaveBeenCalledOnce();
    const versions = await env.DB.prepare(
      "SELECT credential_version FROM payment_attempts WHERE task_id=? ORDER BY started_at,id",
    )
      .bind(f.taskId)
      .all<{ credential_version: number }>();
    expect(versions.results.map((r) => r.credential_version).sort()).toEqual([
      1, 1, 2,
    ]);
  });

  it("does not confirm a real send without independent query evidence and protects receipt conflicts", async () => {
    const f = await acceptanceFixture();
    const adapter: PaymentAdapter = {
      ...protectedAdapter(),
      send: vi.fn(
        async () =>
          ({
            kind: "sent",
            evidence: {
              source: "send",
              businessNo: f.businessNo,
              externalOrderId: "TRADE-ORIGINAL",
            },
          }) as const,
      ),
      query: vi.fn(
        async () =>
          ({
            kind: "confirmed",
            evidence: {
              source: "query",
              businessNo: f.businessNo,
              clientId: f.merchant.clientId,
              amountMinor: 10,
              externalOrderId: "TRADE-OTHER",
              status: 1,
            },
          }) as const,
      ),
    };
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    await due(f.taskId);
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    const current = await task(f.taskId);
    expect(current.status).toBe("attention");
    expect(current.unknownOutcome).toBe(true);
    expect(current.externalOrderId).toBe("TRADE-ORIGINAL");
    expect(current.confirmedAt).toBeNull();
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("logs only predefined payment outcomes and safe HTTP metadata", async () => {
    const f = await acceptanceFixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter: PaymentAdapter = {
      ...protectedAdapter(),
      send: vi.fn(
        async () =>
          ({ kind: "unknown", reason: "network", httpStatus: 503 }) as const,
      ),
    };
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    const record = log.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((record) => record.event === "ldc_payment_attempt");
    expect(record).toMatchObject({
      taskId: f.taskId,
      merchantId: f.merchant.id,
      mode: "real",
      operation: "send",
      credentialVersion: 1,
      reason: "network",
      httpStatus: 503,
    });
    const serialized = JSON.stringify(log.mock.calls);
    for (const forbidden of [
      "secret-value",
      "key=",
      "Authorization",
      "epay/api.php",
      "out_trade_no",
      f.businessNo,
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("persists future HTTP 400 sends and 404 queries without preserving sensitive upstream responses", async () => {
    const f = await acceptanceFixture();
    const upstreamSecretMessage = "private-upstream-message-secret-value";
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/lpay/distribute")
        return Response.json(
          { error_msg: upstreamSecretMessage },
          { status: 400 },
        );
      return Response.json(
        { code: -1, msg: "订单不存在或已完成" },
        { status: 404 },
      );
    });
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: transport,
    });
    await runMerchantCycle(runtime(f.acceptanceId), f.merchant.id, {
      adapterFactory: () => adapter,
    });
    await due(f.taskId);
    await runMerchantCycle(
      { ...runtime(f.acceptanceId), LDC_NETWORK_MODE: "verify" },
      f.merchant.id,
      { adapterFactory: () => adapter },
    );
    const attempts = await env.DB.prepare(
      "SELECT operation,outcome,reason,http_status FROM payment_attempts WHERE task_id=? ORDER BY CASE operation WHEN 'send' THEN 0 ELSE 1 END",
    )
      .bind(f.taskId)
      .all<{
        operation: string;
        outcome: string;
        reason: string;
        http_status: number | null;
      }>();
    expect(attempts.results).toEqual([
      {
        operation: "send",
        outcome: "unknown",
        reason: "http",
        http_status: 400,
      },
      {
        operation: "query",
        outcome: "unknown",
        reason: "checking_not_found",
        http_status: 404,
      },
    ]);
    const complete = await env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE task_id=?",
    )
      .bind(f.taskId)
      .all();
    const serialized = JSON.stringify(complete.results);
    for (const forbidden of [
      upstreamSecretMessage,
      "secret-value",
      "key=",
      "Authorization",
      "epay/api.php",
    ])
      expect(serialized).not.toContain(forbidden);
    expect((await task(f.taskId)).attemptCount).toBe(1);
    expect((await task(f.taskId)).status).toBe("reconciling");
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
    expect(
      transport.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === "/lpay/distribute",
      ),
    ).toHaveLength(1);
  });

  it("Queue, Cron, Alarm and DO eviction preserve the one-send limit after Outbox delivery", async () => {
    const f = await acceptanceFixture();
    const bindings = runtime(f.acceptanceId);
    await env.DB.prepare(
      "INSERT INTO payment_outbox (id,task_id,delivered_at,created_at) VALUES (?,?,1,?)",
    )
      .bind(crypto.randomUUID(), f.taskId, Date.now())
      .run();
    const stub = env.MERCHANT_DO.get(
      env.MERCHANT_DO.idFromName(f.merchant.clientId),
    );
    merchantStubs.push(stub);
    async function applyRuntime() {
      await runInDurableObject(stub, (instance) => {
        // Configure the actual runtime gate while mocking only HTTP transport.
        (instance as unknown as { env: ApiBindings }).env = bindings;
      });
    }
    let sends = 0;
    let queries = 0;
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/lpay/distribute") {
          sends++;
          return Response.json({
            error_msg: "",
            data: { trade_no: "TRADE-DO", out_trade_no: f.businessNo },
          });
        }
        if (url.pathname === "/epay/api.php") {
          queries++;
          return Response.json(
            { code: -1, msg: "订单不存在或已完成" },
            { status: 404 },
          );
        }
        throw new Error("Unexpected mocked transport path");
      });
    await applyRuntime();
    vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    expect(await sweepPayments(bindings)).toBeGreaterThan(0);
    expect(sends).toBe(1);
    expect((await task(f.taskId)).status).toBe("reconciling");
    const batch = createMessageBatch(
      "hb-local-tasks",
      [1, 2, 3].map((n) => ({
        id: `acceptance-q${n}`,
        timestamp: new Date(),
        attempts: 1,
        body: { type: "payment.wake", taskId: f.taskId },
      })),
    );
    await worker.queue(batch, bindings);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toHaveLength(3);
    expect(sends).toBe(1);
    await evictDurableObject(stub);
    await applyRuntime();
    await due(f.taskId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await due(f.taskId);
    await sweepPayments({ ...bindings, LDC_NETWORK_MODE: "verify" });
    expect(sends).toBe(1);
    expect(queries).toBeGreaterThanOrEqual(2);
    expect((await task(f.taskId)).attemptCount).toBe(1);
    expect((await task(f.taskId)).unknownOutcome).toBe(true);
    expect(http).toHaveBeenCalled();
  });
});
