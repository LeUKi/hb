import { env } from "cloudflare:test";
import {
  type ActivityProofData,
  DRAND_QUICKNET,
  drandRoundAfter,
  drandRoundAt,
  drawPlanV2,
  drawSeed,
  emptyActivityInput,
  type LdcActivityInput,
  type LdcMoney,
  queueAmountsV2,
  queueCommitment,
  queueSeed,
  rosterHash,
  type TimedDrawMoney,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { refreshTimedDraw } from "../src/activities/draw-service";
import { drandTime, drawRetryAt } from "../src/activities/random-proof";
import { registerForDraw } from "../src/activities/registration-service";
import {
  createActivity,
  getPublicActivity,
  openActivity,
} from "../src/activities/service";
import { findActivity } from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { decryptString } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";
import { fakeDrandRound } from "./setup";

// 开奖证明 v2 (docs/draw-proof-design.md).
const bindings: ApiBindings = { ...env, LDC_TIMED_DRAW_ENABLED: "true" };
let ownerId: string;
let people: string[];
let merchantId: string;

async function person(index: number) {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: String(7000 + index),
      username: `proof${index}`,
      displayName: `证明 ${index}`,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

function input(
  money: LdcMoney,
  extra: Partial<LdcActivityInput> = {},
): LdcActivityInput {
  const { rewardType: _rewardType, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "开奖证明",
    passwords: ["proofkey1"],
    rewardType: "ldc",
    merchantId,
    allocation: "random",
    money,
    ...extra,
  };
}

async function open(money: LdcMoney, extra: Partial<LdcActivityInput> = {}) {
  const saved = await createActivity(bindings, ownerId, {
    requestId: crypto.randomUUID(),
    activity: input(money, extra),
  });
  return openActivity(bindings, saved.id, ownerId, saved.version);
}

async function proofData(id: string) {
  const response = await app.request(
    `https://hb.example.com/api/activities/${id}/proof`,
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ActivityProofData;
}

async function claimAs(id: string, userId: string) {
  const result = await claimActivity(bindings, id, userId, {
    submissionId: crypto.randomUUID(),
    password: "proofkey1",
  });
  await advanceAttemptCooldown(env.DB, userId);
  return result;
}

async function secretOf(id: string) {
  const row = await env.DB.prepare(
    "SELECT secret_ciphertext FROM activity_random_proofs WHERE activity_id=?",
  )
    .bind(id)
    .first<{ secret_ciphertext: string }>();
  if (!row) throw new Error("Missing sealed queue");
  return decryptString(row.secret_ciphertext, bindings, `random-proof:${id}`);
}

async function inventory(id: string) {
  return (
    await env.DB.prepare(
      "SELECT amount_minor FROM reward_inventory WHERE activity_id=? ORDER BY position",
    )
      .bind(id)
      .all<{ amount_minor: number }>()
  ).results.map((row) => row.amount_minor);
}

const timed: TimedDrawMoney = {
  mode: "timed_draw",
  algorithm: "double_mean_v1",
  totalAmount: "3.00",
  count: 2,
  participantLimit: 4,
  countdownSeconds: 86400,
  distributeFullPool: false,
};

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "simulation_orders",
      "simulation_controls",
      "merchant_credentials",
      "global_redemptions",
      "attempt_events",
      "redemption_submissions",
      "activity_draw_plans",
      "activity_registrations",
      "claims",
      "reward_inventory",
      "activity_passwords",
      "activities",
      "merchants",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  ownerId = await person(0);
  people = await Promise.all([1, 2, 3, 4].map(person));
  merchantId = (
    await createMerchant(bindings, ownerId, {
      requestId: crypto.randomUUID(),
      clientId: "proof_app",
      label: "虚拟商户",
      secret: "fake-only",
    })
  ).id;
});

// test/setup.ts runs draws ahead of the clock; a test may set it back.
let setupDrandTime = drandTime.now;
beforeEach(() => {
  setupDrandTime = drandTime.now;
});
afterEach(() => {
  drandTime.now = setupDrandTime;
  vi.restoreAllMocks();
});

describe("拼手气 and 自定义 in random order: a queue sealed at opening", () => {
  it("seals the queue, hands it out in order and shows the secret only at the end", async () => {
    const money: LdcMoney = {
      mode: "random",
      algorithm: "double_mean_v1",
      totalAmount: "5.00",
      count: 3,
    };
    const activity = await open(money);
    const row = await findActivity(bindings, activity.id);
    expect(row?.randomVersion).toBe(2);
    const secret = await secretOf(activity.id);
    const commitment = queueCommitment(activity.id, secret);
    const queue = queueAmountsV2({
      seed: queueSeed(activity.id, secret),
      money,
    });
    expect(await inventory(activity.id)).toEqual(queue);
    expect((await getPublicActivity(bindings, activity.id)).drawProof).toEqual({
      kind: "queue",
      commitment,
    });
    // Nothing of the queue before the end, nor on the author's own pages.
    const before = await proofData(activity.id);
    expect(before).toMatchObject({
      kind: "queue",
      commitment,
      secret: null,
      queue: null,
    });
    expect(JSON.stringify(before)).not.toContain(secret);
    await expect(
      env.DB.prepare(
        "UPDATE activity_random_proofs SET secret=?,revealed_at=1 WHERE activity_id=?",
      )
        .bind(secret, activity.id)
        .run(),
    ).rejects.toThrow("immutable_random_proof");
    await expect(
      env.DB.prepare(
        "UPDATE reward_inventory SET amount_minor=amount_minor WHERE activity_id=?",
      )
        .bind(activity.id)
        .run(),
    ).rejects.toThrow("immutable_queue");

    const claimed = [];
    for (const userId of people.slice(0, 3))
      claimed.push(await claimAs(activity.id, userId));
    expect(
      claimed.map((result) =>
        "claim" in result ? result.claim.amount : undefined,
      ),
    ).toEqual(queue.map((amount) => (amount / 100).toFixed(2)));

    const after = await proofData(activity.id);
    if (after.kind !== "queue") throw new Error("Missing queue proof");
    expect(after.secret).toBe(secret);
    expect(after.queue?.map((item) => item.amountMinor)).toEqual(queue);
    expect(after.queue?.map((item) => item.claim?.user.username)).toEqual([
      "proof1",
      "proof2",
      "proof3",
    ]);
    // Shown once, then fixed.
    await expect(
      env.DB.prepare(
        "UPDATE activity_random_proofs SET secret=? WHERE activity_id=?",
      )
        .bind("0".repeat(64), activity.id)
        .run(),
    ).rejects.toThrow("immutable_random_proof");
    await expect(
      env.DB.prepare("DELETE FROM activity_random_proofs WHERE activity_id=?")
        .bind(activity.id)
        .run(),
    ).rejects.toThrow("immutable_random_proof");
  });

  it("reorders a 自定义's own amounts, and leaves the unclaimed ones listed", async () => {
    const money: LdcMoney = {
      mode: "custom",
      amounts: ["1.00", "2.00", "3.00", "4.00"],
    };
    const activity = await open(money);
    const secret = await secretOf(activity.id);
    const queue = queueAmountsV2({
      seed: queueSeed(activity.id, secret),
      money,
    });
    expect([...queue].sort()).toEqual([100, 200, 300, 400]);
    expect(await inventory(activity.id)).toEqual(queue);
    await claimAs(activity.id, people[0] ?? "");
    await env.DB.prepare(
      "UPDATE activities SET deadline=CAST(unixepoch('now')*1000 AS INTEGER)-1000 WHERE id=?",
    )
      .bind(activity.id)
      .run();
    const after = await proofData(activity.id);
    if (after.kind !== "queue") throw new Error("Missing queue proof");
    expect(after.secret).toBe(secret);
    expect(
      after.queue?.map((item) => [item.amountMinor, item.claim !== null]),
    ).toEqual(queue.map((amount, index) => [amount, index === 0]));
  });

  it("leaves fixed amounts and in-order 自定义 as they were", async () => {
    const cases: [LdcMoney, LdcActivityInput["allocation"]][] = [
      [{ mode: "fixed", totalAmount: "2.00", count: 2 }, "random"],
      [{ mode: "custom", amounts: ["1.00", "2.00"] }, "sequential"],
    ];
    for (const [money, allocation] of cases) {
      const activity = await open(money, { allocation });
      expect((await findActivity(bindings, activity.id))?.randomVersion).toBe(
        null,
      );
      expect(
        (await getPublicActivity(bindings, activity.id)).drawProof,
      ).toBeUndefined();
      expect(await proofData(activity.id)).toEqual({ kind: "none" });
    }
  });
});

describe("限时开奖: the drand round right after closing", () => {
  async function fullDraw() {
    const activity = await open(timed, {
      forceDedicated: true,
      joinSquare: true,
    });
    for (const userId of people)
      await registerForDraw(bindings, activity.id, userId, {
        submissionId: crypto.randomUUID(),
        password: "proofkey1",
      });
    const closed = await findActivity(bindings, activity.id);
    if (closed?.drawState !== "settling" || closed.drawClosedAt === null)
      throw new Error("Draw did not close");
    return { activity, closedAt: closed.drawClosedAt };
  }

  it("draws from the round after closing and the frozen roster, as anyone can redo", async () => {
    const { activity, closedAt } = await fullDraw();
    const waiting = await getPublicActivity(bindings, activity.id);
    const round = drandRoundAfter(closedAt);
    expect(waiting.drawProof).toEqual({
      kind: "draw",
      round,
      roundAt: new Date(drandRoundAt(round)).toISOString(),
    });
    await refreshTimedDraw(bindings, activity.id);
    expect((await findActivity(bindings, activity.id))?.drawState).toBe(
      "completed",
    );
    const data = await proofData(activity.id);
    if (data.kind !== "draw") throw new Error("Missing draw proof");
    const entries = data.roster.entries.map((entry) => ({
      ordinal: entry.ordinal,
      registrationId: entry.registrationId,
    }));
    expect(data.roster.entries.map((entry) => entry.user.username)).toEqual([
      "proof1",
      "proof2",
      "proof3",
      "proof4",
    ]);
    expect(data.roster.hash).toBe(rosterHash(entries));
    const drand = fakeDrandRound(round);
    expect(data.drand).toEqual({
      chainHash: DRAND_QUICKNET.chainHash,
      round,
      roundAt: new Date(drandRoundAt(round)).toISOString(),
      randomness: drand.randomness,
      signature: drand.signature,
    });
    const seed = drawSeed({
      activityId: activity.id,
      rosterHash: data.roster.hash,
      round,
      randomness: drand.randomness,
    });
    expect(data.seed).toBe(seed);
    const plan = drawPlanV2({ seed, registered: 4, money: timed });
    expect(data.result).toEqual({
      picked: plan.picked,
      amounts: plan.amounts,
      winners: plan.winners,
    });
    expect((await getPublicActivity(bindings, activity.id)).drawProof).toEqual({
      kind: "draw",
      round,
      roundAt: new Date(drandRoundAt(round)).toISOString(),
      rosterHash: data.roster.hash,
    });
    const policy = await env.DB.prepare(
      "SELECT json_extract(payload,'$.policy') AS policy FROM activity_draw_plans WHERE activity_id=?",
    )
      .bind(activity.id)
      .first();
    expect(policy).toEqual({ policy: "timed_draw_v2" });
  });

  it("waits for its round without asking a node early, then retries the next node", async () => {
    drandTime.now = () => Date.now();
    const node = globalThis.fetch;
    const fetch = vi.spyOn(globalThis, "fetch");
    const { activity } = await fullDraw();
    await refreshTimedDraw(bindings, activity.id);
    const proof = await env.DB.prepare(
      "SELECT round,round_at,randomness FROM activity_random_proofs WHERE activity_id=?",
    )
      .bind(activity.id)
      .first<{ round: number; round_at: number; randomness: string | null }>();
    expect(proof?.randomness).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const row = await findActivity(bindings, activity.id);
    if (!row || !proof) throw new Error("Missing draw");
    expect(row.drawState).toBe("settling");
    expect(await drawRetryAt(bindings, row)).toBe(proof.round_at + 500);

    // The round is out; the first node fails, the next one answers.
    const nodes = {
      ...bindings,
      DRAND_URLS: "https://down.test,https://drand.test",
    };
    drandTime.now = () => proof.round_at + 600;
    fetch.mockImplementation(async (request, init) => {
      if (String(request).startsWith("https://down.test"))
        return new Response(null, { status: 404 });
      return node(request, init);
    });
    await refreshTimedDraw(nodes, activity.id);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual([
      "down.test",
      "drand.test",
    ]);
    expect((await findActivity(bindings, activity.id))?.drawState).toBe(
      "completed",
    );
  });

  it("never takes a round whose randomness is not its signature's", async () => {
    const { activity } = await fullDraw();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ...fakeDrandRound(1), randomness: "0".repeat(64) }),
    );
    await refreshTimedDraw(bindings, activity.id);
    expect((await findActivity(bindings, activity.id))?.drawState).toBe(
      "settling",
    );
    const proof = await env.DB.prepare(
      "SELECT randomness FROM activity_random_proofs WHERE activity_id=?",
    )
      .bind(activity.id)
      .first();
    expect(proof).toEqual({ randomness: null });
  });

  it("fixes the round and roster at closing, and the version at opening", async () => {
    const { activity, closedAt } = await fullDraw();
    await refreshTimedDraw(bindings, activity.id);
    for (const change of [
      "round=round+1",
      "roster_hash=?1",
      "randomness=?1",
      "seed=?1",
    ])
      await expect(
        env.DB.prepare(
          `UPDATE activity_random_proofs SET ${change} WHERE activity_id=?2`,
        )
          .bind("f".repeat(64), activity.id)
          .run(),
      ).rejects.toThrow("immutable_random_proof");
    await expect(
      env.DB.prepare("UPDATE activities SET random_version=NULL WHERE id=?")
        .bind(activity.id)
        .run(),
    ).rejects.toThrow("immutable_random_version");
    // Only the round right after closing.
    await expect(
      env.DB.prepare(`INSERT INTO activity_random_proofs(activity_id,kind,version,round,round_at,roster_hash,roster_count,created_at)
        VALUES (?, 'draw', 2, ?, ?, ?, 4, 0)`)
        .bind(
          crypto.randomUUID(),
          drandRoundAfter(closedAt) + 1,
          drandRoundAt(drandRoundAfter(closedAt) + 1),
          "a".repeat(64),
        )
        .run(),
    ).rejects.toThrow();
  });
});
