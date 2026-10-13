import { expect, type Page, test } from "@playwright/test";
import type {
  ClaimDetail,
  DiscoveryCard,
  GlobalRedemptionInput,
  GlobalRedemptionResult,
  PasswordClaimInput,
} from "../packages/contracts/src";

const ids = [
  "790f9912-9934-4dfc-8efc-7c32962a3e82",
  "084cfc63-5e47-4c92-a5c9-b14e12b0a798",
];
const requestId = "4d95d1e9-a564-4ba0-9c6c-92a9e9d5eb0b";
const rewardAmount = "0.88";
const user = {
  id: "viewer-1",
  username: "ada",
  displayName: "Ada",
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

function card(index: number): DiscoveryCard {
  return {
    id: ids[index] ?? (ids[0] as string),
    title: `同口令活动${index + 1}`,
    rewardType: "ldc",
    reward: { mode: "fixed", totalAmount: "17.60", count: 20 },
    paymentMode: "simulation",
    status: index === 0 ? "active" : "ended",
    author: {
      id: "author",
      username: "maker",
      displayName: "作者",
      avatarUrl: null,
      accountTier: "standard" as const,
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
function claimDetail(index: number, id = "claimed-1"): ClaimDetail {
  return {
    id,
    activity: {
      id: ids[index] ?? (ids[0] as string),
      title: card(index).title,
      status: "active",
    },
    rewardType: "ldc",
    amount: rewardAmount,
    payment: {
      id: `payment-${index}`,
      mode: "simulation",
      status: "confirmed",
      reason: null,
      confirmedAt: new Date().toISOString(),
    },
    claimedAt: new Date().toISOString(),
    afterClaimInfo: "领取后说明",
  };
}
async function expectLdcReward(page: Page) {
  await expect(page.locator("main .envelope-svg .prize")).toHaveText(
    `+${rewardAmount} LDC`,
  );
}
async function mock(page: Page) {
  const state = {
    signedIn: true,
    csrfToken: "csrf",
    sessionReads: 0,
    posts: [] as GlobalRedemptionInput[],
    claims: [] as PasswordClaimInput[],
    refreshes: 0,
    failFirst: false,
    rateLimitFirst: false,
    result: "multiple" as GlobalRedemptionResult["result"],
    cards: [card(0), card(1)],
    topicReplies: [] as string[],
    claimedActivityIds: new Set<string>(),
    claimSubmissionFingerprints: new Map<
      string,
      { activityId: string; password: string }
    >(),
    failNextClaim: false,
    discoverClaimResult: false,
    claimSubmissionId: crypto.randomUUID(),
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/session" || path === "/api/me") {
      state.sessionReads += 1;
      return route.fulfill({
        json: state.signedIn
          ? { user, csrfToken: state.csrfToken }
          : { user: null, csrfToken: null },
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
          statusCounts: {
            all: 0,
            draft: 0,
            active: 0,
            ended: 0,
            archived: 0,
          },
        },
      });
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/redemptions/discover") {
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
      state.claimSubmissionId = crypto.randomUUID();
      const selectedActivityId = ids[0];
      if (!selectedActivityId) throw new Error("Missing primary activity id");
      if (state.discoverClaimResult)
        state.claimedActivityIds.add(selectedActivityId);
      return route.fulfill({
        json: {
          id: requestId,
          claimSubmissionId: state.claimSubmissionId,
          result: state.result,
          items: state.cards,
          nextCursor: null,
          ...(state.result === "single"
            ? {
                selectedActivityId,
                ...(state.discoverClaimResult
                  ? {
                      claimResult: {
                        result: "claimed",
                        claim: claimDetail(0, "legacy-claim"),
                      },
                    }
                  : {}),
              }
            : {}),
        },
      });
    }
    if (path === "/api/redemptions")
      return route.fulfill({
        json: {
          id: requestId,
          claimSubmissionId: state.claimSubmissionId,
          result: state.result,
          items: state.cards,
          nextCursor: null,
          ...(state.result === "single"
            ? { selectedActivityId: ids[0], claimResult: { result: "ended" } }
            : {}),
        },
      });
    if (path === `/api/redemptions/${requestId}`) {
      state.refreshes++;
      return route.fulfill({
        json: {
          id: requestId,
          claimSubmissionId: state.claimSubmissionId,
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
            activity: {
              ...(state.cards[index] ?? card(index)),
              beforeInfo: "先查看活动，再确认领取",
            },
          },
        });
      if (path === `/api/activities/${id}/recipients`)
        return route.fulfill({
          json: { enabled: false, items: [], nextCursor: null },
        });
      if (path === `/api/activities/${id}/passwords`)
        return route.fulfill({
          json: {
            passwords: state.claimedActivityIds.has(id)
              ? [{ text: "Answer123", isClaimPassword: true, isSolved: false }]
              : [],
            hiddenCount: state.claimedActivityIds.has(id) ? 0 : 1,
            canSolve: state.claimedActivityIds.has(id),
          },
        });
      if (path === `/api/activities/${id}/participation`)
        return route.fulfill({
          json: {
            claim: state.claimedActivityIds.has(id) ? claimDetail(index) : null,
            registration: null,
          },
        });
      if (path === `/api/activities/${id}/claim`) {
        const claim = claimDetail(index);
        if (req.method() === "GET")
          return route.fulfill({
            json: { claim: state.claimedActivityIds.has(id) ? claim : null },
          });
        const body = req.postDataJSON() as PasswordClaimInput;
        const previousFingerprint = state.claimSubmissionFingerprints.get(
          body.submissionId,
        );
        if (
          previousFingerprint &&
          (previousFingerprint.activityId !== id ||
            previousFingerprint.password !== body.password)
        )
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "CONFLICT",
                message: "同一提交标识不能更换操作、活动或口令",
              },
            },
          });
        state.claimSubmissionFingerprints.set(body.submissionId, {
          activityId: id,
          password: body.password,
        });
        state.claims.push(body);
        if (state.failNextClaim) {
          state.failNextClaim = false;
          return route.abort();
        }
        state.claimedActivityIds.add(id);
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
async function redeem(page: Page, password = "Answer123") {
  await page.getByLabel("口令", { exact: true }).fill(password);
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
}

test("多个匹配关闭弹窗后自动提交一次，返回不再次全站提交", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await redeem(page);
  const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  expect(state.claims).toHaveLength(0);
  await dialog.getByRole("button", { name: /同口令活动1/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  await expectLdcReward(page);
  expect(state.claims).toHaveLength(1);
  expect(state.claims[0]?.password).toBe("Answer123");
  expect(state.claims[0]?.submissionId).not.toBe(state.posts[0]?.submissionId);
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  await expect(page).toHaveURL("/");
  expect(state.posts).toHaveLength(1);
  expect(state.claims).toHaveLength(1);
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
  const reads = state.sessionReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => state.sessionReads).toBeGreaterThan(reads);
  await page.getByRole("button", { name: "再次确认", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择要兑奖的活动", exact: true }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]).toEqual(state.posts[1]);
});

test("同账号会话轮换撤下首页原提交，迟到兑奖结果不导航或写入新会话", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = await mock(page);
  let release = () => {};
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/redemptions/discover", async (route) => {
    state.posts.push(route.request().postDataJSON());
    const result = {
      id: requestId,
      claimSubmissionId: state.claimSubmissionId,
      result: "single",
      items: [card(0)],
      nextCursor: null,
      selectedActivityId: ids[0],
      claimResult: { result: "claimed", claim: claimDetail(0) },
    };
    started();
    await pending;
    await route.fulfill({ json: result });
  });
  try {
    await page.goto("/");
    await redeem(page);
    await submitted;
    const reads = state.sessionReads;
    state.csrfToken = "csrf-rotated";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => state.sessionReads).toBeGreaterThan(reads);
    await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "再次确认", exact: true }),
    ).toHaveCount(0);
    const response = page.waitForResponse("**/api/redemptions/discover");
    release();
    await response;
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Stay in this QueryClient: a document reload would hide a late cache write.
    await page.getByLabel("口令", { exact: true }).fill(ids[0] as string);
    await page.getByRole("button", { name: "跳转活动", exact: true }).click();
    await expect(page).toHaveURL(`/activities/${ids[0]}`);
    await expect(page.getByRole("button", { name: /领取红包/ })).toBeVisible();
    await expect(page.locator(".envelope-svg .prize")).toHaveCount(0);
    expect(state.posts).toHaveLength(1);
    expect(state.claims).toHaveLength(0);
  } finally {
    release();
  }
});

test("活动页自动提交未知结果重试保持同一活动提交标识", async ({ page }) => {
  const state = await mock(page);
  state.failNextClaim = true;
  await page.goto("/");
  await redeem(page);
  const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /同口令活动1/ }).click();
  await expect(page.getByRole("button", { name: /重试原提交/ })).toBeVisible();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expectLdcReward(page);
  expect(state.posts).toHaveLength(1);
  expect(state.claims).toHaveLength(2);
  expect(state.claims[0]?.submissionId).toBe(state.claims[1]?.submissionId);
  expect(state.claims[0]?.submissionId).not.toBe(state.posts[0]?.submissionId);
});

test("不同匹配活动使用不同活动提交标识", async ({ page }) => {
  const state = await mock(page);
  state.cards = [card(0), { ...card(1), status: "active" }];
  await page.goto("/");
  await redeem(page);
  let dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /同口令活动1/ }).click();
  await expectLdcReward(page);
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();

  await redeem(page);
  dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /同口令活动2/ }).click();
  await expect(page).toHaveURL(`/activities/${ids[1]}`);
  await expect.poll(() => state.claims.length).toBe(2);

  expect(state.posts).toHaveLength(2);
  expect(state.claims[0]?.submissionId).not.toBe(state.posts[0]?.submissionId);
  expect(state.claims[1]?.submissionId).not.toBe(state.posts[1]?.submissionId);
  expect(state.claims[0]?.submissionId).not.toBe(state.claims[1]?.submissionId);
});

test("新口令重新发现会生成新的活动提交标识", async ({ page }) => {
  const state = await mock(page);
  state.failNextClaim = true;
  await page.goto("/");
  await redeem(page, "Answer123");
  let dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /同口令活动1/ }).click();
  await expect(page.getByRole("button", { name: /重试原提交/ })).toBeVisible();
  expect(state.claims).toHaveLength(1);
  const firstSubmissionId = state.claims[0]?.submissionId;

  await page.goto("/");
  await redeem(page, "Second123");
  dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /同口令活动1/ }).click();
  await expectLdcReward(page);

  expect(state.posts).toHaveLength(2);
  expect(state.claims).toHaveLength(2);
  expect(state.claims[1]?.password).toBe("Second123");
  expect(state.claims[1]?.submissionId).not.toBe(firstSubmissionId);
  expect(state.claims[1]?.submissionId).not.toBe(state.posts[1]?.submissionId);
});

test("明确限流后允许编辑口令，冷却结束可重新提交", async ({ page }) => {
  const state = await mock(page);
  state.rateLimitFirst = true;
  state.result = "single";
  await page.goto("/");
  await redeem(page);
  await expect(page.locator("[data-redemption-action]")).toBeDisabled();
  await expect(page.getByLabel("口令", { exact: true })).toBeEnabled();
  const retry = page.getByRole("button", { name: "兑奖", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0]?.submissionId).not.toBe(state.posts[1]?.submissionId);
  await expectLdcReward(page);
  expect(state.claims).toHaveLength(1);
  expect(state.claims[0]?.submissionId).toBe(state.claimSubmissionId);
});

test("刷新丢弃口令内存，退出清空匹配上下文", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await redeem(page);
  await expect(
    page.getByRole("heading", { name: "选择要兑奖的活动", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
  await redeem(page);
  const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "关闭选择活动", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  expect(state.posts).toHaveLength(2);

  state.signedIn = true;
  await page.goto("/");
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("Answer123");
  expect(state.posts).toHaveLength(2);
});

test("关闭匹配弹窗只取消当前选择", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await redeem(page);
  const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "关闭选择活动", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
});

test("单匹配已归档卡片为空仍定位原活动，不换领", async ({ page }) => {
  const state = await mock(page);
  state.result = "single";
  state.cards = [];
  await page.goto("/");
  await redeem(page);
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  expect(state.posts).toHaveLength(1);
  await expectLdcReward(page);
  expect(state.claims).toHaveLength(1);
  expect(state.claims[0]?.submissionId).not.toBe(state.posts[0]?.submissionId);
});

test("兼容旧发现响应带已有结果时只消费缓存不重复提交", async ({ page }) => {
  const state = await mock(page);
  state.result = "single";
  state.discoverClaimResult = true;
  await page.goto("/");
  await redeem(page);
  await expect(page).toHaveURL(`/activities/${ids[0]}`);
  await expectLdcReward(page);
  expect(state.posts).toHaveLength(1);
  expect(state.claims).toHaveLength(0);
});

test("无匹配可重新输入，匿名不能全站兑换但可浏览广场", async ({ page }) => {
  const state = await mock(page);
  state.result = "none";
  state.cards = [];
  await page.goto("/");
  await redeem(page);
  await expect(page.locator("[data-redemption-action]")).toHaveAttribute(
    "title",
    "未匹配到活动。",
  );
  state.signedIn = false;
  state.cards = [card(0)];
  await openPublicActivities(page);
  await expect(page.getByText("同口令活动1", { exact: true })).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  await page.getByLabel("口令", { exact: true }).fill("GuestTry123");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
});

test("UUID与帖子链接定位，单帖子结果直达且不领取", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill(ids[0] as string);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
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
  await expect(page).toHaveURL(
    new RegExp(`/my/activities[?]statistics=${ids[0]}$`),
  );
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(statisticsDialog).toBeVisible();
  await expect(
    statisticsDialog.getByRole("row", { name: /提交口令Answer123/ }),
  ).toBeVisible();
  const resultRow = statisticsDialog.getByRole("row", {
    name: /提交口令Answer123/,
  });
  const hitLabel = statisticsDialog.locator(".activity-mobile-label", {
    hasText: /^命中 \/ 未命中$/,
  });
  await expect(hitLabel).toBeVisible();
  await expect(resultRow).toHaveText(/命中\s*\/\s*未命中2/);
  await expect(resultRow).toHaveText(/未命中3/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await statisticsDialog
    .getByRole("button", { name: "关闭兑换尝试统计", exact: true })
    .click();
  await expect(statisticsDialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/my\/activities$/);
  await openPublicActivities(page);
  await expect(page.getByText("同口令活动1", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  for (const width of [375, 768, 1440]) {
    for (const textScale of [1, 2]) {
      await page.setViewportSize({ width, height: 900 });
      await openPublicActivities(page);
      await expect(
        page.getByRole("group", { name: "奖励筛选", exact: true }),
      ).toHaveCount(0);
      const buttons = page
        .getByRole("button", { name: "活动状态筛选" })
        .or(page.getByRole("button", { name: "刷新活动列表" }));
      await expect(buttons).toHaveCount(2);
      const baseFontSizes = await buttons.evaluateAll((elements) =>
        elements.map((element) =>
          Number.parseFloat(getComputedStyle(element).fontSize),
        ),
      );
      if (textScale === 2)
        await buttons.evaluateAll((elements) => {
          for (const element of elements) {
            const fontSize = Number.parseFloat(
              getComputedStyle(element).fontSize,
            );
            (element as HTMLButtonElement).style.fontSize = `${fontSize * 2}px`;
          }
        });

      const geometry = await buttons.evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          const group = element
            .closest("[role='group'], .gallery-status-filter")
            ?.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            label: element.textContent,
            bounds,
            group,
            isScrollableSegment: Boolean(
              element.closest(".segmented-control__scroll"),
            ),
            isStandaloneRefresh: element.classList.contains(
              "list-refresh-button",
            ),
            text: range.getBoundingClientRect(),
            fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          };
        }),
      );
      for (const [index, button] of geometry.entries()) {
        const scenario = `${width}px, ${textScale * 100}% text, ${button.label}`;
        expect(button.bounds.width, scenario).toBeGreaterThan(0);
        expect(button.bounds.height, scenario).toBeGreaterThan(0);
        if (!button.isScrollableSegment) {
          expect(button.bounds.left, scenario).toBeGreaterThanOrEqual(0);
          expect(button.bounds.right, scenario).toBeLessThanOrEqual(width);
          if (!button.isStandaloneRefresh) {
            expect(button.group, scenario).toBeDefined();
            expect(button.bounds.right, scenario).toBeLessThanOrEqual(
              (button.group?.right ?? 0) + 1,
            );
          }
        } else {
          expect(button.group, scenario).toBeDefined();
        }
        expect(button.text.left, scenario).toBeGreaterThanOrEqual(
          button.bounds.left - 1,
        );
        expect(button.text.right, scenario).toBeLessThanOrEqual(
          button.bounds.right + 1,
        );
        expect(button.text.top, scenario).toBeGreaterThanOrEqual(
          button.bounds.top - 1,
        );
        expect(button.text.bottom, scenario).toBeLessThanOrEqual(
          button.bounds.bottom + 1,
        );
        expect(button.fontSize, scenario).toBe(
          (baseFontSizes[index] ?? 0) * textScale,
        );
      }

      expect(new URL(page.url()).searchParams.has("type")).toBe(false);
      const statusFilter = page.getByRole("button", {
        name: "活动状态筛选",
      });
      await statusFilter.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitemradio", { name: "已结束" }).click();
      await expect(statusFilter).toContainText("状态：已结束");
      expect(new URL(page.url()).searchParams.get("status")).toBeNull();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${width}px at ${textScale * 100}% text must fit after filtering`,
      ).toBe(true);
    }
  }
});

test("精确回复定位保留楼层，切换楼层使用独立查询与缓存", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await page
    .getByLabel("口令", { exact: true })
    .fill("https://linux.do/t/topic/123/7");
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择活动", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL("/");
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
