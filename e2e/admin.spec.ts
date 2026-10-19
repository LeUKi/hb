import { expect, type Page, test } from "@playwright/test";
import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminCursorList,
  AdminOverview,
  AdminPaymentDetailResponse,
  AdminPaymentListItem,
  AdminUserDetail,
  AdminUserListItem,
  AttemptRateLimitsResponse,
  MerchantPaymentDetail,
} from "../packages/contracts/src";
import {
  type MockUser,
  mockSession,
  openApp,
  shown,
  viewer,
} from "./support/app";

// 网站管理 (migration phase 4) against a mocked admin API: the overview's
// checks lead to filtered lists, filters reach the server, details read
// their own part, and 网站设置 keeps what was typed through a conflict.

const admin: MockUser = {
  ...viewer,
  id: "admin-e2e",
  username: "admin",
  displayName: "测试管理员",
  isAdmin: true,
};

const hour = 3_600_000;
const activityId = "aaaaaaaa-1111-4222-8333-444444444444";
const draftId = "aaaaaaaa-1111-4222-8333-555555555555";
const author = {
  id: "author-1",
  username: "linjian",
  displayName: "林间",
  avatarUrl: null,
};
const recipientId = "user-2";

/** Answers one admin path (with any query); records each query it got. */
async function answer(
  page: Page,
  path: string,
  body: (url: URL) => unknown,
  status = 200,
) {
  const seen: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname === `/api/admin/${path}`,
    (route) => {
      const url = new URL(route.request().url());
      seen.push(url.searchParams);
      return route.fulfill({ status, json: body(url) });
    },
  );
  return seen;
}

function list<T>(items: T[], total = items.length): AdminCursorList<T> {
  return { items, nextCursor: null, readAt: Date.now(), total };
}

function activity(
  id: string,
  title: string,
  extra: Partial<AdminActivityListItem> = {},
): AdminActivityListItem {
  const created = Date.now() - 2 * hour;
  const draft = extra.lifecycle === "draft";
  return {
    id,
    title,
    authorId: author.id,
    authorDisplayName: author.displayName,
    participationMode: "password",
    rewardType: "ldc",
    paymentMode: "real",
    lifecycle: "active",
    totalCount: 3,
    claimedCount: 1,
    registeredCount: 0,
    drawState: null,
    topicId: null,
    postNumber: 0,
    createdAt: created,
    openedAt: draft ? null : created,
    endedAt: null,
    archivedAt: null,
    summary: {
      id,
      title,
      rewardType: "ldc",
      participationMode: "password",
      forceDedicated: true,
      status: draft ? "draft" : "active",
      version: 2,
      createdAt: new Date(created).toISOString(),
      openedAt: draft ? null : new Date(created).toISOString(),
      deadlineAt: draft ? null : new Date(created + 24 * hour).toISOString(),
      topicUrl: null,
      totalCount: 3,
      claimedCount: draft ? 0 : 1,
      reward: {
        mode: "fixed",
        totalAmount: "0.30",
        unitAmount: "0.10",
        count: 3,
      },
    },
    author,
    ...extra,
  };
}

function activityDetail(item: AdminActivityListItem): AdminActivityDetail {
  return {
    ...item,
    updatedAt: item.createdAt,
    deadline: null,
    endReason: null,
    drawClosedAt: null,
    drawPublishedAt: null,
    passwordCount: 2,
    payments: { total: 1, pending: 0, confirmed: 1, attention: 0, unknown: 0 },
  };
}

function user(
  id: string,
  displayName: string,
  extra: Partial<AdminUserListItem> = {},
): AdminUserListItem {
  return {
    id,
    externalId: id === recipientId ? "1002" : "1001",
    username: id,
    displayName,
    avatarUrl: null,
    active: true,
    admin: false,
    createdAt: Date.now() - 48 * hour,
    lastLoginAt: Date.now() - hour,
    ...extra,
  };
}

function payment(
  extra: Partial<AdminPaymentListItem> = {},
): AdminPaymentListItem {
  return {
    id: "11111111-2222-4333-8444-555555555551",
    source: "claim",
    mode: "real",
    status: "waiting",
    reason: "credentials",
    unknownOutcome: false,
    amount: "0.10",
    businessNo: "hb_0123456789abcdef0123456789abcdef",
    externalOrderId: null,
    activityId,
    activityTitle: "周末红包",
    merchantId: "bbbbbbbb-1111-4222-8333-444444444444",
    merchantLabel: "默认商户",
    recipientId: "1002",
    recipientUsername: "xiaoman_old",
    currentRecipientUsername: "xiaoman",
    recipientDisplayName: "小满",
    recipientAvatarUrl: null,
    createdAt: Date.now() - 2 * hour,
    nextRunAt: Date.now() + hour,
    ...extra,
  };
}

function paymentDetail(): AdminPaymentDetailResponse {
  const item = payment();
  const created = new Date(item.createdAt).toISOString();
  const view: MerchantPaymentDetail = {
    id: item.id,
    mode: "real",
    status: "waiting",
    reason: "credentials",
    confirmedAt: null,
    amount: item.amount,
    businessNo: item.businessNo,
    externalOrderId: null,
    createdAt: created,
    nextRunAt: new Date(item.nextRunAt).toISOString(),
    source: "claim",
    claimId: "claim-1",
    activityId,
    acceptanceId: null,
    config: {
      originalClientId: "old_client_2025",
      effectiveClientId: "old_client_2025",
      credentialVersion: 1,
      identityCorrectionVersion: 0,
      canRepairCredentials: false,
    },
    identityCorrections: [],
    recipientProfile: {
      username: "xiaoman",
      displayName: "小满",
      avatarUrl: null,
    },
    recoveryPolicy: "claim_same_order_v1",
    firstSendAt: created,
    usernameCorrection: null,
    nextAction: "none",
    nextSendAt: null,
    nextQueryAt: null,
    sendBlockReason: null,
    orderObservedAt: null,
    orderEvidence: null,
    retryAuthorization: null,
    duplicateProbe: null,
    recipientId: item.recipientId,
    recipientUsername: item.recipientUsername,
    attemptCount: 1,
    reconciliationCount: 0,
    unknownOutcome: false,
    sendAcknowledgedAt: null,
    attempts: [
      {
        id: "attempt-1",
        operation: "send",
        purpose: "recovery",
        outcome: "rejected",
        reason: "credentials",
        httpStatus: 400,
        diagnosticSummary: null,
        recipientUsername: item.recipientUsername,
        credentialVersion: 1,
        startedAt: created,
        finishedAt: created,
      },
    ],
    nextAttemptsCursor: null,
  };
  return {
    draw: false,
    view,
    payment: {
      ...item,
      merchantClientId: "new_client_2026",
      claimId: "claim-1",
      acceptanceId: null,
      attemptCount: 1,
      reconciliationCount: 0,
      nextAction: "none",
      nextSendAt: null,
      nextQueryAt: null,
      sendBlockReason: null,
      orderObservedAt: null,
      orderEvidence: null,
      sendAcknowledgedAt: null,
      confirmedAt: null,
      attempts: [],
      nextAttemptsCursor: null,
    },
  };
}

/**
 * 网站设置's API, checked by version like the server: a save against an
 * older version gets a 409. `saveElsewhere` is another admin saving.
 */
async function mockRateLimits(page: Page) {
  const versions: AttemptRateLimitsResponse[] = [
    {
      config: {
        version: 2,
        homeIntervalSeconds: 5,
        activityIntervalSeconds: 2,
        updatedAt: Date.now() - hour,
        updatedByUserId: admin.id,
      },
      recentChanges: [
        {
          id: "change-2",
          actorUserId: admin.id,
          actorDisplayName: "测试管理员",
          previousVersion: 1,
          nextVersion: 2,
          previousHomeIntervalSeconds: 4,
          homeIntervalSeconds: 5,
          previousActivityIntervalSeconds: 2,
          activityIntervalSeconds: 2,
          createdAt: Date.now() - hour,
        },
      ],
    },
  ];
  const latest = () => versions.at(-1) as AttemptRateLimitsResponse;
  const save = (home: number, activity: number, by: string) =>
    versions.push({
      config: {
        version: latest().config.version + 1,
        homeIntervalSeconds: home,
        activityIntervalSeconds: activity,
        updatedAt: Date.now(),
        updatedByUserId: by,
      },
      recentChanges: latest().recentChanges,
    });
  const sent: {
    expectedVersion: number;
    homeIntervalSeconds: number;
    activityIntervalSeconds: number;
  }[] = [];
  let reads = 0;
  await page.route(
    (url) => url.pathname === "/api/admin/rate-limits",
    (route) => {
      if (route.request().method() !== "PATCH") {
        reads += 1;
        return route.fulfill({ json: latest() });
      }
      const body = route.request().postDataJSON() as (typeof sent)[number];
      sent.push(body);
      if (body.expectedVersion !== latest().config.version)
        return route.fulfill({
          status: 409,
          json: { error: { code: "RATE_LIMIT_CONFIG_CONFLICT", message: "" } },
        });
      save(body.homeIntervalSeconds, body.activityIntervalSeconds, admin.id);
      return route.fulfill({ json: latest() });
    },
  );
  return {
    sent,
    reads: () => reads,
    saveElsewhere: (home: number, activity: number) =>
      save(home, activity, "admin-other"),
  };
}

test.describe("网站管理", () => {
  test.beforeEach(async ({ page }) => {
    // 🐟额's reads (a user's detail, 网站设置): nothing set up yet.
    await page.route(
      (url) => url.pathname.startsWith("/api/admin/balance/"),
      (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/admin/balance/settings")
          return route.fulfill({
            json: {
              settings: {
                version: 1,
                topupEnabled: false,
                withdrawEnabled: false,
                topupFeePercent: 12,
                withdrawFeePercent: 12,
                withdrawMaxMinor: 100_000,
                allowlistEnabled: true,
                allowlist: [],
                updatedAt: Date.now() - hour,
              },
              recentChanges: [],
              platformApp: null,
            },
          });
        if (path.startsWith("/api/admin/balance/users/"))
          return route.fulfill({
            json: {
              account: { availableMinor: 0, lockedMinor: 0 },
              items: [],
              nextCursor: null,
            },
          });
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "未找到" } },
        });
      },
    );
  });

  test("概览：八项检查（含🐟额两项），不为零的能打开筛好的列表", async ({
    page,
  }) => {
    await mockSession(page, admin);
    const now = Date.now();
    const overview: AdminOverview = {
      readAt: now,
      counts: {
        users: 12,
        activities: 30,
        drafts: 4,
        payments: { total: 40, unconfirmed: 3 },
      },
      runtime: {
        environment: "production",
        realPayments: { allowed: false, blockers: ["LDC_STOP_SENDS"] },
        realActivityOpening: { allowed: true, blockers: [] },
        realClaims: { allowed: true, blockers: [] },
        timedDraw: { allowed: true, blockers: [] },
      },
      paymentQueue: { backlog: "未接入", note: "" },
      warnings: {
        stalePayments: 0,
        unknownPayments: 2,
        attentionPayments: 1,
        drawBacklog: 0,
        undeliveredPaymentTasks: 0,
        undeliveredPaymentTasksOverdue: 0,
        staleMaintenance: 1,
        balanceTopups: 0,
        balanceWithdrawals: 2,
      },
      paymentsByMode: [
        { mode: "real", status: "attention", count: 1, oldestAgeSeconds: 7200 },
      ],
      maintenance: [
        {
          job: "payments",
          scheduledAt: now - 60_000,
          startedAt: now - 60_000,
          finishedAt: now - 58_000,
          status: "failed",
          reason: "job_failed",
          stale: true,
        },
      ],
    };
    await answer(page, "overview", () => overview);
    const payments = await answer(page, "payments", () => list([payment()]));
    await openApp(page, "/admin");
    await expect(
      page.getByText("4 项不为零，点开看具体是哪些。"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /要看一下的转入/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /卡住的转出/ }),
    ).toHaveAttribute("href", "/admin/balance");
    await expect(page.getByText("草稿 4 个")).toBeVisible();
    await expect(page.getByText("付款发送已暂停")).toBeVisible();
    await expect(page.getByText("最久等了 2 小时")).toBeVisible();
    await expect(page.getByText("失败", { exact: true })).toBeVisible();
    await expect(page.getByText(/执行出错/)).toBeVisible();
    // Zero is grey and not a link; a count to look at is.
    await expect(
      page.getByRole("link", { name: /付款等待超过一小时/ }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: /付款异常待处理/ }).click();
    await expect(page).toHaveURL(/\/admin\/payments\?state=attention$/);
    await expect
      .poll(() => payments.map((query) => query.get("status")))
      .toContain("attention");
  });

  test("红包：筛选写进地址并发给服务器，详情读口令个数和付款", async ({
    page,
  }) => {
    await mockSession(page, admin);
    const item = activity(activityId, "周末红包");
    const draft = activity(draftId, "草稿红包", {
      lifecycle: "draft",
      claimedCount: 0,
    });
    const queries = await answer(page, "activities", () => list([item, draft]));
    await answer(page, `activities/${activityId}`, () => ({
      activity: activityDetail(item),
    }));
    await answer(page, "payments", () => list([payment()]));
    await openApp(page, "/admin/activities");
    await expect(page.getByText("2 个", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /周末红包.*进行中/ }),
    ).toBeVisible();
    await expect(
      page.getByText("林间 · 参与 1 / 3", { exact: false }),
    ).toBeVisible();

    await page.getByRole("searchbox", { name: "搜索红包" }).fill("周末");
    await expect
      .poll(() => queries.map((query) => query.get("q")))
      .toContain("周末");
    await page
      .getByRole("group", { name: "状态" })
      .getByRole("button", { name: "草稿" })
      .click();
    await expect(page).toHaveURL(/\/admin\/activities\?status=draft$/);
    await expect.poll(() => queries.at(-1)?.get("status")).toBe("draft");
    await page.getByRole("button", { name: "开奖异常" }).click();
    await expect(page).toHaveURL(/anomaly=draw/);
    await expect.poll(() => queries.at(-1)?.get("drawException")).toBe("1");

    await page.getByRole("button", { name: /周末红包/ }).click();
    const pane = page.getByRole("complementary", { name: "详情" });
    await expect(pane.getByText("口令 2 个 · 统计尝试")).toBeVisible();
    await expect(
      pane.getByText("1 笔 · 未确认 0 · 异常待处理 0"),
    ).toBeVisible();
    await pane.getByRole("button", { name: "看它的付款" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/payments\\?activity=${activityId}$`),
    );
    await expect(page.getByText("红包：周末红包")).toBeVisible();
  });

  test("用户：管理员和停用标签，详情计数，去收到的付款", async ({ page }) => {
    await mockSession(page, admin);
    const xiaoman = user(recipientId, "小满", { active: false });
    const queries = await answer(page, "users", () =>
      list([user("admin-1", "站长", { admin: true }), xiaoman]),
    );
    await answer(page, `users/${recipientId}`, () => ({
      user: {
        ...xiaoman,
        counts: {
          authoredActivities: 0,
          claims: 3,
          registrations: 1,
          merchants: 0,
          paymentTasks: 2,
        },
      } satisfies AdminUserDetail,
    }));
    const payments = await answer(page, "payments", () => list([payment()]));
    // 停用 in the address is the API's disabled.
    await openApp(page, "/admin/users?status=inactive");
    await expect
      .poll(() => queries.map((query) => query.get("state")))
      .toContain("disabled");
    await expect(shown(page, "管理员")).toBeVisible();
    await page.getByRole("button", { name: /小满/ }).click();
    const pane = page.getByRole("complementary", { name: "详情" });
    await expect(pane.getByText("停用（LINUX DO 账号已停用）")).toBeVisible();
    await expect(pane.getByText("领取 3 次 · 报名 1 次")).toBeVisible();
    await expect(pane.getByText("2 笔")).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "查看发出的红包" }),
    ).toHaveCount(0);
    await pane.getByRole("button", { name: "查看收到的付款" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/payments\\?recipient=${recipientId}$`),
    );
    await expect
      .poll(() => payments.map((query) => query.get("recipientUserId")))
      .toContain(recipientId);
    await expect(page.getByText("收款人：小满")).toBeVisible();
  });

  test("付款详情：作者看到的说明、经过和带 HTTP 状态的处理记录", async ({
    page,
  }) => {
    await mockSession(page, admin);
    await answer(page, "payments", () => list([payment()]));
    await answer(page, `payments/${payment().id}`, () => paymentDetail());
    await openApp(page, "/admin/payments");
    await page.getByRole("button", { name: /小满/ }).click();
    const pane = page.getByRole("complementary", { name: "详情" });
    await expect(
      pane.getByText("要等发红包的人更新商户密钥，检查通过后继续。"),
    ).toBeVisible();
    await expect(
      pane.getByText("默认商户 · old_client_2025（更换前的应用）"),
    ).toBeVisible();
    await expect(
      pane.getByText("@xiaoman_old（现在是 @xiaoman）"),
    ).toBeVisible();
    await expect(pane.getByText("尚未观察到订单")).toBeVisible();
    await expect(
      pane.getByText("商户凭证失效，等待作者更新。 · HTTP 400"),
    ).toBeVisible();
  });

  test("网站设置：别人先存了，改过的那一项保留，其余跟着新版本", async ({
    page,
  }) => {
    await mockSession(page, admin);
    const settings = await mockRateLimits(page);
    await answer(page, "audit", () => list([]));
    await openApp(page, "/admin/settings");
    await expect(
      page.getByText(/第 2 版 · .* 由 测试管理员 修改/),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "起始页" }).fill("8");
    // Another admin saves version 3 just before.
    settings.saveElsewhere(5, 3);
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(
      page.getByText(
        "保存失败：设置刚被另一位管理员改成第 3 版（起始页 5 秒、红包页 3 秒）。你的输入还在，确认后再保存一次。",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "起始页" })).toHaveValue(
      "8",
    );
    await expect(page.getByRole("textbox", { name: "红包页" })).toHaveValue(
      "3",
    );
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(shown(page, "已保存，立即生效")).toBeVisible();
    expect(settings.sent[1]).toEqual({
      expectedVersion: 3,
      homeIntervalSeconds: 8,
      activityIntervalSeconds: 3,
    });
    await expect(page.getByText(/^第 4 版/)).toBeVisible();
  });

  test("网站设置：输入后切走再回来，读到的新版本不会被悄悄盖掉", async ({
    page,
  }) => {
    await mockSession(page, admin);
    const settings = await mockRateLimits(page);
    await openApp(page, "/admin/settings");
    await page.getByRole("textbox", { name: "起始页" }).fill("8");
    // Meanwhile another admin saves; coming back to the window reads it.
    settings.saveElsewhere(10, 2);
    const reads = settings.reads();
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
    );
    await expect.poll(() => settings.reads()).toBeGreaterThan(reads);
    await page.getByRole("button", { name: "保存设置" }).click();
    // Checked against the version the typing started from: a conflict.
    await expect(
      page.getByText(/^保存失败：设置刚被另一位管理员改成第 3 版/),
    ).toBeVisible();
    expect(settings.sent[0]).toMatchObject({ expectedVersion: 2 });
    await expect(page.getByRole("textbox", { name: "起始页" })).toHaveValue(
      "8",
    );
  });

  test("地址里的编号不完整：标签写编号无效，不参与筛选", async ({ page }) => {
    await mockSession(page, admin);
    const queries = await answer(page, "payments", () => list([payment()]));
    await openApp(page, "/admin/payments?activity=aaaa-bbbb");
    await expect(page.getByText("红包：编号无效")).toBeVisible();
    await expect(page.getByRole("button", { name: /小满/ })).toBeVisible();
    expect(queries.every((query) => !query.has("activityId"))).toBe(true);
  });

  test("下一批没读到：列表末尾可重试，不当作刷新失败", async ({ page }) => {
    await mockSession(page, admin);
    await page.route(
      (url) => url.pathname === "/api/admin/users",
      (route) =>
        new URL(route.request().url()).searchParams.has("cursor")
          ? route.fulfill({ status: 500, json: { error: {} } })
          : route.fulfill({
              json: {
                ...list(
                  [user("admin-1", "站长"), user(recipientId, "小满")],
                  3,
                ),
                nextCursor: `${Date.now()}:${recipientId}`,
              },
            }),
    );
    await openApp(page, "/admin/users");
    await expect(
      page.getByText("后续记录读取失败，可重试加载。"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "重试加载" })).toBeVisible();
    await expect(page.getByText("刷新失败，当前内容已保留。")).toHaveCount(0);
  });
});
