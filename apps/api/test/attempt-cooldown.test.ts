import { env } from "cloudflare:test";
import type {
  AttemptCooldown,
  ClaimResult,
  GlobalRedemptionResult,
  LdcActivityInput,
  ManagedActivity,
  SolveResult,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { prepareClaimSubmission } from "../src/activities/claim-service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import { discoverGlobalRedemption } from "../src/discovery/service";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import {
  attemptWriteStatements,
  readAttemptCooldown,
} from "../src/runtime/attempt-cooldown";
import { digestPassword, sha256Hex } from "../src/security/crypto";
import { ldcInput } from "./activity-fixtures";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;
let merchantId: string;

async function actor(label: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: id,
    username: `${label}_${id}`,
    displayName: label,
    officialConnectVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(path: string, user = alice, body?: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: user.cookie,
        ...(body === undefined
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user.csrf,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

async function success<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}

async function create(activity?: Partial<LdcActivityInput>) {
  const config = ldcInput({
    merchantId,
    title: "账户冷却",
    forceDedicated: false,
    passwords: ["password123", "secret456"],
    money: { mode: "fixed", totalAmount: "4.00", count: 4 },
    ...activity,
  });
  const created = await success<{ activity: ManagedActivity }>(
    await request("/api/activities", owner, {
      requestId: crypto.randomUUID(),
      activity: config,
    }),
  );
  const opened = await success<{ activity: ManagedActivity }>(
    await request(`/api/me/activities/${created.activity.id}/open`, owner, {
      version: created.activity.version,
    }),
  );
  return opened.activity;
}

async function ldc(mode: "fixed" | "timed_draw") {
  return create({
    title: "LDC账户冷却",
    forceDedicated: false,
    passwords: ["password123", "secret456"],
    merchantId,
    allocation: "random",
    money:
      mode === "fixed"
        ? { mode, totalAmount: "1.00", count: 2 }
        : {
            mode,
            algorithm: "double_mean_v1",
            totalAmount: "1.00",
            count: 2,
            participantLimit: null,
            countdownSeconds: 600,
            distributeFullPool: true,
          },
  });
}

function claim(
  activityId: string,
  password = "password123",
  submissionId: string = crypto.randomUUID(),
  discoveryId?: string,
  user = alice,
) {
  return request(`/api/activities/${activityId}/claim`, user, {
    submissionId,
    password,
    ...(discoveryId ? { discoveryId } : {}),
  });
}

function discover(
  password = "password123",
  submissionId: string = crypto.randomUUID(),
  user = alice,
) {
  return request("/api/redemptions/discover", user, { submissionId, password });
}

async function expire(user = alice) {
  await env.DB.prepare(
    "UPDATE account_attempt_cooldowns SET next_allowed_at=0 WHERE user_id=?",
  )
    .bind(user.id)
    .run();
}

async function state(user = alice) {
  return env.DB.prepare(
    "SELECT revision,origin,attempt_id,accepted_at,next_allowed_at FROM account_attempt_cooldowns WHERE user_id=?",
  )
    .bind(user.id)
    .first<{
      revision: number;
      origin: string;
      attempt_id: string;
      accepted_at: number;
      next_allowed_at: number;
    }>();
}

async function savedDiscovery(id: string) {
  return env.DB.prepare(
    "SELECT selected_activity_id,claim_submission_id FROM global_redemptions WHERE id=?",
  )
    .bind(id)
    .first<{
      selected_activity_id: string | null;
      claim_submission_id: string;
    }>();
}

beforeEach(async () => {
  await env.DB.prepare("UPDATE activities SET force_dedicated=1").run();
  await env.DB.prepare(
    "UPDATE attempt_rate_limits SET home_interval_seconds=5,activity_interval_seconds=2 WHERE id='global'",
  ).run();
  [owner, alice, bob] = await Promise.all([
    actor("owner"),
    actor("alice"),
    actor("bob"),
  ]);
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: `attempt_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "本地模拟",
      secret: "fake-only-secret",
    })
  ).id;
});

describe("atomic account password cooldown", () => {
  it("starts five seconds for a home miss, preserves original replays, and does not count rejection", async () => {
    const id = crypto.randomUUID();
    const first = await success<GlobalRedemptionResult>(
      await discover("nomatch123", id),
    );
    expect(first.result).toBe("none");
    expect(first.claimSubmissionId).toMatch(/^[a-f0-9-]{36}$/);
    const initial = await state();
    expect(initial).toMatchObject({
      revision: 1,
      origin: "home",
      attempt_id: first.id,
    });
    expect((initial?.next_allowed_at ?? 0) - (initial?.accepted_at ?? 0)).toBe(
      5000,
    );
    const replay = await success<GlobalRedemptionResult>(
      await discover("nomatch123", id),
    );
    expect(replay.id).toBe(first.id);
    expect(await state()).toEqual(initial);
    const rejectedId = crypto.randomUUID();
    const rejected = await discover("nomatch456", rejectedId);
    expect(rejected.status).toBe(429);
    const error = (await rejected.json()) as {
      error: { code: string };
      attemptCooldown: AttemptCooldown;
    };
    expect(error.error.code).toBe("GLOBAL_REDEMPTION_RATE_LIMITED");
    expect(error.attemptCooldown).toMatchObject({
      revision: 1,
      nextAllowedAt: initial?.next_allowed_at,
    });
    expect(Number(rejected.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await state()).toEqual(initial);
    expect(
      await env.DB.prepare(
        "SELECT id FROM global_redemptions WHERE user_id=? AND submission_id=?",
      )
        .bind(alice.id, rejectedId)
        .first(),
    ).toBeNull();
    const changed = await discover("nomatch456", id);
    expect(changed.status).toBe(409);
    await expire();
    const acceptedRetry = await success<GlobalRedemptionResult>(
      await discover("nomatch456", rejectedId),
    );
    expect(acceptedRetry.result).toBe("none");
    const retriedState = await state();
    expect(retriedState).toMatchObject({ revision: 2, origin: "home" });
    await success<GlobalRedemptionResult>(
      await discover("nomatch456", rejectedId),
    );
    expect(await state()).toEqual(retriedState);
  });

  it("shares two-second detail cooldown across activities and home and keeps other accounts independent", async () => {
    const first = await create();
    const second = await create();
    const accepted = await success<ClaimResult>(
      await claim(first.id, "wrong123"),
    );
    expect(accepted.result).toBe("incorrect");
    const initial = await state();
    expect(initial).toMatchObject({ revision: 1, origin: "activity" });
    expect((initial?.next_allowed_at ?? 0) - (initial?.accepted_at ?? 0)).toBe(
      2000,
    );
    expect((await claim(second.id, "wrong456")).status).toBe(429);
    expect((await discover("nomatch123")).status).toBe(429);
    expect(await state()).toEqual(initial);
    expect(
      (await claim(second.id, "wrong456", crypto.randomUUID(), undefined, bob))
        .status,
    ).toBe(200);
    await expire();
    await success<GlobalRedemptionResult>(await discover("nomatch123"));
    const home = await state();
    expect(home).toMatchObject({ revision: 2, origin: "home" });
    expect((home?.next_allowed_at ?? 0) - (home?.accepted_at ?? 0)).toBe(5000);
    expect((await claim(second.id, "wrong789")).status).toBe(429);
  });

  it("has no hidden ten-attempt cap after each cooldown has elapsed", async () => {
    const activity = await create();
    for (let index = 0; index < 12; index++) {
      await expire();
      expect((await claim(activity.id, "wrong123")).status).toBe(200);
    }
    expect(await state()).toMatchObject({ revision: 12 });
  });

  it("atomically accepts only one concurrent new attempt across activity objects", async () => {
    const first = await create();
    const second = await create();
    const requests = await Promise.all([
      claim(first.id, "wrong123"),
      claim(second.id, "wrong456"),
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
    expect(await state()).toMatchObject({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM redemption_submissions WHERE user_id=?",
      )
        .bind(alice.id)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("atomically arbitrates home and detail without a shared DO hop", async () => {
    const activity = await create();
    const results = await Promise.allSettled([
      discoverGlobalRedemption(bindings, alice.id, {
        submissionId: crypto.randomUUID(),
        password: "nomatch123",
      }),
      prepareClaimSubmission(bindings, activity.id, alice.id, {
        submissionId: crypto.randomUUID(),
        password: "wrong123",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({
      status: "rejected",
      reason: { status: 429 },
    });
    expect(await state()).toMatchObject({ revision: 1 });
  });

  it("keeps explicit home-to-text automatic submission in the same five-second attempt", async () => {
    const activity = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    const initial = await state();
    const result = await success<ClaimResult>(
      await claim(
        activity.id,
        "password123",
        found.claimSubmissionId,
        found.id,
      ),
    );
    expect(result.result).toBe("claimed");
    expect(result.attemptCooldown).toMatchObject({
      revision: 1,
      nextAllowedAt: initial?.next_allowed_at,
    });
    expect(await state()).toEqual(initial);
    expect(await savedDiscovery(found.id)).toEqual({
      selected_activity_id: activity.id,
      claim_submission_id: found.claimSubmissionId,
    });
    expect((await discover("nomatch123")).status).toBe(429);
    await success<ClaimResult>(
      await claim(
        activity.id,
        "password123",
        found.claimSubmissionId,
        found.id,
      ),
    );
    expect(await state()).toEqual(initial);
    expect(
      (await claim(activity.id, "password123", crypto.randomUUID(), found.id))
        .status,
    ).toBe(409);
  });

  it.each(["text", "timed_draw"] as const)(
    "binds a %s continuation that ends before automatic submission without advancing cooldown",
    async (mode) => {
      const activity = mode === "text" ? await create() : await ldc(mode);
      const found = await success<GlobalRedemptionResult>(await discover());
      const initial = await state();
      await env.DB.prepare(
        "UPDATE activities SET ended_at=?,end_reason='manual' WHERE id=?",
      )
        .bind(Date.now(), activity.id)
        .run();
      const result = await success<ClaimResult>(
        await claim(
          activity.id,
          "password123",
          found.claimSubmissionId,
          found.id,
        ),
      );
      expect(result.result).toBe("ended");
      expect(await state()).toEqual(initial);
      expect(await savedDiscovery(found.id)).toEqual({
        selected_activity_id: activity.id,
        claim_submission_id: found.claimSubmissionId,
      });
      expect(
        (await claim(activity.id, "password123", crypto.randomUUID(), found.id))
          .status,
      ).toBe(409);
      const refreshed = await success<GlobalRedemptionResult>(
        await request(`/api/redemptions/${found.id}`),
      );
      expect(refreshed.claimResult).toMatchObject({ result: "ended" });
      expect(
        await env.DB.prepare(
          "SELECT validated_at FROM redemption_submissions WHERE user_id=? AND submission_id=?",
        )
          .bind(alice.id, found.claimSubmissionId)
          .first(),
      ).toEqual({ validated_at: null });
    },
  );

  it("finishes a saved bound child after interruption without changing a newer account attempt", async () => {
    const activity = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    const pending = await prepareClaimSubmission(
      bindings,
      activity.id,
      alice.id,
      {
        submissionId: found.claimSubmissionId,
        password: "password123",
        discoveryId: found.id,
      },
    );
    expect(pending.outcome).toBe("pending");
    await expire();
    await success<GlobalRedemptionResult>(await discover("nomatch123"));
    const latest = await state();
    const retried = await success<ClaimResult>(
      await claim(
        activity.id,
        "password123",
        found.claimSubmissionId,
        found.id,
      ),
    );
    expect(retried.result).toBe("claimed");
    expect(await state()).toEqual(latest);
    expect(latest).toMatchObject({ revision: 2, origin: "home" });
  });

  it("binds only one explicit terminal choice across claim and registration objects", async () => {
    const text = await create();
    const draw = await ldc("timed_draw");
    const found = await success<GlobalRedemptionResult>(await discover());
    expect(found.result).toBe("multiple");
    const initial = await state();
    await env.DB.prepare(
      "UPDATE activities SET ended_at=?,end_reason='manual' WHERE id IN (?,?)",
    )
      .bind(Date.now(), text.id, draw.id)
      .run();
    const responses = await Promise.all([
      claim(text.id, "password123", crypto.randomUUID(), found.id),
      claim(draw.id, "password123", crypto.randomUUID(), found.id),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const bound = await savedDiscovery(found.id);
    expect([text.id, draw.id]).toContain(bound?.selected_activity_id);
    expect(await state()).toEqual(initial);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM redemption_submissions WHERE user_id=?",
      )
        .bind(alice.id)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("returns an independent legacy terminal result without changing an already bound home attempt", async () => {
    const selected = await create();
    const ended = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    await success<ClaimResult>(
      await claim(
        selected.id,
        "password123",
        found.claimSubmissionId,
        found.id,
      ),
    );
    const initial = await state();
    const binding = await savedDiscovery(found.id);
    await env.DB.prepare(
      "UPDATE activities SET ended_at=?,end_reason='manual' WHERE id=?",
    )
      .bind(Date.now(), ended.id)
      .run();
    const terminalId = crypto.randomUUID();
    const terminal = await success<ClaimResult>(
      await claim(ended.id, "password123", terminalId),
    );
    expect(terminal.result).toBe("ended");
    expect(await state()).toEqual(initial);
    expect(await savedDiscovery(found.id)).toEqual(binding);
    expect(
      await env.DB.prepare(
        "SELECT outcome,validated_at,matched_password_id,claim_id FROM redemption_submissions WHERE user_id=? AND submission_id=?",
      )
        .bind(alice.id, terminalId)
        .first(),
    ).toEqual({
      outcome: "ended",
      validated_at: null,
      matched_password_id: null,
      claim_id: null,
    });
    // Even a later legacy state change cannot turn the saved terminal UUID into a validation.
    await env.DB.prepare(
      "UPDATE activities SET ended_at=NULL,end_reason=NULL WHERE id=?",
    )
      .bind(ended.id)
      .run();
    const replay = await success<ClaimResult>(
      await claim(ended.id, "password123", terminalId),
    );
    expect(replay.result).toBe("ended");
    expect(await state()).toEqual(initial);
    expect(await savedDiscovery(found.id)).toEqual(binding);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM redemption_submissions WHERE user_id=? AND validated_at IS NOT NULL",
      )
        .bind(alice.id)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM claims WHERE user_id=?",
      )
        .bind(alice.id)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("binds an old Web random child ID once and exposes the completed result through refresh", async () => {
    const activity = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    const initial = await state();
    const oldChild = crypto.randomUUID();
    expect((await claim(activity.id, "password123", oldChild)).status).toBe(
      200,
    );
    expect(await state()).toEqual(initial);
    expect(await savedDiscovery(found.id)).toEqual({
      selected_activity_id: activity.id,
      claim_submission_id: oldChild,
    });
    const refreshed = await success<GlobalRedemptionResult>(
      await request(`/api/redemptions/${found.id}`),
    );
    expect(refreshed).toMatchObject({
      id: found.id,
      claimSubmissionId: oldChild,
      claimResult: { result: "claimed" },
    });
  });

  it("allows only one multi-match continuation and rejects a changed explicit target", async () => {
    const first = await create();
    const second = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    expect(found.result).toBe("multiple");
    const initial = await state();
    const requests = await Promise.all([
      claim(first.id, "password123", crypto.randomUUID()),
      claim(second.id, "password123", crypto.randomUUID()),
    ]);
    expect(requests.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
    const bound = await savedDiscovery(found.id);
    const other = bound?.selected_activity_id === first.id ? second : first;
    expect(
      (await claim(other.id, "password123", found.claimSubmissionId, found.id))
        .status,
    ).toBe(409);
    expect(await state()).toEqual(initial);
  });

  it("freezes user, password, and candidates and never trusts a claimed source", async () => {
    const candidate = await create();
    const other = await create({
      title: "不匹配",
      forceDedicated: false,
      passwords: ["different123"],
      money: { mode: "fixed", totalAmount: "1.00", count: 1 },
    });
    const found = await success<GlobalRedemptionResult>(await discover());
    const initial = await state();
    expect(
      (await claim(candidate.id, "wrong123", found.claimSubmissionId, found.id))
        .status,
    ).toBe(409);
    expect(
      (await claim(other.id, "password123", found.claimSubmissionId, found.id))
        .status,
    ).toBe(409);
    expect(
      (
        await claim(
          candidate.id,
          "password123",
          found.claimSubmissionId,
          found.id,
          bob,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/activities/${candidate.id}/claim`, alice, {
          submissionId: crypto.randomUUID(),
          password: "wrong123",
          origin: "home",
        })
      ).status,
    ).toBe(400);
    expect(await state()).toEqual(initial);
    expect(await state(bob)).toBeNull();
    expect((await savedDiscovery(found.id))?.selected_activity_id).toBeNull();
  });

  it("invalidates an unbound discovery only on the next accepted attempt, with no wall-clock TTL", async () => {
    const activity = await create();
    const original = await success<GlobalRedemptionResult>(await discover());
    expect((await discover("nomatch123")).status).toBe(429);
    await expire();
    // A long pause alone does not invalidate the latest home operation.
    await env.DB.prepare(
      "UPDATE global_redemptions SET created_at=created_at-86400000 WHERE id=?",
    )
      .bind(original.id)
      .run();
    expect(
      (
        await claim(
          activity.id,
          "password123",
          original.claimSubmissionId,
          original.id,
        )
      ).status,
    ).toBe(200);
    expect(await state()).toMatchObject({ revision: 1, origin: "home" });

    const second = await create();
    const pending = await success<GlobalRedemptionResult>(
      await discover("secret456"),
    );
    await expire();
    await success<GlobalRedemptionResult>(await discover("nomatch123"));
    expect(
      (
        await claim(
          second.id,
          "secret456",
          pending.claimSubmissionId,
          pending.id,
        )
      ).status,
    ).toBe(429);
    await expire();
    expect(
      (
        await claim(
          second.id,
          "secret456",
          pending.claimSubmissionId,
          pending.id,
        )
      ).status,
    ).toBe(200);
    expect(await state()).toMatchObject({ revision: 4, origin: "activity" });
    expect((await savedDiscovery(pending.id))?.selected_activity_id).toBeNull();
  });

  it("keeps solve in the account cooldown and disallows a home continuation for it", async () => {
    const activity = await create();
    expect((await claim(activity.id)).status).toBe(200);
    const solveId = crypto.randomUUID();
    expect(
      (
        await request(`/api/activities/${activity.id}/password-solves`, alice, {
          submissionId: solveId,
          password: "secret456",
        })
      ).status,
    ).toBe(429);
    await expire();
    const found = await success<GlobalRedemptionResult>(
      await discover("secret456"),
    );
    expect(
      (
        await request(`/api/activities/${activity.id}/password-solves`, alice, {
          submissionId: solveId,
          password: "secret456",
          discoveryId: found.id,
        })
      ).status,
    ).toBe(429);
    await expire();
    const solved = await success<SolveResult>(
      await request(`/api/activities/${activity.id}/password-solves`, alice, {
        submissionId: solveId,
        password: "secret456",
      }),
    );
    expect(solved.outcome).toBe("solved");
    const initial = await state();
    expect(initial).toMatchObject({ revision: 3, origin: "activity" });
    expect(
      (
        await request(`/api/activities/${activity.id}/password-solves`, alice, {
          submissionId: solveId,
          password: "secret456",
        })
      ).status,
    ).toBe(200);
    expect(await state()).toEqual(initial);
    expect((await savedDiscovery(found.id))?.selected_activity_id).toBeNull();
  });

  it.each(["fixed", "timed_draw"] as const)(
    "continues home discovery into %s LDC without a second cooldown",
    async (mode) => {
      const activity = await ldc(mode);
      const found = await success<GlobalRedemptionResult>(await discover());
      const initial = await state();
      const result = await success<ClaimResult>(
        await claim(
          activity.id,
          "password123",
          found.claimSubmissionId,
          found.id,
        ),
      );
      expect(result.result).toBe(mode === "fixed" ? "claimed" : "registered");
      expect(await state()).toEqual(initial);
      expect(
        (await claim(activity.id, "password123", crypto.randomUUID(), found.id))
          .status,
      ).toBe(409);
      expect(
        (
          await claim(
            activity.id,
            "wrong123",
            crypto.randomUUID(),
            undefined,
            bob,
          )
        ).status,
      ).toBe(200);
      expect(await state(bob)).toMatchObject({
        origin: "activity",
        revision: 1,
      });
      expect(
        (await discover("nomatch123", crypto.randomUUID(), bob)).status,
      ).toBe(429);
    },
  );

  it("preserves the legacy automatic redemption endpoint and its stable child retry", async () => {
    const activity = await create();
    const id = crypto.randomUUID();
    const first = await success<GlobalRedemptionResult>(
      await request("/api/redemptions", alice, {
        submissionId: id,
        password: "password123",
      }),
    );
    expect(first).toMatchObject({
      selectedActivityId: activity.id,
      claimResult: { result: "claimed" },
    });
    const initial = await state();
    const replay = await success<GlobalRedemptionResult>(
      await request("/api/redemptions", alice, {
        submissionId: id,
        password: "password123",
      }),
    );
    expect(replay.claimSubmissionId).toBe(first.claimSubmissionId);
    expect(await state()).toEqual(initial);
    expect(initial).toMatchObject({ revision: 1, origin: "home" });
  });

  it("keeps existing waits fixed while new attempts use the changed setting", async () => {
    await success<GlobalRedemptionResult>(await discover("nomatch123"));
    const initial = await state();
    await env.DB.prepare(
      "UPDATE attempt_rate_limits SET home_interval_seconds=9,activity_interval_seconds=7 WHERE id='global'",
    ).run();
    expect(await state()).toEqual(initial);
    expect((await discover("nomatch456")).status).toBe(429);
    await expire();
    const activity = await create();
    expect((await claim(activity.id, "wrong123")).status).toBe(200);
    const changed = await state();
    expect((changed?.next_allowed_at ?? 0) - (changed?.accepted_at ?? 0)).toBe(
      7000,
    );
  });

  it("rolls back continuation binding and account state if submission persistence fails", async () => {
    const activity = await create();
    const found = await success<GlobalRedemptionResult>(await discover());
    const initial = await state();
    await expect(
      env.DB.batch([
        ...attemptWriteStatements(
          bindings,
          alice.id,
          "activity",
          crypto.randomUUID(),
          {
            activityId: activity.id,
            submissionId: found.claimSubmissionId,
            passwordDigest: await digestPassword(
              "password123",
              bindings.PASSWORD_DIGEST_KEY,
            ),
            discoveryId: found.id,
          },
        ),
        env.DB.prepare(
          "INSERT INTO redemption_submissions (id) VALUES (?)",
        ).bind(crypto.randomUUID()),
      ]),
    ).rejects.toThrow();
    expect(await state()).toEqual(initial);
    expect((await savedDiscovery(found.id))?.selected_activity_id).toBeNull();
    expect(await readAttemptCooldown(bindings, alice.id)).toMatchObject({
      revision: 1,
      nextAllowedAt: initial?.next_allowed_at,
    });
  });
});
