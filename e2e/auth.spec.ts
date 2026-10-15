import { expect, test } from "@playwright/test";
import {
  expectPath,
  identityButton,
  mockSession,
  openApp,
  stubLogin,
  viewer,
} from "./support/app";

test.describe("登录与身份", () => {
  test("登录按钮去 LINUX DO Connect，回到当前页面", async ({ page }) => {
    await mockSession(page, null);
    const visits = await stubLogin(page);
    await openApp(page, "/help");
    await identityButton(page).click();
    const card = page.getByRole("dialog", { name: "登录" });
    await card.getByRole("button", { name: "通过 LINUX DO 登录" }).click();
    await expect.poll(() => visits.length).toBe(1);
    const login = new URL(visits[0] ?? "");
    expect(login.pathname).toBe("/api/auth/login");
    expect(login.searchParams.get("returnTo")).toBe("/help");
  });

  test("登录没完成：去掉 authError，打开卡片说明原因", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page, "/?authError=access_denied");
    const card = page.getByRole("dialog", { name: "登录" });
    await expect(card.getByText("登录已取消，可以重新尝试。")).toBeVisible();
    await expect(card.getByRole("button", { name: "再试一次" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).search).toBe("");
  });

  test("登录服务没配置：按钮暂时不可用", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page, "/?authError=auth_not_configured");
    const card = page.getByRole("dialog", { name: "登录" });
    await expect(
      card.getByRole("button", { name: "登录暂时不可用" }),
    ).toBeDisabled();
  });

  test("退出登录等服务器确认；失败时仍是登录状态并说明", async ({ page }) => {
    let signedIn = true;
    await page.route("**/api/session", (route) =>
      route.fulfill({
        json: signedIn
          ? {
              user: viewer,
              csrfToken: "csrf-e2e-token",
              attemptCooldown: {
                revision: 0,
                serverTime: Date.now(),
                nextAllowedAt: 0,
              },
            }
          : { user: null, csrfToken: null, attemptCooldown: null },
      }),
    );
    let fail = true;
    const logouts: string[] = [];
    await page.route("**/api/auth/logout", async (route) => {
      logouts.push(route.request().headers()["x-csrf-token"] ?? "");
      if (fail) {
        fail = false;
        return route.fulfill({ status: 503, json: { error: {} } });
      }
      signedIn = false;
      return route.fulfill({ json: { ok: true } });
    });
    await openApp(page);
    await identityButton(page).click();
    const card = page.getByRole("dialog", { name: viewer.displayName });
    await card.getByRole("button", { name: "退出登录" }).click();
    await expect(card.getByRole("alert")).toHaveText(
      "退出没有完成：网络或服务出了问题，你仍是登录状态。可以再试一次。",
    );
    await expect(identityButton(page)).toHaveAccessibleName(
      `${viewer.displayName}，打开用户卡片`,
    );
    await card.getByRole("button", { name: "退出登录" }).click();
    await expect(identityButton(page)).toHaveAccessibleName("登录");
    await expect(card).toHaveCount(0);
    expect(logouts).toEqual(["csrf-e2e-token", "csrf-e2e-token"]);
  });

  test("身份检查失败按游客浏览，顶栏可以重试", async ({ page }) => {
    let failing = true;
    await page.route("**/api/session", (route) =>
      failing
        ? route.fulfill({ status: 500, json: { error: {} } })
        : route.fulfill({
            json: {
              user: viewer,
              csrfToken: "csrf-e2e-token",
              attemptCooldown: {
                revision: 0,
                serverTime: Date.now(),
                nextAllowedAt: 0,
              },
            },
          }),
    );
    await openApp(page, "/history");
    await expect(identityButton(page)).toHaveAccessibleName(
      "身份检查失败，重试",
    );
    await expect(
      page.getByText("身份检查失败，请重新检查后继续。"),
    ).toBeVisible();
    failing = false;
    await identityButton(page).click();
    await expect(identityButton(page)).toHaveAccessibleName(
      `${viewer.displayName}，打开用户卡片`,
    );
    await expectPath(page, "/history");
    await expect(page.getByText("这一页正在迁移到新界面")).toBeVisible();
  });
});
