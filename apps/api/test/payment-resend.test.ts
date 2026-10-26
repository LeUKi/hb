import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  PAYMENT_RESEND_LIMIT,
  PAYMENT_RESEND_WINDOW_MS,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaimDetail } from "../src/activities/claim-queries";
import { ActivityError } from "../src/activities/errors";
import { passwordAssociatedData } from "../src/activities/storage";
import { createDb } from "../src/db/client";
import {
  activities,
  activityPasswords,
  claims,
  merchantCredentials,
  merchants,
  paymentOutbox,
  paymentTasks,
  rewardInventory,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import {
  accountPaymentDetail,
  listAccountPayments,
} from "../src/payments/account-queries";
import type { AdapterResult, PaymentAdapter } from "../src/payments/adapter";
import { claimPaymentParameterDigest } from "../src/payments/policy";
import { endLapsedResends, resendClaimPayment } from "../src/payments/resend";
import { runMerchantCycle } from "../src/payments/scheduler";
import { encryptString } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

// A claim's payment the upstream turned down with 收款人不存在 (the recipient
// has no LINUX DO Credit account): its claimant may send it again within
// five minutes, once; nothing retries it by itself.

let now: number;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  vi.restoreAllMocks();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
  // The upstream is faked below: nothing may reach the forum's hosts.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/linux\.do/u.test(url)) throw new Error(`No upstream in tests: ${url}`);
    return realFetch(input, init);
  });
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
  await env.DB.prepare(
    "UPDATE platform_controls SET version=version+1,allow_real_send=1,updated_at=? WHERE id='global'",
  )
    .bind(now)
    .run();
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const db = createDb(env.DB);
  const owner = crypto.randomUUID(),
    recipient = crypto.randomUUID(),
    stranger = crypto.randomUUID();
  const recipientId = BigInt(
    `0x${recipient.replaceAll("-", "").slice(0, 16)}`,
  ).toString();
  const username = `Receiver_${recipient.slice(0, 8)}`;
  await db.insert(users).values(
    [owner, recipient, stranger].map((id) => ({
      id,
      externalId: id === recipient ? recipientId : id,
      username: id === recipient ? username : id,
      displayName: "本地隔离用户",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
  );
  const merchantId = crypto.randomUUID(),
    clientId = `resend_${crypto.randomUUID()}`;
  await db.insert(merchants).values({
    id: merchantId,
    authorId: owner,
    clientId,
    mode: "real",
    label: "重新发送测试",
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
    verificationStatus: "passed",
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
    title: "重新发送测试红包",
    merchantId,
    paymentMode: "real",
    rewardType: "ldc",
    forceDedicated: false,
    allocation: "sequential",
    config: JSON.stringify({
      ...emptyActivityInput(),
      rewardType: "ldc",
      merchantId,
      money: { mode: "fixed", totalAmount: "0.20", count: 2 },
    }),
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
    ciphertext: await encryptString(
      "测试口令一二",
      env,
      passwordAssociatedData(activityId, passwordId),
    ),
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
    businessNo: `hb.lafi.sh_${claimId.replaceAll("-", "")}`,
    recipientId,
    recipientUsername: username,
    amountMinor: 10,
    mode: "real" as const,
    recoveryPolicy: "claim_same_order_v1" as const,
  };
  await db.insert(paymentTasks).values({
    ...frozen,
    parameterDigest: await claimPaymentParameterDigest(frozen),
    status: "pending",
    nextRunAt: 0,
    createdAt: now - 10,
    updatedAt: now - 1,
  });
  return {
    owner,
    recipient,
    stranger,
    merchantId,
    claimId,
    taskId: frozen.id,
    businessNo: frozen.businessNo,
    clientId,
    bindings: {
      ...env,
      APP_ENV: "production",
      LDC_NETWORK_MODE: "live",
    } as ApiBindings,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The upstream's answer when the recipient has no Credit account. */
const noAccount: AdapterResult = {
  kind: "rejected",
  reason: "recipient",
  httpStatus: 400,
  noOrderEvidence: "protocol_rejection_v1",
};

function upstream(send: AdapterResult, query: AdapterResult): PaymentAdapter {
  return {
    mode: "real",
    send: vi.fn(async () => send),
    query: vi.fn(async () => query),
  };
}
const receipt = (f: Fixture): AdapterResult => ({
  kind: "sent",
  evidence: {
    source: "send",
    businessNo: f.businessNo,
    externalOrderId: "TRADE-RESEND",
  },
});
const confirmation = (f: Fixture): AdapterResult => ({
  kind: "confirmed",
  evidence: {
    source: "query",
    businessNo: f.businessNo,
    clientId: f.clientId,
    amountMinor: 10,
    externalOrderId: "TRADE-RESEND",
    status: 1,
  },
});

async function task(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, f.taskId))
    .get();
  if (!row) throw new Error("No task");
  return row;
}
async function cycle(f: Fixture, adapter: PaymentAdapter) {
  return runMerchantCycle(f.bindings, f.merchantId, {
    adapterFactory: () => adapter,
  });
}
/** On to when the task is next due. */
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
async function resendUntil(f: Fixture) {
  return (await getClaimDetail(f.bindings, f.claimId, f.recipient)).payment
    ?.resendUntil;
}
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ActivityError)) throw new Error("Expected a refusal");
  return { status: error.status, code: error.code, message: error.message };
}

/** Sent, and turned down for want of a Credit account. */
async function turnedDown() {
  const f = await fixture();
  const first = upstream(noAccount, { kind: "not_found" });
  await cycle(f, first);
  const held = await task(f);
  expect(held).toMatchObject({
    status: "attention",
    reason: "recipient",
    sendBlockReason: "recipient",
  });
  expect(first.send).toHaveBeenCalledOnce();
  return { f, rejectedAt: now };
}

describe("sending a payment again for its claimant", () => {
  it("looks the order up, then sends it under the same 业务号, within five minutes", async () => {
    const { f, rejectedAt } = await turnedDown();
    expect(await resendUntil(f)).toBe(
      new Date(rejectedAt + PAYMENT_RESEND_WINDOW_MS).toISOString(),
    );

    now += 60_000;
    await resendClaimPayment(f.bindings, f.recipient, f.claimId);
    expect(await task(f)).toMatchObject({
      status: "reconciling",
      reason: "resend",
      sendBlockReason: null,
      nextAction: "query",
      sendBackoffCount: 0,
    });
    expect(await resendUntil(f)).toBeUndefined();
    const outbox = await createDb(env.DB)
      .select()
      .from(paymentOutbox)
      .where(eq(paymentOutbox.taskId, f.taskId));
    expect(outbox.filter((row) => row.createdAt === now)).toHaveLength(1);

    // Now with an account: no order under that 业务号, so it goes again.
    const second = upstream(receipt(f), { kind: "not_found" });
    await cycle(f, second);
    expect(second.query).toHaveBeenCalledOnce();
    expect(second.send).not.toHaveBeenCalled();
    expect((await task(f)).nextAction).toBe("send");
    await due(f);
    await cycle(f, second);
    expect(second.send).toHaveBeenCalledOnce();
    expect(vi.mocked(second.send).mock.calls[0]?.[0]).toMatchObject({
      businessNo: f.businessNo,
      amountMinor: 10,
    });
    await due(f);
    await cycle(f, upstream(receipt(f), confirmation(f)));
    expect((await task(f)).status).toBe("confirmed");
  });

  it("is not paid once five minutes have passed", async () => {
    const { f, rejectedAt } = await turnedDown();
    now = rejectedAt + PAYMENT_RESEND_WINDOW_MS;
    expect(await resendUntil(f)).toBeUndefined();
    expect(
      await refusal(resendClaimPayment(f.bindings, f.recipient, f.claimId)),
    ).toEqual({
      status: 409,
      code: "PAYMENT_RESEND_CLOSED",
      message: "重新发送的时间已过（被拒后 5 分钟内有效），这笔不再补发。",
    });
    expect((await task(f)).status).toBe("attention");
  });

  it("is only its claimant's, and only after 收款人不存在", async () => {
    const { f } = await turnedDown();
    expect(
      (await refusal(resendClaimPayment(f.bindings, f.stranger, f.claimId)))
        .status,
    ).toBe(404);

    const other = await fixture();
    await cycle(
      other,
      upstream(
        {
          kind: "rejected",
          reason: "self_payment",
          httpStatus: 400,
          noOrderEvidence: "protocol_rejection_v1",
        },
        { kind: "not_found" },
      ),
    );
    expect(await resendUntil(other)).toBeUndefined();
    expect(
      (
        await refusal(
          resendClaimPayment(other.bindings, other.recipient, other.claimId),
        )
      ).code,
    ).toBe("PAYMENT_RESEND_NOT_NEEDED");
  });

  it("sends once however often it is pressed", async () => {
    const { f } = await turnedDown();
    await resendClaimPayment(f.bindings, f.recipient, f.claimId);
    expect(
      (await refusal(resendClaimPayment(f.bindings, f.recipient, f.claimId)))
        .code,
    ).toBe("PAYMENT_RESEND_NOT_NEEDED");
    const outbox = await createDb(env.DB)
      .select()
      .from(paymentOutbox)
      .where(eq(paymentOutbox.taskId, f.taskId));
    expect(outbox).toHaveLength(1);
  });

  it("goes again only once", async () => {
    const { f } = await turnedDown();
    const again = upstream(noAccount, { kind: "not_found" });
    for (let round = 0; round < PAYMENT_RESEND_LIMIT; round++) {
      await resendClaimPayment(f.bindings, f.recipient, f.claimId);
      await cycle(f, again);
      await due(f);
      await cycle(f, again);
      expect((await task(f)).status).toBe("attention");
    }
    expect(again.send).toHaveBeenCalledTimes(PAYMENT_RESEND_LIMIT);
    expect(await resendUntil(f)).toBeUndefined();
    expect(
      await refusal(resendClaimPayment(f.bindings, f.recipient, f.claimId)),
    ).toMatchObject({
      code: "PAYMENT_RESEND_CLOSED",
      message: "已经重新发送过一次，这笔不再补发。",
    });
  });

  it("is never sent again by itself", async () => {
    const { f } = await turnedDown();
    const later = upstream(receipt(f), { kind: "not_found" });
    for (let hour = 0; hour < 3; hour++) {
      now += 3_600_000;
      await cycle(f, later);
    }
    expect(later.send).not.toHaveBeenCalled();
    expect(later.query).not.toHaveBeenCalled();
    expect((await task(f)).status).toBe("attention");
  });
});

describe("a payment past its resend", () => {
  it("ends 未发出 once five minutes have passed, and reads so everywhere", async () => {
    const { f, rejectedAt } = await turnedDown();
    now = rejectedAt + PAYMENT_RESEND_WINDOW_MS - 1;
    expect(await endLapsedResends(f.bindings)).toBe(0);
    expect((await task(f)).status).toBe("attention");

    now = rejectedAt + PAYMENT_RESEND_WINDOW_MS;
    expect(await endLapsedResends(f.bindings)).toBe(1);
    expect(await task(f)).toMatchObject({
      status: "failed",
      reason: "recipient",
      sendBlockReason: "recipient",
      nextAction: "none",
    });
    expect(await endLapsedResends(f.bindings)).toBe(0);
    // Its claimant: 未发出, and still why.
    expect(
      (await getClaimDetail(f.bindings, f.claimId, f.recipient)).payment,
    ).toMatchObject({ status: "failed", reason: "recipient" });
    expect(await resendUntil(f)).toBeUndefined();
    expect(
      await refusal(resendClaimPayment(f.bindings, f.recipient, f.claimId)),
    ).toMatchObject({
      code: "PAYMENT_RESEND_CLOSED",
      message: "重新发送的时间已过（被拒后 5 分钟内有效），这笔不再补发。",
    });
    // Its sender: over, not 未完成 and not 异常待处理.
    const all = await listAccountPayments(f.bindings, f.owner);
    expect(all.summary).toMatchObject({
      openCount: 0,
      openAmount: "0.00",
      attentionCount: 0,
      failedCount: 1,
    });
    expect(all.total).toBe(1);
    expect(all.items.map((item) => item.status)).toEqual(["failed"]);
    expect(
      (await listAccountPayments(f.bindings, f.owner, "open")).items,
    ).toHaveLength(0);
    const failed = await listAccountPayments(f.bindings, f.owner, "failed");
    expect(failed.total).toBe(1);
    expect(failed.items.map((item) => item.id)).toEqual([f.taskId]);
    expect(
      (await accountPaymentDetail(f.bindings, f.owner, f.taskId)).payment,
    ).toMatchObject({ status: "failed", nextAction: "none" });
    // Nothing moves it again.
    const later = upstream(receipt(f), { kind: "not_found" });
    now += 3_600_000;
    await cycle(f, later);
    expect(later.send).not.toHaveBeenCalled();
    expect((await task(f)).status).toBe("failed");
  });

  it("ends one sent again and refused again on the next run", async () => {
    const { f } = await turnedDown();
    const again = upstream(noAccount, { kind: "not_found" });
    await resendClaimPayment(f.bindings, f.recipient, f.claimId);
    // Being sent again: not over.
    expect(await endLapsedResends(f.bindings)).toBe(0);
    await cycle(f, again);
    await due(f);
    await cycle(f, again);
    expect((await task(f)).status).toBe("attention");
    expect(await endLapsedResends(f.bindings)).toBe(1);
    expect((await task(f)).status).toBe("failed");
    expect(
      await refusal(resendClaimPayment(f.bindings, f.recipient, f.claimId)),
    ).toMatchObject({
      code: "PAYMENT_RESEND_CLOSED",
      message: "已经重新发送过一次，这笔不再补发。",
    });
  });

  it("is refused by the database for a claim's payment held for anything else", async () => {
    const waiting = await fixture();
    await expect(
      env.DB.prepare("UPDATE payment_tasks SET status='failed' WHERE id=?")
        .bind(waiting.taskId)
        .run(),
    ).rejects.toThrow(/observed real payment evidence cannot be cleared/u);

    const other = await fixture();
    await cycle(
      other,
      upstream(
        {
          kind: "rejected",
          reason: "self_payment",
          httpStatus: 400,
          noOrderEvidence: "protocol_rejection_v1",
        },
        { kind: "not_found" },
      ),
    );
    expect((await task(other)).status).toBe("attention");
    now += 3_600_000;
    expect(await endLapsedResends(other.bindings)).toBe(0);
    await expect(
      env.DB.prepare("UPDATE payment_tasks SET status='failed' WHERE id=?")
        .bind(other.taskId)
        .run(),
    ).rejects.toThrow(/observed real payment evidence cannot be cleared/u);
  });
});
