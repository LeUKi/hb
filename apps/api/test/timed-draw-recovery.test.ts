import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  type ActivityInput,
  emptyActivityInput,
  type LdcActivityInput,
  type ParticipationList,
  type TimedDrawMoney,
} from "@hb/contracts";
import { describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import {
  type DrawPlan,
  publishDrawPlan,
  refreshTimedDraw,
} from "../src/activities/draw-service";
import { registerForDraw } from "../src/activities/registration-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { runMerchantCycle } from "../src/payments/scheduler";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
const password = "recoverykey";
type Actor = { id: string; cookie: string };

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: id,
    username: `recovery_${id.replaceAll("-", "")}`,
    displayName: "回归测试参与者",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: crypto.randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return { id, cookie: `hb_session=${token}` };
}

async function fixture() {
  const [owner, reader, other] = await Promise.all([actor(), actor(), actor()]);
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `recovery_${owner.id.replaceAll("-", "")}`,
    label: "回归测试虚拟商户",
    secret: "fixture-only-secret",
  });
  return { owner, reader, other, merchant };
}

function timedInput(
  merchantId: string,
  money: Partial<TimedDrawMoney> = {},
): LdcActivityInput {
  const { rewards: _rewards, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "恢复与历史回归测试",
    passwords: [password],
    rewardType: "ldc",
    merchantId,
    allocation: "random",
    afterClaimInfo: "PRIVATE-DRAW-INFORMATION",
    money: {
      mode: "timed_draw",
      algorithm: "double_mean_v1",
      totalAmount: "1.00",
      count: 2,
      participantLimit: 3,
      countdownSeconds: 86_400,
      distributeFullPool: true,
      ...money,
    },
  };
}

async function createOpened(owner: Actor, activity: ActivityInput) {
  const saved = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity,
  });
  return openActivity(bindings, saved.id, owner.id, saved.version);
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT draw_state,draw_published_at,registered_count,claimed_count,
    (SELECT COUNT(*) FROM reward_inventory WHERE activity_id=a.id) AS inventory,
    (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS tasks,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
    FROM activities a WHERE id=?`)
    .bind(activityId)
    .first();
}

async function savedPlan(activityId: string) {
  const row = await env.DB.prepare(
    "SELECT participant_count,payload,created_at FROM activity_draw_plans WHERE activity_id=?",
  )
    .bind(activityId)
    .first<{
      participant_count: number;
      payload: string;
      created_at: number;
    }>();
  if (!row) throw new Error("Missing persisted draw plan");
  return row;
}

async function payouts(activityId: string) {
  return (
    await env.DB.prepare(`SELECT p.id AS taskId,c.id AS claimId,o.id AS outboxId,
      c.user_id AS userId,c.inventory_id AS inventoryId,p.recipient_id AS recipientId,
      p.amount_minor AS amountMinor,p.business_no AS businessNo
      FROM claims c JOIN payment_tasks p ON p.claim_id=c.id
      JOIN payment_outbox o ON o.task_id=p.id WHERE c.activity_id=? ORDER BY p.id`)
      .bind(activityId)
      .all()
  ).results;
}

// Registrations are immutable. Seed the shared timestamp at insertion while
// keeping all production admission guards, ordinals and capacity checks active.
async function seedRegistration(
  activityId: string,
  userId: string,
  time: number,
) {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activity_registrations
      (id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at)
      SELECT ?,a.id,u.id,p.id,a.registered_count+1,'simulation:'||u.external_id,?
      FROM activities a JOIN activity_passwords p ON p.activity_id=a.id
      JOIN users u ON u.id=? WHERE a.id=?`).bind(id, time, userId, activityId),
    env.DB.prepare(`UPDATE activities SET registered_count=registered_count+1,
      draw_state=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'settling' ELSE draw_state END,
      draw_closed_at=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN ? ELSE draw_closed_at END,
      draw_reason=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'full' ELSE draw_reason END,
      ended_at=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN ? ELSE ended_at END,
      end_reason=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'exhausted' ELSE end_reason END,
      version=version+1,updated_at=? WHERE id=?`).bind(
      time,
      time,
      time,
      activityId,
    ),
  ]);
  return id;
}

async function history(reader: Actor, cursor?: string) {
  const response = await app.request(
    `${origin}/api/me/participations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { headers: { Cookie: reader.cookie } },
    bindings,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ParticipationList;
}

describe("persisted timed-draw recovery and participation pagination", () => {
  it("recovers a failed publication only through its persisted Alarm after eviction without redrawing or paying twice", async () => {
    const f = await fixture();
    const third = await actor();
    const draft = await createActivity(bindings, f.owner.id, {
      requestId: crypto.randomUUID(),
      activity: timedInput(f.merchant.id),
    });
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(draft.id));
    const opened = await stub.fetch(
      `https://activity.internal/internal/activities/${draft.id}/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorId: f.owner.id, version: draft.version }),
      },
    );
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ activity: { id: draft.id } });
    expect(
      await runInDurableObject(stub, async (_instance, state) => ({
        activityId: await state.storage.get("drawActivityId"),
        alarm: await state.storage.getAlarm(),
      })),
    ).toEqual({ activityId: draft.id, alarm: expect.any(Number) });
    // Admission uses the normal service. The original future Alarm stays
    // persisted until explicitly delivered, keeping this test free of timers.
    for (const person of [f.reader, f.other, third]) {
      expect(
        await registerForDraw(bindings, draft.id, person.id, {
          submissionId: crypto.randomUUID(),
          password,
        }),
      ).toMatchObject({ result: "registered" });
    }
    const trigger = `fixture_recovery_failure_${draft.id.replaceAll("-", "")}`;
    await env.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON payment_outbox
      WHEN EXISTS(SELECT 1 FROM payment_tasks p JOIN claims c ON c.id=p.claim_id
        WHERE p.id=NEW.task_id AND c.activity_id='${draft.id}')
      BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END`).run();
    const failedAt = Date.now();
    let originalPlan: Awaited<ReturnType<typeof savedPlan>>;
    try {
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect(await counts(draft.id)).toMatchObject({
        draw_state: "settling",
        draw_published_at: null,
        registered_count: 3,
        claimed_count: 0,
        inventory: 0,
        claims: 0,
        tasks: 0,
        outbox: 0,
      });
      originalPlan = await savedPlan(draft.id);
      expect(originalPlan.participant_count).toBe(3);
      const recovery = await runInDurableObject(
        stub,
        async (_instance, state) => ({
          data: Object.fromEntries(await state.storage.list()),
          alarm: await state.storage.getAlarm(),
        }),
      );
      expect(recovery.data).toEqual({ drawActivityId: draft.id });
      expect(recovery.alarm).toBeGreaterThanOrEqual(failedAt + 5_000);
      expect(recovery.alarm).toBeLessThanOrEqual(Date.now() + 5_000);
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    const plan = JSON.parse(originalPlan.payload) as DrawPlan;
    expect(plan.winners).toHaveLength(2);
    expect(new Set(plan.winners.map((winner) => winner.userId)).size).toBe(2);
    expect(
      plan.winners.reduce((sum, winner) => sum + winner.amountMinor, 0),
    ).toBe(100);

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await counts(draft.id)).toMatchObject({
      draw_state: "completed",
      draw_published_at: expect.any(Number),
      registered_count: 3,
      claimed_count: 2,
      inventory: 2,
      claims: 2,
      tasks: 2,
      outbox: 2,
    });
    expect(await savedPlan(draft.id)).toEqual(originalPlan);
    const expectedPayouts = plan.winners
      .map((winner) => ({
        taskId: winner.taskId,
        claimId: winner.claimId,
        outboxId: winner.outboxId,
        userId: winner.userId,
        inventoryId: winner.inventoryId,
        recipientId: winner.recipientId,
        amountMinor: winner.amountMinor,
        businessNo: `hb_${winner.claimId.replaceAll("-", "")}`,
      }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    expect(await payouts(draft.id)).toEqual(expectedPayouts);
    for (let cycle = 0; cycle < 3; cycle++) {
      await runMerchantCycle(bindings, f.merchant.id);
    }
    const orders = await env.DB.prepare(
      "SELECT id,business_no,recipient_id,amount_minor FROM simulation_orders WHERE client_id=? ORDER BY business_no",
    )
      .bind(f.merchant.clientId)
      .all();
    expect(orders.results).toHaveLength(2);
    expect(orders.results.map(({ id: _id, ...order }) => order)).toEqual(
      expectedPayouts
        .map((payout) => ({
          business_no: payout.businessNo,
          recipient_id: payout.recipientId,
          amount_minor: payout.amountMinor,
        }))
        .sort((a, b) => (a.business_no < b.business_no ? -1 : 1)),
    );

    // Publication and payment wake replays retain the same IDs and upstream
    // orders after the persisted Alarm has completed recovery.
    expect(await publishDrawPlan(bindings, draft.id)).toBe(false);
    await runMerchantCycle(bindings, f.merchant.id);
    expect(await savedPlan(draft.id)).toEqual(originalPlan);
    expect(await payouts(draft.id)).toEqual(expectedPayouts);
    expect(
      (
        await env.DB.prepare(
          "SELECT id,business_no,recipient_id,amount_minor FROM simulation_orders WHERE client_id=? ORDER BY business_no",
        )
          .bind(f.merchant.clientId)
          .all()
      ).results,
    ).toEqual(orders.results);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS sends FROM payment_attempts p
        JOIN payment_tasks t ON t.id=p.task_id JOIN claims c ON c.id=t.claim_id
        WHERE c.activity_id=? AND p.operation='send'`)
        .bind(draft.id)
        .first(),
    ).toEqual({ sends: 2 });
  }, 30_000);

  it("pages 26 mixed participations at one millisecond exactly once and keeps ordinary claims limited to summary fields", async () => {
    const f = await fixture();
    const time = Date.now();
    const expected: { kind: "claim" | "registration"; id: string }[] = [];
    const winnerClaimIds = new Set<string>();
    for (let index = 0; index < 12; index++) {
      const ordinary = await createOpened(f.owner, {
        ...emptyActivityInput(),
        title: `普通领取 ${index}`,
        passwords: [password],
        rewards: [{ id: crypto.randomUUID(), text: `PRIVATE-TEXT-${index}` }],
        afterClaimInfo: "PRIVATE-ORDINARY-INFORMATION",
      });
      const result = await claimActivity(bindings, ordinary.id, f.reader.id, {
        submissionId: crypto.randomUUID(),
        password,
      });
      if (!("claim" in result)) throw new Error("Missing ordinary text claim");
      expect(result.claim).toMatchObject({
        text: `PRIVATE-TEXT-${index}`,
        afterClaimInfo: "PRIVATE-ORDINARY-INFORMATION",
      });
      expected.push({ kind: "claim", id: result.claim.id });

      const won = index >= 6;
      const draw = await createOpened(
        f.owner,
        timedInput(f.merchant.id, {
          count: 1,
          participantLimit: won ? 1 : null,
        }),
      );
      const registrationId = await seedRegistration(draw.id, f.reader.id, time);
      expected.push({ kind: "registration", id: registrationId });
      if (won) {
        expect(await refreshTimedDraw(bindings, draw.id)).toBe(true);
        const plan = JSON.parse((await savedPlan(draw.id)).payload) as DrawPlan;
        winnerClaimIds.add(plan.winners[0]?.claimId ?? "");
      }
    }
    const losingDraw = await createOpened(
      f.owner,
      timedInput(f.merchant.id, { count: 1, participantLimit: 2 }),
    );
    await seedRegistration(losingDraw.id, f.other.id, time);
    const losingId = await seedRegistration(losingDraw.id, f.reader.id, time);
    expected.push({ kind: "registration", id: losingId });
    // Floyd's single-winner sample selects ordinal 1, leaving the reader's
    // ordinal 2 as a deterministic not_won participation.
    const randomness = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => {
        if (array)
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
            0,
          );
        return array;
      });
    try {
      expect(await refreshTimedDraw(bindings, losingDraw.id)).toBe(true);
    } finally {
      randomness.mockRestore();
    }
    const ordinaryLdc = await createOpened(f.owner, {
      ...timedInput(f.merchant.id),
      title: "普通 LDC 领取",
      allocation: "sequential",
      money: { mode: "fixed", totalAmount: "1.00", count: 1 },
      afterClaimInfo: "PRIVATE-LDC-INFORMATION",
    });
    const result = await claimActivity(bindings, ordinaryLdc.id, f.reader.id, {
      submissionId: crypto.randomUUID(),
      password,
    });
    if (!("claim" in result)) throw new Error("Missing ordinary LDC claim");
    expect(result.claim).toMatchObject({
      amount: "1.00",
      payment: { id: expect.any(String) },
      afterClaimInfo: "PRIVATE-LDC-INFORMATION",
    });
    expected.push({ kind: "claim", id: result.claim.id });
    // Claims permit fixture timestamp updates; include the six timed winner
    // claims at this same millisecond so their history exclusion is exercised.
    await env.DB.prepare("UPDATE claims SET claimed_at=? WHERE user_id=?")
      .bind(time, f.reader.id)
      .run();
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS rows,COUNT(DISTINCT time) AS timestamps,MIN(time) AS time FROM (
        SELECT claimed_at AS time FROM claims WHERE user_id=?
        UNION ALL SELECT registered_at AS time FROM activity_registrations WHERE user_id=?)`)
        .bind(f.reader.id, f.reader.id)
        .first(),
    ).toEqual({ rows: 32, timestamps: 1, time });

    const first = await history(f.reader);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = first.items.at(-1);
    if (!last || !first.nextCursor)
      throw new Error("Missing first page cursor");
    expect(JSON.parse(atob(first.nextCursor))).toEqual({
      time,
      id: last.kind === "claim" ? last.claim.id : last.registration.id,
    });
    const second = await history(f.reader, first.nextCursor);
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    const items = [...first.items, ...second.items];
    const actual = items.map((item) => ({
      kind: item.kind,
      id: item.kind === "claim" ? item.claim.id : item.registration.id,
    }));
    expect(actual).toEqual(expected.sort((a, b) => (a.id > b.id ? -1 : 1)));
    expect(new Set(actual.map((item) => item.id)).size).toBe(26);
    const ordinaryClaims = items.flatMap((item) =>
      item.kind === "claim" ? [item.claim] : [],
    );
    expect(ordinaryClaims).toHaveLength(13);
    expect(
      ordinaryClaims.filter((claim) => claim.rewardType === "ldc"),
    ).toHaveLength(1);
    for (const claim of ordinaryClaims) {
      expect(Object.keys(claim).sort()).toEqual([
        "activity",
        "claimedAt",
        "id",
        "rewardType",
      ]);
      expect(Object.keys(claim.activity).sort()).toEqual([
        "id",
        "status",
        "title",
      ]);
      expect(claim.claimedAt).toBe(new Date(time).toISOString());
      expect(winnerClaimIds.has(claim.id)).toBe(false);
    }
    const registrations = items.flatMap((item) =>
      item.kind === "registration" ? [item.registration] : [],
    );
    expect(
      registrations.filter((entry) => entry.status === "registered"),
    ).toHaveLength(6);
    expect(
      registrations.filter((entry) => entry.status === "won"),
    ).toHaveLength(6);
    expect(
      registrations.filter((entry) => entry.status === "not_won"),
    ).toHaveLength(1);
    for (const entry of registrations) {
      expect(entry.registeredAt).toBe(new Date(time).toISOString());
      if (entry.status === "won") {
        expect(entry.claim).toMatchObject({
          rewardType: "ldc",
          amount: "1.00",
          payment: { id: expect.any(String) },
          afterClaimInfo: "PRIVATE-DRAW-INFORMATION",
        });
        expect(winnerClaimIds.has(entry.claim?.id ?? "")).toBe(true);
      } else {
        expect(entry.claim).toBeNull();
      }
    }
  }, 30_000);
});
