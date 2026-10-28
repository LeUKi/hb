import { env } from "cloudflare:test";
import {
  type LdcActivityInput as ActivityInput,
  type ActivityStatistics,
  ARCHIVE_DELAY_MS,
  type DiscoveryList,
  emptyActivityInput,
  type GlobalRedemptionResult,
  type ManagedActivity,
  type PaymentState,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { passwordAssociatedData } from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import {
  digestPassword,
  encryptString,
  sha256Hex,
} from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";
import { resetMerchantHistory } from "./reset-merchant-history";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
};
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;
let ownerMerchantId: string;
let ownerMerchantClientId: string;

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
    displayName: username,
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

async function storePrivateProfile(user: Actor, username: string) {
  await env.DB.prepare(
    "UPDATE users SET email_ciphertext=?, avatar_url=? WHERE id=?",
  )
    .bind(
      `DISCOVERY-EMAIL-CIPHERTEXT-${username}`,
      `https://cdn.example.com/discovery/${username}.png`,
      user.id,
    )
    .run();
}

function request(path: string, user?: Actor, method = "GET", body?: unknown) {
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
    bindings,
  );
}

async function create(
  config: Partial<ActivityInput> = {},
  open = true,
  author = owner,
) {
  let merchantId = ownerMerchantId;
  if (author.id !== owner.id) {
    merchantId = (
      await createMerchant(bindings, author.id, {
        requestId: crypto.randomUUID(),
        clientId: `discovery_${crypto.randomUUID().replaceAll("-", "")}`,
        label: "本地模拟",
        secret: "virtual-only-secret",
      })
    ).id;
  }
  const response = await request("/api/activities", author, "POST", {
    requestId: crypto.randomUUID(),
    activity: {
      ...emptyActivityInput(),
      title: "发现测试",
      passwords: ["correct123"],
      rewardType: "ldc",
      merchantId,
      money: { mode: "fixed", totalAmount: "2.00", count: 2 },
      beforeInfo: "BEFORE-INFO",
      afterClaimInfo: "PRIVATE-AFTER-CLAIM",
      afterEndInfo: "AFTER-END",
      ...config,
    },
  });
  expect(response.status).toBe(200);
  const saved = ((await response.json()) as { activity: ManagedActivity })
    .activity;
  if (!open) return saved;
  const opened = await request(
    `/api/me/activities/${saved.id}/open`,
    author,
    "POST",
    { version: saved.version },
  );
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { activity: ManagedActivity }).activity;
}

async function createTimedDraw() {
  const { rewardType: _rewardType, ...base } = emptyActivityInput();
  const response = await request("/api/activities", owner, "POST", {
    requestId: crypto.randomUUID(),
    activity: {
      ...base,
      title: "发现开奖",
      passwords: ["drawkey1"],
      forceDedicated: false,
      rewardType: "ldc",
      merchantId: ownerMerchantId,
      allocation: "random",
      money: {
        mode: "timed_draw",
        algorithm: "double_mean_v1",
        totalAmount: "1.00",
        count: 2,
        participantLimit: null,
        countdownSeconds: 600,
        distributeFullPool: true,
      },
    },
  });
  expect(response.status).toBe(200);
  const saved = ((await response.json()) as { activity: ManagedActivity })
    .activity;
  const opened = await request(
    `/api/me/activities/${saved.id}/open`,
    owner,
    "POST",
    { version: saved.version },
  );
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { activity: ManagedActivity }).activity;
}

async function seedLegacyPassword(
  activityId: string,
  password: string,
  position: number,
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO activity_passwords
    (id, activity_id, digest, ciphertext, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      activityId,
      await digestPassword(password, bindings.PASSWORD_DIGEST_KEY),
      await encryptString(
        password,
        bindings,
        passwordAssociatedData(activityId, id),
      ),
      position,
      Date.now(),
    )
    .run();
  return id;
}

function submit(
  password = "correct123",
  submissionId = crypto.randomUUID(),
  user = alice,
) {
  return request("/api/redemptions", user, "POST", { password, submissionId });
}

function discover(
  password = "correct123",
  submissionId = crypto.randomUUID(),
  user = alice,
) {
  return request("/api/redemptions/discover", user, "POST", {
    password,
    submissionId,
  });
}

async function redeem(
  password = "correct123",
  submissionId = crypto.randomUUID(),
  user = alice,
) {
  await advanceAttemptCooldown(env.DB, user.id, submissionId);
  const response = await submit(password, submissionId, user);
  expect(response.status).toBe(200);
  const result = (await response.json()) as GlobalRedemptionResult;
  delete result.attemptCooldown;
  if (result.claimResult) delete result.claimResult.attemptCooldown;
  return result;
}

async function claim(
  id: string,
  password = "correct123",
  user = alice,
  submissionId = crypto.randomUUID(),
) {
  await advanceAttemptCooldown(env.DB, user.id, submissionId);
  return request(`/api/activities/${id}/claim`, user, "POST", {
    password,
    submissionId,
  });
}

async function count(table: string) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return row?.count;
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
    env.DB.prepare("DELETE FROM activity_registrations"),
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
  const ownerMerchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `discovery_${crypto.randomUUID().replaceAll("-", "")}`,
    label: "本地模拟",
    secret: "virtual-only-secret",
  });
  ownerMerchantId = ownerMerchant.id;
  ownerMerchantClientId = ownerMerchant.clientId;
});

describe("persistent global redemption", () => {
  it("rejects client identity fields before persisting a global match or allocating a reward", async () => {
    await create();
    const payload = {
      password: "correct123",
      submissionId: crypto.randomUUID(),
    };
    for (const extra of [
      { userId: alice.id },
      { userId: bob.id },
      { authorId: owner.id },
      { unexpected: "PRIVATE-EXTRA-FIELD" },
    ]) {
      const response = await request("/api/redemptions", alice, "POST", {
        ...payload,
        ...extra,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const error = await response.json();
      expect(error).toMatchObject({
        error: { code: "INVALID_ACTIVITY", issues: expect.any(Array) },
      });
      expect(JSON.stringify(error)).not.toContain("PRIVATE-EXTRA-FIELD");
    }
    expect(await count("global_redemptions")).toBe(0);
    expect(await count("redemption_submissions")).toBe(0);
    expect(await count("claims")).toBe(0);
    expect(await count("attempt_events")).toBe(0);
  });

  it("rejects a global coordinator whose object identity belongs to another account", async () => {
    const coordinator = env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName(`global-redemption:${bob.id}`),
    );
    for (const [operation, input] of [
      ["submit", { password: "missing123", submissionId: crypto.randomUUID() }],
      [
        "discover",
        { password: "missing123", submissionId: crypto.randomUUID() },
      ],
      ["refresh", { id: crypto.randomUUID() }],
    ] as const) {
      const response = await coordinator.fetch(
        `https://activity.internal/internal/redemptions/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: alice.id, ...input }),
        },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_OBJECT" },
      });
    }
    expect(await count("global_redemptions")).toBe(0);
    expect(await count("redemption_submissions")).toBe(0);
    expect(await count("claims")).toBe(0);
  });

  it("discovers a single target without creating claim, registration, or attempt facts", async () => {
    const activity = await create();
    const submissionId = crypto.randomUUID();
    const response = await discover("correct123", submissionId);
    expect(response.status).toBe(200);
    const found = (await response.json()) as GlobalRedemptionResult;
    expect(found).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
    });
    expect(found.claimResult).toBeUndefined();
    expect(found.items.map((item) => item.id)).toEqual([activity.id]);
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("redemption_submissions")).toBe(0);
    expect(await count("attempt_events")).toBe(0);
    expect(await count("claims")).toBe(0);

    const claimed = await claim(activity.id, "correct123", alice, submissionId);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({
      result: "claimed",
      claim: { activity: { id: activity.id } },
    });
    expect(await count("redemption_submissions")).toBe(1);
    expect(await count("claims")).toBe(1);
  });

  it("discovers a timed draw target without registering or recording attempts", async () => {
    const activity = await createTimedDraw();
    const submissionId = crypto.randomUUID();
    const response = await discover("drawkey1", submissionId);
    expect(response.status).toBe(200);
    const found = (await response.json()) as GlobalRedemptionResult;
    expect(found).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
    });
    expect(found.claimResult).toBeUndefined();
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("redemption_submissions")).toBe(0);
    expect(await count("attempt_events")).toBe(0);
    expect(await count("activity_registrations")).toBe(0);
    expect(await count("claims")).toBe(0);

    const registered = await claim(
      activity.id,
      "drawkey1",
      alice,
      submissionId,
    );
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ result: "registered" });
    expect(await count("redemption_submissions")).toBe(1);
    expect(await count("activity_registrations")).toBe(1);
    expect(await count("claims")).toBe(0);
  });

  it("legacy global single-result timed draw uses the persisted claim submission for registration recovery", async () => {
    const activity = await createTimedDraw();
    const submissionId = crypto.randomUUID();
    const first = await redeem("drawkey1", submissionId);
    expect(first).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
      claimResult: { result: "registered" },
    });
    expect(await count("activity_registrations")).toBe(1);

    const replay = await redeem("drawkey1", submissionId);
    expect(replay).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
      claimResult: { result: "registered" },
    });
    expect(await count("activity_registrations")).toBe(1);

    const already = await redeem("drawkey1", crypto.randomUUID());
    expect(already).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
      claimResult: { result: "already_registered" },
    });
    expect(await count("activity_registrations")).toBe(1);
  });

  it("retains a persisted single target when a later accepted attempt invalidates its continuation and imposes cooldown", async () => {
    const original = await create();
    const key = crypto.randomUUID();
    expect((await discover("correct123", key)).status).toBe(200);
    await advanceAttemptCooldown(env.DB, alice.id);
    expect((await claim(original.id, "wrong123")).status).toBe(200);
    const limited = await submit("correct123", key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const snapshot = await env.DB.prepare(
      "SELECT id,candidate_ids,claim_submission_id FROM global_redemptions WHERE user_id=? AND submission_id=?",
    )
      .bind(alice.id, key)
      .first<{
        id: string;
        candidate_ids: string;
        claim_submission_id: string;
      }>();
    if (!snapshot)
      throw new Error(
        "Expected the durable candidate snapshot before the newer attempt",
      );
    expect(JSON.parse(snapshot.candidate_ids)).toEqual([original.id]);
    expect(await count("claims")).toBe(0);
    const later = await create();
    const refreshed = (await (
      await request(`/api/redemptions/${snapshot.id}`, alice)
    ).json()) as GlobalRedemptionResult;
    expect(refreshed).toMatchObject({
      result: "single",
      selectedActivityId: original.id,
    });
    expect(refreshed.items.map((item) => item.id)).toEqual([original.id]);
    expect(refreshed.claimResult).toBeUndefined();
    expect(await count("claims")).toBe(0);
    await advanceAttemptCooldown(env.DB, alice.id);
    const retried = await redeem("correct123", key);
    expect(retried).toMatchObject({
      id: snapshot.id,
      result: "single",
      selectedActivityId: original.id,
      claimResult: {
        result: "claimed",
        claim: { activity: { id: original.id } },
      },
    });
    expect(retried.items.map((item) => item.id)).toEqual([original.id]);
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("claims")).toBe(1);
    expect(
      await env.DB.prepare("SELECT claimed_count FROM activities WHERE id=?")
        .bind(later.id)
        .first(),
    ).toEqual({ claimed_count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT claim_submission_id FROM global_redemptions WHERE id=?",
      )
        .bind(snapshot.id)
        .first(),
    ).toEqual({ claim_submission_id: snapshot.claim_submission_id });
  });

  it("keeps zero matches stable across retries and binds the key to its password", async () => {
    const key = crypto.randomUUID();
    const first = await redeem("correct123", key);
    expect(first).toMatchObject({
      result: "none",
      items: [],
      nextCursor: null,
    });
    await create();
    expect(await redeem("correct123", key)).toEqual(first);
    expect((await submit("different123", key)).status).toBe(409);
    expect(await count("claims")).toBe(0);
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("attempt_events")).toBe(0);
  });

  it("single match claims once through ActivityDO and never switches to a newer candidate", async () => {
    const activity = await create();
    const key = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => redeem("  correct123  ", key)),
    );
    expect(new Set(responses.map((r) => r.id)).size).toBe(1);
    for (const result of responses)
      expect(result).toMatchObject({
        result: "single",
        claimResult: {
          result: "claimed",
          claim: { activity: { id: activity.id }, rewardType: "ldc" },
        },
      });
    await create();
    expect(
      (await redeem("correct123", key)).items.map((item) => item.id),
    ).toEqual([activity.id]);
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("claims")).toBe(1);
    // The claim counts in that 红包's 尝试统计, as every 口令红包 does.
    expect(await count("attempt_events")).toBe(1);
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, activity.id)
      .run();
    const refreshed = (await (
      await request(`/api/redemptions/${responses[0]?.id}`, alice)
    ).json()) as GlobalRedemptionResult;
    expect(refreshed).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
      items: [],
      claimResult: { result: "claimed" },
    });
    expect(await count("claims")).toBe(1);
  });

  it("includes ended and already claimed matches and never allocates while listing or refreshing", async () => {
    const active = await create({ title: "进行中" });
    const ended = await create({ title: "已结束" });
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, ended.id)
      .run();
    await claim(active.id);
    const first = await redeem();
    expect(first.result).toBe("multiple");
    expect(first.items.map((item) => item.id)).toEqual([ended.id, active.id]);
    expect(
      first.items.find((item) => item.id === active.id)?.myClaim,
    ).toBeTruthy();
    expect(first.items.find((item) => item.id === ended.id)?.status).toBe(
      "ended",
    );
    expect(await count("claims")).toBe(1);
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, ended.id)
      .run();
    const refreshed = (await (
      await request(`/api/redemptions/${first.id}`, alice)
    ).json()) as GlobalRedemptionResult;
    expect(refreshed.result).toBe("multiple");
    expect(refreshed.items.map((item) => item.id)).toEqual([active.id]);
    expect(refreshed.claimResult).toBeUndefined();
    expect(await count("claims")).toBe(1);
    expect((await request(`/api/redemptions/${first.id}`, bob)).status).toBe(
      404,
    );
    expect((await request(`/api/redemptions/${first.id}`)).status).toBe(401);
  });

  it("filters dedicated, draft and time-derived archived activities, independently of square and topic", async () => {
    const first = await create();
    const second = await create();
    await create({ forceDedicated: true, joinSquare: true });
    await create({}, false);
    const archived = await create();
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, archived.id)
      .run();
    const result = await redeem();
    expect(result.result).toBe("multiple");
    expect(new Set(result.items.map((item) => item.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(await count("claims")).toBe(0);
    await claim(first.id);
    await claim(second.id);
    expect(await count("claims")).toBe(2);
  });

  it("shows all-ended lists and a single ended result without redirecting to another activity", async () => {
    const first = await create();
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, first.id)
      .run();
    expect(await redeem()).toMatchObject({
      result: "single",
      claimResult: { result: "ended" },
    });
    const second = await create();
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, second.id)
      .run();
    const result = await redeem();
    expect(result.result).toBe("multiple");
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.status === "ended")).toBe(true);
    expect(await count("claims")).toBe(0);
  });

  it("enforces a persistent atomic home cooldown including misses; saved replays remain usable and rejection persists no attempt", async () => {
    const firstKey = crypto.randomUUID();
    await redeem("missing123", firstKey);
    const attempts = await Promise.all(
      Array.from({ length: 15 }, () => submit("missing123")),
    );
    expect(attempts.filter((response) => response.status === 200)).toHaveLength(
      0,
    );
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(
      15,
    );
    for (const response of attempts.filter((item) => item.status === 429)) {
      const retryAfter = response.headers.get("Retry-After");
      expect(retryAfter).toMatch(/^[1-9][0-9]*$/);
      expect(Number(retryAfter)).toBeLessThanOrEqual(5);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: { code: "GLOBAL_REDEMPTION_RATE_LIMITED" },
      });
    }
    expect(await count("global_redemptions")).toBe(1);
    expect((await submit("missing123", firstKey)).status).toBe(200);
    expect(await count("global_redemptions")).toBe(1);
    expect(await count("redemption_submissions")).toBe(0);
    expect(await count("claims")).toBe(0);
    await advanceAttemptCooldown(env.DB, alice.id);
    const next = await Promise.all(
      Array.from({ length: 15 }, () => submit("missing123")),
    );
    expect(next.filter((response) => response.status === 200)).toHaveLength(1);
    expect(next.filter((response) => response.status === 429)).toHaveLength(14);
    expect(await count("global_redemptions")).toBe(2);
    expect(await count("attempt_events")).toBe(0);
  });

  it("replays an existing claim for a new single-match submission without allocating another inventory item", async () => {
    const activity = await create();
    const original = await redeem();
    expect(original.claimResult?.result).toBe("claimed");
    if (!original.claimResult || !("claim" in original.claimResult))
      throw new Error("Expected the original claim");
    const claimId = original.claimResult.claim.id;
    const key = crypto.randomUUID();
    const alreadyClaimed = await redeem("correct123", key);
    expect(alreadyClaimed).toMatchObject({
      result: "single",
      selectedActivityId: activity.id,
      claimResult: {
        result: "already_claimed",
        claim: { id: claimId, rewardType: "ldc" },
      },
    });
    expect(await redeem("correct123", key)).toEqual(alreadyClaimed);
    expect(await count("claims")).toBe(1);
    expect(await count("global_redemptions")).toBe(2);
    expect(
      await env.DB.prepare("SELECT claimed_count FROM activities WHERE id=?")
        .bind(activity.id)
        .first("claimed_count"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT user_id FROM claims WHERE id=?")
        .bind(claimId)
        .first("user_id"),
    ).toBe(alice.id);
    expect(await count("attempt_events")).toBe(1);
  });

  it("paginates the original candidate set and reuses the public card whitelist", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 22; index += 1)
      ids.push((await create({ quantityVisibility: "fuzzy" })).id);
    const first = await redeem();
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    await create();
    const second = (await (
      await request(
        `/api/redemptions/${first.id}?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        alice,
      )
    ).json()) as GlobalRedemptionResult;
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)),
    ).toEqual(new Set(ids));
    const encoded = JSON.stringify(first.items);
    for (const hidden of [
      "PRIVATE",
      "BEFORE-INFO",
      "AFTER-END",
      "correct123",
      "totalCount",
      "claimedCount",
      "remaining",
    ])
      expect(encoded).not.toContain(hidden);
    expect(first.items.every((item) => item.quantity.mode === "fuzzy")).toBe(
      true,
    );
    expect(await count("claims")).toBe(0);
  });
});

describe("square and topic discovery", () => {
  it("returns public author avatars in discovery cards without exposing contact fields", async () => {
    await storePrivateProfile(owner, "owner");
    const activity = await create({
      joinSquare: true,
      topicUrl: "https://linux.do/t/example/12345/8",
    });
    const square = (await (
      await request("/api/discovery/activities")
    ).json()) as DiscoveryList;
    const topic = (await (
      await request("/api/topics/12345/activities?postNumber=8")
    ).json()) as DiscoveryList;
    for (const list of [square, topic]) {
      expect(list.items[0]).toMatchObject({
        id: activity.id,
        author: {
          username: "owner",
          avatarUrl: "https://cdn.example.com/discovery/owner.png",
        },
      });
      expect(JSON.stringify(list)).not.toMatch(
        /DISCOVERY-EMAIL-CIPHERTEXT|email_ciphertext|emailCiphertext|email/,
      );
    }
  });

  it("loads twenty claimed LDC cards with bounded queries and never joins another account's claims", async () => {
    const base = emptyActivityInput();
    const expected = new Map<
      string,
      { id: string; paymentState: PaymentState }
    >();
    const states: PaymentState[] = ["pending", "confirmed", "reconciling"];
    for (let index = 0; index < 20; index++) {
      const created = await request("/api/activities", owner, "POST", {
        requestId: crypto.randomUUID(),
        activity: {
          ...base,
          title: `LDC 卡片 ${index}`,
          rewardType: "ldc",
          merchantId: ownerMerchantId,
          money: { mode: "fixed", totalAmount: "3.00", count: 3 },
          passwords: ["correct123"],
          topicUrl: "https://linux.do/t/123456",
          joinSquare: true,
          quantityVisibility: "fuzzy",
          beforeInfo: "PRIVATE-CARD-BEFORE",
          afterClaimInfo: "PRIVATE-AFTER-CLAIM",
        },
      });
      expect(created.status).toBe(200);
      const activity = ((await created.json()) as { activity: ManagedActivity })
        .activity;
      expect(
        (
          await request(
            `/api/me/activities/${activity.id}/open`,
            owner,
            "POST",
            {
              version: activity.version,
            },
          )
        ).status,
      ).toBe(200);
      const paymentState = states[index % states.length] ?? "pending";
      // Seed read-side fixtures without waking the asynchronous payment queue.
      for (const [position, user] of (index === 0
        ? [alice, bob]
        : [alice]
      ).entries()) {
        const claimId = crypto.randomUUID();
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO claims (id,activity_id,user_id,inventory_id,password_id,claimed_at)
            SELECT ?,?,?,i.id,p.id,? FROM reward_inventory i JOIN activity_passwords p ON p.activity_id=i.activity_id
            WHERE i.activity_id=? AND i.position=? AND p.position=0`).bind(
            claimId,
            activity.id,
            user.id,
            now,
            activity.id,
            position,
          ),
          env.DB.prepare(`INSERT INTO payment_tasks
            (id,claim_id,merchant_id,client_id,business_no,recipient_id,amount_minor,mode,status,next_run_at,created_at,updated_at)
            VALUES (?,?,?,?,?,? ,100,'simulation',?,?,?,?)`).bind(
            crypto.randomUUID(),
            claimId,
            ownerMerchantId,
            ownerMerchantClientId,
            `query_${claimId}`,
            `simulation:${user.id}`,
            paymentState,
            now + 3600000,
            now,
            now,
          ),
          env.DB.prepare(
            "UPDATE activities SET claimed_count=claimed_count+1 WHERE id=?",
          ).bind(activity.id),
        ]);
        if (user === alice)
          expected.set(activity.id, { id: claimId, paymentState });
      }
    }

    const querySpy = vi.spyOn(bindings.DB, "prepare");
    try {
      for (const path of [
        "/api/discovery/activities",
        "/api/topics/123456/activities",
      ]) {
        querySpy.mockClear();
        const response = await request(path, alice);
        expect(response.status).toBe(200);
        const page = (await response.json()) as DiscoveryList;
        expect(page.items).toHaveLength(20);
        expect(page.nextCursor).toBeNull();
        expect(querySpy.mock.calls.length).toBeLessThanOrEqual(3);
        for (const item of page.items) {
          expect(item.author.id).toBe(owner.id);
          expect(item.myClaim).toEqual(expected.get(item.id));
          expect(item.quantity).toMatchObject({ mode: "fuzzy" });
        }
        const serialized = JSON.stringify(page);
        for (const hidden of [
          "PRIVATE",
          "correct123",
          "amountMinor",
          "totalCount",
          "claimedCount",
          "ciphertext",
        ])
          expect(serialized).not.toContain(hidden);
      }
      querySpy.mockClear();
      const bobPage = (await (
        await request("/api/discovery/activities", bob)
      ).json()) as DiscoveryList;
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(3);
      expect(bobPage.items.filter((item) => item.myClaim)).toHaveLength(1);
      for (const item of bobPage.items)
        expect(item.myClaim?.id).not.toBe(expected.get(item.id)?.id);
      querySpy.mockClear();
      const publicPage = (await (
        await request("/api/discovery/activities")
      ).json()) as DiscoveryList;
      // One page query and one full-filter count; neither grows with card count.
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(publicPage.total).toBe(20);
      expect(publicPage.items).toHaveLength(20);
      expect(publicPage.items.every((item) => item.myClaim === null)).toBe(
        true,
      );
    } finally {
      querySpy.mockRestore();
    }
  });

  it("indexes an exact reply independently of square, includes other authors, and normalizes IDs", async () => {
    const listed = await create({
      topicUrl: "https://linux.do/t/example/12345/8?u=someone",
      joinSquare: true,
    });
    const linked = await create(
      { topicUrl: "https://linux.do/t/12345" },
      true,
      bob,
    );
    await create(
      { topicUrl: "https://linux.do/t/12345", joinSquare: true },
      false,
    );
    const archived = await create({
      topicUrl: "https://linux.do/t/12345",
      joinSquare: true,
    });
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, archived.id)
      .run();
    const topic = (await (
      await request("/api/topics/00012345/activities")
    ).json()) as DiscoveryList;
    expect(new Set(topic.items.map((item) => item.id))).toEqual(
      new Set([linked.id]),
    );
    expect(topic.items.find((item) => item.id === linked.id)?.author.id).toBe(
      bob.id,
    );
    const reply = (await (
      await request("/api/topics/12345/activities?postNumber=8")
    ).json()) as DiscoveryList;
    expect(reply.items.map((item) => item.id)).toEqual([listed.id]);
    expect(reply.items[0]?.topicUrl).toBe("https://linux.do/t/12345/8");
    const square = (await (
      await request("/api/discovery/activities?status=all")
    ).json()) as DiscoveryList;
    expect(square.items.map((item) => item.id)).toEqual([listed.id]);
    expect((await request("/api/topics/not-a-topic/activities")).status).toBe(
      400,
    );
  });

  it("rejects invalid reply numbers and binds pagination cursors to both topic and reply", async () => {
    for (let index = 0; index < 21; index++)
      await create({ topicUrl: "https://linux.do/t/12345/8" });
    const firstResponse = await request(
      "/api/topics/12345/activities?postNumber=8",
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as DiscoveryList;
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = (await (
      await request(
        `/api/topics/12345/activities?postNumber=8&cursor=${cursor}`,
      )
    ).json()) as DiscoveryList;
    expect(second.items).toHaveLength(1);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(21);
    expect(
      (await request(`/api/topics/12345/activities?cursor=${cursor}`)).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/topics/54321/activities?postNumber=8&cursor=${cursor}`,
        )
      ).status,
    ).toBe(400);
    for (const value of [
      "0",
      "-1",
      "1.5",
      "abc",
      "1e2",
      "9007199254740992",
      "",
      "10000000000000000",
    ])
      expect(
        (
          await request(
            `/api/topics/12345/activities?postNumber=${encodeURIComponent(value)}`,
          )
        ).status,
      ).toBe(400);
    expect(
      (await request("/api/topics/12345/activities?postNumber=0008")).status,
    ).toBe(200);
  });

  it("moves an opened association between exact reply indices without changing square membership or opening time", async () => {
    const original = await create({
      topicUrl: "https://linux.do/t/12345/8",
      joinSquare: true,
    });
    const response = await request(
      `/api/me/activities/${original.id}`,
      owner,
      "PATCH",
      {
        version: original.version,
        activity: {
          ...original.config,
          topicUrl: "https://linux.do/t/new-topic/54321/2?u=owner",
        },
      },
    );
    expect(response.status).toBe(200);
    const updated = ((await response.json()) as { activity: ManagedActivity })
      .activity;
    expect(updated.openedAt).toBe(original.openedAt);
    expect(updated.config.joinSquare).toBe(true);
    const oldReply = (await (
      await request("/api/topics/12345/activities?postNumber=8")
    ).json()) as DiscoveryList;
    expect(oldReply.items).toEqual([]);
    const newReply = (await (
      await request("/api/topics/54321/activities?postNumber=2")
    ).json()) as DiscoveryList;
    expect(newReply.items.map((item) => item.id)).toEqual([original.id]);
    expect(newReply.items[0]?.topicUrl).toBe("https://linux.do/t/54321/2");
    const firstReply = (await (
      await request("/api/topics/54321/activities")
    ).json()) as DiscoveryList;
    expect(firstReply.items).toEqual([]);
    const square = (await (
      await request("/api/discovery/activities")
    ).json()) as DiscoveryList;
    expect(square.items.map((item) => item.id)).toEqual([original.id]);
    const cleared = await request(
      `/api/me/activities/${original.id}`,
      owner,
      "PATCH",
      {
        version: updated.version,
        activity: { ...updated.config, topicUrl: "" },
      },
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { activity: ManagedActivity }).activity,
    ).toMatchObject({
      openedAt: original.openedAt,
      topicUrl: null,
      config: { joinSquare: true },
    });
    expect(
      (
        (await (
          await request("/api/topics/54321/activities?postNumber=2")
        ).json()) as DiscoveryList
      ).items,
    ).toEqual([]);
    expect(
      (
        (await (
          await request("/api/discovery/activities")
        ).json()) as DiscoveryList
      ).items.map((item) => item.id),
    ).toEqual([original.id]);
  });

  it("keeps deleted drafts out of all discovery and global matching responses", async () => {
    const draft = await create(
      { topicUrl: "https://linux.do/t/12345/8", joinSquare: true },
      false,
    );
    const deletion = await request(
      `/api/me/activities/${draft.id}`,
      owner,
      "DELETE",
      { version: draft.version },
    );
    expect(deletion.status).toBe(200);
    for (const path of [
      "/api/discovery/activities",
      "/api/topics/12345/activities?postNumber=8",
    ])
      expect(
        ((await (await request(path)).json()) as DiscoveryList).items,
      ).toEqual([]);
    expect(await redeem()).toMatchObject({ result: "none", items: [] });
    expect(
      (await request(`/api/me/activities/${draft.id}/statistics`, owner))
        .status,
    ).toBe(404);
  });

  it("lets a draft leave the square again; only an opened 红包 keeps it", async () => {
    const draft = await create({ joinSquare: true }, false);
    const left = await request(
      `/api/me/activities/${draft.id}`,
      owner,
      "PATCH",
      {
        version: draft.version,
        activity: { ...draft.config, joinSquare: false },
      },
    );
    expect(left.status).toBe(200);
    expect(
      ((await left.json()) as { activity: ManagedActivity }).activity.config
        .joinSquare,
    ).toBe(false);
  });

  it("keeps square independent from topic, persists the irreversible switch, and filters active and ended", async () => {
    const activity = await create({ topicUrl: "https://linux.do/t/12345" });
    const changed = await request(
      `/api/me/activities/${activity.id}`,
      owner,
      "PATCH",
      {
        version: activity.version,
        activity: { ...activity.config, joinSquare: true },
      },
    );
    expect(changed.status).toBe(200);
    const joined = ((await changed.json()) as { activity: ManagedActivity })
      .activity;
    expect(joined.config.joinSquare).toBe(true);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: joined.version,
          activity: { ...joined.config, joinSquare: false },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        (await (
          await request("/api/discovery/activities?status=active")
        ).json()) as DiscoveryList
      ).items,
    ).toHaveLength(1);
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - 1000, activity.id)
      .run();
    expect(
      (
        (await (
          await request("/api/discovery/activities?status=active")
        ).json()) as DiscoveryList
      ).items,
    ).toHaveLength(0);
    expect(
      (
        (await (
          await request("/api/discovery/activities?status=ended")
        ).json()) as DiscoveryList
      ).items,
    ).toHaveLength(1);
    const noTopic = await request("/api/activities", owner, "POST", {
      requestId: crypto.randomUUID(),
      activity: { ...activity.config, joinSquare: true, topicUrl: "" },
    });
    expect(noTopic.status).toBe(200);
    const independent = (
      (await noTopic.json()) as { activity: ManagedActivity }
    ).activity;
    expect(independent.config.joinSquare).toBe(true);
    expect(independent.topicUrl).toBeNull();
  });
  it("leaves out of the square the 红包 ended early or stopped, in its lists and its counts", async () => {
    const titles = ["领完了", "提前结束", "停用了", "还在领"];
    const [exhausted, manual, stopped] = await Promise.all(
      titles.map((title) =>
        create({ title, joinSquare: true, passwords: [`${title}123`] }),
      ),
    );
    const now = Date.now();
    const end = (id: string, reason: string) =>
      env.DB.prepare(
        "UPDATE activities SET ended_at = ?, end_reason = ? WHERE id = ?",
      )
        .bind(now - 1000, reason, id)
        .run();
    await end(exhausted?.id ?? "", "exhausted");
    await end(manual?.id ?? "", "manual");
    await end(stopped?.id ?? "", "stopped");
    const read = async (status: string) =>
      (await (
        await request(`/api/discovery/activities?status=${status}`)
      ).json()) as DiscoveryList;
    const all = await read("all");
    expect(all.items.map((item) => item.title).sort()).toEqual(
      ["还在领", "领完了"].sort(),
    );
    expect(all.total).toBe(2);
    const ended = await read("ended");
    expect(ended.items.map((item) => item.title)).toEqual(["领完了"]);
    expect(ended.total).toBe(1);
    // Still there by its link.
    expect((await request(`/api/activities/${manual?.id}`)).status).toBe(200);
  });
});

describe("author attempt statistics", () => {
  it("does not expose attempt statistics for an unopened dedicated draft", async () => {
    const draft = await create(
      { forceDedicated: true, joinSquare: true },
      false,
    );
    expect(
      (await request(`/api/me/activities/${draft.id}/statistics`, owner))
        .status,
    ).toBe(404);
  });
  it("preserves historical matched results after adding a password and counts unique accounts and successful claims", async () => {
    const activity = await create({ forceDedicated: true, joinSquare: true });
    const key = crypto.randomUUID();
    for (let index = 0; index < 3; index += 1)
      expect((await claim(activity.id, "later123", alice)).status).toBe(200);
    await claim(activity.id, "later123", bob, key);
    await claim(activity.id, "later123", bob, key);
    await seedLegacyPassword(activity.id, "later123", 1);
    await claim(activity.id, "later123", bob);
    await claim(activity.id, "correct123", alice);
    const response = await request(
      `/api/me/activities/${activity.id}/statistics`,
      owner,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const stats = (await response.json()) as ActivityStatistics;
    expect(stats.items.map((item) => item.attempts)).toEqual([5, 1]);
    expect(stats).toMatchObject({
      totalAttempts: 6,
      uniqueUsers: 2,
      matchedAttempts: 2,
      successfulClaims: 2,
    });
    expect(stats.items.find((item) => item.password === "later123")).toEqual({
      password: "later123",
      attempts: 5,
      uniqueUsers: 2,
      matchedAttempts: 1,
      matchedUsers: 1,
      unmatchedAttempts: 4,
      successfulClaims: 1,
    });
    expect(stats.validPasswords).toEqual([
      { password: "correct123", successfulClaims: 1, registrations: 0 },
      { password: "later123", successfulClaims: 1, registrations: 0 },
    ]);
    await env.DB.prepare("UPDATE activities SET archived_at = ? WHERE id = ?")
      .bind(Date.now(), activity.id)
      .run();
    expect(
      (await request(`/api/me/activities/${activity.id}/statistics`, owner))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/me/activities/${activity.id}/statistics`, bob))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/me/activities/${activity.id}/statistics`)).status,
    ).toBe(401);
    // Every opened 口令红包 has them, page-only or not.
    const ordinary = await create();
    expect(
      (await request(`/api/me/activities/${ordinary.id}/statistics`, owner))
        .status,
    ).toBe(200);
  });

  it("paginates distinct attempt values without returning per-user trajectories", async () => {
    const activity = await create({ forceDedicated: true, joinSquare: true });
    const people = [alice, bob];
    for (let index = 0; index < 21; index += 1) {
      const person = people[index % people.length];
      if (!person) throw new Error("Missing fixture actor");
      expect(
        (
          await claim(
            activity.id,
            `wrong${index.toString().padStart(3, "0")}`,
            person,
          )
        ).status,
      ).toBe(200);
    }
    // Unequal counts must sort ahead of the stable digest order across pages.
    await claim(activity.id, "wrong020", alice);
    await claim(activity.id, "wrong020", bob);
    await claim(activity.id, "wrong019", alice);
    const first = (await (
      await request(`/api/me/activities/${activity.id}/statistics`, owner)
    ).json()) as ActivityStatistics;
    expect(first.items).toHaveLength(20);
    expect(
      first.items.slice(0, 2).map((item) => [item.password, item.attempts]),
    ).toEqual([
      ["wrong020", 3],
      ["wrong019", 2],
    ]);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await request(
        `/api/me/activities/${activity.id}/statistics?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        owner,
      )
    ).json()) as ActivityStatistics;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.password))
        .size,
    ).toBe(21);
    expect(first).toMatchObject({
      totalAttempts: 24,
      uniqueUsers: 2,
      successfulClaims: 0,
    });
    expect(JSON.stringify(first.items)).not.toContain("userId");
    expect(JSON.stringify(first.items)).not.toContain("validatedAt");
  });
});
