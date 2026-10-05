import { expect, test } from "@playwright/test";

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

test("首页导航和状态页直接刷新均可连接 API", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("当前兑换范围：全站兑换", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "运行状态", exact: true }).click();
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
