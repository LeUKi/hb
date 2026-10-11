import { expect, type Page, test } from "@playwright/test";
import { emptyActivityInput, type Merchant } from "../packages/contracts/src";

const user = {
  id: "user-1",
  username: "viewer",
  displayName: "查看者",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
};
const author = {
  id: "author-1",
  username: "author",
  displayName: "作者",
  avatarUrl: null,
};

function activity(id: string, title: string, status = "active") {
  return {
    id,
    title,
    rewardType: "ldc",
    status,
    author,
    forceDedicated: false,
    topicUrl: null,
    openedAt: "2026-10-07T00:00:00Z",
    deadlineAt: "2026-10-08T00:00:00Z",
    quantity: { mode: "exact", total: 30, claimed: 10, remaining: 20 },
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    beforeInfo: "",
    paymentMode: "simulation",
    reward: { mode: "fixed", unitAmount: "0.88", totalAmount: "26.40" },
    myClaim: null,
    myRegistration: null,
  };
}

const validForumLink = "https://linux.do/t/topic/12345/6";
const invalidForumLink = "https://evil.example/t/12345/1";

const squareFirstPage = [
  {
    ...activity("a-active", "公开进行中", "ended"),
    topicUrl: validForumLink,
    draw: {
      state: "waiting",
      deadlineAt: "2026-10-08T00:00:00Z",
      closedAt: null,
      reason: null,
      registeredCount: 10,
      winnerCount: 2,
    },
  },
  {
    ...activity("a-claimed", "已参与活动"),
    topicUrl: invalidForumLink,
    myClaim: { id: "claim-1", paymentState: "pending" },
  },
  ...Array.from({ length: 18 }, (_, index) => ({
    ...activity(
      `a-long-${index}`,
      `超长公开活动标题用于验证操作列不会被挤出视口 ${index + 1}`,
    ),
    author: {
      ...author,
      displayName: `很长的发布者名称 ${index + 1}`,
    },
  })),
];

const squareSecondPage = Array.from({ length: 4 }, (_, index) =>
  activity(
    `a-next-${index}`,
    `第二页公开活动用于验证翻页后滚动复位 ${index + 1}`,
  ),
);

const authorBaseActivity = {
  id: "a-author",
  title: "我发起的活动",
  rewardType: "ldc",
  status: "active",
  version: 1,
  createdAt: "2026-10-07T00:00:00Z",
  openedAt: "2026-10-07T00:00:00Z",
  deadlineAt: "2026-10-08T00:00:00Z",
  topicUrl: null,
  totalCount: 30,
  claimedCount: 10,
  reward: {
    mode: "fixed",
    unitAmount: "0.88",
    totalAmount: "26.40",
  },
  paymentMode: "simulation",
  draw: null,
};

const authorActivities = [
  { ...authorBaseActivity, forceDedicated: true },
  ...Array.from({ length: 23 }, (_, index) => ({
    ...authorBaseActivity,
    id: `a-author-long-${index}`,
    title:
      index === 0
        ? "我发起的文本奖励活动"
        : `我发起的超长活动标题用于验证列表内滚动和操作按钮 ${index + 1}`,
    rewardType: index === 0 ? "text" : authorBaseActivity.rewardType,
    reward: index === 0 ? { mode: "text" } : authorBaseActivity.reward,
    createdAt: "2026-10-06T00:00:00Z",
  })),
];

const baseParticipations = [
  {
    kind: "claim",
    claim: {
      id: "claim-1",
      activity: {
        id: "a-claimed",
        title: "参与活动",
        status: "active",
        deadlineAt: "2026-10-08T00:00:00Z",
        author,
        createdAt: "2026-10-06T00:00:00Z",
        reward: {
          mode: "fixed",
          unitAmount: "0.88",
          totalAmount: "26.40",
        },
      },
      rewardType: "ldc",
      claimedAt: "2026-10-07T01:00:00Z",
      sourcePassword: "ok-pass",
      amount: "0.88",
      payment: {
        id: "pay-1",
        mode: "simulation",
        status: "confirmed",
        reason: null,
        confirmedAt: "2026-10-07T02:00:00Z",
      },
    },
  },
  {
    kind: "registration",
    registration: {
      id: "reg-1",
      activity: {
        id: "a-draw",
        title: "报名中奖活动",
        status: "ended",
        deadlineAt: "2026-10-07T00:30:00Z",
        author,
        createdAt: "2026-10-05T00:00:00Z",
        reward: {
          mode: "timed_draw",
          totalAmount: "9.99",
          participantLimit: 3,
        },
        draw: {
          state: "completed",
          deadlineAt: "2026-10-07T00:30:00Z",
          closedAt: "2026-10-07T00:31:00Z",
          reason: "deadline",
          registeredCount: 8,
          winnerCount: 3,
          participantLimit: 3,
        },
      },
      registeredAt: "2026-10-07T00:20:00Z",
      status: "won",
      drawAt: "2026-10-07T00:31:00Z",
      sourcePassword: "draw-pass",
      claim: {
        id: "claim-draw-1",
        activity: {
          id: "a-draw",
          title: "报名中奖活动",
          status: "ended",
        },
        rewardType: "ldc",
        claimedAt: "2026-10-07T00:31:00Z",
        sourcePassword: "draw-pass",
        amount: "3.33",
        afterClaimInfo: "",
        payment: {
          id: "pay-draw-1",
          mode: "simulation",
          status: "confirmed",
          reason: null,
          confirmedAt: "2026-10-07T03:00:00Z",
        },
      },
    },
  },
  {
    kind: "registration",
    registration: {
      id: "reg-2",
      activity: {
        id: "a-lost-draw",
        title: "报名未中奖活动",
        status: "ended",
        deadlineAt: "2026-10-07T00:30:00Z",
        author,
        createdAt: "2026-10-04T00:00:00Z",
        reward: {
          mode: "timed_draw",
          totalAmount: "12.34",
          participantLimit: 2,
        },
        draw: {
          state: "completed",
          deadlineAt: "2026-10-07T00:30:00Z",
          closedAt: "2026-10-07T00:31:00Z",
          reason: "deadline",
          registeredCount: 8,
          winnerCount: 2,
          participantLimit: 2,
        },
      },
      registeredAt: "2026-10-07T00:10:00Z",
      status: "not_won",
      drawAt: "2026-10-07T00:31:00Z",
      sourcePassword: "lost-pass",
      claim: null,
    },
  },
];

const participations = [
  ...baseParticipations,
  ...Array.from({ length: 21 }, (_, index) => ({
    kind: "claim",
    claim: {
      id: `claim-long-${index}`,
      activity: {
        id: `a-claim-long-${index}`,
        title: `我参与的超长活动标题用于验证移动端操作按钮 ${index + 1}`,
        status: "active",
        deadlineAt: "2026-10-08T00:00:00Z",
        author,
        createdAt: "2026-10-03T00:00:00Z",
        reward:
          index === 0
            ? { mode: "text" }
            : {
                mode: "fixed",
                unitAmount: "0.01",
                totalAmount: "0.24",
              },
      },
      rewardType: index === 0 ? "text" : "ldc",
      claimedAt: "2026-10-07T01:00:00Z",
      sourcePassword: `extra-pass-${index}`,
      amount: index === 0 ? undefined : "0.01",
      payment: {
        id: `pay-long-${index}`,
        mode: "simulation",
        status: "pending",
        reason: null,
        confirmedAt: null,
      },
    },
  })),
];

async function setup(page: Page) {
  const merchant: Merchant = {
    id: "merchant-1",
    label: "列表测试商户",
    clientId: "mock_list_client",
    mode: "simulation",
    scenario: "normal",
    version: 1,
    credentialVersion: 1,
    usageStatus: "current",
    publicationEligibility: {
      allowed: true,
      reason: null,
      credentialVersion: 1,
    },
    credentialVerification: {
      status: "unverified",
      credentialVersion: 1,
      checkedAt: null,
      nextCheckAt: null,
      reason: null,
    },
    capabilities: {
      canExecutePayments: true,
      canCheck: true,
      canSimulate: true,
      canVerify: false,
    },
    pausedReason: null,
    paymentCheckNextAt: null,
    createdAt: "2026-10-07T00:00:00Z",
    updatedAt: "2026-10-07T00:00:00Z",
  };
  const requested: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    requested.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/session" || url.pathname === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "csrf" } });
    if (url.pathname === "/api/discovery/activities") {
      const secondPage = url.searchParams.get("cursor") === "square-page-2";
      return route.fulfill({
        json: {
          total: squareFirstPage.length + squareSecondPage.length,
          nextCursor: secondPage ? null : "square-page-2",
          items: secondPage ? squareSecondPage : squareFirstPage,
        },
      });
    }
    if (url.pathname === "/api/me/history-summary")
      return route.fulfill({
        json: { initiatedCount: 7, participatedCount: 3 },
      });
    if (url.pathname === "/api/me/activities") {
      const secondPage = url.searchParams.get("cursor") === "author-page-2";
      return route.fulfill({
        json: {
          total: authorActivities.length,
          nextCursor: secondPage ? null : "author-page-2",
          statusCounts: {
            all: authorActivities.length,
            draft: 0,
            active: authorActivities.length,
            ended: 0,
            archived: 0,
          },
          items: secondPage
            ? authorActivities.slice(20)
            : authorActivities.slice(0, 20),
        },
      });
    }
    if (url.pathname.match(/^\/api\/me\/activities\/[^/]+\/statistics$/))
      return route.fulfill({
        json: {
          totalAttempts: 2,
          uniqueUsers: 1,
          successfulClaims: 1,
          items: [
            {
              password: "ok-pass",
              attempts: 2,
              uniqueUsers: 1,
              matchedAttempts: 1,
              unmatchedAttempts: 1,
              successfulClaims: 1,
            },
          ],
          validPasswords: [{ password: "ok-pass", successfulClaims: 1 }],
          nextCursor: null,
        },
      });
    if (url.pathname === "/api/me/participations") {
      const secondPage = url.searchParams.get("cursor") === "claims-page-2";
      return route.fulfill({
        json: {
          total: participations.length,
          nextCursor: secondPage ? null : "claims-page-2",
          statusCounts: {
            all: participations.length,
            draft: 0,
            active: participations.length - 2,
            ended: 2,
            archived: 0,
          },
          items: secondPage
            ? participations.slice(20)
            : participations.slice(0, 20),
        },
      });
    }
    const publicPasswordsMatch = url.pathname.match(
      /^\/api\/activities\/([^/]+)\/passwords$/,
    );
    if (publicPasswordsMatch)
      return route.fulfill({
        json: {
          passwords: [
            {
              text: "ok-pass",
              isClaimPassword: false,
              isRegistrationPassword: false,
              isSolved: true,
            },
          ],
          hiddenCount: 0,
          canSolve: true,
        },
      });
    const publicParticipationMatch = url.pathname.match(
      /^\/api\/activities\/([^/]+)\/participation$/,
    );
    if (publicParticipationMatch) {
      const firstClaim = (
        baseParticipations[0] as { claim: Record<string, unknown> }
      ).claim;
      const activityId = publicParticipationMatch[1] ?? "";
      const item = participations.find((item) => {
        const claimActivity =
          "claim" in item && item.claim ? item.claim.activity : null;
        const registrationActivity =
          "registration" in item && item.registration
            ? item.registration.activity
            : null;
        return (
          claimActivity?.id === activityId ||
          registrationActivity?.id === activityId
        );
      });
      const claim =
        activityId === "a-claimed"
          ? {
              ...firstClaim,
              afterClaimInfo: "",
            }
          : item && "claim" in item
            ? item.claim
            : null;
      return route.fulfill({
        json: {
          claim,
          registration:
            item && "registration" in item ? item.registration : null,
        },
      });
    }
    const publicClaimMatch = url.pathname.match(
      /^\/api\/activities\/([^/]+)\/claim$/,
    );
    if (publicClaimMatch) {
      const firstClaim = (
        baseParticipations[0] as { claim: Record<string, unknown> }
      ).claim;
      const claim =
        publicClaimMatch[1] === "a-claimed"
          ? {
              ...firstClaim,
              afterClaimInfo: "",
            }
          : null;
      return route.fulfill({ json: { claim } });
    }
    if (url.pathname.match(/^\/api\/activities\/[^/]+\/registration$/))
      return route.fulfill({ json: { registration: null } });
    const publicActivityMatch = url.pathname.match(
      /^\/api\/activities\/([^/]+)$/,
    );
    if (publicActivityMatch) {
      const id = publicActivityMatch[1] ?? "";
      const listed =
        [...squareFirstPage, ...squareSecondPage].find(
          (item) => item.id === id,
        ) ??
        authorActivities.find((item) => item.id === id) ??
        participations
          .map((item) =>
            "claim" in item && item.claim
              ? item.claim.activity
              : "registration" in item && item.registration
                ? item.registration.activity
                : null,
          )
          .find((item) => item?.id === id);
      return route.fulfill({
        json: {
          activity: {
            ...activity(id, listed?.title ?? `公开活动 ${id}`),
            ...(listed ?? {}),
            id,
            status: listed?.status ?? "active",
            author:
              listed && "author" in listed && listed.author
                ? listed.author
                : author,
            beforeInfo: "",
            afterEndInfo: "",
            openingBlockedReason: null,
          },
        },
      });
    }
    if (url.pathname === "/api/me/merchants")
      return route.fulfill({
        json: {
          items: [merchant],
          currentMerchantId: merchant.id,
          canCreate: false,
          canSimulate: true,
          nextCursor: null,
        },
      });
    if (url.pathname === `/api/me/merchants/${merchant.id}`)
      return route.fulfill({ json: { merchant } });
    const managedMatch = url.pathname.match(/^\/api\/me\/activities\/([^/]+)$/);
    if (managedMatch)
      return route.fulfill({
        json: {
          activity: {
            id: managedMatch[1],
            title: managedMatch[1] === "a-anchor" ? "锚点活动" : "管理活动",
            rewardType: "ldc",
            status: "active",
            version: 1,
            createdAt: "2026-10-07T00:00:00Z",
            openedAt: "2026-10-07T00:00:00Z",
            deadlineAt: null,
            topicUrl: null,
            totalCount: 1,
            claimedCount: 0,
            merchantId: "merchant-1",
            author,
            config: {
              ...emptyActivityInput(),
              title: managedMatch[1] === "a-anchor" ? "锚点活动" : "管理活动",
              rewardType: "ldc",
              merchantId: "merchant-1",
              money: { mode: "fixed", totalAmount: "0.88", count: 1 },
            },
          },
        },
      });
    if (url.pathname === "/api/me/payment-activities") {
      const secondPage = url.searchParams.get("cursor") === "page-2";
      const extra = Array.from({ length: 36 }, (_, index) => ({
        id: `a-extra-${index}`,
        title: `补充活动 ${index + 1}`,
        rewardType: "ldc",
        status: "active",
        version: 1,
        createdAt: "2026-10-07T00:00:00Z",
        openedAt: "2026-10-07T00:00:00Z",
        deadlineAt: null,
        topicUrl: null,
        totalCount: 30,
        claimedCount: 21,
        merchantId: "merchant-1",
      }));
      return route.fulfill({
        json: {
          total: 26,
          nextCursor: secondPage ? null : "page-2",
          items: secondPage
            ? extra.slice(18)
            : [
                {
                  id: "a-zero",
                  title: "零目标活动",
                  rewardType: "ldc",
                  status: "active",
                  version: 1,
                  createdAt: "2026-10-07T00:00:00Z",
                  openedAt: "2026-10-07T00:00:00Z",
                  deadlineAt: null,
                  topicUrl: null,
                  totalCount: 0,
                  claimedCount: 0,
                  merchantId: "merchant-1",
                  draw: null,
                },
                {
                  id: "a-full",
                  title: "多目标活动",
                  rewardType: "ldc",
                  status: "active",
                  version: 1,
                  createdAt: "2026-10-07T00:00:00Z",
                  openedAt: "2026-10-07T00:00:00Z",
                  deadlineAt: null,
                  topicUrl: null,
                  totalCount: 30,
                  claimedCount: 21,
                  merchantId: "merchant-1",
                },
                ...extra.slice(0, 18),
              ],
        },
      });
    }
    const paymentMatch = url.pathname.match(
      /^\/api\/me\/activities\/([^/]+)\/payments$/,
    );
    if (paymentMatch) {
      const id = paymentMatch[1];
      return route.fulfill({
        json: {
          activityId: id,
          merchantId: "merchant-1",
          total: id === "a-zero" ? 0 : 2,
          nextCursor:
            (id === "a-full" || id === "a-extra-18") &&
            !url.searchParams.get("cursor")
              ? "target-2"
              : null,
          summary: {
            pendingAmount: id === "a-zero" ? "0.00" : "0.88",
            confirmedAmount: id === "a-zero" ? "0.00" : "1.76",
            totalAmount: id === "a-zero" ? "0.00" : "2.64",
            pendingCount: id === "a-zero" ? 0 : 1,
            confirmedCount: id === "a-zero" ? 0 : 2,
            totalCount: id === "a-zero" ? 0 : 3,
          },
          items:
            id === "a-zero" || id === "a-anchor"
              ? []
              : [
                  {
                    id: url.searchParams.get("cursor") ? "pay-2" : "pay-1",
                    mode: "simulation",
                    status: "pending",
                    reason: null,
                    confirmedAt: null,
                    amount: "0.88",
                    businessNo: url.searchParams.get("cursor")
                      ? "biz-2"
                      : "biz-1",
                    externalOrderId: null,
                    createdAt: "2026-10-07T01:00:00Z",
                    nextRunAt: "2026-10-07T01:05:00Z",
                    source: "claim",
                    claimId: "claim-1",
                    activityId: id,
                    acceptanceId: null,
                    recipientProfile: {
                      id: "recipient-1",
                      username: "recipient",
                      displayName: "收款人",
                      avatarUrl: null,
                      accountTier: "standard",
                    },
                  },
                ],
        },
      });
    }
    const selectedPayment = url.pathname.match(
      /^\/api\/me\/merchants\/merchant-1\/payments\/(pay-[12])$/,
    );
    if (selectedPayment)
      return route.fulfill({
        json: {
          payment: {
            id: selectedPayment[1],
            source: "claim",
            activityId: "a-full",
            claimId: "claim-1",
            acceptanceId: null,
            mode: "simulation",
            status: "pending",
            reason: null,
            amount: "0.88",
            businessNo: selectedPayment[1] === "pay-1" ? "biz-1" : "biz-2",
            externalOrderId: null,
            confirmedAt: null,
            createdAt: "2026-10-07T01:00:00Z",
            nextRunAt: "2026-10-07T01:05:00Z",
            recipientProfile: {
              id: "recipient-1",
              username: "recipient",
              displayName: "收款人",
              avatarUrl: null,
              accountTier: "standard",
            },
          },
        },
      });
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return requested;
}

async function expectFixedListScroll(page: Page) {
  const table = page.locator(".list-panel__scroll").first();
  const pagination = page.locator(".list-pagination").first();
  await expect(table).toBeVisible();
  await expect(pagination).toBeVisible();
  expect(
    await table.evaluate((node) => node.scrollHeight > node.clientHeight),
  ).toBe(true);
  const before = await pagination.boundingBox();
  expect(before).not.toBeNull();
  await table.evaluate((node) => {
    node.scrollTop = 160;
  });
  await expect
    .poll(() => table.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const after = await pagination.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
}

async function expectNoHorizontalDocumentScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

async function expectBoxSize(
  locator: ReturnType<Page["locator"]>,
  expected: { width: number; height: number },
) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box?.width ?? 0)).toBe(expected.width);
  expect(Math.round(box?.height ?? 0)).toBe(expected.height);
}

function matchingApiRequests(
  requested: string[],
  from: number,
  pathname: string,
) {
  return requested.slice(from).flatMap((path) => {
    const url = new URL(path, "https://local.test");
    return url.pathname === pathname ? [url] : [];
  });
}

function detailActivityRequests(requested: string[], from: number) {
  return requested
    .slice(from)
    .filter((path) => /^\/api\/me\/activities\/[^/?]+(?:\?.*)?$/.test(path));
}

test("正式列表在表格内滚动、固定分页并保留操作列", async ({ page }) => {
  await setup(page);
  await page.goto("/square");
  await expectFixedListScroll(page);

  const table = page.locator(".list-panel__scroll").first();
  const pagination = page.locator(".list-pagination").first();
  const viewLink = page
    .locator(".compact-activity-table tbody tr")
    .nth(6)
    .getByRole("link", { name: "查看活动" });
  await expect(viewLink).toBeVisible();
  await viewLink.focus();
  const scrollBeforeOpen = await table.evaluate((node) => node.scrollTop);
  await viewLink.click();
  await expect(page).toHaveURL(/\/activities\/a-long-4$/);
  await expect(
    page.getByRole("heading", {
      name: "超长公开活动标题用于验证操作列不会被挤出视口 5",
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/square(?:\?|$)/);
  await expect(viewLink).toBeFocused();
  await expect
    .poll(() => table.evaluate((node) => node.scrollTop))
    .toBe(scrollBeforeOpen);

  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByText("第二页公开活动用于验证翻页后滚动复位 1"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".list-panel__scroll")
        .first()
        .evaluate((node) => node.scrollTop),
    )
    .toBe(0);

  for (const path of ["/my/claims", "/my/activities"]) {
    await page.goto(path);
    await expectFixedListScroll(page);
    await expect(
      page.getByRole("link", { name: "查看活动" }).first(),
    ).toBeVisible();
  }

  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/square");
  await expectFixedListScroll(page);
  await expect(
    page.getByRole("link", { name: "查看活动" }).first(),
  ).toBeVisible();
  await expectBoxSize(
    page.getByRole("link", { name: "打开关联论坛帖子" }).first(),
    { width: 40, height: 28 },
  );
  await expectNoHorizontalDocumentScroll(page);
});

test("短视口和放大文字下列表退回页面滚动且分页不裁切", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 375, height: 500 });
  await page.goto("/square");
  await expect(page.getByRole("table", { name: "公开活动" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "活动广场分页" }),
  ).toBeVisible();
  await page.locator(".list-page *").evaluateAll((elements) => {
    for (const element of elements) {
      const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
      if (Number.isFinite(fontSize))
        (element as HTMLElement).style.fontSize = `${fontSize * 2}px`;
    }
  });
  const pagination = page.locator(".list-pagination").first();
  await expect(pagination).toBeVisible();
  await pagination.scrollIntoViewIfNeeded();
  const paginationBox = await pagination.boundingBox();
  expect(paginationBox).not.toBeNull();
  expect(paginationBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (paginationBox?.y ?? 0) + (paginationBox?.height ?? 0),
  ).toBeLessThanOrEqual(500);
  await pagination
    .getByRole("button", { name: "下一页" })
    .click({ trial: true });
  await expectNoHorizontalDocumentScroll(page);
});

test("历史列表挂载后刷新列表和账号统计且不逐行补查", async ({ page }) => {
  const requested = await setup(page);
  await page.clock.install({ time: new Date("2026-10-07T08:00:00Z") });

  for (const scenario of [
    {
      path: "/my/activities",
      api: "/api/me/activities",
      label: "我发起的活动",
    },
    {
      path: "/my/claims",
      api: "/api/me/participations",
      label: "我参与的活动",
    },
  ] as const) {
    await page.goto(scenario.path);
    await expect(
      page.getByRole("table", { name: scenario.label }),
    ).toBeVisible();
    const listScroll = page.locator(".list-panel__scroll").first();
    const expectedScrollTop = await listScroll.evaluate((node) => {
      node.scrollTop = 96;
      return node.scrollTop;
    });
    const mountedFrom = requested.length;

    await page.clock.fastForward(15_000);

    await expect
      .poll(
        () => matchingApiRequests(requested, mountedFrom, scenario.api).length,
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          matchingApiRequests(requested, mountedFrom, "/api/me/history-summary")
            .length,
      )
      .toBeGreaterThan(0);
    expect(detailActivityRequests(requested, mountedFrom)).toEqual([]);
    expect(
      matchingApiRequests(requested, mountedFrom, "/api/session"),
    ).toHaveLength(0);
    await expect(page).toHaveURL(new RegExp(`${scenario.path}(?:\\?|$)`));
    await expect
      .poll(() => listScroll.evaluate((node) => node.scrollTop))
      .toBe(expectedScrollTop);
  }
});

test("历史列表在页面重新聚焦后刷新列表和账号统计", async ({ page }) => {
  const requested = await setup(page);

  for (const scenario of [
    {
      path: "/my/activities",
      api: "/api/me/activities",
      label: "我发起的活动",
    },
    {
      path: "/my/claims",
      api: "/api/me/participations",
      label: "我参与的活动",
    },
  ] as const) {
    await page.goto(scenario.path);
    await expect(
      page.getByRole("table", { name: scenario.label }),
    ).toBeVisible();
    const focusFrom = requested.length;
    const otherPage = await page.context().newPage();
    await otherPage.goto("about:blank");
    await otherPage.bringToFront();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await otherPage.close();
    await expect
      .poll(
        () => matchingApiRequests(requested, focusFrom, scenario.api).length,
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          matchingApiRequests(requested, focusFrom, "/api/me/history-summary")
            .length,
      )
      .toBeGreaterThan(0);
    expect(detailActivityRequests(requested, focusFrom)).toEqual([]);
  }
});

test("历史筛选和后退不会沿用上一页游标", async ({ page }) => {
  const requested = await setup(page);

  await page.goto("/my/activities");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByText("我发起的超长活动标题用于验证列表内滚动和操作按钮 20"),
  ).toBeVisible();
  const beforeActivityFilter = requested.length;
  await page.evaluate(() => {
    window.history.pushState({}, "", "/my/activities?type=text");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect
    .poll(() =>
      matchingApiRequests(
        requested,
        beforeActivityFilter,
        "/api/me/activities",
      ).some((url) => url.searchParams.get("type") === "text"),
    )
    .toBe(true);
  expect(
    matchingApiRequests(
      requested,
      beforeActivityFilter,
      "/api/me/activities",
    ).some(
      (url) =>
        url.searchParams.get("type") === "text" &&
        url.searchParams.get("cursor") === "author-page-2",
    ),
  ).toBe(false);

  await page.goto("/my/claims");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByText("我参与的超长活动标题用于验证移动端操作按钮 18"),
  ).toBeVisible();
  const beforeClaimFilter = requested.length;
  await page.evaluate(() => {
    window.history.pushState({}, "", "/my/claims?type=text");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect
    .poll(() =>
      matchingApiRequests(
        requested,
        beforeClaimFilter,
        "/api/me/participations",
      ).some((url) => url.searchParams.get("type") === "text"),
    )
    .toBe(true);
  expect(
    matchingApiRequests(
      requested,
      beforeClaimFilter,
      "/api/me/participations",
    ).some(
      (url) =>
        url.searchParams.get("type") === "text" &&
        url.searchParams.get("cursor") === "claims-page-2",
    ),
  ).toBe(false);
});

test("历史导航恢复筛选分页滚动并在刷新后保留列表状态", async ({ page }) => {
  await setup(page);
  await page.goto("/my/activities");
  await page
    .getByRole("group", { name: "奖励类型" })
    .getByRole("button", { name: "LDC" })
    .click();
  await expect(page).toHaveURL(/\/my\/activities\?type=ldc$/);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(
    page.getByText("我发起的超长活动标题用于验证列表内滚动和操作按钮 20"),
  ).toBeVisible();
  const listScroll = page.locator(".list-panel__scroll").first();
  const expectedScrollTop = await listScroll.evaluate((node) => {
    node.scrollTop = 128;
    return node.scrollTop;
  });
  const detailLink = page
    .getByRole("row", {
      name: /我发起的超长活动标题用于验证列表内滚动和操作按钮 20/,
    })
    .getByRole("link", { name: "查看活动" });
  await detailLink.click();
  await expect(page).toHaveURL(/\/activities\/a-author-long-19$/);
  await expect(
    page.getByRole("heading", {
      name: "我发起的超长活动标题用于验证列表内滚动和操作按钮 20",
    }),
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/my\/activities\?type=ldc$/);
  await expect(
    page.getByText("我发起的超长活动标题用于验证列表内滚动和操作按钮 20"),
  ).toBeVisible();
  await expect(page.getByText("第 2 页")).toBeVisible();
  await expect
    .poll(() => listScroll.evaluate((node) => node.scrollTop))
    .toBe(expectedScrollTop);

  await page.goForward();
  await expect(page).toHaveURL(/\/activities\/a-author-long-19$/);
  await page.goBack();
  await page.reload();
  await expect(page).toHaveURL(/\/my\/activities\?type=ldc$/);
  await expect(
    page
      .getByRole("group", { name: "奖励类型" })
      .getByRole("button", { name: "LDC" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("我发起的超长活动标题用于验证列表内滚动和操作按钮 20"),
  ).toBeVisible();
  await expect(page.getByText("第 2 页")).toBeVisible();
  await expect
    .poll(() => listScroll.evaluate((node) => node.scrollTop))
    .toBe(expectedScrollTop);
});

test("广场和参与历史从详情返回保留筛选分页滚动", async ({ page }) => {
  await setup(page);

  for (const scenario of [
    {
      path: "/square?status=ended&type=ldc",
      expectedUrl: /\/square\?status=ended&type=ldc$/,
      table: "公开活动",
      pagination: "活动广场分页",
      rowName: /第二页公开活动用于验证翻页后滚动复位 1/,
      detailUrl: /\/activities\/a-next-0$/,
      heading: "第二页公开活动用于验证翻页后滚动复位 1",
      filter: { group: "奖励筛选", button: "LDC" },
      statusButtonText: "状态：已结束",
    },
    {
      path: "/my/claims?type=ldc",
      expectedUrl: /\/my\/claims\?type=ldc$/,
      table: "我参与的活动",
      pagination: "参与记录分页",
      rowName: /我参与的超长活动标题用于验证移动端操作按钮 18/,
      detailUrl: /\/activities\/a-claim-long-17$/,
      heading: "我参与的超长活动标题用于验证移动端操作按钮 18",
      filter: { group: "奖励类型", button: "LDC" },
      statusButtonText: null,
    },
  ] as const) {
    await page.goto(scenario.path);
    await expect(page).toHaveURL(scenario.expectedUrl);
    await page
      .getByRole("navigation", { name: scenario.pagination })
      .getByRole("button", { name: "下一页" })
      .click();
    await expect(
      page.getByRole("row", { name: scenario.rowName }),
    ).toBeVisible();
    const listScroll = page.locator(".list-panel__scroll").first();
    const expectedScrollTop = await listScroll.evaluate((node) => {
      node.scrollTop = 96;
      return node.scrollTop;
    });
    const detailLink = page
      .getByRole("row", { name: scenario.rowName })
      .getByRole("link", { name: "查看活动" });
    await detailLink.click();
    await expect(page).toHaveURL(scenario.detailUrl);
    await expect(
      page.getByRole("heading", { name: scenario.heading }),
    ).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(scenario.expectedUrl);
    await expect(
      page.getByRole("table", { name: scenario.table }),
    ).toBeVisible();
    await expect(
      page.getByRole("row", { name: scenario.rowName }),
    ).toBeVisible();
    await expect(page.getByText("第 2 页")).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: scenario.filter.group })
        .getByRole("button", { name: scenario.filter.button }),
    ).toHaveAttribute("aria-pressed", "true");
    if (scenario.statusButtonText) {
      await expect(
        page.getByRole("button", { name: "活动状态筛选" }),
      ).toContainText(scenario.statusButtonText);
    }
    await expect
      .poll(() => listScroll.evaluate((node) => node.scrollTop))
      .toBe(expectedScrollTop);
  }
});

test("默认列表重置在窄屏和平板宽度保持默认筛选", async ({ page }) => {
  await setup(page);

  for (const width of [375, 768] as const) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto("/square?status=ended&type=text");
    await page.getByRole("link", { name: "活动广场" }).click();
    await expect(page).toHaveURL("/square?status=all&type=all");
    await expect(
      page
        .getByRole("group", { name: "奖励筛选" })
        .getByRole("button", { name: "全部" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "活动状态筛选" }),
    ).toContainText("状态：全部");

    await page.goto("/my/claims?type=text");
    await page.getByRole("link", { name: "活动历史" }).click();
    await expect(page).toHaveURL("/my/activities?type=all");
    await page.getByRole("tab", { name: "我参与的" }).click();
    await expect(page).toHaveURL("/my/claims?type=all");
    await expect(
      page
        .getByRole("group", { name: "奖励类型" })
        .getByRole("button", { name: "全部" }),
    ).toHaveAttribute("aria-pressed", "true");
  }
});

test("主导航重置历史页默认状态且当前项重复点击不新增历史", async ({ page }) => {
  await setup(page);
  await page.goto("/my/activities?type=text");
  await expect(
    page
      .getByRole("group", { name: "奖励类型" })
      .getByRole("button", { name: "文本 / CDK" }),
  ).toHaveAttribute("aria-pressed", "true");
  const activityHistoryNav = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "活动历史" });
  const beforeReset = await page.evaluate(() => window.history.length);
  await activityHistoryNav.click();
  await expect(page).toHaveURL("/my/activities?type=all");
  await expect(
    page
      .getByRole("group", { name: "奖励类型" })
      .getByRole("button", { name: "全部" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => page.evaluate(() => window.history.length))
    .toBe(beforeReset);

  const beforeActiveReset = await page.evaluate(() => window.history.length);
  await activityHistoryNav.click();
  await expect(page).toHaveURL("/my/activities?type=all");
  await expect
    .poll(() => page.evaluate(() => window.history.length))
    .toBe(beforeActiveReset);
});

test("统计弹窗使用浏览器后退关闭并可前进重开", async ({ page }) => {
  await setup(page);
  await page.goto("/my/activities?type=all");
  await page
    .getByRole("button", { name: "我发起的活动：尝试统计", exact: true })
    .click();
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(statisticsDialog).toBeVisible();
  await page.goBack();
  await expect(statisticsDialog).toHaveCount(0);
  await expect(page).toHaveURL("/my/activities?type=all");
  await page.goForward();
  await expect(statisticsDialog).toBeVisible();
  await expect(page).toHaveURL("/my/activities?type=all");
});

test("旧奖励类型 URL 会归并到 LDC 且类型筛选只保留三项", async ({ page }) => {
  await setup(page);
  for (const path of [
    "/square?status=all&type=fixed",
    "/square?status=all&type=custom",
    "/square?status=all&type=random",
    "/square?status=all&type=timed_draw",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/square\?status=all&type=ldc$/);
    const filters = page.getByRole("group", {
      name: "奖励筛选",
      exact: true,
    });
    await expect(filters.getByRole("button")).toHaveText([
      "全部",
      "文本 / CDK",
      "LDC",
    ]);
    await expect(filters.getByRole("button", { name: "LDC" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }

  for (const path of [
    "/my/activities?type=fixed",
    "/my/activities?type=custom",
    "/my/activities?type=random",
    "/my/activities?type=timed_draw",
    "/my/claims?type=timed_draw",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/my\/(?:activities|claims)\?type=ldc$/);
    await expect(
      page
        .getByRole("group", { name: "奖励类型", exact: true })
        .getByRole("button"),
    ).toHaveText(["全部", "文本 / CDK", "LDC"]);
  }
});

test("广场默认全部且本人状态不混入付款状态", async ({ page }) => {
  const requested = await setup(page);
  await page.goto("/square");
  const statusMenu = page.getByRole("button", { name: "活动状态筛选" });
  await expect(statusMenu).toContainText("状态：全部");
  await statusMenu.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "活动状态筛选" })).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "活动状态筛选" }),
  ).toContainText("状态：已结束");
  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "进行中" }).click();
  await expect(
    page.getByRole("button", { name: "活动状态筛选" }),
  ).toContainText("状态：进行中");
  await expect
    .poll(() =>
      page
        .locator(".compact-activity-table")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe("rgb(37, 40, 45)");
  await expect
    .poll(() =>
      page
        .locator(".activity-table-open")
        .first()
        .evaluate((node) => getComputedStyle(node).color),
    )
    .toBe("rgb(245, 246, 248)");
  await expect
    .poll(() =>
      page
        .locator(
          ".gallery-toolbar .segmented-control__button[aria-pressed='true'] .segmented-control__selection",
        )
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe("rgb(75, 81, 91)");
  const squareStats = page.locator(".history-statistics", {
    hasText: "公开活动",
  });
  const publicStatistic = squareStats.locator('[data-statistic="public"]');
  await expect(squareStats).toHaveAttribute("aria-label", "活动广场统计");
  await expect(publicStatistic).toContainText("24");
  await expect(publicStatistic.locator("small")).toHaveText("场");
  await expect(
    page
      .getByRole("row", { name: /公开进行中/ })
      .getByRole("cell", { name: "最多 30 人获奖", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /已参与活动/ })
      .getByRole("cell", { name: "已领取 10 / 30 份", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".activity-table-title-cell", { hasText: "公开进行中" }),
  ).toContainText("进行中");
  await expect(
    page.locator(".activity-row-title-meta", { hasText: "已领取" }),
  ).toBeVisible();
  const forumLink = page
    .locator(".activity-table-title-cell", { hasText: "公开进行中" })
    .getByRole("link", { name: "打开关联论坛帖子" });
  await expect(forumLink).toHaveAttribute(
    "href",
    "https://linux.do/t/topic/12345/6",
  );
  await expect(forumLink).toHaveAttribute("target", "_blank");
  await expect(forumLink).toHaveAttribute("rel", /noopener/);
  await expectBoxSize(forumLink, { width: 36, height: 24 });
  const viewActionBox = await page
    .getByRole("link", { name: "查看活动" })
    .first()
    .boundingBox();
  expect(viewActionBox).not.toBeNull();
  expect(Math.round(viewActionBox?.height ?? 0)).toBe(32);
  expect(Math.round(viewActionBox?.width ?? 0)).toBeGreaterThan(36);
  await expect(
    page
      .locator(".activity-table-title-cell", { hasText: "已参与活动" })
      .getByRole("link", { name: "打开关联论坛帖子" }),
  ).toHaveCount(0);
  await expect(page.getByText(/待完成|已发放|本地模拟/)).toHaveCount(0);
  expect(requested.some((path) => path.includes("status=all"))).toBe(true);
});

test("历史只保留类型筛选，账号总数与真实来源口令正确", async ({ page }) => {
  const requested = await setup(page);
  await page.goto("/my/claims?status=ended");
  await expect(
    page.getByRole("tablist", { name: "活动历史分类" }),
  ).toContainText("我参与的");
  await expect(page.getByRole("tab", { name: "我参与的" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator(".history-statistics", { hasText: "已发起" }),
  ).toContainText("7场");
  await expect(
    page.locator(".history-statistics", { hasText: "已参与" }),
  ).toContainText("3场");
  await expect(
    page.getByRole("tablist", { name: "活动状态", exact: true }),
  ).toHaveCount(0);
  const participationTypeFilters = page.getByRole("group", {
    name: "奖励类型",
    exact: true,
  });
  await expect(participationTypeFilters).toBeVisible();
  await expect(participationTypeFilters.getByRole("button")).toHaveText([
    "全部",
    "文本 / CDK",
    "LDC",
  ]);
  await expect(page.getByRole("cell", { name: /作者/ }).first()).toBeVisible();
  await expect(page.getByText("2026/10/7 09:00:00").first()).toBeVisible();
  await expect(page.getByText("+0.88 LDC")).toBeVisible();
  await expect(page.getByText("+3.33 LDC")).toBeVisible();
  await expect(page.getByText("9.99 LDC 奖池")).toHaveCount(0);
  await expect(page.getByText("12.34 LDC 奖池")).toHaveCount(0);
  await expect(page.getByText("未中奖", { exact: true })).toBeVisible();
  await expect(page.getByText("draw-pass", { exact: true })).toBeVisible();
  await expect(page.getByText("lost-pass", { exact: true })).toBeVisible();
  await expect(page.getByLabel("已发放")).toHaveCount(2);
  await expect(page.getByText("通过口令 ok-pass 兑换")).toBeVisible();
  await expect(page.getByText("通过口令 draw-pass 报名")).toBeVisible();
  await expect(page.getByText("ok-pass", { exact: true })).toBeVisible();
  await expect(
    page
      .locator("td[data-label='我的奖励']", { hasText: "文本 / CDK" })
      .first(),
  ).toHaveText(/文本 \/ CDK\s*已领取/);
  await expect(
    page
      .locator("td[data-label='我的奖励']", { hasText: "文本 / CDK" })
      .first(),
  ).not.toHaveText(/文本 \/ CDK\s*文本 \/ CDK/);

  await page.getByRole("tab", { name: "我发起的" }).click();
  await expect(
    page.getByRole("tablist", { name: "活动状态", exact: true }),
  ).toHaveCount(0);
  const initiatedTypeFilters = page.getByRole("group", {
    name: "奖励类型",
    exact: true,
  });
  await expect(initiatedTypeFilters).toBeVisible();
  await expect(initiatedTypeFilters.getByRole("button")).toHaveText([
    "全部",
    "文本 / CDK",
    "LDC",
  ]);
  await expect(page.getByText("26.40 LDC 总额").first()).toBeVisible();
  await expect(
    page
      .locator("td[data-label='奖励配置']", { hasText: "文本 / CDK" })
      .first(),
  ).toHaveText("文本 / CDK");
  await expect(page.getByText("已领取 10 / 30 份").first()).toBeVisible();
  await expect(page.getByText("2026/10/7 08:00:00").first()).toBeVisible();
  for (const path of [
    "/my/activities?status=draft",
    "/my/claims?status=ended",
  ]) {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const filters = page.getByRole("group", {
        name: "奖励类型",
        exact: true,
      });
      await expect(filters).toBeVisible();
      await expect(
        page.getByRole("tablist", { name: "活动状态", exact: true }),
      ).toHaveCount(0);
      const filterBox = await filters.boundingBox();
      const listBox = await page.locator(".list-panel").boundingBox();
      expect(filterBox).not.toBeNull();
      expect(listBox).not.toBeNull();
      expect(
        (listBox?.y ?? 0) - ((filterBox?.y ?? 0) + (filterBox?.height ?? 0)),
      ).toBeCloseTo(12, 0);
      await expectNoHorizontalDocumentScroll(page);
      await expect(
        page.getByRole("navigation", { name: /活动分页|参与记录分页/ }),
      ).toBeVisible();
    }
  }
  expect(
    matchingApiRequests(requested, 0, "/api/me/activities").every(
      (url) => url.searchParams.get("status") === "all",
    ),
  ).toBe(true);
  expect(
    matchingApiRequests(requested, 0, "/api/me/participations").every(
      (url) => url.searchParams.get("status") === "all",
    ),
  ).toBe(true);
  await page.getByRole("tab", { name: "我发起的", exact: true }).click();
  await expect(page.locator("td[data-label='奖励配置']").first()).toBeVisible();
  await expect(page.locator("td[data-label='参与情况']").first()).toBeVisible();
});

test("付款活动、目标和详情按三列/手机逐级联动", async ({ page }) => {
  const requested = await setup(page);
  await page.goto("/my/payments?activityId=a-anchor");
  await expect(page.getByRole("button", { name: /锚点活动/ })).toHaveClass(
    /is-active/,
  );
  await expect(page.getByText("当前活动暂无发放目标。")).toBeVisible();

  await page.goto("/my/payments?activityId=a-zero");
  await expect(page.getByRole("button", { name: /零目标活动/ })).toHaveClass(
    /is-active/,
  );
  await expect(page.getByText("当前活动暂无发放目标。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /零目标活动/ }),
  ).not.toContainText(/LDC|0\.00|份/);

  const activityScroll = page
    .locator(".work-payment-activities .list-panel__scroll")
    .first();
  await activityScroll.evaluate((node) => {
    node.scrollTop = 24;
  });
  await page.getByRole("button", { name: /多目标活动/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /多目标活动/ })).toBeFocused();
  await expect
    .poll(() => activityScroll.evaluate((node) => node.scrollTop))
    .toBe(24);
  await expect(page.getByText("待完成金额 0.88 LDC")).toBeVisible();
  await expect(page.getByText("已发放金额 1.76 LDC")).toBeVisible();
  await expect(
    page.locator(".work-payment-row", { hasText: "收款人" }).first(),
  ).toHaveClass(/is-active/);
  await expect
    .poll(() =>
      page
        .locator(".work-payment-row", { hasText: "收款人" })
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe("rgb(75, 81, 91)");
  await expect(page.getByText("本站业务号")).toBeVisible();
  await page
    .getByRole("region", { name: "发放目标" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    page.locator('.work-payment-row[data-record-id="pay-2"]'),
  ).toBeVisible();
  await expect(page.getByText("biz-1")).toBeVisible();
  await page.reload();
  await expect(page.getByText("biz-1")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "发放目标" }).getByText("第 2 页"),
  ).toBeVisible();
  await page.locator('.work-payment-row[data-record-id="pay-2"]').click();
  await expect(page.getByText("biz-2")).toBeVisible();
  const beforeUrlStatusChange = requested.length;
  await page
    .getByRole("tablist", { name: "发放目标状态筛选" })
    .getByRole("tab", { name: "已发放" })
    .click();
  await expect(page).toHaveURL(
    /\/my\/payments\?.*activityId=a-full.*paymentStatus=confirmed/,
  );
  await expect(
    page
      .getByRole("tablist", { name: "发放目标状态筛选" })
      .getByRole("tab", { name: "已发放" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      requested
        .slice(beforeUrlStatusChange)
        .some(
          (path) =>
            path.startsWith("/api/me/activities/a-full/payments") &&
            path.includes("status=confirmed"),
        ),
    )
    .toBe(true);
  expect(
    requested
      .slice(beforeUrlStatusChange)
      .filter((path) => path.startsWith("/api/me/activities/a-full/payments")),
  ).not.toContain(
    "/api/me/activities/a-full/payments?status=confirmed&cursor=target-2",
  );
  await page
    .locator(".work-payment-row", { hasText: "收款人" })
    .evaluate((node) => {
      if (node.querySelector("button")) throw new Error("nested button found");
    });
  await page.goto("/my/payments?activityId=a-anchor");
  await expect(page.getByRole("button", { name: /锚点活动/ })).toHaveClass(
    /is-active/,
  );
  await expect(
    page.getByRole("button", { name: /零目标活动/ }),
  ).not.toHaveClass(/is-active/);

  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/my/payments?activityStatus=active");
  await page
    .getByRole("region", { name: "红包活动" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(page.getByRole("button", { name: /补充活动 19/ })).toBeVisible();
  const mobileActivityScroll = page
    .locator(".work-payment-activities .list-panel__scroll")
    .first();
  const expectedMobileScrollTop = await mobileActivityScroll.evaluate(
    (node) => {
      node.scrollTop = 2;
      return node.scrollTop;
    },
  );
  await page.getByRole("button", { name: /补充活动 19/ }).click();
  await expect(page.getByRole("button", { name: "返回上一页" })).toBeVisible();
  await page.goBack();
  await expect(
    page
      .getByRole("tablist", { name: "付款活动状态筛选" })
      .getByRole("tab", { name: "进行中" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "红包活动" }).getByText("第 2 页"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /补充活动 19/ })).toHaveClass(
    /is-active/,
  );
  await expect
    .poll(() => mobileActivityScroll.evaluate((node) => node.scrollTop))
    .toBe(expectedMobileScrollTop);
  await page.goForward();
  await expect(page.getByRole("button", { name: "返回上一页" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "发放目标" }).getByText("第 1 页"),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "发放目标" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    page.locator('.work-payment-row[data-record-id="pay-2"]'),
  ).toBeVisible();
  await page.locator(".work-payment-row", { hasText: "收款人" }).click();
  await expect(page.getByRole("dialog", { name: "付款详情" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "付款详情" })).toHaveCount(0);
  await expect(
    page.locator('.work-payment-row[data-record-id="pay-2"]'),
  ).toBeVisible();
  await expect(
    page.locator(".work-payment-row", { hasText: "收款人" }),
  ).toBeFocused();
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "付款详情" })).toBeVisible();
});

test("统计页移动端保留真实列名文本", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/my/activities?type=all");
  const actionTrigger = page.getByRole("button", {
    name: "我发起的活动操作",
    exact: true,
  });
  await actionTrigger.click();
  await page.getByRole("menuitem", { name: "尝试统计", exact: true }).click();
  const statisticsDialog = page.getByRole("dialog", {
    name: "兑换尝试统计",
    exact: true,
  });
  await expect(statisticsDialog).toBeVisible();
  await expect(page).toHaveURL("/my/activities?type=all");
  await expect(
    statisticsDialog.locator(".activity-mobile-label", {
      hasText: "命中 / 未命中",
    }),
  ).toBeVisible();
  await expect(
    statisticsDialog.locator(".activity-mobile-label", {
      hasText: "有效口令",
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(statisticsDialog).toHaveCount(0);
  await expect(actionTrigger).toBeFocused();
});

test("损坏的浏览快照与失效游标局部回到第一页", async ({ page }) => {
  await setup(page);
  await page.goto("/my/activities");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 页")).toBeVisible();
  await page.addInitScript(() => {
    if (sessionStorage.getItem("nav-corrupted")) return;
    sessionStorage.setItem("nav-corrupted", "true");
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith("hb-navigation-v1:")) continue;
      const snapshot = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      if (snapshot.path !== "/my/activities") continue;
      snapshot.values["authored-pager:"] = "broken";
      sessionStorage.setItem(key, JSON.stringify(snapshot));
    }
  });
  await page.reload();
  await expect(page.getByText("第 1 页")).toBeVisible();
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("第 2 页")).toBeVisible();
  await page.route("**/api/me/activities?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor"))
      return route.fulfill({
        status: 400,
        json: { error: { code: "INVALID_CURSOR", message: "分页位置已失效" } },
      });
    return route.fallback();
  });
  await page.reload();
  await expect(page.getByText("第 1 页")).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "分页位置已失效，已返回第一页。" }),
  ).toBeVisible();
});

test("历史编辑配置直接打开表单，付款入口保留当前活动筛选", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/my/activities");
  const row = page.getByRole("row").filter({ hasText: "我发起的活动" }).first();
  await expect(
    row.getByRole("link", { name: "我发起的活动：付款记录", exact: true }),
  ).toHaveAttribute("href", "/my/payments?activityId=a-author");
  await row
    .getByRole("link", { name: "我发起的活动：编辑配置", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#activity-title")).toHaveValue("管理活动");
  expect(new URL(page.url()).pathname).toBe("/my/activities/a-author");
  expect(new URL(page.url()).searchParams.has("edit")).toBe(false);
});
