import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type ManagedActivity,
  type PasswordClaimInput,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeClaimSubmission,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import { registerForDraw } from "../src/activities/registration-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant, updateMerchant } from "../src/payments/merchants";

const bindings: ApiBindings = { ...env, LDC_TIMED_DRAW_ENABLED: "true" };
// The active-account guard turns the write into NULL, aborting the whole batch.
const guardAbort = /NOT NULL constraint failed/;
let password = "Disabled123";
let owner: string;
let participant: string;
let merchantId: string;

async function account() {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 16)}`).toString(),
      username: `Deactivation_${id.slice(0, 8)}`,
      displayName: "停用账号测试",
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

function submission(): PasswordClaimInput {
  return { submissionId: crypto.randomUUID(), password };
}

function ldc(timed = false): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "停用账号 LDC 测试",
    rewardType: "ldc",
    passwords: [password, "SecondOff123"],
    merchantId,
    allocation: timed ? "random" : "sequential",
    forceDedicated: false,
    money: timed
      ? {
          mode: "timed_draw",
          totalAmount: "1.00",
          count: 2,
          participantLimit: null,
          countdownSeconds: 600,
          algorithm: "double_mean_v1",
          distributeFullPool: true,
        }
      : { mode: "fixed", totalAmount: "1.00", count: 4 },
  };
}

async function activity(
  input: LdcActivityInput = ldc(),
  open = true,
): Promise<ManagedActivity> {
  const draft = await createActivity(bindings, owner, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open ? openActivity(bindings, draft.id, owner, draft.version) : draft;
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT claimed_count,registered_count,
    (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=a.id) AS registrations,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=a.id) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=a.id) AS attempts,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS payments,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
    FROM activities a WHERE id=?`)
    .bind(activityId)
    .first();
}

/** Disable the account between the service's reads and its write batch. */
function deactivateBeforeBatch(userId: string) {
  const original = env.DB.batch.bind(env.DB);
  let once = true;
  return vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    if (once) {
      once = false;
      await env.DB.prepare("UPDATE users SET active=0 WHERE id=?")
        .bind(userId)
        .run();
    }
    return original(statements);
  });
}

beforeEach(async () => {
  password = `Off${crypto.randomUUID().slice(0, 8)}`;
  owner = await account();
  participant = await account();
  merchantId = (
    await createMerchant(bindings, owner, {
      requestId: crypto.randomUUID(),
      label: "停用账号测试模拟商户",
      clientId: `deactivation_${crypto.randomUUID()}`,
      secret: "FAKE-DEACTIVATION-ONLY",
    })
  ).id;
});
afterEach(() => vi.restoreAllMocks());

describe("accounts disabled while a write is in flight", () => {
  it("rolls back LDC draft and merchant creation atomically", async () => {
    const create = deactivateBeforeBatch(owner);
    await expect(
      createActivity(bindings, owner, {
        requestId: crypto.randomUUID(),
        activity: ldc(),
      }),
    ).rejects.toThrow(guardAbort);
    create.mockRestore();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activities WHERE author_id=?",
      )
        .bind(owner)
        .first(),
    ).toEqual({ count: 0 });
    const fresh = await account();
    deactivateBeforeBatch(fresh);
    await expect(
      createMerchant(bindings, fresh, {
        requestId: crypto.randomUUID(),
        label: "原子账号检查",
        clientId: `atomic_${fresh}`,
        secret: "FAKE-ATOMIC-KEY",
      }),
    ).rejects.toThrow(guardAbort);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchants WHERE author_id=?",
      )
        .bind(fresh)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rolls back claim validation before its admission batch commits", async () => {
    const saved = await activity({ ...ldc(), forceDedicated: true });
    const before = await counts(saved.id);
    deactivateBeforeBatch(participant);
    await expect(
      prepareClaimSubmission(bindings, saved.id, participant, submission()),
    ).rejects.toThrow(guardAbort);
    expect(await counts(saved.id)).toEqual(before);
  });

  it("rolls back allocation, payment and Outbox after durable validation", async () => {
    const saved = await activity();
    const admitted = await prepareClaimSubmission(
      bindings,
      saved.id,
      participant,
      submission(),
    );
    const before = await counts(saved.id);
    deactivateBeforeBatch(participant);
    await expect(completeClaimSubmission(bindings, admitted)).rejects.toThrow(
      guardAbort,
    );
    expect(await counts(saved.id)).toEqual(before);
  });

  it("rolls back a draw registration and its attempt", async () => {
    const saved = await activity({ ...ldc(true), forceDedicated: true });
    const before = await counts(saved.id);
    deactivateBeforeBatch(participant);
    await expect(
      registerForDraw(bindings, saved.id, participant, submission()),
    ).rejects.toThrow(guardAbort);
    expect(await counts(saved.id)).toEqual(before);
  });

  it("keeps a draft unopened when its author is disabled before publication commits", async () => {
    const draft = await activity(ldc(), false);
    deactivateBeforeBatch(owner);
    await expect(
      openActivity(bindings, draft.id, owner, draft.version),
    ).rejects.toThrow(guardAbort);
    expect(
      await env.DB.prepare(
        "SELECT opened_at,version FROM activities WHERE id=?",
      )
        .bind(draft.id)
        .first(),
    ).toEqual({ opened_at: null, version: draft.version });
    expect(await counts(draft.id)).toMatchObject({
      claims: 0,
      registrations: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("rolls back the credential and permanent client registration of a merchant save", async () => {
    const correctedClientId = `atomic_corrected_${crypto.randomUUID()}`;
    deactivateBeforeBatch(owner);
    await expect(
      updateMerchant(bindings, merchantId, owner, {
        requestId: crypto.randomUUID(),
        version: 1,
        label: "原子保存边界",
        clientId: correctedClientId,
        secret: "FAKE-ATOMIC-REPLACEMENT",
      }),
    ).rejects.toThrow(guardAbort);
    expect(
      await env.DB.prepare(
        "SELECT version,credential_version FROM merchants WHERE id=?",
      )
        .bind(merchantId)
        .first(),
    ).toEqual({ version: 1, credential_version: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_client_ids WHERE client_id=?",
      )
        .bind(correctedClientId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_credentials WHERE merchant_id=?",
      )
        .bind(merchantId)
        .first(),
    ).toEqual({ count: 1 });
  });
});
