import { expect, test } from "@playwright/test";

test("解meme标题和秒级构建标记在切页、滚动、窄屏与刷新后保持一致", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("解meme");
  await expect(
    page.getByRole("link", { name: "解meme 首页", exact: true }),
  ).toBeVisible();
  const stamp = page.locator("#build-stamp");
  await expect(stamp).toHaveText(/^build @ [1-9]\d*$/);
  const value = await stamp.getAttribute("data-build-unix-seconds");
  const text = await stamp.textContent();
  expect(Number(value)).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000));
  expect(text).toBe(`build @ ${value}`);
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("link", { name: "活动广场", exact: true })
    .click();
  await expect(page).toHaveURL(/\/square(?:\?|$)/);
  await expect(stamp).toHaveText(text ?? "");
  await page.setViewportSize({ width: 375, height: 160 });
  const before = await stamp.boundingBox();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await stamp.boundingBox()).toEqual(before);
  expect(
    await stamp.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        position: style.position,
        fontSize: style.fontSize,
        pointerEvents: style.pointerEvents,
      };
    }),
  ).toEqual({ position: "fixed", fontSize: "9px", pointerEvents: "none" });
  await page.reload();
  await expect(stamp).toHaveText(text ?? "");
});

test("同域健康检查经过网关，并保持 API 错误响应", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });

  for (const path of ["/api", "/api/not-found"]) {
    const missing = await request.get(path, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(missing.status()).toBe(404);
    expect(missing.headers()["content-type"]).toContain("application/json");
  }
});

test("首页主导航和旧状态页直接刷新均可连接 API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  for (const name of ["兑奖", "活动广场", "活动历史", "我的"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(
    nav.getByRole("link", { name: "运行状态", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("link", { name: "我的", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByRole("region", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  await page.goto("/square");
  await expect(
    page.getByRole("heading", { name: "活动广场", exact: true }),
  ).toBeVisible();
  await page.goto("/status");
  await expect(page).toHaveURL(/\/status$/);
  await page.reload();
  await expect(page.getByTestId("health-status")).toHaveText("连接正常");
});

test("API 异常有反馈，恢复后可主动重试", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    }),
  );
  await page.goto("/status");
  await expect(page.getByTestId("health-status")).toHaveText("连接失败");
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByTestId("health-status")).toHaveText("连接正常");
});

test("窄屏页面不溢出并保留检查按钮", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/status");
  await expect(page.getByTestId("health-status")).toHaveText("连接正常");
  await expect(page.getByRole("button", { name: "重新检查" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("已有成功缓存时，新的连接失败仍会显示", async ({ page }) => {
  await page.goto("/status");
  await expect(page.getByTestId("health-status")).toHaveText("连接正常");
  await page.route("**/api/health", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByTestId("health-status")).toHaveText("连接失败");
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "重新检查" }).click();
  await expect(page.getByTestId("health-status")).toHaveText("连接正常");
});
