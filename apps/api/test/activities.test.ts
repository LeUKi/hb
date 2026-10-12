import { env } from "cloudflare:test";
import {
  ACTIVITY_LIMITS,
  type LdcActivityInput as ActivityInput,
  type ActivityList,
  ARCHIVE_DELAY_MS,
  activityInputSchema,
  DEFAULT_DURATION_MS,
  emptyActivityInput,
  type GlobalRedemptionResult,
  type PublicActivity,
  type ManagedActivity as SharedManagedActivity,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteActivity } from "../src/activities/deletion";
import { openActivity, updateActivity } from "../src/activities/service";
import {
  activityWriteGuard,
  insertPasswordRows,
  preparePasswords,
  privateRows,
} from "../src/activities/storage";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { digestPassword, sha256Hex } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

type ManagedActivity = Omit<SharedManagedActivity, "config"> & {
  config: ActivityInput;
};

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let other: Actor;
let merchantId: string;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Expected value in test");
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

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return {
    ...emptyActivityInput(),
    title: "测试 LDC 活动",
    passwords: ["口令ABC123", "第二个口令123"],
    rewardType: "ldc",
    merchantId,
    money: { mode: "fixed", totalAmount: "2.00", count: 2 },
    beforeInfo: "领取前说明",
    afterClaimInfo: "only-after-claim",
    afterEndInfo: "only-after-end",
    ...overrides,
  };
}

async function create(config = input(), user = owner) {
  let activityInput = config;
  if (user.id !== owner.id && activityInput.merchantId === merchantId) {
    const merchant = await createMerchant(bindings, user.id, {
      requestId: crypto.randomUUID(),
      clientId: `activities_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "本地模拟",
      secret: "virtual-only-secret",
    });
    activityInput = { ...activityInput, merchantId: merchant.id };
  }
  const response = await request("/api/activities", user, "POST", {
    requestId: crypto.randomUUID(),
    activity: activityInput,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { activity: ManagedActivity }).activity;
}

async function open(activity: ManagedActivity) {
  const response = await request(
    `/api/me/activities/${activity.id}/open`,
    owner,
    "POST",
    { version: activity.version },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { activity: ManagedActivity }).activity;
}

async function publicView(id: string, user?: Actor) {
  const response = await request(`/api/activities/${id}`, user);
  expect(response.status).toBe(200);
  return ((await response.json()) as { activity: PublicActivity }).activity;
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
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
  other = await actor("other");
  merchantId = (
    await createMerchant(bindings, owner.id, {
      requestId: crypto.randomUUID(),
      clientId: `activities_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "本地模拟",
      secret: "virtual-only-secret",
    })
  ).id;
});

describe("historical passwords and draft deletion", () => {
  it("limits new activities to five passwords while preserving over-limit historical drafts and create replays", async () => {
    const historical = input({
      passwords: Array.from({ length: 6 }, (_, index) => `password${index}`),
    });
    const requestId = crypto.randomUUID();
    const rejected = await request("/api/activities", owner, "POST", {
      requestId,
      activity: historical,
    });
    expect(rejected.status).toBe(400);
    const created = await request("/api/activities", owner, "POST", {
      requestId,
      activity: { ...historical, passwords: historical.passwords.slice(0, 5) },
    });
    expect(created.status).toBe(200);
    const draft = ((await created.json()) as { activity: ManagedActivity })
      .activity;
    const oldRows = await privateRows(bindings, draft.id);
    const historicalRows = await preparePasswords(
      bindings,
      draft.id,
      historical.passwords,
      oldRows.passwords,
      Date.now(),
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM activity_passwords WHERE activity_id=?").bind(
        draft.id,
      ),
      insertPasswordRows(env.DB, historicalRows),
      env.DB.prepare("UPDATE activities SET creation_digest=? WHERE id=?").bind(
        await digestPassword(
          `activity-create:${JSON.stringify(activityInputSchema.parse(historical))}`,
          bindings.PASSWORD_DIGEST_KEY,
        ),
        draft.id,
      ),
    ]);
    const replay = await request("/api/activities", owner, "POST", {
      requestId,
      activity: historical,
    });
    expect(replay.status).toBe(200);
    const replayed = ((await replay.json()) as { activity: ManagedActivity })
      .activity;
    expect(replayed.id).toBe(draft.id);
    expect(replayed.config.passwords).toEqual(historical.passwords);
    const editedResponse = await request(
      `/api/me/activities/${draft.id}`,
      owner,
      "PATCH",
      {
        version: replayed.version,
        activity: {
          ...replayed.config,
          title: "历史活动仍可编辑",
          topicUrl: "https://linux.do/t/100/9",
        },
      },
    );
    expect(editedResponse.status).toBe(200);
    const edited = (
      (await editedResponse.json()) as { activity: ManagedActivity }
    ).activity;
    for (const passwords of [
      [...historical.passwords, "anotherPassword"],
      historical.passwords.slice(0, 5),
      [...historical.passwords.slice(0, 5), "changedPassword"],
    ]) {
      const update = await request(
        `/api/me/activities/${draft.id}`,
        owner,
        "PATCH",
        {
          version: edited.version,
          activity: { ...edited.config, passwords },
        },
      );
      expect(update.status).toBe(400);
    }
    const opened = await open(edited);
    expect(opened.config.passwords).toEqual(historical.passwords);
    expect(opened.status).toBe("active");
    const publicActivity = await publicView(opened.id);
    expect(JSON.stringify(publicActivity)).not.toContain("password0");
  });

  it.each([
    "https://linux.do/t/topic/12345/last",
    "https://linux.do/t/12345/4/extra",
  ])(
    "replays a historical creation with its original ignored path suffix without permitting a new write: %s",
    async (topicUrl) => {
      const historical = input({ topicUrl });
      const requestId = crypto.randomUUID();
      const initial = await request("/api/activities", owner, "POST", {
        requestId,
        activity: { ...historical, topicUrl: "https://linux.do/t/12345/1" },
      });
      expect(initial.status).toBe(200);
      const draft = ((await initial.json()) as { activity: ManagedActivity })
        .activity;
      // Field order is copied from the pre-migration schema, independently of the
      // new historical parser. Old creation digests must remain byte-for-byte valid.
      const legacyValue = {
        title: historical.title,
        topicUrl,
        forceDedicated: historical.forceDedicated,
        joinSquare: historical.joinSquare,
        deadline: historical.deadline,
        allocation: historical.allocation,
        passwords: historical.passwords,
        quantityVisibility: historical.quantityVisibility,
        showRecipientList: historical.showRecipientList,
        showRecipientUsername: historical.showRecipientUsername,
        showRecipientTime: historical.showRecipientTime,
        showRecipientAmount: historical.showRecipientAmount,
        beforeInfo: historical.beforeInfo,
        afterClaimInfo: historical.afterClaimInfo,
        afterEndInfo: historical.afterEndInfo,
        rewardType: historical.rewardType,
        merchantId: historical.merchantId,
        money: historical.money,
      };
      await env.DB.prepare("UPDATE activities SET creation_digest=? WHERE id=?")
        .bind(
          await digestPassword(
            `activity-create:${JSON.stringify(legacyValue)}`,
            bindings.PASSWORD_DIGEST_KEY,
          ),
          draft.id,
        )
        .run();
      const replay = await request("/api/activities", owner, "POST", {
        requestId,
        activity: historical,
      });
      expect(replay.status).toBe(200);
      const replayed = ((await replay.json()) as { activity: ManagedActivity })
        .activity;
      expect(replayed.id).toBe(draft.id);
      expect(replayed.version).toBe(draft.version);
      expect(replayed.topicUrl).toBe(draft.topicUrl);
      const newCreate = await request("/api/activities", owner, "POST", {
        requestId: crypto.randomUUID(),
        activity: historical,
      });
      expect(newCreate.status).toBe(400);
      const edit = await request(
        `/api/me/activities/${draft.id}`,
        owner,
        "PATCH",
        { version: draft.version, activity: { ...draft.config, topicUrl } },
      );
      expect(edit.status).toBe(400);
      const changedReplay = await request("/api/activities", owner, "POST", {
        requestId,
        activity: { ...historical, title: "different historical request" },
      });
      expect(changedReplay.status).toBe(409);
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM activities").first("n"),
      ).toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM reward_inventory",
        ).first("n"),
      ).toBe(
        historical.money.mode === "custom"
          ? historical.money.amounts.length
          : historical.money.mode === "timed_draw"
            ? 0
            : historical.money.count,
      );
      expect(
        await env.DB.prepare("SELECT version FROM activities WHERE id=?")
          .bind(draft.id)
          .first("version"),
      ).toBe(draft.version);
    },
  );

  it("allows exact reply association edits in draft, active, ended and archived states", async () => {
    let activity = await create(input({ topicUrl: "https://linux.do/t/100" }));
    for (const [index, status] of (
      ["draft", "active", "ended", "archived"] as const
    ).entries()) {
      if (status === "active") activity = await open(activity);
      if (status === "ended" || status === "archived")
        await env.DB.prepare(
          "UPDATE activities SET ended_at=?, end_reason='manual', archived_at=? WHERE id=?",
        )
          .bind(
            Date.now() -
              (status === "archived" ? ARCHIVE_DELAY_MS + 1000 : 1000),
            status === "archived" ? Date.now() - 1000 : null,
            activity.id,
          )
          .run();
      const originalOpening = activity.openedAt;
      const topicUrl = `https://linux.do/t/${200 + index}/${index + 2}`;
      const response = await request(
        `/api/me/activities/${activity.id}`,
        owner,
        "PATCH",
        {
          version: activity.version,
          activity: { ...activity.config, topicUrl },
        },
      );
      expect(response.status).toBe(200);
      activity = ((await response.json()) as { activity: ManagedActivity })
        .activity;
      expect(activity.status).toBe(status);
      expect(activity.topicUrl).toBe(topicUrl);
      expect(activity.config.topicUrl).toBe(topicUrl);
      expect(activity.openedAt).toBe(originalOpening);
    }
  });

  it("deletes a never-opened draft, removes private content, preserves fingerprints and cannot resurrect through replay", async () => {
    const payload = {
      requestId: crypto.randomUUID(),
      activity: input({
        topicUrl: "https://linux.do/t/100/2",
        joinSquare: true,
      }),
    };
    const creation = await request("/api/activities", owner, "POST", payload);
    expect(creation.status).toBe(200);
    const draft = ((await creation.json()) as { activity: ManagedActivity })
      .activity;
    const fingerprint = "terminal:fingerprint";
    await env.DB.prepare(
      `INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'claim', 'password', 'draft', ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        draft.id,
        other.id,
        crypto.randomUUID(),
        fingerprint,
        Date.now(),
        Date.now(),
      )
      .run();
    const deletion = await request(
      `/api/me/activities/${draft.id}`,
      owner,
      "DELETE",
      { version: draft.version },
    );
    expect(deletion.status).toBe(200);
    expect(deletion.headers.get("cache-control")).toBe("no-store");
    const result = await deletion.json();
    expect(result).toMatchObject({
      id: draft.id,
      deleted: true,
      version: draft.version + 1,
    });
    const row = required(
      await env.DB.prepare(
        "SELECT author_id, creation_request_id, creation_digest, deleted_at, title, config, topic_id, total_count FROM activities WHERE id=?",
      )
        .bind(draft.id)
        .first<{ deleted_at: number | null }>(),
    );
    expect(row).toMatchObject({
      author_id: owner.id,
      creation_request_id: payload.requestId,
      title: "",
      config: "{}",
      topic_id: null,
      total_count: 0,
    });
    expect(row.deleted_at).toBeTypeOf("number");
    for (const table of ["activity_passwords", "reward_inventory"])
      expect(
        await env.DB.prepare(
          `SELECT count(*) AS n FROM ${table} WHERE activity_id=?`,
        )
          .bind(draft.id)
          .first("n"),
      ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT fingerprint FROM redemption_submissions WHERE activity_id=?",
      )
        .bind(draft.id)
        .first("fingerprint"),
    ).toBe(fingerprint);
    const repeated = await request(
      `/api/me/activities/${draft.id}`,
      owner,
      "DELETE",
      { version: draft.version },
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(result);
    const blockedSubmissionId = crypto.randomUUID();
    const createReplay = await request(
      "/api/activities",
      owner,
      "POST",
      payload,
    );
    expect(createReplay.status).toBe(410);
    expect(await createReplay.json()).toMatchObject({
      error: { code: "ACTIVITY_DELETED" },
    });
    expect(
      (
        await request("/api/activities", owner, "POST", {
          ...payload,
          activity: { ...payload.activity, title: "changed" },
        })
      ).status,
    ).toBe(409);
    for (const [path, method, body] of [
      [`/api/activities/${draft.id}`, "GET", undefined],
      [`/api/me/activities/${draft.id}`, "GET", undefined],
      [
        `/api/me/activities/${draft.id}`,
        "PATCH",
        { version: draft.version, activity: draft.config },
      ],
      [
        `/api/me/activities/${draft.id}/open`,
        "POST",
        { version: draft.version },
      ],
      [
        `/api/activities/${draft.id}/claim`,
        "POST",
        { submissionId: blockedSubmissionId, password: "口令ABC123" },
      ],
      [
        `/api/activities/${draft.id}/claim`,
        "POST",
        { submissionId: crypto.randomUUID(), password: "口令ABC123" },
      ],
      [`/api/activities/${draft.id}/passwords`, "GET", undefined],
    ] as const)
      expect((await request(path, owner, method, body)).status).toBe(404);
    const ownerList = (await (
      await request("/api/me/activities", owner)
    ).json()) as ActivityList;
    expect(ownerList.items).toEqual([]);
  });

  it("protects draft deletion with login, origin, CSRF, ownership and version checks", async () => {
    const draft = await create();
    const path = `/api/me/activities/${draft.id}`;
    expect(
      (await request(path, undefined, "DELETE", { version: 1 })).status,
    ).toBe(401);
    expect(
      (
        await request(
          path,
          owner,
          "DELETE",
          { version: 1 },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          path,
          owner,
          "DELETE",
          { version: 1 },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
    ).toBe(403);
    expect((await request(path, other, "DELETE", { version: 1 })).status).toBe(
      404,
    );
    expect((await request(path, owner, "DELETE", { version: 2 })).status).toBe(
      409,
    );
    const opened = await open(draft);
    expect(
      (await request(path, owner, "DELETE", { version: opened.version }))
        .status,
    ).toBe(400);
    expect((await publicView(opened.id)).status).toBe("active");
  });

  it("rolls back tombstone and private cleanup when a child deletion fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const draft = await create();
    await env.DB.prepare(
      `CREATE TRIGGER fail_draft_cleanup BEFORE DELETE ON reward_inventory WHEN OLD.activity_id='${draft.id}' BEGIN SELECT RAISE(ABORT,'cleanup failed'); END`,
    ).run();
    try {
      expect(
        (
          await request(`/api/me/activities/${draft.id}`, owner, "DELETE", {
            version: draft.version,
          })
        ).status,
      ).toBe(500);
      const read = await request(`/api/me/activities/${draft.id}`, owner);
      expect(read.status).toBe(200);
      expect(
        ((await read.json()) as { activity: ManagedActivity }).activity,
      ).toEqual(draft);
      expect(
        await env.DB.prepare("SELECT deleted_at FROM activities WHERE id=?")
          .bind(draft.id)
          .first("deleted_at"),
      ).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_draft_cleanup").run();
    }
  });

  it("keeps a single winner when deleting competes with opening or editing in D1", async () => {
    for (const mutation of ["open", "edit"] as const) {
      const draft = await create();
      const results = await Promise.allSettled([
        deleteActivity(bindings, owner.id, draft.id, draft.version),
        mutation === "open"
          ? openActivity(bindings, draft.id, owner.id, draft.version)
          : updateActivity(bindings, draft.id, owner.id, {
              version: draft.version,
              activity: {
                ...draft.config,
                title: "edited",
                passwords: ["updated123"],
              },
            }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const row = required(
        await env.DB.prepare(
          "SELECT deleted_at, opened_at, title, version FROM activities WHERE id=?",
        )
          .bind(draft.id)
          .first<{
            deleted_at: number | null;
            opened_at: number | null;
            title: string;
            version: number;
          }>(),
      );
      expect(row.version).toBe(draft.version + 1);
      const remainingPasswords = await env.DB.prepare(
        "SELECT count(*) AS n FROM activity_passwords WHERE activity_id=?",
      )
        .bind(draft.id)
        .first("n");
      if (row.deleted_at !== null) {
        expect(row.opened_at).toBeNull();
        expect(row.title).toBe("");
        expect(remainingPasswords).toBe(0);
      } else {
        expect(row.title).toBe(mutation === "edit" ? "edited" : draft.title);
        expect(remainingPasswords).toBe(
          mutation === "edit" ? 1 : draft.config.passwords.length,
        );
        expect(row.opened_at !== null).toBe(mutation === "open");
      }
    }
  });

  it("aborts an entire write batch when its guarded target no longer exists", async () => {
    const draft = await create();
    await expect(
      env.DB.batch([
        activityWriteGuard(env.DB, crypto.randomUUID(), owner.id, 1),
        env.DB.prepare(
          "DELETE FROM activity_passwords WHERE activity_id=?",
        ).bind(draft.id),
      ]),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM activity_passwords WHERE activity_id=?",
      )
        .bind(draft.id)
        .first("n"),
    ).toBe(draft.config.passwords.length);
    const deleted = await deleteActivity(
      bindings,
      owner.id,
      draft.id,
      draft.version,
    );
    await expect(
      env.DB.prepare("UPDATE activities SET title='resurrected' WHERE id=?")
        .bind(draft.id)
        .run(),
    ).rejects.toThrow();
    expect(
      await deleteActivity(bindings, owner.id, draft.id, deleted.version),
    ).toEqual(deleted);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("LDC activity management", () => {
  it("creates a draft with encrypted passwords and stable LDC inventory", async () => {
    const config = input({
      passwords: ["  口令ABC123  "],
      topicUrl: "https://linux.do/t/topic/12345/6?u=owner",
    });
    const activity = await create(config);
    expect(activity).toMatchObject({
      status: "draft",
      version: 1,
      openedAt: null,
      deadlineAt: null,
      totalCount: 2,
      topicUrl: "https://linux.do/t/12345/6",
    });
    expect(activity.config.passwords).toEqual(["口令ABC123"]);
    expect(activity.config.money).toEqual(config.money);
    const passwords = await env.DB.prepare(
      "SELECT digest, ciphertext FROM activity_passwords",
    ).all();
    const inventory = await env.DB.prepare(
      "SELECT ciphertext, kind, amount_minor FROM reward_inventory",
    ).all();
    expect(JSON.stringify(passwords)).not.toContain("口令ABC123");
    expect(JSON.stringify(inventory)).not.toContain("private reward");
    expect(JSON.stringify(inventory)).toContain('"kind":"ldc"');
    const another = await create(config);
    expect(another.id).not.toBe(activity.id);
    expect(another.config.money).toEqual(config.money);
  });

  it("requires login, exact origin and CSRF for writes", async () => {
    const payload = { requestId: crypto.randomUUID(), activity: input() };
    expect(
      (await request("/api/activities", undefined, "POST", payload)).status,
    ).toBe(401);
    expect(
      (
        await request("/api/activities", owner, "POST", payload, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/activities", owner, "POST", payload, {
          "X-CSRF-Token": "wrong",
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/me/activities")).status).toBe(401);
  });

  it("never discloses drafts or management records to another account or anonymous user", async () => {
    const activity = await create();
    expect((await request(`/api/activities/${activity.id}`)).status).toBe(404);
    expect(
      (await request(`/api/activities/${activity.id}`, other)).status,
    ).toBe(404);
    expect(
      (await request(`/api/me/activities/${activity.id}`, other)).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, other, "PATCH", {
          version: 1,
          activity: activity.config,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/me/activities/${activity.id}/open`, other, "POST", {
          version: 1,
        })
      ).status,
    ).toBe(404);
    const preview = await publicView(activity.id, owner);
    const serialized = JSON.stringify(preview);
    expect(preview.status).toBe("draft");
    for (const secret of ["口令ABC123", "only-after-claim", "only-after-end"])
      expect(serialized).not.toContain(secret);
    const managed = await request(`/api/me/activities/${activity.id}`, owner);
    expect(managed.headers.get("cache-control")).toBe("no-store");
  });

  it("uses one creation request per author and binds its contents, including concurrent retries", async () => {
    const payload = { requestId: crypto.randomUUID(), activity: input() };
    const responses = await Promise.all([
      request("/api/activities", owner, "POST", payload),
      request("/api/activities", owner, "POST", payload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const first = (await responses[0].json()) as { activity: ManagedActivity };
    const second = (await responses[1].json()) as {
      activity: ManagedActivity;
    };
    expect(first.activity.id).toBe(second.activity.id);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM activities").first("n"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM reward_inventory").first(
        "n",
      ),
    ).toBe(2);
    const changedRequest = await request("/api/activities", owner, "POST", {
      ...payload,
      activity: { ...payload.activity, title: "changed" },
    });
    expect(changedRequest.status).toBe(409);
    expect(await changedRequest.json()).toEqual({
      error: {
        code: "ACTIVITY_CONFLICT",
        message: "同一创建请求不能更换活动内容",
      },
    });
    expect(
      (await request("/api/activities", other, "POST", payload)).status,
    ).toBe(404);
    const otherMerchant = await createMerchant(bindings, other.id, {
      requestId: crypto.randomUUID(),
      clientId: `activities_${crypto.randomUUID().replaceAll("-", "")}`,
      label: "另一个商户",
      secret: "virtual-only-secret",
    });
    expect(
      (
        await request("/api/activities", other, "POST", {
          ...payload,
          activity: { ...payload.activity, merchantId: otherMerchant.id },
        })
      ).status,
    ).toBe(200);
  });

  it("validates format and byte limits with field errors, without leaking private submitted content", async () => {
    const bad = input({ passwords: ["秘密😃密码"] });
    const response = await request("/api/activities", owner, "POST", {
      requestId: crypto.randomUUID(),
      activity: bad,
    });
    expect(response.status).toBe(400);
    const error = (await response.json()) as {
      error: { issues: { path: string }[] };
    };
    expect(error.error.issues[0]?.path).toBe("activity.passwords.0");
    expect(JSON.stringify(error)).not.toContain("秘密😃密码");
    for (const activity of [
      input({ passwords: ["口令ABC123", " 口令ABC123 "] }),
      input({ passwords: ["口令ABC123", " 口令ABC123 "] }),
      input({ money: { mode: "fixed", totalAmount: "0.00", count: 1 } }),
    ]) {
      expect(
        (
          await request("/api/activities", owner, "POST", {
            requestId: crypto.randomUUID(),
            activity,
          })
        ).status,
      ).toBe(400);
    }
    const tooLarge = await app.request(
      `${origin}/api/activities`,
      {
        method: "POST",
        headers: {
          Cookie: owner.cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-CSRF-Token": owner.csrf,
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          activity: input(),
          note: "a".repeat(ACTIVITY_LIMITS.requestBytes + 1),
        }),
      },
      bindings,
    );
    expect(tooLarge.status).toBe(413);
  });

  it("writes 1,000 inventory rows within D1 statement limits", async () => {
    const config = input({
      money: { mode: "fixed", totalAmount: "1000.00", count: 1000 },
    });
    const activity = await create(config);
    expect(activity.totalCount).toBe(1000);
    expect(activity.config.money).toEqual(config.money);
    const detail = await request(`/api/me/activities/${activity.id}`, owner);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await detail.json()) as { activity: ManagedActivity }).activity,
    ).toEqual(activity);
  });

  it("preserves complete field validation issues after forwarding creation to the DO", async () => {
    const requestId = crypto.randomUUID();
    const invalid = input({
      title: "",
      passwords: ["秘密😃密码"],
      money: { mode: "fixed", totalAmount: "0.00", count: 0 },
      afterClaimInfo: "PRIVATE-AFTER-CLAIM".repeat(1000),
    });
    const response = await request("/api/activities", owner, "POST", {
      requestId,
      activity: invalid,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as {
      error: { code: string; issues: { path: string; message: string }[] };
    };
    expect(result.error.code).toBe("INVALID_ACTIVITY");
    expect(result.error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "activity.title",
        "activity.passwords.0",
        "activity.money.totalAmount",
        "activity.money.count",
        "activity.afterClaimInfo",
      ]),
    );
    const encoded = JSON.stringify(result);
    for (const value of ["秘密😃密码", "PRIVATE-AFTER-CLAIM"])
      expect(encoded).not.toContain(value);
    for (const table of [
      "activities",
      "activity_passwords",
      "reward_inventory",
    ])
      expect(
        await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
      ).toBe(0);

    expect(
      (
        await request("/api/activities", owner, "POST", {
          requestId,
          activity: input(),
        })
      ).status,
    ).toBe(200);
  });

  it("binds creation coordination to the authenticated author and rejects client identity fields", async () => {
    const payload = { requestId: crypto.randomUUID(), activity: input() };
    const wrongObject = env.ACTIVITY_DO.get(
      env.ACTIVITY_DO.idFromName(`activity-create:${other.id}`),
    );
    const rejected = await wrongObject.fetch(
      "https://activity.internal/internal/activities/create",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HB-Actor-ID": owner.id,
        },
        body: JSON.stringify(payload),
      },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: "INVALID_OBJECT" },
    });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM activities").first("n"),
    ).toBe(0);

    for (const extra of [
      { authorId: other.id },
      { authorId: owner.id },
      { userId: other.id },
      { userId: owner.id },
      { unexpected: "PRIVATE-EXTRA-FIELD" },
    ]) {
      const spoofed = await request("/api/activities", owner, "POST", {
        ...payload,
        ...extra,
      });
      expect(spoofed.status).toBe(400);
      expect(spoofed.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await spoofed.json())).not.toContain(
        "PRIVATE-EXTRA-FIELD",
      );
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM activities").first("n"),
    ).toBe(0);
    const created = await request("/api/activities", owner, "POST", payload, {
      "X-HB-Actor-ID": other.id,
    });
    expect(created.status).toBe(200);
    const { activity } = (await created.json()) as {
      activity: ManagedActivity;
    };
    expect(activity.author.id).toBe(owner.id);
    expect(
      (await request(`/api/me/activities/${activity.id}`, other)).status,
    ).toBe(404);
  });

  it("rejects client identity fields in raw draft edits without changing stored configuration", async () => {
    const activity = await create();
    const payload = {
      version: activity.version,
      activity: { ...activity.config, title: "PRIVATE-UNSAVED-TITLE" },
    };
    for (const extra of [
      { authorId: owner.id },
      { authorId: other.id },
      { userId: owner.id },
      { unexpected: "PRIVATE-EXTRA-FIELD" },
    ]) {
      const response = await request(
        `/api/me/activities/${activity.id}`,
        owner,
        "PATCH",
        { ...payload, ...extra },
      );
      expect(response.status).toBe(400);
      const result = (await response.json()) as {
        error: { code: string; issues: { path: string; message: string }[] };
      };
      expect(result.error).toMatchObject({
        code: "INVALID_ACTIVITY",
        issues: expect.any(Array),
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE-UNSAVED-TITLE");
      expect(JSON.stringify(result)).not.toContain("PRIVATE-EXTRA-FIELD");
    }
    expect(
      (
        await request(
          `/api/me/activities/${activity.id}`,
          other,
          "PATCH",
          payload,
          { "X-HB-Actor-ID": owner.id },
        )
      ).status,
    ).toBe(404);
    const detail = (await (
      await request(`/api/me/activities/${activity.id}`, owner)
    ).json()) as { activity: ManagedActivity };
    expect(detail.activity).toEqual(activity);
  });

  it("returns safe validation errors for malformed and non-object raw creation and edit bodies", async () => {
    const activity = await create();
    for (const [path, method] of [
      ["/api/activities", "POST"],
      [`/api/me/activities/${activity.id}`, "PATCH"],
    ]) {
      for (const body of [
        '{"activity":{"title":"PRIVATE-MALFORMED-TITLE"}',
        "null",
        "[]",
        "",
      ]) {
        const response = await app.request(
          `${origin}${path}`,
          {
            method,
            headers: {
              Origin: origin,
              Cookie: owner.cookie,
              "Content-Type": "application/json",
              "X-CSRF-Token": owner.csrf,
            },
            body,
          },
          bindings,
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const result = await response.json();
        expect(result).toMatchObject({ error: { code: "INVALID_ACTIVITY" } });
        expect(JSON.stringify(result)).not.toContain("PRIVATE-MALFORMED-TITLE");
      }
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM activities").first("n"),
    ).toBe(1);
    const detail = (await (
      await request(`/api/me/activities/${activity.id}`, owner)
    ).json()) as { activity: ManagedActivity };
    expect(detail.activity).toEqual(activity);
  });

  it("counts chunked multibyte creation and edit bodies by bytes at the exact 1 MiB boundary", async () => {
    const encoder = new TextEncoder();
    function paddedBody(payload: unknown, extraBytes = 0) {
      const json = JSON.stringify(payload);
      const size = encoder.encode(json).byteLength;
      return encoder.encode(
        json + " ".repeat(ACTIVITY_LIMITS.requestBytes - size + extraBytes),
      );
    }
    function streamedRequest(path: string, method: string, body: Uint8Array) {
      const firstSplit = body.findIndex((byte) => byte >= 0x80) + 1;
      expect(firstSplit).toBeGreaterThan(0);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === body.byteLength) {
            controller.close();
            return;
          }
          // Split the first UTF-8 code point across chunks, then stream the
          // remaining bytes without giving the HTTP route a declared length.
          const end =
            offset === 0
              ? firstSplit
              : Math.min(offset + 16_384, body.byteLength);
          controller.enqueue(body.subarray(offset, end));
          offset = end;
        },
      });
      const raw = new Request(`${origin}${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: owner.cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": owner.csrf,
          "Transfer-Encoding": "chunked",
        },
        body: stream,
      });
      expect(raw.headers.has("Content-Length")).toBe(false);
      return app.request(raw, undefined, bindings);
    }

    const payload = { requestId: crypto.randomUUID(), activity: input() };
    const exact = paddedBody(payload);
    const oversized = paddedBody(payload, 1);
    expect(exact.byteLength).toBe(ACTIVITY_LIMITS.requestBytes);
    expect(oversized.byteLength).toBe(ACTIVITY_LIMITS.requestBytes + 1);
    expect(new TextDecoder().decode(oversized).length).toBeLessThan(
      ACTIVITY_LIMITS.requestBytes,
    );
    const rejected = await streamedRequest(
      "/api/activities",
      "POST",
      oversized,
    );
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    for (const table of [
      "activities",
      "activity_passwords",
      "reward_inventory",
    ])
      expect(
        await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
      ).toBe(0);

    const accepted = await streamedRequest("/api/activities", "POST", exact);
    expect(accepted.status).toBe(200);
    const saved = ((await accepted.json()) as { activity: ManagedActivity })
      .activity;
    expect(saved.config.money).toEqual(payload.activity.money);
    const edit = {
      version: saved.version,
      activity: { ...saved.config, title: "多字节修改标题" },
    };
    const rejectedEdit = await streamedRequest(
      `/api/me/activities/${saved.id}`,
      "PATCH",
      paddedBody(edit, 1),
    );
    expect(rejectedEdit.status).toBe(413);
    expect(await rejectedEdit.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    const unchanged = (await (
      await request(`/api/me/activities/${saved.id}`, owner)
    ).json()) as { activity: ManagedActivity };
    expect(unchanged.activity).toEqual(saved);
    const edited = await streamedRequest(
      `/api/me/activities/${saved.id}`,
      "PATCH",
      paddedBody(edit),
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      activity: { version: saved.version + 1, title: edit.activity.title },
    });
  });

  it("updates draft inventory and order while keeping IDs", async () => {
    const activity = await create(input({ forceDedicated: true }));
    const updated = {
      ...activity.config,
      title: "更新后的活动",
      money: { mode: "fixed", totalAmount: "3.00", count: 3 },
    };
    const response = await request(
      `/api/me/activities/${activity.id}`,
      owner,
      "PATCH",
      { version: 1, activity: updated },
    );
    expect(response.status).toBe(200);
    const result = ((await response.json()) as { activity: ManagedActivity })
      .activity;
    expect(result.version).toBe(2);
    expect(result.config.money).toEqual(updated.money);
    const staleUpdate = await request(
      `/api/me/activities/${activity.id}`,
      owner,
      "PATCH",
      { version: 1, activity: activity.config },
    );
    expect(staleUpdate.status).toBe(409);
    expect(await staleUpdate.json()).toEqual({
      error: {
        code: "ACTIVITY_VERSION_CONFLICT",
        message: "活动已更新，请刷新后重试",
      },
    });
  });

  it.each([false, true])(
    "updates draft dedicated mode from %s and synchronizes projection, discovery and statistics",
    async (initialDedicated) => {
      const draft = await create(input({ forceDedicated: initialDedicated }));
      const forceDedicated = !initialDedicated;
      const response = await request(
        `/api/me/activities/${draft.id}`,
        owner,
        "PATCH",
        {
          version: draft.version,
          activity: { ...draft.config, forceDedicated },
        },
      );
      expect(response.status).toBe(200);
      const updated = ((await response.json()) as { activity: ManagedActivity })
        .activity;
      expect(updated).toMatchObject({
        forceDedicated,
        version: draft.version + 1,
        config: { forceDedicated },
      });
      expect(
        await env.DB.prepare(
          "SELECT force_dedicated AS dedicated, json_extract(config,'$.forceDedicated') AS configured FROM activities WHERE id=?",
        )
          .bind(draft.id)
          .first(),
      ).toEqual({
        dedicated: Number(forceDedicated),
        configured: Number(forceDedicated),
      });
      expect((await publicView(draft.id, owner)).forceDedicated).toBe(
        forceDedicated,
      );
      expect(
        (await request(`/api/me/activities/${draft.id}/statistics`, owner))
          .status,
      ).toBe(404);
      const opened = await open(updated);
      expect(opened).toMatchObject({
        forceDedicated,
        config: { forceDedicated },
      });
      expect((await publicView(draft.id)).forceDedicated).toBe(forceDedicated);
      const history = await request(
        "/api/me/activities?status=all&type=all",
        owner,
      );
      expect(history.status).toBe(200);
      const list = (await history.json()) as ActivityList;
      expect(
        list.items.find((activity) => activity.id === draft.id),
      ).toMatchObject({ forceDedicated });
      const discovery = await request(
        "/api/redemptions/discover",
        other,
        "POST",
        {
          submissionId: crypto.randomUUID(),
          password: draft.config.passwords[0],
        },
      );
      expect(discovery.status).toBe(200);
      const found = (await discovery.json()) as GlobalRedemptionResult;
      expect(found.result).toBe(forceDedicated ? "none" : "single");
      expect(found.items.map((activity) => activity.id)).toEqual(
        forceDedicated ? [] : [draft.id],
      );
      expect(
        (await request(`/api/me/activities/${draft.id}/statistics`, owner))
          .status,
      ).toBe(forceDedicated ? 200 : 404);
      expect(
        await env.DB.prepare("SELECT count(*) FROM claims WHERE activity_id=?")
          .bind(draft.id)
          .first("count(*)"),
      ).toBe(0);
    },
  );

  it.each([false, true])(
    "locks opened dedicated mode at %s without changing either stored value",
    async (forceDedicated) => {
      const opened = await open(await create(input({ forceDedicated })));
      const response = await request(
        `/api/me/activities/${opened.id}`,
        owner,
        "PATCH",
        {
          version: opened.version,
          activity: { ...opened.config, forceDedicated: !forceDedicated },
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_ACTIVITY",
          message: "开放后不能修改口令尝试统计设置",
        },
      });
      const reread = await request(`/api/me/activities/${opened.id}`, owner);
      const current = (await reread.json()) as { activity: ManagedActivity };
      expect(current.activity).toEqual(opened);
      expect((await publicView(opened.id)).forceDedicated).toBe(forceDedicated);
      expect(
        await env.DB.prepare(
          "SELECT force_dedicated AS dedicated, json_extract(config,'$.forceDedicated') AS configured FROM activities WHERE id=?",
        )
          .bind(opened.id)
          .first(),
      ).toEqual({
        dedicated: Number(forceDedicated),
        configured: Number(forceDedicated),
      });
    },
  );

  it("rolls back activity, passwords and inventory together if a child insert fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare(
      `CREATE TRIGGER fail_inventory BEFORE INSERT ON reward_inventory WHEN NEW.position = 0 BEGIN SELECT RAISE(ABORT, 'test constraint'); END`,
    ).run();
    try {
      const response = await request("/api/activities", owner, "POST", {
        requestId: crypto.randomUUID(),
        activity: input({
          money: { mode: "fixed", totalAmount: "1.00", count: 1 },
        }),
      });
      expect(response.status).toBe(500);
      expect(
        await env.DB.prepare("SELECT count(*) AS n FROM activities").first("n"),
      ).toBe(0);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM activity_passwords",
        ).first("n"),
      ).toBe(0);
      await env.DB.prepare("DROP TRIGGER fail_inventory").run();
      const activity = await create();
      await env.DB.prepare(
        `CREATE TRIGGER fail_inventory BEFORE INSERT ON reward_inventory WHEN NEW.position = 0 BEGIN SELECT RAISE(ABORT, 'test constraint'); END`,
      ).run();
      const update = await request(
        `/api/me/activities/${activity.id}`,
        owner,
        "PATCH",
        {
          version: 1,
          activity: {
            ...activity.config,
            title: "must roll back",
            forceDedicated: !activity.config.forceDedicated,
            passwords: ["newPass123"],
            money: { mode: "fixed", totalAmount: "3.00", count: 3 },
          },
        },
      );
      expect(update.status).toBe(500);
      const read = await request(`/api/me/activities/${activity.id}`, owner);
      expect(
        ((await read.json()) as { activity: ManagedActivity }).activity,
      ).toEqual(activity);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_inventory").run();
    }
  });

  it("allows only one concurrent version update and does not let the losing inventory leak into the winner", async () => {
    const activity = await create();
    const updates = [
      input({ title: "winner A", forceDedicated: true }),
      input({ title: "winner B" }),
    ];
    const results = await Promise.all(
      updates.map((config) =>
        request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: 1,
          activity: config,
        }),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const final = (
      (await (
        await request(`/api/me/activities/${activity.id}`, owner)
      ).json()) as { activity: ManagedActivity }
    ).activity;
    const winning = updates.find((config) => config.title === final.title);
    expect(final.version).toBe(2);
    expect(final.config.money).toEqual(winning?.money);
    expect(final.forceDedicated).toBe(winning?.forceDedicated);
    expect(final.config.forceDedicated).toBe(winning?.forceDedicated);
  });

  it("opens at the requested moment with configured duration and repeated open never resets it", async () => {
    const draft = await create(
      input({ deadline: { mode: "duration", value: 90, unit: "minutes" } }),
    );
    const opened = await open(draft);
    expect(opened.status).toBe("active");
    expect(
      Date.parse(required(opened.deadlineAt)) -
        Date.parse(required(opened.openedAt)),
    ).toBe(90 * 60 * 1000);
    expect(opened.config.deadline).toEqual({
      mode: "at",
      at: opened.deadlineAt,
    });
    const repeated = await open(draft);
    expect(repeated.openedAt).toBe(opened.openedAt);
    expect(repeated.deadlineAt).toBe(opened.deadlineAt);
    expect(repeated.version).toBe(opened.version);
    expect((await publicView(opened.id)).status).toBe("active");
  });

  it.each([
    [{ mode: "duration" as const }, DEFAULT_DURATION_MS],
    [
      { mode: "duration" as const, value: 2, unit: "hours" as const },
      7_200_000,
    ],
    [
      { mode: "duration" as const, value: 1, unit: "days" as const },
      86_400_000,
    ],
  ])(
    "calculates supported duration shape %# at opening",
    async (deadline, ms) => {
      const opened = await open(await create(input({ deadline })));
      expect(
        Date.parse(required(opened.deadlineAt)) -
          Date.parse(required(opened.openedAt)),
      ).toBe(ms);
    },
  );

  it("rejects an expired configured deadline at opening", async () => {
    const draft = await create(
      input({
        deadline: { mode: "at", at: new Date(Date.now() - 1).toISOString() },
      }),
    );
    expect(
      (
        await request(`/api/me/activities/${draft.id}/open`, owner, "POST", {
          version: 1,
        })
      ).status,
    ).toBe(400);
    expect((await publicView(draft.id, owner)).status).toBe("draft");
  });

  it("rejects duration deadlines that overflow the JavaScript date range", async () => {
    const draft = await create(
      input({
        deadline: {
          mode: "duration",
          value: Number.MAX_SAFE_INTEGER,
          unit: "days",
        },
      }),
    );
    expect(
      (
        await request(`/api/me/activities/${draft.id}/open`, owner, "POST", {
          version: draft.version,
        })
      ).status,
    ).toBe(400);
    expect((await publicView(draft.id, owner)).status).toBe("draft");
  });

  it.each([false, true])(
    "does not let a concurrent stale draft write modify opened inventory or dedicated mode %s",
    async (initialDedicated) => {
      const draft = await create(input({ forceDedicated: initialDedicated }));
      const different = {
        ...draft.config,
        forceDedicated: !initialDedicated,
        money: { mode: "fixed", totalAmount: "3.00", count: 3 },
      };
      const responses = await Promise.all([
        request(`/api/me/activities/${draft.id}/open`, owner, "POST", {
          version: 1,
        }),
        request(`/api/me/activities/${draft.id}`, owner, "PATCH", {
          version: 1,
          activity: different,
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const final = (
        (await (
          await request(`/api/me/activities/${draft.id}`, owner)
        ).json()) as { activity: ManagedActivity }
      ).activity;
      expect(final.config.money).toEqual(
        final.status === "active" ? draft.config.money : different.money,
      );
      const forceDedicated =
        final.status === "active" ? initialDedicated : different.forceDedicated;
      expect(final.forceDedicated).toBe(forceDedicated);
      expect(final.config.forceDedicated).toBe(forceDedicated);
      expect((await publicView(draft.id, owner)).forceDedicated).toBe(
        forceDedicated,
      );
    },
  );

  it("freezes opened rewards, passwords and deadlines while allowing association and display edits", async () => {
    const activity = await open(
      await create(input({ topicUrl: "https://linux.do/t/12345" })),
    );
    for (const change of [
      { allocation: "random" as const },
      { money: { mode: "fixed" as const, totalAmount: "3.00", count: 3 } },
      { passwords: ["replacement123"] },
      { passwords: [...activity.config.passwords, "newPass123"] },
      { forceDedicated: true },
      {
        deadline: {
          mode: "at" as const,
          at: new Date(
            Date.parse(required(activity.deadlineAt)) - 1000,
          ).toISOString(),
        },
      },
      {
        deadline: {
          mode: "at" as const,
          at: new Date(
            Date.parse(required(activity.deadlineAt)) + 1000,
          ).toISOString(),
        },
      },
    ]) {
      expect(
        (
          await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
            version: activity.version,
            activity: { ...activity.config, ...change },
          })
        ).status,
      ).toBe(400);
    }
    const config = {
      ...activity.config,
      beforeInfo: "updated",
      afterClaimInfo: "updated after claim",
      afterEndInfo: "updated after end",
      topicUrl: "https://linux.do/t/23456/8",
      quantityVisibility: "fuzzy" as const,
    };
    expect(
      (
        await request(`/api/me/activities/${activity.id}`, owner, "PATCH", {
          version: activity.version,
          activity: config,
        })
      ).status,
    ).toBe(200);
    const read = (
      (await (
        await request(`/api/me/activities/${activity.id}`, owner)
      ).json()) as { activity: ManagedActivity }
    ).activity;
    expect(read.config.passwords).toEqual(activity.config.passwords);
    expect(read.topicUrl).toBe("https://linux.do/t/23456/8");
    expect(read.config.money).toEqual(activity.config.money);
    expect(read.config).toMatchObject({
      beforeInfo: "updated",
      afterClaimInfo: "updated after claim",
      afterEndInfo: "updated after end",
      quantityVisibility: "fuzzy",
    });
  });

  it("projects the supported quantity modes without exposing private text, passwords or unearned information to the author", async () => {
    for (const quantityVisibility of ["fuzzy", "exact"] as const) {
      const activity = await open(await create(input({ quantityVisibility })));
      const projection = await publicView(activity.id, owner);
      const serialized = JSON.stringify(projection);
      expect(projection.quantity.mode).toBe(quantityVisibility);
      for (const secret of [
        "口令ABC123",
        "only-after-claim",
        "only-after-end",
        "totalCount",
        "claimedCount",
      ])
        expect(serialized).not.toContain(secret);
      if (quantityVisibility !== "exact")
        expect(Object.keys(projection.quantity)).not.toContain("remaining");
    }
  });

  it("rejects retired quantity modes on writes and projects historical values as exact", async () => {
    for (const quantityVisibility of ["hidden", "availability"] as const) {
      const rejected = await request("/api/activities", owner, "POST", {
        requestId: crypto.randomUUID(),
        activity: input({ quantityVisibility }),
      });
      expect(rejected.status).toBe(400);
      const activity = await open(await create());
      await env.DB.prepare(
        "UPDATE activities SET config=json_set(config,'$.quantityVisibility',?) WHERE id=?",
      )
        .bind(quantityVisibility, activity.id)
        .run();
      expect((await publicView(activity.id)).quantity).toEqual({
        mode: "exact",
        total: 2,
        claimed: 0,
        remaining: 2,
      });
      const mutation = await request(
        `/api/me/activities/${activity.id}`,
        owner,
        "PATCH",
        {
          version: activity.version,
          activity: { ...activity.config, quantityVisibility },
        },
      );
      expect(mutation.status).toBe(400);
    }
  });

  it("derives all recipient fields from the one recipient-list switch", async () => {
    for (const showRecipientList of [false, true]) {
      const draft = await create(
        input({
          showRecipientList,
          showRecipientUsername: !showRecipientList,
          showRecipientTime: !showRecipientList,
          showRecipientAmount: !showRecipientList,
        }),
      );
      expect(draft.config).toMatchObject({
        showRecipientList,
        showRecipientUsername: showRecipientList,
        showRecipientTime: showRecipientList,
        showRecipientAmount: showRecipientList,
      });
      const publicActivity = await publicView((await open(draft)).id);
      expect(publicActivity).toMatchObject({
        showRecipientList,
        showRecipientUsername: showRecipientList,
        showRecipientTime: showRecipientList,
        showRecipientAmount: showRecipientList,
      });
    }
  });

  it("treats opened inventory exhaustion as ended before lifecycle persistence", async () => {
    const activity = await open(await create());
    await env.DB.prepare(
      "UPDATE activities SET claimed_count=total_count WHERE id=?",
    )
      .bind(activity.id)
      .run();
    const publicActivity = await publicView(activity.id);
    expect(publicActivity.status).toBe("ended");
    expect(publicActivity.afterEndInfo).toBe("only-after-end");
    expect(publicActivity.quantity).toMatchObject({ remaining: 0 });
  });

  it("derives ended and archived from actual deadline and never reopens ended activities", async () => {
    const activity = await open(await create());
    const endedAt = Date.now() - 1000;
    const config = {
      ...activity.config,
      deadline: { mode: "at", at: new Date(endedAt).toISOString() },
    };
    await env.DB.prepare(
      "UPDATE activities SET deadline = ?, config = ? WHERE id = ?",
    )
      .bind(
        endedAt,
        JSON.stringify({ ...config, passwords: undefined }),
        activity.id,
      )
      .run();
    const ended = await publicView(activity.id);
    expect(ended.status).toBe("ended");
    expect(ended.afterEndInfo).toBe("only-after-end");
    const update = await request(
      `/api/me/activities/${activity.id}`,
      owner,
      "PATCH",
      {
        version: activity.version,
        activity: {
          ...activity.config,
          deadline: {
            mode: "at",
            at: new Date(Date.now() + DEFAULT_DURATION_MS).toISOString(),
          },
        },
      },
    );
    expect(update.status).toBe(400);
    expect((await open(activity)).status).toBe("ended");
    await env.DB.prepare("UPDATE activities SET deadline = ? WHERE id = ?")
      .bind(Date.now() - ARCHIVE_DELAY_MS - 1000, activity.id)
      .run();
    expect((await publicView(activity.id)).status).toBe("archived");
    const list = (await (
      await request("/api/me/activities", owner)
    ).json()) as ActivityList;
    expect(list.items[0]?.status).toBe("archived");
  });

  it("paginates owner-only histories without private inventory or skipped equal-timestamp rows", async () => {
    for (let index = 0; index < 21; index += 1)
      await create(input({ title: `活动 ${index}` }));
    await create(input(), other);
    await env.DB.prepare(
      "UPDATE activities SET created_at = 123456789 WHERE author_id = ?",
    )
      .bind(owner.id)
      .run();
    const first = (await (
      await request("/api/me/activities", owner)
    ).json()) as ActivityList;
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await request(
        `/api/me/activities?cursor=${encodeURIComponent(required(first.nextCursor))}`,
        owner,
      )
    ).json()) as ActivityList;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(21);
    expect(JSON.stringify(first)).not.toContain("private reward");
    expect((await request("/api/me/activities?cursor=bad", owner)).status).toBe(
      400,
    );
  });
});
