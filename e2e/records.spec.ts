import { expect, type Page, test } from "@playwright/test";
import {
  type AccountHistorySummary,
  type ActivityList,
  type ActivitySummary,
  type DiscoveryCard,
  type DiscoveryList,
  encodeActivityEmoji,
  type Merchant,
  type MerchantList,
  type ParticipationList,
} from "../packages/contracts/src";
import {
  expectPath,
  identityButton,
  mockSession,
  openApp,
  viewer,
} from "./support/app";

// 红包广场, 红包记录 and 账号资料 (migration phase 3) against a mocked API.

const hour = 3_600_000;
const author = {
  id: "author-e2e",
  username: "author",
  displayName: "小满",
  avatarUrl: null,
};

function card(id: string, title: string, extra: Partial<DiscoveryCard> = {}) {
  return {
    id,
    title,
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: new Date(Date.now() - hour).toISOString(),
    deadlineAt: new Date(Date.now() + hour).toISOString(),
    quantity: { mode: "exact", total: 5, claimed: 2, remaining: 3 },
    reward: {
      mode: "fixed",
      totalAmount: "0.50",
      unitAmount: "0.10",
      count: 5,
    },
    myClaim: null,
    ...extra,
  } satisfies DiscoveryCard;
}

const summary: AccountHistorySummary = {
  initiatedCount: 3,
  participatedCount: 2,
  sentAmount: "11.00",
  receivedAmount: "3.54",
};

function sent(
  id: string,
  title: string,
  extra: Partial<ActivitySummary> = {},
): ActivitySummary {
  return {
    id,
    title,
    rewardType: "ldc",
    participationMode: "password",
    forceDedicated: false,
    status: "active",
    version: 2,
    createdAt: new Date(Date.now() - 2 * hour).toISOString(),
    openedAt: new Date(Date.now() - 2 * hour).toISOString(),
    deadlineAt: new Date(Date.now() + hour).toISOString(),
    topicUrl: null,
    totalCount: 3,
    claimedCount: 1,
    reward: {
      mode: "fixed",
      totalAmount: "0.30",
      unitAmount: "0.10",
      count: 3,
    },
    ...extra,
  };
}

/** Tomorrow at 20:00, on this device. */
function tomorrowAt20() {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(20, 0, 0, 0);
  return at;
}

const statusCounts = { all: 3, draft: 1, active: 1, ended: 0, archived: 1 };

/** Answers the account's lists; records the status filters asked for. */
async function mockHistory(page: Page) {
  const statuses: string[] = [];
  await page.route("**/api/me/history-summary", (route) =>
    route.fulfill({ json: summary }),
  );
  await page.route("**/api/me/activities?**", (route) => {
    const status = new URL(route.request().url()).searchParams.get("status");
    statuses.push(status ?? "");
    const items =
      status === "finished"
        ? [
            sent("33333333-3333-4333-8333-333333333333", "旧红包", {
              status: "archived",
              deadlineAt: new Date(Date.now() - 100 * hour).toISOString(),
            }),
          ]
        : [
            sent("11111111-1111-4111-8111-111111111111", "周末红包"),
            sent("22222222-2222-4222-8222-222222222222", "还在写的", {
              status: "draft",
              openedAt: null,
              claimedCount: 0,
            }),
            // 定时开放: one timed, and one whose timing did not open it.
            sent("44444444-4444-4444-8444-444444444444", "明晚的红包", {
              status: "draft",
              openedAt: null,
              claimedCount: 0,
              scheduledOpenAt: tomorrowAt20().toISOString(),
            }),
            sent("55555555-5555-4555-8555-555555555555", "没开成的", {
              status: "draft",
              openedAt: null,
              claimedCount: 0,
              scheduleFailure: {
                at: new Date().toISOString(),
                reason: "🐟额可用不够",
              },
            }),
          ];
    return route.fulfill({
      json: {
        items,
        nextCursor: null,
        total: items.length,
        statusCounts,
      } satisfies ActivityList,
    });
  });
  await page.route("**/api/me/participations?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            kind: "claim",
            claim: {
              id: "claim-1",
              activity: {
                id: "44444444-4444-4444-8444-444444444444",
                title: "读书会红包",
                status: "active",
                author,
              },
              rewardType: "ldc",
              claimedAt: new Date(Date.now() - hour).toISOString(),
              sourcePassword: "读书口令2026",
              amount: "3.54",
              payment: {
                id: "payment-1",
                mode: "real",
                status: "confirmed",
                reason: null,
                confirmedAt: new Date().toISOString(),
              },
            },
          },
          {
            kind: "claim",
            claim: {
              id: "claim-2",
              activity: {
                id: "66666666-6666-4666-8666-666666666666",
                title: "上周的红包",
                status: "ended",
                author,
              },
              rewardType: "ldc",
              claimedAt: new Date(Date.now() - 3 * hour).toISOString(),
              sourcePassword: "上周口令2026",
              amount: "1.00",
              payment: {
                id: "payment-2",
                mode: "real",
                status: "pending",
                reason: null,
                confirmedAt: null,
              },
            },
          },
          {
            kind: "registration",
            registration: {
              id: "registration-1",
              activity: {
                id: "55555555-5555-4555-8555-555555555555",
                title: "限时开奖",
                status: "active",
                author,
              },
              registeredAt: new Date(Date.now() - 2 * hour).toISOString(),
              status: "registered",
              drawAt: null,
              claim: null,
            },
          },
        ],
        nextCursor: null,
        total: 3,
      } satisfies ParticipationList,
    }),
  );
  return statuses;
}

test.describe("红包广场", () => {
  test("游客按状态浏览，计数各自来自服务端", async ({ page }) => {
    await mockSession(page, null);
    await page.route("**/api/discovery/activities?**", (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      const items =
        status === "ended"
          ? [
              card("66666666-6666-4666-8666-666666666666", "已经领完", {
                status: "ended",
                quantity: { mode: "exact", total: 5, claimed: 5, remaining: 0 },
              }),
            ]
          : status === "active"
            ? [
                card("77777777-7777-4777-8777-777777777777", "周末红包", {
                  forceDedicated: true,
                  topicUrl: "https://linux.do/t/3033290/12",
                  page: {
                    url: "https://puzzle.example.com/today",
                    host: "puzzle.example.com",
                  },
                }),
              ]
            : [
                card("77777777-7777-4777-8777-777777777777", "周末红包", {
                  forceDedicated: true,
                  topicUrl: "https://linux.do/t/3033290/12",
                  page: {
                    url: "https://puzzle.example.com/today",
                    host: "puzzle.example.com",
                  },
                }),
                card("66666666-6666-4666-8666-666666666666", "已经领完", {
                  status: "ended",
                  quantity: {
                    mode: "exact",
                    total: 5,
                    claimed: 5,
                    remaining: 0,
                  },
                }),
              ];
      return route.fulfill({
        json: {
          items,
          nextCursor: null,
          total: items.length,
        } satisfies DiscoveryList,
      });
    });
    await openApp(page, "/square");
    await expect(page.getByRole("heading", { name: "红包广场" })).toBeVisible();
    const filter = page.getByRole("group", { name: "筛选" });
    await expect(
      filter.getByRole("button", { name: /进行中\s*1/ }),
    ).toBeVisible();
    await expect(
      filter.getByRole("button", { name: /全部\s*2/ }),
    ).toBeVisible();
    // 全部 by default: the running one and the recently ended one; one
    // with 首页领取 off says so, as it is entered from here.
    await expect(page.getByRole("button", { name: /周末红包/ })).toContainText(
      "关闭首页领取",
    );
    await expect(
      page.getByRole("button", { name: /已经领完/ }),
    ).not.toContainText("关闭首页领取");
    // One linked to a post says where it comes from, LINUX DO's logo
    // before it.
    const post = page
      .getByRole("button", { name: /周末红包/ })
      .getByText("来自帖子", { exact: true });
    await expect(post).toBeVisible();
    await expect(post.locator("svg.linux-do-mark")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /已经领完/ }),
    ).not.toContainText("来自帖子");
    // One with a 附带网页 says so, its globe before it (the page opens on
    // the 红包 page: the card is one button).
    const attached = page
      .getByRole("button", { name: /周末红包/ })
      .getByText("附带网页", { exact: true });
    await expect(attached).toBeVisible();
    await expect(attached.locator("svg.lucide-globe")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: /已经领完/ }),
    ).not.toContainText("附带网页");
    await expect(page.getByRole("button", { name: /已经领完/ })).toBeVisible();
    await filter.getByRole("button", { name: /最近结束/ }).click();
    await expect(page).toHaveURL(/\/square\?filter=ended$/);
    const ended = page.getByRole("button", { name: /已经领完/ });
    await expect(ended).toContainText("已领完");
    await ended.click();
    await expectPath(
      page,
      `/🧧/${encodeActivityEmoji("66666666-6666-4666-8666-666666666666")}`,
    );
  });
  test("即将开放：加入广场的定时红包单独一栏，卡片写几点开放；空着时这样写", async ({
    page,
  }) => {
    await mockSession(page, null);
    let upcoming = [
      card("88888888-8888-4888-8888-888888888888", "明晚的红包", {
        status: "draft",
        openedAt: null,
        deadlineAt: null,
        scheduledOpenAt: tomorrowAt20().toISOString(),
      }),
    ];
    const asked: string[] = [];
    await page.route("**/api/discovery/activities?**", (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      asked.push(status ?? "");
      const items =
        status === "upcoming"
          ? upcoming
          : [card("77777777-7777-4777-8777-777777777777", "周末红包")];
      return route.fulfill({
        json: {
          items,
          nextCursor: null,
          total: items.length,
        } satisfies DiscoveryList,
      });
    });
    await openApp(page, "/square");
    const filter = page.getByRole("group", { name: "筛选" });
    // 全部 / 即将开放 / 进行中 / 最近结束, in that order.
    await expect(filter.getByRole("button")).toHaveText([
      /全部/,
      /即将开放/,
      /进行中/,
      /最近结束/,
    ]);
    await expect(
      filter.getByRole("button", { name: /即将开放\s*1/ }),
    ).toBeVisible();
    // 全部 is the opened ones.
    await expect(page.getByRole("button", { name: /明晚的红包/ })).toHaveCount(
      0,
    );
    await filter.getByRole("button", { name: /即将开放/ }).click();
    await expect(page).toHaveURL(/\/square\?filter=upcoming$/);
    const timed = page.getByRole("button", { name: /明晚的红包/ });
    await expect(timed).toContainText("即将开放");
    await expect(timed).toContainText("明天 20:00 开放");
    expect(asked).toContain("upcoming");
    // Nothing timed: said so.
    upcoming = [];
    await page.reload();
    await expect(page.getByText("现在没有即将开放的红包")).toBeVisible();
  });
});

test.describe("红包记录", () => {
  test("顶栏里的入口：发红包右边、头像左边，只有图标", async ({ page }) => {
    await mockSession(page, viewer);
    await mockHistory(page);
    await openApp(page);
    const bar = page.getByRole("banner");
    const create = bar.getByRole("link", { name: "发红包" });
    const records = bar.getByRole("link", { name: "红包记录" });
    await expect(records).toHaveAttribute("href", "/history");
    await expect(records).toHaveText("");
    const x = async (locator: typeof records) =>
      (await locator.boundingBox())?.x ?? Number.NaN;
    expect(await x(create)).toBeLessThan(await x(records));
    expect(await x(records)).toBeLessThan(await x(identityButton(page)));
    await records.click();
    await expectPath(page, "/history");
    await expect(records).toHaveAttribute("aria-current", "page");
  });

  test("我发的：合计、状态筛选（已结束含已归档）和行", async ({ page }) => {
    await mockSession(page, viewer);
    const statuses = await mockHistory(page);
    await openApp(page, "/history");
    await expect(
      page.getByText("已发 3 个，发出 11.00 LDC · 参与过 2 个，领到 3.54 LDC"),
    ).toBeVisible();
    await expect(page.getByText("还没开放，拿到链接的人能看到")).toBeVisible();
    // 定时开放: 待开放 and when; one that did not open says why.
    const timed = page.getByRole("listitem").filter({ hasText: "明晚的红包" });
    await expect(timed).toContainText("待开放");
    await expect(timed).toContainText("明天 20:00 开放");
    await expect(
      page.getByText("定时开放没有成功：🐟额可用不够"),
    ).toBeVisible();
    // Each opened 红包 has its 名单 (opened in place); a draft has nobody yet.
    await expect(
      page.getByRole("button", { name: "名单「周末红包」" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
    await expect(
      page.getByRole("button", { name: "名单「还在写的」" }),
    ).toHaveCount(0);
    const filter = page.getByRole("group", { name: "状态筛选" });
    await expect(
      filter.getByRole("button", { name: /已结束\s*1/ }),
    ).toBeVisible();
    await filter.getByRole("button", { name: /已结束/ }).click();
    await expect(page.getByText("旧红包")).toBeVisible();
    await expect(page.getByText("已归档")).toBeVisible();
    expect(statuses).toContain("finished");
    await expect(page).toHaveURL(/filter=ended/);
  });

  test("我参与的：金额、发放状态和报名结果", async ({ page }) => {
    await mockSession(page, viewer);
    await mockHistory(page);
    await openApp(page, "/history?tab=joined");
    // A running 红包's 口令 stays off the list (a screenshot of it would give
    // the 口令 away); once it ended, the 口令 is public.
    await expect(page.getByText("小满的红包 · 用口令领取")).toBeVisible();
    await expect(page.getByText("读书口令2026")).toHaveCount(0);
    await expect(
      page.getByText("小满的红包 · 用口令 上周口令2026 领取"),
    ).toBeVisible();
    await expect(page.getByText("已发放")).toBeVisible();
    await expect(page.getByText("小满的红包 · 直接报名")).toBeVisible();
    await expect(page.getByText("已报名", { exact: true })).toBeVisible();
  });
});

test.describe("账号资料", () => {
  test("资料、红包合计和刷新资料的往返", async ({ page }) => {
    await mockSession(page, viewer);
    await mockHistory(page);
    await page.route("**/api/me", (route) =>
      route.fulfill({
        json: {
          user: { ...viewer, email: "viewer@example.test" },
          csrfToken: "csrf-e2e-token",
        },
      }),
    );
    await page.route("**/api/me/rank-visibility", (route) =>
      route.fulfill({ json: { sent: true, received: false } }),
    );
    const logins: string[] = [];
    await page.route("**/api/auth/login**", (route) => {
      logins.push(route.request().url());
      return route.fulfill({
        status: 302,
        headers: { Location: "/me?profile=refreshed" },
      });
    });
    // LDC 商户: whether it can pay now, its pause said (07 §4).
    const merchant = {
      id: "m-e2e",
      label: "我的商户",
      usageStatus: "current",
      clientId: "client_e2e",
      pausedReason: "funds",
      credentialVerification: {
        status: "passed",
        credentialVersion: 1,
        checkedAt: new Date().toISOString(),
        nextCheckAt: null,
        reason: null,
      },
    } as unknown as Merchant;
    await page.route("**/api/me/merchants", (route) =>
      route.fulfill({
        json: {
          items: [merchant],
          nextCursor: null,
          currentMerchantId: merchant.id,
          canCreate: true,
          canSimulate: false,
        } satisfies MerchantList,
      }),
    );
    await openApp(page, "/me");
    await expect(page.getByText(viewer.id)).toBeVisible();
    // The often used first, 资料 after them (2026-10-28).
    await expect(page.locator("main h2")).toHaveText([
      "红包",
      "LDC 商户",
      "排行榜",
      "资料",
    ]);
    const shop = page.getByRole("region", { name: "LDC 商户" });
    await expect(shop).toContainText("我的商户");
    await expect(shop).toContainText("凭证检查通过");
    await expect(shop).toContainText("付款已暂停：商户资金不足");
    await expect(shop.getByRole("link", { name: "商户" })).toHaveAttribute(
      "href",
      "/merchant",
    );
    await expect(page.getByText("viewer@example.test")).toBeVisible();
    await expect(page.getByText("11.00 LDC")).toBeVisible();
    await expect(page.getByText("3.54 LDC")).toBeVisible();
    // 草稿 is the way to them.
    await expect(page.getByRole("link", { name: "草稿 1 个" })).toHaveAttribute(
      "href",
      "/history?filter=draft",
    );
    // 排行榜: the two switches as chosen (07 §4).
    await expect(
      page.getByRole("switch", { name: "在发出榜上显示我" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("switch", { name: "在领到榜上显示我" }),
    ).toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "刷新资料" }).click();
    await expect(page.getByText("资料已是最新")).toBeVisible();
    // The flag is said once, then leaves the address.
    await expect(page).toHaveURL(/\/me$/);
    expect(new URL(logins[0] ?? "").searchParams.get("returnTo")).toBe(
      "/me?profile=refreshed",
    );
  });
});
