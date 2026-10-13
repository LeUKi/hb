import { expect, type Locator, test } from "@playwright/test";

const feedbackLabel = (button: Locator) =>
  button.locator('[aria-live="polite"]').last();

test.use({ timezoneId: "Asia/Shanghai" });

test("本浏览器图片设置保存时区和清除记录，失败保留内容", async ({ page }) => {
  await page.clock.install();
  const id = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
  let timeZone = "Asia/Shanghai";
  let recentRequest: {
    activityId: string;
    requestedAt: string;
    available: boolean;
  } | null = {
    activityId: id,
    requestedAt: "2026-10-13T01:02:03.000Z",
    available: true,
  };
  let fail = false;
  const writes: string[] = [];
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
      if (request.method() !== "GET") {
        writes.push(request.method());
        expect(request.headers()["x-csrf-token"]).toBe("image-settings-csrf");
      }
      if (fail)
        return route.fulfill({
          status: 503,
          json: { error: { message: "暂时无法读取" } },
        });
      if (request.method() === "PATCH")
        timeZone = request.postDataJSON().timeZone;
      if (request.method() === "DELETE") recentRequest = null;
      return route.fulfill({ json: { timeZone, recentRequest } });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/account");
  const panel = page.getByRole("region", { name: "本浏览器图片设置" });
  await expect(panel.getByRole("link", { name: "查看活动" })).toBeVisible();
  const save = panel.getByRole("button", { name: "保存时区" });
  await expect(save).toBeDisabled();
  await expect(panel.getByRole("option")).toHaveText([
    "北京时间",
    "使用本机时区（Asia/Shanghai）",
    "UTC",
  ]);
  await panel.getByLabel("图片时区", { exact: true }).selectOption("device");
  await expect(save).toBeDisabled();
  await panel.getByLabel("图片时区", { exact: true }).selectOption("UTC");
  await page.clock.pauseAt(Date.now() + 1_000);
  await save.click();
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await expect(save).toHaveAccessibleName("保存时区，已保存");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await page.clock.runFor(2_999);
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await page.clock.runFor(1);
  await expect(feedbackLabel(save)).toHaveText("保存时区");
  await expect(save).toBeDisabled();
  await panel.getByLabel("图片时区", { exact: true }).selectOption("device");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await expect(save).toHaveAccessibleName("保存时区，已保存");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(save).toBeDisabled();
  expect(timeZone).toBe("Asia/Shanghai");
  fail = true;
  const refresh = panel.getByRole("button", { name: /^刷新(?:，|$)/ });
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("刷新失败");
  await expect(refresh).toHaveAccessibleName("刷新，刷新失败");
  await expect(refresh).toHaveAttribute("title", "暂时无法读取");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "查看活动" })).toBeVisible();
  fail = false;
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("已刷新");
  const clear = panel.getByRole("button", { name: "清除记录" });
  await clear.click();
  await page.clock.runFor(1);
  await expect(feedbackLabel(clear)).toHaveText("已清除");
  await expect(clear).toHaveAccessibleName("清除记录，已清除");
  await expect(panel.getByText("暂无可读取的图片请求记录。")).toBeVisible();
  await expect(panel.getByRole("status")).toHaveCount(0);
  expect(writes).toEqual(["PATCH", "PATCH", "DELETE"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
