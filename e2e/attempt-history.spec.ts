import { type BrowserContext, expect, test } from "@playwright/test";

const activityId = "e1111111-1111-4111-8111-111111111111";
const secondId = "e2222222-2222-4222-8222-222222222222";
const discoveryId = "e3333333-3333-4333-8333-333333333333";
const claimSubmissionId = "e4444444-4444-4444-8444-444444444444";
const user = {
  id: "history-viewer",
  username: "viewer",
  displayName: "参与者",
  avatarUrl: null,
  accountTier: "standard",
  canUseLdc: true,
  loginProvider: "connect",
};
const activity = {
  id: activityId,
  title: "不应出现在本地历史的活动标题",
  rewardType: "text",
  status: "active",
  author: {
    id: "author",
    username: "author",
    displayName: "作者",
    avatarUrl: null,
  },
  forceDedicated: false,
  topicUrl: null,
  openedAt: "2026-10-01T00:00:00Z",
  deadlineAt: "2099-12-01T00:00:00Z",
  quantity: { mode: "exact", total: 4, claimed: 0, remaining: 4 },
  showRecipientList: false,
  showRecipientUsername: false,
  showRecipientTime: false,
  beforeInfo: "",
  reward: { mode: "text" },
  myClaim: null,
};

async function mock(context: BrowserContext) {
  const state = {
    result: "none",
    user: user as typeof user | null,
    fail: false,
    home: [] as { submissionId: string; password: string }[],
    claims: [] as { submissionId: string; password: string }[],
    resultReads: 0,
    claimResult: { result: "ended", passwordMatched: true as boolean | null },
  };
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname))
      return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/session")
      return route.fulfill({
        json: {
          user: state.user,
          csrfToken: state.user ? "csrf" : null,
          attemptCooldown: null,
          loginOptions: { liteauthEnabled: true },
        },
      });
    const discovery = {
      id: discoveryId,
      claimSubmissionId,
      result: state.result,
      items:
        state.result === "none"
          ? []
          : state.result === "single"
            ? [activity]
            : [activity, { ...activity, id: secondId }],
      nextCursor: null,
    };
    if (url.pathname === "/api/redemptions/discover") {
      state.home.push(route.request().postDataJSON());
      if (state.fail) return route.abort("failed");
      return route.fulfill({ json: discovery });
    }
    if (url.pathname === `/api/redemptions/${discoveryId}`) {
      state.resultReads++;
      return route.fulfill({ json: discovery });
    }
    if (url.pathname.match(/\/activities\/[^/]+\/participation$/))
      return route.fulfill({ json: { claim: null, registration: null } });
    if (url.pathname.match(/\/activities\/[^/]+\/passwords$/))
      return route.fulfill({
        json: { passwords: [], hiddenCount: 1, canSolve: false },
      });
    if (url.pathname.match(/\/activities\/[^/]+\/claim$/)) {
      state.claims.push(route.request().postDataJSON());
      return route.fulfill({ json: state.claimResult });
    }
    if (url.pathname.match(/^\/api\/activities\/[^/]+$/))
      return route.fulfill({
        json: { activity: { ...activity, id: url.pathname.split("/").at(-1) } },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "not found" } },
    });
  });
  return state;
}

async function tryPassword(
  page: import("@playwright/test").Page,
  password: string,
) {
  const onActivityPage = new URL(page.url()).pathname.startsWith(
    "/activities/",
  );
  await page
    .getByLabel(onActivityPage ? "兑换口令" : "口令", { exact: true })
    .fill(password);
  await page
    .getByRole("button", {
      name: onActivityPage ? "领取奖励" : "兑奖",
      exact: true,
    })
    .click();
}

const history = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "尝试历史" });

async function expectHistoryHidden(page: import("@playwright/test").Page) {
  await expect(history(page)).toHaveCount(0);
  await expect(page.getByText("暂无尝试记录。")).toHaveCount(0);
}

test("首页按口令合并；匹配后领取失败仍保留，回填与普通导航不提交", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await page.goto("/");
  await tryPassword(page, "remember1");
  await expect(
    history(page).getByText("未匹配", { exact: true }),
  ).toBeVisible();
  state.result = "single";
  await tryPassword(page, "remember1");
  await expect(page).toHaveURL(new RegExp(`/activities/${activityId}`));
  await expect.poll(() => state.claims.length).toBe(1);
  await page.goBack();
  await expect(history(page).locator("li")).toHaveCount(1);
  await expect(
    history(page).getByText("已匹配", { exact: true }),
  ).toBeVisible();
  await expect(history(page)).not.toContainText(activity.title);
  await history(page)
    .getByRole("button", { name: "填入口令 remember1", exact: true })
    .click();
  await expect(page.getByLabel("口令", { exact: true })).toBeFocused();
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue(
    "remember1",
  );
  expect(state.home).toHaveLength(2);
  await history(page).getByRole("link", { name: "查看活动" }).click();
  await expect(page).toHaveURL(new RegExp(`/activities/${activityId}`));
  await page.goBack();
  await page.reload();
  await expect(history(page).locator("li")).toHaveCount(1);
  await expect(
    history(page).getByText("已匹配", { exact: true }),
  ).toBeVisible();
  expect(state.home).toHaveLength(2);
  expect(state.claims).toHaveLength(1);
});

test("网络失败记未确认，原编号重试更新原记录且不改变时间", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.fail = true;
  await page.goto("/");
  await tryPassword(page, "retryword");
  await expect(
    history(page).getByText("未确认", { exact: true }),
  ).toBeVisible();
  const time = await history(page).locator("time").getAttribute("datetime");
  state.fail = false;
  await page.getByRole("button", { name: "再次确认", exact: true }).click();
  await expect(
    history(page).getByText("未匹配", { exact: true }),
  ).toBeVisible();
  expect(state.home[1]?.submissionId).toBe(state.home[0]?.submissionId);
  expect(await history(page).locator("time").getAttribute("datetime")).toBe(
    time,
  );
  await expect(history(page).locator("li")).toHaveCount(1);
});

test("未知结果改填先确认，取消保留恢复入口，确认只改填不提交", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await page.goto("/");
  await tryPassword(page, "savedword");
  await expect(history(page).locator("li")).toHaveCount(1);
  state.fail = true;
  await tryPassword(page, "uncertainword");
  await expect(
    page.getByRole("button", { name: "再次确认", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await history(page)
    .getByRole("button", { name: "填入口令 savedword", exact: true })
    .click();
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue(
    "uncertainword",
  );
  await expect(
    page.getByRole("button", { name: "再次确认", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await history(page)
    .getByRole("button", { name: "填入口令 savedword", exact: true })
    .click();
  await expect(page.getByLabel("口令", { exact: true })).toHaveValue(
    "savedword",
  );
  await expect(page.getByLabel("口令", { exact: true })).toBeFocused();
  await expect(
    page.getByRole("button", { name: "再次确认", exact: true }),
  ).toHaveCount(0);
  expect(state.home).toHaveLength(2);
});

test("多匹配保存已返回候选，历史菜单不展示活动详情或再次兑奖", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.result = "multiple";
  await page.goto("/");
  await tryPassword(page, "multiple1");
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭选择活动", exact: true }).click();
  await expect(
    history(page).getByText("已匹配", { exact: true }),
  ).toBeVisible();
  await history(page)
    .getByRole("button", { name: "查看活动", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "活动1", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "活动2", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/activities/${secondId}`));
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.home).toHaveLength(1);
  expect(state.claims).toHaveLength(0);
});

test("活动页错误口令和校验前结束分别保存未匹配与未确认", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.claimResult = { result: "incorrect", passwordMatched: false };
  await page.goto(`/activities/${activityId}`);
  await tryPassword(page, "wrongpass");
  await expect.poll(() => state.claims.length).toBe(1);
  await page.goto("/");
  await expect(
    history(page).getByText("未匹配", { exact: true }),
  ).toBeVisible();
  state.claimResult = { result: "ended", passwordMatched: null };
  await page.goto(`/activities/${activityId}`);
  await tryPassword(page, "notchecked");
  await expect.poll(() => state.claims.length).toBe(2);
  await page.goto("/");
  await expect(
    history(page).getByText("未确认", { exact: true }),
  ).toBeVisible();
  await expect(history(page).locator("li")).toHaveCount(2);
});

test("无记录隐藏组件，账号隔离、同账号恢复、跨标签删除最后一条后继续隐藏", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await page.goto("/");
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  await expectHistoryHidden(page);
  await tryPassword(page, "keepmine1");
  await expect(history(page).locator("li")).toHaveCount(1);
  state.user = { ...user, id: "another-user" };
  await page.reload();
  await expect(page.getByLabel("口令", { exact: true })).toBeVisible();
  await expectHistoryHidden(page);
  state.user = null;
  await page.reload();
  await expectHistoryHidden(page);
  state.user = user;
  await page.reload();
  await expect(history(page).locator("li")).toHaveCount(1);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const other = await context.newPage();
  await other.goto("/");
  await expect(history(other).locator("li")).toHaveCount(1);
  await history(other)
    .getByRole("button", { name: "删除口令 keepmine1 的记录" })
    .click();
  await expectHistoryHidden(other);
  await expectHistoryHidden(page);
  await other.close();
});

test("清空历史后隐藏整个组件", async ({ page, context }) => {
  await mock(context);
  await page.goto("/");
  await expectHistoryHidden(page);
  await tryPassword(page, "clearword1");
  await tryPassword(page, "clearword2");
  await expect(history(page).locator("li")).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.accept());
  await history(page)
    .getByRole("button", { name: "清空", exact: true })
    .click();
  await expectHistoryHidden(page);
});

test("已有历史使用紧凑标题和末尾本地保存说明", async ({ page, context }) => {
  await mock(context);
  await page.goto("/");
  await tryPassword(page, "styleword1");
  await expect(history(page).locator("li")).toHaveCount(1);
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 820 });
    const metrics = await history(page).evaluate((section) => {
      const title = section.querySelector(".attempt-history-title");
      const description = section.querySelector(".attempt-history-description");
      const list = section.querySelector(".attempt-history-list");
      if (!(title instanceof HTMLElement)) throw new Error("missing title");
      if (!(description instanceof HTMLElement))
        throw new Error("missing description");
      if (!(list instanceof HTMLElement)) throw new Error("missing list");
      const titleStyle = getComputedStyle(title);
      const descriptionStyle = getComputedStyle(description);
      const descriptionRect = description.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return {
        titleFontSize: titleStyle.fontSize,
        descriptionFontSize: descriptionStyle.fontSize,
        titleColor: titleStyle.color,
        descriptionColor: descriptionStyle.color,
        descriptionText: description.textContent?.trim(),
        descriptionIsLast: section.lastElementChild === description,
        descriptionAfterList: descriptionRect.top >= listRect.bottom,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });
    expect(metrics.titleFontSize).toBe("14px");
    expect(metrics.descriptionFontSize).toBe("11px");
    expect(metrics.descriptionText).toBe("仅保存在当前浏览器");
    expect(metrics.descriptionIsLast).toBe(true);
    expect(metrics.descriptionAfterList).toBe(true);
    expect(metrics.descriptionColor).not.toBe(metrics.titleColor);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  }
});

test("本地存储不可用仍能兑奖并在当前会话保留历史", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("disabled", "SecurityError");
      },
    }),
  );
  const state = await mock(context);
  await page.goto("/");
  await tryPassword(page, "fallback1");
  await expect(
    history(page).getByText("未匹配", { exact: true }),
  ).toBeVisible();
  await expect(history(page).getByRole("status")).toContainText(
    "本地存储不可用",
  );
  expect(state.home).toHaveLength(1);
});
