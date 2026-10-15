import { expect, type Page, test } from "@playwright/test";

const activityId = "33333333-3333-4333-8333-333333333333";
const user = {
  id: "activity-cache-user",
  username: "viewer",
  displayName: "活动页缓存用户",
  avatarUrl: null,
};
const author = {
  id: "activity-cache-author",
  username: "author",
  displayName: "活动作者",
  avatarUrl: null,
};

function publicActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: activityId,
    title: "活动页缓存验收",
    rewardType: "ldc",
    status: "active",
    author,
    forceDedicated: true,
    topicUrl: null,
    openedAt: "2026-10-07T00:00:00.000Z",
    deadlineAt: "2026-10-10T00:00:00.000Z",
    quantity: {
      mode: "exact",
      total: 4,
      claimed: 0,
      remaining: 4,
    },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    beforeInfo: "这是活动说明，慢数据到达时页面不应该突然跳。",
    reward: { mode: "fixed", totalAmount: "4.00", count: 4 },
    myClaim: null,
    ...overrides,
  };
}

function claim() {
  return {
    id: "activity-cache-claim",
    activity: {
      id: activityId,
      title: "活动页缓存验收",
      status: "active",
    },
    rewardType: "ldc",
    amount: "1.00",
    payment: {
      id: "payment-cache",
      mode: "simulation",
      status: "confirmed",
      reason: null,
      confirmedAt: "2026-10-07T01:00:01.000Z",
    },
    afterClaimInfo:
      "这是领取后的奖励附言。\n\n它会在本人记录确认后出现，并且内容足够高，用来验证后面的活动口令区域是平滑移动，而不是突然跳到新的位置。\n\n第三段继续增加高度，覆盖真实活动里作者写了较长说明的情况。",
    claimedAt: "2026-10-07T01:00:00.000Z",
  };
}

async function expectClaimCopyPendingOnly(page: Page) {
  const copy = page.locator(".claim-copy");
  await expect(copy.locator('[data-loading-region="records"]')).toHaveCount(1);
  await expect(copy.locator("[data-note-region]")).toHaveCount(0);
  await expect(copy.locator(".roster-entry")).toHaveCount(0);
  await expect(copy.locator("form")).toHaveCount(0);
}

async function expectClaimCopyReady(page: Page) {
  await expect(
    page.locator('.claim-copy [data-loading-region="records"]'),
  ).toHaveCount(0);
}

async function setupActivityRoutes(
  page: Page,
  options: {
    status?: string;
    delayedClaim?: boolean;
    claimed?: boolean;
    delayRefreshAfterClaim?: boolean;
  } = {},
) {
  await page.clock.setFixedTime(new Date("2026-10-09T00:00:00.000Z"));
  const state = {
    claimed: options.claimed ?? false,
    claimGets: 0,
    activityGets: 0,
    claimPosts: 0,
    releaseClaim: () => {},
    passwordRefreshStarted: false,
  };

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities")
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    if (url.pathname === `/api/activities/${activityId}`) {
      state.activityGets += 1;
      return route.fulfill({
        json: {
          activity: publicActivity({
            status: options.status ?? "active",
            deadlineAt:
              options.status === "ended"
                ? "2026-10-07T00:00:00.000Z"
                : "2026-10-10T00:00:00.000Z",
          }),
        },
      });
    }
    if (url.pathname === `/api/activities/${activityId}/participation`) {
      state.claimGets += 1;
      if (options.delayedClaim)
        await new Promise<void>((resolve) => {
          state.releaseClaim = resolve;
        });
      return route.fulfill({
        json: {
          claim: state.claimed ? claim() : null,
          registration: null,
        },
      });
    }
    if (url.pathname === `/api/activities/${activityId}/claim`) {
      state.claimPosts += 1;
      state.claimed = true;
      return route.fulfill({
        json: { result: "claimed", claim: claim() },
      });
    }
    if (url.pathname === `/api/activities/${activityId}/passwords`) {
      if (options.delayRefreshAfterClaim && state.claimed) {
        state.passwordRefreshStarted = true;
        await new Promise(() => {});
      }
      return route.fulfill({
        json: {
          passwords: state.claimed
            ? [{ text: "CachePass", isClaimPassword: true }]
            : [],
          hiddenCount: state.claimed ? 0 : 1,
          canSolve: false,
        },
      });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.continue();
  });

  return state;
}

test("返回同一活动复用 15 秒内缓存，不重新显示骨架或重复拉取记录", async ({
  page,
}) => {
  const state = await setupActivityRoutes(page);

  await page.goto(`/activities/${activityId}`);
  await expect(
    page.getByRole("heading", { name: "活动页缓存验收" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "领取红包" })).toBeVisible();
  const activityGetsBeforeReturn = state.activityGets;
  const claimGetsBeforeReturn = state.claimGets;

  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  await page.goBack();

  await expect(
    page.getByRole("heading", { name: "活动页缓存验收" }),
  ).toBeVisible();
  await expect(page.locator("[data-skeleton-row='true']")).toHaveCount(0);
  expect(state.activityGets).toBe(activityGetsBeforeReturn);
  expect(state.claimGets).toBe(claimGetsBeforeReturn);
});

test("领取记录慢到时保留参与记录占位，不先显示已结束或未领取结果", async ({
  page,
}) => {
  const state = await setupActivityRoutes(page, {
    status: "ended",
    delayedClaim: true,
    claimed: true,
  });

  await page.goto(`/activities/${activityId}`);
  await expectClaimCopyPendingOnly(page);
  await expect(page.getByText("本次活动已结束。")).toHaveCount(0);
  await expect(page.getByText("活动已截止，不能继续兑换。")).toHaveCount(0);

  state.releaseClaim();
  await expect(page.getByText("兑换成功。")).toBeVisible();
  await expectClaimCopyReady(page);
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+1.00 LDC");
});

test("领取成功立即展示真实结果，相关刷新变慢也不阻塞或重复提交", async ({
  page,
}) => {
  const state = await setupActivityRoutes(page, {
    delayRefreshAfterClaim: true,
  });

  await page.goto(`/activities/${activityId}`);
  await page.getByLabel("兑换口令").fill("CachePass");
  await page.getByRole("button", { name: /领取红包/ }).click();

  await expect(page.getByText("兑换成功。")).toBeVisible();
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+1.00 LDC");
  expect(state.claimPosts).toBe(1);
  await expect.poll(() => state.passwordRefreshStarted).toBe(true);
});

for (const scenario of [
  { name: "桌面", width: 1440, reducedMotion: false },
  { name: "手机", width: 375, reducedMotion: false },
  { name: "减少动态效果", width: 375, reducedMotion: true },
]) {
  test(`异步领取结果到达时活动口令区域${scenario.name}布局移动符合设置`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 812 });
    await page.emulateMedia({
      reducedMotion: scenario.reducedMotion ? "reduce" : "no-preference",
    });
    const state = await setupActivityRoutes(page, {
      delayedClaim: true,
      claimed: true,
    });

    await page.goto(`/activities/${activityId}`);
    await expectClaimCopyPendingOnly(page);
    const layoutRegion = page.locator("[data-layout-region='password-panel']");
    await expect(layoutRegion).toBeVisible();

    const samplesPromise = layoutRegion.evaluate(async (element) => {
      const samples: { top: number; transform: string }[] = [];
      for (let index = 0; index < 28; index += 1) {
        const rect = element.getBoundingClientRect();
        samples.push({
          top: Math.round(rect.top * 10) / 10,
          transform: getComputedStyle(element).transform,
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return samples;
    });
    await page.waitForTimeout(30);
    state.releaseClaim();
    const samples = await samplesPromise;
    await expect(page.locator(".envelope-svg .prize")).toHaveText("+1.00 LDC");
    await expectClaimCopyReady(page);

    const distinctTops = new Set(samples.map((sample) => sample.top));
    const animatedTransforms = samples.filter(
      (sample) => sample.transform !== "none",
    );
    if (scenario.reducedMotion) {
      expect(animatedTransforms).toHaveLength(0);
      expect(distinctTops.size).toBeLessThanOrEqual(2);
    } else {
      expect(samples).toHaveLength(28);
    }
  });
}
