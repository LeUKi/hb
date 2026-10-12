import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { LoginSettingsResponse } from "../../packages/contracts/src/login-settings";

const origin = "http://127.0.0.1:4193";
const connectAuthorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
const liteAuthorizer =
  /^https:\/\/liteauth\.442224\.xyz\/api\/auth\/oauth2\/authorize\?/;
const settingsLiteExternalId = "730007";
const settingsLiteParticipantExternalId = "730008";
type LoginRole =
  | "author"
  | "recipient"
  | "settingsLite"
  | "settingsLiteParticipant";
type SignedInSession = {
  user: {
    id: string;
    accountTier: "standard" | "lite";
    loginProvider: "connect" | "liteauth";
    canUseLdc: boolean;
    isAdmin: boolean;
  };
  csrfToken: string;
  loginOptions: { liteauthEnabled: boolean };
};

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

function callbackUrl(authorization: URL, role: string, lite: boolean) {
  expect(authorization.searchParams.get("client_id")).toBe(
    lite ? "hb_full_app_liteauth" : "hb_full_app_connect",
  );
  const callback = new URL(
    lite ? "/api/auth/liteauth/callback" : "/api/auth/callback",
    origin,
  );
  expect(authorization.searchParams.get("redirect_uri")).toBe(callback.href);
  const state = authorization.searchParams.get("state");
  expect(state).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
  callback.searchParams.set("state", state ?? "");
  if (lite) {
    expect(authorization.searchParams.get("scope")).toBe("profile");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const challenge = authorization.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    callback.searchParams.set(
      "code",
      `full-app-liteauth-code:${role}:${challenge}`,
    );
    callback.searchParams.set("iss", "https://liteauth.442224.xyz/api/auth");
  } else callback.searchParams.set("code", `full-app-code-${role}`);
  return callback;
}

async function beginLogin(context: BrowserContext, lite: boolean) {
  const response = await context.request.get(
    lite
      ? "/api/auth/liteauth/login?returnTo=%2F"
      : "/api/auth/login?returnTo=%2F",
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(302);
  const location = response.headers().location;
  if (!location) throw new Error("登录未返回授权地址");
  return new URL(location);
}

async function signIn(page: Page, role: LoginRole) {
  const lite = role === "settingsLite" || role === "settingsLiteParticipant";
  const context = page.context();
  // Only the upstream authorization page is substituted. All internal APIs,
  // callback, token exchange, D1 account and persisted session remain real.
  await context.route(
    lite ? liteAuthorizer : connectAuthorizer,
    async (route) => {
      const callback = callbackUrl(new URL(route.request().url()), role, lite);
      await route.fulfill({
        status: 302,
        headers: { Location: callback.href },
      });
    },
  );
  await page.goto((await beginLogin(context, lite)).href);
  await expect(
    page.getByRole("textbox", { name: "口令", exact: true }),
  ).toBeVisible();
  const response = await context.request.get("/api/session");
  expect(response.status()).toBe(200);
  const session = (await response.json()) as SignedInSession;
  expect(session.user.id).toBeTruthy();
  expect(session.csrfToken).toBeTruthy();
  expect(session.user.loginProvider).toBe(lite ? "liteauth" : "connect");
  return session;
}

test("正式登录开关持久化：旧青春会话保留，新登录及在途回调被阻止，重新开启后正常登录", async ({
  browser,
  request,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 6 }, () =>
      browser.newContext({ baseURL: origin, reducedMotion: "reduce" }),
    ),
  );
  const [owner, existingLite, pendingLite, guest, freshConnect, freshLite] =
    contexts;
  if (
    !owner ||
    !existingLite ||
    !pendingLite ||
    !guest ||
    !freshConnect ||
    !freshLite
  )
    throw new Error("缺少隔离浏览器上下文");
  const external = await Promise.all(contexts.map(guardExternal));
  try {
    const adminPage = await owner.newPage();
    const litePage = await existingLite.newPage();
    const admin = await signIn(adminPage, "author");
    const lite = await signIn(litePage, "settingsLite");
    expect(admin.user.isAdmin).toBe(true);
    expect(lite.user).toMatchObject({
      accountTier: "lite",
      canUseLdc: false,
      isAdmin: false,
    });
    const pendingAuthorization = await beginLogin(pendingLite, true);
    const pendingCallback = callbackUrl(
      pendingAuthorization,
      "settingsLiteParticipant",
      true,
    );
    const read = await owner.request.get("/api/admin/login-settings");
    expect(read.status()).toBe(200);
    const previous = (await read.json()) as LoginSettingsResponse;
    expect(previous.config.liteauthEnabled).toBe(true);

    await adminPage.goto("/admin/rate-limits");
    const card = adminPage.getByRole("region", {
      name: "登录方式",
      exact: true,
    });
    const toggle = card.getByRole("checkbox", {
      name: "允许 LiteAUTH 登录",
      exact: true,
    });
    await expect(
      card.getByText(
        "关闭后隐藏青春版登录入口，并阻止新的 LiteAUTH 登录；已登录用户不受影响。",
        { exact: true },
      ),
    ).toBeVisible();
    await toggle.uncheck();
    await card.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("已保存登录方式配置。");
    const savedResponse = await owner.request.get("/api/admin/login-settings");
    const saved = (await savedResponse.json()) as LoginSettingsResponse;
    expect(saved.config).toMatchObject({
      version: previous.config.version + 1,
      liteauthEnabled: false,
      updatedByUserId: admin.user.id,
    });
    expect(saved.recentChanges[0]).toMatchObject({
      actorUserId: admin.user.id,
      previousVersion: previous.config.version,
      nextVersion: saved.config.version,
      previousLiteauthEnabled: true,
      liteauthEnabled: false,
    });

    await litePage.goto("/account");
    await expect(
      litePage.getByRole("heading", { name: "账号信息", exact: true }),
    ).toBeVisible();
    await expect(
      litePage.getByRole("definition").getByText(lite.user.id, { exact: true }),
    ).toBeVisible();
    await expect(
      litePage.getByRole("button", { name: "刷新资料", exact: true }),
    ).toHaveCount(0);
    await expect(
      litePage.getByRole("button", {
        name: "通过官方 Connect 升级",
        exact: true,
      }),
    ).toBeVisible();
    const retained = await existingLite.request.get("/api/session");
    expect(await retained.json()).toMatchObject({
      user: { ...lite.user },
      loginOptions: { liteauthEnabled: false },
    });
    expect(
      (await existingLite.request.get("/api/me/history-summary")).status(),
    ).toBe(200);

    const beforeDenied = (
      await (await request.get("http://127.0.0.1:4194/state")).json()
    ).upstream;
    const denied = await guest.request.get("/api/auth/liteauth/login", {
      maxRedirects: 0,
      headers: { Accept: "application/json" },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { code: "LITEAUTH_LOGIN_DISABLED" },
    });
    const guestPage = await guest.newPage();
    await guestPage.goto("/api/auth/liteauth/login?returnTo=%2F");
    await expect(guestPage).toHaveURL(`${origin}/?authError=liteauth_disabled`);
    await expect(guestPage.getByRole("alert")).toHaveText(
      "青春版登录已关闭，请通过 LINUX DO 登录",
    );
    await guestPage
      .locator(".header-actions")
      .getByRole("link", { name: "登录", exact: true })
      .click();
    await expect(
      guestPage.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
    ).toBeVisible();
    await expect(guestPage.locator(".work-login-lite")).toHaveCount(0);
    const pendingPage = await pendingLite.newPage();
    await pendingPage.goto(pendingCallback.href);
    await expect(pendingPage).toHaveURL(
      `${origin}/?authError=liteauth_disabled`,
    );
    await expect(pendingPage.getByRole("alert")).toHaveText(
      "青春版登录已关闭，请通过 LINUX DO 登录",
    );
    await pendingPage
      .locator(".header-actions")
      .getByRole("link", { name: "登录", exact: true })
      .click();
    await expect(
      pendingPage.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
    ).toBeVisible();
    const pendingSession = await pendingLite.request.get("/api/session");
    expect(await pendingSession.json()).toMatchObject({
      user: null,
      loginOptions: { liteauthEnabled: false },
    });
    const afterDenied = (
      await (await request.get("http://127.0.0.1:4194/state")).json()
    ).upstream;
    expect(afterDenied.liteauthTokenRequests).toBe(
      beforeDenied.liteauthTokenRequests,
    );
    expect(afterDenied.liteauthProfileRequests).toBe(
      beforeDenied.liteauthProfileRequests,
    );

    const connectPage = await freshConnect.newPage();
    const connect = await signIn(connectPage, "recipient");
    expect(connect.user).toMatchObject({
      accountTier: "standard",
      canUseLdc: true,
      isAdmin: false,
    });
    await connectPage.goto("/account");
    await expect(
      connectPage.getByRole("button", { name: "刷新资料", exact: true }),
    ).toBeEnabled();
    expect(
      (await freshConnect.request.get("/api/admin/login-settings")).status(),
    ).toBe(403);
    const deniedWrite = await freshConnect.request.patch(
      "/api/admin/login-settings",
      {
        headers: { "X-CSRF-Token": connect.csrfToken, Origin: origin },
        data: { expectedVersion: saved.config.version, liteauthEnabled: true },
      },
    );
    expect(deniedWrite.status()).toBe(403);
    expect(
      (await guest.request.get("/api/admin/login-settings")).status(),
    ).toBe(401);

    await toggle.check();
    await card.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("已保存登录方式配置。");
    await expect(card).toContainText("更新于");
    const enabled = (await (
      await owner.request.get("/api/admin/login-settings")
    ).json()) as LoginSettingsResponse;
    expect(enabled.config).toMatchObject({
      version: saved.config.version + 1,
      liteauthEnabled: true,
    });
    expect(enabled.recentChanges[0]).toMatchObject({
      actorUserId: admin.user.id,
      previousLiteauthEnabled: false,
      liteauthEnabled: true,
    });
    const newLitePage = await freshLite.newPage();
    const newcomer = await signIn(newLitePage, "settingsLiteParticipant");
    expect(newcomer.loginOptions.liteauthEnabled).toBe(true);
    expect(newcomer.user).toMatchObject({
      accountTier: "lite",
      canUseLdc: false,
    });
    await newLitePage.goto("/account");
    await expect(
      newLitePage.getByRole("button", { name: "刷新资料", exact: true }),
    ).toBeEnabled();
    const final = await (
      await request.get("http://127.0.0.1:4194/state")
    ).json();
    expect(final.upstream).toMatchObject({
      liteauthTokenRequests: beforeDenied.liteauthTokenRequests + 1,
      liteauthProfileRequests: beforeDenied.liteauthProfileRequests + 1,
      distributeRequests: beforeDenied.distributeRequests,
      blockedRequests: beforeDenied.blockedRequests,
    });
    expect(final.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ external_id: settingsLiteExternalId }),
        expect.objectContaining({
          external_id: settingsLiteParticipantExternalId,
        }),
      ]),
    );
    expect(external.flat()).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
