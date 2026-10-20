import { expect, test } from "@playwright/test";
import {
  expectPath,
  identityButton,
  mockSession,
  omniboxInput,
  openApp,
  viewer,
} from "./support/app";

test.describe("外壳", () => {
  test("启动加载后进入起始页：标题、构建标记、游客的登录按钮", async ({
    page,
  }) => {
    await mockSession(page, null);
    await page.goto("/");
    await expect(page.locator("#boot")).toBeVisible();
    await openApp(page);
    await expect(page.locator("#boot")).toHaveCount(0);
    await expect(page).toHaveTitle("lafish的红包站");
    await expect(page.locator("#root")).not.toHaveAttribute("inert");
    const stamp = page.locator("#build-stamp");
    await expect(stamp).toHaveText(/^build @ [1-9]\d*$/);
    await expect(identityButton(page)).toHaveAccessibleName("登录");
    await expect(omniboxInput(page)).toBeVisible();
    await expect(
      page.getByRole("link", { name: /红包记录\s*\/history/ }),
    ).toBeVisible();
  });

  test("第三方脚本被拦截（如 Cloudflare 统计）：照常进入", async ({ page }) => {
    await mockSession(page, null);
    // Cloudflare adds its analytics beacon to the page; ad blockers refuse it.
    await page.route(
      (url) => url.pathname === "/",
      async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          "</body>",
          '<script type="module" src="https://beacon.example.test/beacon.min.js"></script></body>',
        );
        await route.fulfill({ response, body });
      },
    );
    await page.route("https://beacon.example.test/**", (route) =>
      route.abort("blockedbyclient"),
    );
    await openApp(page);
    await expect(page.locator("#boot")).toHaveCount(0);
    await expect(omniboxInput(page)).toBeVisible();
  });

  test("发布那几秒：本站的脚本第一次没取到，自己重新加载一次就进入", async ({
    page,
  }) => {
    await mockSession(page, null);
    // The bundle comes back as the page (the other version's fallback).
    let misses = 0;
    await page.route("**/src/main.tsx", (route) => {
      if (misses > 0) return route.fallback();
      misses += 1;
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>lafish的红包站</title>",
      });
    });
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    await page.goto("/");
    await expect(omniboxInput(page)).toBeVisible({ timeout: 10_000 });
    expect(misses).toBe(1);
    expect(loads).toBe(2);
    await expect(page.getByText("加载失败")).toHaveCount(0);
  });

  test("本站的脚本重试后还是没加载到：加载失败，可以重新加载", async ({
    page,
  }) => {
    await mockSession(page, null);
    await page.route("**/src/main.tsx", (route) => route.abort());
    await page.goto("/");
    await expect(page.getByText("加载失败")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "重新加载" })).toBeVisible();
    await expect(page.locator("#root")).toHaveAttribute("inert");
  });

  test("空着的输入框按时钟轮流说能输入什么，开始输入就停", async ({ page }) => {
    // Every window shows the same hint at the same moment: it follows the
    // clock, one each 2 seconds (口令, 红包链接, 帖子链接).
    const start = Math.ceil(Date.UTC(2026, 9, 20) / 6000) * 6000;
    await page.clock.setFixedTime(start);
    await mockSession(page, viewer);
    await openApp(page);
    const input = omniboxInput(page);
    // The moving placeholder is drawn over the box, not read out.
    const hint = input.locator("xpath=preceding-sibling::div[1]");
    await expect(hint).toHaveText("输入口令领取红包，或输入 / 使用命令");
    await expect(input).not.toHaveAttribute("placeholder");
    await expect(input).toHaveAccessibleName("口令、红包链接或命令");
    await page.clock.setFixedTime(start + 2000);
    await expect(hint).toHaveText("输入红包链接打开红包，或输入 / 使用命令");
    await page.clock.setFixedTime(start + 4000);
    await expect(hint).toHaveText(
      "输入帖子链接查看帖子里的红包，或输入 / 使用命令",
    );

    await input.fill("测试口令");
    await expect(hint).not.toHaveText(/使用命令/);
    await input.fill("");
    await expect(hint).toHaveText(
      "输入帖子链接查看帖子里的红包，或输入 / 使用命令",
    );
  });

  test("减少动态效果时输入框的提示不轮换", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockSession(page, viewer);
    await openApp(page);
    await expect(omniboxInput(page)).toHaveAttribute(
      "placeholder",
      "输入口令、红包链接，或输入 / 使用命令",
    );
  });

  test("跳到主要内容是 Tab 的第一站", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "跳到主要内容" }),
    ).toBeFocused();
  });

  test("输入 / 列出命令，回车进入第一条", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/help");
    await expect(page.getByRole("option", { name: /帮助/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expectPath(page, "/help");
    await expect(page.getByRole("heading", { name: "帮助" })).toBeVisible();
  });

  test("游客：要登录的命令打开登录卡片，直接打开页面看到登录提示", async ({
    page,
  }) => {
    await mockSession(page, null);
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/history");
    await expect(
      page.getByRole("option", { name: /红包记录.*需登录/ }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    const login = page.getByRole("dialog", { name: "登录" });
    await expect(login).toBeVisible();
    await expectPath(page, "/");
    // The 顶栏's 红包记录 icon asks the same way.
    await page.keyboard.press("Escape");
    await expect(login).toHaveCount(0);
    await page
      .getByRole("banner")
      .getByRole("link", { name: "红包记录" })
      .click();
    await expect(login).toBeVisible();
    await expectPath(page, "/");

    await openApp(page, "/history");
    await expect(page.getByRole("heading", { name: "红包记录" })).toBeVisible();
    await expect(page.getByText("登录后可以使用。")).toBeVisible();
    await expect(page).toHaveTitle("红包记录 · lafish的红包站");
  });

  test("帮助、运行状态和未找到页面", async ({ page }) => {
    await mockSession(page, viewer);
    await openApp(page, "/help");
    await expect(page.getByRole("heading", { name: "帮助" })).toBeVisible();
    await expect(page).toHaveTitle("帮助 · lafish的红包站");

    await page.route("**/api/health", (route) =>
      route.fulfill({ json: { status: "ok" } }),
    );
    await openApp(page, "/status");
    await expect(page.getByRole("heading", { name: "连接正常" })).toBeVisible();

    await openApp(page, "/activities/00000000-0000-4000-8000-000000000000");
    await expect(
      page.getByRole("heading", { name: "未找到页面" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "回到首页" }).click();
    await expectPath(page, "/");
  });

  test("已登录时头像打开用户卡片，名字一行通往账号资料", async ({ page }) => {
    await mockSession(page, viewer);
    await openApp(page);
    await identityButton(page).click();
    const card = page.getByRole("dialog", { name: viewer.displayName });
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: /账号资料/ })).toHaveAttribute(
      "href",
      "/me",
    );
    await expect(card.getByRole("link", { name: /红包记录/ })).toBeVisible();
    await expect(card.getByRole("link", { name: /网站管理/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(identityButton(page)).toBeFocused();
  });

  test("手机宽度满屏，构建标记仍在", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await mockSession(page, null);
    await openApp(page);
    await expect(omniboxInput(page)).toBeVisible();
    await expect(page.locator("#build-stamp")).toBeVisible();
  });
});
