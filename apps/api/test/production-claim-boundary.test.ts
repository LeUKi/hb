import { env } from "cloudflare:test";
import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  claimActivity,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";

const runtime: ApiBindings = {
  ...env,
  APP_ENV: "production",
  LDC_NETWORK_MODE: "live",
};

async function actor() {
  const id = crypto.randomUUID(),
    now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 15)}`).toString(),
      username: `User_${id.slice(0, 8)}`,
      displayName: "claim boundary test",
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

async function permission(allowed: boolean) {
  await env.DB.prepare(
    "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=?,updated_at=? WHERE id='global'",
  )
    .bind(Number(allowed), Date.now())
    .run();
}

async function fixture() {
  await permission(true);
  const owner = await actor(),
    recipient = await actor();
  const merchant = await createMerchant(runtime, owner, {
    requestId: crypto.randomUUID(),
    mode: "real",
    clientId: `mock_${crypto.randomUUID()}`,
    label: "isolated real claim boundary",
    secret: "TEST-ONLY-NOT-A-REAL-CREDENTIAL",
  });
  await env.DB.prepare(
    "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=1",
  )
    .bind(Date.now(), merchant.id)
    .run();
  const {
    rewards: _rewards,
    rewardType: _rewardType,
    ...base
  } = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    title: "validation pause race",
    rewardType: "ldc",
    merchantId: merchant.id,
    forceDedicated: true,
    passwords: ["Correct123"],
    money: { mode: "fixed", totalAmount: "0.30", count: 3 },
  };
  const draft = await createActivity(runtime, owner, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  const activity = await openActivity(runtime, draft.id, owner, draft.version);
  return { activity, recipient };
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT version,claimed_count AS allocated,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=?) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=?) AS events,
    (SELECT COUNT(*) FROM claims WHERE activity_id=?) AS claims,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS tasks
    FROM activities WHERE id=?`)
    .bind(activityId, activityId, activityId, activityId, activityId)
    .first();
}

afterEach(() => vi.restoreAllMocks());

it.each(["Correct123", "Wrong123"])(
  "returns a stable conflict and rolls validation back when allocation is paused mid-request (%s)",
  async (password) => {
    const { activity, recipient } = await fixture();
    const input = { submissionId: crypto.randomUUID(), password };
    const batch = env.DB.batch.bind(env.DB);
    const intercepted = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await permission(false);
        return batch(statements);
      });
    await expect(
      prepareClaimSubmission(runtime, activity.id, recipient, input),
    ).rejects.toMatchObject({ status: 409, code: "REAL_LDC_CLAIMS_PAUSED" });
    expect(intercepted).toHaveBeenCalledTimes(1);
    expect(await counts(activity.id)).toEqual({
      version: activity.version,
      allocated: 0,
      submissions: 0,
      events: 0,
      claims: 0,
      tasks: 0,
    });
    intercepted.mockRestore();
    await permission(true);
    const result = await claimActivity(runtime, activity.id, recipient, input);
    const allocated = Number(password === "Correct123");
    expect(result.result).toBe(allocated ? "claimed" : "incorrect");
    expect(await counts(activity.id)).toEqual({
      version: activity.version,
      allocated,
      submissions: 1,
      events: 1,
      claims: allocated,
      tasks: allocated,
    });
  },
);
