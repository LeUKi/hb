import { env } from "cloudflare:test";
import { emptyActivityInput } from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { claimPaymentParameterDigest } from "../src/payments/policy";
import { sweepQuotaFailures } from "../src/payments/quota";
import { runMerchantCycle } from "../src/payments/scheduler";
import { encryptString } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

// 每人上限和每日额度 (docs/payout-cap-design.md §2, §3), on Credit's real
// protocol: a payment the day's limit refused waits for the day to turn
// while smaller ones still go; a share over 800 LDC refused on two days
// ends failed, as the evidence trigger (migration 0076) lets it.
const AMOUNTS = [100_000, 10];
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
    label: "每人上限测试",
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
    title: "每人上限测试红包",
    merchantId,
    paymentMode: "real",
    rewardType: "ldc",
    forceDedicated: false,
    allocation: "sequential",
    config: JSON.stringify({
      ...emptyActivityInput(),
      rewardType: "ldc",
      merchantId,
      largeShares: true,
      money: { mode: "custom", amounts: ["1000.00", "0.10"] },
    }),
    totalCount: 2,
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
      amountMinor: AMOUNTS[index] ?? 10,
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
      amountMinor: AMOUNTS[index] ?? 10,
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

/** Credit's answer once the paying account's day is spent. */
const spent: AdapterResult = {
  kind: "waiting",
  reason: "quota",
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

describe("每人上限和每日额度", () => {
  it("lets smaller ones go the day one is refused, and ends a share over 800 refused on two days", async () => {
    const f = await fixture();
    const [big, small] = f.tasks;
    const a = upstream(spent);
    await cycle(f, a);
    expect(await task(big ?? "")).toMatchObject({
      status: "waiting",
      reason: "quota",
    });
    const day = await merchant(f);
    expect(day).toMatchObject({
      activeTaskId: null,
      quotaBelow: 100_000,
      quotaRefusals: 1,
    });
    // The smaller one is tried the same day, not held behind it.
    await cycle(f, a);
    expect(await task(small ?? "")).toMatchObject({
      attemptCount: 1,
      status: "waiting",
      reason: "quota",
    });
    expect((await merchant(f)).quotaRefusals).toBe(2);
    // Refused once: not yet over.
    expect(await sweepQuotaFailures(f.bindings)).toBe(0);
    // The day turns: the big one is looked up, sent, refused again.
    now = (day.quotaUntil ?? 0) + 1;
    await cycle(f, a);
    await cycle(f, a);
    expect(a.send).toHaveBeenCalledTimes(3);
    expect(await sweepQuotaFailures(f.bindings)).toBe(1);
    expect(await task(big ?? "")).toMatchObject({
      status: "failed",
      reason: "quota",
      sendBlockReason: "quota",
    });
    // The small one is no share over 800: it waits on, never failed.
    await sweepQuotaFailures(f.bindings);
    expect((await task(small ?? "")).status).not.toBe("failed");
  });
});
