import { expect, type Locator, type Page, test } from "@playwright/test";

async function mockSettings(page: Page) {
  const state = {
    user: {
      id: "settings-admin",
      username: "admin",
      displayName: "管理员",
      avatarUrl: null,
      isAdmin: true,
    },
    csrfToken: "session-a",
    rate: {
      version: 1,
      homeIntervalSeconds: 60,
      activityIntervalSeconds: 60,
      updatedAt: Date.now(),
      updatedByUserId: null as string | null,
    },
    writes: [] as Record<string, unknown>[],
    reads: 0,
    failRead: false,
    readDelay: null as { session: string; wait: Promise<void> } | null,
    saveDelay: null as Promise<void> | null,
    denySave: false,
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
        },
      });
    if (path !== "/api/admin/rate-limits")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    const config = state.rate;
    if (route.request().method() === "GET") {
      state.reads++;
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
    state.writes.push(input);
    expect(route.request().headers()["x-csrf-token"]).toBe(state.csrfToken);
    if (state.denySave) {
      state.user = { ...state.user, isAdmin: false };
      return route.fulfill({
        status: 403,
        json: {
          error: { code: "ADMIN_REQUIRED", message: "此页面仅限管理员访问" },
        },
      });
    }
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
    state.rate = {
      ...state.rate,
      version: config.version + 1,
      homeIntervalSeconds: Number(input.homeIntervalSeconds),
      activityIntervalSeconds: Number(input.activityIntervalSeconds),
      updatedByUserId: state.user.id,
    };
    if (state.saveMode === "commit-lost") return route.abort("failed");
    const saved = { config: state.rate, recentChanges: [] };
    await state.saveDelay;
    return route.fulfill({ json: saved });
  });
  return state;
}
function card(page: Page) {
  return page.getByRole("region", { name: "参与尝试限流", exact: true });
}

type Box = { height: number; width: number; x: number; y: number };

async function box(
  name: string,
  locator: { boundingBox: () => Promise<Box | null> },
) {
  const value = await locator.boundingBox();
  if (!value) throw new Error(`Expected ${name} to have a layout box.`);
  return value;
}

async function expectStableBox(actual: Box | null, expected: Box) {
  if (!actual) throw new Error("Expected element to have a layout box.");
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThan(1);
  }
}

async function freezeClock(page: Page) {
  await page.clock.pauseAt(Date.now() + 1_000);
}

const feedbackLabel = (button: Locator) =>
  button.locator('[aria-live="polite"]').last();
async function change(page: Page) {
  await card(page).getByLabel("首页尝试间隔（秒）", { exact: true }).fill("5");
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

test("设置操作反馈留在触发按钮且三秒复原", async ({ page }) => {
  await page.clock.install();
  const state = await mockSettings(page);
  await page.goto("/admin/settings");

  await change(page);
  const rate = card(page);
  const save = rate.getByRole("button", { name: /^保存配置(?:，|$)/ });
  const saveBox = await box("rate save button", save);
  await freezeClock(page);
  await save.click();
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await expect(save).toHaveAccessibleName("保存配置，已保存");
  await expect(rate.getByRole("status")).toHaveCount(0);
  await expectStableBox(await save.boundingBox(), saveBox);
  await page.clock.runFor(2_999);
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await page.clock.runFor(1);
  await expect(feedbackLabel(save)).toHaveText("保存配置");

  const refresh = rate.getByRole("button", { name: /^刷新(?:，|$)/ });
  const refreshBox = await box("rate refresh button", refresh);
  state.failRead = true;
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("刷新失败");
  await expect(refresh).toHaveAccessibleName("刷新，刷新失败");
  await expect(refresh).toHaveAttribute("title", "刷新失败，请重试。");
  await expect(rate.getByRole("status")).toHaveCount(0);
  await expectStableBox(await refresh.boundingBox(), refreshBox);
  state.failRead = false;
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("已刷新");
  await expect(refresh).toHaveAccessibleName("刷新，已刷新");
  await expect(rate.getByRole("status")).toHaveCount(0);
  await page.clock.runFor(2_999);
  await expect(feedbackLabel(refresh)).toHaveText("已刷新");
  await page.clock.runFor(1);
  await expect(feedbackLabel(refresh)).toHaveText("刷新");
});

test("设置字段校验反馈留在保存按钮且保留输入", async ({ page }) => {
  await page.clock.install();
  await mockSettings(page);
  await page.goto("/admin/settings");
  const panel = card(page);
  const home = panel.getByLabel("首页尝试间隔（秒）", { exact: true });
  await home.fill("0");
  const save = panel.getByRole("button", { name: /^保存配置(?:，|$)/ });
  await freezeClock(page);
  await save.click();
  await expect(feedbackLabel(save)).toHaveText("校验失败");
  await expect(save).toHaveAccessibleName("保存配置，校验失败");
  await expect(save).toHaveAttribute("title", "请填写 1–3600 秒的整数。");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(home).toHaveValue("0");
});

test("保存响应丢失先读取核对，已生效不重复提交", async ({ page }) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  await change(page);
  state.saveMode = "commit-lost";
  await card(page)
    .getByRole("button", { name: /^保存配置(?:，|$)/ })
    .click();
  await expect(
    feedbackLabel(card(page).getByRole("button", { name: /已核对/ })),
  ).toHaveText("已核对");
  expect(state.writes).toHaveLength(1);
  expect(state.reads).toBeGreaterThan(1);
  await expect(
    card(page).getByRole("button", { name: /^保存配置(?:，|$)/ }),
  ).toBeDisabled();
});
test("核对失败锁定原输入与刷新，核对后原版本原内容重试", async ({ page }) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  await change(page);
  state.saveMode = "lost-unreadable";
  const panel = card(page);
  await panel.getByRole("button", { name: /^保存配置(?:，|$)/ }).click();
  await expect(
    panel.getByRole("button", { name: /^核对保存结果(?:，|$)/ }),
  ).toBeEnabled();
  await expect(
    panel.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: /^刷新(?:，|$)/ }),
  ).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  state.failRead = false;
  await panel.getByRole("button", { name: /^核对保存结果(?:，|$)/ }).click();
  await expect(
    panel.getByRole("button", { name: /^重试原提交(?:，|$)/ }),
  ).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  state.saveMode = "success";
  await panel.getByRole("button", { name: /^重试原提交(?:，|$)/ }).click();
  await expect(
    feedbackLabel(panel.getByRole("button", { name: /已保存/ })),
  ).toHaveText("已保存");
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
  const panel = card(page);
  const home = panel.getByLabel("首页尝试间隔（秒）", { exact: true });
  await home.fill("5");
  state.rate = { ...state.rate, version: 2, homeIntervalSeconds: 5 };
  const initialReads = state.reads;
  await page.clock.install();
  await page.clock.fastForward(16_000);
  await refocus(page);
  await expect.poll(() => state.reads).toBeGreaterThan(initialReads);
  await expect(home).toHaveValue("5");
  await expect(
    panel.getByRole("button", { name: /^保存配置(?:，|$)/ }),
  ).toBeEnabled();
  state.saveMode = "conflict";
  await panel.getByRole("button", { name: /^保存配置(?:，|$)/ }).click();
  expect(state.writes[0]?.expectedVersion).toBe(1);
  await expect(panel.getByRole("button", { name: /已变化/ })).toHaveAttribute(
    "title",
    "网站设置已发生变化，请刷新后再试。当前输入已保留。",
  );
  const refresh = panel.getByRole("button", { name: /^刷新(?:，|$)/ });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("刷新会放弃未保存的修改，是否继续？");
    await dialog.dismiss();
  });
  await refresh.click();
  await expect(home).toHaveValue("5");
  state.failRead = true;
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(
    feedbackLabel(panel.getByRole("button", { name: /刷新失败/ })),
  ).toHaveText("刷新失败");
  await expect(home).toHaveValue("5");
  state.failRead = false;
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(
    panel.getByRole("button", { name: /^保存配置(?:，|$)/ }),
  ).toBeDisabled();
  await home.fill("7");
  page.once("dialog", (dialog) => dialog.accept());
  await refresh.click();
  await expect(home).toHaveValue("5"); // Same server version must reset local draft.
  state.saveMode = "success";
  await home.fill("8");
  await panel.getByRole("button", { name: /^保存配置(?:，|$)/ }).click();
  await expect(
    feedbackLabel(panel.getByRole("button", { name: /已保存/ })),
  ).toHaveText("已保存");
  await home.fill("9");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "管理入口" })
    .getByRole("link", { name: "用户", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(home).toHaveValue("9");
});

test("脏输入离开只确认一次，取消保留，确认后放弃", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/admin/settings");
  await change(page);
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
  await expect(
    card(page).getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
  accept = true;
  await destination.click();
  await expect(page).toHaveURL(/\/admin\/users/);
  expect(confirms).toBe(2);
  await page
    .getByRole("navigation", { name: "管理入口" })
    .getByRole("link", { name: "网站设置", exact: true })
    .click();
  await expect(
    card(page).getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("60");
});

test("同账号新会话撤下旧基线和输入，取消在途刷新，迟到记录不会回填", async ({
  page,
}) => {
  const state = await mockSettings(page);
  await page.goto("/admin/settings");
  const home = card(page).getByLabel("首页尝试间隔（秒）", { exact: true });
  await home.fill("5");
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.readDelay = { session: "session-a", wait };
  const before = state.reads;
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await card(page)
      .getByRole("button", { name: /^刷新(?:，|$)/ })
      .click();
    await expect.poll(() => state.reads).toBeGreaterThan(before);
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
      card(page).getByRole("button", { name: /^保存配置(?:，|$)/ }),
    ).toBeDisabled();
  } finally {
    release();
  }
});

test("保存途中换账号不回填管理内容，403 后清除配置与输入", async ({ page }) => {
  const state = await mockSettings(page);
  let release = () => {};
  state.saveDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/admin/settings");
    await change(page);
    await card(page)
      .getByRole("button", { name: /^保存配置(?:，|$)/ })
      .click();
    await expect.poll(() => state.writes.length).toBe(1);
    state.user = {
      ...state.user,
      id: "ordinary-account",
      displayName: "普通用户",
      isAdmin: false,
    };
    const canceledSave = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/admin/rate-limits" &&
        request.method() === "PATCH",
    });
    await refocus(page);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveText("此页面仅限管理员访问");
    release();
    const canceled = await canceledSave;
    expect(canceled.failure()?.errorText).toBe("net::ERR_ABORTED");
    await expect(card(page)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "管理", exact: true }),
    ).toHaveCount(0);
    state.saveDelay = null;
    state.user = {
      ...state.user,
      id: "next-admin",
      displayName: "新管理员",
      isAdmin: true,
    };
    await refocus(page);
    const home = card(page).getByLabel("首页尝试间隔（秒）", { exact: true });
    await expect(home).toHaveValue("5");
    await home.fill("7");
    state.denySave = true;
    await card(page)
      .getByRole("button", { name: /^保存配置(?:，|$)/ })
      .click();
    await expect(home).toHaveCount(0);
    await expect(card(page).getByText(/更新于/)).toHaveCount(0);
    await expect(page.getByRole("alert").first()).toHaveText(
      "此页面仅限管理员访问",
    );
    await expect(
      page.getByRole("button", { name: /^保存配置(?:，|$)/ }),
    ).toHaveCount(0);
  } finally {
    release();
  }
});
