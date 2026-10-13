import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

async function expectHistoryTotals(
  page: Page,
  initiated: number,
  participated: number,
) {
  const overview = page.getByRole("region", { name: "活动历史统计" });
  await expect(overview.locator('[data-statistic="initiated"]')).toHaveText(
    `已发起${initiated}场`,
  );
  await expect(overview.locator('[data-statistic="participated"]')).toHaveText(
    `已参与${participated}场`,
  );
  await expect(overview).not.toContainText("已领取");
}

async function setIdentity(
  page: Page,
  identity: "standard" | "lite" | "guest",
) {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "体验身份", exact: true })
    .selectOption(identity);
  await page.getByRole("button", { name: "场景与身份" }).click();
}

test("both history views retain account totals through pagination and identity changes", async ({
  page,
}) => {
  await page.goto("/#participations");
  await expectHistoryTotals(page, 24, 24);
  await expect(
    page.getByRole("button", { name: "刷新参与记录", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "参与记录分页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    page.locator('.activity-rows[data-context="history"] tr[data-activity-id]'),
  ).toHaveCount(4);
  await expectHistoryTotals(page, 24, 24);

  await page
    .getByRole("tablist", { name: "活动历史分类" })
    .getByRole("tab", { name: "我发起的", exact: true })
    .click();
  await expectHistoryTotals(page, 24, 24);
  await expect(
    page.getByRole("button", { name: "刷新活动列表", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(0);
  await expect(page.getByTestId("managed-activity")).toHaveCount(20);
  await expectHistoryTotals(page, 24, 24);
  await page
    .getByRole("navigation", { name: "作者活动分页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(page.getByTestId("managed-activity")).toHaveCount(4);
  await expectHistoryTotals(page, 24, 24);

  await setIdentity(page, "lite");
  await expectHistoryTotals(page, 0, 0);
  await page
    .getByRole("tablist", { name: "活动历史分类" })
    .getByRole("tab", { name: "我参与的", exact: true })
    .click();
  await expectHistoryTotals(page, 0, 0);
  await expect(
    page.locator('.activity-rows[data-context="history"] tr[data-activity-id]'),
  ).toHaveCount(0);
  await setIdentity(page, "guest");
  await expect(page.getByRole("region", { name: "活动历史统计" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "登录后查看参与记录" }),
  ).toBeVisible();
  await setIdentity(page, "standard");
  await expectHistoryTotals(page, 24, 24);
});

test("creating and deleting drafts update the complete initiated total", async ({
  page,
}) => {
  await page.goto("/#manage");
  await expectHistoryTotals(page, 24, 24);
  const deleting = page.locator(
    '[data-activity-id="20000000-0000-4000-8000-000000000002"]',
  );
  await deleting
    .getByRole("button", { name: "固定红包 · 12 份：删除草稿" })
    .click();
  await page
    .getByRole("dialog", { name: "确认删除草稿" })
    .getByRole("button", { name: "删除草稿", exact: true })
    .click();
  await expectHistoryTotals(page, 23, 24);

  await page
    .locator(".site-header")
    .getByRole("link", { name: "发起活动", exact: true })
    .click();
  await page.locator("#work-title").fill("统计新增草稿");
  await page.getByRole("button", { name: "自定义金额", exact: true }).click();
  await page.locator("#work-custom-amounts").fill("0.50");
  await page.locator("#work-password-1").fill("统计测试口令");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示草稿已保存" })
    .getByRole("button", { name: "查看我的活动" })
    .click();
  await expectHistoryTotals(page, 24, 24);
  await expect(page.getByTestId("managed-activity").first()).toContainText(
    "统计新增草稿",
  );
});

test("participation history keeps five aligned columns and displays the actual redemption password", async ({
  page,
}) => {
  await page.goto("/#participations");
  const table = page.getByRole("table", { name: "我参与的活动" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "活动",
    "发布者",
    "我的奖励",
    "参与时间",
    "操作",
  ]);
  const row = table.locator('[data-activity-id="history-random-active"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".activity-table-open")).toHaveCSS(
    "font-size",
    "16px",
  );
  await expect(row.locator(".activity-row-title .status-badge")).toContainText(
    "进行中",
  );
  await expect(row.locator(".activity-rows-source")).toContainText("通过口令");
  await expect(row.locator(".activity-rows-source")).toContainText("兑换");
  await expect(row.locator(".activity-rows-source b")).toBeVisible();
  await expect(row.locator(".activity-rows-source")).not.toContainText(
    /[「」]/u,
  );
  await expect(row.locator(".activity-rows-source b")).toHaveCSS(
    "user-select",
    "text",
  );
  await expect(row.locator(".activity-rows-source button")).toHaveCount(0);
  await expect(row.locator(".pw-reveal__value")).toHaveCount(0);
  await expect(row.locator(".activity-rows-state")).toHaveCount(0);
  await expect(row.locator(".activity-rows-amount")).toHaveText("+0.98 LDC");
  await expect(row.locator("time.activity-rows-time")).not.toHaveText("—");
  const view = row.getByRole("link", { name: "查看活动", exact: true });
  await expect(view).toHaveAttribute(
    "href",
    "#activity?sample=history-random-active",
  );
  await expect(view).toHaveAttribute("target", "_blank");
  await expect(view).toHaveAttribute("rel", "noopener noreferrer");
  await expect(view).toBeVisible();
  await row.locator(".activity-rows-open").click();
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.98 LDC");
  await expect(page.locator('[data-testid="envelope"]')).toHaveAttribute(
    "data-animate",
    "false",
  );
});

test("only confirmed rewards expose a confirmation help and pending rewards retain their allocated amount", async ({
  page,
}) => {
  await page.goto("/#participations");
  const rows = page.locator('.activity-rows[data-context="history"]');
  const confirmed = rows.locator('[data-payment="confirmed"]').first();
  await expect(confirmed.locator(".payment-confirmation")).toHaveCount(1);
  await confirmed
    .getByRole("button", { name: "已发放说明", exact: true })
    .focus();
  const help = page.getByRole("dialog", { name: "已发放说明" });
  await expect(help).toContainText("确认时间");
  await expect(help.locator("time")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u,
  );
  await expect(help).not.toContainText("到账");
  await page.keyboard.press("Escape");
  const statuses = ["pending", "sending", "reconciling", "waiting"];
  const found = new Set<string>();
  const next = page
    .getByRole("navigation", { name: "参与记录分页" })
    .getByRole("button", { name: "下一页" });
  for (;;) {
    for (const status of statuses) {
      const row = rows.locator(`[data-payment="${status}"]`).first();
      if ((await row.count()) === 0) continue;
      found.add(status);
      await expect(row.locator(".payment-confirmation")).toHaveCount(0);
      await expect(row.locator(".activity-rows-amount")).toHaveText(
        /^\+\d+\.\d{2} LDC$/u,
      );
      await expect(row.locator(".activity-rows-reward-status")).toHaveCount(0);
    }
    if (await next.isDisabled()) break;
    await next.click();
  }
  expect(found).toEqual(new Set(statuses));
});

test("registration history labels its source as registration and never invents an allocated reward", async ({
  page,
}) => {
  await page.goto("/#participations");
  const row = page.locator('[data-participation="registered"]').first();
  await expect(row.locator(".activity-rows-source")).toContainText("报名");
  await expect(row.locator(".activity-rows-source")).not.toContainText("兑换");
  await expect(row.locator(".activity-rows-reward-status")).toContainText(
    "等待开奖",
  );
  await expect(row.locator(".activity-rows-amount")).toHaveCount(0);
  await expect(row.locator(".payment-confirmation")).toHaveCount(0);
});

test("a new claim retains the submitted password instead of borrowing the first configured answer", async ({
  page,
}) => {
  await page.goto("/#participations");
  await expectHistoryTotals(page, 24, 24);
  await page.evaluate(() => {
    window.location.hash = "activity?sample=weekend";
  });
  await page.locator("#activity-password").fill("周末口令2026");
  await page.getByRole("button", { name: "领取红包", exact: true }).click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "claimed",
  );
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "活动历史", exact: true })
    .click();
  const row = page.locator('[data-activity-id="weekend"]');
  await expectHistoryTotals(page, 24, 25);
  await expect(row.locator(".activity-rows-source b")).toHaveText(
    "周末口令2026",
  );
  await expect(row.locator(".activity-rows-source")).toHaveText(
    "通过口令 周末口令2026 兑换",
  );
  await expect(row.locator(".activity-rows-source")).not.toContainText(
    "公共口令2026",
  );
  await expect(row.locator(".activity-rows-source button")).toHaveCount(0);
  await expect(row.locator(".activity-rows-amount")).toHaveText("+0.88 LDC");
  await expect(row.locator(".payment-confirmation")).toHaveCount(1);
});

test("author history shares the table style, keeps creation timestamps, and refreshes deadline filters", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T04:00:00Z") });
  await page.goto("/#manage");
  await expectHistoryTotals(page, 24, 24);
  await expect(page.locator(".work-manage-toolbar")).toHaveCount(0);
  const table = page.getByRole("table", { name: "我发起的活动" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "活动",
    "奖励配置",
    "参与情况",
    "创建时间",
    "操作",
  ]);
  const first = table.locator(
    '[data-activity-id="20000000-0000-4000-8000-000000000001"]',
  );
  const created = await first
    .locator(".activity-table-created")
    .getAttribute("datetime");
  const badge = first.locator(".activity-row-title .status-badge");
  await expect(badge).toContainText("进行中");
  const before = await badge.innerText();
  await page.clock.runFor(1000);
  await expect(badge).not.toHaveText(before);
  await expect(first.locator(".activity-table-created")).toHaveAttribute(
    "datetime",
    created ?? "",
  );
  await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(0);
  await expect(page.getByTestId("managed-activity")).toHaveCount(20);
  await page.clock.fastForward("03:00:00");
  await expect(page.getByTestId("managed-activity")).toHaveCount(20);
  await expect(
    table.locator(".status-badge").filter({ hasText: "正在开奖" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("navigation", { name: "作者活动分页" }),
  ).toContainText("第 1 页");
});

test("a new draw registration and its later prize count as one participated activity", async ({
  page,
}) => {
  await page.goto("/#activity?sample=evening");
  await page.locator("#activity-password").fill("开奖口令2026");
  await page.getByRole("button", { name: "报名", exact: true }).click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "registered",
  );
  await page.evaluate(() => {
    window.location.hash = "participations";
  });
  await expectHistoryTotals(page, 24, 25);
  await page
    .locator('[data-activity-id="evening"] .activity-rows-open')
    .click();
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.getByRole("button", { name: "预览中奖变化", exact: true }).click();
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "won",
  );
  await page.evaluate(() => {
    window.location.hash = "participations";
  });
  await expectHistoryTotals(page, 24, 25);
  const row = page.locator('[data-activity-id="evening"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".activity-rows-source")).toHaveText(
    "通过口令 开奖口令2026 报名",
  );
});

for (const width of [1440, 768, 375]) {
  test(`history tables remain compact and all cells accessible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const route of ["participations", "manage"]) {
      await page.goto(`/#${route}`);
      const table = page.locator(".compact-activity-table");
      await expect(table).toHaveCount(1);
      const row = table.locator(".compact-activity-row").first();
      const geometry = await row.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        scroll: element.scrollWidth,
      }));
      expect(geometry.height).toBeLessThanOrEqual(width <= 760 ? 200 : 120);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await expect(page.locator(".list-panel__footer")).toBeInViewport();
      if (route === "participations")
        await expect(
          row.getByRole("link", { name: "查看活动", exact: true }),
        ).toBeVisible();
      if (route === "manage") {
        await expect(row.locator(".work-managed-progress")).toBeVisible();
        await expect(row.locator(".row-actions")).toBeVisible();
        if (width === 1440) {
          const actions = await row
            .locator(".row-actions-inline > button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getBoundingClientRect().top),
            );
          expect(new Set(actions).size).toBe(1);
        }
      }
    }
  });
}
