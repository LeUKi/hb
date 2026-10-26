import { expect, type Page, test } from "@playwright/test";
import {
  type ActivityStatistics,
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
  type PublicActivity,
} from "../packages/contracts/src";
import { type MockUser, mockSession, openApp, viewer } from "./support/app";

// The sender's own pages under a 红包 (migration phase 3): who may open
// them, and 📊 尝试统计.

const id = "88888888-9999-4aaa-8bbb-cccccccccccc";
const code = encodeActivityEmoji(id);
const author: MockUser = {
  id: "author-e2e",
  username: "author",
  displayName: "小满",
  avatarUrl: null,
  isAdmin: false,
};
const openedAt = new Date(Date.now() - 3_600_000).toISOString();

function publicActivity(): PublicActivity {
  return {
    id,
    title: "周末红包",
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: null,
    },
    forceDedicated: true,
    topicUrl: null,
    openedAt,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    quantity: { mode: "exact", total: 3, claimed: 1, remaining: 2 },
    beforeInfo: "",
  };
}

async function mockActivity(page: Page) {
  await page.route(`**/api/activities/${id}`, (route) =>
    route.fulfill({ json: { activity: publicActivity() } }),
  );
  await page.route(`**/api/me/activities/${id}`, (route) =>
    route.fulfill({
      json: {
        activity: {
          id,
          title: "周末红包",
          rewardType: "ldc",
          participationMode: "password",
          forceDedicated: true,
          status: "active",
          version: 2,
          createdAt: openedAt,
          openedAt,
          deadlineAt: publicActivity().deadlineAt,
          topicUrl: null,
          totalCount: 3,
          claimedCount: 1,
          author: publicActivity().author,
          config: {
            ...emptyActivityInput(),
            title: "周末红包",
            forceDedicated: true,
            passwords: ["周末口令2026", "公共口令2026"],
            merchantId: "55555555-6666-4777-8888-999999999999",
            money: { mode: "fixed", totalAmount: "0.30", count: 3 },
          },
        } satisfies ManagedActivity,
      },
    }),
  );
  await page.route(`**/api/me/activities/${id}/statistics**`, (route) =>
    route.fulfill({
      json: {
        totalAttempts: 4,
        uniqueUsers: 2,
        matchedAttempts: 1,
        successfulClaims: 1,
        items: [
          {
            password: "猜猜看口令2026",
            attempts: 3,
            uniqueUsers: 2,
            matchedAttempts: 0,
            matchedUsers: 0,
            unmatchedAttempts: 3,
            successfulClaims: 0,
          },
          {
            password: "周末口令2026",
            attempts: 1,
            uniqueUsers: 1,
            matchedAttempts: 1,
            matchedUsers: 1,
            unmatchedAttempts: 0,
            successfulClaims: 1,
          },
        ],
        validPasswords: [
          { password: "周末口令2026", successfulClaims: 1, registrations: 0 },
          { password: "公共口令2026", successfulClaims: 0, registrations: 0 },
        ],
        nextCursor: null,
      } satisfies ActivityStatistics,
    }),
  );
}

test.describe("红包作者的页面", () => {
  test("别人打开：只有红包作者能看", async ({ page }) => {
    await mockSession(page, viewer);
    await mockActivity(page);
    await openApp(page, `/🧧/${code}/📊`);
    await expect(
      page.getByText("只有发这个红包的人能打开这一页。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "回到红包" })).toBeVisible();
  });

  test("尝试统计：合计、每个口令和提交的内容", async ({ page }) => {
    await mockSession(page, author);
    await mockActivity(page);
    await openApp(page, `/🧧/${code}/📊`);
    await expect(page).toHaveTitle("尝试统计 · 周末红包 · lafish的红包站");
    await expect(page.getByText("4 次", { exact: true })).toBeVisible();
    await expect(page.getByText("25%")).toBeVisible();
    await expect(page.getByText("未命中 3 次")).toBeVisible();
    await expect(page.getByText("领取 1 人")).toBeVisible();
    await expect(page.getByText("是口令")).toBeVisible();
  });
});
