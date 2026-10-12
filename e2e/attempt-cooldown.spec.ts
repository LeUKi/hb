import { expect, type Page, type Route, test } from "@playwright/test";
import type {
  AttemptCooldown,
  AttemptRateLimitsResponse,
  ClaimActivityInput,
  ClaimDetail,
  GlobalRedemptionInput,
} from "../packages/contracts/src";

const id = "77777777-7777-4777-8777-777777777777";
const discoveryId = "88888888-8888-4888-8888-888888888888";
const claimSubmissionId = "99999999-9999-4999-8999-999999999999";
const now = Date.parse("2026-10-10T00:00:00Z");
const user = {
  id: "cooldown-viewer",
  username: "viewer",
  displayName: "冷却验收用户",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
  isAdmin: false,
};
const activity = {
  id,
  title: "账号共享冷却活动",
  rewardType: "text" as const,
  status: "active" as const,
  author: { ...user, id: "cooldown-author" },
  forceDedicated: false,
  topicUrl: null,
  openedAt: "2026-10-07T00:00:00Z",
  deadlineAt: "2026-12-01T00:00:00Z",
  quantity: { mode: "exact", total: 4, claimed: 0, remaining: 4 },
  showRecipientList: false,
  showRecipientUsername: false,
  showRecipientTime: false,
  beforeInfo: "",
  reward: { mode: "text" },
  myClaim: null,
};
const discovery = {
  id: discoveryId,
  claimSubmissionId,
  result: "none",
  items: [],
  nextCursor: null,
  total: 0,
};

function cooldownTimer(page: Page) {
  return page.getByRole("timer").filter({ hasText: "秒后可重试" });
}

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

async function mockApp(
  page: Page,
  override: (route: Route, url: URL) => Promise<boolean>,
) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (await override(route, url)) return;
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: { user, csrfToken: "csrf", attemptCooldown: null },
      });
    if (url.pathname === `/api/activities/${id}`)
      return route.fulfill({ json: { activity } });
    if (url.pathname === `/api/activities/${id}/participation`)
      return route.fulfill({ json: { claim: null, registration: null } });
    if (url.pathname === `/api/activities/${id}/passwords`)
      return route.fulfill({
        json: { passwords: [], hiddenCount: 1, canSolve: false },
      });
    if (url.pathname === "/api/discovery/activities")
      return route.fulfill({
        json: { items: [activity], nextCursor: null, total: 1 },
      });
    if (url.pathname === `/api/redemptions/${discoveryId}`)
      return route.fulfill({ json: discovery });
    return route.fulfill({ status: 404, json: {} });
  });
}

test("获准尝试的账号冷却跨首页、活动页及刷新连续，过期后可再次提交", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  await page.clock.setFixedTime(new Date(now));
  await page.emulateMedia({ reducedMotion: "reduce" });
  let serverNow = now;
  let cooldown: AttemptCooldown | null = null;
  let discoveries = 0;
  let claims = 0;
  await mockApp(page, async (route, url) => {
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user,
          csrfToken: "csrf",
          attemptCooldown: cooldown && { ...cooldown, serverTime: serverNow },
        },
      });
      return true;
    }
    if (url.pathname === "/api/redemptions/discover") {
      discoveries++;
      cooldown = {
        revision: 1,
        serverTime: serverNow,
        nextAllowedAt: serverNow + 10_000,
      };
      await route.fulfill({
        json: { ...discovery, attemptCooldown: cooldown },
      });
      return true;
    }
    if (url.pathname === `/api/activities/${id}/claim`) {
      claims++;
      cooldown = {
        revision: 2,
        serverTime: serverNow,
        nextAllowedAt: serverNow + 2_000,
      };
      await route.fulfill({
        json: { result: "incorrect", attemptCooldown: cooldown },
      });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("NoMatch123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(cooldownTimer(page)).toContainText("10 秒");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeDisabled();
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "活动广场" })
    .click();
  await page.getByRole("link", { name: "查看活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${id}`);
  await expect(cooldownTimer(page)).toContainText("10 秒");
  await expect(page.getByRole("button", { name: "领取奖励" })).toHaveCount(0);
  await page.getByLabel("兑换口令", { exact: true }).fill("StillWrong123");
  await expect(
    page.getByRole("button", { name: "还需等待 10 秒", exact: true }),
  ).toBeDisabled();
  serverNow += 2_100;
  await page.clock.setFixedTime(new Date(serverNow));
  await page.reload();
  await expect(cooldownTimer(page)).toContainText("8 秒");
  await expect(page.getByRole("button", { name: "领取奖励" })).toHaveCount(0);
  await page.getByLabel("兑换口令", { exact: true }).fill("StillWrong123");
  await expect(
    page.getByRole("button", { name: "还需等待 8 秒", exact: true }),
  ).toBeDisabled();
  serverNow += 8_100;
  await page.clock.setFixedTime(new Date(serverNow));
  await expect(cooldownTimer(page)).toHaveCount(0);
  await page.getByRole("button", { name: "领取奖励" }).click();
  await expect(
    page.getByText("口令不正确，请重新尝试。", { exact: true }),
  ).toBeVisible();
  await expect(cooldownTimer(page)).toContainText("2 秒");
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await page.getByLabel("口令", { exact: true }).fill("NextTry123");
  await expect(cooldownTimer(page)).toContainText("2 秒");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeDisabled();
  expect(discoveries).toBe(1);
  expect(claims).toBe(1);
});

test("未知响应沿原编号重试，发现结果携带服务端编号且自动领取不被发现冷却拦截", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const discoveryRequests: GlobalRedemptionInput[] = [];
  const claimRequests: ClaimActivityInput[] = [];
  let claim: ClaimDetail | null = null;
  await mockApp(page, async (route, url) => {
    if (url.pathname === "/api/redemptions/discover") {
      discoveryRequests.push(route.request().postDataJSON());
      if (discoveryRequests.length === 1)
        await route.fulfill({
          status: 503,
          json: { error: { message: "响应丢失" } },
        });
      else
        await route.fulfill({
          json: {
            ...discovery,
            result: "single",
            selectedActivityId: id,
            items: [activity],
            total: 1,
            attemptCooldown: {
              revision: 1,
              serverTime: now,
              nextAllowedAt: now + 7_000,
            },
          },
        });
      return true;
    }
    if (url.pathname === `/api/activities/${id}/claim`) {
      expect(new URL(page.url()).pathname).toBe(`/activities/${id}`);
      claimRequests.push(route.request().postDataJSON());
      if (claimRequests.length === 1)
        await route.fulfill({
          status: 503,
          json: { error: { message: "响应丢失" } },
        });
      else {
        claim = {
          id: "cooldown-claim",
          activity: { id, title: activity.title, status: "active" },
          rewardType: "text",
          text: "CooldownRealResult123",
          claimedAt: "2026-10-10T00:00:07Z",
          afterClaimInfo: "",
          sourcePassword: "Matched123",
        };
        await route.fulfill({ json: { result: "claimed", claim } });
      }
      return true;
    }
    if (url.pathname === `/api/activities/${id}/participation`) {
      await route.fulfill({ json: { claim, registration: null } });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("Matched123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(page.getByText(/尚未确认兑换结果/)).toBeVisible();
  await page.getByRole("button", { name: "再次确认", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${id}`);
  await expect(page.getByText(/尚未确认领取结果/)).toBeVisible();
  expect(discoveryRequests).toHaveLength(2);
  expect(discoveryRequests[1]).toEqual(discoveryRequests[0]);
  expect(claimRequests).toHaveLength(1);
  expect(claimRequests[0]).toEqual({
    submissionId: claimSubmissionId,
    password: "Matched123",
    discoveryId,
  });
  await expect(
    page.getByRole("button", { name: "重试原提交", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect.poll(() => claimRequests.length).toBe(2);
  expect(claimRequests[1]).toEqual(claimRequests[0]);
  await expect(
    page.getByRole("button", { name: "重试原提交", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: activity.title, exact: true }),
  ).toBeVisible();
  expect(claimRequests).toHaveLength(2);
});

test("换账号及旧账号迟到的限流响应不回填冷却、口令或未知提交", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const late = gate();
  let currentUser = user;
  let discoveryRequests = 0;
  await mockApp(page, async (route, url) => {
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: { user: currentUser, csrfToken: "csrf", attemptCooldown: null },
      });
      return true;
    }
    if (url.pathname === "/api/redemptions/discover") {
      discoveryRequests++;
      await late.wait;
      const serverTime = Date.now();
      await route.fulfill({
        status: 429,
        headers: { "Retry-After": "60" },
        json: {
          error: {
            code: "GLOBAL_REDEMPTION_RATE_LIMITED",
            message: "请稍后重试",
          },
          attemptCooldown: {
            revision: 1,
            serverTime,
            nextAllowedAt: serverTime + 60_000,
          },
        },
      });
      return true;
    }
    return false;
  });
  try {
    await page.goto("/");
    await page.getByLabel("口令", { exact: true }).fill("PrivateOld123");
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    await expect.poll(() => discoveryRequests).toBe(1);
    async function switchTo(next: typeof user) {
      currentUser = next;
      const sessionRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/session",
      );
      const other = await page.context().newPage();
      await other.goto("about:blank");
      await other.bringToFront();
      await page.bringToFront();
      await other.close();
      await page.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("visibilitychange"));
      });
      await sessionRead;
      await expect(
        page.locator("header").getByRole("link", { name: "我的账号" }),
      ).toContainText(next.displayName);
      await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
      await expect(
        page.getByRole("button", { name: "兑奖", exact: true }),
      ).toHaveCount(0);
    }
    await switchTo({ ...user, id: "cooldown-next", displayName: "新的账号" });
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/redemptions/discover",
    );
    late.release();
    await oldResponse;
    await expect(cooldownTimer(page)).toHaveCount(0);
    await expect(page.getByText(/尚未确认兑换结果|尝试过于频繁/)).toHaveCount(
      0,
    );
    await switchTo(user);
    await expect(cooldownTimer(page)).toHaveCount(0);
    expect(discoveryRequests).toBe(1);
  } finally {
    late.release();
  }
});

test("管理员桌面及手机入口可保存 5/2，版本冲突保留输入，403 清除管理内容", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let currentUser: typeof user | null = { ...user, isAdmin: true };
  let config: AttemptRateLimitsResponse = {
    config: {
      version: 1,
      homeIntervalSeconds: 60,
      activityIntervalSeconds: 60,
      updatedAt: now,
      updatedByUserId: null,
    },
    recentChanges: [],
  };
  let mode: "success" | "conflict" | "denied" = "success";
  const writes: unknown[] = [];
  let reads = 0;
  await mockApp(page, async (route, url) => {
    if (url.pathname === "/api/session") {
      await route.fulfill({
        json: {
          user: currentUser,
          csrfToken: currentUser ? "csrf" : null,
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
      return true;
    }
    if (url.pathname === "/api/admin/login-settings") {
      await route.fulfill({
        json: {
          config: {
            version: 1,
            liteauthEnabled: true,
            updatedAt: now,
            updatedByUserId: null,
          },
          recentChanges: [],
        },
      });
      return true;
    }
    if (url.pathname !== "/api/admin/rate-limits") return false;
    if (route.request().method() === "GET") {
      reads++;
      await route.fulfill({ json: config });
    } else {
      const body = route.request().postDataJSON();
      writes.push(body);
      expect(route.request().headers()["x-csrf-token"]).toBe("csrf");
      if (mode === "conflict")
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "RATE_LIMIT_CONFIG_CONFLICT",
              message: "活动内容已发生变化，请刷新后再试。当前输入已保留。",
            },
          },
        });
      else if (mode === "denied") {
        currentUser = { ...user, isAdmin: false };
        await route.fulfill({
          status: 403,
          json: {
            error: { code: "ADMIN_REQUIRED", message: "此页面仅限管理员访问" },
          },
        });
      } else {
        config = {
          config: {
            version: 2,
            homeIntervalSeconds: 5,
            activityIntervalSeconds: 2,
            updatedAt: now + 1_000,
            updatedByUserId: user.id,
          },
          recentChanges: [
            {
              id: "config-change",
              actorUserId: user.id,
              actorDisplayName: user.displayName,
              previousVersion: 1,
              nextVersion: 2,
              previousHomeIntervalSeconds: 60,
              homeIntervalSeconds: 5,
              previousActivityIntervalSeconds: 60,
              activityIntervalSeconds: 2,
              createdAt: now + 1_000,
            },
          ],
        };
        await route.fulfill({ json: config });
      }
    }
    return true;
  });
  await page.goto("/");
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "管理", exact: true })
    .click();
  await expect(page).toHaveURL("/admin");
  await page.getByRole("link", { name: "网站设置", exact: true }).click();
  await expect(page).toHaveURL("/admin/settings");
  await expect(
    page.getByRole("heading", { name: "网站管理", exact: true }),
  ).toBeVisible();
  const limitForm = page.locator("form").filter({
    has: page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  });
  await page.getByLabel("首页尝试间隔（秒）", { exact: true }).fill("5");
  await page.getByLabel("活动页尝试间隔（秒）", { exact: true }).fill("2");
  await limitForm
    .getByRole("button", { name: "保存配置", exact: true })
    .click();
  await expect(page.getByText("已保存。", { exact: true })).toBeVisible();
  expect(writes[0]).toEqual({
    expectedVersion: 1,
    homeIntervalSeconds: 5,
    activityIntervalSeconds: 2,
  });
  await expect(limitForm.getByText(/更新于/)).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await page
    .locator(".mobile-nav")
    .getByRole("link", { name: "管理", exact: true })
    .click();
  await page.getByRole("link", { name: "网站设置", exact: true }).click();
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("5");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  mode = "conflict";
  await page.getByLabel("首页尝试间隔（秒）", { exact: true }).fill("6");
  await limitForm
    .getByRole("button", { name: "保存配置", exact: true })
    .click();
  await expect(page.getByText(/网站设置已发生变化/)).toBeVisible();
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveValue("6");
  expect(writes[1]).toEqual({
    expectedVersion: 2,
    homeIntervalSeconds: 6,
    activityIntervalSeconds: 2,
  });
  mode = "denied";
  await limitForm
    .getByRole("button", { name: "保存配置", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("此页面仅限管理员访问");
  await expect(
    page.getByLabel("首页尝试间隔（秒）", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "管理", exact: true }),
  ).toHaveCount(0);
  const authorizedReads = reads;
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("此页面仅限管理员访问");
  expect(reads).toBe(authorizedReads);
  currentUser = null;
  await page.reload();
  await expect(page.getByRole("link", { name: "前往登录" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toHaveCount(0);
  expect(reads).toBe(authorizedReads);
});
