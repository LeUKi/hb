import { env } from "cloudflare:test";
import {
  type ClaimActivityInput,
  emptyActivityInput,
  encodeActivityEmoji,
  type LdcActivityInput,
} from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { registerForDraw } from "../src/activities/registration-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};

type Actor = { id: string; cookie: string; csrf: string; token: string };

let owner: Actor;
let alice: Actor;
let merchantId: string;
let actorNumber = 70_000;

function cookieValue(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(";")[0] ?? null
  );
}

function mergeCookies(...values: Array<string | null | undefined>) {
  return values.filter(Boolean).join("; ");
}

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const number = ++actorNumber;
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: String(number),
    username: `Image${number}`,
    displayName: `图片用户 ${number}`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 7 * 24 * 3_600_000),
  });
  return { id, cookie: `hb_session=${token}`, csrf, token };
}

function request(
  path: string,
  options: {
    actor?: Actor;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookie?: string;
  } = {},
) {
  const method = options.method ?? "GET";
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(options.actor || options.cookie
          ? { Cookie: mergeCookies(options.actor?.cookie, options.cookie) }
          : {}),
        ...(method === "GET" || method === "HEAD"
          ? {}
          : {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": options.actor?.csrf ?? "",
            }),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
    bindings,
  );
}

function merchantIdSeed(value: string) {
  return `${value.replaceAll("-", "")}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function directInput(extra: Partial<LdcActivityInput> = {}): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "图片红包活动",
    participationMode: "direct",
    passwords: [],
    merchantId,
    money: { mode: "fixed", totalAmount: "2.00", count: 2 },
    beforeInfo: "公开说明",
    afterClaimInfo: "领取后私密说明",
    ...extra,
  };
}

async function saveActivity(input = directInput(), open = true) {
  const draft = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open
    ? openActivity(bindings, draft.id, owner.id, draft.version)
    : draft;
}

function direct(submissionId = crypto.randomUUID()): ClaimActivityInput {
  return { submissionId, participationMode: "direct" };
}

function liveImagePath(activityId: string) {
  return `/api/e/${encodeURIComponent(encodeActivityEmoji(activityId))}/live.svg`;
}

async function counts(activityId: string) {
  return env.DB.prepare(`SELECT claimed_count AS claimed,
    (SELECT COUNT(*) FROM claims WHERE activity_id=activities.id) AS claims,
    (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id=activities.id) AS submissions,
    (SELECT COUNT(*) FROM attempt_events WHERE activity_id=activities.id) AS attempts,
    (SELECT COUNT(*) FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=activities.id) AS payments
    FROM activities WHERE id=?`)
    .bind(activityId)
    .first<{
      claimed: number;
      claims: number;
      submissions: number;
      attempts: number;
      payments: number;
    }>();
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
    env.DB.prepare("DELETE FROM activity_registrations"),
    env.DB.prepare("DELETE FROM reward_inventory"),
    env.DB.prepare("DELETE FROM activity_passwords"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare("DELETE FROM merchants"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM oauth_attempts"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  [owner, alice] = await Promise.all([actor(), actor()]);
  const merchant = await createMerchant(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    clientId: `image_${merchantIdSeed(owner.id)}`,
    label: "图片测试商户",
    secret: "LOCAL-ONLY",
  });
  merchantId = merchant.id;
});

describe("activity image APIs", () => {
  it("serves opened LDC images as no-store SVG and records only successful GETs", async () => {
    const activity = await saveActivity();
    const path = `/api/activity-images/${activity.id}.svg`;

    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("image/svg+xml");
    expect(head.headers.getSetCookie()).toEqual([]);
    expect(await head.text()).toBe("");

    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("图片红包活动");
    expect(body).not.toContain("领取后私密说明");
    const recentCookie = cookieValue(response, "__Host-hb_image_recent");
    expect(recentCookie).toBeTruthy();
    expect(recentCookie).not.toContain(activity.id);

    const prefs = await request("/api/me/activity-images", {
      actor: alice,
      cookie: mergeCookies(alice.cookie, recentCookie),
    });
    expect(prefs.status).toBe(200);
    expect(await prefs.json()).toMatchObject({
      timeZone: "Asia/Shanghai",
      recentRequest: { activityId: activity.id, available: true },
    });
    expect(cookieValue(prefs, "__Host-hb_image_session")).toBeTruthy();
  });

  it("serves emoji live aliases with the same readonly image contract", async () => {
    const activity = await saveActivity();
    const path = liveImagePath(activity.id);

    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("image/svg+xml");
    expect(head.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(head.headers.getSetCookie()).toEqual([]);
    expect(await head.text()).toBe("");

    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(await response.text()).toContain("图片红包活动");
    const recentCookie = cookieValue(response, "__Host-hb_image_recent");
    expect(recentCookie).toBeTruthy();
    expect(recentCookie).not.toContain(activity.id);

    const nav = await request(path, {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
    });
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe(
      `/e/${encodeURIComponent(encodeActivityEmoji(activity.id))}`,
    );
    expect(cookieValue(nav, "__Host-hb_image_recent")).toBeNull();

    const invalid = await request(
      `/api/e/${encodeURIComponent("not-valid")}/live.svg`,
    );
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("content-type")).toContain("image/svg+xml");
    expect(cookieValue(invalid, "__Host-hb_image_recent")).toBeNull();
    expect(await invalid.text()).toContain("活动不可用");

    const doubleEncoded = await request(
      `/api/e/${encodeURIComponent(encodeURIComponent(encodeActivityEmoji(activity.id)))}/live.svg`,
    );
    expect(doubleEncoded.status).toBe(404);
    expect(cookieValue(doubleEncoded, "__Host-hb_image_recent")).toBeNull();

    const extra = await request(`${path}/extra`);
    expect(extra.status).toBe(404);
  });

  it("ignores forged preference and recent cookies, and supports CSRF-protected timezone and clearing", async () => {
    const activity = await saveActivity();
    const forged = mergeCookies(
      `__Host-hb_image_preferences=${btoa(JSON.stringify({ timeZone: "UTC" }))}`,
      `__Host-hb_image_recent=${btoa(JSON.stringify({ activityId: activity.id, requestedAt: Date.now() }))}`,
      `__Host-hb_image_recent_clear=${"x".repeat(5000)}`,
    );
    const ignored = await request("/api/me/activity-images", {
      actor: alice,
      cookie: mergeCookies(alice.cookie, forged),
    });
    expect(await ignored.json()).toMatchObject({
      timeZone: "Asia/Shanghai",
      recentRequest: null,
    });

    const saved = await request("/api/me/activity-images", {
      actor: alice,
      method: "PATCH",
      body: { timeZone: "UTC" },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ timeZone: "UTC" });
    const preferenceCookie = cookieValue(saved, "__Host-hb_image_preferences");
    expect(preferenceCookie).toBeTruthy();
    expect(preferenceCookie).not.toContain("UTC");

    const image = await request(
      `/api/activity-images/${activity.id}.svg?tz=America%2FNew_York`,
      { cookie: preferenceCookie ?? undefined },
    );
    expect(await image.text()).toContain('data-timezone="UTC"');
    const urlZone = await request(
      `/api/activity-images/${activity.id}.svg?tz=America%2FNew_York`,
    );
    expect(await urlZone.text()).toContain('data-timezone="America/New_York"');
    const invalidZone = await request(
      `/api/activity-images/${activity.id}.svg?tz=%2B08%3A00`,
    );
    expect(await invalidZone.text()).toContain('data-timezone="Asia/Shanghai"');
    const recentCookie = cookieValue(image, "__Host-hb_image_recent");

    const cleared = await request("/api/me/activity-images/recent-request", {
      actor: alice,
      method: "DELETE",
      cookie: mergeCookies(alice.cookie, recentCookie),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ recentRequest: null });
    const clearCookie = cookieValue(cleared, "__Host-hb_image_recent_clear");
    const oldAfterClear = await request("/api/me/activity-images", {
      actor: alice,
      cookie: mergeCookies(alice.cookie, recentCookie, clearCookie),
    });
    expect(await oldAfterClear.json()).toMatchObject({ recentRequest: null });
    // Only a request after the clear is shown. The Workers clock can still read
    // the clear's millisecond here, so move it forward explicitly.
    vi.useFakeTimers({ now: Date.now() + 1_000, toFake: ["Date"] });
    let nextImage: Response;
    try {
      nextImage = await request(`/api/activity-images/${activity.id}.svg`, {
        cookie: preferenceCookie ?? undefined,
      });
    } finally {
      vi.useRealTimers();
    }
    const nextRecentCookie = cookieValue(nextImage, "__Host-hb_image_recent");
    const newAfterClear = await request("/api/me/activity-images", {
      actor: alice,
      cookie: mergeCookies(alice.cookie, nextRecentCookie, clearCookie),
    });
    expect(await newAfterClear.json()).toMatchObject({
      recentRequest: { activityId: activity.id, available: true },
    });
    vi.useFakeTimers({ now: Date.now() + 31 * 24 * 3_600_000 });
    try {
      const futureViewer = await actor();
      const expired = await request("/api/me/activity-images", {
        cookie: mergeCookies(
          futureViewer.cookie,
          preferenceCookie,
          nextRecentCookie,
        ),
      });
      expect(await expired.json()).toMatchObject({
        timeZone: "Asia/Shanghai",
        recentRequest: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes drafts and retired text activities without writing recent records", async () => {
    const draft = await saveActivity(directInput(), false);
    const draftImage = await request(`/api/activity-images/${draft.id}.svg`);
    expect(draftImage.status).toBe(404);
    expect(cookieValue(draftImage, "__Host-hb_image_recent")).toBeNull();
    expect(await draftImage.text()).toContain("活动不可用");

    const legacyId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,version,title,reward_type,force_dedicated,participation_mode,join_square,allocation,config,total_count,claimed_count,registered_count,created_at,updated_at,opened_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        legacyId,
        owner.id,
        crypto.randomUUID(),
        "legacy-digest",
        1,
        "旧文本活动",
        "text",
        0,
        "password",
        0,
        "sequential",
        JSON.stringify("unusable-legacy-config"),
        1,
        0,
        0,
        now,
        now,
        now,
      )
      .run();
    const legacyImage = await request(`/api/activity-images/${legacyId}.svg`);
    expect(legacyImage.status).toBe(404);
    expect(cookieValue(legacyImage, "__Host-hb_image_recent")).toBeNull();
  });

  it("uses main sessions ahead of image sessions and keeps image reads read-only", async () => {
    const activity = await saveActivity();
    const alias = liveImagePath(activity.id);
    await claimActivity(bindings, activity.id, alice.id, direct());
    await env.DB.batch([
      env.DB.prepare("DELETE FROM payment_outbox"),
      env.DB.prepare("DELETE FROM payment_attempts"),
      env.DB.prepare("DELETE FROM simulation_orders"),
      env.DB.prepare("DELETE FROM payment_tasks"),
    ]);
    const before = await counts(activity.id);
    const lastSeenBefore = await env.DB.prepare(
      "SELECT last_seen_at AS value FROM sessions WHERE user_id=?",
    )
      .bind(alice.id)
      .first<{ value: number }>();
    const imageSessionResponse = await request("/api/me/activity-images", {
      actor: alice,
    });
    const imageSession = cookieValue(
      imageSessionResponse,
      "__Host-hb_image_session",
    );
    expect(imageSession).toBeTruthy();

    const privateImage = await request(
      `/api/activity-images/${activity.id}.svg`,
      {
        actor: alice,
      },
    );
    expect(privateImage.status).toBe(200);
    const privateBody = await privateImage.text();
    expect(privateBody).toContain("1.00 LDC");
    expect(privateBody).toContain("付款处理中");
    expect(privateBody).toContain("upper-open 1200ms");
    expect(cookieValue(privateImage, "__Host-hb_image_session")).toBeNull();

    const legacyReduced = await request(
      `/api/activity-images/${activity.id}.svg?motion=reduced`,
      { actor: alice },
    );
    const legacyReducedBody = await legacyReduced.text();
    expect(legacyReducedBody).toContain("1.00 LDC");
    expect(legacyReducedBody).toContain("upper-open 1200ms");

    const privateAlias = await request(alias, { actor: alice });
    expect(privateAlias.status).toBe(200);
    expect(await privateAlias.text()).toContain("1.00 LDC");
    const fallbackAlias = await request(`${alias}?fallback=public`, {
      actor: alice,
    });
    expect(fallbackAlias.status).toBe(200);
    expect(await fallbackAlias.text()).not.toContain("1.00 LDC");
    expect(cookieValue(fallbackAlias, "__Host-hb_image_recent")).toBeNull();

    const imageOnlyMe = await request("/api/me/activity-images", {
      cookie: imageSession ?? undefined,
    });
    expect(imageOnlyMe.status).toBe(401);
    const imageOnlyClaim = await request(
      `/api/activities/${activity.id}/claim`,
      {
        method: "POST",
        body: direct(),
        cookie: imageSession ?? undefined,
        headers: { Origin: origin, "X-CSRF-Token": alice.csrf },
      },
    );
    expect(imageOnlyClaim.status).toBe(401);

    const invalidMain = await request(
      `/api/activity-images/${activity.id}.svg`,
      {
        cookie: mergeCookies("hb_session=invalid", imageSession),
      },
    );
    expect(invalidMain.status).toBe(200);
    const invalidMainBody = await invalidMain.text();
    expect(invalidMainBody).not.toContain("1.00 LDC");
    expect(invalidMainBody).toContain("查看");
    const emptyMain = await request(`/api/activity-images/${activity.id}.svg`, {
      cookie: mergeCookies("hb_session=", imageSession),
    });
    expect(await emptyMain.text()).not.toContain("1.00 LDC");
    const authorMain = await request(
      `/api/activity-images/${activity.id}.svg`,
      {
        cookie: mergeCookies(owner.cookie, imageSession),
      },
    );
    expect(await authorMain.text()).not.toContain("1.00 LDC");

    expect(await counts(activity.id)).toEqual(before);
    const lastSeenAfter = await env.DB.prepare(
      "SELECT last_seen_at AS value FROM sessions WHERE user_id=?",
    )
      .bind(alice.id)
      .first<{ value: number }>();
    expect(lastSeenAfter?.value).toBe(lastSeenBefore?.value);

    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?")
      .bind(alice.id)
      .run();
    const revoked = await request(`/api/activity-images/${activity.id}.svg`, {
      cookie: imageSession ?? undefined,
    });
    expect(await revoked.text()).not.toContain("1.00 LDC");
  });

  it("does not record fallback or navigation requests and separates draw participants", async () => {
    const activity = await saveActivity(
      directInput({
        allocation: "random",
        deadline: { mode: "duration", value: 1, unit: "hours" },
        money: {
          mode: "timed_draw",
          algorithm: "bounded_mean_v1",
          totalAmount: "2.00",
          count: 1,
          participantLimit: null,
          countdownSeconds: 600,
          distributeFullPool: true,
        },
      }),
    );
    await registerForDraw(bindings, activity.id, alice.id, direct());
    const nonParticipant = await actor();
    vi.useFakeTimers({ now: Date.now() + 3_600_000 + 1_000 });
    try {
      const registered = await request(
        `/api/activity-images/${activity.id}.svg`,
        {
          actor: alice,
        },
      );
      expect(await registered.text()).toContain("开奖中");
      const stranger = await request(`/api/activity-images/${activity.id}.svg`);
      expect(await stranger.text()).toContain("开奖中");
      const signedInStranger = await request(
        `/api/activity-images/${activity.id}.svg`,
        { actor: nonParticipant },
      );
      const signedInBody = await signedInStranger.text();
      expect(signedInBody).toContain('data-state="drawing"');
      expect(signedInBody).not.toContain("已结束");
    } finally {
      vi.useRealTimers();
    }

    const fallback = await request(
      `/api/activity-images/${activity.id}.svg?fallback=public`,
      { actor: alice },
    );
    expect(fallback.status).toBe(200);
    expect(cookieValue(fallback, "__Host-hb_image_recent")).toBeNull();
    const nav = await request(`/api/activity-images/${activity.id}.svg`, {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
    });
    expect(nav.status).toBe(302);
    expect(cookieValue(nav, "__Host-hb_image_recent")).toBeNull();
    const acceptNav = await request(`/api/activity-images/${activity.id}.svg`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(acceptNav.status).toBe(302);
    const wildcard = await request(`/api/activity-images/${activity.id}.svg`, {
      headers: { Accept: "*/*" },
    });
    expect(wildcard.status).toBe(200);
    expect(wildcard.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("redirects top-level document navigation to the matching activity", async () => {
    const activity = await saveActivity();
    const response = await request(`/api/activity-images/${activity.id}.svg`, {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/activities/${activity.id}`);
  });
});
