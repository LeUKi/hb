import { env, runDurableObjectAlarm } from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type TimedDrawMoney,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimActivity,
  resumePendingActivityClaims,
} from "../src/activities/claim-service";
import { refreshTimedDraw } from "../src/activities/draw-service";
import {
  endActivity,
  refreshActivityLifecycle,
} from "../src/activities/lifecycle";
import {
  getActivityPasswords,
  solveActivityPassword,
} from "../src/activities/password-service";
import {
  getCurrentRegistration,
  listParticipations,
} from "../src/activities/registration-queries";
import { registerForDraw } from "../src/activities/registration-service";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import {
  insertPasswordRows,
  preparePasswords,
} from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { listSquare } from "../src/discovery/service";
import { getStatistics } from "../src/discovery/statistics";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let entrants: Actor[];
let merchantId: string;

async function actor(index: number): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: String(9000 + index),
    username: `Participant${index}`,
    displayName: `成员 ${index}`,
    avatarUrl: `https://avatar.example.com/${index}.png`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}
function input(
  money: Partial<TimedDrawMoney> = {},
  extra: Partial<LdcActivityInput> = {},
): LdcActivityInput {
  const { rewardType: _rewardType, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "限时开奖",
    passwords: ["entrykey", "secondkey", "thirdkey"],
    forceDedicated: true,
    joinSquare: true,
    rewardType: "ldc",
    merchantId,
    allocation: "random",
    money: {
      mode: "timed_draw",
      algorithm: "double_mean_v1",
      totalAmount: "1.00",
      count: 2,
      participantLimit: null,
      countdownSeconds: 86400,
      distributeFullPool: true,
      ...money,
    },
    afterClaimInfo: "仅中奖后可见",
    ...extra,
  };
}
async function create(
  money: Partial<TimedDrawMoney> = {},
  extra: Partial<LdcActivityInput> = {},
  open = true,
) {
  const saved = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity: input(money, extra),
  });
  return open
    ? openActivity(bindings, saved.id, owner.id, saved.version)
    : saved;
}
const submission = (
  password = "entrykey",
  submissionId = crypto.randomUUID(),
) => ({ submissionId, password });
const register = (id: string, index = 0, value = submission()) =>
  registerForDraw(bindings, id, entrants[index]?.id ?? "", value);
const participation = (id: string, user: Actor, refresh?: "0" | "1") =>
  app.request(
    `${origin}/api/activities/${id}/participation${refresh === undefined ? "" : `?refresh=${refresh}`}`,
    { headers: { Cookie: user.cookie } },
    bindings,
  );
async function participationJson(id: string, user: Actor, refresh?: "0" | "1") {
  const response = await participation(id, user, refresh);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    claim: null | { id: string; amount?: string; afterClaimInfo?: string };
    registration: null | {
      status: "registered" | "drawing" | "won" | "not_won";
      claim: null | { id: string; amount?: string; afterClaimInfo?: string };
    };
  };
}
async function waitUntilDrawDue() {
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
async function drawState(id: string) {
  return env.DB.prepare(
    "SELECT draw_state AS drawState, claimed_count AS claimedCount FROM activities WHERE id=?",
  )
    .bind(id)
    .first<{ drawState: string | null; claimedCount: number }>();
}
async function totals(id: string) {
  return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=?) AS registrations,
    (SELECT COUNT(*) FROM claims WHERE activity_id=?) AS claims,
    (SELECT COUNT(*) FROM reward_inventory WHERE activity_id=?) AS inventory,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS payments,
    (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?) AS outbox`)
    .bind(id, id, id, id, id)
    .first();
}
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
      "sessions",
      "oauth_attempts",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  owner = await actor(0);
  entrants = await Promise.all([1, 2, 3, 4].map(actor));
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: "timed_app",
      label: "虚拟商户",
      secret: "fake-only",
    })
  ).id;
});

describe("timed LDC registration and draw lifecycle", () => {
  it("preserves an absolute draw time through saving, editing and opening", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const request = {
      requestId: crypto.randomUUID(),
      activity: input(
        { countdownSeconds: undefined, participantLimit: 2 },
        { deadline: { mode: "at", at } },
      ),
    };
    const saved = await createActivity(bindings, owner.id, request);
    expect(saved.config.deadline).toEqual({ mode: "at", at });
    if (saved.config.rewardType !== "ldc") throw new Error("Expected LDC");
    expect(saved.config.money).not.toHaveProperty("countdownSeconds");
    const edited = await updateActivity(bindings, saved.id, owner.id, {
      version: saved.version,
      activity: { ...saved.config, title: "指定时间已修改" },
    });
    const opened = await openActivity(
      bindings,
      edited.id,
      owner.id,
      edited.version,
    );
    expect(opened.config.deadline).toEqual({ mode: "at", at });
    expect(opened.deadlineAt).toBe(at);
    expect((await createActivity(bindings, owner.id, request)).id).toBe(
      saved.id,
    );
    await expect(
      updateActivity(bindings, opened.id, owner.id, {
        version: opened.version,
        activity: {
          ...opened.config,
          deadline: {
            mode: "at",
            at: new Date(Date.parse(at) + 60_000).toISOString(),
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ACTIVITY",
      message: "限时开奖开放后不能修改开奖时间",
    });
    await register(opened.id, 0);
    await register(opened.id, 1);
    await refreshTimedDraw(bindings, opened.id);
    expect(
      await getManagedActivity(bindings, opened.id, owner.id),
    ).toMatchObject({
      deadlineAt: at,
      draw: { state: "completed", reason: "full", winnerCount: 2 },
    });
  });

  it("checks an absolute deadline again in the winning database batch", async () => {
    const at = new Date(Date.now() + 2_000).toISOString();
    const saved = await create(
      { countdownSeconds: undefined },
      { deadline: { mode: "at", at } },
      false,
    );
    const batch = bindings.DB.batch.bind(bindings.DB);
    const delayed = vi
      .spyOn(bindings.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await new Promise((resolve) => setTimeout(resolve, 2_100));
        return batch(statements);
      });
    try {
      await expect(
        openActivity(bindings, saved.id, owner.id, saved.version),
      ).rejects.toMatchObject({
        code: "INVALID_ACTIVITY",
        message: "截止时间必须晚于正式开放时间",
      });
    } finally {
      delayed.mockRestore();
    }
    expect(
      await getManagedActivity(bindings, saved.id, owner.id),
    ).toMatchObject({
      status: "draft",
      version: saved.version,
      openedAt: null,
      deadlineAt: null,
      config: { deadline: { mode: "at", at } },
    });
    const expired = await create(
      { countdownSeconds: undefined },
      { deadline: { mode: "at", at: "2000-01-01T00:00:00Z" } },
      false,
    );
    await expect(
      openActivity(bindings, expired.id, owner.id, expired.version),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
  });

  it("starts a short countdown at transaction time even after an opening delay", async () => {
    const request = {
      requestId: crypto.randomUUID(),
      activity: input({ countdownSeconds: 1 }),
    };
    const saved = await createActivity(bindings, owner.id, request);
    const beforeOpen = Date.now();
    const batch = bindings.DB.batch.bind(bindings.DB);
    const delayed = vi
      .spyOn(bindings.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return batch(statements);
      });
    let opened: Awaited<ReturnType<typeof openActivity>>;
    try {
      opened = await openActivity(bindings, saved.id, owner.id, saved.version);
    } finally {
      delayed.mockRestore();
    }
    expect(Date.parse(opened.openedAt ?? "")).toBeGreaterThanOrEqual(
      beforeOpen + 1_000,
    );
    expect(
      Date.parse(opened.deadlineAt ?? "") - Date.parse(opened.openedAt ?? ""),
    ).toBe(1_000);
    expect(opened.config.deadline).toEqual({ mode: "duration" });
    expect((await createActivity(bindings, owner.id, request)).id).toBe(
      saved.id,
    );
  });

  it("saves an empty draft, freezes timed settings and opens with transaction-time countdown", async () => {
    const draft = await create({}, {}, false);
    expect(await totals(draft.id)).toEqual({
      registrations: 0,
      claims: 0,
      inventory: 0,
      payments: 0,
      outbox: 0,
    });
    expect(draft.totalCount).toBe(2);
    const activity = await openActivity(
      bindings,
      draft.id,
      owner.id,
      draft.version,
    );
    expect(
      Date.parse(activity.deadlineAt ?? "") -
        Date.parse(activity.openedAt ?? ""),
    ).toBe(86400000);
    expect(activity.config.deadline).toEqual({ mode: "duration" });
    await expect(
      updateActivity(bindings, activity.id, owner.id, {
        version: activity.version,
        activity: input({ count: 3 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
    const edited = await updateActivity(bindings, activity.id, owner.id, {
      version: activity.version,
      activity: {
        ...activity.config,
        title: "修改标题",
        topicUrl: "https://linux.do/t/topic/2964597/1216",
      },
    });
    expect(edited.deadlineAt).toBe(activity.deadlineAt);
    expect(edited.topicUrl).toBe("https://linux.do/t/2964597/1216");
    expect(await totals(activity.id)).toEqual({
      registrations: 0,
      claims: 0,
      inventory: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("gates new openings only, preserves one participation across retries and keeps solving separate", async () => {
    const draft = await create({}, {}, false);
    await expect(
      openActivity(
        { ...bindings, LDC_TIMED_DRAW_ENABLED: "false" },
        draft.id,
        owner.id,
        draft.version,
      ),
    ).rejects.toMatchObject({ code: "TIMED_DRAW_NOT_ENABLED" });
    const activity = await openActivity(
      bindings,
      draft.id,
      owner.id,
      draft.version,
    );
    expect(
      (
        await openActivity(
          { ...bindings, LDC_TIMED_DRAW_ENABLED: "false" },
          activity.id,
          owner.id,
          1,
        )
      ).id,
    ).toBe(activity.id);
    await expect(
      registerForDraw(bindings, activity.id, owner.id, submission()),
    ).rejects.toMatchObject({ code: "SELF_CLAIM_FORBIDDEN" });
    const key = submission();
    const replay = await Promise.all([
      register(activity.id, 0, key),
      register(activity.id, 0, key),
      register(activity.id, 0, key),
    ]);
    expect(replay.every((value) => value.result === "registered")).toBe(true);
    expect(await register(activity.id, 0, submission("notakey"))).toMatchObject(
      { result: "already_registered" },
    );
    await expect(
      register(activity.id, 0, { ...key, password: "secondkey" }),
    ).rejects.toMatchObject({ code: "ACTIVITY_CONFLICT" });
    await advanceAttemptCooldown(env.DB, entrants[0]?.id ?? "");
    expect(
      await solveActivityPassword(
        bindings,
        activity.id,
        entrants[0]?.id ?? "",
        submission("secondkey"),
      ),
    ).toEqual({ outcome: "solved", passwordMatched: true });
    expect(
      await getActivityPasswords(bindings, activity.id, entrants[0]?.id),
    ).toMatchObject({
      passwords: [
        {
          text: "entrykey",
          isRegistrationPassword: true,
          isClaimPassword: false,
        },
        { text: "secondkey", isSolved: true },
      ],
      hiddenCount: 1,
      canSolve: true,
    });
    expect(
      await getActivityPasswords(bindings, activity.id, entrants[1]?.id),
    ).toMatchObject({ passwords: [], hiddenCount: 3, canSolve: false });
    expect(await totals(activity.id)).toEqual({
      registrations: 1,
      claims: 0,
      inventory: 0,
      payments: 0,
      outbox: 0,
    });
    expect(await resumePendingActivityClaims(bindings, activity.id)).toBe(0);
    expect(await getStatistics(bindings, activity.id, owner.id)).toMatchObject({
      registeredParticipants: 1,
      successfulClaims: 0,
      totalAttempts: 2,
      // A sign-up counts under its 口令 before any prize exists.
      validPasswords: expect.arrayContaining([
        { password: "entrykey", successfulClaims: 0, registrations: 1 },
      ]),
    });
  });

  it("participation endpoint refreshes timed draws by default and refresh=0 returns a snapshot", async () => {
    const activity = await create({ count: 1, countdownSeconds: 1 });
    await register(activity.id, 0);
    await waitUntilDrawDue();

    const snapshot = await participationJson(
      activity.id,
      entrants[0] as Actor,
      "0",
    );
    expect(snapshot).toMatchObject({
      claim: null,
      registration: { status: "drawing", claim: null },
    });
    expect(await drawState(activity.id)).toMatchObject({
      drawState: "waiting",
      claimedCount: 0,
    });

    const refreshed = await participationJson(
      activity.id,
      entrants[0] as Actor,
    );
    expect(refreshed.registration).toMatchObject({
      status: "won",
      claim: { amount: "1.00", afterClaimInfo: "仅中奖后可见" },
    });
    expect(refreshed.claim).toMatchObject(refreshed.registration?.claim ?? {});
    expect(await drawState(activity.id)).toMatchObject({
      drawState: "completed",
      claimedCount: 1,
    });
  });

  it("participation endpoint preserves terminal won and not-won projections", async () => {
    const activity = await create({ count: 1, countdownSeconds: 1 });
    await register(activity.id, 0);
    await register(activity.id, 1);
    await waitUntilDrawDue();
    await refreshTimedDraw(bindings, activity.id);

    const first = await participationJson(
      activity.id,
      entrants[0] as Actor,
      "0",
    );
    const second = await participationJson(
      activity.id,
      entrants[1] as Actor,
      "0",
    );
    const results = [first, second];
    const winners = results.filter(
      (item) => item.registration?.status === "won",
    );
    const notWinners = results.filter(
      (item) => item.registration?.status === "not_won",
    );
    expect(winners).toHaveLength(1);
    expect(notWinners).toHaveLength(1);
    expect(winners[0]?.claim).toMatchObject({ amount: "1.00" });
    expect(winners[0]?.registration?.claim).toEqual(winners[0]?.claim);
    expect(notWinners[0]).toMatchObject({
      claim: null,
      registration: { status: "not_won", claim: null },
    });
  });

  it("participation endpoint surfaces failed timed refresh instead of returning stale data", async () => {
    const activity = await create({ count: 1, countdownSeconds: 1 });
    await register(activity.id, 0);
    await env.DB.prepare(`CREATE TRIGGER fixture_participation_refresh_failure BEFORE INSERT ON payment_outbox
      WHEN EXISTS(SELECT 1 FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE p.id=NEW.task_id AND c.activity_id='${activity.id}')
      BEGIN SELECT RAISE(ABORT,'fixture participation refresh failure'); END`).run();
    await waitUntilDrawDue();

    const response = await participation(activity.id, entrants[0] as Actor);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "红包保存失败，请重试",
      },
    });
  });

  it.each([
    { count: 2, limit: 2, winners: 2 },
    { count: 2, limit: 3, winners: 2 },
    { count: 3, limit: 2, winners: 2 },
  ])(
    "draws at the configured limit for N=$count and M=$limit",
    async ({ count, limit, winners }) => {
      const activity = await create({ count, participantLimit: limit });
      for (let index = 0; index < limit; index++)
        await register(activity.id, index);
      const closed = await getManagedActivity(bindings, activity.id, owner.id);
      expect(closed).toMatchObject({
        status: "ended",
        draw: { state: "settling", reason: "full", registeredCount: limit },
      });
      expect(await totals(activity.id)).toMatchObject({
        registrations: limit,
        claims: 0,
        payments: 0,
        outbox: 0,
      });
      expect(await register(activity.id, 3)).toEqual({
        result: "ended",
        passwordMatched: null,
      });
      await refreshTimedDraw(
        {
          ...bindings,
          LDC_TIMED_DRAW_ENABLED: "false",
          LDC_STOP_NEW_CLAIMS: "true",
        },
        activity.id,
      );
      expect(await totals(activity.id)).toMatchObject({
        registrations: limit,
        claims: winners,
        payments: winners,
        outbox: winners,
      });
      const amount = await env.DB.prepare(
        "SELECT SUM(amount_minor) AS paid FROM payment_tasks WHERE claim_id IN (SELECT id FROM claims WHERE activity_id=?)",
      )
        .bind(activity.id)
        .first();
      expect(amount).toEqual({ paid: 100 });
      const states = await Promise.all(
        entrants
          .slice(0, limit)
          .map((entry) =>
            getCurrentRegistration(bindings, activity.id, entry.id),
          ),
      );
      expect(states.filter((state) => state?.status === "won")).toHaveLength(
        winners,
      );
      expect(
        states.filter((state) => state?.status === "not_won"),
      ).toHaveLength(limit - winners);
      expect(
        (await listParticipations(bindings, entrants[0]?.id ?? "")).items,
      ).toHaveLength(1);
      expect(
        (await getActivityPasswords(bindings, activity.id)).passwords,
      ).toHaveLength(3);
      expect(
        await getStatistics(bindings, activity.id, owner.id),
      ).toMatchObject({
        successfulClaims: winners,
        registeredParticipants: limit,
      });
    },
  );

  it("underfilled OFF leaves frozen shares undistributed; later requests cannot allocate them", async () => {
    const activity = await create({
      count: 4,
      participantLimit: 2,
      distributeFullPool: false,
      algorithm: "bounded_mean_v1",
    });
    await register(activity.id, 0);
    await register(activity.id, 1);
    await refreshTimedDraw(bindings, activity.id);
    expect(await totals(activity.id)).toMatchObject({
      registrations: 2,
      inventory: 4,
      claims: 2,
      payments: 2,
    });
    const sums =
      await env.DB.prepare(`SELECT (SELECT SUM(amount_minor) FROM reward_inventory WHERE activity_id=?) AS pool,
      (SELECT SUM(amount_minor) FROM payment_tasks WHERE claim_id IN (SELECT id FROM claims WHERE activity_id=?)) AS paid`)
        .bind(activity.id, activity.id)
        .first<{ pool: number; paid: number }>();
    expect(sums?.pool).toBe(100);
    expect(sums?.paid).toBeLessThan(100);
    expect(sums?.paid).toBeGreaterThan(0);
    expect(await register(activity.id, 2)).toEqual({
      result: "ended",
      passwordMatched: null,
    });
    const plan = await env.DB.prepare(
      "SELECT payload FROM activity_draw_plans WHERE activity_id=?",
    )
      .bind(activity.id)
      .first();
    await Promise.all([
      refreshTimedDraw(bindings, activity.id),
      refreshActivityLifecycle(bindings, activity.id),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT payload FROM activity_draw_plans WHERE activity_id=?",
      )
        .bind(activity.id)
        .first(),
    ).toEqual(plan);
    expect(await totals(activity.id)).toMatchObject({
      registrations: 2,
      claims: 2,
      payments: 2,
    });
  });

  it("atomically accepts only one of two concurrent final-slot registrations", async () => {
    const activity = await create({ count: 1, participantLimit: 1 });
    const results = await Promise.all([
      register(activity.id, 0),
      register(activity.id, 1),
    ]);
    expect(
      results.filter((value) => value.result === "registered"),
    ).toHaveLength(1);
    expect(results.filter((value) => value.result === "ended")).toHaveLength(1);
    expect(await totals(activity.id)).toMatchObject({
      registrations: 1,
      claims: 0,
      payments: 0,
    });
    await refreshTimedDraw(bindings, activity.id);
    expect(await totals(activity.id)).toMatchObject({
      registrations: 1,
      claims: 1,
      payments: 1,
      outbox: 1,
    });
  });

  it("does not reinterpret a terminal wrong attempt when a legacy activity later contains that password", async () => {
    const activity = await create();
    const key = submission("futurekey");
    expect(await register(activity.id, 0, key)).toEqual({
      result: "incorrect",
      passwordMatched: false,
    });
    // Model a legacy appended password without reopening the newly locked API.
    const [later] = await preparePasswords(
      bindings,
      activity.id,
      ["futurekey"],
      [],
      Date.now(),
    );
    if (!later) throw new Error("Missing legacy password fixture");
    await env.DB.batch([
      insertPasswordRows(env.DB, [
        { ...later, position: activity.config.passwords.length },
      ]),
    ]);
    expect(await register(activity.id, 0, key)).toEqual({
      result: "incorrect",
      passwordMatched: false,
    });
    expect(await totals(activity.id)).toMatchObject({
      registrations: 0,
      claims: 0,
      payments: 0,
    });
    await advanceAttemptCooldown(env.DB, entrants[0]?.id ?? "");
    expect(
      await register(activity.id, 0, submission("futurekey")),
    ).toMatchObject({ result: "registered" });
  });

  it("expires without visitors and its persisted ActivityDO alarm settles admitted entries", async () => {
    const activity = await create({ countdownSeconds: 1 }, {}, false);
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(activity.id));
    const opened = await stub.fetch(
      `https://activity.internal/internal/activities/${activity.id}/open`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorId: owner.id, version: activity.version }),
      },
    );
    expect(opened.status).toBe(200);
    await register(activity.id, 0);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await runDurableObjectAlarm(stub);
    expect(
      await getManagedActivity(bindings, activity.id, owner.id),
    ).toMatchObject({
      status: "ended",
      draw: { state: "completed", reason: "deadline", winnerCount: 1 },
    });
    expect(await totals(activity.id)).toMatchObject({
      registrations: 1,
      claims: 1,
      payments: 1,
    });
    expect(await register(activity.id, 1)).toEqual({
      result: "ended",
      passwordMatched: null,
    });
    const empty = await create({ countdownSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await refreshActivityLifecycle(bindings, empty.id);
    expect(
      await getManagedActivity(bindings, empty.id, owner.id),
    ).toMatchObject({ draw: { state: "empty", winnerCount: 0 } });
    expect(await totals(empty.id)).toEqual({
      registrations: 0,
      claims: 0,
      inventory: 0,
      payments: 0,
      outbox: 0,
    });
  });

  it("refuses manual cancellation after registration but lets an empty draw finish safely", async () => {
    const activity = await create();
    await register(activity.id);
    const current = await getManagedActivity(bindings, activity.id, owner.id);
    await expect(
      endActivity(bindings, activity.id, owner.id, current.version),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
    const empty = await create();
    expect(
      await endActivity(bindings, empty.id, owner.id, empty.version),
    ).toMatchObject({ draw: { state: "empty", reason: "manual" } });
  });

  it("shares rate limiting with solves and refuses purpose reuse without duplicating entries", async () => {
    const activity = await create();
    const key = submission();
    await register(activity.id, 0, key);
    await expect(
      solveActivityPassword(bindings, activity.id, entrants[0]?.id ?? "", key),
    ).rejects.toMatchObject({ code: "ACTIVITY_CONFLICT" });
    await expect(
      solveActivityPassword(
        bindings,
        activity.id,
        entrants[0]?.id ?? "",
        submission("wrong00"),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_RATE_LIMITED" });
    await advanceAttemptCooldown(env.DB, entrants[0]?.id ?? "");
    expect(
      await solveActivityPassword(
        bindings,
        activity.id,
        entrants[0]?.id ?? "",
        submission("wrong00"),
      ),
    ).toMatchObject({ outcome: "incorrect", passwordMatched: false });
    await expect(
      solveActivityPassword(
        bindings,
        activity.id,
        entrants[0]?.id ?? "",
        submission("secondkey"),
      ),
    ).rejects.toMatchObject({ code: "CLAIM_RATE_LIMITED" });
    expect(await totals(activity.id)).toMatchObject({
      registrations: 1,
      claims: 0,
      payments: 0,
    });
  });

  it("projects fuzzy counts safely and only exposes each user's own participation", async () => {
    const activity = await create(
      {},
      {
        forceDedicated: false,
        joinSquare: true,
        topicUrl: "https://linux.do/t/123/1",
        quantityVisibility: "fuzzy",
      },
    );
    await register(activity.id);
    expect((await getPublicActivity(bindings, activity.id)).draw).toMatchObject(
      { registeredCount: null, winnerCount: null },
    );
    expect(
      (await getPublicActivity(bindings, activity.id)).draw,
    ).not.toHaveProperty("participantLimit");
    const cards = await listSquare(bindings, "active", entrants[0]?.id);
    expect(cards.items[0]?.myRegistration).toMatchObject({
      status: "registered",
    });
    expect(
      (await listSquare(bindings, "active", entrants[1]?.id)).items[0]
        ?.myRegistration,
    ).toBeNull();
    const loggedOut = await app.request(
      `${origin}/api/activities/${activity.id}/registration`,
      {},
      bindings,
    );
    expect(loggedOut.status).toBe(401);
    const foreign = entrants[1] as Actor;
    const response = await app.request(
      `${origin}/api/me/activities/${activity.id}/registrations`,
      { headers: { Cookie: foreign.cookie } },
      bindings,
    );
    expect(response.status).toBe(404);
    const correct = await app.request(
      `${origin}/api/me/activities/${activity.id}/registrations`,
      { headers: { Cookie: owner.cookie } },
      bindings,
    );
    expect(correct.status).toBe(200);
    const data = await correct.text();
    expect(data).toContain("Participant1");
    expect(data).toContain("avatar.example.com/1.png");
    expect(data).not.toContain("recipient_id");
    expect(data).not.toContain("email");
  });

  it("returns only ordinary claim summaries without decrypting private rewards, while keeping timed winner detail", async () => {
    const recipient = entrants[0] as Actor;
    const ordinaryDraft = await createActivity(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title: "普通 LDC 摘要",
        rewardType: "ldc",
        merchantId,
        passwords: ["textkey"],
        money: { mode: "fixed", totalAmount: "1.00", count: 1 },
        afterClaimInfo: "PRIVATE_AFTER_CLAIM_DO_NOT_LIST",
      },
    });
    const ordinaryActivity = await openActivity(
      bindings,
      ordinaryDraft.id,
      owner.id,
      ordinaryDraft.version,
    );
    const ordinaryResult = await claimActivity(
      bindings,
      ordinaryActivity.id,
      recipient.id,
      submission("textkey"),
    );
    expect(ordinaryResult).toMatchObject({
      result: "claimed",
      claim: { rewardType: "ldc" },
    });
    const ldcDraft = await createActivity(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...input(),
        title: "即时金额摘要",
        allocation: "sequential",
        money: { mode: "fixed", count: 1, totalAmount: "0.01" },
      },
    });
    const ldc = await openActivity(
      bindings,
      ldcDraft.id,
      owner.id,
      ldcDraft.version,
    );
    await advanceAttemptCooldown(env.DB, recipient.id);
    expect(
      await claimActivity(bindings, ldc.id, recipient.id, submission()),
    ).toMatchObject({ result: "claimed" });
    const timed = await create({ count: 1, participantLimit: 1 });
    await advanceAttemptCooldown(env.DB, recipient.id);
    await register(timed.id);
    await refreshTimedDraw(bindings, timed.id);

    const response = await app.request(
      `${origin}/api/me/participations`,
      { headers: { Cookie: recipient.cookie } },
      bindings,
    );
    expect(response.status).toBe(200);
    const history = (await response.json()) as {
      items: Array<{
        kind: string;
        claim?: Record<string, unknown>;
        registration?: { claim: Record<string, unknown> | null };
      }>;
    };
    expect(history.items).toHaveLength(3);
    const ordinary = history.items.filter((item) => item.kind === "claim");
    expect(ordinary).toHaveLength(2);
    for (const item of ordinary) {
      expect(item.claim).toHaveProperty("sourcePassword");
      expect(item.claim).not.toHaveProperty("text");
      expect(item.claim).not.toHaveProperty("afterClaimInfo");
    }
    expect(
      ordinary
        .map((item) => item.claim)
        .filter((claim) => claim?.rewardType === "ldc"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: "0.01",
          payment: expect.objectContaining({
            mode: "simulation",
            confirmedAt: null,
          }),
        }),
        expect.objectContaining({
          amount: "1.00",
          payment: expect.objectContaining({
            mode: "simulation",
            confirmedAt: null,
          }),
        }),
      ]),
    );
    const winner = history.items.find((item) => item.kind === "registration");
    expect(winner?.registration?.claim).toMatchObject({
      amount: "1.00",
      afterClaimInfo: "仅中奖后可见",
      payment: { mode: "simulation" },
    });
    expect(JSON.stringify(history)).not.toContain(
      "PRIVATE_TEXT_REWARD_DO_NOT_LIST",
    );
    expect(JSON.stringify(history)).not.toContain(
      "PRIVATE_AFTER_CLAIM_DO_NOT_LIST",
    );
  });
});
