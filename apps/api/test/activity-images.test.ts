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
import { stopCodeActivity } from "../src/judge/stop";
import { createMerchant } from "../src/payments/merchants";
import { sha256Hex } from "../src/security/crypto";
import {
  check,
  actor as codeActor,
  coded,
  give,
  judgeSettings,
  plus,
  settings,
} from "./code-fixtures";
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

/** /api/🧧/<code>/🖼️.svg as a request carries it, or another spelling. */
function imagePath(
  activityId: string,
  file: "🖼️.svg" | "🖼.svg" | "🖼️" | "🖼" = "🖼️.svg",
) {
  return `/api/${encodeURIComponent("🧧")}/${encodeURIComponent(encodeActivityEmoji(activityId))}/${encodeURIComponent(file)}`;
}

/** "18:21:05" in a zone, as the image writes 数据截至. */
function clockIn(at: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

/** A request made at a fixed instant (the image writes the time). */
async function at<T>(instant: Date, run: () => Promise<T> | T) {
  vi.useFakeTimers({ now: instant, toFake: ["Date"] });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
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
    const path = imagePath(activity.id);

    const head = await request(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("image/svg+xml");
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
    const body = await response.text();
    expect(body).toContain("<svg");
    expect(body).toContain("图片红包活动");
    expect(body).toContain("的红包");
    expect(body).toContain(encodeActivityEmoji(activity.id));
    expect(body).toContain("查看");
    expect(body).toContain("剩余 2 份");
    expect(body).not.toContain("领取后私密说明");
    expect(body).not.toContain("公开说明");
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

  it("answers every spelling of the address and sends a tab to the 红包", async () => {
    const activity = await saveActivity();
    for (const file of ["🖼️.svg", "🖼.svg", "🖼️", "🖼"] as const) {
      const response = await request(imagePath(activity.id, file));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/svg+xml");
      expect(await response.text()).toContain("图片红包活动");
    }
    const lowercase = await request(imagePath(activity.id).toLowerCase());
    expect(lowercase.status).toBe(200);

    const nav = await request(imagePath(activity.id), {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
    });
    expect(nav.status).toBe(302);
    expect(nav.headers.get("location")).toBe(
      `/${encodeURIComponent("🧧")}/${encodeURIComponent(encodeActivityEmoji(activity.id))}`,
    );
    expect(cookieValue(nav, "__Host-hb_image_recent")).toBeNull();

    const invalid = await request(
      `/api/${encodeURIComponent("🧧")}/not-valid/${encodeURIComponent("🖼️")}.svg`,
    );
    expect(invalid.status).toBe(404);
    expect(invalid.headers.get("content-type")).toContain("image/svg+xml");
    expect(cookieValue(invalid, "__Host-hb_image_recent")).toBeNull();
    expect(await invalid.text()).toContain("红包不存在，或链接已经失效");

    const doubleEncoded = await request(
      `/api/${encodeURIComponent("🧧")}/${encodeURIComponent(encodeURIComponent(encodeActivityEmoji(activity.id)))}/${encodeURIComponent("🖼️")}.svg`,
    );
    expect(doubleEncoded.status).toBe(404);
    expect(cookieValue(doubleEncoded, "__Host-hb_image_recent")).toBeNull();

    const otherFile = await request(
      `/api/${encodeURIComponent("🧧")}/${encodeURIComponent(encodeActivityEmoji(activity.id))}/live.svg`,
    );
    expect(otherFile.status).toBe(404);
    expect(otherFile.headers.get("content-type") ?? "").not.toContain("svg");
    expect((await request(`${imagePath(activity.id)}/extra`)).status).toBe(404);
    // The retired addresses are gone.
    expect(
      (
        await request(
          `/api/e/${encodeURIComponent(encodeActivityEmoji(activity.id))}/live.svg`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(`/api/activity-images/${activity.id}.svg`)).status,
    ).toBe(404);
  });

  it("ignores forged preference and recent cookies, and supports CSRF-protected timezone and clearing", async () => {
    const activity = await saveActivity();
    const path = imagePath(activity.id);
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

    // Just past, so the clear below comes after this request (and the
    // preference cookie, a moment older, is still in date).
    const instant = new Date(Date.now() - 1_000);
    const image = await at(instant, () =>
      request(`${path}?tz=America%2FNew_York`, {
        cookie: preferenceCookie ?? undefined,
      }),
    );
    expect(await image.text()).toContain(`数据截至 ${clockIn(instant, "UTC")}`);
    const urlZone = await at(instant, () =>
      request(`${path}?tz=America%2FNew_York`),
    );
    expect(await urlZone.text()).toContain(
      `数据截至 ${clockIn(instant, "America/New_York")}`,
    );
    const invalidZone = await at(instant, () =>
      request(`${path}?tz=%2B08%3A00`),
    );
    expect(await invalidZone.text()).toContain(
      `数据截至 ${clockIn(instant, "Asia/Shanghai")}`,
    );
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
    const nextImage = await at(new Date(Date.now() + 1_000), () =>
      request(path, { cookie: preferenceCookie ?? undefined }),
    );
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
    const draftImage = await request(imagePath(draft.id));
    expect(draftImage.status).toBe(404);
    expect(cookieValue(draftImage, "__Host-hb_image_recent")).toBeNull();
    expect(await draftImage.text()).toContain("红包不存在，或链接已经失效");

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
    const legacyImage = await request(imagePath(legacyId));
    expect(legacyImage.status).toBe(404);
    expect(cookieValue(legacyImage, "__Host-hb_image_recent")).toBeNull();
  });

  it("uses main sessions ahead of image sessions and keeps image reads read-only", async () => {
    const activity = await saveActivity();
    const path = imagePath(activity.id);
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

    const privateImage = await request(path, { actor: alice });
    expect(privateImage.status).toBe(200);
    const privateBody = await privateImage.text();
    expect(privateBody).toContain("你已领取");
    expect(privateBody).toContain("1.00 LDC");
    expect(privateBody).toContain("付款处理中");
    expect(privateBody).toContain("领取于");
    // The opening plays once as the image loads.
    expect(privateBody).toContain('class="flap motion"');
    expect(cookieValue(privateImage, "__Host-hb_image_session")).toBeNull();

    const imageOnly = await request(path, {
      cookie: imageSession ?? undefined,
    });
    expect(await imageOnly.text()).toContain("1.00 LDC");
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

    const invalidMain = await request(path, {
      cookie: mergeCookies("hb_session=invalid", imageSession),
    });
    expect(invalidMain.status).toBe(200);
    const invalidMainBody = await invalidMain.text();
    expect(invalidMainBody).not.toContain("1.00 LDC");
    expect(invalidMainBody).toContain("查看");
    const emptyMain = await request(path, {
      cookie: mergeCookies("hb_session=", imageSession),
    });
    expect(await emptyMain.text()).not.toContain("1.00 LDC");
    const authorMain = await request(path, {
      cookie: mergeCookies(owner.cookie, imageSession),
    });
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
    const revoked = await request(path, {
      cookie: imageSession ?? undefined,
    });
    expect(await revoked.text()).not.toContain("1.00 LDC");
  });

  it("draws the end for everyone once it is over", async () => {
    const activity = await saveActivity();
    await claimActivity(bindings, activity.id, alice.id, direct());
    const bob = await actor();
    await claimActivity(bindings, activity.id, bob.id, direct());
    const guest = await (await request(imagePath(activity.id))).text();
    expect(guest).toContain("红包已领完");
    expect(guest).toContain('filter="url(#muted)"');
    expect(guest).not.toContain("数据可能过期");
    const stranger = await (
      await request(imagePath(activity.id), { actor: await actor() })
    ).text();
    expect(stranger).toContain("红包已领完");
    const claimed = await (
      await request(imagePath(activity.id), { actor: alice })
    ).text();
    expect(claimed).toContain("你已领取");
  });

  it("does not record navigation requests and separates draw participants", async () => {
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
    const path = imagePath(activity.id);
    await registerForDraw(bindings, activity.id, alice.id, direct());
    const nonParticipant = await actor();
    const waiting = await (await request(path, { actor: alice })).text();
    expect(waiting).toContain("已报名，等待开奖");
    const eligible = await (
      await request(path, { actor: nonParticipant })
    ).text();
    expect(eligible).toContain("已报名 1 人");
    expect(eligible).toMatch(/class="glyph"[^>]*>报</);
    vi.useFakeTimers({ now: Date.now() + 3_600_000 + 1_000 });
    try {
      const registered = await request(path, { actor: alice });
      expect(await registered.text()).toContain("开奖中");
      const stranger = await request(path);
      expect(await stranger.text()).toContain("正在开奖");
      const signedInStranger = await request(path, { actor: nonParticipant });
      const signedInBody = await signedInStranger.text();
      expect(signedInBody).toContain("正在开奖");
      expect(signedInBody).not.toContain('filter="url(#muted)"');
    } finally {
      vi.useRealTimers();
    }

    const nav = await request(path, {
      headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
    });
    expect(nav.status).toBe(302);
    expect(cookieValue(nav, "__Host-hb_image_recent")).toBeNull();
    const acceptNav = await request(path, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(acceptNav.status).toBe(302);
    const wildcard = await request(path, { headers: { Accept: "*/*" } });
    expect(wildcard.status).toBe(200);
    expect(wildcard.headers.get("content-type")).toContain("image/svg+xml");
  });
});

// Last in the file: a 代码判定红包 leaves judgments and 🐟额 entries that
// can never be deleted, so the clean-up above could not run after it.
describe("activity image of a 代码判定红包", () => {
  it("draws it in black lacquer, paused, and graphite once the 站长 stops it", async () => {
    await settings({ hongbao_enabled: 1 });
    await judgeSettings({ enabled: 1 });
    const [admin, sender, claimant, stranger] = await Promise.all([
      codeActor(),
      codeActor(),
      codeActor(),
      codeActor(),
    ]);
    await plus(sender);
    await give(admin, sender, "5.00");
    expect((await check(sender)).body.check.passed).toBe(true);
    const draft = await createActivity(bindings, sender.id, {
      requestId: crypto.randomUUID(),
      activity: coded(),
    });
    const activity = await openActivity(
      bindings,
      draft.id,
      sender.id,
      draft.version,
    );
    const path = imagePath(activity.id);
    const lacquer = (svg: string) => {
      expect(svg).toContain('fill="url(#lacquer)"');
      expect(svg).toContain('stroke="url(#rim-gold)"');
      expect(svg).not.toContain("url(#red)");
    };

    const guest = await (await request(path)).text();
    lacquer(guest);
    expect(guest).toContain("查看");
    expect(guest).toContain("剩余 3 份");
    await claimActivity(bindings, activity.id, claimant.id, {
      submissionId: crypto.randomUUID(),
      participationMode: "code",
      input: "flag{ok}",
    });
    const claimed = await (
      await request(path, { cookie: claimant.cookie })
    ).text();
    lacquer(claimed);
    expect(claimed).toContain("你已领取");
    expect(claimed).toContain("已存入🐟额");

    // Five failures in a row: claims wait, and the image says so.
    await env.DB.prepare(
      "UPDATE activity_code SET paused_at = ? WHERE activity_id = ?",
    )
      .bind(Date.now(), activity.id)
      .run();
    const paused = await (
      await request(path, { cookie: stranger.cookie })
    ).text();
    lacquer(paused);
    expect(paused).toContain("红包的代码连续出错，暂停领取");
    expect(paused).toMatch(
      /fill="url\(#faded\)"[\s\S]*class="glyph faded"[^>]*>开</,
    );
    expect(await (await request(path)).text()).toContain(
      "红包的代码连续出错，暂停领取",
    );

    await stopCodeActivity(bindings, activity.id, admin.id);
    for (const cookie of [undefined, stranger.cookie]) {
      const stopped = await (await request(path, { cookie })).text();
      expect(stopped).toContain("红包已被站长停用");
      expect(stopped).not.toContain("暂停领取");
      expect(stopped).toContain('fill="url(#graphite)"');
      expect(stopped).toContain("#5a5e65");
      expect(stopped).toContain('fill="url(#steel)"');
      expect(stopped).not.toContain('filter="url(#muted)"');
      expect(stopped).not.toContain("url(#lacquer)");
    }
  });
});
