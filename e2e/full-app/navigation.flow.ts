import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const origin = "http://127.0.0.1:4193";
const historyChunk = /\/assets\/my\.activities-[^/]*\.js(?:\?|$)/;
const historyApi = (url: string) =>
  new URL(url).pathname === "/api/me/activities";
const squareApi = (url: string) =>
  new URL(url).pathname === "/api/discovery/activities";
const authorizer = /^https:\/\/connect\.linux\.do\/oauth2\/authorize\?/;
const unexpectedRequests = new WeakMap<BrowserContext, string[]>();

test.beforeEach(async ({ context }) => {
  const unexpected: string[] = [];
  unexpectedRequests.set(context, unexpected);
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4193(?:\/|$))/, (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://avatars.example.test")
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#ddd"/></svg>',
      });
    if (url.origin !== origin) unexpected.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
});

test.afterEach(async ({ context }) => {
  expect(unexpectedRequests.get(context)).toEqual([]);
});

async function signIn(page: Page) {
  const context = page.context();
  // Substitute only the upstream authorize screen; callback, persisted session
  // and every application business request continue through the real Workers.
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
    const callback = new URL("/api/auth/callback", origin);
    callback.searchParams.set("state", state ?? "");
    callback.searchParams.set("code", "full-app-code-recipient");
    return route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  await page.mouse.move(0, 0);
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
  const session = await context.request.get("/api/session");
  expect(session.ok()).toBe(true);
  expect(await session.json()).toMatchObject({
    user: { id: expect.any(String) },
    csrfToken: expect.any(String),
  });
}

test("真实拆包慢导航显示目标页面骨架，保留顶栏与构建标记", async ({ page }) => {
  await signIn(page);
  let releaseChunk: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  let started: () => void = () => {};
  const chunkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(historyChunk, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  const stamp = await page.locator("#build-stamp").textContent();
  const pendingImmediately = await page
    .getByRole("link", { name: "活动历史", exact: true })
    .evaluate((link: HTMLAnchorElement) => {
      link.click();
      return Boolean(document.querySelector("[data-route-pending='true']"));
    });
  expect(pendingImmediately).toBe(false);
  await chunkStarted;
  await expect(page).toHaveURL(/\/my\/activities(?:\?|$)/);
  await page.waitForTimeout(220);
  await expect(
    page.locator("[data-route-pending='true'] [data-loading-region='page']"),
  ).toBeVisible();
  await expect(
    page.locator("header").getByRole("link", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#build-stamp")).toHaveText(stamp ?? "");
  const response = page.waitForResponse((response) =>
    historyApi(response.url()),
  );
  releaseChunk();
  expect((await response).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "活动历史", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-route-pending='true']")).toHaveCount(0);
});

test("连续导航不会被迟到页面资源覆盖", async ({ page }) => {
  await signIn(page);
  let releaseChunk: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  let started: () => void = () => {};
  const chunkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(historyChunk, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await page
    .getByRole("link", { name: "活动历史", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await chunkStarted;
  await page.waitForTimeout(220);
  await expect(page.locator("[data-route-pending='true']")).toBeVisible();
  await page
    .getByRole("link", { name: "我的", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  const completed = page.waitForResponse(historyChunk);
  releaseChunk();
  expect((await completed).ok()).toBe(true);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "活动历史", exact: true }),
  ).toHaveCount(0);
});

test("页面代码加载失败提供重新加载操作，恢复后可以读取实际 API", async ({
  page,
}) => {
  await signIn(page);
  await page.route(historyChunk, (route) => route.abort("failed"));
  await page
    .getByRole("link", { name: "活动历史", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page.getByRole("alert")).toHaveText(/页面加载失败/);
  await expect(page.locator("[data-route-pending='true']")).toHaveCount(0);
  await page.unroute(historyChunk);
  const response = page.waitForResponse((response) =>
    historyApi(response.url()),
  );
  await page.getByRole("button", { name: "重新加载页面", exact: true }).click();
  const apiResponse = await response;
  expect(apiResponse.ok()).toBe(true);
  expect(await apiResponse.json()).toMatchObject({
    items: expect.any(Array),
    total: expect.any(Number),
  });
  await expect(
    page.getByRole("heading", { name: "活动历史", exact: true }),
  ).toBeVisible();
});

for (const intent of ["hover", "focus", "touch"] as const)
  test(`导航${intent}预加载页面代码，点击前不读取业务 API`, async ({
    page,
  }) => {
    let historyRequests = 0;
    page.on("request", (request) => {
      if (
        historyApi(request.url()) ||
        new URL(request.url()).pathname === "/api/me/history-summary"
      )
        historyRequests++;
    });
    // A previous test can leave the browser pointer over this new page's link.
    // Start away from navigation so only the chosen intent preloads the chunk.
    await signIn(page);
    const chunkLoaded = page.waitForResponse(historyChunk);
    const link = page.getByRole("link", { name: "活动历史", exact: true });
    if (intent === "hover") await link.hover();
    else if (intent === "focus") await link.focus();
    else await link.dispatchEvent("touchstart");
    const chunk = await chunkLoaded;
    expect(chunk.ok()).toBe(true);
    await expect(page).toHaveURL("/");
    expect(historyRequests).toBe(0);
    const response = page.waitForResponse((response) =>
      historyApi(response.url()),
    );
    await link.evaluate((element: HTMLAnchorElement) => element.click());
    expect((await response).ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: "活动历史", exact: true }),
    ).toBeVisible();
    expect(historyRequests).toBeGreaterThan(0);
  });

for (const width of [1440, 375])
  test(`真实公开活动弹窗支持返回前进与旧链接，不提交兑奖 (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const mutations: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") && request.method() !== "GET")
        mutations.push(`${request.method()} ${url.pathname}`);
    });
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: "活动广场", exact: true }),
    ).toHaveCount(0);
    const input = page.getByRole("textbox", { name: "口令", exact: true });
    await input.fill("原文保留abc123");
    const trigger = page.getByRole("button", {
      name: "已公开的活动",
      exact: true,
    });
    const response = page.waitForResponse((response) =>
      squareApi(response.url()),
    );
    await trigger.click();
    const discovery = await response;
    expect(discovery.ok()).toBe(true);
    expect(await discovery.json()).toMatchObject({
      items: expect.any(Array),
      total: expect.any(Number),
    });
    const dialog = page.getByRole("dialog", { name: "活动广场", exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    await dialog
      .getByRole("button", { name: "活动状态筛选", exact: true })
      .click();
    const endedRead = page.waitForResponse(
      (response) =>
        squareApi(response.url()) &&
        new URL(response.url()).searchParams.get("status") === "ended",
    );
    await dialog
      .getByRole("menuitemradio", { name: "已结束", exact: true })
      .click();
    expect((await endedRead).ok()).toBe(true);
    await expect(
      dialog.getByRole("button", { name: "活动状态筛选", exact: true }),
    ).toHaveText("状态：已结束");
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(input).toHaveValue("原文保留abc123");
    await expect(trigger).toBeFocused();
    await page.goForward();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "活动状态筛选", exact: true }),
    ).toHaveText("状态：已结束");
    await page.reload();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "活动状态筛选", exact: true }),
    ).toHaveText("状态：已结束");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(input).toHaveValue("");
    const legacyRead = page.waitForResponse(
      (response) =>
        squareApi(response.url()) &&
        new URL(response.url()).searchParams.get("status") === "ended",
    );
    await page.goto("/square?status=ended&type=text");
    expect((await legacyRead).ok()).toBe(true);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "活动状态筛选", exact: true }),
    ).toHaveText("状态：已结束");
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(trigger).toBeFocused();
    await page.goForward();
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: "关闭活动广场", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(trigger).toBeFocused();
    expect(mutations).toEqual([]);
  });
