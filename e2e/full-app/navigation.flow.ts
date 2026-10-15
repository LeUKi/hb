import { type BrowserContext, expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:4193";
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
