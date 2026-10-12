import { expect, type Page, test } from "@playwright/test";
import type { DiscoveryCard } from "../packages/contracts/src";

const user = {
  id: "viewer-loading",
  username: "viewer",
  displayName: "加载验收",
  avatarUrl: null,
  accountTier: "standard" as const,
  canUseLdc: true,
  loginProvider: "connect" as const,
};

function publicActivitiesDialog(page: Page) {
  return page.getByRole("dialog", { name: "活动广场", exact: true });
}

async function openPublicActivities(page: Page, path = "/square") {
  await page.goto(path);
  await expect(page).toHaveURL("/");
  const dialog = publicActivitiesDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

function card(id: string, title: string): DiscoveryCard {
  return {
    id,
    title,
    rewardType: "ldc",
    status: "active",
    author: {
      id: "author",
      username: "author",
      displayName: "作者",
      avatarUrl: null,
      accountTier: "standard",
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: "2026-10-07T00:00:00.000Z",
    deadlineAt: "2026-10-08T00:00:00.000Z",
    quantity: { mode: "fuzzy", level: "limited" },
    reward: { mode: "fixed", unitAmount: "1.00", totalAmount: "1.00" },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    myClaim: null,
  };
}

test("筛选慢请求只替换记录区并保留列表框架", async ({ page }) => {
  const ended = {
    resolve: (_value: {
      items: DiscoveryCard[];
      nextCursor: null;
      total: number;
    }) => {},
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities") {
      const status = url.searchParams.get("status");
      if (status === "ended") {
        const payload = await new Promise<{
          items: DiscoveryCard[];
          nextCursor: null;
          total: number;
        }>((resolve) => {
          ended.resolve = resolve;
        });
        return route.fulfill({ json: payload });
      }
      return route.fulfill({
        json: {
          items: [card("active-1", "进行中的活动")],
          nextCursor: null,
          total: 1,
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  const dialog = await openPublicActivities(page);
  await expect(page.getByRole("link", { name: "进行中的活动" })).toBeVisible();

  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "已结束" }).click();

  await expect(dialog).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "活动" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "活动广场分页" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "进行中的活动" })).toHaveCount(0);
  await expect(
    page.locator("[data-skeleton-row='true']").first(),
  ).toBeVisible();

  ended.resolve({
    items: [card("ended-1", "已结束的活动")],
    nextCursor: null,
    total: 1,
  });
  await expect(page.getByRole("link", { name: "已结束的活动" })).toBeVisible();
});

test("连续筛选以最新条件为准，迟到响应不会覆盖当前列表", async ({ page }) => {
  const ended = { release: () => {} };
  let markEndedStarted: (() => void) | null = null;
  const endedStarted = new Promise<void>((resolve) => {
    markEndedStarted = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities") {
      const status = url.searchParams.get("status");
      if (status === "ended") {
        markEndedStarted?.();
        await new Promise<void>((resolve) => {
          ended.release = resolve;
        });
        return route.fulfill({
          json: {
            items: [card("ended-late", "迟到的已结束活动")],
            nextCursor: null,
            total: 1,
          },
        });
      }
      return route.fulfill({
        json: {
          items: [
            card(
              status === "all" ? "all-current" : "active-current",
              status === "all" ? "最新的全部活动" : "当前进行中活动",
            ),
          ],
          nextCursor: null,
          total: 1,
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPublicActivities(page);
  await expect(
    page.getByRole("link", { name: "最新的全部活动" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "已结束" }).click();
  await endedStarted;
  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "全部" }).click();
  await expect(
    page.getByRole("link", { name: "最新的全部活动" }),
  ).toBeVisible();

  ended.release();
  await page.waitForTimeout(100);
  await expect(
    page.getByRole("link", { name: "最新的全部活动" }),
  ).toBeVisible();
  await expect(page.getByText("迟到的已结束活动")).toHaveCount(0);
});

test("后台刷新失败保留当前内容并显示局部刷新提示", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-07T08:00:00Z") });
  let failDiscovery = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities") {
      if (failDiscovery)
        return route.fulfill({
          status: 500,
          json: { error: { message: "刷新失败" } },
        });
      return route.fulfill({
        json: {
          items: [card("active-stable", "刷新前已经显示的活动")],
          nextCursor: null,
          total: 1,
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPublicActivities(page);
  await expect(
    page.getByRole("link", { name: "刷新前已经显示的活动" }),
  ).toBeVisible();

  failDiscovery = true;
  await page.clock.fastForward(15_000);
  await expect(page.getByText("刷新失败，当前内容已保留。")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "刷新前已经显示的活动" }),
  ).toBeVisible();
  await expect(page.locator("[data-loading-region='records']")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("手动刷新广场保留当前内容和筛选，完成后更新记录", async ({ page }) => {
  let isManualRefresh = false;
  let releaseRefresh = () => {};
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities") {
      const manualRefresh = isManualRefresh;
      if (manualRefresh)
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
      return route.fulfill({
        json: {
          items: [
            card(
              manualRefresh ? "manual-refresh-new" : "manual-refresh-old",
              manualRefresh ? "刷新后的活动" : "刷新前的活动",
            ),
          ],
          nextCursor: null,
          total: 1,
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await openPublicActivities(page, "/square?status=all&type=ldc");
  await expect(page.getByRole("link", { name: "刷新前的活动" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "活动状态筛选" }),
  ).toContainText("状态：全部");

  isManualRefresh = true;
  await page.getByRole("button", { name: "刷新活动列表" }).click();
  await expect(page.getByRole("link", { name: "刷新前的活动" })).toBeVisible();
  await expect(page.getByText("第 1 页")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("type")).toBeNull();
  expect(new URL(page.url()).searchParams.get("status")).toBeNull();
  releaseRefresh();
  await expect(page.getByRole("link", { name: "刷新后的活动" })).toBeVisible();
});

test("手动刷新我发起的保留当前内容筛选和分页，完成后更新列表与统计", async ({
  page,
}) => {
  const author = {
    id: "author-loading",
    username: "author",
    displayName: "作者",
    avatarUrl: null,
  };
  const historyActivity = (id: string, title: string) => ({
    id,
    title,
    rewardType: "ldc",
    status: "active",
    version: 1,
    createdAt: "2026-10-07T00:00:00Z",
    openedAt: "2026-10-07T00:00:00Z",
    deadlineAt: "2026-10-08T00:00:00Z",
    topicUrl: null,
    totalCount: 30,
    claimedCount: 10,
    forceDedicated: true,
    reward: {
      mode: "fixed",
      unitAmount: "0.88",
      totalAmount: "26.40",
    },
    paymentMode: "simulation",
    draw: null,
    author,
  });
  const firstPage = Array.from({ length: 20 }, (_, index) =>
    historyActivity(`author-first-${index}`, `第一页活动 ${index + 1}`),
  );
  let isManualHistoryRefresh = false;
  let releaseActivities = () => {};
  let releaseSummary = () => {};

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/me/history-summary") {
      const manualRefresh = isManualHistoryRefresh;
      if (manualRefresh)
        await new Promise<void>((resolve) => {
          releaseSummary = resolve;
        });
      return route.fulfill({
        json: {
          initiatedCount: manualRefresh ? 8 : 7,
          participatedCount: 3,
        },
      });
    }
    if (url.pathname === "/api/me/activities") {
      const secondPage = url.searchParams.get("cursor") === "author-page-2";
      const manualRefresh = isManualHistoryRefresh;
      if (manualRefresh)
        await new Promise<void>((resolve) => {
          releaseActivities = resolve;
        });
      return route.fulfill({
        json: {
          total: 24,
          nextCursor: secondPage ? null : "author-page-2",
          statusCounts: {
            all: 24,
            draft: 0,
            active: 24,
            ended: 0,
            archived: 0,
          },
          items: secondPage
            ? [
                historyActivity(
                  manualRefresh ? "author-refreshed" : "author-before-refresh",
                  manualRefresh ? "刷新后的我发起活动" : "刷新前的我发起活动",
                ),
              ]
            : firstPage,
        },
      });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/my/activities?type=ldc");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("刷新前的我发起活动")).toBeVisible();
  await expect(page.getByText("第 2 页")).toBeVisible();
  await expect(
    page.locator(".history-statistics", { hasText: "已发起" }),
  ).toContainText("7场");
  expect(new URL(page.url()).searchParams.get("type")).toBeNull();

  isManualHistoryRefresh = true;
  await page.getByRole("button", { name: "刷新活动列表" }).click();
  await expect(page.getByText("刷新前的我发起活动")).toBeVisible();
  await expect(page.getByText("第 2 页")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("type")).toBeNull();

  releaseSummary();
  releaseActivities();
  await expect(page.getByText("刷新后的我发起活动")).toBeVisible();
  await expect(page.getByText("刷新前的我发起活动")).toHaveCount(0);
  await expect(page.getByText("第 2 页")).toBeVisible();
  await expect(
    page.locator(".history-statistics", { hasText: "已发起" }),
  ).toContainText("8场");
});
