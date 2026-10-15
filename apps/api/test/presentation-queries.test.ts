import { env } from "cloudflare:test";
import {
  type AccountPaymentDetail,
  type AccountPaymentList,
  type ActivityInput,
  type ActivityList,
  type ActivityPaymentList,
  type ActivityPaymentTargetList,
  ARCHIVE_DELAY_MS,
  type AuthorClaimList,
  type DiscoveryList,
  emptyActivityInput,
  type LdcActivityInput,
  type LdcMoney,
  type ParticipationList,
  type PublicActivity,
  type PublicRecipientList,
  type PublicRegistrationList,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { refreshTimedDraw } from "../src/activities/draw-service";
import { registerForDraw } from "../src/activities/registration-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { activities, sessions, users } from "../src/db/schema";
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
type Actor = { id: string; cookie: string };
let owner: Actor;
let participant: Actor;
let outsider: Actor;
let merchantId: string;

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: id,
    username: `member_${id}`,
    displayName: `Member ${id}`,
    avatarUrl: `https://avatar.example.com/${id}.png`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: crypto.randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, cookie: `hb_session=${token}` };
}
function get(path: string, user?: Actor) {
  return app.request(
    `${origin}/api${path}`,
    { headers: user ? { Cookie: user.cookie } : {} },
    bindings,
  );
}
async function data<T>(path: string, user?: Actor): Promise<T> {
  const response = await get(path, user);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json() as Promise<T>;
}
function ldc(
  money: LdcMoney,
  extra: Partial<LdcActivityInput> = {},
): LdcActivityInput {
  const { rewardType: _t, ...base } = emptyActivityInput();
  return {
    ...base,
    title: `LDC ${money.mode}`,
    rewardType: "ldc",
    merchantId,
    passwords: ["FirstPassword", "ActualSource"],
    allocation:
      money.mode === "timed_draw" || money.mode === "random"
        ? "random"
        : "sequential",
    money,
    ...extra,
  };
}
const draw: LdcMoney = {
  mode: "timed_draw",
  algorithm: "double_mean_v1",
  totalAmount: "1.00",
  count: 1,
  participantLimit: null,
  countdownSeconds: 86400,
  distributeFullPool: true,
};
async function create(
  config: ActivityInput = ldc(
    { mode: "fixed", totalAmount: "2.00", count: 2 },
    { title: "LDC fixed", afterClaimInfo: "PRIVATE_CLAIM_NOTE" },
  ),
  open = true,
  author = owner,
) {
  let input = config;
  if (author.id !== owner.id && input.merchantId === merchantId) {
    const merchant = await createMerchant(bindings, author.id, {
      requestId: crypto.randomUUID(),
      clientId: `presentation_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "本地模拟",
      secret: "virtual-only-secret",
    });
    input = { ...input, merchantId: merchant.id };
  }
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open
    ? openActivity(bindings, saved.id, author.id, saved.version)
    : saved;
}
async function redeem(activityId: string, user = participant) {
  const result = await claimActivity(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    password: "ActualSource",
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}
async function register(activityId: string, user = participant) {
  const result = await registerForDraw(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    password: "ActualSource",
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
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
  owner = await actor();
  participant = await actor();
  outsider = await actor();
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: `presentation_${crypto.randomUUID()}`,
      label: "Local fixture",
      secret: "fake-only",
    })
  ).id;
});

afterEach(() => vi.restoreAllMocks());

describe("production presentation queries", () => {
  it("filters the square before its 20-row page and reports its complete matching total", async () => {
    const retiredText = await create(
      ldc(
        { mode: "fixed", totalAmount: "1.00", count: 1 },
        { title: "LDC square", passwords: ["ActualSource"], joinSquare: true },
      ),
    );
    const stored = await createDb(env.DB)
      .select()
      .from(activities)
      .where(eq(activities.id, retiredText.id))
      .get();
    if (!stored) throw new Error("Missing fixture");
    await env.DB.prepare("UPDATE activities SET reward_type='text' WHERE id=?")
      .bind(retiredText.id)
      .run();
    for (let index = 0; index < 22; index++)
      await createDb(env.DB)
        .insert(activities)
        .values({
          ...stored,
          id: crypto.randomUUID(),
          creationRequestId: crypto.randomUUID(),
          createdAt: stored.createdAt + index,
          openedAt: (stored.openedAt ?? 0) + index,
          rewardType: "text",
        });
    const fixed = await create(
      ldc(
        { mode: "fixed", totalAmount: "10.00", count: 10 },
        { joinSquare: true, quantityVisibility: "fuzzy" },
      ),
    );
    const fixedPage = await data<DiscoveryList>(
      "/discovery/activities?type=fixed&status=active",
    );
    expect(fixedPage).toMatchObject({ total: 1, nextCursor: null });
    expect(fixedPage.items[0]).toMatchObject({
      id: fixed.id,
      reward: { mode: "fixed", unitAmount: "1.00" },
    });
    expect(fixedPage.items[0]?.reward).not.toHaveProperty("totalAmount");
    expect(fixedPage.items[0]?.reward).not.toHaveProperty("count");
    expect(JSON.stringify(fixedPage)).not.toMatch(
      /FirstPassword|ActualSource|PRIVATE|afterClaimInfo/,
    );
    const square = await data<DiscoveryList>(
      "/discovery/activities?status=active",
    );
    expect(square.total).toBe(1);
    expect(square.items.map((row) => row.id)).toEqual([fixed.id]);
    expect((await get("/discovery/activities?type=text")).status).toBe(400);
    expect((await get("/discovery/activities?type=unknown")).status).toBe(400);
  });

  it("projects public reward schemes without text rewards or custom amount arrays", async () => {
    for (const money of [
      { mode: "fixed", totalAmount: "3.00", count: 3 },
      { mode: "custom", amounts: ["1.00", "2.00"] },
      {
        mode: "random",
        algorithm: "bounded_mean_v1",
        totalAmount: "3.00",
        count: 3,
      },
      draw,
    ] satisfies LdcMoney[]) {
      const activity = await create(ldc(money));
      const detail = await data<{ activity: PublicActivity }>(
        `/activities/${activity.id}`,
      );
      expect(detail.activity.reward?.mode).toBe(money.mode);
      expect(detail.activity.reward).not.toHaveProperty("amounts");
      expect(detail.activity.reward).toHaveProperty("totalAmount");
      if (money.mode === "timed_draw")
        expect(detail.activity.reward).toMatchObject({
          participantLimit: null,
          distributeFullPool: true,
        });
    }
  });

  it.each(["waiting", "settling"] as const)(
    "keeps an expired %s draw active in list filters until real result publication",
    async (state) => {
      const timed = await create(
        ldc(draw, { joinSquare: true, afterEndInfo: "ACTUAL_END_NOTE" }),
      );
      await register(timed.id);
      const deadline = Date.parse(timed.deadlineAt ?? "");
      expect(Number.isSafeInteger(deadline)).toBe(true);
      // Open draw deadlines are immutable. Advance the list's clock instead of changing it.
      vi.spyOn(Date, "now").mockReturnValue(deadline + 10000);
      if (state === "settling")
        await env.DB.prepare(
          "UPDATE activities SET draw_state='settling',draw_closed_at=deadline,ended_at=deadline WHERE id=?",
        )
          .bind(timed.id)
          .run();
      const beforeReads = await createDb(env.DB)
        .select()
        .from(activities)
        .where(eq(activities.id, timed.id))
        .get();
      const square = await data<DiscoveryList>(
        "/discovery/activities?status=active&type=timed_draw",
      );
      expect(square).toMatchObject({ total: 1, nextCursor: null });
      expect(square.items[0]).toMatchObject({
        id: timed.id,
        status: "active",
        draw: { state, winnerCount: null },
      });
      expect(
        (await data<DiscoveryList>("/discovery/activities?status=ended")).items,
      ).toEqual([]);
      const activeCounts = {
        all: 1,
        draft: 0,
        active: 1,
        ended: 0,
        archived: 0,
      };
      const initiated = await data<ActivityList>(
        "/me/activities?status=active&type=timed_draw",
        owner,
      );
      expect(initiated).toMatchObject({ total: 1, statusCounts: activeCounts });
      expect(initiated.items[0]).toMatchObject({
        id: timed.id,
        status: "active",
        draw: { state },
      });
      const participated = await data<ParticipationList>(
        "/me/participations?status=active&type=timed_draw",
        participant,
      );
      expect(participated).toMatchObject({
        total: 1,
        statusCounts: activeCounts,
      });
      expect(participated.items[0]).toMatchObject({
        kind: "registration",
        registration: {
          claim: null,
          activity: {
            id: timed.id,
            status: "active",
            draw: { state },
            createdAt: timed.createdAt,
            author: { id: owner.id },
          },
        },
      });
      const activePaymentActivities = await data<ActivityPaymentList>(
        "/me/payment-activities?status=active",
        owner,
      );
      expect(activePaymentActivities).toMatchObject({
        total: 1,
        items: [{ id: timed.id, status: "active", draw: { state } }],
      });
      expect(
        await data<ActivityPaymentList>(
          "/me/payment-activities?status=ended",
          owner,
        ),
      ).toMatchObject({ total: 0, items: [] });
      // Business detail and its ended-note permission keep their original semantics.
      const detail = await data<{ activity: PublicActivity }>(
        `/activities/${timed.id}`,
      );
      expect(detail.activity.status).toBe("ended");
      expect(detail.activity.afterEndInfo).toBe("ACTUAL_END_NOTE");
      expect(
        await createDb(env.DB)
          .select()
          .from(activities)
          .where(eq(activities.id, timed.id))
          .get(),
      ).toEqual(beforeReads);
      // The real settlement service consumes a persisted close, independently of the list clock.
      if (state === "waiting")
        await env.DB.prepare(
          "UPDATE activities SET ended_at=deadline WHERE id=?",
        )
          .bind(timed.id)
          .run();
      expect(await refreshTimedDraw(bindings, timed.id)).toBe(true);
      const published = await createDb(env.DB)
        .select()
        .from(activities)
        .where(eq(activities.id, timed.id))
        .get();
      expect(published?.drawState).toBe("completed");
      expect(published?.drawPublishedAt).toEqual(expect.any(Number));
      expect(
        (
          await data<{ activity: { status: string } }>(
            `/me/activities/${timed.id}`,
            owner,
          )
        ).activity.status,
      ).toBe("ended");
      expect(
        (await data<DiscoveryList>("/discovery/activities?status=active"))
          .total,
      ).toBe(0);
      const endedSquare = await data<DiscoveryList>(
        "/discovery/activities?status=ended&type=timed_draw",
      );
      expect(endedSquare.total).toBe(1);
      expect(endedSquare.items[0]).toMatchObject({
        id: timed.id,
        status: "ended",
        draw: { state: "completed", winnerCount: 1 },
      });
      const endedCounts = { ...activeCounts, active: 0, ended: 1 };
      const endedInitiated = await data<ActivityList>(
        "/me/activities?status=ended&type=timed_draw",
        owner,
      );
      expect(endedInitiated).toMatchObject({
        total: 1,
        statusCounts: endedCounts,
      });
      expect(endedInitiated.items[0]).toMatchObject({
        id: timed.id,
        status: "ended",
        draw: { state: "completed" },
      });
      const endedParticipated = await data<ParticipationList>(
        "/me/participations?status=ended&type=timed_draw",
        participant,
      );
      expect(endedParticipated).toMatchObject({
        total: 1,
        statusCounts: endedCounts,
      });
      const endedPaymentActivities = await data<ActivityPaymentList>(
        "/me/payment-activities?status=ended",
        owner,
      );
      expect(endedPaymentActivities).toMatchObject({
        total: 1,
        items: [
          { id: timed.id, status: "ended", draw: { state: "completed" } },
        ],
      });
      expect(endedParticipated.items).toHaveLength(1);
      expect(endedParticipated.items[0]).toMatchObject({
        kind: "registration",
        registration: {
          status: "won",
          activity: {
            id: timed.id,
            status: "ended",
            draw: { state: "completed" },
          },
          claim: { rewardType: "ldc", amount: "1.00" },
        },
      });
    },
  );

  it("keeps an old settling draw discoverable until it is explicitly archived", async () => {
    const timed = await create(ldc(draw, { joinSquare: true }));
    await register(timed.id);
    const deadline = Date.parse(timed.deadlineAt ?? "");
    vi.spyOn(Date, "now").mockReturnValue(deadline + ARCHIVE_DELAY_MS + 10000);
    await env.DB.prepare(
      "UPDATE activities SET ended_at=deadline,draw_closed_at=deadline,draw_state='settling' WHERE id=?",
    )
      .bind(timed.id)
      .run();
    const square = await data<DiscoveryList>(
      "/discovery/activities?status=active",
    );
    expect(square.total).toBe(1);
    expect(square.items[0]).toMatchObject({
      id: timed.id,
      status: "active",
      draw: { state: "settling" },
    });
    for (const [path, user] of [
      ["/me/activities?status=active", owner],
      ["/me/participations?status=active", participant],
    ] as const) {
      expect(
        await data<ActivityList | ParticipationList>(path, user),
      ).toMatchObject({
        total: 1,
        statusCounts: { all: 1, active: 1, ended: 0, archived: 0 },
      });
    }
    await env.DB.prepare("UPDATE activities SET archived_at=? WHERE id=?")
      .bind(Date.now(), timed.id)
      .run();
    expect((await data<DiscoveryList>("/discovery/activities")).total).toBe(0);
    expect(
      await data<ActivityList>("/me/activities?status=archived", owner),
    ).toMatchObject({
      total: 1,
      statusCounts: { all: 1, active: 0, ended: 0, archived: 1 },
      items: [{ id: timed.id, status: "archived" }],
    });
  });

  it("keeps an ordinary immediate activity ended after its deadline without a lifecycle sweep", async () => {
    const immediate = await create(
      ldc(
        { mode: "fixed", totalAmount: "2.00", count: 2 },
        { joinSquare: true, afterEndInfo: "ORDINARY_END_NOTE" },
      ),
    );
    await redeem(immediate.id);
    await env.DB.prepare("UPDATE activities SET deadline=? WHERE id=?")
      .bind(Date.now() - 10000, immediate.id)
      .run();
    expect(
      (await data<DiscoveryList>("/discovery/activities?status=active")).total,
    ).toBe(0);
    const square = await data<DiscoveryList>(
      "/discovery/activities?status=ended&type=fixed",
    );
    expect(square.total).toBe(1);
    expect(square.items[0]).toMatchObject({
      id: immediate.id,
      status: "ended",
    });
    expect(square.items[0]).not.toHaveProperty("draw");
    for (const [path, user] of [
      ["/me/activities?status=ended&type=fixed", owner],
      ["/me/participations?status=ended&type=fixed", participant],
    ] as const) {
      expect(
        await data<ActivityList | ParticipationList>(path, user),
      ).toMatchObject({
        total: 1,
        statusCounts: { all: 1, active: 0, ended: 1, archived: 0 },
      });
    }
    const detail = await data<{ activity: PublicActivity }>(
      `/activities/${immediate.id}`,
    );
    expect(detail.activity.status).toBe("ended");
    expect(detail.activity.afterEndInfo).toBe("ORDINARY_END_NOTE");
  });

  it("counts complete author lifecycles and distinct participations independently of filters", async () => {
    await create(undefined, false);
    const active = await create();
    await redeem(active.id);
    const ended = await create();
    await env.DB.prepare(
      "UPDATE activities SET ended_at=?,deadline=? WHERE id=?",
    )
      .bind(Date.now() - 10, Date.now() - 10, ended.id)
      .run();
    const archived = await create();
    await redeem(archived.id);
    await env.DB.prepare("UPDATE activities SET ended_at=? WHERE id=?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 10000, archived.id)
      .run();
    const timed = await create(ldc({ ...draw, participantLimit: 1 }));
    await register(timed.id);
    await refreshTimedDraw(bindings, timed.id);
    const other = await create(undefined, true, outsider);
    expect(other.id).toBeTruthy();
    const mine = await data<ActivityList>(
      "/me/activities?type=ldc&status=active",
      owner,
    );
    expect(mine.items.map((row) => row.id)).toEqual([active.id]);
    expect(mine.total).toBe(1);
    expect(mine.statusCounts).toEqual({
      all: 5,
      draft: 1,
      active: 1,
      ended: 2,
      archived: 1,
    });
    // 已结束 includes 已归档 (redesign 07 §3).
    const finished = await data<ActivityList>(
      "/me/activities?status=finished",
      owner,
    );
    expect(finished.total).toBe(3);
    expect(new Set(finished.items.map((row) => row.id))).toEqual(
      new Set([ended.id, archived.id, timed.id]),
    );
    // Amounts count every claim and prize, paid or not: two claims and the
    // drawn prize, 1.00 each.
    expect(await data("/me/history-summary", owner)).toEqual({
      initiatedCount: 5,
      participatedCount: 0,
      sentAmount: "3.00",
      receivedAmount: "0.00",
    });
    expect(await data("/me/history-summary", participant)).toEqual({
      initiatedCount: 0,
      participatedCount: 3,
      sentAmount: "0.00",
      receivedAmount: "3.00",
    });
    const history = await data<ParticipationList>(
      "/me/participations",
      participant,
    );
    expect(history.total).toBe(3);
    expect(history.items).toHaveLength(3);
    const timedHistory = await data<ParticipationList>(
      "/me/participations?type=timed_draw",
      participant,
    );
    expect(timedHistory.items).toHaveLength(1);
    expect(timedHistory.items[0]).toMatchObject({
      kind: "registration",
      registration: {
        sourcePassword: "ActualSource",
        status: "won",
        claim: { amount: "1.00", payment: { confirmedAt: null } },
      },
    });
    expect(
      (await data<ParticipationList>("/me/participations", outsider)).items,
    ).toEqual([]);
    expect((await get("/me/history-summary")).status).toBe(401);
  });

  it("projects current safe author profiles and activity creation times across participation authors", async () => {
    const first = await create();
    const second = await create(undefined, true, outsider);
    await redeem(first.id);
    await redeem(second.id);
    await createDb(env.DB)
      .update(users)
      .set({ username: "renamed_author", displayName: "Renamed Author" })
      .where(eq(users.id, outsider.id));
    const history = await data<ParticipationList>(
      "/me/participations",
      participant,
    );
    expect(history.items).toHaveLength(2);
    for (const item of history.items) {
      if (item.kind !== "claim") throw new Error("Expected ordinary claim");
      const activity = item.claim.activity;
      const saved = activity.id === first.id ? first : second;
      const authorId = activity.id === first.id ? owner.id : outsider.id;
      expect(activity.createdAt).toBe(saved.createdAt);
      expect(activity.author).toMatchObject({ id: authorId });
      expect(Object.keys(activity.author ?? {}).sort()).toEqual([
        "avatarUrl",
        "displayName",
        "id",
        "username",
      ]);
      if (activity.id === second.id)
        expect(activity.author).toMatchObject({
          username: "renamed_author",
          displayName: "Renamed Author",
        });
    }
  });

  it("returns actual successful passwords and LDC summaries without decrypting private text", async () => {
    const text = await create();
    await redeem(text.id);
    const money = await create(
      ldc(
        { mode: "fixed", totalAmount: "2.00", count: 2 },
        { quantityVisibility: "fuzzy" },
      ),
    );
    await redeem(money.id);

    const history = await data<ParticipationList>(
      "/me/participations",
      participant,
    );
    expect(history.total).toBe(2);
    for (const item of history.items) {
      if (item.kind !== "claim") throw new Error("Expected ordinary claim");
      expect(item.claim.sourcePassword).toBe("ActualSource");
      expect(item.claim.activity.deadlineAt).toMatch(/^\d{4}-/);
      expect(item.claim).not.toHaveProperty("text");
      expect(item.claim).not.toHaveProperty("afterClaimInfo");
      if (item.claim.rewardType === "ldc") {
        expect(item.claim).toMatchObject({
          amount: "1.00",
          payment: { status: "pending", confirmedAt: null },
        });
      }
    }
    expect(JSON.stringify(history)).not.toMatch(
      /PRIVATE_TEXT_REWARD|PRIVATE_CLAIM_NOTE|FirstPassword/,
    );
  });

  it("lists the account's payments grouped by 红包, latest first, across pages and filters", async () => {
    const earlier = await create(
      ldc({ mode: "fixed", totalAmount: "4.00", count: 4 }),
    );
    const later = await create(
      ldc({ mode: "fixed", totalAmount: "22.00", count: 22 }),
    );
    const entrants = await Promise.all(Array.from({ length: 22 }, actor));
    for (const user of entrants.slice(0, 4)) await redeem(earlier.id, user);
    for (const user of entrants) await redeem(later.id, user);
    await create(undefined, true, outsider);
    // One confirmed and one paused payment in the earlier 红包.
    await env.DB.prepare(
      `UPDATE payment_tasks SET status=CASE WHEN id=(SELECT MIN(p.id) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?1) THEN 'confirmed' ELSE 'attention' END,
        confirmed_at=CASE WHEN id=(SELECT MIN(p.id) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?1) THEN created_at+100 END
        WHERE id IN (SELECT p.id FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?1 ORDER BY p.id LIMIT 2)`,
    )
      .bind(earlier.id)
      .run();

    const first = await data<AccountPaymentList>("/me/payments", owner);
    expect(first.total).toBe(26);
    expect(first.summary).toEqual({
      confirmedAmount: "1.00",
      confirmedCount: 1,
      openAmount: "25.00",
      openCount: 25,
      attentionCount: 1,
      repairableCount: 0,
      firstRepairableId: null,
    });
    expect(first.items).toHaveLength(20);
    // The 红包 paid most recently comes first, its payments together.
    expect(first.items.every((item) => item.activityId === later.id)).toBe(
      true,
    );
    expect(first.items[0]?.recipientProfile.username).toBeTruthy();
    expect(Object.keys(first.activities)).toEqual([later.id]);
    const second = await data<AccountPaymentList>(
      `/me/payments?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      owner,
    );
    expect(second.items.map((item) => item.activityId)).toEqual([
      later.id,
      later.id,
      ...Array<string>(4).fill(earlier.id),
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(26);
    expect(second.activities[earlier.id]).toMatchObject({
      id: earlier.id,
      confirmedAmount: "1.00",
      claimedCount: 4,
    });

    const confirmed = await data<AccountPaymentList>(
      "/me/payments?status=confirmed",
      owner,
    );
    expect(confirmed.total).toBe(1);
    expect(confirmed.items.map((item) => item.status)).toEqual(["confirmed"]);
    const one = await data<AccountPaymentList>(
      `/me/payments?activity=${earlier.id}&status=open`,
      owner,
    );
    expect(one.total).toBe(3);
    expect(one.summary).toMatchObject({ confirmedCount: 1, openCount: 3 });
    expect(
      (await data<AccountPaymentList>("/me/payments", outsider)).total,
    ).toBe(0);
    expect((await get("/me/payments?status=pending", owner)).status).toBe(400);
    expect(
      (
        await get(
          `/me/payments?cursor=${encodeURIComponent(first.nextCursor ?? "")}&status=open`,
          owner,
        )
      ).status,
    ).toBe(400);

    // The merchant page's numbers: both 红包 are sold out, so none runs.
    expect(await data(`/me/merchants/${merchantId}/usage`, owner)).toEqual({
      activities: 2,
      activeActivities: 0,
      payments: 26,
      openPayments: 25,
      openAmount: "25.00",
      confirmedAmount: "1.00",
    });
    expect(
      (await get(`/me/merchants/${merchantId}/usage`, outsider)).status,
    ).toBe(404);

    const paused = one.items.find((item) => item.status === "attention");
    const detail = await data<AccountPaymentDetail>(
      `/me/payments/${paused?.id}`,
      owner,
    );
    expect(detail.payment).toMatchObject({
      id: paused?.id,
      status: "attention",
    });
    expect(detail.merchant.id).toBe(paused?.merchantId);
    expect(detail.activity).toEqual({
      id: earlier.id,
      title: earlier.title,
      draw: false,
    });
    expect((await get(`/me/payments/${paused?.id}`, outsider)).status).toBe(
      404,
    );
    expect((await get(`/me/payments/${paused?.id}`)).status).toBe(401);
  });

  it("keeps zero-target activities and whole-activity totals across filtered target pages", async () => {
    const selected = await create(
      ldc({
        mode: "custom",
        amounts: Array.from({ length: 24 }, (_, index) => `${index + 1}.00`),
      }),
    );
    const zero = await create(
      ldc({ mode: "fixed", totalAmount: "2.00", count: 2 }),
    );
    await create(ldc({ mode: "fixed", totalAmount: "1.00", count: 1 }), false);
    await create(undefined, true, outsider);
    const entrants = await Promise.all(Array.from({ length: 23 }, actor));
    for (const user of entrants) await redeem(selected.id, user);
    await env.DB.prepare(
      "UPDATE payment_tasks SET status='confirmed',confirmed_at=created_at+100 WHERE id IN (SELECT p.id FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=? ORDER BY p.amount_minor DESC LIMIT 2)",
    )
      .bind(selected.id)
      .run();
    const activityList = await data<ActivityPaymentList>(
      "/me/payment-activities",
      owner,
    );
    expect(activityList.total).toBe(2);
    expect(new Set(activityList.items.map((row) => row.id))).toEqual(
      new Set([selected.id, zero.id]),
    );
    for (const row of activityList.items)
      expect(row).not.toHaveProperty("summary");
    const first = await data<ActivityPaymentTargetList>(
      `/me/activities/${selected.id}/payments?status=pending`,
      owner,
    );
    expect(first.total).toBe(21);
    expect(first.items).toHaveLength(20);
    expect(first.summary).toEqual({
      totalCount: 23,
      pendingCount: 21,
      confirmedCount: 2,
      pendingAmount: "231.00",
      confirmedAmount: "45.00",
      totalAmount: "276.00",
    });
    expect(first.items[0]?.recipientProfile).toMatchObject({
      username: expect.stringMatching(/^member_/),
    });
    const second = await data<ActivityPaymentTargetList>(
      `/me/activities/${selected.id}/payments?status=pending&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      owner,
    );
    expect(second.items).toHaveLength(1);
    expect(second.summary).toEqual(first.summary);
    expect(second.total).toBe(21);
    const confirmed = await data<ActivityPaymentTargetList>(
      `/me/activities/${selected.id}/payments?status=confirmed`,
      owner,
    );
    expect(confirmed.items).toHaveLength(2);
    expect(confirmed.summary).toEqual(first.summary);
    expect(confirmed.items.every((row) => row.confirmedAt !== null)).toBe(true);
    const empty = await data<ActivityPaymentTargetList>(
      `/me/activities/${zero.id}/payments`,
      owner,
    );
    expect(empty.items).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.summary.totalAmount).toBe("0.00");
    expect(
      (await get(`/me/activities/${selected.id}/payments`, outsider)).status,
    ).toBe(404);
    expect(
      (
        await get(
          `/me/activities/${zero.id}/payments?status=pending&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
          owner,
        )
      ).status,
    ).toBe(400);
  });

  it("computes full-roster ties before pagination, oldest first, whatever the retired switches say", async () => {
    const activity = await create(
      ldc({
        mode: "custom",
        amounts: [
          ...Array<string>(21).fill("1.00"),
          "9.00",
          "9.00",
          "5.00",
          "9.00",
        ],
      }),
    );
    const entrants = await Promise.all(Array.from({ length: 24 }, actor));
    for (const user of entrants) await redeem(activity.id, user);
    const first = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients`,
    );
    expect(first.items).toHaveLength(20);
    expect(first.titles?.highestClaimIds).toHaveLength(2);
    expect(first.titles?.lowestClaimIds).toEqual([]);
    expect(first.items.every((row) => row.title === undefined)).toBe(true);
    const second = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.titles).toEqual(first.titles);
    expect(second.items.map((row) => row.amount)).toEqual([
      "1.00",
      "9.00",
      "9.00",
      "5.00",
    ]);
    expect(second.items.filter((row) => row.title === "highest")).toHaveLength(
      2,
    );
    await redeem(activity.id, await actor());
    expect(
      (await data<PublicRecipientList>(`/activities/${activity.id}/recipients`))
        .titles?.highestClaimIds,
    ).toEqual([]);
    // Old 红包 may still store the retired switches: they change nothing.
    await env.DB.prepare(
      "UPDATE activities SET config=json_set(config,'$.showRecipientList',json('false'),'$.showRecipientUsername',json('false'),'$.showRecipientTime',json('false'),'$.showRecipientAmount',json('false')) WHERE id=?",
    )
      .bind(activity.id)
      .run();
    const legacy = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients`,
    );
    expect(legacy.items).toEqual(first.items);
    for (const row of legacy.items) {
      expect(row.username).toMatch(/\S/);
      expect(row).toHaveProperty("amount");
      expect(row).toHaveProperty("claimedAt");
    }
    const detail = await data<{ activity: PublicActivity }>(
      `/activities/${activity.id}`,
    );
    for (const key of [
      "showRecipientList",
      "showRecipientUsername",
      "showRecipientTime",
      "showRecipientAmount",
    ])
      expect(detail.activity).not.toHaveProperty(key);
  });

  it("computes speed titles over the whole roster, whatever the retired switches say", async () => {
    const activity = await create(
      ldc({ mode: "fixed", totalAmount: "22.00", count: 22 }),
    );
    if (activity.openedAt === null) throw new Error("Expected opened activity");
    const openedAt = new Date(activity.openedAt).getTime();
    const entrants = await Promise.all(Array.from({ length: 22 }, actor));
    const claimIds: string[] = [];
    for (const user of entrants) {
      const result = await redeem(activity.id, user);
      if (!("claim" in result)) throw new Error("Expected claim");
      claimIds.push(result.claim.id);
    }
    const times = claimIds.map((id, index) => ({
      id,
      time: openedAt + (index < 2 ? 10_000 : 20_000 + index),
    }));
    await env.DB.batch(
      times.map(({ id, time }) =>
        env.DB.prepare("UPDATE claims SET claimed_at=? WHERE id=?").bind(
          time,
          id,
        ),
      ),
    );

    const first = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients`,
    );
    expect(first.items).toHaveLength(20);
    expect(first.items.map((row) => row.speedTitle)).toEqual([
      "flash",
      "flash",
      ...Array<undefined>(18).fill(undefined),
    ]);
    const second = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.items.map((row) => row.speedTitle)).toEqual([
      undefined,
      undefined,
    ]);

    await env.DB.batch(
      claimIds
        .slice(0, 2)
        .map((id) =>
          env.DB.prepare("UPDATE claims SET claimed_at=? WHERE id=?").bind(
            openedAt + 10_001,
            id,
          ),
        ),
    );
    const afterThreshold = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients`,
    );
    expect(
      afterThreshold.items.slice(0, 3).map((row) => row.speedTitle),
    ).toEqual(["fastest", "fastest", undefined]);

    // Old 红包 may still store the retired switches: they change nothing.
    await env.DB.prepare(
      "UPDATE activities SET config=json_set(config,'$.showRecipientTime',json('false'),'$.showRecipientAmount',json('false')) WHERE id=?",
    )
      .bind(activity.id)
      .run();
    const legacy = await data<PublicRecipientList>(
      `/activities/${activity.id}/recipients`,
    );
    expect(legacy.items).toEqual(afterThreshold.items);
    for (const row of legacy.items) {
      expect(row).toHaveProperty("amount");
      expect(row).toHaveProperty("claimedAt");
    }
    const author = await data<AuthorClaimList>(
      `/me/activities/${activity.id}/claims`,
      owner,
    );
    expect(author.items.slice(0, 3).map((row) => row.speedTitle)).toEqual([
      "fastest",
      "fastest",
      undefined,
    ]);

    await env.DB.prepare("UPDATE claims SET claimed_at=? WHERE id=?")
      .bind(openedAt - 1, claimIds[0])
      .run();
    const preopenIgnored = await data<AuthorClaimList>(
      `/me/activities/${activity.id}/claims`,
      owner,
    );
    expect(preopenIgnored.items[0]?.id).toBe(claimIds[0]);
    expect(
      preopenIgnored.items.slice(0, 2).map((row) => row.speedTitle),
    ).toEqual([undefined, "fastest"]);
  });

  it("does not assign speed titles to automated draw winners", async () => {
    const timed = await create(ldc({ ...draw, participantLimit: 1 }));
    await register(timed.id, await actor());
    await refreshTimedDraw(bindings, timed.id);
    const recipients = await data<PublicRecipientList>(
      `/activities/${timed.id}/recipients`,
    );
    expect(recipients.items).toHaveLength(1);
    expect(recipients.items[0]).not.toHaveProperty("speedTitle");
  });

  it("offers a separate public registration roster with 20-row protected cursors", async () => {
    const timed = await create(ldc(draw));
    const entrants = await Promise.all(Array.from({ length: 21 }, actor));
    for (const user of entrants) await register(timed.id, user);
    const first = await data<PublicRegistrationList>(
      `/activities/${timed.id}/registrations`,
    );
    expect(first.items).toHaveLength(20);
    const registeredTimes = first.items.map((row) =>
      Date.parse(row.registeredAt),
    );
    expect(registeredTimes).toEqual([...registeredTimes].sort((a, b) => a - b));
    expect(JSON.stringify(first)).not.toMatch(
      /ActualSource|FirstPassword|passwordId|userId|afterClaimInfo|PRIVATE|claim/,
    );
    const second = await data<PublicRegistrationList>(
      `/activities/${timed.id}/registrations?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(second.items).toHaveLength(1);
    const waiting = await data<PublicRecipientList>(
      `/activities/${timed.id}/recipients`,
    );
    expect(waiting.items).toEqual([]);
    expect(waiting.titles).toEqual({ highestClaimIds: [], lowestClaimIds: [] });
    const other = await create(ldc(draw));
    expect(
      (
        await get(
          `/activities/${other.id}/registrations?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await get(`/me/activities/${timed.id}/registrations`, outsider)).status,
    ).toBe(404);
    await env.DB.prepare(
      "UPDATE activities SET config=json_set(config,'$.showRecipientList',json('false')) WHERE id=?",
    )
      .bind(timed.id)
      .run();
    const stillPublic = await data<PublicRegistrationList>(
      `/activities/${timed.id}/registrations`,
    );
    expect(stillPublic.items).toEqual(first.items);
    expect(stillPublic).not.toHaveProperty("enabled");
    const draft = await create(ldc(draw), false);
    expect((await get(`/activities/${draft.id}/registrations`)).status).toBe(
      404,
    );
  });
});
