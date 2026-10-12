import { expect, type Page, test } from "@playwright/test";
import type { ClaimDetail } from "../packages/contracts/src";

const user = {
  id: "ldc-only-user",
  username: "ldc-user",
  displayName: "LDC 用户",
  avatarUrl: null,
  accountTier: "standard" as const,
  canUseLdc: true,
  loginProvider: "connect" as const,
};

const liteUser = {
  ...user,
  id: "ldc-lite-user",
  accountTier: "lite" as const,
  canUseLdc: false,
  loginProvider: "liteauth" as const,
};

const activityId = "11111111-1111-4111-8111-111111111111";
const otherActivityId = "44444444-4444-4444-8444-444444444444";
const resultId = "22222222-2222-4222-8222-222222222222";
const confirmedPayment = {
  id: "retirement-simulation-payment",
  mode: "simulation",
  status: "confirmed",
  reason: null,
  confirmedAt: "2026-10-12T00:00:00Z",
} satisfies ClaimDetail["payment"];

function ldcActivity(id = activityId) {
  return {
    id,
    title: "LDC-only 活动",
    rewardType: "ldc",
    status: "active",
    author: { ...user, id: "ldc-author", displayName: "活动作者" },
    forceDedicated: false,
    topicUrl: null,
    openedAt: "2026-10-12T00:00:00Z",
    deadlineAt: "2026-10-13T00:00:00Z",
    quantity: { mode: "exact", total: 1, claimed: 0, remaining: 1 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "公开说明",
    paymentMode: "simulation",
    reward: { mode: "fixed", unitAmount: "1.00", totalAmount: "1.00" },
  };
}

async function installBaseMock(
  page: Page,
  options: {
    currentUser?: typeof user | typeof liteUser | null;
    activityStatus?: number;
    discoveryItems?: unknown[];
    redemptionItems?: unknown[];
    redemptionResult?: Record<string, unknown>;
  } = {},
) {
  const state = {
    discovers: [] as unknown[],
    activityReads: 0,
    participationReads: 0,
    claimReads: 0,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/session" || path === "/api/me") {
      const currentUser =
        options.currentUser === undefined ? user : options.currentUser;
      return route.fulfill({
        json: {
          user: currentUser,
          csrfToken: currentUser ? "csrf" : null,
          loginOptions: { liteauthEnabled: true },
          attemptCooldown: null,
        },
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
          statusCounts: { all: 0, draft: 0, active: 0, ended: 0, archived: 0 },
        },
      });
    if (path === "/api/me/participations")
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    if (path === "/api/me/claims/66666666-6666-4666-8666-666666666666") {
      state.claimReads += 1;
      if (state.claimReads > 2)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "未找到参与记录。" } },
        });
      return route.fulfill({
        json: {
          claim: {
            id: "66666666-6666-4666-8666-666666666666",
            activity: { id: activityId, title: "旧活动领取", status: "active" },
            rewardType: "ldc",
            amount: "1.00",
            claimedAt: "2026-10-12T00:00:00Z",
            afterClaimInfo: "",
            source: "口令",
            payment: confirmedPayment,
          },
        },
      });
    }
    if (path === "/api/discovery/activities") {
      const items = options.discoveryItems ?? [];
      return route.fulfill({
        json: { items, nextCursor: null, total: items.length },
      });
    }
    if (path === "/api/discovery")
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    if (path === `/api/activities/${activityId}`) {
      state.activityReads += 1;
      if (options.activityStatus === 404)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "未找到活动。" } },
        });
      return route.fulfill({ json: { activity: ldcActivity() } });
    }
    if (path === `/api/activities/${activityId}/participation`) {
      state.participationReads += 1;
      return route.fulfill({ json: { claim: null, registration: null } });
    }
    if (path === `/api/activities/${otherActivityId}`)
      return route.fulfill({
        json: {
          activity: {
            ...ldcActivity(otherActivityId),
            title: "已绑定 LDC 活动",
          },
        },
      });
    if (path === `/api/activities/${otherActivityId}/participation`)
      return route.fulfill({ json: { claim: null, registration: null } });
    if (path === `/api/activities/${otherActivityId}/passwords`)
      return route.fulfill({ json: { passwords: [], total: 0 } });
    if (path === `/api/activities/${otherActivityId}/recipients`)
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    if (path === "/api/redemptions/discover") {
      state.discovers.push(request.postDataJSON());
      if (options.currentUser === liteUser)
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "OFFICIAL_CONNECT_REQUIRED",
              message: "需要普通资格。",
            },
          },
        });
      return route.fulfill({
        json: {
          id: resultId,
          result: "multiple",
          claimSubmissionId: "33333333-3333-4333-8333-333333333333",
          items: options.redemptionItems ?? [ldcActivity()],
          nextCursor: null,
          ...(options.redemptionResult ?? {}),
        },
      });
    }
    if (path === `/api/redemptions/${resultId}`)
      return route.fulfill({
        json: {
          id: resultId,
          result: "multiple",
          claimSubmissionId: "33333333-3333-4333-8333-333333333333",
          items: options.redemptionItems ?? [ldcActivity()],
          nextCursor: null,
          ...(options.redemptionResult ?? {}),
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: path } },
    });
  });
  return state;
}

test("旧奖励类型 URL 会 replace 移除废弃参数并保留合法筛选", async ({
  page,
}) => {
  await installBaseMock(page);

  await page.goto("/square?status=ended&type=text");
  await expect(page).toHaveURL(/\/square\?status=ended$/);
  await expect(
    page.getByRole("group", { name: "奖励筛选", exact: true }),
  ).toHaveCount(0);

  await page.goto("/my/claims?type=text");
  await expect(page).toHaveURL(/\/my\/claims$/);
  await expect(
    page.getByRole("group", { name: "奖励类型", exact: true }),
  ).toHaveCount(0);

  await page.goto("/my/activities?type=text&statistics=abc");
  await expect(page).toHaveURL(/\/my\/activities\?statistics=abc$/);
  await expect(
    page.getByRole("group", { name: "奖励类型", exact: true }),
  ).toHaveCount(0);
});

test("青春版首页先识别活动标识，普通口令才提示升级且不提交", async ({
  page,
}) => {
  const state = await installBaseMock(page, { currentUser: liteUser });

  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill(activityId);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${activityId}`);
  expect(state.discovers).toHaveLength(0);

  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("普通口令123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByText("兑奖需要使用官方 Connect 升级后重新提交口令。"),
  ).toBeVisible();
  expect(state.discovers).toHaveLength(0);
});

test("旧全站兑奖结果只展示 LDC 候选，全文本候选不可继续恢复", async ({
  page,
}) => {
  const textOnly = [
    {
      ...ldcActivity("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      rewardType: "text",
      reward: { mode: "text" },
      title: "旧文本活动",
    },
  ];
  await installBaseMock(page, {
    redemptionItems: [textOnly[0], ldcActivity()],
  });

  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("有效口令123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  await expect(page.getByText("LDC-only 活动", { exact: true })).toBeVisible();
  await expect(page.getByText("旧文本活动", { exact: true })).toHaveCount(0);

  await page.unroute("**/api/**");
  await installBaseMock(page, { redemptionItems: textOnly });
  await page.reload();
  await page.getByLabel("口令", { exact: true }).fill("另一个口令123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(page.getByText("未匹配到活动。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toHaveCount(0);
});

test("旧活动 404 只清理相关缓存，不撤下其他 LDC 列表内容", async ({ page }) => {
  const other = {
    ...ldcActivity(otherActivityId),
    title: "仍可展示的 LDC 活动",
  };
  const state = await installBaseMock(page, {
    activityStatus: 404,
    discoveryItems: [other],
  });

  await page.goto("/square");
  await expect(
    page.getByText("仍可展示的 LDC 活动", { exact: true }),
  ).toBeVisible();
  expect(state.activityReads).toBe(0);

  await page.goto(`/activities/${activityId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("alert")).toContainText("未找到活动");

  await page.goto("/square");
  await expect(
    page.getByText("仍可展示的 LDC 活动", { exact: true }),
  ).toBeVisible();
  expect(state.activityReads).toBeGreaterThan(0);
});

test("已绑定的多候选 LDC 兑换结果按原目标恢复且不重复提交", async ({
  page,
}) => {
  let claimPosts = 0;
  await installBaseMock(page, {
    redemptionItems: [],
    redemptionResult: {
      selectedActivityId: otherActivityId,
      claimResult: {
        result: "claimed",
        claim: {
          id: "55555555-5555-4555-8555-555555555555",
          activityId: otherActivityId,
          activityTitle: "已绑定 LDC 活动",
          claimedAt: "2026-10-12T00:00:00Z",
          claimStatus: "claimed",
          participationMode: "password",
          rewardType: "ldc",
          amount: "1.00",
          payment: null,
        },
      },
    },
  });
  await page.route(`**/api/activities/${otherActivityId}`, async (route) =>
    route.fulfill({
      json: {
        activity: { ...ldcActivity(otherActivityId), title: "已绑定 LDC 活动" },
      },
    }),
  );
  await page.route(
    `**/api/activities/${otherActivityId}/participation`,
    async (route) =>
      route.fulfill({
        json: {
          claim: {
            id: "55555555-5555-4555-8555-555555555555",
            activityId: otherActivityId,
            activityTitle: "已绑定 LDC 活动",
            claimedAt: "2026-10-12T00:00:00Z",
            claimStatus: "claimed",
            participationMode: "password",
            rewardType: "ldc",
            amount: "1.00",
            payment: confirmedPayment,
          },
          registration: null,
        },
      }),
  );
  await page.route(
    `**/api/activities/${otherActivityId}/passwords`,
    async (route) => route.fulfill({ json: { passwords: [], total: 0 } }),
  );
  await page.route(
    `**/api/activities/${otherActivityId}/recipients`,
    async (route) =>
      route.fulfill({ json: { items: [], nextCursor: null, total: 0 } }),
  );
  await page.route(
    `**/api/activities/${otherActivityId}/claim`,
    async (route) => {
      claimPosts += 1;
      return route.fulfill({
        status: 409,
        json: { error: { message: "不应重复提交" } },
      });
    },
  );

  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill("绑定口令123");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();

  await expect(page).toHaveURL(`/activities/${otherActivityId}`);
  expect(claimPosts).toBe(0);
});

test("旧活动 404 会清理嵌套 activity.id 的本人领取详情缓存", async ({
  page,
}) => {
  const state = await installBaseMock(page, { activityStatus: 404 });

  await page.goto("/my/claims/66666666-6666-4666-8666-666666666666", {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(`/activities/${activityId}`);
  await expect(page.getByRole("alert")).toContainText("未找到活动");

  await page.goto("/my/claims/66666666-6666-4666-8666-666666666666", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("alert")).toContainText("未找到参与记录");
  expect(state.claimReads).toBeGreaterThan(1);
});

test("活动资源 404 会撤下详情、名单 overlay 和本活动待消费意图", async ({
  page,
}) => {
  const state = await installBaseMock(page, { activityStatus: 404 });
  await page.goto(`/activities/${activityId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.evaluate((id) => {
    history.replaceState(
      {
        ...history.state,
        hbOverlay: {
          kind: "roster",
          id,
          parent: "legacy",
          owner: "ldc-only-user:standard",
          version: 2,
        },
      },
      "",
      location.href,
    );
  }, activityId);
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(page.getByRole("alert")).toContainText("未找到活动");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.activityReads).toBeGreaterThan(0);
  expect(state.participationReads).toBe(0);
});
