import { expect, type Page, test } from "@playwright/test";
import {
  type ActivityInput,
  type CreateActivityInput,
  emptyActivityInput,
  type LdcActivityInput,
  type ManagedActivity,
  type Merchant,
  type UpdateActivityInput,
} from "../packages/contracts/src";

const id = "1b169ce5-9928-42aa-833a-5f086e40258b";
const merchantId = "2c5e17aa-7b10-4348-aea5-0a1db59c806e";
const user = {
  id: "draw-time-owner",
  username: "drawtime",
  displayName: "开奖时间测试",
  avatarUrl: null,
};

test.use({ timezoneId: "Asia/Shanghai" });

async function mockDraw(page: Page) {
  const now = new Date().toISOString();
  const merchant: Merchant = {
    id: merchantId,
    label: "本地测试商户",
    clientId: "draw_time_local",
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
      canSimulate: true,
    },
    pausedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const base = emptyActivityInput();
  const config: LdcActivityInput = {
    ...base,
    title: "开奖时间双模式",
    rewardType: "ldc",
    merchantId,
    allocation: "random",
    passwords: ["drawtime"],
    money: {
      mode: "timed_draw",
      algorithm: "double_mean_v1",
      totalAmount: "1.00",
      count: 2,
      participantLimit: null,
      countdownSeconds: 600,
      distributeFullPool: true,
    },
  };
  const state = {
    activity: {
      id,
      author: user,
      title: config.title,
      rewardType: "ldc",
      forceDedicated: config.forceDedicated,
      config,
      status: "draft",
      version: 1,
      paymentMode: "simulation",
      createdAt: now,
      openedAt: null,
      deadlineAt: null,
      topicUrl: null,
      totalCount: 2,
      claimedCount: 0,
      draw: {
        state: "waiting",
        deadlineAt: null,
        closedAt: null,
        reason: null,
        registeredCount: 0,
        winnerCount: null,
        participantLimit: null,
      },
    } as ManagedActivity,
    creates: [] as CreateActivityInput[],
    updates: [] as UpdateActivityInput[],
    opens: 0,
  };
  function save(activity: ActivityInput) {
    if (activity.rewardType !== "ldc") throw new Error("Expected LDC");
    state.activity = {
      ...state.activity,
      title: activity.title,
      config: activity,
      version: state.activity.version + 1,
      totalCount:
        activity.money.mode === "custom"
          ? activity.money.amounts.length
          : activity.money.count,
    };
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" || path === "/api/me")
      return route.fulfill({ json: { user, csrfToken: "draw-time-csrf" } });
    if (path === "/api/me/merchants")
      return route.fulfill({
        json: {
          items: [merchant],
          currentMerchantId: merchantId,
          canCreate: false,
          canSimulate: true,
          nextCursor: null,
        },
      });
    if (path === `/api/me/merchants/${merchantId}`)
      return route.fulfill({ json: { merchant } });
    if (path.endsWith("/claims") || path.endsWith("/registrations"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/activities" && request.method() === "POST") {
      const input = request.postDataJSON() as CreateActivityInput;
      state.creates.push(input);
      save(input.activity);
      return route.fulfill({ json: { activity: state.activity } });
    } else if (
      path === `/api/me/activities/${id}` &&
      request.method() === "PATCH"
    ) {
      const input = request.postDataJSON() as UpdateActivityInput;
      state.updates.push(input);
      save(input.activity);
    } else if (path === `/api/me/activities/${id}/open`) {
      state.opens++;
      const current = state.activity.config;
      if (current.rewardType !== "ldc" || current.money.mode !== "timed_draw")
        throw new Error("Expected timed draw");
      const draw = state.activity.draw;
      if (!draw) throw new Error("Expected draw summary");
      const deadlineAt =
        current.deadline.mode === "at"
          ? current.deadline.at
          : new Date(
              Date.now() + (current.money.countdownSeconds ?? 0) * 1000,
            ).toISOString();
      state.activity = {
        ...state.activity,
        status: "active",
        version: state.activity.version + 1,
        openedAt: new Date().toISOString(),
        deadlineAt,
        draw: { ...draw, deadlineAt },
      };
    }
    if (path.startsWith("/api/me/activities"))
      return route.fulfill({ json: { activity: state.activity } });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "未设置测试读取" } },
    });
  });
  return state;
}

function timeButton(page: Page, name: "倒计时" | "指定时间") {
  return page
    .getByRole("group", { name: "最晚开奖时间", exact: true })
    .getByRole("button", { name, exact: true });
}

test("开奖时间两种输入互斥，切换及修改金额保留输入，保存刷新保留指定时间", async ({
  page,
}) => {
  const state = await mockDraw(page);
  await page.goto("/activities/new");
  await page
    .getByRole("group", { name: "奖励方式", exact: true })
    .getByRole("button", { name: "限时开奖", exact: true })
    .click();
  await expect(page.locator("#timed-countdown")).toHaveValue("600");
  await page.locator("#activity-title").fill("指定时间活动");
  await page.locator("#activity-password-1").fill("drawtime");
  await page.locator("#timed-total").fill("1.00");
  await page.locator("#timed-count").fill("2");
  await page.locator("#timed-countdown").fill("90");
  await timeButton(page, "倒计时").focus();
  await page.keyboard.press("ArrowRight");
  await expect(timeButton(page, "指定时间")).toBeFocused();
  await expect(page.locator("#timed-countdown")).toHaveCount(0);
  await page.locator("#timed-deadline-at").fill("2035-05-06T13:45");
  await expect(
    page.getByText("使用当前设备时区（Asia/Shanghai）。", {
      exact: true,
    }),
  ).toBeVisible();
  await timeButton(page, "倒计时").click();
  await expect(page.locator("#timed-countdown")).toHaveValue("90");
  await expect(page.locator("#timed-deadline-at")).toHaveCount(0);
  await timeButton(page, "指定时间").click();
  await expect(page.locator("#timed-deadline-at")).toHaveValue(
    "2035-05-06T13:45",
  );
  await page.locator("#timed-total").fill("2.00");
  await page
    .getByRole("group", { name: "抽奖算法", exact: true })
    .getByRole("button", { name: "均值上下 50%", exact: true })
    .click();
  await expect(timeButton(page, "指定时间")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByRole("group", { name: "奖励方式", exact: true })
    .getByRole("button", { name: "即时随机", exact: true })
    .click();
  await page
    .getByRole("group", { name: "奖励方式", exact: true })
    .getByRole("button", { name: "限时开奖", exact: true })
    .click();
  await expect(page.locator("#timed-deadline-at")).toHaveValue(
    "2035-05-06T13:45",
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(viewport);
    const field = page.locator("#timed-deadline-at");
    await expect(field).toBeVisible();
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe(`/my/activities/${id}`);
  const created = state.creates[0]?.activity;
  expect(created?.deadline).toEqual({
    mode: "at",
    at: "2035-05-06T05:45:00.000Z",
  });
  if (created?.rewardType !== "ldc") throw new Error("Expected LDC");
  expect(created.money).not.toHaveProperty("countdownSeconds");
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#timed-deadline-at")).toHaveValue(
    "2035-05-06T13:45",
  );
  await page.reload();
  await expect(page.locator("#timed-deadline-at")).toHaveValue(
    "2035-05-06T13:45",
  );
  await expect(timeButton(page, "指定时间")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("指定时间开放后保持实际时刻并锁定两种时间设置", async ({ page }) => {
  const state = await mockDraw(page);
  if (
    state.activity.config.rewardType !== "ldc" ||
    state.activity.config.money.mode !== "timed_draw"
  )
    throw new Error("Expected timed draw");
  const { countdownSeconds: _countdownSeconds, ...money } =
    state.activity.config.money;
  state.activity.config = {
    ...state.activity.config,
    deadline: { mode: "at", at: "2035-05-06T05:45:00.000Z" },
    money,
  };
  await page.goto(`/my/activities/${id}?edit=true`);
  await expect(page.locator("#timed-deadline-at")).toHaveValue(
    "2035-05-06T13:45",
  );
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe(`/my/activities/${id}`);
  expect(state.opens).toBe(1);
  expect(state.activity.deadlineAt).toBe("2035-05-06T05:45:00.000Z");
  await expect(
    page.getByRole("heading", { name: "编辑活动", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#timed-deadline-at")).toBeDisabled();
  await expect(timeButton(page, "倒计时")).toBeDisabled();
  await expect(timeButton(page, "指定时间")).toBeDisabled();
  await expect(page.getByText(/实际最晚开奖时间：/)).toBeVisible();
});

test("旧倒计时配置刷新后原样保留，指定时间未填写时不发出保存", async ({
  page,
}) => {
  const state = await mockDraw(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/my/activities/${id}?edit=true`);
  await expect(page.locator("#timed-countdown")).toHaveValue("600");
  await timeButton(page, "指定时间").click();
  await expect(page.locator("#timed-deadline-at")).toHaveValue("");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator("#activity-errors")).toBeVisible();
  expect(state.updates).toHaveLength(0);
  await timeButton(page, "倒计时").click();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toBe(`/my/activities/${id}`);
  expect(state.updates[0]?.activity.deadline).toEqual({ mode: "duration" });
  expect(state.updates[0]?.activity).toMatchObject({
    money: { countdownSeconds: 600 },
  });
});
