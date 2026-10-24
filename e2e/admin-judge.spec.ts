import { expect, type Page, test } from "@playwright/test";
import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminAuditEntry,
  AdminCursorList,
  AdminJudgeUsage,
  AdminUserDetail,
  AdminUserListItem,
  JudgeSettingChange,
  JudgeSettings,
  JudgeSettingsInput,
} from "../packages/contracts/src";
import {
  type MockUser,
  mockSession,
  openApp,
  shown,
  viewer,
} from "./support/app";

// 网站管理 · 判定器 (redesign/07 §10) against a mocked admin API: 用量's
// figures and its 30-day chart, 谁在用's rows opening their tab's detail,
// and 设置 keeping what was typed through a conflict, and there when 用量
// cannot be read.

const admin: MockUser = {
  ...viewer,
  id: "admin-e2e",
  username: "admin",
  displayName: "测试管理员",
  isAdmin: true,
};

const hour = 3_600_000;
const day = 24 * hour;
const activityId = "cccccccc-1111-4222-8333-444444444444";
const author = {
  id: "author-judge",
  username: "xiaoming",
  displayName: "小明",
  avatarUrl: null,
};

/** The UTC day of a time, as the server names it: 2026-10-25. */
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
/** "10月25日". */
const dayLabel = (at: number) => {
  const date = new Date(at);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
};

function usage(patch: Partial<AdminJudgeUsage> = {}): AdminJudgeUsage {
  const now = Date.now();
  const counts = (rows: number) => ({
    rows,
    deploys: 0,
    reruns: 0,
    claims: 0,
    timeouts: 0,
    switches: 0,
  });
  return {
    readAt: now,
    day: utcDay(now),
    month: utcDay(now).slice(0, 7),
    today: counts(3),
    // Past the free 1000: amber, and 24 × $0.002.
    thisMonth: {
      rows: 1024,
      deploys: 12,
      reruns: 5,
      claims: 340,
      timeouts: 2,
      switches: 1,
    },
    freeRows: 1000,
    pricePerRow: 0.002,
    estimatedCost: 0.048,
    monthlyLimit: 2000,
    // Yesterday had 7; the others a few or none.
    days: Array.from({ length: 30 }, (_, index) => ({
      day: utcDay(now - (29 - index) * day),
      rows: index === 28 ? 7 : index === 29 ? 3 : index % 3,
    })),
    people: [{ user: author, deploys: 4, rows: 6 }],
    hongbao: [
      {
        activity: {
          id: activityId,
          title: "猜数字",
          author,
          status: "active",
        },
        rows: 9,
        judgments: 120,
      },
    ],
    ...patch,
  };
}

/** Answers one admin path (with any query); records each query it got. */
async function answer(page: Page, path: string, body: () => unknown) {
  const seen: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname === `/api/admin/${path}`,
    (route) => {
      seen.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: body() });
    },
  );
  return seen;
}

function list<T>(items: T[]): AdminCursorList<T> {
  return { items, nextCursor: null, readAt: Date.now(), total: items.length };
}

function authorRow(): AdminUserListItem {
  return {
    id: author.id,
    externalId: "2001",
    username: author.username,
    displayName: author.displayName,
    avatarUrl: null,
    active: true,
    admin: false,
    createdAt: Date.now() - 48 * hour,
    lastLoginAt: Date.now() - hour,
    trustLevel: 2,
    silenced: false,
    profileSeenAt: Date.now() - hour,
    fish: { availableMinor: 5000, lockedMinor: 0 },
    plus: true,
  };
}

function codeActivity(): AdminActivityListItem {
  const created = Date.now() - 2 * hour;
  return {
    id: activityId,
    title: "猜数字",
    authorId: author.id,
    authorDisplayName: author.displayName,
    participationMode: "code",
    rewardType: "ldc",
    paymentMode: "real",
    lifecycle: "active",
    totalCount: 10,
    claimedCount: 2,
    registeredCount: 0,
    drawState: null,
    topicId: null,
    postNumber: 0,
    createdAt: created,
    openedAt: created,
    endedAt: null,
    archivedAt: null,
    summary: {
      id: activityId,
      title: "猜数字",
      rewardType: "ldc",
      participationMode: "code",
      funding: "balance",
      forceDedicated: true,
      status: "active",
      version: 2,
      createdAt: new Date(created).toISOString(),
      openedAt: new Date(created).toISOString(),
      deadlineAt: new Date(created + day).toISOString(),
      topicUrl: null,
      totalCount: 10,
      claimedCount: 2,
      reward: {
        mode: "code",
        totalAmount: "10.00",
        count: 10,
        minEach: "0.01",
      },
    },
    author,
  };
}

/**
 * 判定器设置's API, checked by version like the server: a save against an
 * older version gets a 409. `saveElsewhere` is the 站长 saving in another
 * window.
 */
async function mockSettings(page: Page) {
  const values: JudgeSettingsInput = {
    enabled: true,
    dailyOpenLimit: 3,
    dailyDeployLimit: 10,
    monthlyLimit: 1000,
  };
  let settings: JudgeSettings = {
    ...values,
    version: 2,
    updatedAt: Date.now() - hour,
  };
  const changes: JudgeSettingChange[] = [
    {
      id: "change-2",
      actorUserId: admin.id,
      actorDisplayName: admin.displayName,
      previousVersion: 1,
      nextVersion: 2,
      previous: { ...values, monthlyLimit: 500 },
      next: values,
      createdAt: Date.now() - hour,
    },
  ];
  const save = (next: JudgeSettingsInput, by: MockUser) => {
    changes.unshift({
      id: `change-${settings.version + 1}`,
      actorUserId: by.id,
      actorDisplayName: by.displayName,
      previousVersion: settings.version,
      nextVersion: settings.version + 1,
      previous: settings,
      next,
      createdAt: Date.now(),
    });
    settings = {
      ...next,
      version: settings.version + 1,
      updatedAt: Date.now(),
    };
  };
  const sent: (JudgeSettingsInput & { expectedVersion: number })[] = [];
  await page.route(
    (url) => url.pathname === "/api/admin/judge/settings",
    (route) => {
      if (route.request().method() !== "PUT")
        return route.fulfill({ json: { settings, recentChanges: changes } });
      const body = route.request().postDataJSON() as (typeof sent)[number];
      sent.push(body);
      if (body.expectedVersion !== settings.version)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "JUDGE_SETTINGS_CONFLICT",
              message: "判定器设置已经变了，请刷新后再试。当前输入已保留。",
            },
          },
        });
      const { expectedVersion: _, ...next } = body;
      save(next, admin);
      return route.fulfill({ json: { settings } });
    },
  );
  return {
    sent,
    saveElsewhere: (patch: Partial<JudgeSettingsInput>) =>
      save({ ...settings, ...patch }, admin),
  };
}

test.describe("网站管理 · 判定器", () => {
  test.beforeEach(async ({ page }) => {
    await mockSession(page, admin);
    await answer(page, "judge/usage", usage);
    // A user's 🐟额 in their detail: nothing to show.
    await page.route(
      (url) => url.pathname.startsWith("/api/admin/balance/users/"),
      (route) =>
        route.fulfill({
          json: {
            account: { availableMinor: 0, lockedMinor: 0 },
            member: null,
            apiKeys: [],
            invitedCount: 0,
            items: [],
            nextCursor: null,
          },
        }),
    );
  });

  test("用量：四个数、按用途分、30 天的柱状图和上限的虚线", async ({
    page,
  }) => {
    await mockSettings(page);
    await openApp(page, "/admin/judge");
    // Its tab sits between 🐟额 and 网站设置.
    const tabs = page.getByRole("navigation", { name: "管理入口" });
    await expect(tabs.getByRole("link")).toHaveText([
      "概览",
      "红包",
      "用户",
      "付款",
      "🐟额",
      "判定器",
      "网站设置",
      "操作记录",
    ]);
    await expect(page).toHaveTitle(/网站管理 · 判定器/);
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "用量" }) });
    const figures = section.locator("dl");
    await expect(figures).toContainText("今天3 份");
    await expect(figures).toContainText("本月1024 份免费 1000 份");
    await expect(figures).toContainText("本月估算费用约 $0.05");
    await expect(figures).toContainText("超出 24 份 × $0.002");
    await expect(figures).toContainText("本月上限2000 份");
    await expect(
      section.getByText(/^一个判定器在某个 UTC 日第一次被用到时记一份/),
    ).toBeVisible();
    await expect(
      section.getByText(
        "本月：部署新版本 12 次 · 重新跑测试 5 次 · 领取时判定 340 次 · 超时 2 次（其中换了 1 次实例）",
      ),
    ).toBeVisible();

    // 30 bars, each said to a screen reader; hovering one shows its day.
    const chart = section.getByRole("figure", { name: "最近 30 天，每天几份" });
    await expect(chart.getByRole("listitem")).toHaveCount(30);
    const yesterday = Date.now() - day;
    await expect(chart.getByRole("listitem").nth(28)).toHaveText(
      `${dayLabel(yesterday)} 7 份`,
    );
    await chart.locator(`[data-day="${utcDay(yesterday)}"]`).hover();
    await expect(shown(page, `${dayLabel(yesterday)} · 7 份`)).toBeVisible();
    // 2000 份 over this month's days.
    const now = new Date();
    const monthDays = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    await expect(
      chart.getByText(
        `虚线：本月上限 2000 份平均到每天，约 ${Math.round(2000 / monthDays)} 份`,
      ),
    ).toBeVisible();
  });

  test("用量：到了本月上限，手机宽度下那句也写全", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSettings(page);
    // This month's 1024 份 are past a 1000 上限.
    await answer(page, "judge/usage", () => usage({ monthlyLimit: 1000 }));
    await openApp(page, "/admin/judge");
    const figures = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "用量" }) })
      .locator("dl");
    await expect(figures).toContainText("本月上限1000 份新版本暂时不能部署");
    const note = figures.getByText("新版本暂时不能部署", { exact: true });
    await expect(note).toBeVisible();
    expect(
      await note.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });

  test("用量：上限小到每天不到 1 份，虚线那句不写约 0 份", async ({ page }) => {
    await mockSettings(page);
    await answer(page, "judge/usage", () => usage({ monthlyLimit: 10 }));
    await openApp(page, "/admin/judge");
    const chart = page.getByRole("figure", { name: "最近 30 天，每天几份" });
    await expect(
      chart.getByText("虚线：本月上限 10 份平均到每天，不到 1 份"),
    ).toBeVisible();
  });

  test("用量：上限调得比用量高得多，不画虚线，柱子照数据画", async ({
    page,
  }) => {
    await mockSettings(page);
    await answer(page, "judge/usage", () => usage({ monthlyLimit: 100_000 }));
    await openApp(page, "/admin/judge");
    const chart = page.getByRole("figure", { name: "最近 30 天，每天几份" });
    await expect(
      chart.getByText(/远高于这 30 天每天的用量，图里没有画。$/),
    ).toBeVisible();
    await expect(chart.locator(".border-dashed")).toHaveCount(0);
    // The tallest bar (7 份) fills most of the chart.
    const bar = chart.locator(`[data-day] > span`).nth(28);
    const tall = await bar.evaluate(
      (element) =>
        element.getBoundingClientRect().height /
        (element.parentElement?.getBoundingClientRect().height ?? 1),
    );
    expect(tall).toBeGreaterThan(0.8);
  });

  test("用量读不出来：设置照样在，开关能关；重试后用量回来", async ({
    page,
  }) => {
    const settings = await mockSettings(page);
    let failing = true;
    await page.route(
      (url) => url.pathname === "/api/admin/judge/usage",
      (route) =>
        failing
          ? route.fulfill({ status: 500, json: { error: {} } })
          : route.fallback(),
    );
    await openApp(page, "/admin/judge");
    await expect(shown(page, "用量读取失败。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "用量" })).toHaveCount(0);

    // The switch, what holds when something goes wrong, still saves.
    const toggle = page.getByRole("switch", { name: "代码判定红包" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(shown(page, "已保存，立即生效")).toBeVisible();
    expect(settings.sent[0]).toMatchObject({
      expectedVersion: 2,
      enabled: false,
    });

    failing = false;
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("heading", { name: "用量" })).toBeVisible();
    await expect(shown(page, "用量读取失败。")).toHaveCount(0);
  });

  test("谁在用：一行打开用户页签里他的详情，红包的打开红包页签里它的详情", async ({
    page,
  }) => {
    await mockSettings(page);
    const users = await answer(page, "users", () => list([authorRow()]));
    await answer(page, `users/${author.id}`, () => ({
      user: {
        ...authorRow(),
        counts: {
          authoredActivities: 1,
          claims: 0,
          registrations: 0,
          merchants: 0,
          paymentTasks: 0,
        },
        amounts: { sent: "0.20", received: "0.00" },
      } satisfies AdminUserDetail,
    }));
    const activities = await answer(page, "activities", () =>
      list([codeActivity()]),
    );
    await answer(page, `activities/${activityId}`, () => ({
      activity: {
        ...codeActivity(),
        updatedAt: Date.now() - hour,
        deadline: null,
        endReason: null,
        drawClosedAt: null,
        drawPublishedAt: null,
        passwordCount: 0,
        code: {
          fingerprint: "a".repeat(64),
          failuresInRow: 0,
          pausedAt: null,
          stoppedAt: null,
          stoppedBy: null,
        },
        payments: {
          total: 0,
          pending: 0,
          confirmed: 0,
          attention: 0,
          unknown: 0,
        },
      } satisfies AdminActivityDetail,
    }));
    await openApp(page, "/admin/judge");

    const person = page.getByRole("link", { name: /小明.*@xiaoming/ });
    await expect(person).toContainText("部署了 4 个新版本 · 占了 6 份");
    await expect(person).toHaveAttribute("href", `/admin/users?q=${author.id}`);
    await person.click();
    await expect(page).toHaveURL(new RegExp(`/admin/users\\?q=${author.id}$`));
    await expect
      .poll(() => users.map((query) => query.get("q")))
      .toContain(author.id);
    const pane = page.getByRole("complementary", { name: "详情" });
    await expect(pane.getByText("2001", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /小明/ })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await page.goBack();
    const hongbao = page.getByRole("link", { name: /猜数字/ });
    await expect(hongbao).toContainText("进行中");
    await expect(hongbao).toContainText("小明 · 9 份 · 判定 120 次");
    await hongbao.click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/activities\\?q=${activityId}$`),
    );
    await expect
      .poll(() => activities.map((query) => query.get("q")))
      .toContain(activityId);
    // There it can be stopped.
    await expect(pane.getByText("代码判定", { exact: true })).toBeVisible();
    await expect(pane.getByRole("button", { name: "停用" })).toBeVisible();
  });

  test("设置：提示照文档，别人先存了，改过的那一项保留，其余跟着新版本", async ({
    page,
  }) => {
    const settings = await mockSettings(page);
    await answer(page, "audit", () => list([]));
    await openApp(page, "/admin/judge");
    await expect(
      page.getByText(/^第 2 版 · .* 由 测试管理员 修改/),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "代码判定红包" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByText("关着时不能新建、不能开放；已经开放的照常领、照常退回。"),
    ).toBeVisible();
    await expect(
      page.getByText("只算部署新版本；重新跑测试、换回部署过的版本不算"),
    ).toBeVisible();
    await expect(
      page.getByText("到了上限，新版本暂时不能部署；已经开放的红包照常领取"),
    ).toBeVisible();
    const save = page.getByRole("button", { name: "保存设置" });
    await expect(save).toHaveAttribute("aria-disabled", "true");

    const monthly = page.getByRole("textbox", { name: "每月判定器上限" });
    await monthly.fill("0");
    await expect(shown(page, "请填 1–1000000 的整数")).toBeVisible();
    await monthly.fill("2000");
    // Saved in another window just before: 每人每天部署 becomes 20.
    settings.saveElsewhere({ dailyDeployLimit: 20 });
    await save.click();
    await expect(
      page.getByText(
        "保存没有完成：判定器设置刚在别处改成第 3 版。你的输入还在，确认后再保存一次。",
      ),
    ).toBeVisible();
    await expect(monthly).toHaveValue("2000");
    await expect(
      page.getByRole("textbox", { name: "每人每天部署" }),
    ).toHaveValue("20");
    await save.click();
    await expect(shown(page, "已保存，立即生效")).toBeVisible();
    expect(settings.sent[1]).toEqual({
      expectedVersion: 3,
      enabled: true,
      dailyOpenLimit: 3,
      dailyDeployLimit: 20,
      monthlyLimit: 2000,
    });
    await expect(
      page.getByText(/^第 4 版 · .* 由 测试管理员 修改/),
    ).toBeVisible();
  });

  test("操作记录：判定器设置写成中文", async ({ page }) => {
    const entry: AdminAuditEntry = {
      id: "change-3",
      type: "judge_settings",
      actorUserId: admin.id,
      actorDisplayName: admin.displayName,
      actorAvatarUrl: null,
      createdAt: Date.now() - hour,
      previousVersion: 2,
      nextVersion: 3,
      before: {
        enabled: true,
        dailyOpenLimit: 3,
        dailyDeployLimit: 10,
        monthlyLimit: 1000,
      },
      after: {
        enabled: false,
        dailyOpenLimit: 3,
        dailyDeployLimit: 10,
        monthlyLimit: 2000,
      },
    };
    await answer(page, "audit", () => list([entry]));
    await openApp(page, "/admin/audit");
    await expect(shown(page, "判定器设置")).toBeVisible();
    await expect(
      page.getByText("代码判定红包 开 → 关；每月判定器上限 1000 份 → 2000 份"),
    ).toBeVisible();
    await expect(page.getByText("第 2 版 → 第 3 版")).toBeVisible();
  });
});
