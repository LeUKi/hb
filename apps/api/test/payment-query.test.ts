import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { MerchantPaymentDetail } from "@hb/contracts";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import {
  paymentAcceptances,
  paymentAttempts,
  paymentDuplicateProbes,
  paymentRetryGrants,
  paymentTasks,
  paymentUsernameCorrections,
  sessions,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { paymentParameterDigest } from "../src/payments/policy";
import { encryptString, sha256Hex } from "../src/security/crypto";

const origin = "https://payment-query.example";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let other: Actor;

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: id,
    username: id,
    displayName: "诊断测试账号",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

async function request(
  path: string,
  user?: Actor,
  method = "GET",
  runtime = bindings,
  headers: Record<string, string> = {},
) {
  const context = createExecutionContext();
  const response = await app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(user ? { Cookie: user.cookie } : {}),
        ...(method === "GET"
          ? {}
          : { Origin: origin, "X-CSRF-Token": user?.csrf ?? "" }),
        ...headers,
      },
    },
    runtime,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function fixture(withProbe = false, withoutOrder = false) {
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    mode: "real",
    label: "隔离诊断商户",
    clientId: `query_fixture_${crypto.randomUUID()}`,
    secret: "VIRTUAL-QUERY-PRIVATE-CREDENTIAL",
  });
  const now = Date.now();
  const acceptanceId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const businessNo = `hb-query-test-${crypto.randomUUID()}`;
  const db = createDb(env.DB);
  await db.insert(paymentAcceptances).values({
    id: acceptanceId,
    merchantId: merchant.id,
    clientId: merchant.clientId,
    businessNo,
    recipientId: "900001",
    recipientUsername: "virtual_recipient",
    amountMinor: 10,
    sendConsumedAt: now,
    createdAt: now,
  });
  await db.insert(paymentTasks).values({
    id: taskId,
    source: "acceptance",
    acceptanceId,
    merchantId: merchant.id,
    clientId: merchant.clientId,
    businessNo,
    recipientId: "900001",
    recipientUsername: "virtual_recipient",
    amountMinor: 10,
    mode: "real",
    status: "reconciling",
    attemptCount: 1,
    reconciliationCount: 2,
    unknownOutcome: true,
    nextAction: "query",
    nextRunAt: now + 60_000,
    nextSendAt: now + 120_000,
    nextQueryAt: now + 60_000,
    sendBlockReason: withoutOrder ? "recipient" : "quota",
    queryRetryAfterAt: now + 45_000,
    orderObservedAt: withoutOrder ? null : now,
    orderEvidence: withoutOrder ? null : "query",
    externalOrderId: withoutOrder ? null : "virtual-query-order",
    createdAt: now,
    updatedAt: now,
  });
  const task = await db
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, taskId))
    .get();
  if (!task) throw new Error("Missing test task");
  const parameterDigest = await paymentParameterDigest(task);
  await db.insert(paymentRetryGrants).values({
    taskId,
    policy: "same_order_v1",
    parameterDigest,
    maxAdditionalSends: 5,
    usedAdditionalSends: 0,
    expiresAt: now + 3_600_000,
    createdAt: now,
  });
  for (const usedAdditionalSends of [1, 2])
    await db
      .update(paymentRetryGrants)
      .set({ usedAdditionalSends })
      .where(eq(paymentRetryGrants.taskId, taskId));
  if (withProbe) {
    await db
      .update(paymentTasks)
      .set({
        status: "confirmed",
        unknownOutcome: false,
        confirmedAt: now,
        nextAction: "none",
        nextSendAt: null,
        nextQueryAt: null,
      })
      .where(eq(paymentTasks.id, taskId));
    await db.insert(paymentDuplicateProbes).values({
      taskId,
      parameterDigest,
      baselineExternalOrderId: "virtual-query-order",
      status: "pending",
      nextRunAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(paymentDuplicateProbes)
      .set({
        status: "awaiting_evidence",
        permitConsumedAt: now,
        queryCount: 3,
        protocolVerifiedAt: now,
      })
      .where(eq(paymentDuplicateProbes.taskId, taskId));
  }
  return { merchant, taskId, now, task };
}

beforeEach(async () => {
  owner = await actor();
  other = await actor();
});

describe("owner recovery diagnostics", () => {
  it("returns scheduling and authorization evidence only to the owner, re-redacts decrypted summaries", async () => {
    const { merchant, taskId, now } = await fixture();
    const attemptId = crypto.randomUUID();
    const ciphertext = await encryptString(
      "余额不足 key=DIAGNOSTIC-SECRET https://credit.example/epay/api.php?key=URL-SECRET Basic QVVUSC1TRUNSRVQ=\u0000",
      bindings,
      `payment-diagnostic:${taskId}:${attemptId}`,
    );
    await createDb(env.DB).insert(paymentAttempts).values({
      id: attemptId,
      taskId,
      token: crypto.randomUUID(),
      operation: "send",
      purpose: "probe",
      outcome: "rejected",
      reason: "funds",
      credentialVersion: 1,
      diagnosticCiphertext: ciphertext,
      httpStatus: 400,
      startedAt: now,
      finishedAt: now,
    });
    const path = `/api/me/merchants/${merchant.id}/payments/${taskId}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(path, other)).status).toBe(404);
    const response = await request(path, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = (await response.json()) as { payment: MerchantPaymentDetail };
    expect(data.payment).toMatchObject({
      source: "acceptance",
      usernameCorrection: null,
      nextAction: "query",
      nextSendAt: new Date(now + 120_000).toISOString(),
      nextQueryAt: new Date(now + 60_000).toISOString(),
      sendBlockReason: "quota",
      orderObservedAt: new Date(now).toISOString(),
      orderEvidence: "query",
      retryAuthorization: {
        policy: "same_order_v1",
        maxAdditionalSends: 5,
        usedAdditionalSends: 2,
        revokedAt: null,
      },
      duplicateProbe: null,
      attempts: [
        {
          purpose: "probe",
          diagnosticSummary: "余额不足 key=[redacted] [URL] [auth]",
          httpStatus: 400,
        },
      ],
    });
    expect(JSON.stringify(data)).not.toMatch(
      /DIAGNOSTIC-SECRET|URL-SECRET|QVVUSC1TRUNSRVQ|PRIVATE-CREDENTIAL|ciphertext|parameterDigest|lease_token/,
    );
  });

  it("keeps the original username snapshot and returns append-only correction with actual send identities", async () => {
    const { merchant, taskId, task, now } = await fixture(false, true);
    const db = createDb(env.DB);
    const originalDigest = await paymentParameterDigest(task);
    const correctedUsername = "Virtual_recipient";
    const correctedDigest = await paymentParameterDigest({
      ...task,
      recipientUsername: correctedUsername,
    });
    await db.insert(paymentUsernameCorrections).values({
      taskId,
      originalUsername: "virtual_recipient",
      correctedUsername,
      originalParameterDigest: originalDigest,
      correctedParameterDigest: correctedDigest,
      createdAt: now,
    });
    for (const [index, identity] of [
      {
        operation: "send" as const,
        username: "virtual_recipient",
        digest: originalDigest,
      },
      {
        operation: "send" as const,
        username: correctedUsername,
        digest: correctedDigest,
      },
      { operation: "query" as const, username: null, digest: correctedDigest },
    ].entries()) {
      await db.insert(paymentAttempts).values({
        id: crypto.randomUUID(),
        taskId,
        token: crypto.randomUUID(),
        operation: identity.operation,
        purpose: "recovery",
        outcome: "unknown",
        credentialVersion: 1,
        recipientUsername: identity.username,
        parameterDigest: identity.digest,
        startedAt: now + index,
      });
    }
    const path = `/api/me/merchants/${merchant.id}/payments/${taskId}`;
    expect((await request(path, other)).status).toBe(404);
    const response = await request(path, owner);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = (await response.json()) as { payment: MerchantPaymentDetail };
    expect(data.payment).toMatchObject({
      recipientId: "900001",
      recipientUsername: "virtual_recipient",
      usernameCorrection: {
        originalUsername: "virtual_recipient",
        correctedUsername,
        createdAt: new Date(now).toISOString(),
      },
      attempts: [
        { operation: "query", recipientUsername: null },
        { operation: "send", recipientUsername: correctedUsername },
        { operation: "send", recipientUsername: "virtual_recipient" },
      ],
    });
    expect(
      (
        await db
          .select()
          .from(paymentTasks)
          .where(eq(paymentTasks.id, taskId))
          .get()
      )?.recipientUsername,
    ).toBe("virtual_recipient");
    expect(JSON.stringify(data)).not.toMatch(
      /parameterDigest|ParameterDigest|PRIVATE-CREDENTIAL|ciphertext/,
    );
  });

  it("keeps confirmed payment and active duplicate-probe evidence separate", async () => {
    const { merchant, taskId, now } = await fixture(true);
    const response = await request(
      `/api/me/merchants/${merchant.id}/payments/${taskId}`,
      owner,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      payment: {
        status: "confirmed",
        nextAction: "none",
        nextSendAt: null,
        nextQueryAt: null,
        duplicateProbe: {
          status: "awaiting_evidence",
          baselineExternalOrderId: "virtual-query-order",
          queryCount: 3,
          protocolVerifiedAt: new Date(now).toISOString(),
          backendVerifiedAt: null,
        },
      },
    });
  });

  it("does not expose corrupt or wrong-identity diagnostics and keeps stable attempt pagination", async () => {
    const { merchant, taskId, now } = await fixture();
    const db = createDb(env.DB);
    for (let index = 0; index < 22; index++) {
      const id = crypto.randomUUID();
      const wrongIdentity =
        index === 21
          ? await encryptString(
              "wrong identity secret",
              bindings,
              `payment-diagnostic:${taskId}:another-attempt`,
            )
          : index === 20
            ? "invalid encrypted data"
            : null;
      await db.insert(paymentAttempts).values({
        id,
        taskId,
        token: crypto.randomUUID(),
        operation: "query",
        purpose: "recovery",
        outcome: "unknown",
        credentialVersion: 1,
        startedAt: now + index,
        diagnosticCiphertext: wrongIdentity,
      });
    }
    const path = `/api/me/merchants/${merchant.id}/payments/${taskId}`;
    const first = (await (await request(path, owner)).json()) as {
      payment: MerchantPaymentDetail;
    };
    expect(first.payment.attempts).toHaveLength(20);
    expect(
      first.payment.attempts.every(
        (attempt) => attempt.diagnosticSummary === null,
      ),
    ).toBe(true);
    expect(first.payment.nextAttemptsCursor).not.toBeNull();
    const second = (await (
      await request(
        `${path}?cursor=${encodeURIComponent(first.payment.nextAttemptsCursor ?? "")}`,
        owner,
      )
    ).json()) as { payment: MerchantPaymentDetail };
    expect(second.payment.attempts).toHaveLength(2);
    expect(second.payment.nextAttemptsCursor).toBeNull();
    expect(
      new Set(
        [...first.payment.attempts, ...second.payment.attempts].map(
          (attempt) => attempt.id,
        ),
      ).size,
    ).toBe(22);
    expect((await request(`${path}?cursor=invalid`, owner)).status).toBe(400);
  });

  it("persists manual cooldown without changing send time, business block or upstream query deadline", async () => {
    const { merchant, taskId, task, now } = await fixture();
    const wake = vi.fn(
      async () =>
        new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    // This endpoint test cannot reach a real DO or a real upstream transport.
    const runtime: ApiBindings = {
      ...bindings,
      LDC_NETWORK_MODE: "verify",
      MERCHANT_DO: {
        idFromName: env.MERCHANT_DO.idFromName.bind(env.MERCHANT_DO),
        get: () => ({ fetch: wake }),
      } as unknown as ApiBindings["MERCHANT_DO"],
    };
    const path = `/api/me/merchants/${merchant.id}/check`;
    expect((await request(path, other, "POST", runtime)).status).toBe(404);
    expect(
      (
        await request(path, owner, "POST", runtime, {
          "X-CSRF-Token": "incorrect",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(path, owner, "POST", runtime, {
          Origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    const first = await request(path, owner, "POST", runtime);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const admitted = (await first.json()) as {
      accepted: boolean;
      merchant: { paymentCheckNextAt: string };
    };
    expect(admitted.accepted).toBe(true);
    expect(Date.parse(admitted.merchant.paymentCheckNextAt)).toBeGreaterThan(
      Date.now(),
    );
    const second = await request(path, owner, "POST", runtime);
    expect(second.status).toBe(200);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await second.json()).toMatchObject({
      accepted: false,
      merchant: { paymentCheckNextAt: admitted.merchant.paymentCheckNextAt },
    });
    expect(wake).toHaveBeenCalledTimes(1);
    const stored = await createDb(env.DB)
      .select()
      .from(paymentTasks)
      .where(eq(paymentTasks.id, taskId))
      .get();
    expect(stored).toMatchObject({
      nextSendAt: task.nextSendAt,
      sendBlockReason: "quota",
      queryRetryAfterAt: now + 45_000,
      nextQueryAt: now + 45_000,
      nextRunAt: now + 45_000,
    });
    const refreshed = await request(
      `/api/me/merchants/${merchant.id}`,
      owner,
      "GET",
      runtime,
    );
    expect(await refreshed.json()).toMatchObject({
      merchant: { paymentCheckNextAt: admitted.merchant.paymentCheckNextAt },
    });
  });
});
