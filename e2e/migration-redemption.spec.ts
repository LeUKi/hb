import { expect, type Page, test } from "@playwright/test";
import { emptyActivityInput } from "../packages/contracts/src";

const id = "11111111-1111-4111-8111-111111111111";
const id2 = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "viewer",
  username: "viewer",
  displayName: "参与者",
  avatarUrl: null,
};
const author = {
  ...user,
  id: "author",
  username: "author",
  displayName: "活动作者",
};
async function setup(page: Page) {
  const state = {
    mode: "multiple",
    claims: [] as { submissionId: string; password: string }[],
    claimed: false,
    fail: false,
    author: false,
    managedMissing: false,
    forceDedicated: true,
    ended: false,
    draw: false,
    notWon: false,
    externals: [] as string[],
  };
  const activity = () => ({
    id,
    title: "迁移活动",
    rewardType: "ldc",
    status: state.ended ? "ended" : "active",
    paymentMode: "simulation",
    reward: state.draw
      ? { mode: "timed_draw", totalAmount: "2.64", count: 3 }
      : { mode: "fixed", unitAmount: "0.88", count: 3 },
    author,
    forceDedicated: state.forceDedicated,
    topicUrl: null,
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    quantity: {
      mode: "exact",
      total: 3,
      claimed: state.claimed ? 2 : 1,
      remaining: state.claimed ? 1 : 2,
    },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "作者公开说明",
    ...(state.ended ? { afterEndInfo: "作者结束说明" } : {}),
    ...(state.draw
      ? {
          draw: {
            state: state.notWon ? "completed" : "waiting",
            deadlineAt: new Date(Date.now() + 86400000).toISOString(),
            closedAt: null,
            reason: null,
            registeredCount: 2,
            winnerCount: 1,
          },
        }
      : {}),
    myClaim: null,
  });
  const claim = () => ({
    id: "reward-id",
    activity: { id, title: "迁移活动", status: "active" },
    rewardType: "ldc",
    amount: "0.88",
    payment: {
      id: "migration-payment",
      mode: "simulation",
      status: "confirmed",
      reason: null,
      confirmedAt: "2026-10-07T00:00:00Z",
    },
    afterClaimInfo: "作者私有附言",
    claimedAt: "2026-10-07T00:00:00Z",
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      state.externals.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const p = url.pathname;
    if (p === "/api/session" || p === "/api/me")
      return route.fulfill({
        json: { user: state.author ? author : user, csrfToken: "csrf" },
      });
    if (p === "/api/redemptions/discover") {
      return route.fulfill({
        json: {
          id: "result",
          claimSubmissionId: "33333333-3333-4333-8333-333333333333",
          result: state.mode,
          items:
            state.mode === "none"
              ? []
              : [activity(), { ...activity(), id: id2, title: "另一活动" }],
          nextCursor: null,
          ...(state.mode === "single"
            ? {
                selectedActivityId: id,
              }
            : {}),
        },
      });
    }
    if (p === "/api/redemptions") {
      if (state.mode === "single") {
        state.claimed = true;
        state.claims.push({
          submissionId: "33333333-3333-4333-8333-333333333333",
          password: route.request().postDataJSON().password,
        });
      }
      return route.fulfill({
        json: {
          id: "result",
          claimSubmissionId: "33333333-3333-4333-8333-333333333333",
          result: state.mode,
          items:
            state.mode === "none"
              ? []
              : [activity(), { ...activity(), id: id2, title: "另一活动" }],
          nextCursor: null,
          ...(state.mode === "single"
            ? {
                selectedActivityId: id,
                claimResult: { result: "claimed", claim: claim() },
              }
            : {}),
        },
      });
    }
    if (p === "/api/redemptions/result" || p === "/api/topics/123/activities")
      return route.fulfill({
        json: {
          id: "result",
          claimSubmissionId: "33333333-3333-4333-8333-333333333333",
          result: state.mode,
          items: [activity(), { ...activity(), id: id2, title: "另一活动" }],
          nextCursor: null,
        },
      });
    if (p === `/api/activities/${id}`)
      return route.fulfill({ json: { activity: activity() } });
    if (p === `/api/activities/${id}/participation`)
      return route.fulfill({
        json: {
          claim: state.claimed ? claim() : null,
          registration: state.notWon
            ? {
                id: "registration",
                activity: { id, title: "迁移活动", status: "ended" },
                registeredAt: "2026-10-07T00:00:00Z",
                drawAt: "2026-10-07T01:00:00Z",
                status: "not_won",
                claim: null,
              }
            : null,
        },
      });
    if (p === `/api/activities/${id}/claim`) {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: { claim: state.claimed ? claim() : null },
        });
      state.claims.push(route.request().postDataJSON());
      if (state.fail) {
        state.fail = false;
        return route.abort();
      }
      state.claimed = true;
      return route.fulfill({ json: { result: "claimed", claim: claim() } });
    }
    if (p === `/api/activities/${id}/registration`)
      return route.fulfill({
        json: {
          registration: state.notWon
            ? {
                id: "registration",
                activity: { id, title: "迁移活动", status: "ended" },
                registeredAt: "2026-10-07T00:00:00Z",
                drawAt: "2026-10-07T01:00:00Z",
                status: "not_won",
                claim: null,
              }
            : null,
        },
      });
    if (p === `/api/activities/${id}/passwords`)
      return route.fulfill({
        json: {
          passwords: state.claimed
            ? [{ text: "Answer123", isClaimPassword: true }]
            : [],
          hiddenCount: state.claimed ? 0 : 1,
          canSolve: false,
        },
      });
    if (p === `/api/activities/${id}/recipients`)
      return route.fulfill({
        json: {
          enabled: true,
          items: [
            {
              ...user,
              id: "c1",
              claimedAt: "2026-10-07T00:00:00Z",
              amount: "0.88",
              title: "highest",
            },
          ],
          nextCursor: null,
        },
      });
    if (p === `/api/activities/${id}/registrations`)
      return route.fulfill({
        json: {
          enabled: true,
          items: [{ ...user, id: "r1", registeredAt: "2026-10-07T00:00:00Z" }],
          nextCursor: null,
        },
      });
    if (p === `/api/me/activities/${id}/statistics`)
      return route.fulfill({
        json: {
          totalAttempts: 0,
          uniqueUsers: 0,
          successfulClaims: 0,
          items: [],
          validPasswords: [],
          nextCursor: null,
        },
      });
    if (p === `/api/me/activities/${id}`) {
      if (state.managedMissing)
        return route.fulfill({
          status: 404,
          json: { error: { message: "not found" } },
        });
      return route.fulfill({
        json: {
          activity: {
            ...activity(),
            version: 1,
            createdAt: new Date().toISOString(),
            totalCount: 3,
            claimedCount: 1,
            config: {
              ...emptyActivityInput(),
              title: "迁移活动",
              forceDedicated: state.forceDedicated,
              rewardType: "ldc",
              passwords: ["Answer123"],
              beforeInfo: "作者公开说明",
            },
          },
        },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}
for (const width of [1440, 375]) {
  test(`匹配弹窗关闭后自动兑奖一次，返回红包高度固定 ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await setup(page);
    await page.goto("/");
    await page.getByLabel("口令", { exact: true }).fill("Answer123");
    await page.getByRole("button", { name: "兑奖", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /迁移活动/ }).click();
    await expect(page).toHaveURL(new RegExp(`/activities/${id}$`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.locator(".envelope-svg .prize", { hasText: "+0.88" }),
    ).toBeVisible();
    expect(state.claims).toHaveLength(1);
    await expect(page.locator('[data-note-region="after"]')).toContainText(
      "作者私有附言",
    );
    await expect(
      page.locator('[data-note-region="before"] summary'),
    ).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "返回上一页", exact: true }).click();
    const heights = await page.evaluate(async () => {
      const values: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 450) {
        const e = document.querySelector('[data-testid="envelope"]');
        if (e) values.push(e.getBoundingClientRect().height);
        await new Promise(requestAnimationFrame);
      }
      return values;
    });
    expect(heights.length).toBeGreaterThan(3);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    expect(heights[0]).toBe(150);
    expect(state.claims).toHaveLength(1);
    expect(state.externals).toEqual([]);
  });
}
test("单匹配进入活动页后自动提交，取消弹窗回焦且定位不兑奖", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeFocused();
  await page
    .getByLabel("口令", { exact: true })
    .fill("https://linux.do/t/topic/123/1");
  await page.getByRole("button", { name: "跳转活动" }).click();
  await page
    .getByRole("dialog", { name: "选择活动" })
    .getByRole("button", { name: /迁移活动/ })
    .click();
  await expect(page.getByLabel("兑换口令", { exact: true })).toBeVisible();
  expect(state.claims).toHaveLength(0);
  await expect(page.locator(".activity-quantity")).toHaveText(
    "已领取 1 / 3 份",
  );
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  state.mode = "single";
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.locator(".envelope-svg .prize", { hasText: "+0.88" }),
  ).toBeVisible();
  await expect(page.locator(".activity-quantity")).toHaveText(
    "已领取 2 / 3 份",
  );
  await expect(page.locator(".activity-status-copy")).toHaveText("兑换成功。");
  expect(state.claims).toHaveLength(1);
});
test("未知自动提交在目标页重试原编号", async ({ page }) => {
  const state = await setup(page);
  state.fail = true;
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /迁移活动/ })
    .click();
  await page.getByRole("button", { name: "重试原提交" }).click();
  await expect(
    page.locator(".envelope-svg .prize", { hasText: "+0.88" }),
  ).toBeVisible();
  expect(state.claims).toHaveLength(2);
  expect(state.claims[0]?.submissionId).toBe(state.claims[1]?.submissionId);
});
test("未中奖结果、说明权限、双时间和减少动态效果", async ({ page }) => {
  const state = await setup(page);
  state.draw = true;
  state.notWon = true;
  state.ended = true;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/activities/${id}`);
  await expect(page.getByText("本次未中奖。", { exact: true })).toBeVisible();
  await expect(page.locator('[data-note-region="after"]')).toHaveCount(0);
  await expect(
    page.locator(".activity-page [data-note-region]").last(),
  ).toHaveAttribute("data-note-region", "ended");
  await page.getByRole("button", { name: "查看中奖名单" }).click();
  const times = page.getByRole("dialog").locator(".roster-time time");
  await expect(times).toHaveCount(2);
  await expect(times.first()).toHaveText(/2026-10-07 \d{2}:00:00/);
  expect(
    await times.first().evaluate((e) => getComputedStyle(e).fontFamily),
  ).toContain("monospace");
  await page.getByRole("tab", { name: "报名名单" }).click();
  await expect(times).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "查看中奖名单" }),
  ).toBeFocused();
  expect(state.externals).toEqual([]);
});
test("作者分享和管理独立，管理项路由按配置显示", async ({ page }) => {
  const state = await setup(page);
  state.author = true;
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(`/activities/${id}`);
  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  await expect(page.getByRole("menu")).not.toContainText("统计");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "分享活动", exact: true }),
  ).toBeFocused();

  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "编辑配置" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "兑换尝试统计" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "付款记录" })).toBeVisible();
  await page.getByRole("menuitem", { name: "兑换尝试统计" }).click();
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(statisticsDialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/activities/${id}$`));
  await page.mouse.click(5, 5);
  await expect(statisticsDialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "管理活动", exact: true }),
  ).toBeFocused();

  await page.goto(`/activities/${id}`);
  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑配置" }).click();
  await expect(page).toHaveURL(new RegExp(`/my/activities/${id}(\\?.*)?$`));
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#activity-title")).toHaveValue("迁移活动");
  expect(new URL(page.url()).searchParams.has("edit")).toBe(false);

  await page.goto(`/activities/${id}`);
  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await page.getByRole("menuitem", { name: "付款记录" }).click();
  await expect(page).toHaveURL(new RegExp(`/my/payments\\?activityId=${id}`));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("非作者、缺失作者数据和普通活动不暴露管理入口", async ({ page }) => {
  const state = await setup(page);
  await page.goto(`/activities/${id}`);
  await expect(
    page.getByRole("button", { name: "管理活动", exact: true }),
  ).toHaveCount(0);

  state.author = true;
  state.managedMissing = true;
  await page.goto(`/activities/${id}`);
  await expect(
    page.getByRole("button", { name: "管理活动", exact: true }),
  ).toHaveCount(0);

  state.managedMissing = false;
  state.forceDedicated = false;
  await page.goto(`/activities/${id}`);
  await page.getByRole("button", { name: "管理活动", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "兑换尝试统计" }),
  ).toHaveCount(0);
  await page.mouse.click(12, 12);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

for (const width of [1440, 375]) {
  for (const result of ["claimed", "not-won", "missed", "ended"] as const) {
    test(`${width}px ${result} 首页往返连续，已有结果只展开一次`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = await setup(page);
      state.claimed = result === "claimed";
      state.notWon = result === "not-won";
      state.draw = result === "not-won" || result === "missed";
      state.ended = result !== "claimed";
      let delayedPageCode = false;
      if (width === 375 && result === "not-won") {
        await page.route(
          (url) =>
            decodeURIComponent(url.pathname).endsWith(
              "/routes/activities.$id.tsx",
            ),
          async (route) => {
            delayedPageCode = true;
            await new Promise((resolve) => setTimeout(resolve, 450));
            await route.continue();
          },
        );
      }
      await page.goto("/");
      await page.getByLabel("口令", { exact: true }).fill(id);
      const sample = () =>
        page.evaluate(async () => {
          const rows: {
            t: number;
            w: number;
            y: number;
            phase: string | null;
          }[] = [];
          const start = performance.now();
          while (performance.now() - start < 1400) {
            const stage = Array.from(
              document.querySelectorAll('[data-testid="envelope"]'),
            ).find((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            const e = stage?.querySelector(".envelope");
            if (e) {
              const r = e.getBoundingClientRect();
              rows.push({
                t: performance.now() - start,
                w: r.width,
                y: r.y,
                phase: stage?.getAttribute("data-phase") ?? null,
              });
            }
            await new Promise(requestAnimationFrame);
          }
          return rows;
        });
      const entering = sample();
      await page.getByRole("button", { name: "跳转活动" }).click();
      const frames = await entering;
      if (width === 375 && result === "not-won")
        expect(delayedPageCode).toBe(true);
      expect(
        frames.filter((r) => r.w > 108 && r.w < 205).length,
        JSON.stringify(frames.filter((_, i) => i % 6 === 0)),
      ).toBeGreaterThan(2);
      await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
        "data-opening-count",
        "1",
      );
      const returning = sample();
      await page
        .getByRole("button", { name: "返回上一页", exact: true })
        .click();
      const back = await returning;
      expect(
        back.filter((r) => r.w > 108 && r.w < 205).length,
        JSON.stringify(back.filter((_, i) => i % 6 === 0)),
      ).toBeGreaterThan(2);
      const settled = back.filter(
        (row) => row.phase === "closed" && row.t > 700 && row.w > 0,
      );
      expect(settled.length).toBeGreaterThan(3);
      expect(
        Math.max(...settled.map((row) => row.y)) -
          Math.min(...settled.map((row) => row.y)),
      ).toBeLessThan(1);
      expect(state.claims).toHaveLength(0);
    });
  }
}

test("口令 Enter 提交与 IME 隔离，定位后的唯一输入实际共享移动", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/");
  const input = page.getByLabel("口令", { exact: true });
  await input.fill("Answer123");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await input.dispatchEvent("compositionend");
  await input.fill("Answer123");
  await input.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("口令", { exact: true }).fill(id);
  const samples = page.evaluate(async () => {
    const rows: { width: number; transform: string; count: number }[] = [];
    // Include the measured shell/height settling before the shared move starts.
    const until = performance.now() + 1400;
    while (performance.now() < until) {
      const field = document.querySelector(
        '.activity-page [data-redemption-part="password"]',
      );
      if (location.pathname.startsWith("/activities/") && field)
        rows.push({
          width: field.getBoundingClientRect().width,
          transform: getComputedStyle(field).transform,
          count: document.querySelectorAll("#claim-password").length,
        });
      await new Promise(requestAnimationFrame);
    }
    return rows;
  });
  await page.getByRole("button", { name: "跳转活动" }).click();
  const rows = await samples;
  expect(rows.some((row) => row.transform !== "none")).toBe(true);
  expect(rows.every((row) => row.count === 1)).toBe(true);
  expect(state.claims).toHaveLength(0);
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByLabel("兑换口令", { exact: true }).press("Enter");
  await expect(
    page.locator(".envelope-svg .prize", { hasText: "+0.88" }),
  ).toBeVisible();
  expect(state.claims).toHaveLength(1);
});

test("再次点击兑奖主导航清空首页当前流程且不增加历史", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const before = await page.evaluate(() => history.length);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue("");
  await expect(page.locator(".home-exchange textarea")).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(before);
});
