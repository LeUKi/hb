import { env } from "cloudflare:test";
import {
  type ActivityInput,
  activityInputSchema,
  type ClaimActivityInput,
  type ClaimResult,
  emptyActivityInput,
  type LdcActivityInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimActivity,
  completeClaimSubmission,
  findSubmission,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import {
  type DrawPlan,
  publishDrawPlan,
  refreshTimedDraw,
  saveDrawPlan,
} from "../src/activities/draw-service";
import {
  getActivityPasswords,
  solveActivityPassword,
} from "../src/activities/password-service";
import { getCurrentParticipation } from "../src/activities/registration-queries";
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
  privateRows,
} from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { discoverGlobalRedemption } from "../src/discovery/service";
import { getStatistics } from "../src/discovery/statistics";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { readAttemptCooldown } from "../src/runtime/attempt-cooldown";
import { digestPassword, sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;
let merchantId: string;
let actorNumber = 50_000;

async function actor(official = true): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const number = ++actorNumber;
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: String(number),
    username: `Direct${number}`,
    displayName: `参与者 ${number}`,
    officialConnectVerified: official,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    loginProvider: official ? "connect" : "liteauth",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(path: string, user?: Actor, method = "GET", body?: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(user ? { Cookie: user.cookie } : {}),
        ...(method === "GET"
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user?.csrf ?? "",
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

function directInput(extra: Partial<LdcActivityInput> = {}): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "无需口令的活动",
    participationMode: "direct",
    passwords: [],
    merchantId,
    money: { mode: "fixed", totalAmount: "1.00", count: 2 },
    ...extra,
  };
}

async function save(input: ActivityInput, open = true) {
  const draft = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open
    ? openActivity(bindings, draft.id, owner.id, draft.version)
    : draft;
}

function ldcInput(money: LdcActivityInput["money"]): LdcActivityInput {
  return directInput({
    allocation: money.mode === "fixed" ? "sequential" : "random",
    money,
  });
}

function direct(submissionId = crypto.randomUUID()): ClaimActivityInput {
  return { submissionId, participationMode: "direct" };
}

async function counts(id: string) {
  return env.DB.prepare(`SELECT claimed_count AS claimed,registered_count AS registered,
    (SELECT COUNT(*) FROM activity_passwords WHERE activity_id=activities.id) AS passwords,
    (SELECT COUNT(*) FROM claims WHERE activity_id=activities.id) AS claims,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=activities.id) AS registrations,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=activities.id) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=activities.id) AS attempts,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=activities.id) AS payments
    FROM activities WHERE id=?`)
    .bind(id)
    .first();
}

beforeEach(async () => {
  [owner, alice, bob] = await Promise.all([actor(), actor(), actor()]);
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `direct_${owner.id.replaceAll("-", "")}`,
    label: "本地模拟商户",
    secret: "LOCAL-ONLY",
  });
  merchantId = merchant.id;
  await env.DB.prepare(`UPDATE attempt_rate_limits SET home_interval_seconds=5,
    activity_interval_seconds=2 WHERE id='global'`).run();
});

describe("direct participation", () => {
  it("claims LDC through the protected endpoint and reads nullable sources", async () => {
    const activity = await save(directInput());
    const response = await request(
      `/api/activities/${activity.id}/claim`,
      alice,
      "POST",
      direct(),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as ClaimResult;
    expect(result).toMatchObject({
      result: "claimed",
      passwordMatched: null,
      claim: { activity: { participationMode: "direct" } },
    });
    expect("claim" in result && result.claim.sourcePassword).toBeUndefined();
    expect(await counts(activity.id)).toMatchObject({
      passwords: 0,
      claims: 1,
      claimed: 1,
      attempts: 0,
    });
    expect(await getActivityPasswords(bindings, activity.id, alice.id)).toEqual(
      {
        passwords: [],
        hiddenCount: 0,
        canSolve: false,
      },
    );
    const history = await request("/api/me/participations", alice);
    expect(await history.json()).toMatchObject({
      items: [
        { kind: "claim", claim: { activity: { participationMode: "direct" } } },
      ],
    });
  });

  it("does not participate when a guest or member only reads the activity", async () => {
    const activity = await save(directInput());
    expect((await request(`/api/activities/${activity.id}`)).status).toBe(200);
    expect(
      (await request(`/api/activities/${activity.id}`, alice)).status,
    ).toBe(200);
    expect(
      (await request(`/api/activities/${activity.id}/participation`, alice))
        .status,
    ).toBe(200);
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
    expect(
      (
        await request(
          `/api/activities/${activity.id}/claim`,
          undefined,
          "POST",
          direct(),
        )
      ).status,
    ).toBe(401);
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
  });

  it("rejects mode mismatch and malformed direct payloads before charging cooldown", async () => {
    const passwordActivity = await save(
      directInput({
        participationMode: "password",
        passwords: ["Secret123"],
      }),
    );
    const activity = await save(directInput());
    for (const [id, body] of [
      [passwordActivity.id, direct()],
      [
        activity.id,
        { submissionId: crypto.randomUUID(), password: "Secret123" },
      ],
      [activity.id, { ...direct(), password: "Secret123" }],
      [activity.id, { ...direct(), discoveryId: crypto.randomUUID() }],
    ] as const) {
      const response = await request(
        `/api/activities/${id}/claim`,
        alice,
        "POST",
        body,
      );
      expect([400, 409]).toContain(response.status);
    }
    expect((await readAttemptCooldown(bindings, alice.id)).revision).toBe(0);
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
  });

  it("recovers a durable direct claim without a second charge or reward", async () => {
    const activity = await save(directInput());
    const input = direct();
    const pending = await prepareClaimSubmission(
      bindings,
      activity.id,
      alice.id,
      input,
    );
    expect(pending).toMatchObject({
      participationMode: "direct",
      outcome: "pending",
      matchedPasswordId: null,
    });
    const cooldown = await readAttemptCooldown(bindings, alice.id);
    const first = await completeClaimSubmission(bindings, pending);
    expect(await claimActivity(bindings, activity.id, alice.id, input)).toEqual(
      first,
    );
    expect(await completeClaimSubmission(bindings, pending)).toEqual(first);
    expect(await readAttemptCooldown(bindings, alice.id)).toMatchObject({
      revision: cooldown.revision,
      nextAllowedAt: cooldown.nextAllowedAt,
    });
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      submissions: 1,
    });
    await expect(
      claimActivity(bindings, activity.id, alice.id, {
        submissionId: input.submissionId,
        password: "different-password",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("shares the activity interval across concurrent direct activities", async () => {
    const first = await save(directInput());
    const second = await save(directInput());
    const results = await Promise.allSettled([
      claimActivity(bindings, first.id, alice.id, direct()),
      claimActivity(bindings, second.id, alice.id, direct()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { status: 429 },
    });
    const cooldown = await readAttemptCooldown(bindings, alice.id);
    expect(cooldown.revision).toBe(1);
    expect(cooldown.nextAllowedAt - cooldown.serverTime).toBeGreaterThan(0);
    expect(cooldown.nextAllowedAt - cooldown.serverTime).toBeLessThanOrEqual(
      2000,
    );
    const rejectedId = results[0]?.status === "rejected" ? first.id : second.id;
    await expect(
      claimActivity(bindings, rejectedId, alice.id, direct()),
    ).rejects.toMatchObject({ status: 429 });
    expect(await readAttemptCooldown(bindings, alice.id)).toMatchObject({
      revision: 1,
      nextAllowedAt: cooldown.nextAllowedAt,
    });
  });

  it("honors a home cooldown and never treats direct participation as discovery continuation", async () => {
    const activity = await save(directInput({ joinSquare: true }));
    const discovery = await discoverGlobalRedemption(bindings, alice.id, {
      submissionId: crypto.randomUUID(),
      password: `NoMatch${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
    });
    expect(discovery.result).toBe("none");
    const cooldown = await readAttemptCooldown(bindings, alice.id);
    expect(cooldown.nextAllowedAt - cooldown.serverTime).toBeGreaterThan(4000);
    await expect(
      claimActivity(bindings, activity.id, alice.id, direct()),
    ).rejects.toMatchObject({ status: 429 });
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });
  });

  it("rolls back cooldown and submission when direct allocation admission fails", async () => {
    const activity = await save(directInput());
    await env.DB.prepare(`CREATE TRIGGER fixture_direct_submission_failure
      BEFORE INSERT ON redemption_submissions WHEN NEW.activity_id='${activity.id}'
      BEGIN SELECT RAISE(ABORT,'fixture direct admission failure'); END`).run();
    try {
      await expect(
        prepareClaimSubmission(bindings, activity.id, alice.id, direct()),
      ).rejects.toThrow();
      expect((await readAttemptCooldown(bindings, alice.id)).revision).toBe(0);
      expect(await counts(activity.id)).toMatchObject({
        claims: 0,
        submissions: 0,
      });
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER fixture_direct_submission_failure",
      ).run();
    }
  });

  it("keeps the last reward unique under different-account concurrency", async () => {
    const activity = await save(
      directInput({ money: { mode: "fixed", totalAmount: "0.01", count: 1 } }),
    );
    const results = await Promise.all([
      claimActivity(bindings, activity.id, alice.id, direct()),
      claimActivity(bindings, activity.id, bob.id, direct()),
    ]);
    expect(
      results.filter((result) => result.result === "claimed"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.result === "ended")).toHaveLength(
      1,
    );
    expect(await counts(activity.id)).toMatchObject({ claims: 1, claimed: 1 });
  });

  it("switches drafts both ways while rejecting old edits and locking open activity modes", async () => {
    const draft = await save(
      directInput({ participationMode: "password", passwords: ["Secret123"] }),
      false,
    );
    const changed = await updateActivity(bindings, draft.id, owner.id, {
      version: draft.version,
      activity: {
        ...draft.config,
        participationMode: "direct",
        passwords: [],
        forceDedicated: false,
      },
    });
    expect(changed.config.participationMode).toBe("direct");
    const { participationMode: _mode, ...legacy } = changed.config;
    await expect(
      updateActivity(bindings, changed.id, owner.id, {
        version: changed.version,
        activity: { ...legacy, passwords: ["Secret123"] },
      }),
    ).rejects.toMatchObject({ code: "PARTICIPATION_MODE_REQUIRED" });
    const password = await updateActivity(bindings, changed.id, owner.id, {
      version: changed.version,
      activity: {
        ...changed.config,
        participationMode: "password",
        passwords: ["Secret123"],
      },
    });
    const opened = await openActivity(
      bindings,
      password.id,
      owner.id,
      password.version,
    );
    await expect(
      updateActivity(bindings, opened.id, owner.id, {
        version: opened.version,
        activity: {
          ...opened.config,
          participationMode: "direct",
          passwords: [],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
    const activeDirect = await save(directInput());
    await expect(
      updateActivity(bindings, activeDirect.id, owner.id, {
        version: activeDirect.version,
        activity: {
          ...activeDirect.config,
          participationMode: "password",
          passwords: ["Secret123"],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
  });

  it("preserves old create and claim fingerprints and original draft outcome after switching mode", async () => {
    const activity = activityInputSchema.parse(
      directInput({ participationMode: undefined, passwords: ["Secret123"] }),
    );
    const requestId = crypto.randomUUID();
    const draft = await createActivity(bindings, owner.id, {
      requestId,
      activity,
    });
    const creation = await env.DB.prepare(
      "SELECT creation_digest FROM activities WHERE id=?",
    )
      .bind(draft.id)
      .first("creation_digest");
    expect(creation).toBe(
      await digestPassword(
        `activity-create:${JSON.stringify(activity)}`,
        bindings.PASSWORD_DIGEST_KEY,
      ),
    );
    const input = { submissionId: crypto.randomUUID(), password: "Secret123" };
    // Persist a pre-existing LDC terminal submission to verify its old digest and replay.
    // New author submissions are rejected by the current self-claim rule.
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,created_at,finished_at)
      VALUES (?,?,?,?,?,'claim','password','draft',?,?)`)
      .bind(
        crypto.randomUUID(),
        draft.id,
        owner.id,
        input.submissionId,
        await digestPassword(
          `claim-request:${draft.id}:${input.password}`,
          bindings.PASSWORD_DIGEST_KEY,
        ),
        Date.now(),
        Date.now(),
      )
      .run();
    expect(
      (await claimActivity(bindings, draft.id, owner.id, input)).result,
    ).toBe("draft");
    const changed = await updateActivity(bindings, draft.id, owner.id, {
      version: draft.version,
      activity: { ...draft.config, participationMode: "direct", passwords: [] },
    });
    expect(
      (await claimActivity(bindings, draft.id, owner.id, input)).result,
    ).toBe("draft");
    expect(
      (await createActivity(bindings, owner.id, { requestId, activity })).id,
    ).toBe(changed.id);
    const original = await findSubmission(
      bindings,
      owner.id,
      input.submissionId,
    );
    expect(original?.fingerprint).toBe(
      await digestPassword(
        `claim-request:${draft.id}:${input.password}`,
        bindings.PASSWORD_DIGEST_KEY,
      ),
    );
  });

  it("clears over-limit historical draft passwords when switching to direct without allowing new over-limit sets", async () => {
    const passwords = Array.from(
      { length: 6 },
      (_, index) => `LegacyPass${index}`,
    );
    const draft = await save(
      directInput({
        participationMode: "password",
        passwords: passwords.slice(0, 5),
      }),
      false,
    );
    const oldRows = await privateRows(bindings, draft.id);
    const historicalRows = await preparePasswords(
      bindings,
      draft.id,
      passwords,
      oldRows.passwords,
      Date.now(),
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM activity_passwords WHERE activity_id=?").bind(
        draft.id,
      ),
      insertPasswordRows(env.DB, historicalRows),
    ]);
    const historical = await getManagedActivity(bindings, draft.id, owner.id);
    expect(historical.config.passwords).toEqual(passwords);
    const changed = await updateActivity(bindings, draft.id, owner.id, {
      version: historical.version,
      activity: {
        ...historical.config,
        participationMode: "direct",
        passwords: [],
        forceDedicated: false,
      },
    });
    expect(changed.config).toMatchObject({
      participationMode: "direct",
      passwords: [],
    });
    expect(changed.config.money).toEqual(historical.config.money);
    expect(await counts(draft.id)).toMatchObject({
      passwords: 0,
      submissions: 0,
    });
    await expect(
      updateActivity(bindings, draft.id, owner.id, {
        version: changed.version,
        activity: {
          ...changed.config,
          participationMode: "password",
          passwords,
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
    expect(
      (await getManagedActivity(bindings, draft.id, owner.id)).version,
    ).toBe(changed.version);
    const restored = await updateActivity(bindings, draft.id, owner.id, {
      version: changed.version,
      activity: {
        ...changed.config,
        participationMode: "password",
        passwords: passwords.slice(0, 1),
      },
    });
    expect(restored.config.passwords).toEqual(passwords.slice(0, 1));
  });

  it("does not offer password solving or statistics for direct activities", async () => {
    const activity = await save(directInput());
    await claimActivity(bindings, activity.id, alice.id, direct());
    const cooldown = await readAttemptCooldown(bindings, alice.id);
    await expect(
      solveActivityPassword(bindings, activity.id, alice.id, {
        submissionId: crypto.randomUUID(),
        password: "Secret123",
      }),
    ).rejects.toMatchObject({ code: "PARTICIPATION_MODE_MISMATCH" });
    await expect(
      getStatistics(bindings, activity.id, owner.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await readAttemptCooldown(bindings, alice.id)).toMatchObject({
      revision: cooldown.revision,
    });
    expect(
      (
        await request(
          `/api/activities/${activity.id}/password-solves`,
          alice,
          "POST",
          direct(),
        )
      ).status,
    ).toBe(400);
  });

  it.each(["fixed", "random", "custom"] as const)(
    "uses the existing %s LDC allocation and payment outbox",
    async (mode) => {
      const money: LdcActivityInput["money"] =
        mode === "fixed"
          ? { mode, totalAmount: "1.00", count: 2 }
          : mode === "random"
            ? {
                mode,
                totalAmount: "1.00",
                count: 2,
                algorithm: "double_mean_v1",
              }
            : { mode, amounts: ["0.40", "0.60"] };
      const activity = await save(ldcInput(money));
      const result = await claimActivity(
        bindings,
        activity.id,
        alice.id,
        direct(),
      );
      expect(result).toMatchObject({
        result: "claimed",
        passwordMatched: null,
        claim: { rewardType: "ldc" },
      });
      expect(await counts(activity.id)).toMatchObject({
        claims: 1,
        payments: 1,
        passwords: 0,
        attempts: 0,
      });
      const claim = await env.DB.prepare(
        "SELECT password_id FROM claims WHERE activity_id=?",
      )
        .bind(activity.id)
        .first();
      expect(claim?.password_id).toBeNull();
    },
  );

  it("preserves LDC eligibility and author restrictions without consuming cooldown", async () => {
    const activity = await save(
      ldcInput({ mode: "fixed", totalAmount: "1.00", count: 2 }),
    );
    const lite = await actor(false);
    await expect(
      claimActivity(bindings, activity.id, lite.id, direct()),
    ).rejects.toMatchObject({ code: "OFFICIAL_CONNECT_REQUIRED" });
    await expect(
      claimActivity(bindings, activity.id, owner.id, direct()),
    ).rejects.toMatchObject({ code: "SELF_CLAIM_FORBIDDEN" });
    expect((await readAttemptCooldown(bindings, lite.id)).revision).toBe(0);
    expect((await readAttemptCooldown(bindings, owner.id)).revision).toBe(0);
  });

  it("admits direct registration durably, closes a full draw and publishes nullable winners", async () => {
    const activity = await save(
      ldcInput({
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "1.00",
        count: 1,
        participantLimit: 2,
        countdownSeconds: 86400,
        distributeFullPool: true,
      }),
    );
    const first = direct();
    const result = await registerForDraw(
      bindings,
      activity.id,
      alice.id,
      first,
    );
    expect(result).toMatchObject({
      result: "registered",
      passwordMatched: null,
      registration: { activity: { participationMode: "direct" } },
    });
    expect(
      await findSubmission(bindings, alice.id, first.submissionId),
    ).toMatchObject({
      outcome: "registered",
      purpose: "register",
      participationMode: "direct",
      matchedPasswordId: null,
    });
    expect(
      await registerForDraw(bindings, activity.id, alice.id, first),
    ).toEqual(result);
    expect(
      (await registerForDraw(bindings, activity.id, alice.id, direct())).result,
    ).toBe("already_registered");
    await registerForDraw(bindings, activity.id, bob.id, direct());
    await refreshTimedDraw(bindings, activity.id);
    const aliceResult = await getCurrentParticipation(
      bindings,
      activity.id,
      alice.id,
    );
    const bobResult = await getCurrentParticipation(
      bindings,
      activity.id,
      bob.id,
    );
    expect(
      [aliceResult.registration?.status, bobResult.registration?.status].sort(),
    ).toEqual(["not_won", "won"]);
    expect(await counts(activity.id)).toMatchObject({
      registered: 2,
      registrations: 2,
      claims: 1,
      payments: 1,
      attempts: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT payload FROM activity_draw_plans WHERE activity_id=?",
      )
        .bind(activity.id)
        .first<string>("payload"),
    ).toContain('"passwordId":null');
  });

  it("requires admission for direct registrations and rolls back a failed finalization", async () => {
    const activity = await save(
      ldcInput({
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "1.00",
        count: 1,
        participantLimit: null,
        countdownSeconds: 86400,
        distributeFullPool: true,
      }),
    );
    await expect(
      env.DB.prepare(`INSERT INTO activity_registrations
      (id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at)
      VALUES (?,?,?,NULL,1,(SELECT 'simulation:'||external_id FROM users WHERE id=?),0)`)
        .bind(crypto.randomUUID(), activity.id, alice.id, alice.id)
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare(`CREATE TRIGGER fixture_direct_registration_failure
      BEFORE UPDATE ON redemption_submissions WHEN NEW.activity_id='${activity.id}' AND NEW.outcome='registered'
      BEGIN SELECT RAISE(ABORT,'fixture direct finalization failure'); END`).run();
    try {
      await expect(
        registerForDraw(bindings, activity.id, alice.id, direct()),
      ).rejects.toThrow();
      expect(await counts(activity.id)).toMatchObject({
        registrations: 0,
        registered: 0,
        submissions: 0,
      });
      expect((await readAttemptCooldown(bindings, alice.id)).revision).toBe(0);
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER fixture_direct_registration_failure",
      ).run();
    }
    await advanceAttemptCooldown(env.DB, alice.id);
    expect(
      (await registerForDraw(bindings, activity.id, alice.id, direct())).result,
    ).toBe("registered");
    expect(
      (await getPublicActivity(bindings, activity.id)).participationMode,
    ).toBe("direct");
  });

  it("rejects a direct draw plan with a missing password source without redrawing or publishing", async () => {
    const activity = await save(
      ldcInput({
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "1.00",
        count: 2,
        participantLimit: 2,
        countdownSeconds: 86400,
        distributeFullPool: true,
      }),
    );
    await registerForDraw(bindings, activity.id, alice.id, direct());
    await registerForDraw(bindings, activity.id, bob.id, direct());
    const saved = await saveDrawPlan(bindings, activity.id);
    if (!saved) throw new Error("Missing saved direct draw plan");
    const plan = JSON.parse(saved.payload) as DrawPlan;
    expect(plan.winners.every((winner) => winner.passwordId === null)).toBe(
      true,
    );
    const payload = JSON.stringify({
      ...plan,
      winners: plan.winners.map(
        ({ passwordId: _passwordId, ...winner }) => winner,
      ),
    });
    // Inject malformed persisted JSON while keeping every production admission
    // and immutable-update guard installed for the publication/recovery checks.
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM activity_draw_plans WHERE activity_id=?",
      ).bind(activity.id),
      env.DB.prepare(
        "INSERT INTO activity_draw_plans(activity_id,participant_count,payload,created_at) VALUES (?,?,?,?)",
      ).bind(activity.id, saved.participant_count, payload, saved.created_at),
    ]);
    for (const publish of [publishDrawPlan, refreshTimedDraw]) {
      await expect(publish(bindings, activity.id)).rejects.toThrow(
        "Invalid saved drawing password source",
      );
      expect(await saveDrawPlan(bindings, activity.id)).toEqual({
        ...saved,
        payload,
      });
      expect(await counts(activity.id)).toMatchObject({
        registered: 2,
        claims: 0,
        payments: 0,
      });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM reward_inventory WHERE activity_id=?",
        )
          .bind(activity.id)
          .first<number>("n"),
      ).toBe(0);
    }
  });
});
