import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const id = (number: number) =>
  `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
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

function managed(page: Page, number: number) {
  return page.locator(`[data-activity-id="${id(number)}"]`);
}

async function changeHash(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

async function setIdentity(page: Page, identity: "standard" | "lite") {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "体验身份", exact: true })
    .selectOption(identity);
  await page.getByRole("button", { name: "场景与身份" }).click();
}

test("author activities paginate 24 records, retain a fixed footer, and reset filters to page one", async ({
  page,
}) => {
  await page.goto("/#manage");
  const filter = page.getByRole("group", { name: "奖励筛选" });
  await expect(filter.getByRole("button")).toHaveText([
    "全部",
    "文本 / CDK",
    "LDC",
  ]);
  await expect(
    page.getByRole("button", { name: "刷新活动列表", exact: true }),
  ).toBeVisible();
  const paging = page.getByRole("navigation", { name: "作者活动分页" });
  await expect(page.getByTestId("managed-activity")).toHaveCount(20);
  await expect(paging.getByRole("button", { name: "上一页" })).toBeDisabled();
  const before = await paging.boundingBox();
  await page
    .locator(".work-list-page .list-panel__scroll")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  const after = await paging.boundingBox();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  await paging.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByTestId("managed-activity")).toHaveCount(4);
  await expect(paging).toContainText("第 2 页");
  await expect(paging.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(managed(page, 21)).toBeVisible();
  await expect(managed(page, 22)).toContainText(
    "CDK 兑换草稿 · 8 份 · 第 3 期",
  );
  await filter.getByRole("button", { name: "文本 / CDK", exact: true }).click();
  await expect(paging).toContainText("第 1 页");
  await expect(page.getByTestId("managed-activity")).toHaveCount(14);
  await expect(paging.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(
    page.getByTestId("managed-activity").locator(".activity-reward-label"),
  ).toHaveText(Array(14).fill("文本 / CDK"));
  await filter.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("managed-activity")).toHaveCount(20);
  await expect(paging).toContainText("第 1 页");
});

test("draft deletion requires confirmation, survives route unmounts, and cannot revive through edit or payment links", async ({
  page,
}) => {
  await page.goto("/#manage");
  const deleting = managed(page, 2).getByRole("button", {
    name: "CDK 兑换码 · 12 份：删除草稿",
  });
  await deleting.click();
  const dialog = page.getByRole("dialog", { name: "确认删除草稿" });
  await expect(dialog).toContainText("CDK 兑换码 · 12 份");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(managed(page, 2)).toBeVisible();
  await deleting.click();
  await dialog.getByRole("button", { name: "删除草稿", exact: true }).click();
  await expect(managed(page, 2)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
  await changeHash(page, "account");
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await changeHash(page, "manage");
  await expect(managed(page, 2)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
  await changeHash(page, `create?edit=${id(2)}`);
  await expect(page.getByRole("heading", { name: "活动不存在" })).toBeVisible();
  await expect(page.locator("#work-title")).toHaveCount(0);
  await changeHash(page, `payment?activity=${id(2)}`);
  await expect(page.getByRole("heading", { name: "活动不存在" })).toBeVisible();
  await expect(page.locator("[data-payment-id]")).toHaveCount(0);
});

test("editing the selected draft loads its complete data and updates the same record", async ({
  page,
}) => {
  await page.goto("/#manage");
  await managed(page, 2)
    .getByRole("button", { name: "CDK 兑换码 · 12 份：编辑草稿" })
    .click();
  await expect(page).toHaveURL(new RegExp(`edit=${id(2)}$`, "u"));
  await expect(page.locator("#work-title")).toHaveValue("CDK 兑换码 · 12 份");
  await expect(page.locator("#work-text-rewards")).toHaveValue(
    Array.from(
      { length: 12 },
      (_, item) => `DEMO-2-${String(item + 1).padStart(3, "0")}`,
    ).join("\n"),
  );
  await expect(page.locator("#work-password-1")).toHaveValue("兑换口令2026");
  await expect(page.locator("#work-topic")).toHaveValue(
    "https://linux.do/t/topic/2964597/1216",
  );
  await expect(
    page.getByRole("checkbox", { name: "仅在活动页兑换", exact: true }),
  ).toBeDisabled();
  await page.locator("#work-title").fill("资料兑换 · 修订版");
  await page.locator("#work-topic").fill("");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示草稿已保存" })
    .getByRole("button", { name: "查看我的活动" })
    .click();
  await expect(managed(page, 2)).toContainText("资料兑换 · 修订版");
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
  await managed(page, 2)
    .getByRole("button", { name: "资料兑换 · 修订版：编辑草稿" })
    .click();
  await expect(page.locator("#work-title")).toHaveValue("资料兑换 · 修订版");
  await expect(page.locator("#work-topic")).toHaveValue("");
  await expect(page.locator("#work-password-1")).toHaveValue("兑换口令2026");
});

test("published editing preserves rewards and payment relations while opening the selected activity", async ({
  page,
}) => {
  await page.goto("/#manage");
  await managed(page, 1)
    .getByRole("button", { name: "周末红包 · 20 份：编辑配置", exact: true })
    .click();
  await expect(page.locator("#work-fixed-amount")).toHaveValue("0.88");
  await expect(page.locator("#work-fixed-count")).toHaveValue("20");
  await expect(page.locator("#work-fixed-amount")).toBeDisabled();
  await expect(page.locator("#work-fixed-count")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "限时开奖", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: "加入活动广场", exact: true }),
  ).toBeDisabled();
  await page.locator("#work-title").fill("周末红包 · 修订标题");
  await page
    .locator("#work-topic")
    .fill("https://linux.do/t/topic/2964597/1217");
  await page.locator(".work-more-settings > summary").click();
  await page
    .getByRole("group", { name: "数量展示", exact: true })
    .getByRole("button", { name: "模糊", exact: true })
    .click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示活动已更新" })
    .getByRole("button", { name: "查看活动", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`sample=${id(1)}$`, "u"));
  await expect(
    page.getByRole("heading", { name: "周末红包 · 修订标题", exact: true }),
  ).toBeVisible();
  await changeHash(page, "manage");
  await expect(managed(page, 1).locator(".activity-reward-summary")).toHaveText(
    "17.60 LDC 奖池",
  );
  await expect(managed(page, 1)).toContainText("进行中");
  await managed(page, 1)
    .getByRole("button", { name: "周末红包 · 修订标题：付款记录" })
    .click();
  await expect(page.locator(".work-payment-scope")).toContainText(
    "周末红包 · 修订标题",
  );
  const payments = page.locator("[data-payment-id]");
  await expect(payments).toHaveCount(8);
  await expect(payments.locator(".work-payment-value > strong")).toHaveText(
    Array(8).fill("0.88LDC"),
  );
});

test("author fixtures include four LDC modes and protect an open draw with accepted registrations", async ({
  page,
}) => {
  await page.goto("/#manage");
  for (const label of [
    "固定均分",
    "即时随机",
    "自定义金额",
    "限时开奖",
    "文本 / CDK",
  ]) {
    await expect(page.locator(".work-managed-list")).toContainText(label);
  }
  for (const [number, summary] of [
    [1, "17.60 LDC 奖池"],
    [3, "25.80 LDC 奖池"],
    [5, "20.00 LDC 奖池"],
    [9, "20.00 LDC 奖池"],
    [2, "12 份 文本 / CDK"],
  ] as const) {
    await expect(
      managed(page, number).locator(".activity-reward-summary"),
    ).toHaveText(summary);
  }
  await expect(managed(page, 10)).toContainText("CDK 兑换码 · 8 份 · 第 2 期");
  await expect(managed(page, 14)).toContainText(
    "CDK 兑换草稿 · 8 份 · 第 2 期",
  );
  await expect(managed(page, 18)).toContainText("CDK 兑换码 · 8 份 · 第 3 期");
  await expect(managed(page, 9)).toContainText("30 人");
  await expect(managed(page, 9)).toContainText("已报名");
  await expect(
    managed(page, 9).getByRole("button", { name: /提前结束/u }),
  ).toHaveCount(0);
  await managed(page, 9)
    .getByRole("button", { name: "限时开奖 · 10 个获奖名额：付款记录" })
    .click();
  await expect(page.locator("[data-payment-id]")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "当前活动暂无匹配的发放目标",
  );
  await changeHash(page, "manage");
  await managed(page, 3)
    .getByRole("button", { name: "十月第一期红包：编辑配置", exact: true })
    .click();
  await expect(page.locator("#work-custom-amounts")).toHaveValue(
    Array.from(
      { length: 30 },
      (_, item) => ["0.50", "0.88", "1.20"][item % 3],
    ).join("\n"),
  );
  await expect(page.locator("#work-custom-amounts")).toBeDisabled();
  await expect(
    page.getByRole("complementary", { name: "活动摘要" }),
  ).toContainText("25.80");
  await expect(page.locator(".work-summary-plan")).toHaveText(
    "自定义金额 · 30 份奖励",
  );
});

test("payment pagination selects a record on the current page and scoped links preserve the related activity", async ({
  page,
}) => {
  await page.goto("/#payment");
  await expect(
    page.getByRole("tablist", { name: "付款活动状态筛选" }),
  ).toContainText("进行中");
  await expect(
    page.locator(".work-payment-activity-row").first(),
  ).toContainText("周末红包 · 20 份");
  await expect(page.getByRole("button", { name: /接入验收付款/u })).toHaveCount(
    0,
  );
  await page
    .locator(".work-payment-activity-row")
    .filter({
      hasText: /^十月第一期红包已结束/u,
    })
    .click();
  await expect(page.locator(".work-payment-heading-tools")).toContainText(
    "待完成",
  );
  await expect(page.locator(".work-payment-heading-tools")).toContainText(
    "已发放",
  );
  const activityBounds = await page
    .locator(".work-payment-activities")
    .boundingBox();
  const targetBounds = await page
    .locator(".work-payment-targets")
    .boundingBox();
  const detailBounds = await page.locator(".work-payment-detail").boundingBox();
  expect((activityBounds?.width ?? 0) < (targetBounds?.width ?? 0)).toBe(true);
  expect((detailBounds?.width ?? 0) > (targetBounds?.width ?? 0)).toBe(true);
  expect(activityBounds?.width).toBeCloseTo(224, 0);
  expect(targetBounds?.width).toBeCloseTo(288, 0);
  await expect(page.locator("[data-payment-id]")).toHaveCount(20);
  await page.locator('[data-payment-id="HB202610060002"]').click();
  await expect(page.locator(".work-payment-detail")).toContainText(
    "CLAIM-000003-002",
  );
  await expect(page.locator(".work-payment-detail")).toContainText("发放金额");
  await expect(page.locator(".work-payment-detail")).toContainText("收款目标");
  await expect(page.locator(".work-payment-detail")).toContainText(
    "订单与时间",
  );
  await expect(page.locator(".work-payment-detail")).toContainText(
    "本站业务号",
  );
  await expect(page.locator(".work-payment-detail")).toContainText(
    "本站确认发放时间",
  );
  await expect(
    page.locator(".work-payment-detail .work-payment-facts").first(),
  ).toHaveCSS("display", "grid");
  await expect(page.locator(".work-payment-detail")).not.toContainText(
    "处理记录",
  );
  await expect(page.locator(".work-payment-detail")).not.toContainText(
    "配置与更正",
  );
  await expect(page.locator(".work-payment-detail")).not.toContainText(
    "付款任务",
  );
  await page.locator('[data-payment-id="HB202610060003"]').click();
  await expect(page.locator(".work-payment-detail")).toContainText("等待恢复");
  await expect(page.locator(".work-payment-detail")).toContainText(
    "上游交易号",
  );
  await expect(page.locator(".work-payment-detail")).toContainText(
    "LDC-PENDING-1203",
  );
  await expect(
    page.getByRole("navigation", { name: "发放目标分页" }),
  ).toContainText("第 1 页");
  await page
    .getByRole("tablist", { name: "发放目标状态筛选" })
    .getByRole("tab", { name: /已发放/u })
    .click();
  await expect(
    page.getByRole("navigation", { name: "发放目标分页" }),
  ).toContainText("第 1 页");
  await expect(page.locator("[data-payment-id]")).toHaveCount(10);
  await expect(page.locator(".work-payment-detail")).toContainText(
    "CLAIM-000003-002",
  );
  await page
    .locator(".work-payment-detail")
    .getByRole("button", { name: "查看关联活动" })
    .click();
  await expect(page).toHaveURL(new RegExp(`sample=${id(3)}$`, "u"));
  await expect(
    page.getByRole("heading", { name: "十月第一期红包", exact: true }),
  ).toBeVisible();
});

test("mobile row actions escape the list, support keyboard navigation, and return focus on Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#manage");
  const trigger = managed(page, 2).getByRole("button", {
    name: "CDK 兑换码 · 12 份操作",
  });
  const bounds = await trigger.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(36);
  expect(bounds?.height).toBeGreaterThanOrEqual(36);
  await expect(managed(page, 2).locator(".row-actions-inline")).toBeHidden();
  await trigger.click();
  const menu = page.getByRole("menu", { name: "CDK 兑换码 · 12 份操作" });
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((element) =>
      element.parentElement?.classList.contains("site-main"),
    ),
  ).toBe(true);
  await expect(
    menu.getByRole("menuitem", { name: "删除草稿", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "删除草稿", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const activeTrigger = managed(page, 1).getByRole("button", {
    name: "周末红包 · 20 份操作",
  });
  await activeTrigger.click();
  const activeMenu = page.getByRole("menu", { name: "周末红包 · 20 份操作" });
  await expect(
    activeMenu.getByRole("menuitem", { name: "编辑配置", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    activeMenu.getByRole("menuitem", { name: "尝试统计", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    activeMenu.getByRole("menuitem", { name: "付款记录", exact: true }),
  ).toBeFocused();
  await expect(
    activeMenu.getByRole("menuitem", { name: /提前结束/u }),
  ).toHaveCount(0);
  await expect(activeMenu.getByRole("separator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await trigger.click();
  await page.getByRole("heading", { name: "活动历史", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await managed(page, 2)
    .getByRole("button", { name: "CDK 兑换码 · 12 份：编辑草稿" })
    .click();
  await expect(page.locator("#work-title")).toHaveValue("CDK 兑换码 · 12 份");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test("mobile payment details open for the chosen row without adding a second list scroll region", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#payment");
  await page
    .locator(".work-payment-activity-row")
    .filter({
      hasText: /^十月第一期红包已结束/u,
    })
    .click();
  await page.locator('[data-payment-id="HB202610060002"]').click();
  const detail = page.getByRole("dialog", { name: "付款详情" });
  await expect(detail).toContainText("CLAIM-000003-002");
  await expect(detail).toContainText("收款目标");
  await expect(detail).toContainText("本站业务号");
  await expect(detail.locator(".work-payment-attempt")).toHaveCount(0);
  await expect(page.locator(".work-payment-detail")).toBeHidden();
  await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await page
    .getByRole("tablist", { name: "发放目标状态筛选" })
    .getByRole("tab", { name: /已发放/u })
    .click();
  await page.locator('[data-payment-id="HB202610060005"]').click();
  await expect(detail).toContainText("CLAIM-000003-005");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test("author and payment list states hide stale rows and retry through the common panel", async ({
  page,
}) => {
  for (const route of ["manage", "payment"]) {
    await page.goto(`/#${route}`);
    for (const state of ["loading", "empty", "error"]) {
      await page.getByRole("button", { name: "场景与身份" }).click();
      await page
        .getByRole("combobox", { name: "列表场景", exact: true })
        .selectOption(state);
      await page.getByRole("button", { name: "场景与身份" }).click();
      const panels = page.locator(".work-list-page .list-panel");
      await expect(panels.first()).toHaveAttribute("data-state", state);
      await expect(
        page.locator("[data-payment-id], [data-testid='managed-activity']"),
      ).toHaveCount(0);
      if (state === "loading") {
        await expect(page.getByRole("status").first()).toHaveText("正在加载…");
        for (const button of await page
          .locator(".work-list-page .list-panel__footer button")
          .all())
          await expect(button).toBeDisabled();
      } else if (state === "empty") {
        await expect(page.getByRole("status").first()).toHaveText(
          route === "manage" ? "暂无活动" : "暂无可查看付款的红包活动",
        );
      } else {
        await expect(panels.first().getByRole("alert")).toHaveText(
          "加载失败，请重试。",
        );
        await panels
          .first()
          .getByRole("button", { name: "重试", exact: true })
          .click();
        await expect(panels.first()).toHaveAttribute("data-state", "ready");
        await expect(
          page.locator("[data-payment-id], [data-testid='managed-activity']"),
        ).toHaveCount(route === "manage" ? 20 : 8);
      }
    }
  }
});

test("author records are isolated by identity and reset only after a browser refresh", async ({
  page,
}) => {
  await page.goto("/#manage");
  await managed(page, 2)
    .getByRole("button", { name: "CDK 兑换码 · 12 份：删除草稿" })
    .click();
  await page
    .getByRole("dialog", { name: "确认删除草稿" })
    .getByRole("button", { name: "删除草稿", exact: true })
    .click();
  await expect(managed(page, 2)).toHaveCount(0);
  await setIdentity(page, "lite");
  await expect(
    page.locator('[data-activity-id="21000000-0000-4000-8000-000000000002"]'),
  ).toBeVisible();
  await expect(managed(page, 2)).toHaveCount(0);
  await expect(page.locator(".work-managed-list")).not.toContainText("LDC");
  await setIdentity(page, "standard");
  await expect(managed(page, 2)).toHaveCount(0);
  await page.reload();
  await expect(managed(page, 2)).toBeVisible();
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
});

test("form segmented controls retain plan inputs and fit a 375px screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#create");
  const plans = page.getByRole("group", { name: "LDC 奖励方式" });
  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await page.locator("#work-random-amount").fill("42.50");
  const algorithm = page.getByRole("group", { name: "随机算法" });
  await algorithm
    .getByRole("button", { name: "均值上下 50%", exact: true })
    .click();
  await plans.getByRole("button", { name: "限时开奖", exact: true }).click();
  await expect(page.locator("#work-draw-seconds")).toHaveValue("600");
  await expect(page.locator("#work-draw-limit")).toHaveValue("");
  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await expect(page.locator("#work-random-amount")).toHaveValue("42.50");
  await expect(
    algorithm.getByRole("button", { name: "均值上下 50%", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await plans.getByRole("button", { name: "自定义金额", exact: true }).click();
  await page
    .getByRole("group", { name: "发放顺序" })
    .getByRole("button", { name: "随机", exact: true })
    .click();
  await page.locator("#work-custom-amounts").fill("0.50\n1.25");
  await plans.getByRole("button", { name: "固定均分", exact: true }).click();
  await plans.getByRole("button", { name: "自定义金额", exact: true }).click();
  await expect(page.locator("#work-custom-amounts")).toHaveValue("0.50\n1.25");
  await expect(
    page
      .getByRole("group", { name: "发放顺序" })
      .getByRole("button", { name: "随机", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("group", { name: "奖励类型" })
    .getByRole("button", { name: "文本 / CDK", exact: true })
    .click();
  await page.locator(".work-more-settings > summary").click();
  await page
    .getByRole("group", { name: "数量展示" })
    .getByRole("button", { name: "模糊", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "开放时长单位", exact: true }),
  ).toContainText("小时");
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    main: document.querySelector(".site-main")?.scrollWidth,
    inputs: Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        ".work-editor input:not([type='checkbox']), .work-editor textarea",
      ),
    ).map((input) => input.getBoundingClientRect().right),
  }));
  expect(widths.page).toBeLessThanOrEqual(375);
  expect(widths.main).toBeLessThanOrEqual(375);
  for (const right of widths.inputs) expect(right).toBeLessThanOrEqual(375);
});

test("repeated draft saves reuse one record and opening publishes the edited inventory", async ({
  page,
}) => {
  await page.goto("/#create");
  await page
    .getByRole("group", { name: "奖励类型" })
    .getByRole("button", { name: "文本 / CDK", exact: true })
    .click();
  await page.locator("#work-title").fill("本地文本活动");
  await page.locator("#work-text-rewards").fill("FIRST-CDK\n    \nSECOND-CDK");
  await page.locator("#work-password-1").fill("本地文本口令");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "演示草稿已保存" });
  await confirmation
    .getByRole("button", { name: "继续编辑", exact: true })
    .click();
  await page.locator("#work-title").fill("本地文本活动 · 更新");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await confirmation.getByRole("button", { name: "查看我的活动" }).click();
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
  const saved = page.getByTestId("managed-activity").first();
  await expect(saved).toContainText("本地文本活动 · 更新");
  await expect(saved).toContainText("2 份 文本 / CDK");
  const savedId = await saved.getAttribute("data-activity-id");
  expect(savedId).toMatch(/^[0-9a-f-]{36}$/u);
  await saved
    .getByRole("button", { name: "本地文本活动 · 更新：编辑草稿" })
    .click();
  await expect(page.locator("#work-text-rewards")).toHaveValue(
    "FIRST-CDK\n    \nSECOND-CDK",
  );
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await page
    .getByRole("dialog", { name: "演示活动已开放" })
    .getByRole("button", { name: "查看活动", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`sample=${savedId}$`, "u"));
  await expect(
    page.getByRole("heading", { name: "本地文本活动 · 更新", exact: true }),
  ).toBeVisible();
  await changeHash(page, "manage");
  await expect(page.getByRole("group", { name: "奖励筛选" })).toContainText(
    "全部",
  );
  await expect(page.locator(`[data-activity-id="${savedId}"]`)).toContainText(
    "进行中",
  );
  await expect(page.locator(`[data-activity-id="${savedId}"]`)).toContainText(
    "2 份 文本 / CDK",
  );
});
