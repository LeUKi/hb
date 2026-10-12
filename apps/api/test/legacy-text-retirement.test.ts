import {
  createExecutionContext,
  createScheduledController,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import type {
  AdminOverview,
  AdminUserDetail,
  DiscoveryList,
  GlobalRedemptionResult,
} from "@hb/contracts";
import { emptyActivityInput } from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumePendingActivityClaims } from "../src/activities/claim-service";
import { saveDrawPlan } from "../src/activities/draw-service";
import {
  refreshActivityLifecycle,
  sweepActivityLifecycle,
} from "../src/activities/lifecycle";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import worker from "../src/index";
import { createMerchant } from "../src/payments/merchants";
import { digestPassword, sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};

type Actor = { id: string; cookie: string; csrf: string };

async function actor(username: string, officialConnectVerified = true) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB).insert(users).values({
    id,
    externalId: username,
    username,
    displayName: username,
    officialConnectVerified,
    createdAt: now,
    updatedAt: now,
  });
  await createDb(env.DB)
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
      userId: id,
      csrfToken: csrf,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(
  path: string,
  user?: Actor,
  method = "GET",
  body?: unknown,
  target = bindings,
) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(user ? { Cookie: user.cookie } : {}),
        ...(method !== "GET"
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user?.csrf ?? "",
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    target,
  );
}

async function resetData() {
  for (const table of [
    "payment_outbox",
    "payment_tasks",
    "attempt_events",
    "redemption_submissions",
    "claims",
    "global_redemptions",
    "activity_registrations",
    "activity_draw_plans",
    "account_attempt_cooldowns",
    "reward_inventory",
    "activity_passwords",
    "activities",
    "sessions",
    "users",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
}

async function seedLegacyText(authorId: string, password = "LEGACY1") {
  const id = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const inventoryId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
       participation_mode,join_square,deleted_at,allocation,config,total_count,
       claimed_count,registered_count,reward_type,topic_id,post_number,
       created_at,updated_at,opened_at,deadline,draw_state,draw_closed_at,draw_reason)
      VALUES (?,?,?,'legacy-digest','Legacy text',0,'password',1,NULL,'sequential',
        ?,1,0,0,'text','2964597',1,?,?,?,?, 'settling',?,'manual')`).bind(
      id,
      authorId,
      `legacy-${id}`,
      JSON.stringify({
        rewardType: "text",
        title: null,
        money: "SENSITIVE-RETIRED-CONFIG",
      }),
      now - 2000,
      now - 1000,
      now - 1000,
      now - 100,
      now - 1000,
    ),
    env.DB.prepare(
      "INSERT INTO activity_passwords(id,activity_id,digest,ciphertext,position,created_at) VALUES(?,?,?,?,0,?)",
    ).bind(
      passwordId,
      id,
      await digestPassword(password, env.PASSWORD_DIGEST_KEY),
      "not-valid-encrypted-password",
      now - 1000,
    ),
    env.DB.prepare(
      "INSERT INTO reward_inventory(id,activity_id,position,kind,ciphertext,amount_minor,created_at) VALUES(?,?,0,'text','not-valid-encrypted-reward',NULL,?)",
    ).bind(inventoryId, id, now - 1000),
    env.DB.prepare(
      "INSERT INTO activity_draw_plans(activity_id,participant_count,payload,created_at) VALUES(?,0,?,?)",
    ).bind(
      id,
      JSON.stringify({ retired: "SENSITIVE-RETIRED-DRAW-PLAN" }),
      now - 1000,
    ),
  ]);
  return { id, passwordId, inventoryId };
}

async function activitySnapshot(id: string) {
  const predicates = {
    activities: "id=?",
    activity_passwords: "activity_id=?",
    reward_inventory: "activity_id=?",
    claims: "activity_id=?",
    redemption_submissions: "activity_id=?",
    attempt_events: "activity_id=?",
    activity_registrations: "activity_id=?",
    activity_draw_plans: "activity_id=?",
    payment_tasks: "claim_id IN (SELECT id FROM claims WHERE activity_id=?)",
    payment_outbox:
      "task_id IN (SELECT id FROM payment_tasks WHERE claim_id IN (SELECT id FROM claims WHERE activity_id=?))",
  };
  return Promise.all(
    Object.entries(predicates).map(async ([table, predicate]) => ({
      table,
      rows: (
        await env.DB.prepare(
          `SELECT * FROM ${table} WHERE ${predicate} ORDER BY ${table === "activity_draw_plans" ? "activity_id" : "id"}`,
        )
          .bind(id)
          .all()
      ).results,
    })),
  );
}

async function legacySubmission(
  legacy: Awaited<ReturnType<typeof seedLegacyText>>,
  viewer: Actor,
  password: string,
  claimed = false,
) {
  const submissionId = crypto.randomUUID();
  const claimId = claimed ? crypto.randomUUID() : null;
  if (claimId) {
    await env.DB.prepare(`INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at)
      VALUES(?,?,?,?,?,100)`)
      .bind(
        claimId,
        legacy.id,
        viewer.id,
        legacy.inventoryId,
        legacy.passwordId,
      )
      .run();
    await env.DB.prepare("UPDATE activities SET claimed_count=1 WHERE id=?")
      .bind(legacy.id)
      .run();
  }
  await env.DB.prepare(`INSERT INTO redemption_submissions
    (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,matched_password_id,claim_id,created_at,validated_at,finished_at)
    VALUES (?,?,?,?,?,'claim','password',?,?,?,100,100,?)`)
    .bind(
      crypto.randomUUID(),
      legacy.id,
      viewer.id,
      submissionId,
      await digestPassword(
        `claim-request:${legacy.id}:${password}`,
        env.PASSWORD_DIGEST_KEY,
      ),
      claimed ? "claimed" : "pending",
      legacy.passwordId,
      claimId,
      claimed ? 100 : null,
    )
    .run();
  return { submissionId, claimId };
}

async function savedGlobal(
  viewer: Actor,
  candidates: string[],
  selected: string | null = null,
) {
  const id = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const password = "LEGACY4";
  const claimSubmissionId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO global_redemptions
    (id,user_id,submission_id,fingerprint,password_digest,candidate_ids,claim_submission_id,selected_activity_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(
      id,
      viewer.id,
      submissionId,
      await digestPassword(
        `global-redemption:${password}`,
        env.PASSWORD_DIGEST_KEY,
      ),
      await digestPassword(password, env.PASSWORD_DIGEST_KEY),
      JSON.stringify(candidates),
      claimSubmissionId,
      selected,
      Date.now(),
    )
    .run();
  return { id, submissionId, password, claimSubmissionId };
}

describe("retired text reward data", () => {
  beforeEach(resetData);

  it("hides legacy text activities before config or inventory decryption", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const legacy = await seedLegacyText(owner.id);

    expect((await request(`/api/activities/${legacy.id}`, viewer)).status).toBe(
      404,
    );
    expect(
      (await request(`/api/me/activities/${legacy.id}`, owner)).status,
    ).toBe(404);

    const square = (await (
      await request("/api/discovery/activities", viewer)
    ).json()) as DiscoveryList;
    expect(square.items.map((item) => item.id)).not.toContain(legacy.id);

    const topic = (await (
      await request("/api/topics/2964597/activities?postNumber=1", viewer)
    ).json()) as DiscoveryList;
    expect(topic.items.map((item) => item.id)).not.toContain(legacy.id);
  });

  it("does not create attempts, claims, payments or outbox entries for legacy global matches", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const legacy = await seedLegacyText(owner.id, "LEGACY2");

    const before = await activitySnapshot(legacy.id);
    const response = await request(
      "/api/redemptions/discover",
      viewer,
      "POST",
      {
        submissionId: crypto.randomUUID(),
        password: "LEGACY2",
      },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as GlobalRedemptionResult;
    expect(result.result).toBe("none");
    expect(result.items).toHaveLength(0);

    expect(await activitySnapshot(legacy.id)).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_attempt_cooldowns WHERE user_id=?",
      )
        .bind(viewer.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM redemption_submissions WHERE activity_id=?",
      )
        .bind(legacy.id)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it("does not wake or mutate legacy text activities from recovery paths", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const legacy = await seedLegacyText(owner.id, "LEGACY3");
    const submissionId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,matched_password_id,created_at,validated_at)
      VALUES (?,?,?,?,?,'claim','password','pending',?,100,100)`)
      .bind(
        crypto.randomUUID(),
        legacy.id,
        viewer.id,
        submissionId,
        "legacy-fingerprint",
        legacy.passwordId,
      )
      .run();

    const before = await activitySnapshot(legacy.id);
    expect(await saveDrawPlan(bindings, legacy.id)).toBeNull();
    expect(await resumePendingActivityClaims(bindings, legacy.id)).toBe(0);
    await refreshActivityLifecycle(bindings, legacy.id);
    expect(await sweepActivityLifecycle(bindings)).toBe(0);
    expect(await activitySnapshot(legacy.id)).toEqual(before);
  });

  it("returns not found for old public and private resources without waking ActivityDO", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const legacy = await seedLegacyText(owner.id);
    const { claimId } = await legacySubmission(legacy, viewer, "LEGACY1", true);
    const before = await activitySnapshot(legacy.id);
    const getObject = vi.fn(() => {
      throw new Error("RETIRED_DO_MUST_NOT_WAKE");
    });
    const protectedBindings: ApiBindings = {
      ...bindings,
      ACTIVITY_DO: {
        idFromName: (name: string) => bindings.ACTIVITY_DO.idFromName(name),
        get: getObject,
      } as unknown as ApiBindings["ACTIVITY_DO"],
    };
    for (const [path, user] of [
      [`/api/activities/${legacy.id}`, viewer],
      [`/api/activities/${legacy.id}/claim`, viewer],
      [`/api/activities/${legacy.id}/registration`, viewer],
      [`/api/activities/${legacy.id}/participation?refresh=1`, viewer],
      [`/api/activities/${legacy.id}/passwords`, viewer],
      [`/api/activities/${legacy.id}/recipients`, viewer],
      [`/api/activities/${legacy.id}/registrations`, viewer],
      [`/api/me/activities/${legacy.id}`, owner],
      [`/api/me/activities/${legacy.id}/claims`, owner],
      [`/api/me/activities/${legacy.id}/registrations`, owner],
      [`/api/me/activities/${legacy.id}/statistics`, owner],
      [`/api/me/claims/${claimId}`, viewer],
    ] as const) {
      const response = await request(
        path,
        user,
        "GET",
        undefined,
        protectedBindings,
      );
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toMatch(
        /SENSITIVE-RETIRED|not-valid-encrypted/,
      );
    }
    expect(getObject).not.toHaveBeenCalled();
    expect(await activitySnapshot(legacy.id)).toEqual(before);
  });

  it("preserves claimed and pending submissions across original retries, internal refresh, alarm and Cron", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const pendingActivity = await seedLegacyText(owner.id, "LEGACY3");
    const pending = await legacySubmission(pendingActivity, viewer, "LEGACY3");
    const claimedActivity = await seedLegacyText(owner.id, "LEGACY1");
    const claimed = await legacySubmission(
      claimedActivity,
      viewer,
      "LEGACY1",
      true,
    );
    const before = await Promise.all(
      [pendingActivity, claimedActivity].map((x) => activitySnapshot(x.id)),
    );
    for (const [legacy, submitted, password] of [
      [pendingActivity, pending, "LEGACY3"],
      [claimedActivity, claimed, "LEGACY1"],
    ] as const) {
      const response = await request(
        `/api/activities/${legacy.id}/claim`,
        viewer,
        "POST",
        {
          submissionId: submitted.submissionId,
          password,
        },
      );
      expect(response.status).toBe(404);
      const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(legacy.id));
      const refresh = await stub.fetch(
        `https://activity.internal/internal/activities/${legacy.id}/refresh`,
        { method: "POST" },
      );
      expect(refresh.status).toBe(404);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("drawActivityId", legacy.id);
        await state.storage.setAlarm(Date.now() + 60_000);
      });
      await runDurableObjectAlarm(stub);
      expect(
        await runInDurableObject(stub, async (_instance, state) => ({
          id: await state.storage.get("drawActivityId"),
          alarm: await state.storage.getAlarm(),
        })),
      ).toEqual({ id: undefined, alarm: null });
    }
    await worker.scheduled(
      createScheduledController({
        cron: "*/5 * * * *",
        scheduledTime: Date.now(),
      }),
      bindings,
      createExecutionContext(),
    );
    expect(
      await Promise.all(
        [pendingActivity, claimedActivity].map((x) => activitySnapshot(x.id)),
      ),
    ).toEqual(before);
  });

  it("excludes old rows from all history and administrator totals", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const administrator = await actor("998877");
    const target = { ...bindings, ADMIN_LINUX_DO_IDS: "998877" };
    const legacy = await seedLegacyText(owner.id);
    await legacySubmission(legacy, viewer, "LEGACY1", true);
    for (const [path, user] of [
      ["/api/me/activities", owner],
      ["/api/me/claims", viewer],
      ["/api/me/participations", viewer],
      ["/api/admin/activities", administrator],
    ] as const) {
      const response = await request(path, user, "GET", undefined, target);
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        items: unknown[];
        total?: number;
      };
      expect(result.items).toEqual([]);
      if (result.total !== undefined) expect(result.total).toBe(0);
    }
    for (const user of [owner, viewer]) {
      expect(
        await (await request("/api/me/history-summary", user)).json(),
      ).toEqual({ initiatedCount: 0, participatedCount: 0 });
    }
    expect(
      (
        await request(
          `/api/admin/activities/${legacy.id}`,
          administrator,
          "GET",
          undefined,
          target,
        )
      ).status,
    ).toBe(404);
    const overview = (await (
      await request(
        "/api/admin/overview",
        administrator,
        "GET",
        undefined,
        target,
      )
    ).json()) as AdminOverview;
    expect(overview.counts.activities).toBe(0);
    expect(JSON.stringify(overview)).not.toMatch(
      /Legacy text|SENSITIVE-RETIRED/,
    );
    const detail = (await (
      await request(
        `/api/admin/users/${viewer.id}`,
        administrator,
        "GET",
        undefined,
        target,
      )
    ).json()) as { user: AdminUserDetail };
    expect(detail.user.counts.claims).toBe(0);
    expect((await activitySnapshot(legacy.id))[0]?.rows).toHaveLength(1);
  });

  it("keeps original mixed choices and restores a bound LDC beyond the first page", async () => {
    const owner = await actor("legacy-owner");
    const viewer = await actor("legacy-viewer");
    const legacy = await seedLegacyText(owner.id, "LEGACY4");
    const merchant = await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      label: "本地模拟",
      clientId: "retirement-merchant",
      secret: "LOCAL-ONLY",
    });
    const draft = await createActivity(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      activity: {
        ...emptyActivityInput(),
        title: "LDC candidate",
        merchantId: merchant.id,
        passwords: ["LEGACY4"],
      },
    });
    const ldc = await openActivity(bindings, draft.id, owner.id, draft.version);
    const mixed = await savedGlobal(viewer, [legacy.id, ldc.id]);
    const selectedText = await savedGlobal(
      viewer,
      [legacy.id, ldc.id],
      legacy.id,
    );
    const textOnly = await savedGlobal(viewer, [legacy.id]);
    for (const saved of [mixed, selectedText, textOnly]) {
      const before = await env.DB.prepare(
        "SELECT * FROM global_redemptions WHERE id=?",
      )
        .bind(saved.id)
        .first();
      const response = await request(`/api/redemptions/${saved.id}`, viewer);
      expect(response.status).toBe(saved === selectedText ? 404 : 200);
      if (saved !== selectedText) {
        const result = (await response.json()) as GlobalRedemptionResult;
        expect(result.result).toBe(saved === textOnly ? "single" : "multiple");
        expect(result.items.map((item) => item.id)).toEqual(
          saved === textOnly ? [] : [ldc.id],
        );
        expect(result).not.toHaveProperty("claimResult");
        expect(result).not.toHaveProperty("selectedActivityId");
      }
      const replay = await request("/api/redemptions", viewer, "POST", {
        submissionId: saved.submissionId,
        password: saved.password,
      });
      expect(replay.status).toBe(saved === mixed ? 200 : 404);
      if (saved === selectedText) {
        const beforeTarget = await activitySnapshot(ldc.id);
        const retarget = await request(
          `/api/activities/${ldc.id}/claim`,
          viewer,
          "POST",
          {
            submissionId: saved.claimSubmissionId,
            password: saved.password,
            discoveryId: saved.id,
          },
        );
        expect(retarget.status).toBe(409);
        expect(await activitySnapshot(ldc.id)).toEqual(beforeTarget);
      }
      expect(
        await env.DB.prepare("SELECT * FROM global_redemptions WHERE id=?")
          .bind(saved.id)
          .first(),
      ).toEqual(before);
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM claims").first("n"),
    ).toBe(0);

    const ids: string[] = [];
    for (let index = 0; index < 21; index++) {
      const draft = await createActivity(bindings, owner.id, {
        requestId: crypto.randomUUID(),
        activity: {
          ...emptyActivityInput(),
          title: `LDC candidate ${index}`,
          merchantId: merchant.id,
          passwords: ["LEGACY4"],
        },
      });
      ids.push(
        (await openActivity(bindings, draft.id, owner.id, draft.version)).id,
      );
    }
    const selected = ids[0];
    if (!selected) throw new Error("Missing LDC candidate");
    const saved = await savedGlobal(viewer, ids, selected);
    const original = await env.DB.prepare(
      "SELECT * FROM global_redemptions WHERE id=?",
    )
      .bind(saved.id)
      .first();
    const response = await request(`/api/redemptions/${saved.id}`, viewer);
    expect(response.status).toBe(200);
    const result = (await response.json()) as GlobalRedemptionResult;
    expect(result.items).toHaveLength(20);
    expect(result.items.map((item) => item.id)).not.toContain(selected);
    expect(result).toMatchObject({
      result: "multiple",
      selectedActivityId: selected,
      claimSubmissionId: saved.claimSubmissionId,
    });
    expect(
      await env.DB.prepare("SELECT * FROM global_redemptions WHERE id=?")
        .bind(saved.id)
        .first(),
    ).toEqual(original);
  });
});
