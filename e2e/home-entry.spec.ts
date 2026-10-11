import { mkdir } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import type { PublicActivity } from "../packages/contracts/src";

const id = "cecef876-ddbb-4ed5-93ce-9b311e3df3ea";
const alternateId = "21111111-1111-4111-8111-111111111111";
const topicActivityId = "790f9912-9934-4dfc-7c32962a3e82";
const topicPageOneId = "11111111-2222-4333-8444-555555555555";
const topicPageTwoId = "22222222-3333-4444-8555-666666666666";
const topicStaleMultiId = "33333333-4444-4555-8666-777777777777";
const emoji = "🚷🎼📯😨😸🎺🐵🦄🪁🚍🤽📄🥘☕";
const shortPath = `/e/${emoji}`;
const longPath = `/activities/${id}`;
const sameOriginActivityLink = `http://127.0.0.1:5173${longPath}`;
const sameOriginEmojiLink = `http://127.0.0.1:5173${shortPath}`;
const topicLink = "https://linux.do/t/topic/12345/6";
const screenshotDir = ".wrangler/verification/home-entry";

const user = {
  id: "viewer-home-entry",
  username: "home-entry",
  displayName: "首页用户",
  avatarUrl: null,
  accountTier: "standard" as const,
  canUseLdc: true,
  loginProvider: "connect" as const,
};

function gate() {
  let release = () => {};
  let started = () => {};
  const opened = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    opened,
    wait: () => {
      started();
      return closed;
    },
  };
}

function activity(activityId = id): PublicActivity {
  const titles: Record<string, string> = {
    [id]: "UUID 活动",
    [alternateId]: "另一个 UUID 活动",
    [topicActivityId]: "帖子关联活动",
    [topicPageOneId]: "帖子第一页活动",
    [topicPageTwoId]: "帖子第二页活动",
    [topicStaleMultiId]: "帖子迟到多选活动",
  };
  return {
    id: activityId,
    title: titles[activityId] ?? "UUID 活动",
    rewardType: "text",
    status: "active",
    author: user,
    forceDedicated: true,
    topicUrl: [
      topicActivityId,
      topicPageOneId,
      topicPageTwoId,
      topicStaleMultiId,
    ].includes(activityId)
      ? "https://linux.do/t/topic/12345/6"
      : null,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
    quantity: { mode: "exact", total: 1, claimed: 0, remaining: 1 },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    beforeInfo: "活动公开说明。",
    reward: { mode: "text" },
  };
}

async function mockHome(
  page: Page,
  options: {
    session?: "user" | "guest" | "error";
    sessionGate?: ReturnType<typeof gate>;
    topicGate?: ReturnType<typeof gate>;
    topicMode?:
      | "single"
      | "none"
      | "error"
      | "error-then-single"
      | "multiple"
      | "stale-multiple";
    attemptCooldown?: unknown;
    sessionFailures?: number;
  } = {},
) {
  const state = {
    discovers: [] as unknown[],
    mutations: [] as string[],
    topicReads: [] as string[],
    topicCursors: [] as Array<string | null>,
    activityReads: [] as string[],
    sessionReads: 0,
    topicFailures: 0,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") state.mutations.push(path);
    if (path === "/api/session" || path === "/api/me") {
      state.sessionReads += 1;
      await options.sessionGate?.wait();
      if (
        options.session === "error" &&
        state.sessionReads <= (options.sessionFailures ?? 4)
      )
        return route.fulfill({
          status: 500,
          json: { error: { code: "SESSION_FAILED", message: "身份检查失败" } },
        });
      return route.fulfill({
        json: {
          user: options.session === "guest" ? null : user,
          csrfToken: options.session === "guest" ? null : "csrf",
          attemptCooldown: options.attemptCooldown ?? null,
          loginOptions: { liteauthEnabled: false },
        },
      });
    }
    if (path === "/api/me/history-summary")
      return route.fulfill({
        json: { initiatedCount: 0, participatedCount: 0 },
      });
    if (path === "/api/me/activities")
      return route.fulfill({
        json: {
          total: 0,
          items: [],
          nextCursor: null,
          statusCounts: { all: 0, draft: 0, active: 0, ended: 0, archived: 0 },
        },
      });
    if (path === "/api/redemptions/discover") {
      state.discovers.push(request.postDataJSON());
      return route.fulfill({
        json: { id: "none", result: "none", items: [], nextCursor: null },
      });
    }
    if (path === `/api/activities/${id}`) {
      state.activityReads.push(path);
      return route.fulfill({ json: { activity: activity(id) } });
    }
    if (path === `/api/activities/${alternateId}`) {
      state.activityReads.push(path);
      return route.fulfill({ json: { activity: activity(alternateId) } });
    }
    if (
      [
        topicActivityId,
        topicPageOneId,
        topicPageTwoId,
        topicStaleMultiId,
      ].includes(path.slice("/api/activities/".length)) &&
      path.startsWith("/api/activities/")
    ) {
      state.activityReads.push(path);
      return route.fulfill({
        json: { activity: activity(path.slice("/api/activities/".length)) },
      });
    }
    if (path === "/api/topics/12345/activities") {
      state.topicReads.push(url.searchParams.get("postNumber") ?? "");
      const cursor = url.searchParams.get("cursor");
      state.topicCursors.push(cursor);
      await options.topicGate?.wait();
      if (options.topicMode === "none")
        return route.fulfill({
          json: { total: 0, items: [], nextCursor: null },
        });
      if (
        options.topicMode === "error" ||
        (options.topicMode === "error-then-single" && state.topicFailures === 0)
      ) {
        state.topicFailures += 1;
        return route.fulfill({
          status: 500,
          json: { error: { code: "TOPIC_FAILED", message: "查找失败" } },
        });
      }
      if (options.topicMode === "multiple")
        return route.fulfill({
          json: cursor
            ? {
                total: 3,
                items: [activity(topicPageTwoId)],
                nextCursor: null,
              }
            : {
                total: 3,
                items: [activity(topicPageOneId), activity(topicStaleMultiId)],
                nextCursor: "page-2",
              },
        });
      if (options.topicMode === "stale-multiple")
        return route.fulfill({
          json: {
            total: 2,
            items: [activity(topicPageOneId), activity(topicStaleMultiId)],
            nextCursor: null,
          },
        });
      return route.fulfill({
        json: {
          total: 1,
          items: [activity(topicActivityId)],
          nextCursor: null,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "未找到" } },
    });
  });
  return state;
}

function homeInput(page: Page) {
  return page.getByLabel("口令", { exact: true });
}

async function captureHomeEntry(page: Page, name: string) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({
    path: `${screenshotDir}/${name}.png`,
    fullPage: true,
  });
}

async function expectEmptyHomeEntry(page: Page) {
  await expect(page.locator(".home-exchange textarea")).toHaveCount(1);
  await expect(homeInput(page)).toHaveCount(1);
  await expect(homeInput(page)).toHaveAttribute("placeholder", "");
  await expect(page.locator(".pw-input__placeholder")).toHaveText("");
  await expect(page.getByRole("heading", { name: "兑奖" })).toHaveCount(0);
  const labelBox = await page.locator(".pw-input__label").boundingBox();
  expect(labelBox?.width).toBeLessThanOrEqual(1);
  expect(labelBox?.height).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "兑奖" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "跳转活动" })).toHaveCount(0);
  await expect(page.locator(".pw-input__count")).toHaveCount(0);
  await expect(page.locator(".pw-input__hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "一键优化" })).toHaveCount(0);
}

async function expectLocatorMode(page: Page) {
  await expect(
    page.getByRole("button", { name: "跳转活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pw-input__count")).toHaveCount(0);
  await expect(page.locator(".pw-input__hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "一键优化" })).toHaveCount(0);
  await expect(page.locator(".pw-input__invalid")).toHaveCount(0);
}

test("首页输入框只暴露隐藏口令标签、空占位和说明按钮", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockHome(page);
  await page.goto("/");

  await expectEmptyHomeEntry(page);
  await captureHomeEntry(page, "desktop-empty");
  const help = page.getByRole("button", {
    name: "口令输入说明",
    exact: true,
  });
  await expect(help).toBeVisible();
  await help.click();
  const dialog = page.getByRole("dialog", {
    name: "口令输入说明",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("14 个 Emoji");
  await expect(dialog).toContainText("UUID");
  await expect(dialog).toContainText("本站活动链接");
  await expect(dialog).toContainText("https://linux.do/t/topic/");
});

test("口令模式只在非空时显示动作、计数、无效字符和必要规则", async ({
  page,
}) => {
  await mockHome(page);
  await page.goto("/");
  const input = homeInput(page);

  await input.fill("bad!xx");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pw-input__count")).toHaveText("6 / 18");
  await expect(page.locator(".pw-input__invalid")).toHaveCount(1);
  await expect(page.locator(".pw-input__error")).toContainText("不可用字符");
  await expect(page.getByRole("button", { name: "一键优化" })).toBeVisible();
  await expect(page.locator(".pw-input__hint")).toContainText("6–18");

  await input.fill("abcdef");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".pw-input__count")).toHaveText("6 / 18");
  await expect(page.locator(".pw-input__invalid")).toHaveCount(0);
  await expect(page.locator(".pw-input__error")).toBeEmpty();
  await expect(page.locator(".pw-input__hint")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "一键优化" })).toHaveCount(0);

  await page.getByRole("button", { name: "清空输入" }).click();
  await expect(input).toHaveValue("");
  await expectEmptyHomeEntry(page);
});

test("活动标识模式支持 UUID、Emoji、本站链接和严格帖子链接", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockHome(page);
  await page.goto("/");
  const input = homeInput(page);

  for (const value of [
    id,
    emoji,
    sameOriginActivityLink,
    sameOriginEmojiLink,
    topicLink,
  ]) {
    await input.fill(value);
    await expectLocatorMode(page);
  }
  await captureHomeEntry(page, "mobile-topic");
});

test("活动标识输入和组词 Enter 不会提前跳转，提交才跳转", async ({ page }) => {
  const state = await mockHome(page);
  await page.goto("/");
  const input = homeInput(page);

  await input.fill(id);
  await expectLocatorMode(page);
  await expect(page).toHaveURL("/");
  expect(state.activityReads).toEqual([]);

  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(page).toHaveURL("/");
  expect(state.activityReads).toEqual([]);

  await input.dispatchEvent("compositionend");
  await input.press("Enter");
  await expect(page).toHaveURL(longPath);
  await expect(page.getByRole("heading", { name: "UUID 活动" })).toBeVisible();
  expect(state.activityReads).toContain(`/api/activities/${id}`);
});

test("帖子链接只接受严格 topic 格式并按楼层查询", async ({ page }) => {
  const state = await mockHome(page);
  await page.goto("/");
  const input = homeInput(page);

  for (const rejected of [
    "http://linux.do/t/topic/12345/6",
    "https://linux.do/t/12345/6",
    "https://linux.do/t/topic-title/12345/6",
    "https://linux.do/t/topic/12345/6/extra",
  ]) {
    await input.fill(rejected);
    await expect(
      page.getByRole("button", { name: "兑奖", exact: true }),
    ).toBeVisible();
  }

  await input.fill(" https://linux.do/t/topic/12345/6?u=someone#last ");
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${topicActivityId}`);
  await expect(
    page.getByRole("heading", { name: "帖子关联活动" }),
  ).toBeVisible();
  expect(new Set(state.topicReads)).toEqual(new Set(["6"]));
  expect(state.discovers).toEqual([]);
});

test("游客和冷却状态可以跳转活动，帖子查询等待身份确认", async ({ page }) => {
  const pendingSession = gate();
  const state = await mockHome(page, {
    session: "guest",
    sessionGate: pendingSession,
    attemptCooldown: {
      revision: 9,
      serverTime: Date.now(),
      nextAllowedAt: Date.now() + 60_000,
    },
  });
  await page.goto("/");
  await pendingSession.opened;

  await homeInput(page).fill(id);
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(longPath);

  await page.goto("/");
  await homeInput(page).fill(topicLink);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect.poll(() => state.topicReads).toEqual([]);
  pendingSession.release();
  await expect(page).toHaveURL(`/activities/${topicActivityId}`);
  expect(state.topicReads.length).toBeGreaterThanOrEqual(1);
  expect(state.topicReads.every((postNumber) => postNumber === "6")).toBe(true);
});

test("登录账号冷却会禁用普通口令，但不拦截 UUID 跳转", async ({ page }) => {
  const state = await mockHome(page, {
    attemptCooldown: {
      revision: 9,
      serverTime: Date.now(),
      nextAllowedAt: Date.now() + 60_000,
    },
  });
  await page.goto("/");
  const input = homeInput(page);

  await input.fill("abcdef");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("timer")).toContainText("秒后可重试");

  await input.fill(id);
  await expectLocatorMode(page);
  await expect(page.getByRole("timer")).toHaveCount(0);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(longPath);
  await expect(page.getByRole("heading", { name: "UUID 活动" })).toBeVisible();
  expect(state.discovers).toEqual([]);
  expect(state.mutations).toEqual([]);
});

test("会话错误可重试，重试后仍按同一输入跳转", async ({ page }) => {
  const state = await mockHome(page, { session: "error" });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("身份检查失败");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(homeInput(page)).toBeEnabled();

  await homeInput(page).fill(id);
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(longPath);
  expect(state.sessionReads).toBeGreaterThanOrEqual(2);
});

test("会话失败前输入的活动标识在重试成功后保留", async ({ page }) => {
  const pendingSession = gate();
  const state = await mockHome(page, {
    session: "error",
    sessionGate: pendingSession,
  });
  await page.goto("/");
  await pendingSession.opened;
  await homeInput(page).fill(id);
  pendingSession.release();

  await expect(page.getByRole("alert")).toContainText("身份检查失败");
  await expect(homeInput(page)).toHaveValue(id);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(homeInput(page)).toHaveValue(id);
  await expectLocatorMode(page);

  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(longPath);
  expect(state.discovers).toEqual([]);
});

test("旧帖子请求在输入变化后不能导航", async ({ page }) => {
  const firstTopic = gate();
  const state = await mockHome(page, { topicGate: firstTopic });
  await page.goto("/");
  const input = homeInput(page);

  await input.fill(topicLink);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await firstTopic.opened;
  await input.fill(alternateId);
  firstTopic.release();

  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "帖子关联活动" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${alternateId}`);
  expect(state.topicReads.length).toBeGreaterThanOrEqual(1);
  expect(state.topicReads.every((postNumber) => postNumber === "6")).toBe(true);
});

test("迟到的帖子多选结果在输入变化后不能打开选择弹窗", async ({ page }) => {
  const delayedTopic = gate();
  const state = await mockHome(page, {
    topicGate: delayedTopic,
    topicMode: "stale-multiple",
  });
  await page.goto("/");
  const input = homeInput(page);

  await input.fill(topicLink);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await delayedTopic.opened;
  await input.fill(alternateId);
  delayedTopic.release();

  await expect(page.getByRole("dialog", { name: "选择活动" })).toHaveCount(0);
  await expect(page).toHaveURL("/");
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${alternateId}`);
  expect(state.topicReads.length).toBeGreaterThanOrEqual(1);
  expect(state.topicReads.every((postNumber) => postNumber === "6")).toBe(true);
});

test("帖子多选分页可用，历史和刷新恢复游标，新提交回到第一页并关闭返焦", async ({
  page,
}) => {
  const state = await mockHome(page, { topicMode: "multiple" });
  await page.goto("/");
  const input = homeInput(page);
  await input.fill(topicLink);
  const jump = page.getByRole("button", { name: "跳转活动", exact: true });
  await jump.click();

  let dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("帖子第一页活动")).toBeVisible();
  await expect(dialog.getByText("第 1 页")).toBeVisible();
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog.getByText("帖子第二页活动")).toBeVisible();
  await expect(dialog.getByText("第 2 页")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("dialog", { name: "选择活动" })).toHaveCount(0);
  await page.goForward();
  dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("帖子第二页活动")).toBeVisible();
  await expect(dialog.getByText("第 2 页")).toBeVisible();

  await page.reload();
  dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("帖子第二页活动")).toBeVisible();
  await expect(dialog.getByText("第 2 页")).toBeVisible();

  await dialog.getByRole("button", { name: "关闭选择活动" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(jump).toBeFocused();
  await jump.click();
  dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("帖子第一页活动")).toBeVisible();
  await expect(dialog.getByText("第 1 页")).toBeVisible();
  expect(state.topicCursors).toContain(null);
  expect(state.topicCursors).toContain("page-2");
});

test("帖子零结果保留跳转模式，再次提交重试同一目标", async ({ page }) => {
  const state = await mockHome(page, { topicMode: "none" });
  await page.goto("/");
  await homeInput(page).fill(topicLink);

  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("未匹配到活动。");
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("未匹配到活动。");
  expect(state.topicReads.length).toBeGreaterThanOrEqual(2);
  expect(state.topicReads.every((postNumber) => postNumber === "6")).toBe(true);
});

test("前一次普通口令未匹配后，活动标识跳转不会沿用发现或兑换意图", async ({
  page,
}) => {
  const state = await mockHome(page);
  await page.goto("/");
  const input = homeInput(page);

  await input.fill("abcdef");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(page.locator(".form-message")).toContainText("未匹配到活动。");
  expect(state.discovers).toHaveLength(1);

  await input.fill(id);
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(longPath);
  await expect(page.getByRole("heading", { name: "UUID 活动" })).toBeVisible();
  expect(state.discovers).toHaveLength(1);
  expect(
    state.mutations.filter((path) => path !== "/api/redemptions/discover"),
  ).toEqual([]);
});

test("帖子查询失败保留跳转模式，重试同一目标", async ({ page }) => {
  const state = await mockHome(page, { topicMode: "error" });
  await page.goto("/");
  await homeInput(page).fill(topicLink);

  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(
    page.locator('p[role="alert"]').filter({ hasText: "查找失败。" }),
  ).toBeVisible();
  await expectLocatorMode(page);
  await page.getByRole("button", { name: "重试" }).click();
  await expect(
    page.locator('p[role="alert"]').filter({ hasText: "查找失败。" }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
  expect(state.topicReads.length).toBeGreaterThanOrEqual(2);
  expect(state.topicReads.every((postNumber) => postNumber === "6")).toBe(true);
});
