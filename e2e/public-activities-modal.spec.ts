import { expect, type Page, test } from "@playwright/test";

const firstId = "790f9912-9934-4dfc-8efc-7c32962a3e82";
function card(index: number, status = "active") {
  return {
    id:
      index === 0
        ? firstId
        : `790f9912-9934-4dfc-8efc-${String(index).padStart(12, "0")}`,
    title: `公开活动 ${index + 1}`,
    rewardType: "ldc",
    reward: {
      mode: "fixed",
      unitAmount: "0.88",
      totalAmount: "17.60",
      count: 20,
    },
    paymentMode: "simulation",
    status,
    author: {
      id: "author",
      username: "maker",
      displayName: "发布者",
      avatarUrl: null,
      accountTier: "standard",
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: "2026-10-01T00:00:00.000Z",
    deadlineAt: "2030-10-01T00:00:00.000Z",
    quantity: { mode: "exact", total: 20, claimed: 0, remaining: 20 },
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    myClaim: null,
  };
}
async function mock(page: Page) {
  const state = {
    reads: [] as string[],
    writes: [] as string[],
    fail: false,
    pendingSession: null as Promise<void> | null,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") state.writes.push(url.pathname);
    if (url.pathname === "/api/session" || url.pathname === "/api/me") {
      await state.pendingSession;
      return route.fulfill({
        json: {
          user: null,
          csrfToken: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
    }
    if (url.pathname === "/api/discovery/activities") {
      state.reads.push(url.search);
      if (state.fail)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "暂时不可用" } },
        });
      const second = url.searchParams.has("cursor");
      return route.fulfill({
        json: {
          total: 40,
          nextCursor: second ? null : "page-2",
          items: Array.from({ length: 20 }, (_, index) =>
            card(
              index + (second ? 20 : 0),
              url.searchParams.get("status") === "ended" ? "ended" : "active",
            ),
          ),
        },
      });
    }
    if (url.pathname.startsWith("/api/activities/"))
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "活动不存在" } },
      });
    return route.fulfill({ json: {} });
  });
  return state;
}
const popup = (page: Page) =>
  page.getByRole("dialog", { name: "活动广场", exact: true });
const trigger = (page: Page) =>
  page.getByRole("button", { name: "已公开的活动", exact: true });

for (const width of [1440, 375])
  test(`${width}px 首页链接入口、输入保留及系统返回关闭／前进恢复`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await mock(page);
    await page.goto("/");
    const input = page.getByLabel("口令", { exact: true });
    await input.fill("保留我的口令");
    expect(state.reads).toEqual([]);
    await expect(
      page
        .locator(".desktop-nav, .mobile-nav")
        .getByRole("link", { name: "活动广场" }),
    ).toHaveCount(0);
    const style = await trigger(page).evaluate((node) => {
      const span = node.querySelector("span");
      if (!span) throw new Error("Missing link label");
      return {
        underline: getComputedStyle(span).textDecorationLine,
        border: getComputedStyle(node).borderWidth,
        background: getComputedStyle(node).backgroundColor,
        arrow: node.querySelector("svg")?.getAttribute("aria-hidden"),
      };
    });
    expect(style).toEqual({
      underline: "underline",
      border: "0px",
      background: "rgba(0, 0, 0, 0)",
      arrow: "true",
    });
    const entryBox = await trigger(page).boundingBox();
    const inputBox = await input.boundingBox();
    if (!entryBox || !inputBox) throw new Error("Missing home controls");
    expect(entryBox.x).toBeLessThan(inputBox.x + 3);
    expect(entryBox.y + entryBox.height).toBeLessThan(inputBox.y);
    await trigger(page).click();
    await expect(popup(page)).toBeVisible();
    await expect(
      popup(page).getByRole("table", { name: "公开活动" }),
    ).toBeVisible();
    await expect(popup(page).locator("[data-activity-id]")).toHaveCount(20);
    const bounds = await popup(page).boundingBox();
    if (!bounds) throw new Error("Missing dialog bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await expect(input).toHaveValue("保留我的口令");
    await page.goBack();
    await expect(popup(page)).toHaveCount(0);
    await expect(input).toHaveValue("保留我的口令");
    await expect(trigger(page)).toBeFocused();
    await page.goForward();
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    expect(state.writes).toEqual([]);
  });

test("旧地址回首页弹窗，保留合法筛选并支持分页、刷新与阅读位置恢复", async ({
  page,
}) => {
  const state = await mock(page);
  await page.goto("/square?status=ended&type=text&cursor=old&page=8");
  await expect(page).toHaveURL("/");
  await expect(popup(page)).toBeVisible();
  await expect(
    popup(page).getByRole("button", { name: "活动状态筛选" }),
  ).toHaveText("状态：已结束");
  await expect(popup(page).getByLabel("活动广场分页")).toContainText("第 1 页");
  await popup(page)
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(popup(page).getByLabel("活动广场分页")).toContainText("第 2 页");
  await expect(
    popup(page).getByText("公开活动 21", { exact: true }),
  ).toBeVisible();
  const scroll = popup(page).locator(".list-panel__scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 190;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await page.reload();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByLabel("活动广场分页")).toContainText("第 2 页");
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  state.fail = true;
  const refresh = popup(page).getByRole("button", {
    name: /^刷新活动列表/,
  });
  await refresh.click();
  await expect(refresh).toHaveAccessibleName("刷新活动列表，刷新失败");
  await expect(
    popup(page).getByText("公开活动 21", { exact: true }),
  ).toBeAttached();
  state.fail = false;
  await refresh.click();
  await expect(refresh).toHaveAccessibleName("刷新活动列表，已刷新");
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(state.writes).toEqual([]);
});

test("浏览活动先关闭模态，返回恢复列表，不发生兑奖或报名", async ({ page }) => {
  const state = await mock(page);
  await page.goto("/");
  await trigger(page).click();
  await expect(popup(page).locator("[data-activity-id]")).toHaveCount(20);
  await popup(page)
    .getByRole("link", { name: "公开活动 1", exact: true })
    .click();
  await expect(page).toHaveURL(`/activities/${firstId}`);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.goBack();
  await expect(popup(page)).toBeVisible();
  await expect(
    popup(page).getByRole("link", { name: "公开活动 1", exact: true }),
  ).toBeFocused();
  await popup(page).getByRole("button", { name: "关闭活动广场" }).click();
  await expect(popup(page)).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("身份确认期间点击入口排队，确认后保持弹窗且返回关闭", async ({ page }) => {
  const state = await mock(page);
  let resolveSession: () => void = () => {};
  state.pendingSession = new Promise<void>((resolve) => {
    resolveSession = resolve;
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await trigger(page).click();
  expect(state.reads).toEqual([]);
  resolveSession();
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator("[data-activity-id]")).toHaveCount(20);
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
});

test("短视口分页可达、键盘留在模态及遮罩关闭回焦", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 260 });
  await mock(page);
  await page.goto("/square");
  await expect(popup(page).locator("[data-activity-id]")).toHaveCount(20);
  await popup(page)
    .getByRole("button", { name: "下一页", exact: true })
    .click();
  await expect(popup(page).getByLabel("活动广场分页")).toContainText("第 2 页");
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest("dialog[open]")),
    ),
  ).toBe(true);
  await page.mouse.click(2, 2);
  await expect(popup(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

for (const reopen of [false, true])
  test(`${reopen ? "前进重开" : "打开"}公开列表取消旧帖子定位，迟到结果不能导航或覆盖弹窗`, async ({
    page,
  }) => {
    await mock(page);
    let release: () => void = () => {};
    let started: () => void = () => {};
    let finished: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const requestFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await page.route("**/api/topics/123/activities*", async (route) => {
      started();
      await gate;
      try {
        await route.fulfill({
          json: { items: [card(0)], total: 1, nextCursor: null },
        });
      } finally {
        finished();
      }
    });
    await page.goto("/");
    if (reopen) {
      await trigger(page).click();
      await expect(popup(page)).toBeVisible();
      await page.goBack();
      await expect(popup(page)).toHaveCount(0);
    }
    await page
      .getByLabel("口令", { exact: true })
      .fill("https://linux.do/t/topic/123");
    await page.getByRole("button", { name: "跳转活动", exact: true }).click();
    await requestStarted;
    if (reopen) await page.goForward();
    else await trigger(page).click();
    await expect(popup(page)).toBeVisible();
    release();
    await requestFinished;
    await expect(page).toHaveURL("/");
    await expect(popup(page)).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "选择活动", exact: true }),
    ).toHaveCount(0);
    await page.goBack();
    await expect(page.getByLabel("口令", { exact: true })).toHaveValue(
      "https://linux.do/t/topic/123",
    );
  });

test("公开列表阻止旧兑奖自动导航，并保留原提交供主动再次确认", async ({
  page,
}) => {
  const state = await mock(page);
  const user = {
    id: "modal-user",
    username: "viewer",
    displayName: "参与者",
    avatarUrl: null,
    accountTier: "standard",
    canUseLdc: true,
    loginProvider: "connect",
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { user, csrfToken: "csrf" } }),
  );
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submissions: Array<{ submissionId: string; password: string }> = [];
  await page.route("**/api/redemptions/discover", async (route) => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) await gate;
    return route.fulfill({
      json: {
        id: "redemption-modal",
        result: "single",
        items: [card(0)],
        total: 1,
        nextCursor: null,
        selectedActivityId: firstId,
        claimSubmissionId: "790f9912-9934-4dfc-8efc-7c32962a3e82",
        claimResult: {
          result: "claimed",
          claim: {
            id: "claim",
            activity: { id: firstId, title: "公开活动 1", status: "active" },
            rewardType: "ldc",
            amount: "0.88",
            payment: {
              id: "payment",
              mode: "simulation",
              status: "confirmed",
              reason: null,
              confirmedAt: null,
            },
            claimedAt: "2026-10-01T00:00:00.000Z",
            afterClaimInfo: "",
          },
          activity: {
            id: firstId,
            status: "active",
            quantity: card(0).quantity,
          },
        },
      },
    });
  });
  await page.goto("/");
  const input = page.getByLabel("口令", { exact: true });
  await input.fill("原提交需要保留");
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  await trigger(page).click();
  await expect(popup(page)).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "再次确认", exact: true }),
  ).toBeAttached();
  await expect(page).toHaveURL("/");
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toBeDisabled();
  await page.getByRole("button", { name: "再次确认", exact: true }).click();
  await expect(page).toHaveURL(`/activities/${firstId}`);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(state.writes).toEqual([]);
});
