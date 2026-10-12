import { expect, test } from "@playwright/test";

const user = {
  id: "loading-owner",
  username: "owner",
  displayName: "作者",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
};
function statistics(password: string, nextCursor: string | null) {
  return {
    totalAttempts: 28,
    uniqueUsers: 12,
    successfulClaims: 3,
    items: [
      {
        password,
        attempts: 2,
        uniqueUsers: 1,
        matchedAttempts: 1,
        unmatchedAttempts: 1,
        successfulClaims: 1,
      },
    ],
    validPasswords: [{ password: "已授权有效口令", successfulClaims: 3 }],
    nextCursor,
  };
}

test("统计分页保留摘要、框架和高度，权限撤销后500及返回缓存页不恢复私有内容", async ({
  page,
}) => {
  let status = 200;
  let pause = false;
  let release = () => {};
  let statisticsRequests = 0;
  const forbidden: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:5173") {
      forbidden.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/me/history-summary")
      return route.fulfill({
        json: { initiatedCount: 0, participatedCount: 0 },
      });
    if (url.pathname === "/api/me/activities")
      return route.fulfill({
        json: {
          total: 0,
          items: [],
          nextCursor: null,
          statusCounts: {
            all: 0,
            draft: 0,
            active: 0,
            ended: 0,
            archived: 0,
          },
        },
      });
    if (
      url.pathname.startsWith("/api/") &&
      url.pathname.endsWith("/statistics")
    ) {
      statisticsRequests += 1;
      if (pause)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (status !== 200)
        return route.fulfill({
          status,
          json: { error: { code: "FAILED", message: "无权读取或临时失败" } },
        });
      const cursor = url.searchParams.get("cursor");
      return route.fulfill({
        json: statistics(
          cursor ? "第二页提交" : "第一页提交",
          cursor ? null : "page2",
        ),
      });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.clock.install();
  await page.goto("/my/activities/statistics-test/statistics");
  await expect(page).toHaveURL(/\/my\/activities\?statistics=statistics-test$/);
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toBeVisible();
  const heading = await statisticsDialog
    .getByRole("heading", { name: "兑换尝试统计", exact: true })
    .elementHandle();
  const summary = await statisticsDialog
    .locator(".attempt-statistics-summary")
    .elementHandle();
  const header = await statisticsDialog.locator("thead").elementHandle();
  const pager = await statisticsDialog
    .getByRole("navigation", { name: "兑换尝试统计分页" })
    .elementHandle();
  const region = statisticsDialog.locator(".list-panel__content");
  const height = (await region.boundingBox())?.height ?? 0;
  pause = true;
  await statisticsDialog
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(statisticsDialog.locator(".list-panel")).toHaveAttribute(
    "data-state",
    "loading",
  );
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toHaveCount(0);
  await expect(
    statisticsDialog.locator(".attempt-statistics-summary"),
  ).toContainText("28");
  for (const node of [heading, summary, header, pager])
    expect(await node?.evaluate((el) => el.isConnected)).toBe(true);
  expect(
    Math.abs(((await region.boundingBox())?.height ?? 0) - height),
  ).toBeLessThan(2);
  await expect(
    statisticsDialog.getByRole("button", { name: "上一页" }),
  ).toBeDisabled();
  pause = false;
  release();
  await expect(
    statisticsDialog.getByRole("cell", { name: "第二页提交" }),
  ).toBeVisible();

  // Confirm a cached condition returns without replacing the current records.
  const requestsBeforeReturn = statisticsRequests;
  await statisticsDialog
    .getByRole("button", { name: "上一页", exact: true })
    .click();
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toBeVisible();
  await expect(statisticsDialog.locator(".list-panel")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await statisticsDialog
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await page.clock.runFor(100);
  await expect(
    statisticsDialog.getByRole("cell", { name: "第二页提交" }),
  ).toBeVisible();
  expect(statisticsRequests).toBe(requestsBeforeReturn);
  status = 403;
  await page.clock.fastForward(15001);
  await expect(statisticsDialog.locator(".list-panel")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(
    statisticsDialog.getByText("已授权有效口令", { exact: true }),
  ).toHaveCount(0);
  status = 500;
  await statisticsDialog
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(statisticsDialog.locator(".list-panel")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toHaveCount(0);
  await expect(
    statisticsDialog.locator(".attempt-statistics-summary"),
  ).not.toContainText("28");
  await statisticsDialog
    .getByRole("button", { name: "上一页", exact: true })
    .click();
  await expect(statisticsDialog.locator(".list-panel")).toHaveAttribute(
    "data-state",
    "error",
  );
  await expect(
    statisticsDialog.getByText("已授权有效口令", { exact: true }),
  ).toHaveCount(0);
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toHaveCount(0);
  status = 200;
  await statisticsDialog
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await expect(
    statisticsDialog.getByRole("cell", { name: "第一页提交" }),
  ).toBeVisible();
  expect(forbidden).toEqual([]);
});
