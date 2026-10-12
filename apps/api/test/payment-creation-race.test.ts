import { env } from "cloudflare:test";
import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeClaimSubmission,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import {
  type DrawPlan,
  publishDrawPlan,
  saveDrawPlan,
} from "../src/activities/draw-service";
import { registerForDraw } from "../src/activities/registration-service";
import { createActivity, openActivity } from "../src/activities/service";
import { createDb } from "../src/db/client";
import { claims, paymentTasks, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { readMerchantImpact } from "../src/payments/configuration";
import { claimPaymentParameterDigest } from "../src/payments/identity";
import {
  createMerchant,
  ownedMerchant,
  updateMerchant,
} from "../src/payments/merchants";

const live: ApiBindings = {
  ...env,
  APP_ENV: "production",
  LDC_NETWORK_MODE: "live",
  LDC_TIMED_DRAW_ENABLED: "true",
  LDC_STOP_NEW_OPENINGS: "false",
  LDC_STOP_NEW_CLAIMS: "false",
  LDC_STOP_SENDS: "true",
};
const password = "CreationRace123";

async function fixture(money: LdcActivityInput["money"]) {
  const people = Array.from({ length: 4 }, () => {
    const id = crypto.randomUUID();
    return {
      officialConnectVerified: true,
      id,
      externalId: BigInt(`0x${id.replaceAll("-", "").slice(0, 16)}`).toString(),
      username: `Race_${id.slice(0, 8)}`,
      displayName: "隔离并发测试账号",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
  await createDb(env.DB).insert(users).values(people);
  const author = people[0];
  if (!author) throw new Error("Missing fixture author");
  const merchant = await createMerchant(live, author.id, {
    requestId: crypto.randomUUID(),
    clientId: `race_original_${crypto.randomUUID()}`,
    label: "付款创建竞争测试",
    mode: "real",
    secret: "isolated-original-fixture-key",
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE merchant_credentials SET verification_status='passed',verification_checked_at=? WHERE merchant_id=? AND version=1",
    ).bind(Date.now(), merchant.id),
    env.DB.prepare(
      "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=1,allow_real_send=0 WHERE id='global'",
    ),
  ]);
  const base = emptyActivityInput();
  const input: LdcActivityInput = {
    ...base,
    title: "付款创建竞争测试",
    rewardType: "ldc",
    merchantId: merchant.id,
    passwords: [password],
    allocation: "random",
    forceDedicated: true,
    money,
  };
  const draft = await createActivity(live, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  const activity = await openActivity(live, draft.id, author.id, draft.version);
  return { activity, author, merchant, recipients: people.slice(1) };
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT claimed_count,registered_count,draw_state,draw_published_at,
    (SELECT COUNT(*) FROM reward_inventory WHERE activity_id=a.id) AS inventory,
    (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS tasks,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
    FROM activities a WHERE id=?`)
    .bind(activityId)
    .first();
}

async function tasksFor(activityId: string) {
  const rows = await createDb(env.DB)
    .select({ task: paymentTasks })
    .from(paymentTasks)
    .innerJoin(claims, eq(claims.id, paymentTasks.claimId))
    .where(eq(claims.activityId, activityId));
  return rows.map((row) => row.task);
}

async function changeConfiguration(f: Awaited<ReturnType<typeof fixture>>) {
  const merchant = await ownedMerchant(live, f.merchant.id, f.author.id);
  const preview = await readMerchantImpact(live, merchant);
  const result = await updateMerchant(live, f.merchant.id, f.author.id, {
    requestId: crypto.randomUUID(),
    version: merchant.version,
    label: merchant.label,
    clientId: `race_corrected_${crypto.randomUUID()}`,
    secret: "isolated-corrected-fixture-key",
    confirmationToken: preview.confirmationToken,
  });
  return { result, impact: preview.impact };
}

afterEach(() => vi.restoreAllMocks());

describe("payment creation racing normal merchant configuration updates", () => {
  it("rolls back claim allocation and retries the same selected reward with the current application and matching digest", async () => {
    const f = await fixture({ mode: "custom", amounts: ["0.10", "0.30"] });
    const recipient = f.recipients[0];
    if (!recipient) throw new Error("Missing fixture recipient");
    const request = { submissionId: crypto.randomUUID(), password };
    const admitted = await prepareClaimSubmission(
      live,
      f.activity.id,
      recipient.id,
      request,
    );
    const firstReward = await env.DB.prepare(
      "SELECT id FROM reward_inventory WHERE activity_id=? ORDER BY position LIMIT 1",
    )
      .bind(f.activity.id)
      .first<{ id: string }>();
    const random = crypto.getRandomValues.bind(crypto);
    let selections = 0;
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      // A re-draw on merchant-version retry would choose the other amount.
      if (array instanceof Uint32Array && array.length === 1) {
        array[0] = selections++ === 0 ? 0 : 1;
        return array;
      }
      return random(array);
    });
    const originalBatch = env.DB.batch.bind(env.DB);
    let updating = false;
    let inject = true;
    let allocationBatches = 0;
    let changed: Awaited<ReturnType<typeof changeConfiguration>> | undefined;
    const rollbacks: {
      counts: Awaited<ReturnType<typeof counts>>;
      submission: unknown;
    }[] = [];
    const race = vi.spyOn(env.DB, "batch").mockImplementation(async (sql) => {
      if (updating) return originalBatch(sql);
      allocationBatches++;
      if (!inject) return originalBatch(sql);
      inject = false;
      updating = true;
      try {
        changed = await changeConfiguration(f);
      } finally {
        updating = false;
      }
      try {
        return await originalBatch(sql);
      } catch (error) {
        rollbacks.push({
          counts: await counts(f.activity.id),
          submission: await env.DB.prepare(
            "SELECT outcome,claim_id FROM redemption_submissions WHERE id=?",
          )
            .bind(admitted.id)
            .first(),
        });
        throw error;
      }
    });
    const result = await completeClaimSubmission(live, admitted);
    race.mockRestore();

    expect(changed?.impact).toMatchObject({ activeActivities: 1 });
    expect(allocationBatches).toBe(2);
    expect(rollbacks).toEqual([
      {
        counts: expect.objectContaining({
          claimed_count: 0,
          inventory: 2,
          claims: 0,
          tasks: 0,
          outbox: 0,
        }),
        submission: { outcome: "pending", claim_id: null },
      },
    ]);
    expect(result).toMatchObject({
      result: "claimed",
      claim: { amount: "0.10" },
    });
    const claim = await env.DB.prepare(
      "SELECT inventory_id FROM claims WHERE activity_id=? AND user_id=?",
    )
      .bind(f.activity.id, recipient.id)
      .first();
    expect(claim).toEqual({ inventory_id: firstReward?.id });
    const tasks = await tasksFor(f.activity.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task || !changed) throw new Error("Missing persisted race result");
    expect(task).toMatchObject({
      clientId: changed.result.clientId,
      recipientId: recipient.externalId,
      recipientUsername: recipient.username,
      amountMinor: 10,
      recoveryPolicy: "claim_same_order_v1",
      status: "pending",
      attemptCount: 0,
    });
    expect(task.clientId).not.toBe(f.merchant.clientId);
    expect(task.parameterDigest).toBe(await claimPaymentParameterDigest(task));
    const replay = await prepareClaimSubmission(
      live,
      f.activity.id,
      recipient.id,
      request,
    );
    expect(await completeClaimSubmission(live, replay)).toEqual(result);
    expect(await tasksFor(f.activity.id)).toEqual(tasks);
    expect(await counts(f.activity.id)).toMatchObject({
      claimed_count: 1,
      inventory: 2,
      claims: 1,
      tasks: 1,
      outbox: 1,
    });
  });

  it("rolls back draw publication and publishes the unchanged saved winner plan with the current application once", async () => {
    const f = await fixture({
      mode: "timed_draw",
      count: 2,
      totalAmount: "0.90",
      algorithm: "bounded_mean_v1",
      participantLimit: 3,
      countdownSeconds: 600,
      distributeFullPool: true,
    });
    for (const person of f.recipients) {
      expect(
        await registerForDraw(live, f.activity.id, person.id, {
          submissionId: crypto.randomUUID(),
          password,
        }),
      ).toMatchObject({ result: "registered" });
    }
    const saved = await saveDrawPlan(live, f.activity.id);
    if (!saved) throw new Error("Missing fixture drawing plan");
    const plan = JSON.parse(saved.payload) as DrawPlan;
    expect(plan.winners).toHaveLength(2);
    const originalBatch = env.DB.batch.bind(env.DB);
    let updating = false;
    let inject = true;
    let publicationBatches = 0;
    let changed: Awaited<ReturnType<typeof changeConfiguration>> | undefined;
    const rollbacks: {
      counts: Awaited<ReturnType<typeof counts>>;
      payload: string | undefined;
    }[] = [];
    const race = vi.spyOn(env.DB, "batch").mockImplementation(async (sql) => {
      if (updating) return originalBatch(sql);
      publicationBatches++;
      if (!inject) return originalBatch(sql);
      inject = false;
      updating = true;
      try {
        changed = await changeConfiguration(f);
      } finally {
        updating = false;
      }
      try {
        return await originalBatch(sql);
      } catch (error) {
        rollbacks.push({
          counts: await counts(f.activity.id),
          payload: (await saveDrawPlan(live, f.activity.id))?.payload,
        });
        throw error;
      }
    });
    expect(await publishDrawPlan(live, f.activity.id)).toBe(true);
    race.mockRestore();

    expect(changed?.impact).toMatchObject({ unfinishedDraws: 1 });
    expect(publicationBatches).toBe(2);
    expect(rollbacks).toEqual([
      {
        counts: expect.objectContaining({
          draw_state: "settling",
          draw_published_at: null,
          registered_count: 3,
          claimed_count: 0,
          inventory: 0,
          claims: 0,
          tasks: 0,
          outbox: 0,
        }),
        payload: saved.payload,
      },
    ]);
    expect((await saveDrawPlan(live, f.activity.id))?.payload).toBe(
      saved.payload,
    );
    const tasks = await tasksFor(f.activity.id);
    expect(tasks).toHaveLength(2);
    for (const winner of plan.winners) {
      const task = tasks.find((candidate) => candidate.id === winner.taskId);
      const profile = f.recipients.find(
        (person) => person.id === winner.userId,
      );
      if (!task || !profile || !changed)
        throw new Error("Saved winner payment was not published");
      expect(task).toMatchObject({
        claimId: winner.claimId,
        clientId: changed.result.clientId,
        recipientId: winner.recipientId,
        recipientUsername: profile.username,
        amountMinor: winner.amountMinor,
        recoveryPolicy: "claim_same_order_v1",
        status: "pending",
        attemptCount: 0,
      });
      expect(task.parameterDigest).toBe(
        await claimPaymentParameterDigest(task),
      );
      expect(
        await env.DB.prepare("SELECT task_id FROM payment_outbox WHERE id=?")
          .bind(winner.outboxId)
          .first(),
      ).toEqual({ task_id: winner.taskId });
    }
    expect(await publishDrawPlan(live, f.activity.id)).toBe(false);
    expect(await tasksFor(f.activity.id)).toEqual(tasks);
    expect(await counts(f.activity.id)).toMatchObject({
      draw_state: "completed",
      registered_count: 3,
      claimed_count: 2,
      inventory: 2,
      claims: 2,
      tasks: 2,
      outbox: 2,
    });
  });
});
