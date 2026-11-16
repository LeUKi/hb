import { env } from "cloudflare:test";
import { emptyActivityInput, PAYOUT_FUNDS_WAIT_MS } from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaimDetail } from "../src/activities/claim-queries";
import { ActivityError } from "../src/activities/errors";
import { getPublicActivity } from "../src/activities/service";
import { passwordAssociatedData } from "../src/activities/storage";
import { createDb } from "../src/db/client";
import {
  activities,
  activityPasswords,
  claims,
  merchantCredentials,
  merchants,
  paymentTasks,
  rewardInventory,
  users,
} from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import type { AdapterResult, PaymentAdapter } from "../src/payments/adapter";
import {
  assertMerchantFunded,
  sweepFundsWaits,
} from "../src/payments/funds-stop";
import { claimPaymentParameterDigest } from "../src/payments/policy";
import { publicationEligibility } from "../src/payments/publication";
import { runMerchantCycle } from "../src/payments/scheduler";
import { encryptString } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

// 奖励发放：余额不足终止 (docs/payout-stop-design.md): a merchant whose Credit
// balance ran short waits three days from its first 余额不足; a payment
// through ends the wait; past it, what was never sent stops (failed, funds),
// its open 红包 end, and the sender and each claimant are told.

let now: number;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  vi.restoreAllMocks();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/linux\.do/u.test(url)) throw new Error(`No upstream in tests: ${url}`);
    return realFetch(input, init);
  });
  await env.DB.batch(
    [
      "notifications",
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

/** A merchant's open 红包 with two claims, each a payment waiting to go. */
async function fixture() {
  const db = createDb(env.DB);
  const owner = crypto.randomUUID();
  const people = [crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(users).values(
    [owner, ...people].map((id, index) => ({
      id,
      externalId: String(100 + index),
      username: `funds_${index}`,
      displayName: "本地隔离用户",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
  );
  const merchantId = crypto.randomUUID(),
    clientId = `funds_${crypto.randomUUID()}`;
  await db.insert(merchants).values({
    id: merchantId,
    authorId: owner,
    clientId,
    mode: "real",
    label: "余额不足测试",
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
  const activityId = crypto.randomUUID();
  await db.insert(activities).values({
    id: activityId,
    authorId: owner,
    creationRequestId: crypto.randomUUID(),
    creationDigest: "test",
    title: "余额不足测试红包",
    merchantId,
    paymentMode: "real",
    rewardType: "ldc",
    forceDedicated: false,
    allocation: "sequential",
    config: JSON.stringify({
      ...emptyActivityInput(),
      rewardType: "ldc",
      merchantId,
      money: { mode: "fixed", totalAmount: "0.30", count: 3 },
    }),
    totalCount: 3,
    claimedCount: 2,
    createdAt: now - 100,
    updatedAt: now - 1,
    openedAt: now - 50,
    deadline: now + 30 * 86_400_000,
  });
  const passwordId = crypto.randomUUID();
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
  const tasks: string[] = [];
  const claimIds: string[] = [];
  for (const [index, person] of people.entries()) {
    const inventoryId = crypto.randomUUID(),
      claimId = crypto.randomUUID();
    await db.insert(rewardInventory).values({
      id: inventoryId,
      activityId,
      position: index,
      kind: "ldc",
      amountMinor: 10,
      createdAt: now,
    });
    await db.insert(claims).values({
      id: claimId,
      activityId,
      userId: person,
      inventoryId,
      passwordId,
      claimedAt: now + index,
    });
    const frozen = {
      id: crypto.randomUUID(),
      source: "claim" as const,
      claimId,
      acceptanceId: null,
      merchantId,
      clientId,
      businessNo: `hb.lafi.sh_${claimId.replaceAll("-", "")}`,
      recipientId: String(100 + index + 1),
      recipientUsername: `funds_${index + 1}`,
      amountMinor: 10,
      mode: "real" as const,
      recoveryPolicy: "claim_same_order_v1" as const,
    };
    await db.insert(paymentTasks).values({
      ...frozen,
      parameterDigest: await claimPaymentParameterDigest(frozen),
      status: "pending",
      nextRunAt: 0,
      createdAt: now - 10 + index,
      updatedAt: now - 1,
    });
    tasks.push(frozen.id);
    claimIds.push(claimId);
  }
  return {
    owner,
    people,
    merchantId,
    activityId,
    tasks,
    claimIds,
    clientId,
    bindings: {
      ...env,
      APP_ENV: "production",
      LDC_NETWORK_MODE: "live",
    } as ApiBindings,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Credit's answer when the paying account is short. */
const short: AdapterResult = {
  kind: "waiting",
  reason: "funds",
  httpStatus: 400,
  noOrderEvidence: "protocol_rejection_v1",
};

function upstream(send: AdapterResult): PaymentAdapter {
  return {
    mode: "real",
    send: vi.fn(async () => send),
    query: vi.fn(async () => ({ kind: "not_found" }) as AdapterResult),
  };
}
async function task(id: string) {
  const row = await createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, id))
    .get();
  if (!row) throw new Error("No task");
  return row;
}
async function merchant(f: Fixture) {
  const row = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, f.merchantId))
    .get();
  if (!row) throw new Error("No merchant");
  return row;
}
async function cycle(f: Fixture, adapter: PaymentAdapter) {
  return runMerchantCycle(f.bindings, f.merchantId, {
    adapterFactory: () => adapter,
  });
}
async function notices() {
  return (
    await env.DB.prepare(
      "SELECT user_id AS userId, kind, dedupe_key AS dedupeKey FROM notifications ORDER BY created_at, dedupe_key",
    ).all<{ userId: string; kind: string; dedupeKey: string }>()
  ).results;
}
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ActivityError)) throw new Error("Expected a refusal");
  return { status: error.status, code: error.code, message: error.message };
}

/** The first payment sent and turned down: 余额不足. */
async function shortOfFunds() {
  const f = await fixture();
  await cycle(f, upstream(short));
  const [head] = f.tasks;
  expect(await task(head ?? "")).toMatchObject({
    status: "waiting",
    reason: "funds",
  });
  return { f, shortAt: now };
}

describe("a merchant short of funds", () => {
  it("waits from its first 余额不足: claims pause, opening is refused, the sender hears once", async () => {
    const { f, shortAt } = await shortOfFunds();
    now += 60_000;
    expect(await sweepFundsWaits(f.bindings)).toBe(0);
    const row = await merchant(f);
    expect(row.fundsWaitSince).toBe(shortAt);
    expect(row.fundsNoticedAt).toBe(shortAt);
    expect(await notices()).toEqual([
      {
        userId: f.owner,
        kind: "payout_stuck",
        dedupeKey: `payout_waiting:${f.merchantId}:${shortAt}`,
      },
    ]);
    await sweepFundsWaits(f.bindings);
    expect(await notices()).toHaveLength(1);

    // Both claimants: 发放暂停 with its time, the queued one too.
    for (const [index, claimId] of f.claimIds.entries()) {
      expect(
        (await getClaimDetail(f.bindings, claimId, f.people[index] ?? ""))
          .payment,
      ).toMatchObject({
        status: "waiting",
        reason: "funds",
        fundsStopAt: new Date(shortAt + PAYOUT_FUNDS_WAIT_MS).toISOString(),
      });
    }
    // The 红包: claims wait, its page says until when.
    expect(
      await refusal(
        assertMerchantFunded(f.bindings, {
          funding: "merchant",
          merchantId: f.merchantId,
        }),
      ),
    ).toMatchObject({ status: 409, code: "MERCHANT_FUNDS_PAUSED" });
    expect(
      (await getPublicActivity(f.bindings, f.activityId)).fundsPaused,
    ).toEqual({
      stopAt: new Date(shortAt + PAYOUT_FUNDS_WAIT_MS).toISOString(),
    });
    // No new 红包 on it.
    expect(
      (await publicationEligibility(f.bindings, await merchant(f))).reason,
    ).toBe("MERCHANT_FUNDS_PAUSED");
  });

  it("ends the wait once a payment goes through", async () => {
    const { f } = await shortOfFunds();
    await sweepFundsWaits(f.bindings);
    expect((await merchant(f)).fundsWaitSince).not.toBeNull();
    const [head] = f.tasks;
    const row = await task(head ?? "");
    const paid: PaymentAdapter = {
      mode: "real",
      send: vi.fn(
        async (): Promise<AdapterResult> => ({
          kind: "sent",
          evidence: {
            source: "send",
            businessNo: row.businessNo,
            externalOrderId: "TRADE-FUNDS",
          },
        }),
      ),
      query: vi.fn(
        async (): Promise<AdapterResult> => ({
          kind: "confirmed",
          evidence: {
            source: "query",
            businessNo: row.businessNo,
            clientId: f.clientId,
            amountMinor: 10,
            externalOrderId: "TRADE-FUNDS",
            status: 1,
          },
        }),
      ),
    };
    for (let round = 0; round < 6; round++) {
      const current = await task(head ?? "");
      if (current.status === "confirmed") break;
      now =
        Math.max(
          now,
          current.nextRunAt,
          current.nextSendAt ?? 0,
          current.nextQueryAt ?? 0,
          current.queryRetryAfterAt ?? 0,
        ) + 1;
      await cycle(f, paid);
    }
    expect((await task(head ?? "")).status).toBe("confirmed");
    expect((await merchant(f)).fundsWaitSince).toBeNull();
    // Claims go on: the 红包 takes them again.
    await expect(
      assertMerchantFunded(f.bindings, {
        funding: "merchant",
        merchantId: f.merchantId,
      }),
    ).resolves.toBeUndefined();
  });

  it("three days on: what was never sent stops, the 红包 ends, the sender and each claimant are told", async () => {
    const { f, shortAt } = await shortOfFunds();
    await sweepFundsWaits(f.bindings);
    now = shortAt + PAYOUT_FUNDS_WAIT_MS - 1;
    expect(await sweepFundsWaits(f.bindings)).toBe(0);
    now = shortAt + PAYOUT_FUNDS_WAIT_MS;
    expect(await sweepFundsWaits(f.bindings)).toBe(2);
    for (const id of f.tasks)
      expect(await task(id)).toMatchObject({
        status: "failed",
        reason: "funds",
        sendBlockReason: "funds",
        nextAction: "none",
      });
    expect(await merchant(f)).toMatchObject({
      fundsWaitSince: null,
      activeTaskId: null,
      pausedReason: null,
    });
    const activity = await createDb(env.DB)
      .select()
      .from(activities)
      .where(eq(activities.id, f.activityId))
      .get();
    expect(activity).toMatchObject({ endedAt: now, endReason: "funds" });
    expect(
      (await getPublicActivity(f.bindings, f.activityId)).fundsStopped,
    ).toBe(true);
    expect(
      (await getClaimDetail(f.bindings, f.claimIds[1] ?? "", f.people[1] ?? ""))
        .payment,
    ).toMatchObject({ status: "failed", reason: "funds" });
    const told = await notices();
    expect(told.map((row) => [row.userId, row.kind])).toEqual(
      expect.arrayContaining([
        [f.owner, "payout_stuck"],
        [f.owner, "payout_stopped"],
        [f.people[0], "payout_failed"],
        [f.people[1], "payout_failed"],
      ]),
    );
    expect(told).toHaveLength(4);
    // Nothing moves it again, nor tells anyone twice.
    expect(await sweepFundsWaits(f.bindings)).toBe(0);
    expect(await notices()).toHaveLength(4);
  });

  it("never stops a payment whose result is unknown", async () => {
    const { f, shortAt } = await shortOfFunds();
    await sweepFundsWaits(f.bindings);
    const [head, queued] = f.tasks;
    await env.DB.prepare(
      "UPDATE payment_tasks SET status='reconciling',reason='unknown',unknown_outcome=1 WHERE id=?",
    )
      .bind(head)
      .run();
    now = shortAt + PAYOUT_FUNDS_WAIT_MS;
    expect(await sweepFundsWaits(f.bindings)).toBe(1);
    expect((await task(head ?? "")).status).toBe("reconciling");
    expect((await task(queued ?? "")).status).toBe("failed");
  });
});
