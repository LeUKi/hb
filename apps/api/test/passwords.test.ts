import { env, evictDurableObject } from "cloudflare:test";
import {
  type ActivityInput,
  type ActivityPasswords,
  type ActivityStatistics,
  ARCHIVE_DELAY_MS,
  type ClaimDetail,
  type ClaimResult,
  emptyActivityInput,
  type ManagedActivity,
  type SolveResult,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptAssociatedData,
  completeClaimSubmission,
  findSubmission,
  prepareClaimSubmission,
  resumePendingActivityClaims,
} from "../src/activities/claim-service";
import { solveActivityPassword } from "../src/activities/password-service";
import {
  insertPasswordRows,
  preparePasswords,
} from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import {
  decryptString,
  digestPassword,
  sha256Hex,
} from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
const validPasswords = [
  "claim123",
  "secret456",
  "other789",
  "lastword1",
  "hidden999",
];
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;
let merchantId: string;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing fixture value");
  return value;
}

async function actor(username: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    officialConnectVerified: true,
    id,
    externalId: username,
    username,
    displayName: `${username} 昵称`,
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

function request(
  path: string,
  user?: Actor,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
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
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

function ldcConfig(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    ...emptyActivityInput(),
    title: "口令验证测试",
    passwords: validPasswords,
    rewardType: "ldc",
    merchantId,
    money: { mode: "fixed", totalAmount: "4.00", count: 4 },
    afterClaimInfo: "PRIVATE-AFTER-CLAIM",
    ...overrides,
  };
}

async function create(activity: ActivityInput = ldcConfig(), open = true) {
  const input = activity;
  const response = await request("/api/activities", owner, "POST", {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  expect(response.status).toBe(200);
  const saved = ((await response.json()) as { activity: ManagedActivity })
    .activity;
  if (!open) return saved;
  const opened = await request(
    `/api/me/activities/${saved.id}/open`,
    owner,
    "POST",
    { version: saved.version },
  );
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { activity: ManagedActivity }).activity;
}

function submitClaim(
  id: string,
  user = alice,
  password = "claim123",
  submissionId = crypto.randomUUID(),
) {
  return request(`/api/activities/${id}/claim`, user, "POST", {
    password,
    submissionId,
  });
}

async function claim(
  id: string,
  user = alice,
  password = "claim123",
  submissionId = crypto.randomUUID(),
) {
  await advanceAttemptCooldown(env.DB, user.id, submissionId);
  const response = await submitClaim(id, user, password, submissionId);
  expect(response.status).toBe(200);
  const result = (await response.json()) as ClaimResult;
  if (result.result !== "claimed") throw new Error("Expected a new reward");
  return result;
}

function submitSolve(
  id: string,
  user = alice,
  password = "secret456",
  submissionId = crypto.randomUUID(),
) {
  return request(`/api/activities/${id}/password-solves`, user, "POST", {
    password,
    submissionId,
  });
}

async function solve(
  id: string,
  user = alice,
  password = "secret456",
  submissionId = crypto.randomUUID(),
) {
  await advanceAttemptCooldown(env.DB, user.id, submissionId);
  const response = await submitSolve(id, user, password, submissionId);
  expect(response.status).toBe(200);
  const result = (await response.json()) as SolveResult;
  delete result.attemptCooldown;
  return result;
}

async function passwords(id: string, user?: Actor) {
  const response = await request(`/api/activities/${id}/passwords`, user);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as ActivityPasswords;
}

async function counts(id: string) {
  return required(
    await env.DB.prepare(`SELECT claimed_count AS assigned, version,
      (SELECT COUNT(*) FROM claims WHERE activity_id=a.id) AS claims,
      (SELECT COUNT(*) FROM attempt_events WHERE activity_id=a.id) AS attempts,
      (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=a.id AND validated_at IS NOT NULL) AS validations,
      (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS payments,
      (SELECT COUNT(*) FROM payment_outbox o JOIN payment_tasks p ON p.id=o.task_id JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=a.id) AS outbox
      FROM activities a WHERE a.id=?`)
      .bind(id)
      .first(),
  );
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  await env.DB.prepare(
    "INSERT INTO attempt_rate_limits (id,version,home_interval_seconds,activity_interval_seconds,updated_at) VALUES ('global',1,5,2,0) ON CONFLICT(id) DO UPDATE SET home_interval_seconds=5,activity_interval_seconds=2",
  ).run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_outbox"),
    env.DB.prepare("DELETE FROM payment_attempts"),
    env.DB.prepare("DELETE FROM payment_tasks"),
    env.DB.prepare("DELETE FROM simulation_orders"),
    env.DB.prepare("DELETE FROM simulation_controls"),
    env.DB.prepare("DELETE FROM merchant_credentials"),
    env.DB.prepare("DELETE FROM global_redemptions"),
    env.DB.prepare("DELETE FROM attempt_events"),
    env.DB.prepare("DELETE FROM redemption_submissions"),
    env.DB.prepare("DELETE FROM claims"),
    env.DB.prepare("DELETE FROM reward_inventory"),
    env.DB.prepare("DELETE FROM activity_passwords"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare("DELETE FROM merchants"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM oauth_attempts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  owner = await actor("owner");
  alice = await actor("alice");
  bob = await actor("bob");
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: `passwords_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "本地模拟",
      secret: "virtual-only-secret",
    })
  ).id;
});
afterEach(() => vi.restoreAllMocks());

describe("dedicated-page password visibility", () => {
  it("reveals draft answers only to the author without personal badges", async () => {
    const activity = await create(ldcConfig(), false);
    expect(await passwords(activity.id, owner)).toEqual({
      passwords: validPasswords.map((text) => ({
        text,
        isClaimPassword: false,
        isSolved: false,
      })),
      hiddenCount: 0,
      canSolve: false,
    });
    for (const viewer of [undefined, alice])
      expect(
        (await request(`/api/activities/${activity.id}/passwords`, viewer))
          .status,
      ).toBe(404);
  });

  it("reveals only the viewer's own award and solved answers while active", async () => {
    const activity = await create();
    await claim(activity.id, alice, "claim123");
    await claim(activity.id, bob, "other789");
    expect(await passwords(activity.id)).toEqual({
      passwords: [],
      hiddenCount: 5,
      canSolve: false,
    });
    expect(await passwords(activity.id, alice)).toEqual({
      passwords: [{ text: "claim123", isClaimPassword: true, isSolved: false }],
      hiddenCount: 4,
      canSolve: true,
    });
    expect(await solve(activity.id)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(await passwords(activity.id, alice)).toEqual({
      passwords: [
        { text: "claim123", isClaimPassword: true, isSolved: false },
        { text: "secret456", isClaimPassword: false, isSolved: true },
      ],
      hiddenCount: 3,
      canSolve: true,
    });
    expect(await passwords(activity.id, bob)).toEqual({
      passwords: [{ text: "other789", isClaimPassword: true, isSolved: false }],
      hiddenCount: 4,
      canSolve: true,
    });
    expect(await passwords(activity.id, owner)).toEqual({
      passwords: validPasswords.map((text) => ({
        text,
        isClaimPassword: false,
        isSolved: false,
      })),
      hiddenCount: 0,
      canSolve: false,
    });
    const publicDetail = await (
      await request(`/api/activities/${activity.id}`, alice)
    ).json();
    for (const text of validPasswords)
      expect(JSON.stringify(publicDetail)).not.toContain(text);
    expect(JSON.stringify(publicDetail)).not.toContain("PRIVATE-REWARD-");
  });

  it("gives a claimant only their own personal flags", async () => {
    const activity = await create();
    await claim(activity.id, alice, "claim123");
    await solve(activity.id, alice, "secret456");
    await claim(activity.id, bob, "other789");
    await solve(activity.id, bob, "lastword1");
    const answers = await passwords(activity.id, bob);
    expect(answers.canSolve).toBe(true);
    expect(answers.passwords).toEqual([
      { text: "other789", isClaimPassword: true, isSolved: false },
      { text: "lastword1", isClaimPassword: false, isSolved: true },
    ]);
  });

  it("does not decrypt unauthorized password ciphertext", async () => {
    const activity = await create();
    await claim(activity.id);
    await env.DB.prepare(
      "UPDATE activity_passwords SET ciphertext='INVALID-PRIVATE-CIPHERTEXT' WHERE activity_id=? AND position=4",
    )
      .bind(activity.id)
      .run();
    expect((await passwords(activity.id)).passwords).toEqual([]);
    expect((await passwords(activity.id, alice)).passwords).toEqual([
      { text: "claim123", isClaimPassword: true, isSolved: false },
    ]);
  });

  it.each(["ended", "archived"] as const)(
    "publishes all answers at the actual %s time before lifecycle persistence",
    async (status) => {
      const activity = await create(ldcConfig({ forceDedicated: true }));
      await claim(activity.id);
      await solve(activity.id);
      const before = await counts(activity.id);
      await env.DB.prepare("UPDATE activities SET deadline=? WHERE id=?")
        .bind(
          Date.now() - (status === "archived" ? ARCHIVE_DELAY_MS : 0) - 1000,
          activity.id,
        )
        .run();
      expect(
        await env.DB.prepare(
          "SELECT ended_at, archived_at FROM activities WHERE id=?",
        )
          .bind(activity.id)
          .first(),
      ).toEqual({ ended_at: null, archived_at: null });
      expect(await passwords(activity.id)).toEqual({
        passwords: validPasswords.map((text) => ({
          text,
          isClaimPassword: false,
          isSolved: false,
        })),
        hiddenCount: 0,
        canSolve: false,
      });
      const own = await passwords(activity.id, alice);
      expect(own.canSolve).toBe(false);
      expect(own.hiddenCount).toBe(0);
      expect(own.passwords[0]).toMatchObject({ isClaimPassword: true });
      expect(own.passwords[1]).toMatchObject({ isSolved: true });
      expect(await solve(activity.id, alice, "hidden999")).toEqual({
        outcome: status,
        passwordMatched: null,
      });
      expect((await submitSolve(activity.id, bob)).status).toBe(403);
      expect(await counts(activity.id)).toEqual(before);
      const endedRow = await env.DB.prepare(
        "SELECT validated_at,matched_password_id,claim_id FROM redemption_submissions WHERE purpose='solve' AND outcome=?",
      )
        .bind(status)
        .first();
      expect(endedRow).toEqual({
        validated_at: null,
        matched_password_id: null,
        claim_id: null,
      });
    },
  );

  it("publishes all answers when inventory is exhausted, including before end metadata repair", async () => {
    const activity = await create(
      ldcConfig({
        money: { mode: "fixed", totalAmount: "1.00", count: 1 },
      }),
    );
    await claim(activity.id);
    await env.DB.prepare(
      "UPDATE activities SET ended_at=NULL,end_reason=NULL WHERE id=?",
    )
      .bind(activity.id)
      .run();
    expect(await passwords(activity.id)).toEqual({
      passwords: validPasswords.map((text) => ({
        text,
        isClaimPassword: false,
        isSolved: false,
      })),
      hiddenCount: 0,
      canSolve: false,
    });
    const before = await counts(activity.id);
    expect(await solve(activity.id)).toEqual({
      outcome: "ended",
      passwordMatched: null,
    });
    expect(await counts(activity.id)).toEqual(before);
  });
});

describe("terminal password validation without reward allocation", () => {
  it("requires a previous claim, authentication, CSRF and a valid password", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    const payload = {
      submissionId: crypto.randomUUID(),
      password: "secret456",
    };
    expect(
      (
        await request(
          `/api/activities/${activity.id}/password-solves`,
          undefined,
          "POST",
          payload,
        )
      ).status,
    ).toBe(401);
    expect((await submitSolve(activity.id)).status).toBe(403);
    const draft = await create(ldcConfig(), false);
    expect((await submitSolve(draft.id)).status).toBe(404);
    expect((await submitSolve(draft.id, owner)).status).toBe(400);
    await claim(activity.id);
    const before = await counts(activity.id);
    expect(
      (
        await request(
          `/api/activities/${activity.id}/password-solves`,
          alice,
          "POST",
          payload,
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/activities/${activity.id}/password-solves`,
          alice,
          "POST",
          payload,
          { Origin: "https://untrusted.example" },
        )
      ).status,
    ).toBe(403);
    expect((await submitSolve(activity.id, alice, "bad!")).status).toBe(400);
    expect(await counts(activity.id)).toEqual(before);
  });

  it("keeps forced attempts encrypted and increments validations without increasing claim statistics", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    const award = await claim(activity.id);
    expect(await solve(activity.id)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(await solve(activity.id, alice, "wrong123")).toEqual({
      outcome: "incorrect",
      passwordMatched: false,
    });
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      assigned: 1,
      version: activity.version,
      attempts: 3,
      validations: 3,
      payments: 1,
      outbox: 1,
    });
    const stats = (await (
      await request(`/api/me/activities/${activity.id}/statistics`, owner)
    ).json()) as ActivityStatistics;
    expect(stats).toMatchObject({
      totalAttempts: 3,
      uniqueUsers: 1,
      successfulClaims: 1,
    });
    expect(
      stats.items.find((item) => item.password === "secret456"),
    ).toMatchObject({
      matchedAttempts: 1,
      unmatchedAttempts: 0,
      successfulClaims: 0,
    });
    const attempts = await env.DB.prepare(
      "SELECT e.ciphertext,e.submission_row_id,e.claim_id FROM attempt_events e JOIN redemption_submissions s ON s.id=e.submission_row_id WHERE s.purpose='solve'",
    ).all<{
      ciphertext: string;
      submission_row_id: string;
      claim_id: string | null;
    }>();
    expect(attempts.results).toHaveLength(2);
    expect(attempts.results.every((row) => row.claim_id === null)).toBe(true);
    expect(JSON.stringify(attempts)).not.toContain("wrong123");
    const decrypted = await Promise.all(
      attempts.results.map((row) =>
        decryptString(
          row.ciphertext,
          bindings,
          attemptAssociatedData(activity.id, row.submission_row_id),
        ),
      ),
    );
    expect(decrypted.sort()).toEqual(["secret456", "wrong123"]);
    const claimDetail = (await (
      await request(`/api/me/claims/${award.claim.id}`, alice)
    ).json()) as { claim: ClaimDetail };
    expect(claimDetail.claim).toMatchObject({
      id: award.claim.id,
      rewardType: "ldc",
      amount: award.claim.amount,
      sourcePassword: award.claim.sourcePassword,
      afterClaimInfo: award.claim.afterClaimInfo,
      payment: {
        id: award.claim.payment?.id,
        mode: award.claim.payment?.mode,
      },
    });
  });

  it("never saves failed raw input for ordinary activities", async () => {
    const activity = await create();
    await claim(activity.id);
    expect(await solve(activity.id, alice, "wrong123")).toEqual({
      outcome: "incorrect",
      passwordMatched: false,
    });
    expect(await counts(activity.id)).toMatchObject({
      attempts: 0,
      validations: 2,
    });
    const row = await env.DB.prepare(
      "SELECT * FROM redemption_submissions WHERE purpose='solve'",
    ).first();
    expect(JSON.stringify(row)).not.toContain("wrong123");
    expect((await passwords(activity.id, alice)).hiddenCount).toBe(4);
  });

  it("replays normalized lost-response submissions across DO eviction and binds their purpose and content", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    const awardKey = crypto.randomUUID();
    await claim(activity.id, alice, "claim123", awardKey);
    const key = crypto.randomUUID();
    expect(await solve(activity.id, alice, " secret456 ", key)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(activity.id));
    await evictDurableObject(stub);
    expect(await solve(activity.id, alice, "secret456", key)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(
      (await submitSolve(activity.id, alice, "other789", key)).status,
    ).toBe(409);
    expect(
      (await submitClaim(activity.id, alice, "secret456", key)).status,
    ).toBe(409);
    expect(
      (await submitSolve(activity.id, alice, "claim123", awardKey)).status,
    ).toBe(409);
    const different = await create();
    expect(
      (await submitSolve(different.id, alice, "secret456", key)).status,
    ).toBe(409);
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      attempts: 2,
      validations: 2,
    });
    const saved = required(await findSubmission(bindings, alice.id, key));
    await expect(
      completeClaimSubmission(bindings, saved),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(await resumePendingActivityClaims(bindings, activity.id)).toBe(0);
  });

  it("preserves old claim fingerprints and default purpose for legacy requests", async () => {
    const activity = await create();
    const key = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,outcome,created_at,validated_at,finished_at)
      VALUES (?,?,?,?,?,'incorrect',?,?,?)`)
      .bind(
        crypto.randomUUID(),
        activity.id,
        alice.id,
        key,
        await digestPassword(
          `claim-request:${activity.id}:wrong123`,
          bindings.PASSWORD_DIGEST_KEY,
        ),
        Date.now(),
        Date.now(),
        Date.now(),
      )
      .run();
    const response = await submitClaim(activity.id, alice, "wrong123", key);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: "incorrect" });
    expect(
      (await submitSolve(activity.id, alice, "wrong123", key)).status,
    ).toBe(409);
    expect((await findSubmission(bindings, alice.id, key))?.purpose).toBe(
      "claim",
    );
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      validations: 1,
    });
  });

  it("shares the persistent cooldown across claim and solve and does not advance it for saved replays", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    const awardKey = crypto.randomUUID();
    await claim(activity.id, alice, "claim123", awardKey);
    const solveKey = crypto.randomUUID();
    const firstRejected = await submitSolve(
      activity.id,
      alice,
      "secret456",
      solveKey,
    );
    expect(firstRejected.status).toBe(429);
    expect(await firstRejected.json()).toMatchObject({
      error: { code: "CLAIM_RATE_LIMITED" },
    });
    await advanceAttemptCooldown(env.DB, alice.id);
    const admitted = await submitSolve(
      activity.id,
      alice,
      "secret456",
      solveKey,
    );
    expect(admitted.status).toBe(200);
    const accepted = (await admitted.json()) as SolveResult;
    expect(accepted).toMatchObject({
      outcome: "solved",
      attemptCooldown: { revision: 2 },
    });
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(activity.id));
    await evictDurableObject(stub);
    const limited = await submitSolve(activity.id);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("Retry-After"))).toBeLessThanOrEqual(2);
    const replay = await submitSolve(activity.id, alice, "secret456", solveKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      outcome: "solved",
      attemptCooldown: {
        revision: 2,
        nextAllowedAt: accepted.attemptCooldown?.nextAllowedAt,
      },
    });
    expect(
      (await submitClaim(activity.id, alice, "claim123", awardKey)).status,
    ).toBe(200);
    expect((await submitSolve(activity.id, alice, "bad!")).status).toBe(400);
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      attempts: 2,
      validations: 2,
    });
    await advanceAttemptCooldown(env.DB, alice.id);
    const next = await submitSolve(activity.id, alice, "other789");
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({
      outcome: "solved",
      attemptCooldown: { revision: 3 },
    });
    expect(await counts(activity.id)).toMatchObject({
      attempts: 3,
      validations: 3,
    });
  });

  it("keeps an incorrect result immutable when legacy data gains that password", async () => {
    const activity = await create(
      ldcConfig({
        passwords: validPasswords.slice(0, 4),
        forceDedicated: true,
      }),
    );
    await claim(activity.id);
    const key = crypto.randomUUID();
    expect(await solve(activity.id, alice, "hidden999", key)).toEqual({
      outcome: "incorrect",
      passwordMatched: false,
    });
    // Preserve compatibility with historical additions, now forbidden by author edits.
    const [later] = await preparePasswords(
      bindings,
      activity.id,
      ["hidden999"],
      [],
      Date.now(),
    );
    if (!later) throw new Error("Missing legacy password fixture");
    await env.DB.batch([
      insertPasswordRows(env.DB, [
        { ...later, position: activity.config.passwords.length },
      ]),
    ]);
    expect(await solve(activity.id, alice, "hidden999", key)).toEqual({
      outcome: "incorrect",
      passwordMatched: false,
    });
    expect((await passwords(activity.id, alice)).passwords).not.toContainEqual({
      text: "hidden999",
      isClaimPassword: false,
      isSolved: true,
    });
    expect(await solve(activity.id, alice, "hidden999")).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    const stats = (await (
      await request(`/api/me/activities/${activity.id}/statistics`, owner)
    ).json()) as ActivityStatistics;
    expect(
      stats.items.find((item) => item.password === "hidden999"),
    ).toMatchObject({
      attempts: 2,
      matchedAttempts: 1,
      unmatchedAttempts: 1,
      successfulClaims: 0,
    });
  });

  it("atomically enforces the shared cooldown even without DO request serialization", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    await claim(activity.id);
    await advanceAttemptCooldown(env.DB, alice.id);
    const outcomes = await Promise.allSettled(
      ["secret456", "other789"].map((password) =>
        solveActivityPassword(bindings, activity.id, alice.id, {
          submissionId: crypto.randomUUID(),
          password,
        }),
      ),
    );
    const successes = outcomes.filter(
      (result) => result.status === "fulfilled",
    );
    const failures = outcomes.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({ value: { outcome: "solved" } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: { status: 429 } });
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      assigned: 1,
      attempts: 2,
      validations: 2,
    });
  });

  it("rolls back failed solve persistence atomically and permits a same-key retry", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    await claim(activity.id);
    const key = crypto.randomUUID();
    const before = await counts(activity.id);
    await advanceAttemptCooldown(env.DB, alice.id);
    await env.DB.prepare(
      "CREATE TRIGGER fail_password_attempt BEFORE INSERT ON attempt_events BEGIN SELECT RAISE(ABORT,'injected attempt failure'); END",
    ).run();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        (await submitSolve(activity.id, alice, "secret456", key)).status,
      ).toBe(500);
      expect(await counts(activity.id)).toEqual(before);
      expect(await findSubmission(bindings, alice.id, key)).toBeUndefined();
      expect((await passwords(activity.id, alice)).hiddenCount).toBe(4);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_password_attempt").run();
    }
    expect(await solve(activity.id, alice, "secret456", key)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      attempts: 2,
      validations: 2,
    });
  });

  it("deduplicates concurrent UUIDs and admits only one concurrent new solution without allocating", async () => {
    const activity = await create(ldcConfig({ forceDedicated: true }));
    await claim(activity.id);
    const key = crypto.randomUUID();
    await advanceAttemptCooldown(env.DB, alice.id);
    const same = await Promise.all(
      Array.from({ length: 4 }, () =>
        submitSolve(activity.id, alice, "secret456", key),
      ),
    );
    for (const response of same) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ outcome: "solved" });
    }
    await advanceAttemptCooldown(env.DB, alice.id);
    const distinct = await Promise.all([
      submitSolve(activity.id, alice, "other789"),
      submitSolve(activity.id, alice, "lastword1"),
    ]);
    expect(distinct.map((response) => response.status).sort()).toEqual([
      200, 429,
    ]);
    for (const response of distinct)
      expect(await response.json()).toMatchObject(
        response.status === 200
          ? { outcome: "solved" }
          : { error: { code: "CLAIM_RATE_LIMITED" } },
      );
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      assigned: 1,
      version: activity.version,
      attempts: 3,
      validations: 3,
      payments: 1,
      outbox: 1,
    });
    expect((await passwords(activity.id, alice)).hiddenCount).toBe(2);
  });

  it("leaves the original simulated LDC task, reward and outbox unchanged", async () => {
    const merchant = { id: merchantId };
    const { rewardType: _type, ...base } = ldcConfig({ forceDedicated: true });
    const activity = await create({
      ...base,
      rewardType: "ldc",
      merchantId: merchant.id,
      money: { mode: "fixed", totalAmount: "1.00", count: 4 },
    });
    const award = await claim(activity.id);
    const taskBefore = await env.DB.prepare(
      "SELECT * FROM payment_tasks",
    ).first();
    const outboxBefore = await env.DB.prepare(
      "SELECT id,task_id,created_at FROM payment_outbox",
    ).first();
    expect(await solve(activity.id)).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(await solve(activity.id, alice, "other789")).toEqual({
      outcome: "solved",
      passwordMatched: true,
    });
    expect(await env.DB.prepare("SELECT * FROM payment_tasks").first()).toEqual(
      taskBefore,
    );
    expect(
      await env.DB.prepare(
        "SELECT id,task_id,created_at FROM payment_outbox",
      ).first(),
    ).toEqual(outboxBefore);
    expect(await counts(activity.id)).toMatchObject({
      claims: 1,
      assigned: 1,
      payments: 1,
      outbox: 1,
    });
    expect(
      await (await request(`/api/me/claims/${award.claim.id}`, alice)).json(),
    ).toEqual({ claim: award.claim });
    expect((await submitSolve(activity.id, owner)).status).toBe(403);
  });
});

describe("deleted activity exclusion", () => {
  it("rejects replay and reads after draft deletion", async () => {
    const activity = await create(ldcConfig(), false);
    const input = { submissionId: crypto.randomUUID(), password: "claim123" };
    await expect(
      prepareClaimSubmission(bindings, activity.id, alice.id, input),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "DELETE", {
          version: activity.version,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await submitClaim(
          activity.id,
          alice,
          input.password,
          input.submissionId,
        )
      ).status,
    ).toBe(404);
    expect((await submitSolve(activity.id, owner)).status).toBe(404);
    expect(
      (await request(`/api/activities/${activity.id}/passwords`, owner)).status,
    ).toBe(404);
    expect(
      (await request(`/api/activities/${activity.id}/recipients`, owner))
        .status,
    ).toBe(404);
    await expect(
      prepareClaimSubmission(bindings, activity.id, alice.id, input),
    ).rejects.toMatchObject({ status: 404 });
    expect(await resumePendingActivityClaims(bindings, activity.id)).toBe(0);
  });

  it("excludes an old malformed pending record on a tombstoned draft from recovery", async () => {
    const activity = await create(ldcConfig(), false);
    const input = { submissionId: crypto.randomUUID(), password: "claim123" };
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,outcome,created_at)
      VALUES (?,?,?,?,?,'pending',?)`)
      .bind(
        crypto.randomUUID(),
        activity.id,
        owner.id,
        input.submissionId,
        await digestPassword(
          `claim-request:${activity.id}:claim123`,
          bindings.PASSWORD_DIGEST_KEY,
        ),
        Date.now(),
      )
      .run();
    const pending = required(
      await findSubmission(bindings, owner.id, input.submissionId),
    );
    await env.DB.prepare("UPDATE activities SET deleted_at=? WHERE id=?")
      .bind(Date.now(), activity.id)
      .run();
    expect(await resumePendingActivityClaims(bindings, activity.id)).toBe(0);
    await expect(
      completeClaimSubmission(bindings, pending),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      solveActivityPassword(bindings, activity.id, owner.id, {
        ...input,
        submissionId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM claims").first("COUNT(*)"),
    ).toBe(0);
  });
});
