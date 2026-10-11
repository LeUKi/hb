import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client";
import {
  activities,
  activityPasswords,
  claims,
  merchantCredentials,
  merchants,
  paymentAttempts,
  paymentOutbox,
  paymentTasks,
  rewardInventory,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import type { AdapterResult, PaymentAdapter } from "../src/payments/adapter";
import {
  claimPaymentParameterDigest,
  realQueryDecision,
  realSendDecision,
} from "../src/payments/policy";
import { merchantPaymentDetail } from "../src/payments/queries";
import { requestMerchantCheck } from "../src/payments/recovery";
import {
  runMerchantCycle,
  sweepPayments,
  wakePayment,
} from "../src/payments/scheduler";
import { encryptString } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

let now: number;
beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  vi.restoreAllMocks();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "claims",
      "activity_passwords",
      "reward_inventory",
      "activities",
      "merchant_credentials",
      "merchants",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
afterEach(() => vi.restoreAllMocks());

async function setSending(enabled: boolean) {
  await env.DB.prepare(
    "UPDATE platform_controls SET version=version+1,allow_real_send=?,updated_at=? WHERE id='global'",
  )
    .bind(Number(enabled), now)
    .run();
}
async function fixture(
  options: {
    passed?: boolean;
    enabled?: boolean;
    history?: boolean;
    digest?: string;
  } = {},
) {
  const db = createDb(env.DB);
  const owner = crypto.randomUUID(),
    recipient = crypto.randomUUID();
  const recipientId = BigInt(
    `0x${recipient.replaceAll("-", "").slice(0, 16)}`,
  ).toString();
  const username = `Receiver_${recipient.slice(0, 8)}`;
  await db.insert(users).values(
    [owner, recipient].map((id) => ({
      officialConnectVerified: true,
      id,
      externalId: id === recipient ? recipientId : owner,
      username: id === recipient ? username : owner,
      displayName: "本地隔离用户",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
  );
  const merchantId = crypto.randomUUID(),
    clientId = `claim_${crypto.randomUUID()}`;
  await db.insert(merchants).values({
    id: merchantId,
    authorId: owner,
    clientId,
    mode: "real",
    label: "生产协议测试",
    requestId: crypto.randomUUID(),
    requestDigest: "test",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(merchantCredentials).values({
    id: crypto.randomUUID(),
    merchantId,
    version: 1,
    ciphertext: await encryptString(
      "isolated-test-secret",
      env,
      `merchant:${merchantId}:credential:1`,
    ),
    verificationStatus: options.passed === false ? "unverified" : "passed",
    verificationCheckedAt: now - 1,
    createdAt: now - 1,
  });
  const activityId = crypto.randomUUID(),
    inventoryId = crypto.randomUUID(),
    passwordId = crypto.randomUUID(),
    claimId = crypto.randomUUID();
  await db.insert(activities).values({
    id: activityId,
    authorId: owner,
    creationRequestId: crypto.randomUUID(),
    creationDigest: "test",
    title: "真实活动领取测试",
    merchantId,
    paymentMode: "real",
    rewardType: "ldc",
    forceDedicated: false,
    allocation: "sequential",
    config: "{}",
    totalCount: 2,
    claimedCount: 1,
    createdAt: now - 100,
    updatedAt: now - 1,
    openedAt: now - 50,
    deadline: now + 86_400_000,
  });
  await db.insert(activityPasswords).values({
    id: passwordId,
    activityId,
    digest: "test",
    ciphertext: "test-not-decrypted",
    position: 0,
    createdAt: now,
  });
  await db.insert(rewardInventory).values({
    id: inventoryId,
    activityId,
    position: 0,
    kind: "ldc",
    amountMinor: 10,
    createdAt: now,
  });
  await db.insert(claims).values({
    id: claimId,
    activityId,
    userId: recipient,
    inventoryId,
    passwordId,
    claimedAt: now,
  });
  const frozen = {
    id: crypto.randomUUID(),
    source: "claim" as const,
    claimId,
    acceptanceId: null,
    merchantId,
    clientId,
    businessNo: `hb_${claimId.replaceAll("-", "")}`,
    recipientId,
    recipientUsername: username,
    amountMinor: 10,
    mode: "real" as const,
    recoveryPolicy: "claim_same_order_v1" as const,
  };
  const digest = options.digest ?? (await claimPaymentParameterDigest(frozen));
  await db.insert(paymentTasks).values({
    ...frozen,
    parameterDigest: digest,
    status: "pending",
    nextRunAt: 0,
    createdAt: now - 10,
    updatedAt: now - 1,
  });
  await db
    .insert(paymentOutbox)
    .values({ id: crypto.randomUUID(), taskId: frozen.id, createdAt: now });
  if (options.history) {
    await env.DB.prepare(
      "UPDATE payment_tasks SET first_send_at=?,attempt_count=1,unknown_outcome=1,status='reconciling',next_action='query',next_query_at=0 WHERE id=?",
    )
      .bind(now - 5, frozen.id)
      .run();
    await db.insert(paymentAttempts).values({
      id: crypto.randomUUID(),
      taskId: frozen.id,
      token: crypto.randomUUID(),
      operation: "send",
      purpose: "recovery",
      outcome: "unknown",
      credentialVersion: 1,
      startedAt: now - 5,
      finishedAt: now - 4,
    });
  }
  await setSending(options.enabled !== false);
  return {
    owner,
    recipient,
    activityId,
    merchantId,
    clientId,
    taskId: frozen.id,
    claimId,
    recipientId,
    username,
    businessNo: frozen.businessNo,
    digest,
    bindings: {
      ...env,
      APP_ENV: "production",
      LDC_NETWORK_MODE: "live",
    } as ApiBindings,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function task(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, f.taskId))
    .get();
  if (!row) throw new Error("No task");
  return row;
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
function receipt(f: Fixture): AdapterResult {
  return {
    kind: "sent",
    evidence: {
      source: "send",
      businessNo: f.businessNo,
      externalOrderId: "TRADE-CLAIM",
    },
  };
}
function confirmation(f: Fixture): AdapterResult {
  return {
    kind: "confirmed",
    evidence: {
      source: "query",
      businessNo: f.businessNo,
      clientId: f.clientId,
      amountMinor: 10,
      externalOrderId: "TRADE-CLAIM",
      status: 1,
    },
  };
}
async function cycle(f: Fixture, a: PaymentAdapter, bindings = f.bindings) {
  return runMerchantCycle(bindings, f.merchantId, { adapterFactory: () => a });
}
async function due(f: Fixture) {
  const row = await task(f);
  now =
    Math.max(
      now,
      row.nextRunAt,
      row.nextSendAt ?? 0,
      row.nextQueryAt ?? 0,
      row.queryRetryAfterAt ?? 0,
    ) + 1;
}

describe("ordinary real claim payments", () => {
  it("persists first send intent, confirms by query and exposes no acceptance grant", async () => {
    const f = await fixture(),
      a = adapter(confirmation(f), receipt(f));
    await cycle(f, a);
    const first = await task(f);
    expect(first.firstSendAt).toBe(now);
    expect(first.attemptCount).toBe(1);
    expect(first.unknownOutcome).toBe(true);
    expect(first.orderEvidence).toBe("receipt");
    expect(vi.mocked(a.send).mock.calls[0]?.[0]).toMatchObject({
      source: "claim",
      claimId: f.claimId,
      recipientId: f.recipientId,
      businessNo: f.businessNo,
      amountMinor: 10,
    });
    await due(f);
    await cycle(f, a);
    expect((await task(f)).status).toBe("confirmed");
    expect((await task(f)).firstSendAt).toBe(first.firstSendAt);
    const detail = await merchantPaymentDetail(
      f.bindings,
      f.merchantId,
      f.taskId,
    );
    expect(detail).toMatchObject({
      source: "claim",
      recoveryPolicy: "claim_same_order_v1",
      retryAuthorization: null,
      duplicateProbe: null,
    });
    expect(
      detail.attempts.find((x) => x.operation === "send")?.recipientUsername,
    ).toBe(f.username);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it.each([
    { APP_ENV: "local", LDC_NETWORK_MODE: "live" },
    { APP_ENV: "staging", LDC_NETWORK_MODE: "live" },
    { APP_ENV: undefined, LDC_NETWORK_MODE: "live" },
    { APP_ENV: "production", LDC_NETWORK_MODE: "verify" },
    { APP_ENV: "production", LDC_NETWORK_MODE: "acceptance" },
    { APP_ENV: "production", LDC_NETWORK_MODE: "disabled" },
    { APP_ENV: "production", LDC_NETWORK_MODE: "live", LDC_STOP_SENDS: "true" },
  ])("does not grant first send under %j", async (overrides) => {
    const f = await fixture(),
      a = adapter();
    await cycle(f, a, { ...f.bindings, ...overrides } as ApiBindings);
    expect(a.send).not.toHaveBeenCalled();
    expect(a.query).not.toHaveBeenCalled();
    expect((await task(f)).firstSendAt).toBeNull();
    expect((await task(f)).attemptCount).toBe(0);
  });

  it("defaults closed and sends historical queries while all send/open/claim flags are stopped", async () => {
    const fresh = await fixture({ enabled: false }),
      a = adapter();
    await cycle(fresh, a);
    expect(a.send).not.toHaveBeenCalled();
    const f = await fixture({ history: true, enabled: false }),
      q = adapter(confirmation(f));
    const verify = {
      ...f.bindings,
      LDC_NETWORK_MODE: "verify",
      LDC_STOP_SENDS: "true",
      LDC_STOP_NEW_OPENINGS: "true",
      LDC_STOP_NEW_CLAIMS: "true",
    };
    await cycle(f, q, verify);
    expect(q.query).toHaveBeenCalledOnce();
    expect(q.send).not.toHaveBeenCalled();
    expect((await task(f)).status).toBe("confirmed");
  });

  it("waits before first send for current credentials and wakes after verification without consuming intent", async () => {
    const f = await fixture({ passed: false }),
      a = adapter();
    await cycle(f, a);
    expect(await task(f)).toMatchObject({
      status: "waiting",
      reason: "credentials",
      firstSendAt: null,
      attemptCount: 0,
    });
    expect((await task(f)).nextRunAt).toBe(now + 300_000);
    expect(a.send).not.toHaveBeenCalled();
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=1",
    )
      .bind(now, f.merchantId)
      .run();
    await requestMerchantCheck(f.bindings, f.merchantId);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    expect((await task(f)).firstSendAt).toBe(now);
  });

  it.each(["control", "credentials"] as const)(
    "rolls back intent when %s changes before the atomic batch",
    async (kind) => {
      const f = await fixture(),
        a = adapter();
      const originalBatch = env.DB.batch.bind(env.DB);
      let inject = true;
      const race = vi
        .spyOn(env.DB, "batch")
        .mockImplementation(async (statements) => {
          if (inject) {
            inject = false;
            if (kind === "control") await setSending(false);
            else
              await env.DB.prepare(
                "UPDATE merchant_credentials SET verification_status='unverified' WHERE merchant_id=?",
              )
                .bind(f.merchantId)
                .run();
          }
          return originalBatch(statements);
        });
      await cycle(f, a);
      race.mockRestore();
      expect(a.send).not.toHaveBeenCalled();
      expect((await task(f)).firstSendAt).toBeNull();
      expect((await task(f)).attemptCount).toBe(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT id FROM payment_attempts WHERE task_id=?",
          )
            .bind(f.taskId)
            .all()
        ).results,
      ).toHaveLength(0);
      expect(
        (
          await env.DB.prepare("SELECT lease_token FROM merchants WHERE id=?")
            .bind(f.merchantId)
            .first<{ lease_token: string | null }>()
        )?.lease_token,
      ).toBeNull();
    },
  );

  it("recovers response loss without a grant or 24-hour/five-send expiry", async () => {
    const f = await fixture(),
      a = adapter();
    await cycle(f, a);
    const original = await task(f);
    now += 2 * 86_400_000;
    for (let n = 0; n < 7; n++) {
      await due(f);
      await cycle(f, a);
      expect(a.query).toHaveBeenCalledTimes(n + 1);
      await due(f);
      await cycle(f, a);
    }
    expect(a.send).toHaveBeenCalledTimes(8);
    const row = await task(f);
    expect(row.firstSendAt).toBe(original.firstSendAt);
    expect(row.unknownOutcome).toBe(true);
    expect(row.businessNo).toBe(original.businessNo);
    for (const [snapshot] of vi.mocked(a.send).mock.calls)
      expect(snapshot).toMatchObject({
        recipientId: f.recipientId,
        recipientUsername: f.username,
        amountMinor: 10,
        parameterDigest: f.digest,
      });
    expect(
      (
        await env.DB.prepare(
          "SELECT task_id FROM payment_retry_grants WHERE task_id=?",
        )
          .bind(f.taskId)
          .all()
      ).results,
    ).toHaveLength(0);
  });

  it("concurrent and repeated wakes cannot consume first send twice", async () => {
    const f = await fixture(),
      a = adapter();
    await Promise.all([cycle(f, a), cycle(f, a), cycle(f, a)]);
    expect(a.send).toHaveBeenCalledOnce();
    expect((await task(f)).attemptCount).toBe(1);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted intent by querying before any retry and ignores its late outcome", async () => {
    const f = await fixture(),
      a = adapter(confirmation(f));
    let started!: () => void, finish!: (result: AdapterResult) => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(a.send).mockImplementation(async () => {
      started();
      return new Promise<AdapterResult>((resolve) => {
        finish = resolve;
      });
    });
    const initial = cycle(f, a);
    await sending;
    now += 31_000;
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect((await task(f)).status).toBe("confirmed");
    finish({ kind: "unknown", reason: "timeout" });
    await initial;
    expect((await task(f)).status).toBe("confirmed");
    expect((await task(f)).attemptCount).toBe(1);
    expect(a.send).toHaveBeenCalledOnce();
  });

  it("a late credential rejection preserves newer verified keys and each attempt's pinned version", async () => {
    const f = await fixture(),
      a = adapter({ kind: "not_found" });
    vi.mocked(a.send).mockImplementationOnce(async (_row, context) => {
      expect(context.credentialVersion).toBe(1);
      expect(context.clientSecret).toBe("isolated-test-secret");
      now += 5;
      await createDb(env.DB)
        .insert(merchantCredentials)
        .values({
          id: crypto.randomUUID(),
          merchantId: f.merchantId,
          version: 2,
          ciphertext: await encryptString(
            "isolated-rotated-key",
            env,
            `merchant:${f.merchantId}:credential:2`,
          ),
          verificationStatus: "passed",
          verificationCheckedAt: now,
          createdAt: now,
        });
      await env.DB.prepare(
        "UPDATE merchants SET credential_version=2 WHERE id=?",
      )
        .bind(f.merchantId)
        .run();
      return { kind: "waiting", reason: "credentials", httpStatus: 401 };
    });
    await cycle(f, a);
    expect(
      (
        await env.DB.prepare(
          "SELECT verification_status FROM merchant_credentials WHERE merchant_id=? AND version=2",
        )
          .bind(f.merchantId)
          .first<{ verification_status: string }>()
      )?.verification_status,
    ).toBe("passed");
    await due(f);
    await cycle(f, a);
    expect(vi.mocked(a.query).mock.calls[0]?.[1]).toMatchObject({
      credentialVersion: 2,
      clientSecret: "isolated-rotated-key",
    });
    const attempts = (
      await env.DB.prepare(
        "SELECT operation,credential_version FROM payment_attempts WHERE task_id=? ORDER BY started_at,id",
      )
        .bind(f.taskId)
        .all()
    ).results;
    expect(attempts).toEqual([
      { operation: "send", credential_version: 1 },
      { operation: "query", credential_version: 2 },
    ]);
    expect((await task(f)).sendBlockReason).toBeNull();
  });

  it("a newer same-version verification cannot be invalidated by an older send", async () => {
    const f = await fixture(),
      a = adapter();
    vi.mocked(a.send).mockImplementationOnce(async () => {
      now += 5;
      await env.DB.prepare(
        "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=?,verification_started_at=? WHERE merchant_id=? AND version=1",
      )
        .bind(now, now, f.merchantId)
        .run();
      return { kind: "waiting", reason: "credentials", httpStatus: 401 };
    });
    await cycle(f, a);
    expect(
      (
        await env.DB.prepare(
          "SELECT verification_status FROM merchant_credentials WHERE merchant_id=? AND version=1",
        )
          .bind(f.merchantId)
          .first<{ verification_status: string }>()
      )?.verification_status,
    ).toBe("passed");
  });

  it("does not send when the allocated inventory no longer matches the locked amount", async () => {
    const f = await fixture(),
      a = adapter();
    await env.DB.prepare(
      "UPDATE reward_inventory SET amount_minor=11 WHERE activity_id=?",
    )
      .bind(f.activityId)
      .run();
    await cycle(f, a);
    expect(a.send).not.toHaveBeenCalled();
    expect((await task(f)).firstSendAt).toBeNull();
  });

  it.each(["receipt", "duplicate", "pending", "conflict"] as const)(
    "%s evidence never authorizes another send",
    async (evidence) => {
      const f = await fixture();
      const q: AdapterResult =
        evidence === "pending"
          ? {
              kind: "unconfirmed",
              reason: "upstream_pending",
              evidence: {
                source: "query",
                clientId: f.clientId,
                businessNo: f.businessNo,
                amountMinor: 10,
                externalOrderId: "TRADE-CLAIM",
                status: 0,
              },
            }
          : evidence === "conflict"
            ? {
                kind: "confirmed",
                evidence: {
                  source: "query",
                  clientId: f.clientId,
                  businessNo: f.businessNo,
                  amountMinor: 11,
                  externalOrderId: "TRADE-CLAIM",
                  status: 1,
                },
              }
            : { kind: "not_found" };
      const a = adapter(
        q,
        evidence === "receipt"
          ? receipt(f)
          : evidence === "duplicate"
            ? { kind: "duplicate", reason: "duplicate_order" }
            : { kind: "unknown", reason: "timeout" },
      );
      await cycle(f, a);
      await due(f);
      await cycle(f, a);
      for (let n = 0; n < 2; n++) {
        await due(f);
        await cycle(f, a);
      }
      expect(a.send).toHaveBeenCalledOnce();
      expect((await realSendDecision(f.bindings, await task(f))).allowed).toBe(
        false,
      );
    },
  );

  it("invalidates a definitely rejected credential and recovers after same-version revalidation", async () => {
    const f = await fixture(),
      a = adapter(
        { kind: "not_found" },
        { kind: "waiting", reason: "credentials", httpStatus: 401 },
      );
    await cycle(f, a);
    expect(
      (
        await env.DB.prepare(
          "SELECT verification_status FROM merchant_credentials WHERE merchant_id=? AND version=1",
        )
          .bind(f.merchantId)
          .first<{ verification_status: string }>()
      )?.verification_status,
    ).toBe("rejected");
    await due(f);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledOnce();
    now += 30_000;
    await env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=1",
    )
      .bind(now, f.merchantId)
      .run();
    await requestMerchantCheck(f.bindings, f.merchantId);
    await cycle(f, a);
    await due(f);
    vi.mocked(a.send).mockResolvedValueOnce(receipt(f));
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledTimes(2);
    expect((await task(f)).businessNo).toBe(f.businessNo);
  });

  it("keeps the frozen username and pays ended/archived activities and legacy merchants", async () => {
    const f = await fixture({ history: true }),
      a = adapter(confirmation(f));
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET username='NewUsername' WHERE id=?").bind(
        f.recipient,
      ),
      env.DB.prepare(
        "UPDATE activities SET ended_at=?,archived_at=?,end_reason='manual' WHERE id=?",
      ).bind(now - 10, now - 1, f.activityId),
      env.DB.prepare(
        "UPDATE merchants SET usage_status='legacy' WHERE id=?",
      ).bind(f.merchantId),
    ]);
    expect((await realQueryDecision(f.bindings, await task(f))).allowed).toBe(
      true,
    );
    await cycle(f, a);
    expect(a.query).toHaveBeenCalledOnce();
    expect((await task(f)).status).toBe("confirmed");
    expect(vi.mocked(a.query).mock.calls[0]?.[0].recipientUsername).toBe(
      f.username,
    );
  });

  it("rejects a plausible but incorrect stored digest and mutable task snapshots", async () => {
    const invalid = await fixture({ digest: "a".repeat(64) }),
      a = adapter();
    await cycle(invalid, a);
    expect(a.send).not.toHaveBeenCalled();
    const f = await fixture(),
      original = await task(f);
    for (const delta of [
      { recipientId: "1" },
      { recipientUsername: "Different" },
      { claimId: crypto.randomUUID() },
      { amountMinor: 11 },
      { businessNo: "different" },
    ])
      expect(
        (await realSendDecision(f.bindings, { ...original, ...delta })).allowed,
      ).toBe(false);
  });

  it("Cron and queue wakes include ordinary query responsibility under a send stop", async () => {
    const f = await fixture({ history: true, enabled: false }),
      fresh = await fixture({ enabled: false });
    const queue = vi.spyOn(env.PAYMENT_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });
    const wakes: string[] = [];
    vi.spyOn(env.MERCHANT_DO, "get").mockImplementation(
      () =>
        ({
          fetch: async (_url: string, init: RequestInit) => {
            wakes.push(
              (JSON.parse(String(init.body)) as { merchantId: string })
                .merchantId,
            );
            return new Response(null, { status: 200 });
          },
        }) as unknown as ReturnType<typeof env.MERCHANT_DO.get>,
    );
    const bindings = {
      ...f.bindings,
      LDC_NETWORK_MODE: "verify",
      LDC_STOP_SENDS: "true",
    };
    expect(await sweepPayments(bindings)).toBe(1);
    expect(wakes).toEqual([f.merchantId]);
    expect(queue).toHaveBeenCalledTimes(2);
    await wakePayment(bindings, f.taskId);
    await wakePayment(bindings, fresh.taskId);
    expect(wakes).toEqual([f.merchantId, f.merchantId]);
  });
});
