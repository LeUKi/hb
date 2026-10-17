import { env } from "cloudflare:test";
import {
  type ActivityError,
  type ActivityInput,
  type ClaimResult,
  emptyActivityInput,
  type LdcActivityInput,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passesHumanCheck } from "../src/activities/human-check";
import {
  createActivity,
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
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";

const origin = "https://hb.example.com";
const siteverify = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The test key the Workers runtime runs with (vitest.config.ts). */
const testSiteKey = "1x00000000000000000000AA";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let alice: Actor;
let merchantId: string;
let actorNumber = 70_000;

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const number = ++actorNumber;
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: String(number),
    username: `Human${number}`,
    displayName: `参与者 ${number}`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

function post(path: string, user: Actor, body: unknown) {
  return app.request(
    `${origin}${path}`,
    {
      method: "POST",
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

const claim = (id: string, body: Record<string, unknown>) =>
  post(`/api/activities/${id}/claim`, alice, body);

function input(extra: Partial<LdcActivityInput> = {}): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "要人机验证的红包",
    participationMode: "direct",
    passwords: [],
    merchantId,
    money: { mode: "fixed", totalAmount: "2.00", count: 2 },
    humanCheck: true,
    ...extra,
  };
}

async function save(activity: ActivityInput, environment = bindings) {
  const draft = await createActivity(environment, owner.id, {
    requestId: crypto.randomUUID(),
    activity,
  });
  return openActivity(bindings, draft.id, owner.id, draft.version);
}

/** Siteverify answers with `outcome`; what it was asked is kept. */
function answer(...outcomes: unknown[]) {
  const asked: FormData[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      if (String(url) !== siteverify) throw new Error(`Unexpected ${url}`);
      asked.push(init?.body as FormData);
      const outcome = outcomes[Math.min(asked.length, outcomes.length) - 1];
      if (outcome instanceof Error) throw outcome;
      return Response.json(outcome);
    });
  return { asked, spy };
}

async function counts(id: string) {
  return env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM claims WHERE activity_id=?) AS claims,
    (SELECT COUNT(*) FROM activity_registrations WHERE activity_id=?) AS registrations,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=?) AS submissions`)
    .bind(id, id, id)
    .first();
}

beforeEach(async () => {
  [owner, alice] = await Promise.all([actor(), actor()]);
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `human_${owner.id.replaceAll("-", "")}`,
    label: "本地模拟商户",
    secret: "LOCAL-ONLY",
  });
  merchantId = merchant.id;
  await env.DB.prepare(`UPDATE attempt_rate_limits SET home_interval_seconds=5,
    activity_interval_seconds=2 WHERE id='global'`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("领取前人机验证", () => {
  it("asks before a claim would go ahead, writing nothing, then claims with a passing token", async () => {
    const activity = await save(input());
    expect(await getPublicActivity(bindings, activity.id)).toMatchObject({
      humanCheck: true,
    });
    const submissionId = crypto.randomUUID();
    const asked = await claim(activity.id, {
      submissionId,
      participationMode: "direct",
    });
    expect(asked.status).toBe(403);
    expect((await asked.json()) as ActivityError).toMatchObject({
      error: { code: "HUMAN_CHECK_REQUIRED" },
      humanCheck: { siteKey: testSiteKey, action: "claim", cData: activity.id },
    });
    expect(await counts(activity.id)).toMatchObject({
      claims: 0,
      submissions: 0,
    });

    const { asked: verified } = answer({ success: true });
    const claimed = await claim(activity.id, {
      submissionId,
      participationMode: "direct",
      humanToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
    // No cooldown was started by the request that only asked.
    expect(claimed.status).toBe(200);
    expect(((await claimed.json()) as ClaimResult).result).toBe("claimed");
    expect(verified).toHaveLength(1);
    expect(verified[0]?.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(verified[0]?.get("secret")).toBe(
      "1x0000000000000000000000000000000AA",
    );
  });

  it("asks again for a failing token, and a spent one still replays its submission", async () => {
    const activity = await save(input());
    const submissionId = crypto.randomUUID();
    const body = {
      submissionId,
      participationMode: "direct",
      humanToken: "token",
    };
    answer(
      { success: false, "error-codes": ["invalid-input-response"] },
      { success: true },
      { success: false, "error-codes": ["timeout-or-duplicate"] },
    );
    const refused = await claim(activity.id, body);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ActivityError).error.code).toBe(
      "HUMAN_CHECK_REQUIRED",
    );
    // The claim itself, without the cooldown's clock.
    const claimOf = async (response: Response) => {
      const { attemptCooldown: _clock, ...result } =
        (await response.json()) as ClaimResult & { attemptCooldown?: unknown };
      return result;
    };
    const first = await claimOf(await claim(activity.id, body));
    expect(first.result).toBe("claimed");
    // The answer was lost: 重试原提交 sends it again, token and all.
    const replay = await claim(activity.id, body);
    expect(replay.status).toBe(200);
    expect(await claimOf(replay)).toEqual(first);
    const { humanToken: _spent, ...withoutToken } = body;
    expect(await claimOf(await claim(activity.id, withoutToken))).toEqual(
      first,
    );
    expect(await counts(activity.id)).toMatchObject({ claims: 1 });
  });

  it("asks for a 口令 红包 only once the 口令 is right", async () => {
    const activity = await save(
      input({ participationMode: "password", passwords: ["Secret123"] }),
    );
    const wrong = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      password: "Wrong1234",
    });
    expect(wrong.status).toBe(200);
    expect(((await wrong.json()) as ClaimResult).result).toBe("incorrect");
    await advanceAttemptCooldown(env.DB, alice.id);
    const submissionId = crypto.randomUUID();
    const right = await claim(activity.id, {
      submissionId,
      password: "Secret123",
    });
    expect(right.status).toBe(403);
    expect(((await right.json()) as ActivityError).humanCheck).toEqual({
      siteKey: testSiteKey,
      action: "claim",
      cData: activity.id,
    });
    answer({ success: true });
    const claimed = await claim(activity.id, {
      submissionId,
      password: "Secret123",
      humanToken: "token",
    });
    expect(((await claimed.json()) as ClaimResult).result).toBe("claimed");
  });

  it("asks a timed draw's sign-up as 报名", async () => {
    const activity = await save(
      input({
        allocation: "random",
        money: {
          mode: "timed_draw",
          algorithm: "double_mean_v1",
          totalAmount: "1.00",
          count: 1,
          participantLimit: null,
          countdownSeconds: 86400,
          distributeFullPool: true,
        },
      }),
    );
    const submissionId = crypto.randomUUID();
    const asked = await claim(activity.id, {
      submissionId,
      participationMode: "direct",
    });
    expect(asked.status).toBe(403);
    expect((await asked.json()) as ActivityError).toMatchObject({
      error: { message: "报名这个红包需要先通过人机验证。" },
      humanCheck: { action: "register", cData: activity.id },
    });
    answer({ success: true });
    const registered = await claim(activity.id, {
      submissionId,
      participationMode: "direct",
      humanToken: "token",
    });
    expect(((await registered.json()) as ClaimResult).result).toBe(
      "registered",
    );
    expect(await counts(activity.id)).toMatchObject({ registrations: 1 });
  });

  it("lets the claim through when Siteverify cannot answer, and logs it", async () => {
    const activity = await save(input());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(new TypeError("network down"));
    const claimed = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      participationMode: "direct",
      humanToken: "token",
    });
    expect(((await claimed.json()) as ClaimResult).result).toBe("claimed");
    expect(logged).toHaveBeenCalledWith("human_check_unavailable", {
      activityId: activity.id,
      reason: "network",
    });
  });

  it("never calls Siteverify for a 红包 without the check", async () => {
    const activity = await save(input({ humanCheck: undefined }));
    expect(await getPublicActivity(bindings, activity.id)).not.toHaveProperty(
      "humanCheck",
    );
    const { spy } = answer({ success: true });
    const claimed = await claim(activity.id, {
      submissionId: crypto.randomUUID(),
      participationMode: "direct",
      humanToken: "token",
    });
    expect(((await claimed.json()) as ClaimResult).result).toBe("claimed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not let the server-side single-match redemption skip the check", async () => {
    const activity = await save(
      input({ participationMode: "password", passwords: ["Shared9876"] }),
    );
    const response = await post("/api/redemptions", alice, {
      submissionId: crypto.randomUUID(),
      password: "Shared9876",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ActivityError).error.code).toBe(
      "HUMAN_CHECK_REQUIRED",
    );
    expect(await counts(activity.id)).toMatchObject({ claims: 0 });
  });

  it("checks a real key's token against this site, the action and the 红包", async () => {
    const real: ApiBindings = {
      ...bindings,
      TURNSTILE_SITE_KEY: "0x4AAAAAAATestOnlyKey",
      TURNSTILE_SECRET_KEY: "test-only-secret",
    };
    const challenge = {
      siteKey: "0x4AAAAAAATestOnlyKey",
      action: "claim" as const,
      cData: "activity-1",
    };
    const passing = {
      success: true,
      hostname: "hb.example.com",
      action: "claim",
      cdata: "activity-1",
    };
    const { asked } = answer(
      passing,
      { ...passing, cdata: "activity-2" },
      { ...passing, hostname: "evil.example.com" },
      { ...passing, action: "register" },
      { success: false, "error-codes": ["invalid-input-secret"] },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const results = [];
    for (let index = 0; index < 5; index++)
      results.push(await passesHumanCheck(real, challenge, "token", "1.2.3.4"));
    expect(results).toEqual([true, false, false, false, true]);
    expect(asked[0]?.get("secret")).toBe("test-only-secret");
    expect(asked[0]?.get("remoteip")).toBe("1.2.3.4");
  });

  it("turns on only where Turnstile has keys, and stays editable after opening", async () => {
    const bare: ApiBindings = { ...bindings, TURNSTILE_SITE_KEY: "" };
    await expect(save(input(), bare)).rejects.toMatchObject({
      code: "HUMAN_CHECK_UNAVAILABLE",
    });
    const plain = await save(input({ humanCheck: undefined }));
    const on = await updateActivity(bindings, plain.id, owner.id, {
      version: plain.version,
      activity: { ...plain.config, passwords: [], humanCheck: true },
    });
    expect(on.config.humanCheck).toBe(true);
    const off = await updateActivity(bindings, on.id, owner.id, {
      version: on.version,
      activity: { ...on.config, passwords: [], humanCheck: false },
    });
    expect(off.config.humanCheck).toBe(false);
    expect(await getPublicActivity(bindings, off.id)).not.toHaveProperty(
      "humanCheck",
    );
  });
});
