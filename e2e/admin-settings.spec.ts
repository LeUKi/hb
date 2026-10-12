import { expect, type Page, test } from "@playwright/test";

async function mockSettings(page: Page) {
  const state = {
    user: {
      id: "settings-admin",
      username: "admin",
      displayName: "管理员",
      avatarUrl: null,
      accountTier: "standard",
      loginProvider: "connect",
      canUseLdc: true,
      isAdmin: true,
    },
    csrfToken: "session-a",
    login: {
      version: 1,
      liteauthEnabled: true,
      updatedAt: Date.now(),
      updatedByUserId: null as string | null,
    },
    rate: {
      version: 1,
      homeIntervalSeconds: 60,
      activityIntervalSeconds: 60,
      updatedAt: Date.now(),
      updatedByUserId: null as string | null,
    },
    writes: [] as { module: string; input: Record<string, unknown> }[],
    reads: [] as string[],
    failRead: false,
    readDelay: null as { session: string; wait: Promise<void> } | null,
    saveMode: "success" as
      | "success"
      | "commit-lost"
      | "not-committed"
      | "lost-unreadable"
      | "conflict",
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session")
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: state.csrfToken,
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: state.login.liteauthEnabled },
        },
      });
    const module = path.split("/").at(-1);
    if (module !== "login-settings" && module !== "rate-limits")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    const config = module === "login-settings" ? state.login : state.rate;
    if (route.request().method() === "GET") {
      state.reads.push(module);
      const observed = structuredClone(config);
      if (state.readDelay?.session === state.csrfToken)
        await state.readDelay.wait;
      if (state.failRead)
        return route.fulfill({
          status: 503,
          json: { error: { message: "读取失败" } },
        });
      return route.fulfill({ json: { config: observed, recentChanges: [] } });
    }
    const input = route.request().postDataJSON() as Record<string, unknown>;
    state.writes.push({ module, input });
    expect(route.request().headers()["x-csrf-token"]).toBe(state.csrfToken);
    if (
      state.saveMode === "conflict" ||
      input.expectedVersion !== config.version
    )
      return route.fulfill({
        status: 409,
        json: { error: { message: "配置冲突" } },
      });
    if (state.saveMode === "not-committed") return route.abort("failed");
    if (state.saveMode === "lost-unreadable") {
      state.failRead = true;
      return route.abort("failed");
    }
    if (module === "login-settings")
      state.login = {
        ...state.login,
        version: config.version + 1,
        liteauthEnabled: Boolean(input.liteauthEnabled),
        updatedByUserId: state.user.id,
      };
    else
      state.rate = {
        ...state.rate,
        version: config.version + 1,
        homeIntervalSeconds: Number(input.homeIntervalSeconds),
        activityIntervalSeconds: Number(input.activityIntervalSeconds),
        updatedByUserId: state.user.id,
      };
    if (state.saveMode === "commit-lost") return route.abort("failed");
    return route.fulfill({
      json: {
        config: module === "login-settings" ? state.login : state.rate,
        recentChanges: [],
      },
    });
  });
  return state;
}
function card(page: Page, module: "login" | "rate") {
  return page.getByRole("region", {
    name: module === "login" ? "登录方式" : "参与尝试限流",
    exact: true,
  });
}
async function change(page: Page, module: "login" | "rate") {
  if (module === "login")
    await card(page, module).getByRole("checkbox").uncheck();
  else
    await card(page, module)
      .getByLabel("首页尝试间隔（秒）", { exact: true })
      .fill("5");
}
async function refocus(page: Page) {
  await page.evaluate(() => {
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
  });
}
for (const module of ["login", "rate"] as const) {
  test(`${module} 保存响应丢失先读取核对，已生效不重复提交`, async ({
    page,
  }) => {
    const state = await mockSettings(page);
    await page.goto("/admin/settings");
    await change(page, module);
    state.saveMode = "commit-lost";
    await card(page, module)
      .getByRole("button", { name: "保存配置", exact: true })
      .click();
    await expect(card(page, module).getByRole("status")).toHaveText(
      "已核对，配置已生效。",
    );
    expect(state.writes).toHaveLength(1);
    expect(
      state.reads.filter(
        (value) =>
          value === (module === "login" ? "login-settings" : "rate-limits"),
      ).length,
    ).toBeGreaterThan(1);
    await expect(
      card(page, module).getByRole("button", { name: "保存配置", exact: true }),
    ).toBeDisabled();
    await change(page, module === "login" ? "rate" : "login");
    await expect(
      card(page, module === "login" ? "rate" : "login").getByRole("button", {
        name: "保存配置",
        exact: true,
      }),
    ).toBeEnabled();
  });
}
test("核对失败锁定原输入与刷新，核对后原版本原内容重试", async ({ page }) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  await change(page, "rate");
  state.saveMode = "lost-unreadable";
  const panel = card(page, "rate");
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "核对保存结果", exact: true }),
  ).toBeEnabled();
  await expect(
    panel.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "刷新", exact: true }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  state.failRead = false;
  await panel
    .getByRole("button", { name: "核对保存结果", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "重试原提交", exact: true }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  state.saveMode = "success";
  await panel.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("已保存。");
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  await expect(
    panel.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toBeEnabled();
});
test("后台读取保留基线和脏输入，刷新取消及失败保留，同版本成功重置，保存后再次修改离开保护", async ({
  page,
}) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  const panel = card(page, "rate");
  const home = panel.getByLabel("首页尝试间隔（秒）", { exact: true });
  await home.fill("5");
  state.rate = { ...state.rate, version: 2, homeIntervalSeconds: 5 };
  const initialReads = state.reads.length;
  await page.clock.install();
  await page.clock.fastForward(16_000);
  await refocus(page);
  await expect.poll(() => state.reads.length).toBeGreaterThan(initialReads);
  await expect(home).toHaveValue("5");
  await expect(
    panel.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeEnabled();
  state.saveMode = "conflict";
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  expect(state.writes[0]?.input.expectedVersion).toBe(1);
  await expect(panel.getByRole("status")).toContainText("当前输入已保留");
  const refresh = panel.getByRole("button", { name: "刷新", exact: true });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("刷新会放弃未保存的修改，是否继续？");
    await dialog.dismiss();
  });
  await refresh.click();
  await expect(home).toHaveValue("5");
  state.failRead = true;
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(panel.getByRole("status")).toHaveText("刷新失败，请重试。");
  await expect(home).toHaveValue("5");
  state.failRead = false;
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(
    panel.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await home.fill("7");
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(home).toHaveValue("5"); // Same server version must reset local draft.
  state.saveMode = "success";
  await home.fill("8");
  await panel.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("已保存。");
  await home.fill("9");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "管理入口" })
    .getByRole("link", { name: "用户", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(home).toHaveValue("9");
});

test("双表单脏输入离开只确认一次，取消保留，确认后放弃", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/admin/settings");
  await change(page, "login");
  await change(page, "rate");
  let confirms = 0;
  let accept = false;
  page.on("dialog", async (dialog) => {
    confirms++;
    expect(dialog.message()).toBe("还有未保存的网站设置，确定离开吗？");
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  const destination = page
    .getByRole("navigation", { name: "管理入口" })
    .getByRole("link", { name: "用户", exact: true });
  await destination.click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  expect(confirms).toBe(1);
  await expect(card(page, "login").getByRole("checkbox")).not.toBeChecked();
  await expect(
    card(page, "rate").getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
  accept = true;
  await destination.click();
  await expect(page).toHaveURL(/\/admin\/users/);
  expect(confirms).toBe(2);
  await page
    .getByRole("navigation", { name: "管理入口" })
    .getByRole("link", { name: "网站设置", exact: true })
    .click();
  await expect(card(page, "login").getByRole("checkbox")).toBeChecked();
  await expect(
    card(page, "rate").getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("60");
});

test("同账号新会话撤下旧基线和输入，取消在途刷新，迟到记录不会回填", async ({
  page,
}) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  const home = card(page, "rate").getByLabel("首页尝试间隔（秒）", {
    exact: true,
  });
  await home.fill("5");
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.readDelay = { session: "session-a", wait };
  const before = state.reads.length;
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await card(page, "rate")
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect.poll(() => state.reads.length).toBeGreaterThan(before);
    const canceled = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/admin/rate-limits",
    });
    state.csrfToken = "session-b";
    state.rate = { ...state.rate, version: 2, homeIntervalSeconds: 20 };
    await refocus(page);
    await canceled;
    await expect(home).toHaveValue("20");
    release();
    await expect(home).toHaveValue("20");
    await expect(
      card(page, "rate").getByRole("button", { name: "保存配置", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
});
