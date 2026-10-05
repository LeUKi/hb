import { expect, type Page, test } from "@playwright/test";
import type {
  ClaimActivityInput,
  DiscoveryCard,
  GlobalRedemptionResult,
} from "../packages/contracts/src";

const ids = [
  "790f9912-9934-4dfc-8efc-7c32962a3e82",
  "084cfc63-5e47-4c92-a5c9-b14e12b0a798",
];
const requestId = "4d95d1e9-a564-4ba0-9c6c-92a9e9d5eb0b";
const user = {
  id: "viewer-1",
  username: "ada",
  displayName: "Ada",
  avatarUrl: null,
};
function card(index: number): DiscoveryCard {
  return {
    id: ids[index] ?? (ids[0] as string),
    title: `同口令活动${index + 1}`,
    rewardType: "text",
    status: index === 0 ? "active" : "ended",
    author: {
      id: "author",
      username: "maker",
      displayName: "作者",
      avatarUrl: null,
    },
    forceDedicated: false,
    topicUrl: "https://linux.do/t/123",
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    quantity: { mode: "fuzzy", level: "limited" },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    myClaim: null,
  };
}
async function mock(page: Page) {
  const state = {
    signedIn: true,
    posts: [] as ClaimActivityInput[],
    claims: [] as ClaimActivityInput[],
    refreshes: 0,
    failFirst: false,
    rateLimitFirst: false,
    result: "multiple" as GlobalRedemptionResult["result"],
    cards: [card(0), card(1)],
    topicReplies: [] as string[],
    claimed: false,
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: state.signedIn
          ? { user, csrfToken: "csrf" }
          : { user: null, csrfToken: null },
      });
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/redemptions") {
      state.posts.push(req.postDataJSON());
      if (state.failFirst && state.posts.length === 1) return route.abort();
      if (state.rateLimitFirst && state.posts.length === 1)
        return route.fulfill({
          status: 429,
          headers: { "Retry-After": "1" },
          json: {
            error: { code: "CLAIM_RATE_LIMITED", message: "请稍后重试" },
          },
        });
      return route.fulfill({
        json: {
          id: requestId,
          result: state.result,
          items: state.cards,
          nextCursor: null,
          ...(state.result === "single"
            ? { selectedActivityId: ids[0], claimResult: { result: "ended" } }
            : {}),
        },
      });
    }
    if (path === `/api/redemptions/${requestId}`) {
      state.refreshes++;
      return route.fulfill({
        json: {
          id: requestId,
          result: state.result,
          items: state.cards,
          nextCursor: null,
        },
      });
    }
    if (path === "/api/topics/123/activities") {
      state.topicReplies.push(
        new URL(req.url()).searchParams.get("postNumber") ?? "1",
      );
      return route.fulfill({ json: { items: state.cards, nextCursor: null } });
    }
    if (path === "/api/discovery/activities")
      return route.fulfill({ json: { items: state.cards, nextCursor: null } });
    if (path === `/api/me/activities/${ids[0]}/statistics`)
      return route.fulfill({
        json: {
          totalAttempts: 5,
          uniqueUsers: 2,
          successfulClaims: 1,
          items: [
            {
              password: "Answer123",
              attempts: 5,
              uniqueUsers: 2,
              matchedAttempts: 2,
              unmatchedAttempts: 3,
              successfulClaims: 1,
            },
          ],
          validPasswords: [{ password: "Answer123", successfulClaims: 1 }],
          nextCursor: null,
        },
      });
    for (const [index, id] of ids.entries()) {
      if (path === `/api/activities/${id}`)
        return route.fulfill({
          json: {
            activity: { ...card(index), beforeInfo: "先查看活动，再确认领取" },
          },
        });
      if (path === `/api/activities/${id}/recipients`)
        return route.fulfill({
          json: { enabled: false, items: [], nextCursor: null },
        });
      if (path === `/api/activities/${id}/claim`) {
        const claim = {
          id: "claimed-1",
          activity: { id, title: card(index).title, status: "active" },
          rewardType: "text",
          text: "MATCH-PRIVATE",
          claimedAt: new Date().toISOString(),
          afterClaimInfo: "领取后说明",
        };
        if (req.method() === "GET")
          return route.fulfill({
            json: { claim: state.claimed ? claim : null },
          });
        state.claims.push(req.postDataJSON());
        state.claimed = true;
        return route.fulfill({ json: { result: "claimed", claim } });
      }
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: "未找到", code: "NOT_FOUND" } },
    });
  });
  return state;
}
async function redeem(page: Page) {
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑换", exact: true }).click();
}

test("多个匹配先选活动，口令预填，返回只读刷新不再次全站提交", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/");
  await redeem(page);
  await expect(
    page.getByRole("heading", { name: "匹配活动", exact: true }),
  ).toBeVisible();
  expect(state.claims).toHaveLength(0);
  await page
    .getByRole("link", { name: "查看活动", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveValue(
    "Answer123",
  );
  expect(state.claims).toHaveLength(0);
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await expect(page.getByText("MATCH-PRIVATE", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回匹配列表", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "匹配活动", exact: true }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.claims).toHaveLength(1);
  expect(state.refreshes).toBeGreaterThan(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("Answer123");
  expect(page.url()).not.toContain("Answer123");
});

test("全站未知结果保留原请求，安全重试使用同一标识", async ({ page }) => {
  const state = await mock(page);
  state.failFirst = true;
  await page.goto("/");
  await redeem(page);
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "匹配活动", exact: true }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]).toEqual(state.posts[1]);
});

test("全站限流保留原提交，等待后重试不会重新选择活动", async ({ page }) => {
  const state = await mock(page);
  state.rateLimitFirst = true;
  state.result = "single";
  await page.goto("/");
  await redeem(page);
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByLabel("兑换口令", { exact: true })).toBeDisabled();
  const retry = page.getByRole("button", { name: "重试原提交", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]).toEqual(state.posts[1]);
  expect(state.claims).toHaveLength(0);
});

test("刷新丢弃口令内存，退出清空匹配上下文", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await redeem(page);
  await expect(
    page.getByRole("heading", { name: "匹配活动", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveValue("");
  await redeem(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "匹配活动", exact: true }),
  ).toHaveCount(0);
  expect(state.posts).toHaveLength(2);
});

test("单匹配已归档卡片为空仍定位原活动，不换领", async ({ page }) => {
  const state = await mock(page);
  state.result = "single";
  state.cards = [];
  await page.goto("/");
  await redeem(page);
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  expect(state.posts).toHaveLength(1);
  expect(state.claims).toHaveLength(0);
});

test("无匹配可重新输入，匿名不能全站兑换但可浏览广场", async ({ page }) => {
  const state = await mock(page);
  state.result = "none";
  state.cards = [];
  await page.goto("/");
  await redeem(page);
  await expect(page.getByText(/未匹配到活动/)).toBeVisible();
  state.signedIn = false;
  state.cards = [card(0)];
  await page.goto("/square");
  await expect(page.getByText("同口令活动1", { exact: true })).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "兑换", exact: true }),
  ).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
});

test("UUID与帖子链接定位，单帖子结果直达且不领取", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await page.getByText("定位活动", { exact: true }).click();
  await page
    .getByLabel("活动 ID 或链接", { exact: true })
    .fill(ids[0] as string);
  await page.getByRole("button", { name: "前往活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  state.cards = [card(0)];
  await page.goto("/topics/123");
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  expect(state.posts).toHaveLength(0);
  expect(state.claims).toHaveLength(0);
});

test("统计呈现同口令的历史命中与未命中，窄屏列表不溢出", async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/my/activities/${ids[0]}/statistics`);
  await expect(
    page.getByText("Answer123", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText(/未命中/).first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/square");
  await expect(page.getByText("同口令活动1", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("精确回复定位保留楼层，切换楼层使用独立查询与缓存", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await page.getByText("定位活动", { exact: true }).click();
  await page
    .getByLabel("活动 ID 或链接", { exact: true })
    .fill("https://linux.do/t/topic-slug/123/7");
  await page.getByRole("button", { name: "前往活动", exact: true }).click();
  await expect(page).toHaveURL("/topics/123?postNumber=7");
  await expect(
    page.getByRole("link", { name: "查看论坛帖子", exact: true }),
  ).toHaveAttribute("href", "https://linux.do/t/123/7");
  await expect.poll(() => [...new Set(state.topicReplies)]).toEqual(["7"]);
  state.cards = [
    { ...card(0), title: "另一楼层的活动A" },
    { ...card(1), title: "另一楼层的活动B" },
  ];
  await page.goto("/topics/123?postNumber=8");
  await expect(
    page.getByText("另一楼层的活动A", { exact: true }),
  ).toBeVisible();
  expect([...new Set(state.topicReplies)]).toEqual(["7", "8"]);
  expect(state.posts).toHaveLength(0);
  expect(state.claims).toHaveLength(0);
});
