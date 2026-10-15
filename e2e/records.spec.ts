import { expect, type Page, test } from "@playwright/test";
import {
  type AccountHistorySummary,
  type ActivityList,
  type ActivitySummary,
  type DiscoveryCard,
  type DiscoveryList,
  encodeActivityEmoji,
  type ParticipationList,
} from "../packages/contracts/src";
import { expectPath, mockSession, openApp, viewer } from "./support/app";

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
            ? [card("77777777-7777-4777-8777-777777777777", "周末红包")]
            : [
                card("77777777-7777-4777-8777-777777777777", "周末红包"),
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
    await expect(page.getByRole("button", { name: /周末红包/ })).toBeVisible();
    await filter.getByRole("button", { name: /已结束/ }).click();
    await expect(page).toHaveURL(/\/square\?filter=ended$/);
    const ended = page.getByRole("button", { name: /已经领完/ });
    await expect(ended).toContainText("已领完");
    await ended.click();
    await expectPath(
      page,
      `/🧧/${encodeActivityEmoji("66666666-6666-4666-8666-666666666666")}`,
    );
  });
});

test.describe("红包记录", () => {
  test("我发的：合计、状态筛选（已结束含已归档）和行", async ({ page }) => {
    await mockSession(page, viewer);
    const statuses = await mockHistory(page);
    await openApp(page, "/history");
    await expect(
      page.getByText("已发 3 个，发出 11.00 LDC · 参与过 2 个，领到 3.54 LDC"),
    ).toBeVisible();
    await expect(page.getByText("还没开放，只有你能看到")).toBeVisible();
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
    const logins: string[] = [];
    await page.route("**/api/auth/login**", (route) => {
      logins.push(route.request().url());
      return route.fulfill({
        status: 302,
        headers: { Location: "/me?profile=refreshed" },
      });
    });
    await openApp(page, "/me");
    await expect(page.getByText(viewer.id)).toBeVisible();
    await expect(page.getByText("viewer@example.test")).toBeVisible();
    await expect(page.getByText("11.00 LDC")).toBeVisible();
    await expect(page.getByText("3.54 LDC")).toBeVisible();
    await expect(page.getByText("草稿 1 个")).toBeVisible();
    await page.getByRole("button", { name: "刷新资料" }).click();
    await expect(page.getByText("资料已是最新")).toBeVisible();
    // The flag is said once, then leaves the address.
    await expect(page).toHaveURL(/\/me$/);
    expect(new URL(logins[0] ?? "").searchParams.get("returnTo")).toBe(
      "/me?profile=refreshed",
    );
  });
});
