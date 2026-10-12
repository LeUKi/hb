import { expect, type Page, test } from "@playwright/test";
import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminAuditEntry,
  AdminPaymentDetail,
  AdminPaymentListItem,
  AdminUserDetail,
  AdminUserListItem,
} from "../packages/contracts/src";

const baseTime = new Date("2026-10-12T08:00:00Z").getTime();
const activityLifecycle = ["draft", "active", "ended", "archived"] as const;
const paymentStatuses = [
  "pending",
  "sending",
  "waiting",
  "confirmed",
  "attention",
] as const;

function pickActivityLifecycle(index: number) {
  return activityLifecycle[index % activityLifecycle.length] ?? "draft";
}

function pickPaymentStatus(index: number) {
  return paymentStatuses[index % paymentStatuses.length] ?? "pending";
}

type ListKind = "activities" | "users" | "payments" | "audit";
type DetailKind = "activityDetail" | "userDetail" | "paymentDetail";

function activity(
  index: number,
  overrides: Partial<AdminActivityListItem> = {},
) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    title: `活动 ${index}`,
    authorId: `author-${index % 3}`,
    authorDisplayName: `作者 ${index % 3}`,
    participationMode: index % 2 ? "password" : "direct",
    rewardType: "ldc",
    paymentMode: "simulation",
    lifecycle: pickActivityLifecycle(index),
    totalCount: 30,
    claimedCount: index,
    registeredCount: index + 1,
    drawState: index % 5 ? null : "overdue",
    topicId: String(9000 + index),
    postNumber: index + 1,
    createdAt: baseTime - Math.floor(index / 3) * 1000,
    openedAt: null,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } satisfies AdminActivityListItem;
}

function user(index: number, overrides: Partial<AdminUserListItem> = {}) {
  return {
    id: `user-${index}`,
    externalId: `linux-${1000 + index}`,
    username: `user_${index}`,
    displayName: `用户 ${index}`,
    avatarUrl: null,
    accountTier: index % 2 ? "standard" : "lite",
    active: index % 4 !== 0,
    officialConnectVerified: index % 2 === 1,
    createdAt: baseTime - Math.floor(index / 3) * 1000,
    lastLoginAt: index % 3 ? baseTime - index * 5000 : null,
    ...overrides,
  } satisfies AdminUserListItem;
}

function payment(index: number, overrides: Partial<AdminPaymentListItem> = {}) {
  return {
    id: `pay-${index}`,
    source: index % 2 ? "claim" : "acceptance",
    mode: index % 2 ? "real" : "simulation",
    status: pickPaymentStatus(index),
    reason: index % 5 === 4 ? "manual_attention_required" : null,
    unknownOutcome: index % 6 === 0,
    amount: `${index}.50`,
    businessNo:
      index === 2
        ? "BIZ-LONG-ORDER-20261012-0000000000000000000000002"
        : `BIZ-${String(index).padStart(4, "0")}`,
    externalOrderId: index % 2 ? `EXT-${index}` : null,
    activityId: activity(index).id,
    activityTitle: `活动 ${index}`,
    merchantId: `00000000-0000-4000-9000-${String(index % 3).padStart(12, "0")}`,
    merchantLabel: `商户 ${index % 3}`,
    recipientId: `linux-${1000 + index}`,
    recipientUsername: `order_user_${index}`,
    currentRecipientUsername: `current_user_${index}`,
    createdAt: baseTime - Math.floor(index / 3) * 1000,
    nextRunAt: baseTime + index * 1000,
    ...overrides,
  } satisfies AdminPaymentListItem;
}

function audit(index: number, overrides: Partial<AdminAuditEntry> = {}) {
  return {
    id: `audit-${index}`,
    type: index % 2 ? "login_settings" : "attempt_rate_limits",
    actorUserId: `admin-${index % 2}`,
    actorDisplayName: `管理员 ${index % 2}`,
    createdAt: baseTime - Math.floor(index / 3) * 1000,
    previousVersion: index,
    nextVersion: index + 1,
    before: index % 2 ? { liteauthEnabled: true } : { homeIntervalSeconds: 60 },
    after: index % 2 ? { liteauthEnabled: false } : { homeIntervalSeconds: 30 },
    ...overrides,
  } satisfies AdminAuditEntry;
}

const allActivities = Array.from({ length: 23 }, (_, index) =>
  activity(index + 1),
);
const allUsers = Array.from({ length: 23 }, (_, index) => user(index + 1));
const allPayments = Array.from({ length: 23 }, (_, index) =>
  payment(index + 1),
);
const allAudit = Array.from({ length: 23 }, (_, index) => audit(index + 1));

async function mockAdmin(page: Page) {
  const state = {
    session: {
      user: {
        id: "admin-user",
        username: "admin",
        displayName: "管理员",
        avatarUrl: null,
        accountTier: "standard",
        loginProvider: "connect",
        canUseLdc: true,
        isAdmin: true,
      },
      csrfToken: "csrf-a",
      attemptCooldown: null,
      loginOptions: { liteauthEnabled: true },
    },
    reads: [] as { kind: ListKind; query: Record<string, string> }[],
    failNext: new Set<ListKind | DetailKind>(),
    sessionReads: 0,
    activityDetailReads: new Map<string, number>(),
    userDetailReads: new Map<string, number>(),
    delayFirstUsersList: false,
    delayedUsersRelease: null as null | (() => void),
    delayedUsersStarted: 0,
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/session") {
      state.sessionReads += 1;
      return route.fulfill({ json: state.session });
    }
    if (path === "/api/admin/overview")
      return route.fulfill({
        json: {
          readAt: Date.now(),
          counts: {
            users: 23,
            activities: 23,
            payments: { total: 23, unconfirmed: 4 },
          },
          runtime: {
            environment: "local",
            realPayments: { allowed: false, blockers: ["APP_ENV"] },
            realActivityOpening: { allowed: false, blockers: ["APP_ENV"] },
            timedDraw: { allowed: true, blockers: [] },
          },
          paymentQueue: { backlog: "未接入", note: "未接入" },
          warnings: {
            stalePayments: 0,
            unknownPayments: 0,
            attentionPayments: 0,
            drawBacklog: 0,
            undeliveredPaymentTasks: 0,
            undeliveredPaymentTasksOverdue: 0,
            staleMaintenance: 0,
          },
          paymentsByMode: [],
          maintenance: [],
        },
      });
    if (path === "/api/admin/login-settings")
      return route.fulfill({
        json: {
          config: {
            version: 1,
            liteauthEnabled: true,
            updatedAt: baseTime,
            updatedByUserId: "admin-user",
          },
          recentChanges: [],
        },
      });
    if (path === "/api/admin/rate-limits")
      return route.fulfill({
        json: {
          config: {
            version: 1,
            homeIntervalSeconds: 60,
            activityIntervalSeconds: 60,
            updatedAt: baseTime,
            updatedByUserId: "admin-user",
          },
          recentChanges: [],
        },
      });

    const query = Object.fromEntries(url.searchParams.entries());
    if (path === "/api/admin/activities") {
      state.reads.push({ kind: "activities", query });
      if (state.failNext.delete("activities")) return fail(route);
      return list(route, filterActivities(query), query.cursor);
    }
    if (path.startsWith("/api/admin/activities/")) {
      if (state.failNext.delete("activityDetail")) return fail(route);
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      const item = allActivities.find((candidate) => candidate.id === id);
      if (!item) return notFound(route);
      const reads = (state.activityDetailReads.get(id) ?? 0) + 1;
      state.activityDetailReads.set(id, reads);
      return route.fulfill({
        json: {
          activity: {
            ...item,
            title: reads > 1 ? `${item.title}（已刷新）` : item.title,
            updatedAt: baseTime,
            deadline: null,
            endReason: null,
            drawClosedAt: null,
            drawPublishedAt: null,
            payments: {
              total: 5,
              pending: 2,
              confirmed: 2,
              attention: 1,
              unknown: 0,
            },
          } satisfies AdminActivityDetail,
        },
      });
    }
    if (path === "/api/admin/users") {
      state.reads.push({ kind: "users", query });
      if (state.failNext.delete("users")) return fail(route);
      if (state.delayFirstUsersList && state.delayedUsersStarted === 0) {
        state.delayedUsersStarted += 1;
        const capturedCsrf = state.session.csrfToken;
        await new Promise<void>((resolve) => {
          state.delayedUsersRelease = resolve;
        });
        return list(
          route,
          [
            user(98, {
              displayName: `迟到用户 ${capturedCsrf}`,
              username: "late_user",
            }),
          ],
          query.cursor,
        );
      }
      const visible =
        state.session.csrfToken === "csrf-b"
          ? [user(99, { displayName: "新会话用户", username: "fresh_user" })]
          : filterUsers(query);
      return list(route, visible, query.cursor);
    }
    if (path.startsWith("/api/admin/users/")) {
      if (state.failNext.delete("userDetail")) return fail(route);
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      const item =
        allUsers.find((candidate) => candidate.id === id) ?? user(99);
      const reads = (state.userDetailReads.get(id) ?? 0) + 1;
      state.userDetailReads.set(id, reads);
      return route.fulfill({
        json: {
          user: {
            ...item,
            displayName:
              reads > 1 ? `${item.displayName}（已刷新）` : item.displayName,
            counts: {
              authoredActivities: 3,
              claims: 4,
              registrations: 5,
              merchants: 2,
              paymentTasks: 6,
            },
          } satisfies AdminUserDetail,
        },
      });
    }
    if (path === "/api/admin/payments") {
      state.reads.push({ kind: "payments", query });
      if (state.failNext.delete("payments")) return fail(route);
      return list(route, filterPayments(query), query.cursor);
    }
    if (path.startsWith("/api/admin/payments/")) {
      if (state.failNext.delete("paymentDetail")) return fail(route);
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      const item = allPayments.find((candidate) => candidate.id === id);
      if (!item) return notFound(route);
      const pageTwo = query.attemptsCursor === "attempt:2";
      return route.fulfill({
        json: {
          payment: {
            ...item,
            claimId: "claim-1",
            acceptanceId: null,
            attemptCount: 23,
            reconciliationCount: 7,
            nextAction: "query",
            nextSendAt: null,
            nextQueryAt: baseTime + 600_000,
            sendBlockReason: "rate_limit",
            orderObservedAt: baseTime,
            orderEvidence: "query",
            sendAcknowledgedAt: null,
            confirmedAt: null,
            attempts: Array.from({ length: pageTwo ? 3 : 20 }, (_, index) => ({
              id: `attempt-${pageTwo ? index + 21 : index + 1}`,
              operation: index % 2 ? "query" : "send",
              purpose: index % 2 ? "probe" : "recovery",
              outcome: pageTwo ? "unknown" : "succeeded",
              reason: pageTwo ? "query_unavailable" : null,
              httpStatus: 200,
              credentialVersion: 2,
              startedAt: baseTime - index * 1000,
              finishedAt: baseTime - index * 500,
            })),
            nextAttemptsCursor: pageTwo ? null : "attempt:2",
          } satisfies AdminPaymentDetail,
        },
      });
    }
    if (path === "/api/admin/audit") {
      state.reads.push({ kind: "audit", query });
      if (state.failNext.delete("audit")) return fail(route);
      return list(route, filterAudit(query), query.cursor);
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  return state;
}

function filterActivities(query: Record<string, string>) {
  return allActivities.filter((item) => {
    if (
      query.q &&
      !`${item.title} ${item.id} ${item.topicId}`.includes(query.q)
    )
      return false;
    if (
      query.status &&
      query.status !== "all" &&
      item.lifecycle !== query.status
    )
      return false;
    if (
      query.rewardType &&
      query.rewardType !== "all" &&
      item.rewardType !== query.rewardType
    )
      return false;
    if (query.drawException === "1" && !item.drawState) return false;
    if (query.authorId && item.authorId !== query.authorId) return false;
    return true;
  });
}

function filterUsers(query: Record<string, string>) {
  return allUsers.filter((item) => {
    if (
      query.q &&
      !`${item.username} ${item.displayName} ${item.externalId} ${item.id}`.includes(
        query.q,
      )
    )
      return false;
    if (query.tier && query.tier !== "all" && item.accountTier !== query.tier)
      return false;
    if (query.state === "active" && !item.active) return false;
    if (query.state === "disabled" && item.active) return false;
    return true;
  });
}

function filterPayments(query: Record<string, string>) {
  return allPayments.filter((item) => {
    if (
      query.q &&
      ![item.id, item.businessNo, item.externalOrderId].some((value) =>
        value?.includes(query.q ?? ""),
      )
    )
      return false;
    if (query.mode && query.mode !== "all" && item.mode !== query.mode)
      return false;
    if (query.status && query.status !== "all" && item.status !== query.status)
      return false;
    if (query.activityId && item.activityId !== query.activityId) return false;
    if (query.merchantId && item.merchantId !== query.merchantId) return false;
    if (query.recipientId && item.recipientId !== query.recipientId)
      return false;
    if (query.anomaly === "unknown" && !item.unknownOutcome) return false;
    if (query.anomaly === "attention" && item.status !== "attention")
      return false;
    if (
      query.exception === "1" &&
      !item.unknownOutcome &&
      item.status !== "attention"
    )
      return false;
    return true;
  });
}

function filterAudit(query: Record<string, string>) {
  return allAudit.filter((item) => {
    if (query.type && query.type !== "all" && item.type !== query.type)
      return false;
    if (
      query.actor &&
      !`${item.actorUserId} ${item.actorDisplayName}`.includes(query.actor)
    )
      return false;
    if (query.from && item.createdAt < Number(query.from)) return false;
    if (query.to && item.createdAt > Number(query.to)) return false;
    return true;
  });
}

async function list<T>(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  items: T[],
  cursor: string | undefined,
) {
  const offset = cursor ? Number(cursor.split(":", 1)[0]) : 0;
  const page = items.slice(offset, offset + 20);
  const nextOffset = offset + 20;
  await route.fulfill({
    json: {
      items: page,
      nextCursor: nextOffset < items.length ? `${nextOffset}:next` : null,
      readAt: Date.now(),
    },
  });
}

async function fail(route: Parameters<Parameters<Page["route"]>[1]>[0]) {
  await route.fulfill({
    status: 503,
    json: { error: { code: "UNAVAILABLE", message: "读取失败，请重试。" } },
  });
}

async function notFound(route: Parameters<Parameters<Page["route"]>[1]>[0]) {
  await route.fulfill({
    status: 404,
    json: { error: { code: "NOT_FOUND", message: "未找到" } },
  });
}

async function expectDocumentFitsViewport(page: Page, label: string) {
  const metrics = await page.evaluate(() => ({
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(
    Math.max(metrics.html, metrics.body),
    `${label} document should not overflow horizontally`,
  ).toBeLessThanOrEqual(metrics.viewport + 1);
}

async function expectScrollContainersStayInsideViewport(
  page: Page,
  label: string,
) {
  const containers = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        ".admin-table-wrap, .admin-table-scroll",
      ),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    }),
  );
  for (const [index, container] of containers.entries()) {
    const viewportWidth = (await page.viewportSize())?.width ?? 0;
    expect(
      container.left,
      `${label} table container ${index} should start inside viewport`,
    ).toBeGreaterThanOrEqual(-1);
    expect(
      container.right,
      `${label} table container ${index} should end inside viewport`,
    ).toBeLessThanOrEqual(viewportWidth + 1);
    expect(
      container.scrollWidth,
      `${label} table container ${index} should own table overflow`,
    ).toBeGreaterThanOrEqual(container.clientWidth);
  }
}

async function applyFontScale(page: Page, fontScale: string) {
  await page.addStyleTag({
    content: `html { font-size: ${fontScale} !important; }`,
  });
}

test("管理员六个入口在桌面和窄屏放大文字下不横溢，长筛选与日期标签可见", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await mockAdmin(page);
  const routes = [
    { path: "/admin", heading: "概览" },
    { path: "/admin/activities", heading: "活动" },
    { path: "/admin/users", heading: "用户" },
    { path: "/admin/payments", heading: "付款" },
    { path: "/admin/settings", heading: "登录方式" },
    { path: "/admin/audit", heading: "操作记录" },
  ];

  for (const viewport of [
    { width: 1440, height: 900, fontScale: "100%" },
    { width: 375, height: 812, fontScale: "200%" },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const route of routes) {
      await page.goto(route.path);
      await applyFontScale(page, viewport.fontScale);
      await expect(
        page.getByRole("heading", { name: "网站管理" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: route.heading }).first(),
      ).toBeVisible();
      await expectDocumentFitsViewport(
        page,
        `${route.path} ${viewport.width}px ${viewport.fontScale}`,
      );
      await expectScrollContainersStayInsideViewport(
        page,
        `${route.path} ${viewport.width}px ${viewport.fontScale}`,
      );
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (!active || active === document.body) return false;
          const rect = active.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.left < innerWidth;
        }),
        `${route.path} should expose a visible focus target`,
      ).toBe(true);
    }

    await page.goto("/admin/activities");
    await applyFontScale(page, viewport.fontScale);
    await page
      .getByLabel("搜索活动")
      .fill(
        "https://linux.do/t/topic/123456789012345678901234567890/987654321",
      );
    await expect(page.getByLabel("搜索活动")).toBeVisible();
    await expectDocumentFitsViewport(
      page,
      `activities long filter ${viewport.width}px ${viewport.fontScale}`,
    );

    await page.goto("/admin/payments");
    await applyFontScale(page, viewport.fontScale);
    await page
      .getByLabel("搜索付款")
      .fill("BIZ-LONG-ORDER-20261012-0000000000000000000000002");
    await page
      .getByLabel("活动 ID")
      .fill("00000000-0000-4000-8000-000000000002");
    await page
      .getByLabel("商户 ID")
      .fill("00000000-0000-4000-9000-000000000002");
    await page.getByLabel("收款人 ID").fill("simulation:linux-1002");
    await expect(page.getByLabel("搜索付款")).toBeVisible();
    await expect(page.getByLabel("活动 ID")).toBeVisible();
    await expect(page.getByLabel("商户 ID")).toBeVisible();
    await expect(page.getByLabel("收款人 ID")).toBeVisible();
    await expectDocumentFitsViewport(
      page,
      `payments long filters ${viewport.width}px ${viewport.fontScale}`,
    );

    await page.goto("/admin/audit");
    await applyFontScale(page, viewport.fontScale);
    await expect(page.getByText("开始日期", { exact: true })).toBeVisible();
    await expect(page.getByText("结束日期", { exact: true })).toBeVisible();
    await page.getByLabel("开始日期").fill("2026-10-12");
    await page.getByLabel("结束日期").fill("2026-10-13");
    await expect(page.getByLabel("开始日期")).toBeVisible();
    await expect(page.getByLabel("结束日期")).toBeVisible();
    await expectDocumentFitsViewport(
      page,
      `audit date labels ${viewport.width}px ${viewport.fontScale}`,
    );
  }
});

test("活动列表保留筛选 URL、分页和刷新失败前的内容", async ({ page }) => {
  const state = await mockAdmin(page);
  await page.goto("/admin/activities");
  await expect(
    page.getByRole("link", { name: "活动 1", exact: true }),
  ).toBeVisible();

  await page.getByLabel("搜索活动").fill("活动 20");
  await page.getByLabel("生命周期").selectOption("draft");
  await page.getByLabel("开奖异常").check();
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/activities\?/);
  await expect(page).toHaveURL(/q=/);
  await expect(page).toHaveURL(/status=draft/);
  await expect.soft(page).toHaveURL(/drawException=1/);
  expect.soft(state.reads.at(-1)?.query).toMatchObject({
    q: "活动 20",
    status: "draft",
    drawException: "1",
  });
  await expect(
    page.getByRole("link", { name: "活动 20", exact: true }),
  ).toBeVisible();
  const activityOpener = page.getByRole("link", {
    name: "活动 20",
    exact: true,
  });
  await activityOpener.click();
  const activityPanel = page.getByRole("dialog", { name: "活动详情" });
  await expect(activityPanel).toBeVisible();
  await expect(
    activityPanel.getByRole("heading", { name: "活动 20" }),
  ).toBeVisible();
  await expect(activityPanel.getByText("总份数")).toBeVisible();
  await expect(activityPanel.getByText("报名人数")).toBeVisible();
  await activityPanel.getByRole("button", { name: "刷新" }).click();
  await expect(
    activityPanel.getByRole("heading", { name: "活动 20（已刷新）" }),
  ).toBeVisible();
  state.failNext.add("activityDetail");
  await activityPanel.getByRole("button", { name: "刷新" }).click();
  await expect(activityPanel.getByRole("alert")).toContainText("读取失败");
  await expect(
    activityPanel.getByRole("heading", { name: "活动 20（已刷新）" }),
  ).toBeVisible();
  await activityPanel.getByRole("button", { name: "关闭" }).click();
  await expect(activityOpener).toBeFocused();

  await page.getByLabel("搜索活动").fill("");
  await page.getByLabel("生命周期").selectOption("all");
  await page.getByLabel("开奖异常").uncheck();
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=20%3Anext|cursor=20:next/);
  await expect(
    page.getByRole("link", { name: "活动 21", exact: true }),
  ).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/cursor=/);
  await page.goForward();
  await expect(
    page.getByRole("link", { name: "活动 21", exact: true }),
  ).toBeVisible();

  state.failNext.add("activities");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("读取失败");
  await expect(page.getByRole("alert")).toContainText("上次读取");
  await expect(
    page.getByRole("link", { name: "活动 21", exact: true }),
  ).toBeVisible();
});

test("用户详情在桌面侧栏展示，关闭后回焦搜索入口，详情链接带入筛选", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockAdmin(page);
  await page.goto("/admin/users?detail=user-3");

  const panel = page.getByRole("dialog", { name: "用户详情" });
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(panel.getByRole("heading", { name: "用户 3" })).toBeVisible();
  await expect(panel.getByText("永久账号资格")).toBeVisible();
  await expect(panel.getByText("已获得")).toBeVisible();
  await expect(panel.getByText("账号状态")).toBeVisible();
  await expect(panel.getByText("可用")).toBeVisible();
  await expect(panel.getByText("注册时间")).toBeVisible();
  await expect(panel.getByText("最近登录")).toBeVisible();
  await panel.getByRole("button", { name: "刷新" }).click();
  await expect(
    panel.getByRole("heading", { name: "用户 3（已刷新）" }),
  ).toBeVisible();
  state.failNext.add("userDetail");
  await panel.getByRole("button", { name: "刷新" }).click();
  await expect(panel.getByRole("alert")).toContainText("读取失败");
  await expect(panel.getByRole("alert")).toContainText("上次读取");
  await expect(
    panel.getByRole("heading", { name: "用户 3（已刷新）" }),
  ).toBeVisible();
  await panel.getByRole("link", { name: "筛选活动" }).click();
  await expect(page).toHaveURL(/\/admin\/activities\?authorId=user-3/);

  await page.goto("/admin/users?detail=user-4");
  await page
    .getByRole("dialog", { name: "用户详情" })
    .getByRole("button", { name: "关闭" })
    .click();
  await expect(page).not.toHaveURL(/detail=/);
  await expect(page.getByLabel("搜索用户")).toBeFocused();

  const userOpener = page.getByRole("link", { name: "用户 5", exact: true });
  await userOpener.click();
  const linkedPanel = page.getByRole("dialog", { name: "用户详情" });
  await expect(
    linkedPanel.getByRole("heading", { name: "用户 5" }),
  ).toBeVisible();
  await linkedPanel.getByRole("button", { name: "关闭" }).click();
  await expect(userOpener).toBeFocused();
  await userOpener.click();
  await page
    .getByRole("dialog", { name: "用户详情" })
    .getByRole("link", { name: "筛选付款" })
    .click();
  await expect(page).toHaveURL(/\/admin\/payments\?recipientId=linux-1005/);

  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "用户详情" }).getByRole("heading", {
      name: "用户 5",
    }),
  ).toBeVisible();
  state.failNext.add("users");
  await page
    .locator(".admin-list-panel")
    .getByRole("button", { name: "刷新", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("读取失败");
  await expect(page.getByRole("alert")).toContainText("上次读取");
  await expect(
    page.getByRole("link", { name: "用户 5", exact: true }),
  ).toBeVisible();
});

test("付款列表支持关联筛选、详情刷新失败保留内容并分页读取尝试记录", async ({
  page,
}) => {
  const state = await mockAdmin(page);
  const target = allPayments.find((item) => item.id === "pay-3");
  if (!target) throw new Error("Missing payment fixture");
  await page.goto("/admin/payments");

  await page.getByLabel("搜索付款").fill(target.businessNo);
  await page.getByLabel("活动 ID").fill(target.activityId ?? "");
  await page.getByLabel("商户 ID").fill(target.merchantId);
  await page.getByLabel("收款人 ID").fill(target.recipientId);
  await page.getByLabel("付款模式").selectOption(target.mode);
  await page.getByLabel("付款状态").selectOption(target.status);
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/payments\?/);
  expect(state.reads.at(-1)?.query).toMatchObject({
    q: target.businessNo,
    activityId: target.activityId ?? "",
    merchantId: target.merchantId,
    recipientId: target.recipientId,
    mode: target.mode,
    status: target.status,
  });
  await expect(
    page.getByRole("link", { name: target.businessNo }),
  ).toBeVisible();

  await page.getByRole("link", { name: target.businessNo }).click();
  const panel = page.getByRole("dialog", { name: "付款详情" });
  await expect(
    panel.getByText(target.externalOrderId ?? "", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByText(/已收到有效响应/)).toHaveCount(20);
  const nextAttempts = panel.getByRole("button", { name: "下一页尝试记录" });
  await expect(nextAttempts).toBeVisible();
  await nextAttempts.click();
  await expect(panel.getByText(/结果尚未明确/)).toHaveCount(3);
  await expect(page).toHaveURL(/attemptsCursor=attempt/);

  state.failNext.add("paymentDetail");
  await panel.getByRole("button", { name: "刷新详情" }).click();
  await expect(panel.getByRole("alert")).toContainText("读取失败");
  await expect(panel.getByText(/结果尚未明确/)).toHaveCount(3);
  await panel.getByRole("button", { name: "刷新详情" }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);

  state.failNext.add("payments");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("读取失败");
  await expect(
    page.getByRole("link", { name: target.businessNo }),
  ).toBeVisible();
});

test("操作记录保留类型、操作者、日期筛选和游标分页", async ({ page }) => {
  const state = await mockAdmin(page);
  await page.goto("/admin/audit");

  await page.getByLabel("搜索操作者").fill("管理员 1");
  await page.getByLabel("开始日期").fill("2026-10-12");
  await page.getByLabel("结束日期").fill("2026-10-12");
  await page.getByLabel("记录类型").selectOption("login_settings");
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await expect(page).toHaveURL(/\/admin\/audit\?/);
  await expect(page).toHaveURL(/type=login_settings/);
  await expect(page).toHaveURL(/actor=/);
  expect(state.reads.at(-1)?.query).toMatchObject({
    type: "login_settings",
    actor: "管理员 1",
  });
  await expect(
    page.getByRole("cell", { name: "登录方式" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "管理员 1" }).first(),
  ).toBeVisible();

  await page.getByLabel("搜索操作者").fill("");
  await page.getByLabel("开始日期").fill("");
  await page.getByLabel("结束日期").fill("");
  await page.getByLabel("记录类型").selectOption("all");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=20%3Anext|cursor=20:next/);
  await expect(
    page.getByText("audit-21").or(page.getByText("21 → 22")),
  ).toBeVisible();
});

test.describe("操作记录本地日期恢复", () => {
  test.use({ timezoneId: "Asia/Shanghai" });

  test("上海时区搜索、刷新和历史导航不会让日期回退", async ({ page }) => {
    const state = await mockAdmin(page);
    await page.goto("/admin/audit");

    const firstRange = await page.evaluate(() => ({
      from: String(new Date("2026-10-12T00:00:00").getTime()),
      to: String(new Date("2026-10-12T23:59:59.999").getTime()),
    }));
    await page.getByLabel("搜索操作者").fill("管理员 1");
    await page.getByLabel("开始日期").fill("2026-10-12");
    await page.getByLabel("结束日期").fill("2026-10-12");
    await page.getByRole("button", { name: "搜索", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`from=${firstRange.from}`));
    await expect(page).toHaveURL(new RegExp(`to=${firstRange.to}`));
    expect(state.reads.at(-1)?.query).toMatchObject({
      actor: "管理员 1",
      from: firstRange.from,
      to: firstRange.to,
    });
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-12");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-12");

    await page.reload();
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-12");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-12");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-12");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-12");

    const secondRange = await page.evaluate(() => ({
      from: String(new Date("2026-10-13T00:00:00").getTime()),
      to: String(new Date("2026-10-13T23:59:59.999").getTime()),
    }));
    await page.getByLabel("开始日期").fill("2026-10-13");
    await page.getByLabel("结束日期").fill("2026-10-13");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`from=${secondRange.from}`));
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-13");

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`from=${firstRange.from}`));
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-12");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-12");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`from=${secondRange.from}`));
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-10-13");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-13");
  });
});

test("移动端详情使用原生 modal 并关闭回焦入口", async ({ page }) => {
  await mockAdmin(page);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const module of ["activities", "users", "payments", "audit"]) {
    await page.goto(`/admin/${module}`);
    await expect(page.getByRole("heading", { name: "网站管理" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${module} must fit the mobile viewport`,
    ).toBe(true);
  }
  await page.goto("/admin/payments");
  const firstPayment = allPayments.find((item) => item.id === "pay-2");
  if (!firstPayment) throw new Error("Missing payment fixture");
  const opener = page.getByRole("link", { name: firstPayment.businessNo });
  await opener.click();

  const dialog = page.locator('dialog:modal[aria-label="付款详情"]');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: firstPayment.businessNo }),
  ).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("同一账号 csrf 变化后迟到响应不会回填旧管理员列表", async ({ page }) => {
  const state = await mockAdmin(page);
  state.delayFirstUsersList = true;
  await page.goto("/admin/users");
  await expect.poll(() => state.delayedUsersStarted).toBe(1);

  state.session = { ...state.session, csrfToken: "csrf-b" };
  const sessionReads = state.sessionReads;
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await page.bringToFront();
  await other.close();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => state.sessionReads).toBeGreaterThan(sessionReads);
  await expect(
    page.getByRole("link", { name: "新会话用户", exact: true }),
  ).toBeVisible();

  state.delayedUsersRelease?.();
  await expect(
    page.getByRole("link", { name: "新会话用户", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("迟到用户 csrf-a")).toBeHidden();
});
