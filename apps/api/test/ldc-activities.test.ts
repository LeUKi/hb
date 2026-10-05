import { env } from "cloudflare:test";
import {
  type ActivityInput,
  boundedMeanLimits,
  type ClaimDetail,
  type ClaimResult,
  emptyActivityInput,
  formatAmount,
  type GlobalRedemptionResult,
  type LdcActivityInput,
  type ManagedActivity,
  type Merchant,
  type PublicRecipientList,
  type RandomLdcMoney,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { runMerchantCycle } from "../src/payments/scheduler";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let bob: Actor;
let merchant: Merchant;
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
function config(overrides: Partial<LdcActivityInput> = {}): LdcActivityInput {
  const {
    rewards: _rewards,
    rewardType: _type,
    ...base
  } = emptyActivityInput();
  return {
    ...base,
    title: "LDC 奖励",
    passwords: ["correct123"],
    rewardType: "ldc",
    merchantId: merchant.id,
    money: { mode: "fixed", totalAmount: "10.00", count: 2 },
    afterClaimInfo: "已解锁领取后说明",
    ...overrides,
  };
}
async function create(activity = config(), open = true) {
  const response = await request("/api/activities", owner, "POST", {
    requestId: crypto.randomUUID(),
    activity,
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
function submit(id: string, user = alice, submissionId = crypto.randomUUID()) {
  return request(`/api/activities/${id}/claim`, user, "POST", {
    submissionId,
    password: "correct123",
  });
}
async function claim(
  id: string,
  user = alice,
  submissionId = crypto.randomUUID(),
) {
  const response = await submit(id, user, submissionId);
  expect(response.status).toBe(200);
  return (await response.json()) as ClaimResult;
}
async function counts() {
  return await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM claims) AS claims,
    (SELECT COUNT(*) FROM payment_tasks) AS payments, (SELECT COUNT(*) FROM payment_outbox) AS outbox,
    (SELECT COALESCE(SUM(claimed_count),0) FROM activities) AS assigned`).first();
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
  merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: "test_app",
    label: "模拟商户",
    secret: "fake-secret",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("LDC activity allocation and durable payment responsibility", () => {
  it("pregenerates exact integer amounts, creates one task and outbox atomically, and replays the same reward", async () => {
    const activity = await create();
    const inventory = await env.DB.prepare(
      "SELECT kind, ciphertext, amount_minor AS amount FROM reward_inventory ORDER BY position",
    ).all();
    expect(inventory.results).toEqual([
      { kind: "ldc", ciphertext: null, amount: 500 },
      { kind: "ldc", ciphertext: null, amount: 500 },
    ]);
    const key = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => claim(activity.id, alice, key)),
    );
    for (const response of responses)
      expect(response).toMatchObject({
        result: "claimed",
        claim: {
          rewardType: "ldc",
          amount: "5.00",
          afterClaimInfo: "已解锁领取后说明",
          payment: { mode: "simulation", status: "pending" },
        },
      });
    expect(
      new Set(
        responses.map((response) =>
          "claim" in response ? response.claim.id : "",
        ),
      ).size,
    ).toBe(1);
    expect(await counts()).toEqual({
      claims: 1,
      payments: 1,
      outbox: 1,
      assigned: 1,
    });
    const task = await env.DB.prepare(
      "SELECT client_id,recipient_id,amount_minor,mode,business_no FROM payment_tasks",
    ).first();
    expect(task).toMatchObject({
      client_id: "test_app",
      recipient_id: "simulation:alice",
      amount_minor: 500,
      mode: "simulation",
    });
    expect(await claim(activity.id)).toMatchObject({
      result: "already_claimed",
      claim: { amount: "5.00" },
    });
    expect(await counts()).toEqual({
      claims: 1,
      payments: 1,
      outbox: 1,
      assigned: 1,
    });
  });

  it("rejects author self-claim before allocation or attempts while preserving ordinary text behavior", async () => {
    const activity = await create(config({ forceDedicated: true }));
    expect((await submit(activity.id, owner)).status).toBe(403);
    expect(await counts()).toEqual({
      claims: 0,
      payments: 0,
      outbox: 0,
      assigned: 0,
    });
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM attempt_events",
    ).first();
    expect(attempts).toEqual({ count: 0 });
    const ordinary = await create();
    expect(
      (
        await request("/api/redemptions", owner, "POST", {
          submissionId: crypto.randomUUID(),
          password: "correct123",
        })
      ).status,
    ).toBe(403);
    expect((await submit(ordinary.id, alice)).status).toBe(200);
  });

  it("validates ownership and money before creating an activity", async () => {
    const foreign = await createMerchant(bindings, bob.id, {
      requestId: crypto.randomUUID(),
      clientId: "foreign_app",
      label: "其他商户",
      secret: "fake",
    });
    for (const input of [
      config({ merchantId: foreign.id }),
      config({ money: { mode: "fixed", totalAmount: "1.00", count: 3 } }),
      config({ money: { mode: "custom", amounts: ["0", "1.001"] } }),
    ]) {
      expect(
        (
          await request("/api/activities", owner, "POST", {
            requestId: crypto.randomUUID(),
            activity: input,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM activities").first(),
    ).toEqual({ count: 0 });
  });

  it("freezes merchant, type and amount pool after opening but permits presentation updates", async () => {
    const activity = await create(
      config({ money: { mode: "custom", amounts: ["1.25", "2.50"] } }),
    );
    // Existing development merchant history remains usable after the single-current migration.
    await env.DB.prepare(
      "UPDATE merchants SET usage_status='legacy' WHERE id=?",
    )
      .bind(merchant.id)
      .run();
    const other = await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: "second_app",
      label: "另一商户",
      secret: "fake",
    });
    const initial = activity.config as LdcActivityInput;
    const candidates: ActivityInput[] = [
      { ...initial, merchantId: other.id },
      { ...initial, money: { mode: "custom", amounts: ["1.26", "2.50"] } },
      {
        ...emptyActivityInput(),
        title: initial.title,
        passwords: initial.passwords,
        deadline: initial.deadline,
        rewards: [{ id: crypto.randomUUID(), text: "changed" }],
      },
    ];
    for (const input of candidates)
      expect(
        (
          await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
            version: activity.version,
            activity: input,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: activity.version,
          activity: {
            ...initial,
            beforeInfo: "新说明",
            passwords: [...initial.passwords, "second123"],
          },
        })
      ).status,
    ).toBe(200);
    expect(await claim(activity.id)).toMatchObject({
      claim: { amount: "1.25" },
    });
    expect(await claim(activity.id, bob)).toMatchObject({
      claim: { amount: "2.50" },
    });
  });

  it("rolls allocation back when payment task insertion fails and recovers the same submission", async () => {
    const activity = await create(config({ forceDedicated: true }));
    await env.DB.prepare(
      "CREATE TRIGGER fail_payment BEFORE INSERT ON payment_tasks BEGIN SELECT RAISE(ABORT, 'injected payment failure'); END",
    ).run();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = crypto.randomUUID();
    try {
      expect((await submit(activity.id, alice, key)).status).toBe(500);
      expect(await counts()).toEqual({
        claims: 0,
        payments: 0,
        outbox: 0,
        assigned: 0,
      });
      const event = await env.DB.prepare(
        "SELECT matched,claim_id FROM attempt_events",
      ).first();
      expect(event).toEqual({ matched: 1, claim_id: null });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_payment").run();
    }
    expect(await claim(activity.id, alice, key)).toMatchObject({
      result: "claimed",
      claim: { amount: "5.00" },
    });
    expect(await counts()).toEqual({
      claims: 1,
      payments: 1,
      outbox: 1,
      assigned: 1,
    });
  });

  it("rolls every allocation effect back when outbox creation fails", async () => {
    const activity = await create();
    await env.DB.prepare(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON payment_outbox BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END",
    ).run();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await submit(activity.id)).status).toBe(500);
      expect(await counts()).toEqual({
        claims: 0,
        payments: 0,
        outbox: 0,
        assigned: 0,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_outbox").run();
    }
  });

  it("shows LDC amounts with the single public-list toggle while keeping private details account-scoped", async () => {
    const activity = await create(
      config({ showRecipientList: true, showRecipientAmount: false }),
    );
    const won = await claim(activity.id);
    if (!("claim" in won)) throw new Error("Expected reward");
    const claimId = won.claim.id;
    expect((await request(`/api/me/claims/${claimId}`, bob)).status).toBe(404);
    const own = (
      (await (await request(`/api/me/claims/${claimId}`, alice)).json()) as {
        claim: ClaimDetail;
      }
    ).claim;
    expect(own).toMatchObject({ rewardType: "ldc", amount: "5.00" });
    expect(own).not.toHaveProperty("text");
    const publicList = (await (
      await request(`/api/activities/${activity.id}/recipients`)
    ).json()) as PublicRecipientList;
    expect(publicList.items).toEqual([
      {
        id: claimId,
        username: "alice",
        displayName: "alice",
        avatarUrl: null,
        claimedAt: won.claim.claimedAt,
        amount: "5.00",
      },
    ]);
    const publicDetail = await (
      await request(`/api/activities/${activity.id}`)
    ).json();
    expect(publicDetail).toMatchObject({
      activity: { rewardType: "ldc", paymentMode: "simulation" },
    });
    expect(JSON.stringify(publicDetail)).not.toContain("5.00");
    expect(JSON.stringify(publicDetail)).not.toContain("email");
    await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
      version: activity.version,
      activity: { ...activity.config, showRecipientAmount: true },
    });
    const visible = (await (
      await request(`/api/activities/${activity.id}/recipients`)
    ).json()) as PublicRecipientList;
    expect(visible.items).toEqual(publicList.items);
  });

  it("keeps LDC awards pending in matching lists and allows each same-password activity to be claimed", async () => {
    const first = await create();
    const second = await create();
    await claim(first.id);
    const result = (await (
      await request("/api/redemptions", alice, "POST", {
        submissionId: crypto.randomUUID(),
        password: "correct123",
      })
    ).json()) as GlobalRedemptionResult;
    expect(result.result).toBe("multiple");
    expect(
      result.items.find((item) => item.id === first.id)?.myClaim,
    ).toMatchObject({ paymentState: "pending" });
    expect(
      result.items.find((item) => item.id === second.id)?.myClaim,
    ).toBeNull();
    expect(await counts()).toEqual({
      claims: 1,
      payments: 1,
      outbox: 1,
      assigned: 1,
    });
    await claim(second.id);
    expect(await counts()).toEqual({
      claims: 2,
      payments: 2,
      outbox: 2,
      assigned: 2,
    });
  });

  it("gives exactly one final reward and one payment under competing accounts", async () => {
    const activity = await create(
      config({ money: { mode: "fixed", totalAmount: "0.01", count: 1 } }),
    );
    const results = await Promise.all([
      claim(activity.id, alice),
      claim(activity.id, bob),
    ]);
    expect(results.filter((item) => item.result === "claimed")).toHaveLength(1);
    expect(results.filter((item) => item.result === "ended")).toHaveLength(1);
    expect(await counts()).toEqual({
      claims: 1,
      payments: 1,
      outbox: 1,
      assigned: 1,
    });
  });
});

const randomAlgorithms = ["double_mean_v1", "bounded_mean_v1"] as const;
function randomConfig(algorithm: RandomLdcMoney["algorithm"]) {
  return config({
    allocation: "random",
    money: { mode: "random", algorithm, totalAmount: "10", count: 3 },
  });
}
async function inventory(id: string) {
  return (
    await env.DB.prepare(
      "SELECT id,position,amount_minor,created_at FROM reward_inventory WHERE activity_id=? ORDER BY position",
    )
      .bind(id)
      .all<{
        id: string;
        position: number;
        amount_minor: number;
        created_at: number;
      }>()
  ).results;
}
async function edit(saved: ManagedActivity, input: LdcActivityInput) {
  const response = await request(
    `/api/me/activities/${saved.id}`,
    owner,
    "PATCH",
    {
      version: saved.version,
      activity: input,
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { activity: ManagedActivity }).activity;
}

describe("random LDC inventory persistence and coordination", () => {
  it("rejects sequential random pools and insufficient total amounts before any write", async () => {
    const activity = randomConfig("double_mean_v1");
    for (const input of [
      { ...activity, allocation: "sequential" },
      {
        ...activity,
        money: {
          mode: "random",
          algorithm: "double_mean_v1",
          totalAmount: "0.02",
          count: 3,
        },
      },
    ])
      expect(
        (
          await request("/api/activities", owner, "POST", {
            requestId: crypto.randomUUID(),
            activity: input,
          })
        ).status,
      ).toBe(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM activities").first(),
    ).toEqual({ count: 0 });
  });

  it.each(randomAlgorithms)(
    "persists and opens 1,000 exact shares at the safe-integer amount limit: %s",
    async (algorithm) => {
      const saved = await create({
        ...randomConfig(algorithm),
        money: {
          mode: "random",
          algorithm,
          totalAmount: "90071992547409.91",
          count: 1000,
        },
      });
      const pool = await inventory(saved.id);
      expect(saved.status).toBe("active");
      expect(pool).toHaveLength(1000);
      expect(
        pool.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n),
      ).toBe(BigInt(Number.MAX_SAFE_INTEGER));
      expect(
        pool.every(
          (item) =>
            Number.isSafeInteger(item.amount_minor) && item.amount_minor > 0,
        ),
      ).toBe(true);
    },
  );

  it.each(randomAlgorithms)(
    "keeps the original pool across duplicate creation, unrelated edits and concurrent opening: %s",
    async (algorithm) => {
      const input = randomConfig(algorithm);
      const body = { requestId: crypto.randomUUID(), activity: input };
      const responses = await Promise.all([
        request("/api/activities", owner, "POST", body),
        request("/api/activities", owner, "POST", body),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const created = await Promise.all(
        responses.map(
          async (response) =>
            ((await response.json()) as { activity: ManagedActivity }).activity,
        ),
      );
      expect(created[0]?.id).toBe(created[1]?.id);
      let saved = created[0];
      if (!saved) throw new Error("Missing created activity");
      const original = await inventory(saved.id);
      expect(original).toHaveLength(3);
      expect(original.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(
        1000,
      );
      // Existing development merchant history remains usable after the single-current migration.
      await env.DB.prepare(
        "UPDATE merchants SET usage_status='legacy' WHERE id=?",
      )
        .bind(merchant.id)
        .run();
      const other = await createMerchant(bindings, owner.id, {
        requestId: crypto.randomUUID(),
        clientId: "random_other",
        label: "其他模拟商户",
        secret: "dummy",
      });
      await env.DB.prepare(
        "CREATE TRIGGER reject_random_rewrite BEFORE INSERT ON reward_inventory BEGIN SELECT RAISE(ABORT, 'unexpected inventory rewrite'); END",
      ).run();
      try {
        saved = await edit(saved, {
          ...input,
          title: "新标题",
          merchantId: other.id,
          beforeInfo: "新说明",
          passwords: [...input.passwords, "another123"],
          quantityVisibility: "fuzzy",
          deadline: {
            mode: "at",
            at: new Date(Date.now() + 7200000).toISOString(),
          },
          money: { mode: "random", algorithm, totalAmount: "10.00", count: 3 },
        });
        expect(await inventory(saved.id)).toEqual(original);
        const openedResponses = await Promise.all([
          request(`/api/me/activities/${saved.id}/open`, owner, "POST", {
            version: saved.version,
          }),
          request(`/api/me/activities/${saved.id}/open`, owner, "POST", {
            version: saved.version,
          }),
        ]);
        expect(openedResponses.map((response) => response.status)).toEqual([
          200, 200,
        ]);
        const opened = await Promise.all(
          openedResponses.map(
            async (response) =>
              ((await response.json()) as { activity: ManagedActivity })
                .activity,
          ),
        );
        expect(opened[0]).toEqual(opened[1]);
        const first = opened[0];
        if (first?.config.rewardType !== "ldc")
          throw new Error("Missing opened LDC activity");
        saved = await edit(first, {
          ...first.config,
          afterEndInfo: "结束说明",
          money: { mode: "random", algorithm, totalAmount: "10.0", count: 3 },
        });
        expect(saved.status).toBe("active");
        expect(await inventory(saved.id)).toEqual(original);
      } finally {
        await env.DB.prepare("DROP TRIGGER reject_random_rewrite").run();
      }
      const otherAlgorithm =
        algorithm === "double_mean_v1" ? "bounded_mean_v1" : "double_mean_v1";
      expect(
        (
          await request(`/api/me/activities/${saved.id}`, owner, "PATCH", {
            version: saved.version,
            activity: {
              ...saved.config,
              money: {
                mode: "random",
                algorithm: otherAlgorithm,
                totalAmount: "10",
                count: 3,
              },
            },
          })
        ).status,
      ).toBe(400);
      expect(await inventory(saved.id)).toEqual(original);
    },
  );

  it("rebuilds a draft pool when the algorithm, total or count changes", async () => {
    let saved = await create(randomConfig("double_mean_v1"), false);
    await env.DB.prepare(
      "UPDATE reward_inventory SET amount_minor=CASE position WHEN 2 THEN 998 ELSE 1 END WHERE activity_id=?",
    )
      .bind(saved.id)
      .run();
    saved = await edit(saved, randomConfig("bounded_mean_v1"));
    let pool = await inventory(saved.id);
    const limits = boundedMeanLimits(1000, 3);
    expect(
      pool.every(
        (row) =>
          row.amount_minor >= limits.min && row.amount_minor <= limits.max,
      ),
    ).toBe(true);
    saved = await edit(saved, {
      ...randomConfig("bounded_mean_v1"),
      money: {
        mode: "random",
        algorithm: "bounded_mean_v1",
        totalAmount: "20",
        count: 3,
      },
    });
    pool = await inventory(saved.id);
    expect(pool.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(2000);
    saved = await edit(saved, {
      ...randomConfig("bounded_mean_v1"),
      money: {
        mode: "random",
        algorithm: "bounded_mean_v1",
        totalAmount: "20",
        count: 4,
      },
    });
    pool = await inventory(saved.id);
    expect(pool).toHaveLength(4);
    expect(pool.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(2000);
  });

  it("rolls back random pool creation and draft replacement on a mid-inventory failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = {
      requestId: crypto.randomUUID(),
      activity: randomConfig("bounded_mean_v1"),
    };
    await env.DB.prepare(
      "CREATE TRIGGER fail_random_pool BEFORE INSERT ON reward_inventory WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT, 'random inventory failure'); END",
    ).run();
    try {
      expect(
        (await request("/api/activities", owner, "POST", body)).status,
      ).toBe(500);
      expect(
        await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM activities) AS activities,(SELECT COUNT(*) FROM activity_passwords) AS passwords,(SELECT COUNT(*) FROM reward_inventory) AS inventory",
        ).first(),
      ).toEqual({ activities: 0, passwords: 0, inventory: 0 });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_random_pool").run();
    }
    const response = await request("/api/activities", owner, "POST", body);
    expect(response.status).toBe(200);
    const saved = ((await response.json()) as { activity: ManagedActivity })
      .activity;
    const original = await inventory(saved.id);
    await env.DB.prepare(
      "CREATE TRIGGER fail_random_pool BEFORE INSERT ON reward_inventory WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT, 'random inventory failure'); END",
    ).run();
    try {
      expect(
        (
          await request(`/api/me/activities/${saved.id}`, owner, "PATCH", {
            version: saved.version,
            activity: {
              ...body.activity,
              title: "回滚标题",
              passwords: ["changed123"],
              money: { ...body.activity.money, totalAmount: "20" },
            },
          })
        ).status,
      ).toBe(500);
      expect(
        (
          (await (
            await request(`/api/me/activities/${saved.id}`, owner)
          ).json()) as { activity: ManagedActivity }
        ).activity,
      ).toEqual(saved);
      expect(await inventory(saved.id)).toEqual(original);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_random_pool").run();
    }
  });

  it.each(randomAlgorithms)(
    "does not let a stale draft update overwrite the pool during opening: %s",
    async (algorithm) => {
      const saved = await create(randomConfig(algorithm), false);
      const original = await inventory(saved.id);
      const responses = await Promise.all([
        request(`/api/me/activities/${saved.id}/open`, owner, "POST", {
          version: saved.version,
        }),
        request(`/api/me/activities/${saved.id}`, owner, "PATCH", {
          version: saved.version,
          activity: {
            ...saved.config,
            money: { mode: "random", algorithm, totalAmount: "20", count: 4 },
          },
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const current = (
        (await (
          await request(`/api/me/activities/${saved.id}`, owner)
        ).json()) as { activity: ManagedActivity }
      ).activity;
      const pool = await inventory(saved.id);
      if (current.status === "active") expect(pool).toEqual(original);
      else {
        expect(pool).toHaveLength(4);
        expect(pool.reduce((sum, row) => sum + row.amount_minor, 0)).toBe(2000);
        expect(
          (
            await request(
              `/api/me/activities/${saved.id}/open`,
              owner,
              "POST",
              { version: current.version },
            )
          ).status,
        ).toBe(200);
        expect(await inventory(saved.id)).toEqual(pool);
      }
    },
  );

  it.each(randomAlgorithms)(
    "rejects corrupted pre-generated amounts instead of repairing or rerolling them at opening: %s",
    async (algorithm) => {
      const saved = await create(randomConfig(algorithm), false);
      await env.DB.prepare(
        "UPDATE reward_inventory SET amount_minor=amount_minor+1 WHERE activity_id=? AND position=0",
      )
        .bind(saved.id)
        .run();
      const corrupt = await inventory(saved.id);
      expect(
        (
          await request(`/api/me/activities/${saved.id}/open`, owner, "POST", {
            version: saved.version,
          })
        ).status,
      ).toBe(400);
      expect(await inventory(saved.id)).toEqual(corrupt);
      if (algorithm === "bounded_mean_v1") {
        await env.DB.prepare(
          "UPDATE reward_inventory SET amount_minor=CASE position WHEN 2 THEN 998 ELSE 1 END WHERE activity_id=?",
        )
          .bind(saved.id)
          .run();
        expect(
          (
            await request(
              `/api/me/activities/${saved.id}/open`,
              owner,
              "POST",
              { version: saved.version },
            )
          ).status,
        ).toBe(400);
      }
    },
  );

  it("rejects a double-mean pool with the right total but an impossible generation order", async () => {
    const saved = await create(
      {
        ...randomConfig("double_mean_v1"),
        money: {
          mode: "random",
          algorithm: "double_mean_v1",
          totalAmount: "1",
          count: 4,
        },
      },
      false,
    );
    await env.DB.prepare(
      "UPDATE reward_inventory SET amount_minor=CASE position WHEN 0 THEN 97 ELSE 1 END WHERE activity_id=?",
    )
      .bind(saved.id)
      .run();
    const corrupt = await inventory(saved.id);
    expect(corrupt.reduce((sum, item) => sum + item.amount_minor, 0)).toBe(100);
    expect(
      (
        await request(`/api/me/activities/${saved.id}/open`, owner, "POST", {
          version: saved.version,
        })
      ).status,
    ).toBe(400);
    expect(await inventory(saved.id)).toEqual(corrupt);
    expect(
      await env.DB.prepare(
        "SELECT opened_at,version FROM activities WHERE id=?",
      )
        .bind(saved.id)
        .first(),
    ).toEqual({ opened_at: null, version: saved.version });
  });

  it.each(randomAlgorithms)(
    "keeps assigned random amounts through claim rollback, competing claims and payment recovery: %s",
    async (algorithm) => {
      const saved = await create({
        ...randomConfig(algorithm),
        money: { mode: "random", algorithm, totalAmount: "10", count: 2 },
      });
      const pool = await inventory(saved.id);
      const key = crypto.randomUUID();
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await env.DB.prepare(
        "CREATE TRIGGER fail_random_outbox BEFORE INSERT ON payment_outbox BEGIN SELECT RAISE(ABORT, 'random outbox failure'); END",
      ).run();
      try {
        expect((await submit(saved.id, alice, key)).status).toBe(500);
        expect(await counts()).toEqual({
          claims: 0,
          payments: 0,
          outbox: 0,
          assigned: 0,
        });
        expect(await inventory(saved.id)).toEqual(pool);
      } finally {
        await env.DB.prepare("DROP TRIGGER fail_random_outbox").run();
      }
      const won = await Promise.all([
        claim(saved.id, alice, key),
        claim(saved.id, bob),
        claim(saved.id, alice, key),
      ]);
      const amounts = new Map<string, string>();
      for (const result of won) {
        if (!("claim" in result) || result.claim.rewardType !== "ldc")
          throw new Error("Missing random reward");
        amounts.set(result.claim.id, result.claim.amount);
      }
      expect(amounts.size).toBe(2);
      expect([...amounts.values()].sort()).toEqual(
        pool.map((row) => formatAmount(row.amount_minor)).sort(),
      );
      expect(await inventory(saved.id)).toEqual(pool);
      await env.DB.prepare(
        "UPDATE simulation_controls SET scenario='response_lost' WHERE merchant_id=?",
      )
        .bind(merchant.id)
        .run();
      await runMerchantCycle(bindings, merchant.id);
      await env.DB.prepare(
        "UPDATE payment_tasks SET next_run_at=0 WHERE merchant_id=?",
      )
        .bind(merchant.id)
        .run();
      await runMerchantCycle(bindings, merchant.id);
      await env.DB.prepare(
        "UPDATE simulation_controls SET scenario='normal' WHERE merchant_id=?",
      )
        .bind(merchant.id)
        .run();
      await runMerchantCycle(bindings, merchant.id);
      const tasks = await env.DB.prepare(
        "SELECT t.status,t.amount_minor AS amount,r.amount_minor AS inventory_amount,o.amount_minor AS order_amount FROM payment_tasks t JOIN claims c ON c.id=t.claim_id JOIN reward_inventory r ON r.id=c.inventory_id JOIN simulation_orders o ON o.business_no=t.business_no AND o.client_id=t.client_id",
      ).all();
      expect(tasks.results).toHaveLength(2);
      for (const task of tasks.results)
        expect(task).toEqual({
          status: "confirmed",
          amount: task.amount,
          inventory_amount: task.amount,
          order_amount: task.amount,
        });
      expect(await counts()).toEqual({
        claims: 2,
        payments: 2,
        outbox: 2,
        assigned: 2,
      });
      expect(await inventory(saved.id)).toEqual(pool);
    },
  );
});
