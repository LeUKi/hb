import { env } from "cloudflare:test";
import {
  emptyActivityInput,
  type LdcActivityInput,
  type LdcMoney,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { registerForDraw } from "../src/activities/registration-service";
import {
  createActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

// 领取范围 (docs/claim-scope-design.md).
const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
let ownerId: string;
let merchantId: string;

async function person(
  username: string,
  linuxDoId: string,
  trustLevel: number | null,
) {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: linuxDoId,
      username,
      displayName: `昵称${username}`,
      trustLevel,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    });
  return id;
}

function input(
  scope: LdcActivityInput["scope"],
  money: LdcMoney = { mode: "fixed", totalAmount: "1.00", count: 5 },
  extra: Partial<LdcActivityInput> = {},
): LdcActivityInput {
  const { rewardType: _rewardType, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "领取范围",
    passwords: ["scopekey1"],
    rewardType: "ldc",
    merchantId,
    money,
    scope,
    ...extra,
  };
}

async function open(activity: LdcActivityInput) {
  const saved = await createActivity(bindings, ownerId, {
    requestId: crypto.randomUUID(),
    activity,
  });
  return openActivity(bindings, saved.id, ownerId, saved.version);
}

const claim = (id: string, userId: string, password = "scopekey1") =>
  claimActivity(bindings, id, userId, {
    submissionId: crypto.randomUUID(),
    password,
  });

async function traces(userId: string) {
  return env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM redemption_submissions WHERE user_id=?) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE user_id=?) AS attempts,
    (SELECT COUNT(*) FROM account_attempt_cooldowns WHERE user_id=?) AS cooldowns`)
    .bind(userId, userId, userId)
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
      "account_attempt_cooldowns",
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
  ownerId = await person("owner", "800", 3);
  merchantId = (
    await createMerchant(bindings, ownerId, {
      requestId: crypto.randomUUID(),
      clientId: "scope_app",
      label: "虚拟商户",
      secret: "fake-only",
    })
  ).id;
});

describe("领取范围", () => {
  it("notes each name that has been here by LINUX DO ID, the rest by name, and shows them", async () => {
    await person("Known", "801", 1);
    const activity = await open(
      input({
        users: [
          { username: "known", linuxDoId: null },
          { username: "@newcomer", linuxDoId: "999" },
        ],
      }),
    );
    const managed = await getManagedActivity(bindings, activity.id, ownerId);
    const config = managed.config as LdcActivityInput;
    expect(config.scope).toEqual({
      users: [
        { username: "Known", linuxDoId: "801" },
        // An ID nobody here has is not taken on trust.
        { username: "newcomer", linuxDoId: null },
      ],
    });
    expect((await getPublicActivity(bindings, activity.id)).scope).toEqual({
      users: [
        { username: "Known", displayName: "昵称Known", avatarUrl: null },
        { username: "newcomer" },
      ],
    });
  });

  it("turns away someone outside before the 口令, its attempt or cooldown", async () => {
    const low = await person("low", "802", 1);
    const activity = await open(input({ levels: { min: 2, max: 4 } }));
    await expect(claim(activity.id, low)).rejects.toMatchObject({
      status: 403,
      code: "NOT_IN_SCOPE",
      message: "这个红包只有部分人能领",
    });
    // A wrong 口令 says nothing more.
    await expect(claim(activity.id, low, "wrongkey9")).rejects.toMatchObject({
      code: "NOT_IN_SCOPE",
    });
    expect(await traces(low)).toEqual({
      submissions: 0,
      attempts: 0,
      cooldowns: 0,
    });
  });

  it("lets in either part: a level in range, a name, a noted ID after a rename", async () => {
    const leveled = await person("leveled", "803", 3);
    const named = await person("named", "804", 0);
    const renamed = await person("before", "805", null);
    const unknownLevel = await person("unknown", "806", null);
    const activity = await open(
      input({
        levels: { min: 2, max: 4 },
        users: [
          { username: "named", linuxDoId: null },
          { username: "before", linuxDoId: null },
        ],
      }),
    );
    await env.DB.prepare("UPDATE users SET username='after' WHERE id=?")
      .bind(renamed)
      .run();
    for (const userId of [leveled, named, renamed])
      expect(await claim(activity.id, userId)).toMatchObject({
        result: "claimed",
      });
    await expect(claim(activity.id, unknownLevel)).rejects.toMatchObject({
      code: "NOT_IN_SCOPE",
    });
  });

  it("is fixed once opened; presentation still changes", async () => {
    const activity = await open(input({ levels: { min: 1, max: 4 } }));
    const managed = await getManagedActivity(bindings, activity.id, ownerId);
    const config = managed.config as LdcActivityInput;
    await expect(
      updateActivity(bindings, activity.id, ownerId, {
        version: managed.version,
        activity: { ...config, passwords: ["scopekey1"], scope: undefined },
      }),
    ).rejects.toMatchObject({ message: "开放后不能修改领取范围" });
    const edited = await updateActivity(bindings, activity.id, ownerId, {
      version: managed.version,
      activity: { ...config, passwords: ["scopekey1"], title: "新标题" },
    });
    expect((edited.config as LdcActivityInput).scope).toEqual({
      levels: { min: 1, max: 4 },
    });
  });

  it("keeps someone outside from a 限时开奖's roster", async () => {
    const low = await person("draw-low", "807", 0);
    const high = await person("draw-high", "808", 4);
    const activity = await open(
      input(
        { levels: { min: 4, max: 4 } },
        {
          mode: "timed_draw",
          algorithm: "double_mean_v1",
          totalAmount: "1.00",
          count: 1,
          participantLimit: null,
          countdownSeconds: 3600,
          distributeFullPool: true,
        },
        { allocation: "random", forceDedicated: true, joinSquare: true },
      ),
    );
    const register = (userId: string) =>
      registerForDraw(bindings, activity.id, userId, {
        submissionId: crypto.randomUUID(),
        password: "scopekey1",
      });
    await expect(register(low)).rejects.toMatchObject({
      code: "NOT_IN_SCOPE",
      message: "这个红包只有部分人能报名",
    });
    expect(await register(high)).toMatchObject({ result: "registered" });
  });

  it("finds someone by name for the form, signed in only", async () => {
    await person("Findable", "809", 2);
    const token = crypto.randomUUID();
    const now = new Date();
    await createDb(env.DB)
      .insert(sessions)
      .values({
        tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
        userId: ownerId,
        csrfToken: crypto.randomUUID(),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(Date.now() + 3600000),
      });
    const ask = (username: string, signed = true) =>
      app.request(
        `${origin}/api/people?username=${encodeURIComponent(username)}`,
        signed ? { headers: { Cookie: `hb_session=${token}` } } : {},
        bindings,
      );
    expect(await (await ask("@findable")).json()).toEqual({
      person: {
        linuxDoId: "809",
        username: "Findable",
        displayName: "昵称Findable",
        avatarUrl: null,
      },
    });
    expect(await (await ask("nobody")).json()).toEqual({ person: null });
    expect((await ask("bad name")).status).toBe(400);
    expect((await ask("findable", false)).status).toBe(401);
  });
});
