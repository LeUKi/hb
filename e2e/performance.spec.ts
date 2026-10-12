import { expect, type Page, type Route, test } from "@playwright/test";

const id = "66666666-6666-4666-8666-666666666666";
const user = {
  id: "performance-viewer",
  username: "viewer",
  displayName: "加载验收用户",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
};
const activity = {
  id,
  title: "并行读取验收",
  rewardType: "ldc",
  status: "active",
  author: { ...user, id: "performance-author" },
  forceDedicated: true,
  topicUrl: null,
  openedAt: "2026-10-07T00:00:00.000Z",
  deadlineAt: "2026-12-01T00:00:00.000Z",
  quantity: { mode: "exact", total: 4, claimed: 0, remaining: 4 },
  showRecipientList: false,
  showRecipientUsername: false,
  showRecipientTime: false,
  beforeInfo: "活动说明保持原来的位置。",
  reward: { mode: "fixed", totalAmount: "4.00", count: 4 },
  myClaim: null,
};

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function publicActivitiesDialog(page: Page) {
  return page.getByRole("dialog", { name: "活动广场", exact: true });
}

async function mockLocal(
  page: Page,
  handle: (route: Route, url: URL) => Promise<unknown>,
) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    return handle(route, url);
  });
}

test("身份确认后详情、口令与参与并行开始，慢详情不阻塞其他读取", async ({
  page,
}) => {
  const identity = gate();
  const detail = gate();
  const reads: string[] = [];
  // Development StrictMode can abort its speculative identity request.
  // Count active/completed reads rather than that canceled mount.
  page.on("requestfailed", (request) => {
    if (
      new URL(request.url()).pathname === "/api/session" &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    ) {
      const index = reads.indexOf("/api/session");
      if (index >= 0) reads.splice(index, 1);
    }
  });
  await mockLocal(page, async (route, url) => {
    reads.push(url.pathname);
    if (url.pathname === "/api/session") {
      await identity.wait;
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    }
    if (url.pathname === `/api/activities/${id}`) {
      await detail.wait;
      return route.fulfill({ json: { activity } });
    }
    if (url.pathname.endsWith("/participation"))
      return route.fulfill({ json: { claim: null, registration: null } });
    if (url.pathname.endsWith("/passwords"))
      return route.fulfill({
        json: { passwords: [], hiddenCount: 1, canSolve: false },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/activities/${id}`);
  await expect.poll(() => reads).toEqual(["/api/session"]);
  identity.release();
  await expect
    .poll(() => reads.filter((path) => path.startsWith("/api/activities/")))
    .toEqual(
      expect.arrayContaining([
        `/api/activities/${id}`,
        `/api/activities/${id}/passwords`,
      ]),
    );
  expect(reads).toHaveLength(3);
  await expect(page.getByRole("button", { name: "领取红包" })).toHaveCount(0);
  detail.release();
  await expect(page.getByRole("button", { name: "领取红包" })).toBeVisible();
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  expect(reads.filter((path) => path.endsWith("/participation"))).toHaveLength(
    1,
  );
});

test("广场等待确定身份只读一次，历史焦点信号合并并复用在途刷新", async ({
  page,
}) => {
  const identity = gate();
  const square = gate();
  const refresh = gate();
  let squareReads = 0;
  let listReads = 0;
  let summaryReads = 0;
  let holdRefresh = false;
  // StrictMode can cancel the modal's speculative first mount. The active
  // request and completed response must still represent a single list read.
  page.on("requestfailed", (request) => {
    if (
      new URL(request.url()).pathname === "/api/discovery/activities" &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    )
      squareReads--;
  });
  await mockLocal(page, async (route, url) => {
    if (url.pathname === "/api/session") {
      await identity.wait;
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    }
    if (url.pathname === "/api/discovery/activities") {
      squareReads++;
      await square.wait;
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    }
    if (url.pathname === "/api/me/activities") {
      listReads++;
      if (holdRefresh) await refresh.wait;
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    }
    if (url.pathname === "/api/me/history-summary") {
      summaryReads++;
      if (holdRefresh) await refresh.wait;
      return route.fulfill({
        json: { initiatedCount: 0, participatedCount: 0 },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/square");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("button", { name: "已公开的活动", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("正在确认登录状态…")).toBeVisible();
  expect(squareReads).toBe(0);
  identity.release();
  await expect.poll(() => squareReads).toBe(1);
  await expect(publicActivitiesDialog(page)).toBeVisible();
  await expect(page.locator('[data-loading-region="records"]')).toBeVisible();
  square.release();
  await expect(
    publicActivitiesDialog(page).getByText("暂无符合条件的活动。"),
  ).toBeVisible();
  expect(squareReads).toBe(1);
  await publicActivitiesDialog(page)
    .getByRole("button", { name: "关闭活动广场", exact: true })
    .click();
  await expect(publicActivitiesDialog(page)).toBeHidden();
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "活动历史" })
    .click();
  await expect(page.getByText("还没有符合条件的活动。")).toBeVisible();
  // Development StrictMode may abort its first mount; count explicit focus
  // refreshes after the initial data is rendered, not speculative mounts.
  const initialListReads = listReads;
  const initialSummaryReads = summaryReads;
  holdRefresh = true;
  const signalFocus = () =>
    page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await signalFocus();
  await expect.poll(() => listReads).toBe(initialListReads + 1);
  await expect.poll(() => summaryReads).toBe(initialSummaryReads + 1);
  await signalFocus();
  await page.waitForTimeout(200);
  expect(listReads).toBe(initialListReads + 1);
  expect(summaryReads).toBe(initialSummaryReads + 1);
  refresh.release();
  await expect(page.getByRole("heading", { name: "活动历史" })).toBeVisible();
  expect(squareReads).toBe(1);
});

test("邮箱单独等待和重试，不阻塞账号外壳或提前显示缺失邮箱", async ({
  page,
}) => {
  const profile = gate();
  let profileReads = 0;
  let sessionReads = 0;
  await mockLocal(page, async (route, url) => {
    if (url.pathname === "/api/session") {
      sessionReads++;
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    }
    if (url.pathname === "/api/me") {
      profileReads++;
      if (profileReads === 1) {
        await profile.wait;
        return route.fulfill({
          status: 503,
          json: { error: { message: "重试" } },
        });
      }
      return route.fulfill({
        json: {
          user: { ...user, email: "profile@example.test" },
          csrfToken: "csrf",
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "账号信息" })).toBeVisible();
  await expect(page.getByText("正在读取邮箱…")).toBeVisible();
  await expect(page.getByText("Connect 尚未提供邮箱")).toHaveCount(0);
  profile.release();
  await expect(page.getByText("邮箱读取失败。")).toBeVisible();
  const sessionsBeforeRetry = sessionReads;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("profile@example.test")).toBeVisible();
  expect(profileReads).toBe(2);
  expect(sessionReads).toBe(sessionsBeforeRetry);
});

test("终态参与继续按领取规则轮询，但后续读取不再刷新开奖 DO", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-10T00:00:00Z") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reads: (string | null)[] = [];
  await mockLocal(page, async (route, url) => {
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === `/api/activities/${id}`)
      return route.fulfill({
        json: {
          activity: {
            ...activity,
            rewardType: "ldc",
            status: "ended",
            reward: { mode: "timed_draw", totalAmount: "10.00" },
            draw: { state: "completed", registeredCount: 3, winnerCount: 1 },
          },
        },
      });
    if (url.pathname.endsWith("/participation")) {
      reads.push(url.searchParams.get("refresh"));
      return route.fulfill({
        json: {
          claim: null,
          registration: {
            id: "registration-terminal",
            activity: { id, title: activity.title, status: "ended" },
            registeredAt: "2026-10-07T01:00:00Z",
            drawAt: "2026-10-08T00:00:00Z",
            status: "not_won",
            claim: null,
          },
        },
      });
    }
    if (url.pathname.endsWith("/passwords"))
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/activities/${id}`);
  await expect.poll(() => reads.length).toBe(1);
  await expect(page.getByText("未中奖", { exact: true })).toBeVisible();
  await page.clock.fastForward(15_100);
  await expect.poll(() => reads.length).toBe(2);
  expect(reads).toEqual([null, "0"]);
});

test("切换账号后迟到的邮箱资料不能写回新账号", async ({ page }) => {
  const oldProfile = gate();
  const secondUser = { ...user, id: "second-viewer", username: "second" };
  let currentUser = user;
  let firstProfileStarted = false;
  await mockLocal(page, async (route, url) => {
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { user: currentUser, csrfToken: "csrf" } });
    if (url.pathname === "/api/me") {
      const requestedUser = currentUser;
      if (requestedUser.id === user.id) {
        firstProfileStarted = true;
        await oldProfile.wait;
      }
      return route.fulfill({
        json: {
          user: { ...requestedUser, email: `${requestedUser.id}@example.test` },
          csrfToken: "csrf",
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/account");
  await expect.poll(() => firstProfileStarted).toBe(true);
  currentUser = secondUser;
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.bringToFront();
  await other.close();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText("second-viewer@example.test")).toBeVisible();
  oldProfile.release();
  await expect(page.getByText("performance-viewer@example.test")).toHaveCount(
    0,
  );
  await expect(page.getByText("second-viewer@example.test")).toBeVisible();
});
