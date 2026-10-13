import { expect, test } from "@playwright/test";

test("账号页不再展示本浏览器图片设置", async ({ page }) => {
  let preferenceReads = 0;
  let preferenceWrites = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" || path === "/api/me")
      return route.fulfill({
        json: {
          user: {
            id: "image-settings-user",
            username: "viewer",
            displayName: "读者",
            avatarUrl: null,
            accountTier: "standard",
            loginProvider: "connect",
            canUseLdc: true,
            isAdmin: false,
            email: null,
          },
          csrfToken: "image-settings-csrf",
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
    if (path.startsWith("/api/me/activity-images")) {
      if (request.method() === "GET") preferenceReads += 1;
      else preferenceWrites += 1;
      return route.fulfill({
        json: { timeZone: "Asia/Shanghai", recentRequest: null },
      });
    }
    return route.fulfill({ json: { items: [] } });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "本浏览器图片设置" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("图片时区", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清除记录" })).toHaveCount(0);
  expect(preferenceReads).toBe(0);
  expect(preferenceWrites).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
