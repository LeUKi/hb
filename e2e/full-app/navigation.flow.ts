import { type BrowserContext, expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:4193";
const squareChunk = /\/assets\/square[^/]*\.js(?:\?|$)/;
const squareApi = (url: string) =>
  new URL(url).pathname === "/api/discovery/activities";
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

test("真实拆包慢导航显示目标页面骨架，保留顶栏与构建标记", async ({ page }) => {
  let releaseChunk: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  let started: () => void = () => {};
  const chunkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(squareChunk, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await page.goto("/");
  const stamp = await page.locator("#build-stamp").textContent();
  const pendingImmediately = await page
    .getByRole("link", { name: "活动广场", exact: true })
    .evaluate((link: HTMLAnchorElement) => {
      link.click();
      return Boolean(document.querySelector("[data-route-pending='true']"));
    });
  expect(pendingImmediately).toBe(false);
  await chunkStarted;
  await expect(page).toHaveURL(/\/square(?:\?|$)/);
  await page.waitForTimeout(220);
  await expect(
    page.locator("[data-route-pending='true'] [data-loading-region='page']"),
  ).toBeVisible();
  await expect(
    page.locator("header").getByRole("link", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#build-stamp")).toHaveText(stamp ?? "");
  const response = page.waitForResponse((response) =>
    squareApi(response.url()),
  );
  releaseChunk();
  expect((await response).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "活动广场", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-route-pending='true']")).toHaveCount(0);
});

test("连续导航不会被迟到页面资源覆盖", async ({ page }) => {
  let releaseChunk: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseChunk = resolve;
  });
  let started: () => void = () => {};
  const chunkStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(squareChunk, async (route) => {
    started();
    await gate;
    await route.continue();
  });
  await page.goto("/");
  await page
    .getByRole("link", { name: "活动广场", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await chunkStarted;
  await page.waitForTimeout(220);
  await expect(page.locator("[data-route-pending='true']")).toBeVisible();
  await page
    .getByRole("link", { name: "我的", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  const completed = page.waitForResponse(squareChunk);
  releaseChunk();
  expect((await completed).ok()).toBe(true);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "活动广场", exact: true }),
  ).toHaveCount(0);
});

test("页面代码加载失败提供重新加载操作，恢复后可以读取实际 API", async ({
  page,
}) => {
  await page.route(squareChunk, (route) => route.abort("failed"));
  await page.goto("/");
  await page
    .getByRole("link", { name: "活动广场", exact: true })
    .evaluate((link: HTMLAnchorElement) => link.click());
  await expect(page.getByRole("alert")).toHaveText(/页面加载失败/);
  await expect(page.locator("[data-route-pending='true']")).toHaveCount(0);
  await page.unroute(squareChunk);
  const response = page.waitForResponse((response) =>
    squareApi(response.url()),
  );
  await page.getByRole("button", { name: "重新加载页面", exact: true }).click();
  const apiResponse = await response;
  expect(apiResponse.ok()).toBe(true);
  expect(await apiResponse.json()).toMatchObject({
    items: expect.any(Array),
    total: expect.any(Number),
  });
  await expect(
    page.getByRole("heading", { name: "活动广场", exact: true }),
  ).toBeVisible();
});

for (const intent of ["hover", "focus", "touch"] as const)
  test(`导航${intent}预加载页面代码，点击前不读取业务 API`, async ({
    page,
  }) => {
    let squareRequests = 0;
    page.on("request", (request) => {
      if (squareApi(request.url())) squareRequests++;
    });
    // A previous test can leave the browser pointer over this new page's link.
    // Start away from navigation so only the chosen intent preloads the chunk.
    await page.mouse.move(0, 0);
    await page.goto("/");
    const chunkLoaded = page.waitForResponse(squareChunk);
    const link = page.getByRole("link", { name: "活动广场", exact: true });
    if (intent === "hover") await link.hover();
    else if (intent === "focus") await link.focus();
    else await link.dispatchEvent("touchstart");
    const chunk = await chunkLoaded;
    expect(chunk.ok()).toBe(true);
    await expect(page).toHaveURL("/");
    expect(squareRequests).toBe(0);
    const response = page.waitForResponse((response) =>
      squareApi(response.url()),
    );
    await link.evaluate((element: HTMLAnchorElement) => element.click());
    expect((await response).ok()).toBe(true);
    await expect(
      page.getByRole("heading", { name: "活动广场", exact: true }),
    ).toBeVisible();
    expect(squareRequests).toBeGreaterThan(0);
  });
