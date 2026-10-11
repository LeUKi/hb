import { expect, type Page, test } from "@playwright/test";
import type {
  AttemptRateLimitsResponse,
  UpdateAttemptRateLimitsInput,
} from "../packages/contracts/src";
import type {
  LoginSettingsResponse,
  UpdateLoginSettingsInput,
} from "../packages/contracts/src/login-settings";

const description =
  "关闭后隐藏青春版登录入口，并阻止新的 LiteAUTH 登录；已登录用户不受影响。";
const admin = {
  id: "login-settings-admin",
  username: "admin",
  displayName: "登录配置管理员",
  avatarUrl: null,
  email: "admin@example.test",
  accountTier: "standard" as "standard" | "lite",
  loginProvider: "connect" as "connect" | "liteauth",
  canUseLdc: true,
  isAdmin: true,
};

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function refocus(page: Page) {
  const response = page.waitForResponse(
    (incoming) => new URL(incoming.url()).pathname === "/api/session",
  );
  await page.evaluate(() => {
    const previous = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    window.dispatchEvent(new Event("visibilitychange"));
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  });
  await response;
}

async function mockSettings(
  page: Page,
  initialUser: typeof admin | null = null,
) {
  const state = {
    user: initialUser,
    optionsKnown: true,
    settings: {
      config: {
        version: 1,
        liteauthEnabled: true,
        updatedAt: Date.now(),
        updatedByUserId: null,
      },
      recentChanges: [],
    } as LoginSettingsResponse,
    rateLimits: {
      config: {
        version: 1,
        homeIntervalSeconds: 60,
        activityIntervalSeconds: 60,
        updatedAt: Date.now(),
        updatedByUserId: null,
      },
      recentChanges: [],
    } as AttemptRateLimitsResponse,
    sessionDelay: null as ReturnType<typeof gate> | null,
    saveDelay: null as ReturnType<typeof gate> | null,
    denySave: false,
    paths: [] as string[],
    writes: [] as UpdateLoginSettingsInput[],
    rateWrites: [] as UpdateAttemptRateLimitsInput[],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    state.paths.push(url.pathname);
    if (url.pathname === "/api/session") {
      await state.sessionDelay?.wait;
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: state.user ? "csrf" : null,
          attemptCooldown: null,
          ...(state.optionsKnown
            ? {
                loginOptions: {
                  liteauthEnabled: state.settings.config.liteauthEnabled,
                },
              }
            : {}),
        },
      });
    }
    if (url.pathname === "/api/me")
      return route.fulfill({ json: { user: state.user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities")
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    if (url.pathname === "/api/auth/logout") {
      expect(request.method()).toBe("POST");
      expect(request.headers()["x-csrf-token"]).toBe("csrf");
      state.user = null;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/admin/rate-limits") {
      if (request.method() === "GET")
        return route.fulfill({ json: state.rateLimits });
      const input = request.postDataJSON() as UpdateAttemptRateLimitsInput;
      state.rateWrites.push(input);
      state.rateLimits = {
        config: {
          ...state.rateLimits.config,
          version: state.rateLimits.config.version + 1,
          homeIntervalSeconds: input.homeIntervalSeconds,
          activityIntervalSeconds: input.activityIntervalSeconds,
        },
        recentChanges: [],
      };
      return route.fulfill({ json: state.rateLimits });
    }
    if (url.pathname === "/api/admin/login-settings") {
      if (request.method() === "GET")
        return route.fulfill({ json: state.settings });
      const input = request.postDataJSON() as UpdateLoginSettingsInput;
      state.writes.push(input);
      expect(request.headers()["x-csrf-token"]).toBe("csrf");
      if (state.denySave) {
        state.user = state.user && { ...state.user, isAdmin: false };
        return route.fulfill({
          status: 403,
          json: {
            error: { code: "ADMIN_REQUIRED", message: "此页面仅限管理员访问" },
          },
        });
      }
      if (input.expectedVersion !== state.settings.config.version)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "LOGIN_SETTINGS_CONFLICT",
              message:
                "登录方式已在其他页面修改。当前输入已保留，请重新读取最新配置。",
            },
          },
        });
      const previous = state.settings.config;
      state.settings = {
        config: {
          ...previous,
          version: previous.version + 1,
          liteauthEnabled: input.liteauthEnabled,
          updatedAt: Date.now(),
          updatedByUserId: state.user?.id ?? null,
        },
        recentChanges: [
          {
            id: `login-change-${previous.version + 1}`,
            actorUserId: state.user?.id ?? "",
            actorDisplayName: state.user?.displayName ?? "",
            previousVersion: previous.version,
            nextVersion: previous.version + 1,
            previousLiteauthEnabled: previous.liteauthEnabled,
            liteauthEnabled: input.liteauthEnabled,
            createdAt: Date.now(),
          },
          ...state.settings.recentChanges,
        ],
      };
      const saved = state.settings;
      await state.saveDelay?.wait;
      return route.fulfill({ json: saved });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return state;
}

function loginCard(page: Page) {
  return page.getByRole("region", { name: "登录方式", exact: true });
}

function rateForm(page: Page) {
  return page
    .locator("form")
    .filter({ has: page.getByLabel("首页尝试间隔（秒）", { exact: true }) });
}

test("未知及关闭状态不闪现青春版入口，开启后展开，关闭移除焦点并保留官方登录", async ({
  page,
}) => {
  const canceledSessionRequests: string[] = [];
  let sessionResponses = 0;
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/session")
      canceledSessionRequests.push(request.failure()?.errorText ?? "unknown");
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/session") sessionResponses++;
  });
  const state = await mockSettings(page);
  state.settings.config.liteauthEnabled = false;
  state.sessionDelay = gate();
  await page.goto(
    "/account?returnTo=%2Fmy%2Fclaims&authError=liteauth_disabled",
  );
  await expect.poll(() => state.paths.includes("/api/session")).toBe(true);
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  await page.evaluate(() => {
    Object.assign(window, { liteLoginFlashed: false });
    new MutationObserver(() => {
      if (document.querySelector(".work-login-lite"))
        Object.assign(window, { liteLoginFlashed: true });
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  const coldReadsBeforeRelease = state.paths.filter(
    (path) => path === "/api/session",
  ).length;
  state.sessionDelay.release();
  const connect = page.getByRole("link", {
    name: "通过LINUX DO登录",
    exact: true,
  });
  await expect(connect).toHaveAttribute(
    "href",
    "/api/auth/login?returnTo=%2Fmy%2Fclaims",
  );
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "liteLoginFlashed")),
  ).toBe(false);
  expect(state.paths.every((path) => path === "/api/session")).toBe(true);
  expect(sessionResponses).toBe(1);
  expect(state.paths.filter((path) => path === "/api/session")).toHaveLength(
    1 + canceledSessionRequests.length,
  );
  expect(
    canceledSessionRequests.every((error) => error === "net::ERR_ABORTED"),
  ).toBe(true);
  test.info().annotations.push({
    type: "cold-session-reads",
    description: JSON.stringify({
      beforeRelease: coldReadsBeforeRelease,
      successful: sessionResponses,
      canceled: canceledSessionRequests.length,
    }),
  });
  state.sessionDelay = null;
  state.optionsKnown = false;
  await refocus(page);
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  state.optionsKnown = true;
  state.settings.config.liteauthEnabled = true;
  await refocus(page);
  const trigger = page.getByRole("button", { name: "青春版登录", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  const lite = page.getByRole("link", {
    name: "通过 LiteAuth 登录",
    exact: true,
  });
  await expect(lite).toHaveAttribute(
    "href",
    "/api/auth/liteauth/login?returnTo=%2Fmy%2Fclaims",
  );
  await expect(lite).toBeEnabled();
  await expect(page).toHaveURL(/authError=liteauth_disabled/);
  await lite.focus();
  state.settings.config.liteauthEnabled = false;
  await refocus(page);
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  await expect(lite).toHaveCount(0);
  await expect(connect).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  state.settings.config.liteauthEnabled = true;
  await refocus(page);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(lite).toBeVisible();
  await expect(lite).toBeEnabled();
  await expect(connect).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(state.paths.every((path) => path === "/api/session")).toBe(true);
  await page.goto("/square");
  const headerLogin = page
    .locator(".header-actions")
    .getByRole("link", { name: "登录", exact: true });
  await expect(headerLogin).toBeVisible();
  const warmReads = state.paths.filter(
    (path) => path === "/api/session",
  ).length;
  state.settings.config.liteauthEnabled = false;
  state.sessionDelay = gate();
  try {
    await headerLogin.click();
    await expect(page).toHaveURL(/\/account\?/);
    await expect
      .poll(() => state.paths.filter((path) => path === "/api/session").length)
      .toBe(warmReads + 1);
    state.sessionDelay.release();
    await expect(page.locator(".work-login-lite")).toHaveCount(0);
    await expect(connect).toBeVisible();
    expect(state.paths.filter((path) => path === "/api/session")).toHaveLength(
      warmReads + 1,
    );
  } finally {
    state.sessionDelay.release();
  }
  expect(state.paths).not.toContain("/api/admin/login-settings");
});

test("关闭不退出已有青春版会话，仅隐藏其刷新资料，官方登录账号刷新不受影响", async ({
  page,
}) => {
  const liteUser = {
    ...admin,
    id: "existing-lite",
    username: "lite",
    displayName: "已有青春用户",
    accountTier: "lite" as const,
    loginProvider: "liteauth" as const,
    canUseLdc: false,
    isAdmin: false,
    email: "",
  };
  const state = await mockSettings(page, liteUser);
  await page.goto("/account");
  const refresh = page.getByRole("button", { name: "刷新资料", exact: true });
  await expect(refresh).toBeVisible();
  state.settings.config.liteauthEnabled = false;
  await refocus(page);
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("definition").getByText("existing-lite", { exact: true }),
  ).toBeVisible();
  await expect(refresh).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "通过官方 Connect 升级", exact: true }),
  ).toBeVisible();
  const sessionRequests = state.paths.filter(
    (path) => path === "/api/session",
  ).length;
  state.sessionDelay = gate();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "通过LINUX DO登录", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  await expect
    .poll(() => state.paths.filter((path) => path === "/api/session").length)
    .toBeGreaterThan(sessionRequests);
  state.sessionDelay.release();
  state.sessionDelay = null;
  await expect(page.locator(".work-login-lite")).toHaveCount(0);
  state.user = { ...admin, isAdmin: false };
  await refocus(page);
  await expect(
    page.getByRole("definition").getByText(admin.id, { exact: true }),
  ).toBeVisible();
  await expect(refresh).toBeVisible();
  expect(state.paths.filter((path) => path.startsWith("/api/auth/"))).toEqual([
    "/api/auth/logout",
  ]);
  expect(state.paths.some((path) => path === "/api/admin/login-settings")).toBe(
    false,
  );
});

test("登录与限流配置独立保存，冲突及重新读取保留规则，离开确认覆盖两份输入", async ({
  page,
}) => {
  const state = await mockSettings(page, admin);
  await page.goto("/admin/rate-limits");
  const card = loginCard(page);
  const toggle = card.getByRole("checkbox", {
    name: "允许 LiteAUTH 登录",
    exact: true,
  });
  const save = card.getByRole("button", { name: "保存配置", exact: true });
  await expect(
    page.getByRole("heading", { name: "网站管理", exact: true }),
  ).toBeVisible();
  await expect(card.getByText(description, { exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  await page.getByLabel("首页尝试间隔（秒）", { exact: true }).fill("5");
  await toggle.click();
  await save.click();
  await expect(save).toBeDisabled();
  expect(state.writes).toEqual([
    { expectedVersion: 1, liteauthEnabled: false },
  ]);
  expect(state.rateWrites).toEqual([]);
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
  await expect(card).toContainText(admin.displayName);
  await toggle.click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/未保存/);
    await dialog.dismiss();
  });
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "我的", exact: true })
    .click();
  await expect(page).toHaveURL("/admin/rate-limits");
  await expect(toggle).toBeChecked();
  state.settings.config.version = 3;
  await save.click();
  await expect(card.getByText(/已在其他页面修改/)).toBeVisible();
  await expect(toggle).toBeChecked();
  const reload = card.getByRole("button", {
    name: "重新读取最新配置",
    exact: true,
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  await reload.click();
  await expect(toggle).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await reload.click();
  await expect(toggle).not.toBeChecked();
  await expect(card).toContainText("版本 3");
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
  await rateForm(page)
    .getByRole("button", { name: "保存配置", exact: true })
    .click();
  await expect(
    rateForm(page).getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  expect(state.rateWrites).toEqual([
    { expectedVersion: 1, homeIntervalSeconds: 5, activityIntervalSeconds: 60 },
  ]);
  expect(state.writes).toHaveLength(2);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(toggle).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await toggle.click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "我的", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
});

test("保存途中换账号不回填管理内容，403 后清除配置与输入", async ({ page }) => {
  const state = await mockSettings(page, admin);
  state.saveDelay = gate();
  const card = loginCard(page);
  try {
    await page.goto("/admin/rate-limits");
    await card
      .getByRole("checkbox", { name: "允许 LiteAUTH 登录", exact: true })
      .click();
    await card.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    state.user = {
      ...admin,
      id: "ordinary-account",
      displayName: "普通账号",
      isAdmin: false,
    };
    await refocus(page);
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveText("此页面仅限管理员访问");
    const savedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/admin/login-settings" &&
        response.request().method() === "PATCH",
    );
    state.saveDelay.release();
    await savedResponse;
    await expect(card).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "管理", exact: true }),
    ).toHaveCount(0);
    state.saveDelay = null;
    state.user = { ...admin, id: "next-admin", displayName: "新管理员" };
    await refocus(page);
    const toggle = card.getByRole("checkbox", {
      name: "允许 LiteAUTH 登录",
      exact: true,
    });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    state.denySave = true;
    await card.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(toggle).toHaveCount(0);
    await expect(card.getByText(/版本/)).toHaveCount(0);
    await expect(page.getByRole("alert").first()).toHaveText(
      "此页面仅限管理员访问",
    );
    await expect(
      page.getByRole("button", { name: "保存配置", exact: true }),
    ).toHaveCount(0);
  } finally {
    state.saveDelay?.release();
  }
});
