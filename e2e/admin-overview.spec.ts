import { expect, type Locator, type Page, test } from "@playwright/test";
import type { AdminOverview } from "../packages/contracts/src";

function feedbackLabel(button: Locator) {
  return button.locator('[aria-live="polite"]').last();
}

const overview: AdminOverview = {
  readAt: Date.now(),
  counts: { users: 12, activities: 8, payments: { total: 9, unconfirmed: 4 } },
  runtime: {
    environment: "local",
    realPayments: { allowed: false, blockers: ["APP_ENV"] },
    realActivityOpening: { allowed: false, blockers: ["APP_ENV"] },
    realClaims: { allowed: false, blockers: ["APP_ENV"] },
    timedDraw: { allowed: true, blockers: [] },
  },
  paymentQueue: { backlog: "未接入", note: "未接入" },
  warnings: {
    stalePayments: 2,
    unknownPayments: 1,
    attentionPayments: 1,
    drawBacklog: 1,
    undeliveredPaymentTasks: 3,
    undeliveredPaymentTasksOverdue: 1,
    staleMaintenance: 1,
  },
  paymentsByMode: [
    { mode: "real", status: "sending", count: 1, oldestAgeSeconds: 10 },
    { mode: "simulation", status: "waiting", count: 3, oldestAgeSeconds: 4000 },
  ],
  maintenance: [
    {
      job: "payments",
      scheduledAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
      status: "running",
      reason: null,
      stale: false,
    },
  ],
};
async function mock(page: Page) {
  const state = { reads: 0, fail: false };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session")
      return route.fulfill({
        json: {
          user: {
            id: "overview-admin",
            username: "admin",
            displayName: "管理员",
            avatarUrl: null,
            accountTier: "standard",
            loginProvider: "connect",
            canUseLdc: true,
            isAdmin: true,
          },
          csrfToken: "overview-session",
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
    if (path === "/api/admin/overview") {
      state.reads++;
      return state.fail
        ? route.fulfill({
            status: 503,
            json: { error: { code: "UNAVAILABLE", message: "读取失败" } },
          })
        : route.fulfill({ json: overview });
    }
    if (path.startsWith("/api/admin/"))
      return route.fulfill({
        json: { items: [], nextCursor: null, readAt: Date.now() },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

test("概览异常卡片进入准确条件，真实模拟及未接入指标分开展示", async ({
  page,
}) => {
  await mock(page);
  await page.goto("/admin");
  await expect(
    page.getByRole("navigation", { name: "管理入口" }).getByRole("link"),
  ).toHaveCount(6);
  await expect(page.getByText("未接入", { exact: true })).toBeVisible();
  await expect(page.getByText("暂无运行记录", { exact: true })).toHaveCount(3);
  await expect(
    page.getByRole("cell", { name: "发送中", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "真实", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "模拟", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "任务未投递超过十分钟 1" }).click();
  await expect(page).toHaveURL(/\/admin\/payments\?.*anomaly=undelivered/);
});

test("概览可见轮询及读取失败保留成功内容，手机不溢出", async ({ page }) => {
  await page.clock.install();
  const state = await mock(page);
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "概览", exact: true }),
  ).toBeVisible();
  const initialReads = state.reads;
  expect(initialReads).toBeGreaterThan(0);
  await page.clock.fastForward(30_000);
  await expect.poll(() => state.reads).toBeGreaterThan(initialReads);
  state.fail = true;
  const refresh = page.getByRole("button", { name: /^刷新(?:，|$)/ });
  await refresh.click();
  await expect(feedbackLabel(refresh)).toHaveText("刷新失败");
  await expect(refresh).toHaveAccessibleName("刷新，刷新失败");
  await expect(refresh).toHaveAttribute("title", "读取失败");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "付款结果未知 1" }),
  ).toBeVisible();
  await expect(
    page.getByText(/上次读取：.*读取失败，请重试。当前内容已保留。/),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const navigation = page.locator(".mobile-nav a");
  const positions = await navigation.evaluateAll((links) =>
    links.map((link) => link.getBoundingClientRect().top),
  );
  expect(new Set(positions).size).toBe(1);
});
