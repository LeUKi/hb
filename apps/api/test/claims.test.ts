import { env, evictDurableObject } from "cloudflare:test";
import {
  type TextActivityInput as ActivityInput,
  ARCHIVE_DELAY_MS,
  type AuthorClaimList,
  CLAIM_WINDOW_MS,
  type ClaimDetail,
  type ClaimList,
  type ClaimResult,
  emptyActivityInput,
  type ManagedActivity,
  type PublicRecipientList,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptAssociatedData,
  completeClaimSubmission,
  prepareClaimSubmission,
} from "../src/activities/claim-service";
import {
  refreshActivityLifecycle,
  sweepActivityLifecycle,
} from "../src/activities/lifecycle";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { decryptString, sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;

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
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function request(
  path: string,
  user?: Actor,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
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
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}

async function create(config: Partial<ActivityInput> = {}, open = true) {
  const response = await request("/api/activities", owner, "POST", {
    requestId: crypto.randomUUID(),
    activity: {
      ...emptyActivityInput(),
      title: "领取测试",
      passwords: ["正确口令123", "another123"],
      rewards: [
        { id: crypto.randomUUID(), text: "PRIVATE-TEXT-A" },
        { id: crypto.randomUUID(), text: "PRIVATE-TEXT-B" },
      ],
      afterClaimInfo: "AFTER-CLAIM",
      afterEndInfo: "AFTER-END",
      ...config,
    },
  });
  expect(response.status).toBe(200);
  const result = ((await response.json()) as { activity: ManagedActivity })
    .activity;
  if (!open) return result;
  const opened = await request(
    `/api/me/activities/${result.id}/open`,
    owner,
    "POST",
    { version: result.version },
  );
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { activity: ManagedActivity }).activity;
}

function submit(
  activityId: string,
  user = alice,
  password = "正确口令123",
  submissionId = crypto.randomUUID(),
) {
  return request(`/api/activities/${activityId}/claim`, user, "POST", {
    submissionId,
    password,
  });
}

async function claim(
  activityId: string,
  user = alice,
  password = "正确口令123",
  submissionId = crypto.randomUUID(),
) {
  const response = await submit(activityId, user, password, submissionId);
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResult;
}

async function stats(activityId: string) {
  const row =
    await env.DB.prepare(`SELECT claimed_count AS claimed, version, ended_at AS endedAt, end_reason AS endReason, archived_at AS archivedAt,
    (SELECT COUNT(*) FROM claims WHERE activity_id = activities.id) AS claims,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id = activities.id) AS attempts,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id = activities.id AND validated_at IS NOT NULL) AS validations
    FROM activities WHERE id = ?`)
      .bind(activityId)
      .first<{
        claimed: number;
        version: number;
        endedAt: number | null;
        endReason: string | null;
        archivedAt: number | null;
        claims: number;
        attempts: number;
        validations: number;
      }>();
  return required(row);
}

async function managed(id: string) {
  return (
    (await (await request(`/api/me/activities/${id}`, owner)).json()) as {
      activity: ManagedActivity;
    }
  ).activity;
}

beforeEach(async () => {
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
});
afterEach(() => vi.restoreAllMocks());

describe("text claiming and private history", () => {
  it("allocates sequentially, permits text authors to claim, and retains one immutable reward per account", async () => {
    const activity = await create();
    const first = await claim(activity.id);
    expect(first).toMatchObject({
      result: "claimed",
      claim: { text: "PRIVATE-TEXT-A", afterClaimInfo: "AFTER-CLAIM" },
    });
    expect(await stats(activity.id)).toMatchObject({
      claimed: 1,
      claims: 1,
      version: activity.version,
      attempts: 0,
    });
    const again = await claim(activity.id, alice, "another123");
    expect(again).toMatchObject({
      result: "already_claimed",
      claim: { text: "PRIVATE-TEXT-A" },
    });
    const second = await claim(activity.id, owner);
    expect(second).toMatchObject({
      result: "claimed",
      claim: { text: "PRIVATE-TEXT-B" },
    });
    expect(await stats(activity.id)).toMatchObject({
      claimed: 2,
      claims: 2,
      version: activity.version + 1,
      endReason: "exhausted",
    });
    expect(await claim(activity.id, bob)).toEqual({ result: "ended" });
  });

  it("supports random allocation without replacement and identical text entries remain separate rewards", async () => {
    const rewards = Array.from({ length: 6 }, () => ({
      id: crypto.randomUUID(),
      text: "same private value",
    }));
    const activity = await create({ allocation: "random", rewards });
    const actors = await Promise.all(
      Array.from({ length: 6 }, (_, index) => actor(`random-${index}`)),
    );
    const results = await Promise.all(
      actors.map((user) => claim(activity.id, user)),
    );
    expect(results.every((result) => result.result === "claimed")).toBe(true);
    const rows = await env.DB.prepare(
      "SELECT inventory_id FROM claims WHERE activity_id = ?",
    )
      .bind(activity.id)
      .all<{ inventory_id: string }>();
    expect(new Set(rows.results.map((row) => row.inventory_id)).size).toBe(6);
    expect(await stats(activity.id)).toMatchObject({
      claimed: 6,
      claims: 6,
      endReason: "exhausted",
    });
  });

  it("replays lost responses with the same claim and rejects changed password or activity on a reused key", async () => {
    const activity = await create({ forceDedicated: true });
    const key = crypto.randomUUID();
    const first = await claim(activity.id, alice, "正确口令123", key);
    const replay = await claim(activity.id, alice, "正确口令123", key);
    expect(replay).toEqual(first);
    expect(await stats(activity.id)).toMatchObject({
      claimed: 1,
      claims: 1,
      attempts: 1,
      validations: 1,
    });
    expect((await submit(activity.id, alice, "another123", key)).status).toBe(
      409,
    );
    const different = await create();
    expect((await submit(different.id, alice, "正确口令123", key)).status).toBe(
      409,
    );
    expect((await stats(different.id)).claimed).toBe(0);
  });

  it("serializes the last reward and competing keys without overselling", async () => {
    const activity = await create({
      forceDedicated: true,
      rewards: [{ id: crypto.randomUUID(), text: "last one" }],
    });
    const results = await Promise.all([
      claim(activity.id, alice),
      claim(activity.id, bob),
      claim(activity.id, alice, "another123"),
    ]);
    expect(
      results.filter((result) => result.result === "claimed"),
    ).toHaveLength(1);
    expect(await stats(activity.id)).toMatchObject({
      claims: 1,
      claimed: 1,
      endReason: "exhausted",
    });
    const linked = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attempt_events WHERE claim_id IS NOT NULL AND activity_id = ?",
    )
      .bind(activity.id)
      .first("n");
    expect(linked).toBe(1);
  });

  it("does not create claims, validation events or private responses for unauthenticated, invalid or blocked requests", async () => {
    const activity = await create({ forceDedicated: true });
    const payload = {
      submissionId: crypto.randomUUID(),
      password: "正确口令123",
    };
    expect(
      (
        await request(
          `/api/activities/${activity.id}/claim`,
          undefined,
          "POST",
          payload,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          `/api/activities/${activity.id}/claim`,
          alice,
          "POST",
          payload,
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect((await submit(activity.id, alice, "bad!")).status).toBe(400);
    const draft = await create({ forceDedicated: true }, false);
    expect(await claim(draft.id, owner)).toEqual({ result: "draft" });
    expect((await submit(draft.id, alice)).status).toBe(404);
    expect(await stats(activity.id)).toMatchObject({
      claims: 0,
      attempts: 0,
      validations: 0,
    });
    expect(await stats(draft.id)).toMatchObject({
      claims: 0,
      attempts: 0,
      validations: 0,
    });
  });

  it("keeps private reward access claimant-only and author-only, including after archive", async () => {
    const activity = await create();
    const result = await claim(activity.id);
    if (result.result !== "claimed") throw new Error("Expected claim");
    const id = result.claim.id;
    expect((await request(`/api/me/claims/${id}`)).status).toBe(401);
    expect((await request(`/api/me/claims/${id}`, bob)).status).toBe(404);
    expect(
      (await request(`/api/me/activities/${activity.id}/claims`, bob)).status,
    ).toBe(404);
    const history = (await (
      await request("/api/me/claims", alice)
    ).json()) as ClaimList;
    expect(history.items).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("PRIVATE-TEXT-A");
    const before = await (
      await request(`/api/activities/${activity.id}`, alice)
    ).json();
    expect(JSON.stringify(before)).not.toContain("PRIVATE-TEXT-A");
    expect(JSON.stringify(before)).not.toContain("AFTER-CLAIM");
    const changed = await managed(activity.id);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: changed.version,
          activity: {
            ...changed.config,
            afterClaimInfo: "updated shared information",
          },
        })
      ).status,
    ).toBe(200);
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, activity.id)
      .run();
    await refreshActivityLifecycle(bindings, activity.id);
    const response = await request(`/api/me/claims/${id}`, alice);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const detail = (await response.json()) as { claim: ClaimDetail };
    expect(detail.claim).toMatchObject({
      text: "PRIVATE-TEXT-A",
      afterClaimInfo: "updated shared information",
      activity: { status: "archived" },
    });
    const authorList = (await (
      await request(`/api/me/activities/${activity.id}/claims`, owner)
    ).json()) as AuthorClaimList;
    expect(authorList.items[0]).toMatchObject({
      text: "PRIVATE-TEXT-A",
      claimant: { id: alice.id },
    });
    expect((await claim(activity.id)).result).toBe("already_claimed");
    expect(await claim(activity.id, bob)).toEqual({ result: "archived" });
  });
});

describe("durable validation, statistics and recovery", () => {
  it("counts new wrong submissions, deduplicates retransmission, and never rewrites history after adding a password", async () => {
    const activity = await create({ forceDedicated: true });
    const password = "将来有效123";
    const firstKey = crypto.randomUUID();
    for (const key of [firstKey, crypto.randomUUID(), crypto.randomUUID()])
      expect(await claim(activity.id, alice, password, key)).toEqual({
        result: "incorrect",
      });
    expect(await claim(activity.id, alice, password, firstKey)).toEqual({
      result: "incorrect",
    });
    expect(await stats(activity.id)).toMatchObject({
      attempts: 3,
      validations: 3,
      claims: 0,
    });
    const records = await env.DB.prepare(
      "SELECT ciphertext, submission_row_id FROM attempt_events WHERE activity_id = ?",
    )
      .bind(activity.id)
      .all<{ ciphertext: string; submission_row_id: string }>();
    expect(JSON.stringify(records)).not.toContain(password);
    expect(
      await decryptString(
        required(records.results[0]).ciphertext,
        bindings,
        attemptAssociatedData(
          activity.id,
          required(records.results[0]).submission_row_id,
        ),
      ),
    ).toBe(password);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: activity.version,
          activity: {
            ...activity.config,
            passwords: [...activity.config.passwords, password],
          },
        })
      ).status,
    ).toBe(200);
    expect(await claim(activity.id, alice, password, firstKey)).toEqual({
      result: "incorrect",
    });
    expect((await claim(activity.id, alice, password)).result).toBe("claimed");
    const aggregate = await env.DB.prepare(
      "SELECT matched, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users, COUNT(claim_id) AS successes FROM attempt_events WHERE activity_id = ? GROUP BY matched ORDER BY matched",
    )
      .bind(activity.id)
      .all();
    expect(aggregate.results).toEqual([
      { matched: 0, count: 3, users: 1, successes: 0 },
      { matched: 1, count: 1, users: 1, successes: 1 },
    ]);
  });

  it("retains admitted matched attempts through process eviction and resumes without duplicate events", async () => {
    const activity = await create({ forceDedicated: true });
    const input = {
      submissionId: crypto.randomUUID(),
      password: "正确口令123",
    };
    const pending = await prepareClaimSubmission(
      bindings,
      activity.id,
      alice.id,
      input,
    );
    expect(pending.outcome).toBe("pending");
    expect(await stats(activity.id)).toMatchObject({ attempts: 1, claims: 0 });
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(activity.id));
    await (
      await stub.fetch("https://activity.internal/internal/health")
    ).arrayBuffer();
    await evictDurableObject(stub);
    expect(
      (await claim(activity.id, alice, input.password, input.submissionId))
        .result,
    ).toBe("claimed");
    expect(await stats(activity.id)).toMatchObject({
      attempts: 1,
      validations: 1,
      claims: 1,
      claimed: 1,
    });
  });

  it("preserves matched-but-unallocated attempts when the deadline passes or another person takes the last reward", async () => {
    const expired = await create({ forceDedicated: true });
    const pending = await prepareClaimSubmission(
      bindings,
      expired.id,
      alice.id,
      { submissionId: crypto.randomUUID(), password: "正确口令123" },
    );
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 10, expired.id)
      .run();
    expect(await completeClaimSubmission(bindings, pending)).toEqual({
      result: "ended",
    });
    expect(await stats(expired.id)).toMatchObject({
      attempts: 1,
      claims: 0,
      claimed: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT matched, claim_id FROM attempt_events WHERE activity_id = ?",
      )
        .bind(expired.id)
        .first(),
    ).toEqual({ matched: 1, claim_id: null });
    const exhausted = await create({
      forceDedicated: true,
      rewards: [{ id: crypto.randomUUID(), text: "one" }],
    });
    const losing = await prepareClaimSubmission(
      bindings,
      exhausted.id,
      alice.id,
      { submissionId: crypto.randomUUID(), password: "正确口令123" },
    );
    expect((await claim(exhausted.id, bob)).result).toBe("claimed");
    expect(await completeClaimSubmission(bindings, losing)).toEqual({
      result: "ended",
    });
    expect(await stats(exhausted.id)).toMatchObject({ attempts: 2, claims: 1 });
  });

  it("lets Cron resume interrupted valid submissions and settle expired pending work without new attempts", async () => {
    const active = await create({ forceDedicated: true });
    const expired = await create({ forceDedicated: true });
    await prepareClaimSubmission(bindings, active.id, alice.id, {
      submissionId: crypto.randomUUID(),
      password: "正确口令123",
    });
    await prepareClaimSubmission(bindings, expired.id, bob.id, {
      submissionId: crypto.randomUUID(),
      password: "正确口令123",
    });
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 10, expired.id)
      .run();
    expect(await sweepActivityLifecycle(bindings)).toBe(2);
    expect(await stats(active.id)).toMatchObject({
      attempts: 1,
      validations: 1,
      claims: 1,
    });
    expect(await stats(expired.id)).toMatchObject({
      attempts: 1,
      validations: 1,
      claims: 0,
      endReason: "expired",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM redemption_submissions WHERE outcome = 'pending'",
      ).first("n"),
    ).toBe(0);
    expect(await sweepActivityLifecycle(bindings)).toBe(0);
  });

  it("isolates early lifecycle failures and recovers later pages plus interrupted claims before retrying failures next sweep", async () => {
    const activities: ManagedActivity[] = [];
    for (let index = 0; index < 56; index++)
      activities.push(await create({ forceDedicated: true }));
    activities.sort((left, right) => left.id.localeCompare(right.id));
    const databaseFailure = required(activities[0]);
    const networkFailure = required(activities[1]);
    const resumed = required(activities.at(-1));
    const deadline = Date.now() - 1000;
    const submission = await prepareClaimSubmission(
      bindings,
      resumed.id,
      alice.id,
      { submissionId: crypto.randomUUID(), password: "正确口令123" },
    );
    expect(submission.outcome).toBe("pending");
    await env.DB.prepare("UPDATE activities SET deadline=? WHERE id<>?")
      .bind(deadline, resumed.id)
      .run();
    // A real database rejection produces a non-OK ActivityDO response. A
    // separate transport exception must also remain isolated by the sweep.
    await env.DB.prepare(
      `CREATE TRIGGER fail_lifecycle_refresh BEFORE UPDATE OF ended_at ON activities
       WHEN OLD.id='${databaseFailure.id}' BEGIN SELECT RAISE(ABORT, 'PRIVATE-DIAGNOSTIC'); END`,
    ).run();
    const failingObject = env.ACTIVITY_DO.idFromName(networkFailure.id);
    const get = bindings.ACTIVITY_DO.get.bind(bindings.ACTIVITY_DO);
    const stubSpy = vi
      .spyOn(bindings.ACTIVITY_DO, "get")
      .mockImplementation((id, options) => {
        if (id.equals(failingObject))
          return {
            fetch: async () => {
              throw new Error("PRIVATE-NETWORK-DIAGNOSTIC");
            },
          } as unknown as ReturnType<typeof bindings.ACTIVITY_DO.get>;
        return get(id, options);
      });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await sweepActivityLifecycle(bindings)).toBe(54);
      expect(await stats(databaseFailure.id)).toMatchObject({ endedAt: null });
      expect(await stats(networkFailure.id)).toMatchObject({ endedAt: null });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM activities WHERE ended_at=? AND end_reason='expired'",
        )
          .bind(deadline)
          .first("n"),
      ).toBe(53);
      expect(await stats(resumed.id)).toMatchObject({
        claims: 1,
        claimed: 1,
        attempts: 1,
        validations: 1,
      });
      const reward = (await (
        await request(`/api/activities/${resumed.id}/claim`, alice)
      ).json()) as { claim: ClaimDetail };
      expect(reward.claim).toMatchObject({
        rewardType: "text",
        text: "PRIVATE-TEXT-A",
        afterClaimInfo: "AFTER-CLAIM",
      });
      const errors = log.mock.calls.filter(
        ([event]) => event === "activity_lifecycle_refresh_failed",
      );
      expect(errors).toHaveLength(2);
      expect(errors.map((entry) => entry[1])).toEqual(
        expect.arrayContaining([
          { activityId: databaseFailure.id },
          { activityId: networkFailure.id },
        ]),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE-");
    } finally {
      stubSpy.mockRestore();
      await env.DB.prepare("DROP TRIGGER fail_lifecycle_refresh").run();
    }
    expect(await sweepActivityLifecycle(bindings)).toBe(2);
    for (const activity of [databaseFailure, networkFailure])
      expect(await stats(activity.id)).toMatchObject({
        endedAt: deadline,
        endReason: "expired",
      });
    expect(await stats(resumed.id)).toMatchObject({ claims: 1, attempts: 1 });
    expect(await sweepActivityLifecycle(bindings)).toBe(0);
  }, 20_000);

  it("rolls back every allocation effect on failure while preserving the validation event for safe retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const activity = await create({
      forceDedicated: true,
      rewards: [{ id: crypto.randomUUID(), text: "only" }],
    });
    const key = crypto.randomUUID();
    await env.DB.prepare(
      "CREATE TRIGGER fail_allocation BEFORE UPDATE OF claim_id ON attempt_events WHEN NEW.claim_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'allocation test failure'); END",
    ).run();
    try {
      expect(
        (await submit(activity.id, alice, "正确口令123", key)).status,
      ).toBe(500);
      expect(await stats(activity.id)).toMatchObject({
        attempts: 1,
        validations: 1,
        claims: 0,
        claimed: 0,
        endedAt: null,
        version: activity.version,
      });
      expect(
        await env.DB.prepare(
          "SELECT outcome, claim_id FROM redemption_submissions WHERE submission_id = ?",
        )
          .bind(key)
          .first(),
      ).toEqual({ outcome: "pending", claim_id: null });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_allocation").run();
    }
    expect((await claim(activity.id, alice, "正确口令123", key)).result).toBe(
      "claimed",
    );
    expect(await stats(activity.id)).toMatchObject({
      attempts: 1,
      claims: 1,
      claimed: 1,
      endReason: "exhausted",
    });
  });

  it("enforces persistent rolling limits, bypasses them for replays, and keeps limits scoped to account and activity", async () => {
    const activity = await create({ forceDedicated: true });
    const firstKey = crypto.randomUUID();
    expect(await claim(activity.id, alice, "wrong123", firstKey)).toEqual({
      result: "incorrect",
    });
    for (let index = 1; index < 10; index += 1)
      expect(await claim(activity.id, alice, "wrong123")).toEqual({
        result: "incorrect",
      });
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(activity.id));
    await evictDurableObject(stub);
    const blocked = await submit(activity.id, alice, "wrong123");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(await claim(activity.id, alice, "wrong123", firstKey)).toEqual({
      result: "incorrect",
    });
    expect(await stats(activity.id)).toMatchObject({
      attempts: 10,
      validations: 10,
    });
    expect(await claim(activity.id, bob, "wrong123")).toEqual({
      result: "incorrect",
    });
    const another = await create();
    expect(await claim(another.id, alice, "wrong123")).toEqual({
      result: "incorrect",
    });
    await env.DB.prepare(
      "UPDATE redemption_submissions SET validated_at = ? WHERE activity_id = ? AND user_id = ?",
    )
      .bind(Date.now() - CLAIM_WINDOW_MS - 1, activity.id, alice.id)
      .run();
    expect(await claim(activity.id, alice, "wrong123")).toEqual({
      result: "incorrect",
    });
    expect((await stats(activity.id)).attempts).toBe(12);
  });

  it("uses configurable limits with the same SQL guard and invalid configuration falls back safely", async () => {
    const activity = await create();
    const config = { ...bindings, CLAIM_ATTEMPTS_PER_MINUTE: "1" };
    await prepareClaimSubmission(config, activity.id, alice.id, {
      submissionId: crypto.randomUUID(),
      password: "wrong123",
    });
    await expect(
      prepareClaimSubmission(config, activity.id, alice.id, {
        submissionId: crypto.randomUUID(),
        password: "wrong123",
      }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      prepareClaimSubmission(
        { ...config, CLAIM_ATTEMPTS_PER_MINUTE: "invalid" },
        activity.id,
        alice.id,
        { submissionId: crypto.randomUUID(), password: "wrong123" },
      ),
    ).resolves.toMatchObject({ outcome: "incorrect" });
  });

  it("enforces SQL uniqueness even when pending allocations bypass the DO in a concurrent recovery test", async () => {
    const activity = await create({ forceDedicated: true });
    const first = await prepareClaimSubmission(
      bindings,
      activity.id,
      alice.id,
      { submissionId: crypto.randomUUID(), password: "正确口令123" },
    );
    const second = await prepareClaimSubmission(
      bindings,
      activity.id,
      alice.id,
      { submissionId: crypto.randomUUID(), password: "another123" },
    );
    const results = await Promise.all([
      completeClaimSubmission(bindings, first),
      completeClaimSubmission(bindings, second),
    ]);
    expect(results.map((result) => result.result).sort()).toEqual([
      "already_claimed",
      "claimed",
    ]);
    expect(await stats(activity.id)).toMatchObject({
      attempts: 2,
      claims: 1,
      claimed: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM attempt_events WHERE claim_id IS NOT NULL AND activity_id = ?",
      )
        .bind(activity.id)
        .first("n"),
    ).toBe(1);
  });
});

describe("lifecycle and public recipients", () => {
  it("allows early ending only before any claim and treats repeats as the same ended activity", async () => {
    const activity = await create();
    const wrongOwner = await request(
      `/api/me/activities/${activity.id}/end`,
      alice,
      "POST",
      { version: activity.version },
    );
    expect(wrongOwner.status).toBe(404);
    const ended = await request(
      `/api/me/activities/${activity.id}/end`,
      owner,
      "POST",
      { version: activity.version },
    );
    expect(ended.status).toBe(200);
    expect(
      ((await ended.json()) as { activity: ManagedActivity }).activity.status,
    ).toBe("ended");
    const first = await stats(activity.id);
    expect(first.endReason).toBe("manual");
    expect(
      (
        await request(`/api/me/activities/${activity.id}/end`, owner, "POST", {
          version: activity.version,
        })
      ).status,
    ).toBe(200);
    expect((await stats(activity.id)).endedAt).toBe(first.endedAt);
    expect(await claim(activity.id)).toEqual({ result: "ended" });
    const claimed = await create();
    await claim(claimed.id);
    expect(
      (
        await request(`/api/me/activities/${claimed.id}/end`, owner, "POST", {
          version: claimed.version,
        })
      ).status,
    ).toBe(400);
  });

  it("does not both end early and allocate when an author races the first claimant", async () => {
    const activity = await create();
    const [ending, redeeming] = await Promise.all([
      request(`/api/me/activities/${activity.id}/end`, owner, "POST", {
        version: activity.version,
      }),
      submit(activity.id),
    ]);
    const result = (await redeeming.json()) as ClaimResult;
    const row = await stats(activity.id);
    if (ending.status === 200) {
      expect(result.result).toBe("ended");
      expect(row.claims).toBe(0);
      expect(row.endReason).toBe("manual");
    } else {
      expect(ending.status).toBe(400);
      expect(result.result).toBe("claimed");
      expect(row.claims).toBe(1);
      expect(row.endedAt).toBeNull();
    }
  });

  it("rechecks extended deadlines, persists the actual deadline as end time, and archives exactly once", async () => {
    const activity = await create();
    const later = new Date(
      Date.parse(required(activity.deadlineAt)) + 3600000,
    ).toISOString();
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: activity.version,
          activity: { ...activity.config, deadline: { mode: "at", at: later } },
        })
      ).status,
    ).toBe(200);
    // This refresh represents an old scan result; it may not overwrite the new deadline.
    await refreshActivityLifecycle(bindings, activity.id);
    expect((await stats(activity.id)).endedAt).toBeNull();
    const deadline = Date.now() - ARCHIVE_DELAY_MS - 1000;
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(deadline, activity.id)
      .run();
    expect(await claim(activity.id)).toEqual({ result: "archived" });
    const row = await stats(activity.id);
    expect(row).toMatchObject({
      endedAt: deadline,
      endReason: "expired",
      archivedAt: deadline + ARCHIVE_DELAY_MS,
    });
    await refreshActivityLifecycle(bindings, activity.id);
    expect(await stats(activity.id)).toEqual(row);
    const current = await managed(activity.id);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: current.version,
          activity: { ...current.config, deadline: { mode: "at", at: later } },
        })
      ).status,
    ).toBe(400);
  });

  it("sweeps more than one page and does not delete archived claim records", async () => {
    const original = await create();
    await claim(original.id);
    const template = required(
      await env.DB.prepare("SELECT * FROM activities WHERE id = ?")
        .bind(original.id)
        .first<Record<string, unknown>>(),
    );
    const deadline = Date.now() - ARCHIVE_DELAY_MS - 1000;
    const statements = Array.from({ length: 54 }, () =>
      env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,title,force_dedicated,allocation,config,total_count,created_at,updated_at,opened_at,deadline)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(),
        owner.id,
        crypto.randomUUID(),
        "synthetic",
        "synthetic",
        0,
        "sequential",
        template.config,
        1,
        Date.now(),
        Date.now(),
        Date.now() - ARCHIVE_DELAY_MS - 2000,
        deadline,
      ),
    );
    await env.DB.batch(statements);
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(deadline, original.id)
      .run();
    expect(await sweepActivityLifecycle(bindings)).toBe(55);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE archived_at IS NOT NULL",
      ).first("n"),
    ).toBe(55);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM claims").first("n"),
    ).toBe(1);
  });

  it("uses the single public-list toggle and keeps private rewards and cursor contents hidden", async () => {
    const activity = await create({
      rewards: Array.from({ length: 21 }, (_, index) => ({
        id: crypto.randomUUID(),
        text: `PRIVATE-${index}`,
      })),
      showRecipientList: true,
    });
    const actors = await Promise.all(
      Array.from({ length: 21 }, (_, index) => actor(`recipient-${index}`)),
    );
    for (const user of actors) await claim(activity.id, user);
    const response = await request(`/api/activities/${activity.id}/recipients`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = (await response.json()) as PublicRecipientList;
    expect(first.items).toHaveLength(20);
    expect(
      first.items.every(
        (item) =>
          typeof item.username === "string" &&
          typeof item.displayName === "string" &&
          typeof item.claimedAt === "string" &&
          !Object.hasOwn(item, "text") &&
          !Object.hasOwn(item, "amount"),
      ),
    ).toBe(true);
    const cursorEnvelope = JSON.parse(atob(required(first.nextCursor))) as {
      ciphertext: string;
    };
    expect(cursorEnvelope.ciphertext).toBeTypeOf("string");
    expect(atob(required(first.nextCursor))).not.toContain("claimedAt");
    const second = (await (
      await request(
        `/api/activities/${activity.id}/recipients?cursor=${encodeURIComponent(required(first.nextCursor))}`,
      )
    ).json()) as PublicRecipientList;
    expect(second.items).toHaveLength(1);
    const author = (await (
      await request(`/api/me/activities/${activity.id}/claims`, owner)
    ).json()) as AuthorClaimList;
    expect(author.items).toHaveLength(20);
    const ownerSecond = (await (
      await request(
        `/api/me/activities/${activity.id}/claims?cursor=${encodeURIComponent(required(author.nextCursor))}`,
        owner,
      )
    ).json()) as AuthorClaimList;
    expect(ownerSecond.items).toHaveLength(1);
    const otherActivity = await create({ showRecipientList: true });
    expect(
      (
        await request(
          `/api/activities/${otherActivity.id}/recipients?cursor=${encodeURIComponent(required(first.nextCursor))}`,
        )
      ).status,
    ).toBe(400);
    const current = await managed(activity.id);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: current.version,
          activity: {
            ...current.config,
            showRecipientUsername: true,
            showRecipientTime: true,
          },
        })
      ).status,
    ).toBe(200);
    const visible = (await (
      await request(`/api/activities/${activity.id}/recipients`)
    ).json()) as PublicRecipientList;
    expect(visible.items[0]).toMatchObject({
      username: expect.any(String),
      displayName: expect.any(String),
      claimedAt: expect.any(String),
    });
    expect(JSON.stringify(visible)).not.toContain("PRIVATE-");
    const latest = await managed(activity.id);
    await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
      version: latest.version,
      activity: { ...latest.config, showRecipientList: false },
    });
    expect(
      await (await request(`/api/activities/${activity.id}/recipients`)).json(),
    ).toEqual({ enabled: false, items: [], nextCursor: null });
  });
});
