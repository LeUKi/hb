import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  type AttemptCooldown,
  type AttemptRateLimitsResponse,
  type ClaimActivityInput,
  emptyActivityInput,
  type GlobalRedemptionResult,
  type ManagedActivity,
  type TextActivityInput,
} from "../../packages/contracts/src";

const origin = "http://127.0.0.1:4193";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
const reward = "FULL-APP-COOLDOWN-REWARD";
type Session = {
  user: { id: string; isAdmin: boolean };
  csrfToken: string;
  attemptCooldown: AttemptCooldown | null;
};

function cooldownTimer(page: Page) {
  return page.getByRole("timer").filter({ hasText: "秒后可重试" });
}

function claimCooldownButton(page: Page) {
  return page.getByRole("button", { name: /^还需等待 \d+ 秒$/ });
}

async function guardExternal(context: BrowserContext) {
  const unexpected: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "https://avatars.example.test")
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
      });
    unexpected.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  return unexpected;
}

async function signIn(page: Page, role: "author" | "recipient") {
  const context = page.context();
  // Only the upstream authorization page is substituted. State, callback,
  // token exchange, persisted account and session remain real application code.
  await context.route(authorizer, async (route) => {
    const authorization = new URL(route.request().url());
    expect(authorization.searchParams.get("client_id")).toBe(
      "hb_full_app_connect",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback`,
    );
    const state = authorization.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    const callback = new URL(`${origin}/api/auth/callback`);
    callback.searchParams.set("state", state ?? "");
    callback.searchParams.set("code", `full-app-code-${role}`);
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  const login = await context.request.get("/api/auth/login?returnTo=%2F", {
    maxRedirects: 0,
  });
  expect(login.status()).toBe(302);
  const authorizationUrl = login.headers().location;
  if (!authorizationUrl) throw new Error("登录未返回授权地址");
  await page.goto(authorizationUrl);
  await expect(
    page.getByRole("textbox", { name: "口令", exact: true }),
  ).toBeVisible();
  const response = await context.request.get("/api/session");
  expect(response.ok()).toBe(true);
  const session = (await response.json()) as Session;
  expect(session.user.id).toBeTruthy();
  expect(session.csrfToken).toBeTruthy();
  return session;
}

test("正式账号冷却跨页面和刷新，发现后以服务端编号自动领取一次", async ({
  browser,
  request,
}) => {
  const author = await browser.newContext({ baseURL: origin });
  const recipient = await browser.newContext({ baseURL: origin });
  const external = await Promise.all([author, recipient].map(guardExternal));
  try {
    const authorPage = await author.newPage();
    const page = await recipient.newPage();
    const owner = await signIn(authorPage, "author");
    const viewer = await signIn(page, "recipient");
    const initial = await request.get("http://127.0.0.1:4194/state");
    expect(initial.ok()).toBe(true);
    const initialUpstream = (await initial.json()).upstream as {
      blockedRequests: number;
      distributeRequests: number;
    };
    expect(owner.user.isAdmin).toBe(true);
    expect(viewer.user.isAdmin).toBe(false);
    const configRead = await author.request.get("/api/admin/rate-limits");
    expect(configRead.status()).toBe(200);
    const previous = (await configRead.json()) as AttemptRateLimitsResponse;
    const headers = { "X-CSRF-Token": owner.csrfToken, Origin: origin };
    const configSaved = await author.request.patch("/api/admin/rate-limits", {
      headers,
      data: {
        expectedVersion: previous.config.version,
        homeIntervalSeconds: 5,
        activityIntervalSeconds: 2,
      },
    });
    expect(configSaved.status()).toBe(200);
    expect(await configSaved.json()).toMatchObject({
      config: {
        version: previous.config.version + 1,
        homeIntervalSeconds: 5,
        activityIntervalSeconds: 2,
      },
      recentChanges: expect.arrayContaining([
        expect.objectContaining({
          actorUserId: owner.user.id,
          previousVersion: previous.config.version,
        }),
      ]),
    });
    expect(
      (await recipient.request.get("/api/admin/rate-limits")).status(),
    ).toBe(403);
    const password = `Cool${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const title = `完整应用共享冷却 ${randomUUID().slice(0, 8)}`;
    const input: TextActivityInput = {
      ...emptyActivityInput(),
      title,
      passwords: [password],
      rewards: [{ id: randomUUID(), text: reward }],
      joinSquare: true,
      showRecipientList: false,
    };
    const saved = await author.request.post("/api/activities", {
      headers,
      data: {
        requestId: randomUUID(),
        activity: input,
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const { activity } = (await saved.json()) as { activity: ManagedActivity };
    const opened = await author.request.post(
      `/api/me/activities/${activity.id}/open`,
      {
        headers,
        data: { version: activity.version },
      },
    );
    expect(opened.ok()).toBe(true);

    const firstAttempt = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/redemptions/discover",
    );
    await page
      .getByLabel("口令", { exact: true })
      .fill(`Absent${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    const first = (await (await firstAttempt).json()) as GlobalRedemptionResult;
    expect(first.result).toBe("none");
    expect(first.attemptCooldown).toBeDefined();
    expect(
      (first.attemptCooldown?.nextAllowedAt ?? 0) -
        (first.attemptCooldown?.serverTime ?? 0),
    ).toBeLessThanOrEqual(5_000);
    await expect(cooldownTimer(page)).toContainText(/\d+ 秒后可重试/);

    // A second real internal request is rejected before activity validation;
    // changing pages cannot create another independent allowance.
    const blocked = await recipient.request.post(
      `/api/activities/${activity.id}/claim`,
      {
        headers: { "X-CSRF-Token": viewer.csrfToken, Origin: origin },
        data: {
          submissionId: randomUUID(),
          password: "BlockedNow123",
        },
      },
    );
    expect(blocked.status()).toBe(429);
    expect(Number(blocked.headers()["retry-after"])).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({
      error: { code: "CLAIM_RATE_LIMITED" },
      attemptCooldown: {
        revision: first.attemptCooldown?.revision,
        nextAllowedAt: first.attemptCooldown?.nextAllowedAt,
      },
    });
    await page
      .locator(".desktop-nav")
      .getByRole("link", { name: "活动广场" })
      .click();
    await page
      .getByRole("row")
      .filter({ hasText: title })
      .getByRole("link", { name: "查看活动", exact: true })
      .click();
    await expect(page).toHaveURL(`/activities/${activity.id}`);
    await expect(cooldownTimer(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "领取奖励", exact: true }),
    ).toHaveCount(0);
    await expect(claimCooldownButton(page)).toBeDisabled();
    await page.reload();
    await expect(cooldownTimer(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "领取奖励", exact: true }),
    ).toHaveCount(0);
    await expect(claimCooldownButton(page)).toBeDisabled();
    const reloadedSession = await recipient.request.get("/api/session");
    expect(await reloadedSession.json()).toMatchObject({
      attemptCooldown: {
        revision: first.attemptCooldown?.revision,
        nextAllowedAt: first.attemptCooldown?.nextAllowedAt,
      },
    });
    await expect(cooldownTimer(page)).toHaveCount(0, { timeout: 7_000 });
    await expect(
      page.getByRole("button", { name: "领取奖励", exact: true }),
    ).toBeEnabled();
    await page
      .locator(".desktop-nav")
      .getByRole("link", { name: "兑奖", exact: true })
      .click();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(
      page.getByRole("button", { name: "兑奖", exact: true }),
    ).toHaveCount(0);

    const claimRequests: ClaimActivityInput[] = [];
    page.on("request", (outgoing) => {
      if (
        outgoing.method() === "POST" &&
        new URL(outgoing.url()).pathname ===
          `/api/activities/${activity.id}/claim`
      ) {
        expect(new URL(page.url()).pathname).toBe(`/activities/${activity.id}`);
        claimRequests.push(outgoing.postDataJSON());
      }
    });
    const matchingResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/redemptions/discover",
    );
    await page.getByLabel("口令", { exact: true }).fill(password);
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    const matched = (await (
      await matchingResponse
    ).json()) as GlobalRedemptionResult;
    expect(matched.result).toBe("single");
    expect(matched.claimSubmissionId).toMatch(/^[a-f0-9-]{36}$/i);
    await expect(page).toHaveURL(`/activities/${activity.id}`);
    await expect(page.locator("pre").filter({ hasText: reward })).toHaveText(
      reward,
    );
    expect(claimRequests).toEqual([
      {
        submissionId: matched.claimSubmissionId,
        password,
        discoveryId: matched.id,
      },
    ]);
    await page.reload();
    await expect(page.locator("pre").filter({ hasText: reward })).toHaveText(
      reward,
    );
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/`);
    const localHistory = page.getByRole("region", { name: "尝试历史" });
    await expect(localHistory.locator("li")).toHaveCount(2);
    await expect(
      localHistory.getByText("已匹配", { exact: true }),
    ).toBeVisible();
    await expect(
      localHistory.getByText("未匹配", { exact: true }),
    ).toBeVisible();
    await expect(localHistory).not.toContainText(title);
    await localHistory
      .getByRole("button", { name: `填入口令 ${password}`, exact: true })
      .click();
    await expect(page.getByLabel("口令", { exact: true })).toHaveValue(
      password,
    );
    await page.goForward();
    await expect(page.locator("pre").filter({ hasText: reward })).toHaveText(
      reward,
    );
    expect(claimRequests).toHaveLength(1);
    await page.getByRole("button", { name: "分享活动", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "复制口令1", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const observation = await request.get("http://127.0.0.1:4194/state");
    expect(observation.ok()).toBe(true);
    const state = (await observation.json()) as {
      claims: Array<{ activity_id: string; user_id: string }>;
      upstream: { blockedRequests: number; distributeRequests: number };
    };
    expect(
      state.claims.filter(
        (claim) =>
          claim.activity_id === activity.id && claim.user_id === viewer.user.id,
      ),
    ).toHaveLength(1);
    expect(state.upstream.blockedRequests).toBe(
      initialUpstream.blockedRequests,
    );
    expect(state.upstream.distributeRequests).toBe(
      initialUpstream.distributeRequests,
    );
    expect(external.flat()).toEqual([]);
  } finally {
    await Promise.allSettled([author.close(), recipient.close()]);
  }
});
