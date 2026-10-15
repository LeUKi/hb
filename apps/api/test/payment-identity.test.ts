import { env } from "cloudflare:test";
import { emptyActivityInput } from "@hb/contracts";
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
import { listAccountPayments } from "../src/payments/account-queries";
import type { AdapterResult, PaymentAdapter } from "../src/payments/adapter";
import { loadMerchantSecret } from "../src/payments/credentials";
import {
  effectiveClaimPaymentTask,
  loadPaymentIdentityCorrections,
  synchronizeClaimPaymentIdentity,
} from "../src/payments/identity";
import { repairPaymentCredential } from "../src/payments/merchants";
import {
  claimPaymentParameterDigest,
  realQueryDecision,
  realSendDecision,
} from "../src/payments/policy";
import { merchantPaymentDetail } from "../src/payments/queries";
import {
  basicAuthorization,
  createRealPaymentAdapter,
} from "../src/payments/real-protocol";
import { runMerchantCycle, wakePayment } from "../src/payments/scheduler";
import { beginCredentialVerification } from "../src/payments/verification";
import { encryptString } from "../src/security/crypto";

let now: number;
beforeEach(() => {
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
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
  if (!row) throw new Error("Missing task fixture");
  return row;
}
async function merchant(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, f.merchantId))
    .get();
  if (!row) throw new Error("Missing merchant fixture");
  return row;
}
async function replaceClient(
  f: Fixture,
  clientId = `fixed_${crypto.randomUUID()}`,
  passed = true,
) {
  const current = await merchant(f);
  const next = (
    await env.DB.prepare(
      "SELECT MAX(version)+1 AS version FROM merchant_credentials WHERE merchant_id=?",
    )
      .bind(f.merchantId)
      .first<{ version: number }>()
  )?.version;
  if (next === undefined) throw new Error("Missing credential counter");
  const secret = `isolated-key-${next}`;
  now++;
  const registry = await env.DB.prepare(
    "SELECT client_id FROM merchant_client_ids WHERE client_id=?",
  )
    .bind(clientId)
    .first();
  await env.DB.batch([
    ...(registry
      ? []
      : [
          env.DB.prepare(
            "INSERT INTO merchant_client_ids(client_id,merchant_id,created_at) VALUES(?,?,?)",
          ).bind(clientId, f.merchantId, now),
        ]),
    env.DB.prepare(
      "INSERT INTO merchant_credentials(id,merchant_id,client_id,version,ciphertext,verification_status,verification_checked_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      f.merchantId,
      clientId,
      next,
      await encryptString(
        secret,
        env,
        `merchant:${f.merchantId}:credential:${next}`,
      ),
      passed ? "passed" : "unverified",
      now,
      now,
    ),
    env.DB.prepare(
      "UPDATE merchants SET client_id=?,version=?,credential_version=?,updated_at=? WHERE id=?",
    ).bind(clientId, current.version + 1, next, now, f.merchantId),
  ]);
  return { clientId, version: next, secret };
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
async function cycle(f: Fixture, adapter: PaymentAdapter) {
  return runMerchantCycle(f.bindings, f.merchantId, {
    adapterFactory: () => adapter,
  });
}
type MockUpstream = (
  url: URL,
  init: RequestInit | undefined,
) => Response | Promise<Response>;
function protocol(f: Fixture, upstream?: MockUpstream) {
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (upstream) return upstream(url, init);
      if (init?.method === "POST")
        return Response.json({
          error_msg: "",
          data: { out_trade_no: f.businessNo, trade_no: "TRADE-FIXTURE" },
        });
      return confirmation(f, url);
    },
  );
  const real = createRealPaymentAdapter({ fetch: transport as typeof fetch });
  const adapter: PaymentAdapter = {
    mode: "real",
    send: vi.fn((row, context) => real.send(row, context)),
    query: vi.fn((row, context) => real.query(row, context)),
  };
  return { adapter, transport };
}
function confirmation(f: Fixture, url: URL, status = 1) {
  return Response.json({
    code: 1,
    pid: url.searchParams.get("pid"),
    out_trade_no: f.businessNo,
    trade_no: "TRADE-FIXTURE",
    money: "0.10",
    status,
  });
}
function notFound() {
  return Response.json(
    { code: -1, msg: "订单不存在或已完成" },
    { status: 404 },
  );
}
async function attempts(f: Fixture) {
  return (
    await env.DB.prepare(
      "SELECT operation,client_id,identity_correction_version,credential_version,no_order_evidence,parameter_digest,outcome FROM payment_attempts WHERE task_id=? ORDER BY started_at,id",
    )
      .bind(f.taskId)
      .all()
  ).results;
}

describe("merchant configuration correction and pinned payment identities", () => {
  it("uses a verified corrected application for a never-sent ordinary debt without overwriting its original identity", async () => {
    const f = await fixture();
    const original = await task(f);
    const changed = await replaceClient(f);
    const { adapter, transport } = protocol(f);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.send).mock.calls[0]?.[0]).toMatchObject({
      clientId: changed.clientId,
      recipientId: original.recipientId,
      businessNo: original.businessNo,
      amountMinor: 10,
    });
    expect(
      new Headers(transport.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe(basicAuthorization(changed.clientId, changed.secret));
    const sent = await task(f);
    expect(sent).toMatchObject({
      clientId: original.clientId,
      parameterDigest: original.parameterDigest,
      attemptCount: 1,
    });
    expect(
      await loadPaymentIdentityCorrections(f.bindings, f.taskId),
    ).toMatchObject([
      {
        version: 1,
        evidence: "never_sent",
        originalClientId: f.clientId,
        correctedClientId: changed.clientId,
      },
    ]);
    await due(f);
    await cycle(f, adapter);
    expect((await task(f)).status).toBe("confirmed");
    expect(
      (await attempts(f)).map((a) => ({
        operation: a.operation,
        clientId: a.client_id,
        version: a.identity_correction_version,
      })),
    ).toEqual([
      { operation: "send", clientId: changed.clientId, version: 1 },
      { operation: "query", clientId: changed.clientId, version: 1 },
    ]);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("waits for the current corrected credential check and preserves encrypted old keys", async () => {
    const f = await fixture();
    const changed = await replaceClient(f, undefined, false);
    const { adapter } = protocol(f);
    await cycle(f, adapter);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
    expect(
      await loadMerchantSecret(f.bindings, f.merchantId, 1, f.clientId),
    ).toBe("isolated-test-secret");
    await expect(
      loadMerchantSecret(f.bindings, f.merchantId, 1, changed.clientId),
    ).rejects.toThrow("identity mismatch");
    now++;
    const verify = await beginCredentialVerification(
      f.bindings,
      f.merchantId,
      {
        fetch: vi.fn(async () =>
          Response.json(
            { code: -1, msg: "订单不存在或已完成" },
            { status: 404 },
          ),
        ),
      },
      changed.version,
    );
    expect(verify).not.toBeNull();
    await verify?.();
    await due(f);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.send).mock.calls[0]?.[1]).toMatchObject({
      clientId: changed.clientId,
      credentialVersion: changed.version,
      clientSecret: changed.secret,
    });
  });

  it("chains repeated safe corrections and allows returning to the same merchant's registered application", async () => {
    const f = await fixture();
    const changed = await replaceClient(f);
    expect(
      await synchronizeClaimPaymentIdentity(
        f.bindings,
        await merchant(f),
        await task(f),
      ),
    ).toBe(true);
    const restored = await replaceClient(f, f.clientId);
    expect(
      await synchronizeClaimPaymentIdentity(
        f.bindings,
        await merchant(f),
        await task(f),
      ),
    ).toBe(true);
    const corrections = await loadPaymentIdentityCorrections(
      f.bindings,
      f.taskId,
    );
    expect(
      corrections.map((c) => [
        c.version,
        c.originalClientId,
        c.correctedClientId,
      ]),
    ).toEqual([
      [1, f.clientId, changed.clientId],
      [2, changed.clientId, f.clientId],
    ]);
    const effective = await effectiveClaimPaymentTask(
      f.bindings,
      await task(f),
    );
    expect(effective).toMatchObject({
      clientId: f.clientId,
      identityCorrectionVersion: 2,
      parameterDigest: f.digest,
    });
    const { adapter } = protocol(f);
    await cycle(f, adapter);
    expect(vi.mocked(adapter.send).mock.calls[0]?.[1]).toMatchObject({
      credentialVersion: restored.version,
      clientSecret: restored.secret,
    });
  });

  it("persists exact pre-order rejection proof, queries the corrected application and keeps the original business number and send counters", async () => {
    const f = await fixture();
    let sends = 0;
    const { adapter } = protocol(f, (url, init) => {
      if (init?.method === "POST" && ++sends === 1)
        return Response.json(
          { error_msg: "认证失败", data: null },
          { status: 401 },
        );
      if (init?.method === "POST")
        return Response.json({
          error_msg: "",
          data: { trade_no: "TRADE-FIXTURE", out_trade_no: f.businessNo },
        });
      return sends === 1 ? notFound() : confirmation(f, url);
    });
    await cycle(f, adapter);
    const rejected = await task(f);
    expect(rejected).toMatchObject({
      unknownOutcome: false,
      attemptCount: 1,
      sendBlockReason: "credentials",
    });
    expect((await attempts(f))[0]).toMatchObject({
      outcome: "rejected",
      no_order_evidence: "protocol_rejection_v1",
      client_id: f.clientId,
    });
    const changed = await replaceClient(f);
    await cycle(f, adapter);
    expect(adapter.query).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.query).mock.calls[0]?.[0].clientId).toBe(
      changed.clientId,
    );
    const queried = await task(f);
    expect(queried.nextAction).toBe("send");
    expect(queried.firstSendAt).toBe(rejected.firstSendAt);
    expect(queried.sendBackoffCount).toBe(rejected.sendBackoffCount);
    await due(f);
    await cycle(f, adapter);
    await due(f);
    await cycle(f, adapter);
    expect((await task(f)).status).toBe("confirmed");
    expect((await task(f)).attemptCount).toBe(2);
    expect((await task(f)).clientId).toBe(f.clientId);
    expect((await task(f)).businessNo).toBe(f.businessNo);
    expect(
      await loadPaymentIdentityCorrections(f.bindings, f.taskId),
    ).toMatchObject([{ evidence: "rejected_no_order", version: 1 }]);
  });

  it("does not bypass funds backoff or Retry-After while changing a proven rejected application", async () => {
    const f = await fixture();
    const { adapter } = protocol(f, (_url, init) =>
      init?.method === "POST"
        ? Response.json(
            { error_msg: "余额不足", data: null },
            { status: 400, headers: { "Retry-After": "600" } },
          )
        : notFound(),
    );
    await cycle(f, adapter);
    const rejected = await task(f);
    const changed = await replaceClient(f);
    await cycle(f, adapter);
    expect(adapter.query).not.toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalledOnce();
    expect((await task(f)).queryRetryAfterAt).toBe(rejected.queryRetryAfterAt);
    expect((await task(f)).nextSendAt).toBe(rejected.nextSendAt);
    expect(
      (await effectiveClaimPaymentTask(f.bindings, await task(f))).clientId,
    ).toBe(changed.clientId);
    now = (rejected.queryRetryAfterAt ?? now) + 1;
    await cycle(f, adapter);
    expect(adapter.query).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("does not automatically resume recipient or amount errors even if their rejection is known not to have created an order", async () => {
    const f = await fixture();
    const { adapter } = protocol(f, () =>
      Response.json({ error_msg: "收款人不存在", data: null }, { status: 400 }),
    );
    await cycle(f, adapter);
    await replaceClient(f);
    await due(f);
    await cycle(f, adapter);
    expect(await task(f)).toMatchObject({
      status: "attention",
      sendBlockReason: "recipient",
      unknownOutcome: false,
    });
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).not.toHaveBeenCalled();
  });

  it("keeps a lost-response debt on the original application even after new credentials pass", async () => {
    const f = await fixture();
    const { adapter } = protocol(f, (_url, init) => {
      if (init?.method === "POST") throw new Error("mock transport failure");
      return notFound();
    });
    await cycle(f, adapter);
    const changed = await replaceClient(f);
    for (let n = 0; n < 3; n++) {
      await due(f);
      await cycle(f, adapter);
    }
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.query).toHaveBeenCalledTimes(3);
    for (const [row, context] of vi.mocked(adapter.query).mock.calls) {
      expect(row.clientId).toBe(f.clientId);
      expect(context).toMatchObject({
        clientId: f.clientId,
        credentialVersion: 1,
        clientSecret: "isolated-test-secret",
      });
    }
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
    expect((await task(f)).unknownOutcome).toBe(true);
    expect((await realSendDecision(f.bindings, await task(f))).allowed).toBe(
      false,
    );
    expect((await merchant(f)).clientId).toBe(changed.clientId);
  });

  it.each(["receipt", "pending"] as const)(
    "retains %s order evidence on its bound application through configuration changes and later 404s",
    async (kind) => {
      const f = await fixture();
      let queryCount = 0;
      const { adapter } = protocol(f, (url, init) => {
        if (init?.method === "POST") {
          if (kind === "pending") throw new Error("mock transport failure");
          return Response.json({
            error_msg: "",
            data: { trade_no: "TRADE-FIXTURE", out_trade_no: f.businessNo },
          });
        }
        return ++queryCount === 1 && kind === "pending"
          ? confirmation(f, url, 0)
          : notFound();
      });
      await cycle(f, adapter);
      if (kind === "pending") {
        await due(f);
        await cycle(f, adapter);
      }
      await replaceClient(f);
      for (let n = 0; n < 2; n++) {
        await due(f);
        await cycle(f, adapter);
      }
      expect(adapter.send).toHaveBeenCalledOnce();
      expect((await task(f)).orderEvidence).toBe(
        kind === "receipt" ? "receipt" : "query",
      );
      expect((await task(f)).externalOrderId).toBe("TRADE-FIXTURE");
      expect(
        await loadPaymentIdentityCorrections(f.bindings, f.taskId),
      ).toEqual([]);
      for (const [snapshot] of vi.mocked(adapter.query).mock.calls)
        expect(snapshot.clientId).toBe(f.clientId);
    },
  );

  it("does not promote a historical 400 or a guessed rejection to safe migration proof", async () => {
    const f = await fixture();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE payment_tasks SET attempt_count=1,first_send_at=?,status='waiting',reason='funds',send_block_reason='funds',next_query_at=0 WHERE id=?",
      ).bind(now, f.taskId),
      env.DB.prepare(
        "INSERT INTO payment_attempts(id,task_id,token,operation,outcome,credential_version,started_at,finished_at,http_status,reason,client_id) VALUES(?,?,?,'send','rejected',1,?,?,400,'funds',?)",
      ).bind(
        crypto.randomUUID(),
        f.taskId,
        crypto.randomUUID(),
        now,
        now,
        f.clientId,
      ),
    ]);
    await replaceClient(f);
    const { adapter } = protocol(f, () => notFound());
    await cycle(f, adapter);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(adapter.query).toHaveBeenCalledOnce();
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
    expect((await attempts(f))[0]?.no_order_evidence).toBeNull();
  });

  it("keeps historical uncertainty after a subsequent precise credential rejection", async () => {
    const f = await fixture();
    let sends = 0;
    const { adapter } = protocol(f, (_url, init) => {
      if (init?.method !== "POST") return notFound();
      if (++sends === 1) throw new Error("mock response loss");
      return Response.json(
        { error_msg: "认证失败", data: null },
        { status: 401 },
      );
    });
    await cycle(f, adapter);
    await due(f);
    await cycle(f, adapter);
    await due(f);
    await cycle(f, adapter);
    expect((await task(f)).unknownOutcome).toBe(true);
    await replaceClient(f);
    await due(f);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.query).mock.calls.at(-1)?.[0].clientId).toBe(
      f.clientId,
    );
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
  });

  it("serializes concurrent correction and send attempts with one logical merchant lease", async () => {
    const f = await fixture();
    await replaceClient(f);
    const { adapter } = protocol(f);
    await Promise.all([
      cycle(f, adapter),
      cycle(f, adapter),
      cycle(f, adapter),
    ]);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect((await task(f)).attemptCount).toBe(1);
    expect(
      await loadPaymentIdentityCorrections(f.bindings, f.taskId),
    ).toHaveLength(1);
    expect(
      (await attempts(f)).filter((a) => a.operation === "send"),
    ).toHaveLength(1);
  });

  it("invalidates a prepared send when the client changes before its atomic intent batch", async () => {
    const f = await fixture();
    const { adapter } = protocol(f);
    const originalBatch = env.DB.batch.bind(env.DB);
    let inject = true;
    const race = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (inject) {
          inject = false;
          await replaceClient(f);
        }
        return originalBatch(statements);
      });
    await cycle(f, adapter);
    race.mockRestore();
    expect(adapter.send).not.toHaveBeenCalled();
    expect((await task(f)).attemptCount).toBe(0);
    expect(await attempts(f)).toEqual([]);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.send).mock.calls[0]?.[0].clientId).toBe(
      (await merchant(f)).clientId,
    );
  });

  it("pins an already-started send and confirms its old order after a client replacement", async () => {
    const f = await fixture();
    const { adapter } = protocol(f, async (url, init) => {
      if (init?.method === "POST") {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          basicAuthorization(f.clientId, "isolated-test-secret"),
        );
        await replaceClient(f);
        return Response.json({
          error_msg: "",
          data: { trade_no: "TRADE-FIXTURE", out_trade_no: f.businessNo },
        });
      }
      return confirmation(f, url);
    });
    await cycle(f, adapter);
    await due(f);
    await cycle(f, adapter);
    expect((await task(f)).status).toBe("confirmed");
    expect(vi.mocked(adapter.query).mock.calls[0]?.[1]).toMatchObject({
      clientId: f.clientId,
      credentialVersion: 1,
    });
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
    const confirmed = await task(f);
    expect((await realQueryDecision(f.bindings, confirmed)).allowed).toBe(true);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it("checks the original order after a crashed send intent and ignores its late response", async () => {
    const f = await fixture();
    const { adapter } = protocol(f);
    let started!: () => void, finish!: (result: AdapterResult) => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(adapter.send).mockImplementationOnce(async () => {
      started();
      return new Promise<AdapterResult>((resolve) => {
        finish = resolve;
      });
    });
    const initial = cycle(f, adapter);
    await sending;
    await replaceClient(f);
    now += 31_000;
    await cycle(f, adapter);
    expect(vi.mocked(adapter.query).mock.calls[0]?.[0].clientId).toBe(
      f.clientId,
    );
    expect((await task(f)).status).toBe("confirmed");
    finish({ kind: "unknown", reason: "timeout" });
    await initial;
    expect((await task(f)).status).toBe("confirmed");
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
  });

  it("counts a payment waiting for its original order's key on /payments, as its detail does", async () => {
    const f = await fixture({ history: true });
    // The list heads each group with its 红包, so it needs a real config.
    await env.DB.prepare("UPDATE activities SET config=? WHERE id=?")
      .bind(
        JSON.stringify({
          ...emptyActivityInput(),
          merchantId: f.merchantId,
          money: { mode: "fixed", totalAmount: "0.20", count: 2 },
        }),
        f.activityId,
      )
      .run();
    expect(
      (await listAccountPayments(f.bindings, f.owner, "all")).summary,
    ).toMatchObject({ repairableCount: 0, firstRepairableId: null });
    await replaceClient(f);
    // The application the order was made with: its key was rejected.
    await env.DB.prepare(
      "UPDATE merchant_credentials SET client_id=?,verification_status='rejected',verification_reason='credentials' WHERE merchant_id=? AND version=1",
    )
      .bind(f.clientId, f.merchantId)
      .run();
    const detail = await merchantPaymentDetail(
      f.bindings,
      f.merchantId,
      f.taskId,
    );
    expect(detail.config?.canRepairCredentials).toBe(true);
    expect(
      (await listAccountPayments(f.bindings, f.owner, "all")).summary,
    ).toMatchObject({ repairableCount: 1, firstRepairableId: f.taskId });
  });

  it("repairs only the original order's credential, keeps current application settings, and does not let late failures reject newer keys", async () => {
    const f = await fixture({ history: true });
    const changed = await replaceClient(f);
    let repairedVersion = 0;
    let queries = 0;
    const { adapter } = protocol(f, async (url) => {
      if (++queries === 1) {
        return Response.json(
          { code: -1, msg: "商户信息不存在" },
          { status: 400 },
        );
      }
      if (queries === 2) {
        expect(url.searchParams.get("pid")).toBe(f.clientId);
        expect(url.searchParams.get("key")).toBe("isolated-test-secret");
        const current = await merchant(f);
        const input = {
          version: current.version,
          requestId: crypto.randomUUID(),
          secret: "isolated-repaired-original-key",
        };
        const repaired = await repairPaymentCredential(
          f.bindings,
          f.merchantId,
          f.owner,
          f.taskId,
          input,
        );
        repairedVersion = repaired.credentialVersion;
        await env.DB.prepare(
          "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=?",
        )
          .bind(++now, f.merchantId, repairedVersion)
          .run();
        expect(
          (
            await repairPaymentCredential(
              f.bindings,
              f.merchantId,
              f.owner,
              f.taskId,
              input,
            )
          ).credentialVersion,
        ).toBe(repairedVersion);
        return Response.json(
          { code: -1, msg: "商户信息不存在" },
          { status: 400 },
        );
      }
      expect(url.searchParams.get("pid")).toBe(f.clientId);
      expect(url.searchParams.get("key")).toBe(
        "isolated-repaired-original-key",
      );
      return confirmation(f, url);
    });
    await cycle(f, adapter);
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
    await cycle(f, adapter);
    expect(await merchant(f)).toMatchObject({
      clientId: changed.clientId,
      credentialVersion: changed.version,
    });
    const credentials = (
      await env.DB.prepare(
        "SELECT version,client_id,verification_status FROM merchant_credentials WHERE merchant_id=? ORDER BY version",
      )
        .bind(f.merchantId)
        .all()
    ).results;
    expect(credentials.at(-1)).toMatchObject({
      version: repairedVersion,
      client_id: f.clientId,
      verification_status: "passed",
    });
    expect(
      credentials.find((row) => row.version === changed.version)
        ?.verification_status,
    ).toBe("passed");
    await due(f);
    await cycle(f, adapter);
    expect((await task(f)).status).toBe("confirmed");
    expect(adapter.send).not.toHaveBeenCalled();
    expect(vi.mocked(adapter.query).mock.calls[2]?.[1].credentialVersion).toBe(
      repairedVersion,
    );
    expect(await loadPaymentIdentityCorrections(f.bindings, f.taskId)).toEqual(
      [],
    );
  });

  it("rejects the historical repair operation for the current client or a still-accepted old key", async () => {
    const f = await fixture({ history: true });
    const current = await merchant(f);
    const input = {
      version: current.version,
      requestId: crypto.randomUUID(),
      secret: "isolated-repair-key",
    };
    await expect(
      repairPaymentCredential(
        f.bindings,
        f.merchantId,
        f.owner,
        f.taskId,
        input,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_CREDENTIAL_REPAIR_NOT_ALLOWED" });
    await replaceClient(f);
    await expect(
      repairPaymentCredential(f.bindings, f.merchantId, f.owner, f.taskId, {
        ...input,
        requestId: crypto.randomUUID(),
        version: (await merchant(f)).version,
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_CREDENTIAL_REPAIR_NOT_ALLOWED" });
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM merchant_credentials WHERE merchant_id=?",
        )
          .bind(f.merchantId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
  });

  it("accepts registered old and current DO aliases and rejects unrelated object names", async () => {
    const f = await fixture();
    const changed = await replaceClient(f);
    const invoke = (name: string) =>
      env.MERCHANT_DO.get(env.MERCHANT_DO.idFromName(name)).fetch(
        "https://merchant.internal/internal/payments/run",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchantId: f.merchantId }),
        },
      );
    expect((await invoke(f.clientId)).status).toBe(200);
    expect((await invoke(changed.clientId)).status).toBe(200);
    expect((await invoke(`unregistered_${crypto.randomUUID()}`)).status).toBe(
      400,
    );
    expect((await task(f)).attemptCount).toBe(0);
  });

  it("does not let twenty legacy refusals without proof starve the next safe correction", async () => {
    const f = await fixture();
    const original = await task(f);
    const db = createDb(env.DB);
    await env.DB.prepare(
      "UPDATE activities SET total_count=21,claimed_count=21 WHERE id=?",
    )
      .bind(f.activityId)
      .run();
    const blocked: string[] = [];
    for (let index = 1; index <= 20; index++) {
      const userId = crypto.randomUUID(),
        inventoryId = crypto.randomUUID(),
        claimId = crypto.randomUUID(),
        taskId = crypto.randomUUID();
      const recipientId = BigInt(
        `0x${userId.replaceAll("-", "").slice(0, 16)}`,
      ).toString();
      await db.insert(users).values({
        id: userId,
        externalId: recipientId,
        username: `Legacy_${index}_${userId.slice(0, 8)}`,
        displayName: "历史拒绝测试用户",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      await db.insert(rewardInventory).values({
        id: inventoryId,
        activityId: f.activityId,
        position: index,
        kind: "ldc",
        amountMinor: 10,
        createdAt: now,
      });
      await db.insert(claims).values({
        id: claimId,
        activityId: f.activityId,
        userId,
        inventoryId,
        passwordId:
          (
            await env.DB.prepare(
              "SELECT id FROM activity_passwords WHERE activity_id=?",
            )
              .bind(f.activityId)
              .first<{ id: string }>()
          )?.id ?? "",
        claimedAt: now,
      });
      const frozen = {
        ...original,
        id: taskId,
        claimId,
        businessNo: `hb_${claimId.replaceAll("-", "")}`,
        recipientId,
        recipientUsername: `Legacy_${index}_${userId.slice(0, 8)}`,
      };
      await db.insert(paymentTasks).values({
        ...frozen,
        parameterDigest: await claimPaymentParameterDigest(frozen),
        createdAt: now - 100 - index,
      });
      await env.DB.prepare(
        "UPDATE payment_tasks SET status='attention',reason='configuration',send_block_reason='configuration',attempt_count=1,first_send_at=? WHERE id=?",
      )
        .bind(now - 100, taskId)
        .run();
      await db.insert(paymentAttempts).values({
        id: crypto.randomUUID(),
        taskId,
        token: crypto.randomUUID(),
        operation: "send",
        outcome: "rejected",
        credentialVersion: 1,
        startedAt: now - 100,
        finishedAt: now - 99,
        httpStatus: 400,
        reason: "configuration",
        clientId: f.clientId,
      });
      blocked.push(taskId);
    }
    const changed = await replaceClient(f);
    const { adapter } = protocol(f);
    await cycle(f, adapter);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.send).mock.calls[0]?.[0].id).toBe(f.taskId);
    expect(
      (await effectiveClaimPaymentTask(f.bindings, await task(f))).clientId,
    ).toBe(changed.clientId);
    expect(
      (
        await env.DB.prepare(
          "SELECT task_id FROM payment_identity_corrections WHERE task_id IN (SELECT value FROM json_each(?))",
        )
          .bind(JSON.stringify(blocked))
          .all()
      ).results,
    ).toEqual([]);
  });

  it("lets a queue wake adopt a safe identity through the same guarded correction path", async () => {
    const f = await fixture();
    const changed = await replaceClient(f);
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
    await wakePayment(f.bindings, f.taskId);
    expect(wakes).toEqual([f.merchantId]);
    expect(
      (await effectiveClaimPaymentTask(f.bindings, await task(f))).clientId,
    ).toBe(changed.clientId);
    expect((await task(f)).attemptCount).toBe(0);
  });
});
