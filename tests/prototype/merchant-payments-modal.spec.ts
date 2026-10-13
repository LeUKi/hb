import { test as base, expect } from "@playwright/test";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const requests: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin !== "http://127.0.0.1:4177" ||
          /^\/api(?:\/|$)/u.test(url.pathname)
        ) {
          requests.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(requests).toEqual([]);
    },
    { auto: true },
  ],
});

test("商户保存仅在有效修改后启用，保存和刷新更新基线", async ({ page }) => {
  await page.goto("/#merchant");
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  await expect(save).toBeDisabled();
  const name = page.getByLabel("商户名称", { exact: true });
  await name.fill("演示新名称");
  await expect(save).toBeEnabled();
  await name.fill("默认商户");
  await expect(save).toBeDisabled();
  await name.fill("演示新名称");
  await save.click();
  await expect(
    page.getByText("演示配置已保存。", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  const client = page.getByLabel("Client ID", { exact: true });
  await client.fill("NEW-DEMO-CLIENT");
  await expect(save).toBeDisabled();
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-SECRET");
  await expect(save).toBeEnabled();
  await save.click();
  await page.getByRole("button", { name: "确认并保存", exact: true }).click();
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveValue("");
  await name.fill("刷新丢弃的名称");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(name).toHaveValue("刷新丢弃的名称");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(name).toHaveValue("演示新名称");
  await expect(save).toBeDisabled();
});

test("未配置商户只有完整输入才可创建，创建后禁用保存", async ({ page }) => {
  await page.goto("/#merchant?newMerchant=1");
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("商户名称", { exact: true }).fill("新商户");
  await page.getByLabel("Client ID", { exact: true }).fill("LOCAL-NEW");
  await expect(save).toBeDisabled();
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-NEW");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveValue("");
});

test("付款表分页及阅读位置刷新恢复，详情直链关闭留在配置", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto("/#merchant");
  await page.getByRole("button", { name: "付款记录", exact: true }).click();
  const list = page.getByRole("dialog", { name: "付款记录", exact: true });
  await list
    .getByRole("navigation", { name: "商户付款记录分页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(
    list.getByRole("navigation", { name: "商户付款记录分页" }),
  ).toContainText("第 2 页");
  const scroll = list.locator(".merchant-payments-content");
  await scroll.evaluate((node) => {
    node.scrollTop = 150;
  });
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(150);
  await page.reload();
  await expect(
    list.getByRole("navigation", { name: "商户付款记录分页" }),
  ).toContainText("第 2 页");
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(150);
  const paymentId = await list
    .locator("tbody tr")
    .first()
    .getAttribute("data-payment-id");
  await page.goto(`/#merchant?dialog=merchant-payments&paymentId=${paymentId}`);
  await expect(
    page.getByRole("dialog", { name: "付款详情", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回付款记录", exact: true }).click();
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page).toHaveURL(/#merchant$/u);
});

test("原订单密钥修复取消返回保留输入，确认返回丢弃且不持久化", async ({
  page,
}) => {
  await page.goto("/#merchant");
  const outerSecret = page.getByLabel("商户密钥", { exact: true });
  await outerSecret.fill("VIRTUAL-OUTER");
  await page.getByRole("button", { name: "付款记录", exact: true }).click();
  const list = page.getByRole("dialog", { name: "付款记录", exact: true });
  await list
    .locator('tr[data-payment-status="waiting"]')
    .first()
    .getByRole("button", { name: "查看详情", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  const secret = detail.getByLabel("原订单商户密钥", { exact: true });
  await secret.fill("VIRTUAL-UNSAVED-REPAIR");
  page.once("dialog", (dialog) => dialog.dismiss());
  await detail
    .getByRole("button", { name: "返回付款记录", exact: true })
    .click();
  await expect(secret).toHaveValue("VIRTUAL-UNSAVED-REPAIR");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(secret).toHaveValue("VIRTUAL-UNSAVED-REPAIR");
  page.once("dialog", (dialog) => dialog.accept());
  await detail
    .getByRole("button", { name: "返回付款记录", exact: true })
    .click();
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(outerSecret).toHaveValue("VIRTUAL-OUTER");
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
  ).not.toContain("VIRTUAL-");
});

test("商户配置的站内导航及系统返回取消保留输入，确认才离开", async ({
  page,
}) => {
  await page.goto("/#account");
  await page.getByRole("button", { name: "商户配置", exact: true }).click();
  const name = page.getByLabel("商户名称", { exact: true });
  await name.fill("尚未保存的商户");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "我的", exact: true }).first().click();
  await expect(name).toHaveValue("尚未保存的商户");
  await expect(page).toHaveURL(/#merchant$/u);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "我的", exact: true }).first().click();
  await expect(page).toHaveURL(/#account$/u);
  await page.getByRole("button", { name: "商户配置", exact: true }).click();
  const secret = page.getByLabel("商户密钥", { exact: true });
  await secret.fill("VIRTUAL-UNSAVED-CONFIG");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goBack();
  await expect(secret).toHaveValue("VIRTUAL-UNSAVED-CONFIG");
  await expect(page).toHaveURL(/#merchant$/u);
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/#account$/u);
  await page.getByRole("button", { name: "商户配置", exact: true }).click();
  await expect(secret).toHaveValue("");
});

for (const nativeNavigation of [true, false]) {
  test(`原订单密钥修改时取消前进恢复原详情和 URL，确认前进才离开 ${nativeNavigation ? "原生" : "兼容"}历史`, async ({
    page,
  }) => {
    if (!nativeNavigation)
      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { value: undefined });
      });
    await page.goto("/#merchant");
    await page.getByRole("button", { name: "付款记录", exact: true }).click();
    await page
      .getByRole("dialog", { name: "付款记录", exact: true })
      .locator('tr[data-payment-status="waiting"]')
      .first()
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    const detailUrl = page.url();
    await detail.locator(".merchant-payment-facts").getByRole("button").click();
    await expect(page).toHaveURL(/#activity\?/u);
    await page.goBack();
    await expect(detail).toBeVisible();
    const secret = detail.getByLabel("原订单商户密钥", { exact: true });
    await secret.fill("VIRTUAL-UNSAVED-FORWARD");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.goForward();
    await expect(secret).toHaveValue("VIRTUAL-UNSAVED-FORWARD");
    await expect(page).toHaveURL(detailUrl);
    page.once("dialog", (dialog) => dialog.accept());
    await page.goForward();
    await expect(page).toHaveURL(/#activity\?/u);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  });

  test(`接受原单离开但取消商户配置离开时，两个表单均保留 ${nativeNavigation ? "原生" : "兼容"}历史`, async ({
    page,
  }) => {
    if (!nativeNavigation)
      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { value: undefined });
      });
    await page.goto("/#account");
    await page.getByRole("button", { name: "商户配置", exact: true }).click();
    const name = page.getByLabel("商户名称", { exact: true });
    await name.fill("尚未保存的商户名称");
    await page.getByRole("button", { name: "付款记录", exact: true }).click();
    await page
      .getByRole("dialog", { name: "付款记录", exact: true })
      .locator('tr[data-payment-status="waiting"]')
      .first()
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    const secret = detail.getByLabel("原订单商户密钥", { exact: true });
    await secret.fill("VIRTUAL-KEEP-BOTH-FORMS");
    const originalUrl = page.url();
    const confirmations: string[] = [];
    page.on("dialog", async (dialog) => {
      confirmations.push(dialog.message());
      if (dialog.message().includes("原订单凭证")) await dialog.accept();
      else await dialog.dismiss();
    });
    await detail.locator(".merchant-payment-facts").getByRole("button").click();
    await expect(detail).toBeVisible();
    await expect(secret).toHaveValue("VIRTUAL-KEEP-BOTH-FORMS");
    await expect(name).toHaveValue("尚未保存的商户名称");
    await expect(page).toHaveURL(originalUrl);
    expect(confirmations).toEqual([
      "还有未保存的原订单凭证，确定离开吗？",
      "还有未保存的商户配置，确定离开吗？",
    ]);
  });

  test(`取消多步系统返回恢复原详情及两个表单 ${nativeNavigation ? "原生" : "兼容"}历史`, async ({
    page,
  }) => {
    if (!nativeNavigation)
      await page.addInitScript(() => {
        Object.defineProperty(window, "navigation", { value: undefined });
      });
    await page.goto("/#account");
    await page.getByRole("button", { name: "商户配置", exact: true }).click();
    const name = page.getByLabel("商户名称", { exact: true });
    await name.fill("多步返回仍保留的商户名称");
    await page.getByRole("button", { name: "付款记录", exact: true }).click();
    await page
      .getByRole("dialog", { name: "付款记录", exact: true })
      .locator('tr[data-payment-status="waiting"]')
      .first()
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    const secret = detail.getByLabel("原订单商户密钥", { exact: true });
    await secret.fill("VIRTUAL-KEEP-MULTI-BACK");
    const originalUrl = page.url();
    let allowOuter = false;
    const confirmations: string[] = [];
    page.on("dialog", async (dialog) => {
      confirmations.push(dialog.message());
      if (dialog.message().includes("原订单凭证") || allowOuter)
        await dialog.accept();
      else await dialog.dismiss();
    });
    await page.evaluate(() => window.history.go(-3));
    await expect(secret).toHaveValue("VIRTUAL-KEEP-MULTI-BACK");
    await expect(name).toHaveValue("多步返回仍保留的商户名称");
    await expect(page).toHaveURL(originalUrl);
    expect(confirmations).toEqual([
      "还有未保存的原订单凭证，确定离开吗？",
      "还有未保存的商户配置，确定离开吗？",
    ]);
    allowOuter = true;
    await page.evaluate(() => window.history.go(-3));
    await expect(page).toHaveURL(/#account$/u);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(confirmations).toHaveLength(4);
  });
}

for (const width of [1440, 375]) {
  test(`付款详情的 X、Esc 和遮罩关闭整个弹窗 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/#merchant");
    const trigger = page.getByRole("button", { name: "付款记录", exact: true });
    for (const method of ["button", "escape", "backdrop"]) {
      await trigger.click();
      await page
        .getByRole("dialog", { name: "付款记录", exact: true })
        .getByRole("button", { name: "查看详情", exact: true })
        .first()
        .click();
      const detail = page.getByRole("dialog", {
        name: "付款详情",
        exact: true,
      });
      await expect(detail).toBeVisible();
      if (method === "button")
        await detail
          .getByRole("button", { name: "关闭付款详情", exact: true })
          .click();
      else if (method === "escape") await page.keyboard.press("Escape");
      else await page.mouse.click(2, 2);
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page).toHaveURL(/#merchant$/u);
      await expect(trigger).toBeFocused();
    }
  });

  test(`商户付款表和详情共用弹窗，历史与焦点恢复 ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#merchant");
    const input = page.getByLabel("商户密钥", { exact: true });
    await input.fill("VIRTUAL-UNSAVED");
    const trigger = page.getByRole("button", {
      name: "付款记录",
      exact: true,
    });
    await trigger.click();
    const list = page.getByRole("dialog", { name: "付款记录", exact: true });
    await expect(list).toBeVisible();
    const table = list.getByRole("table", {
      name: "商户付款记录",
      exact: true,
    });
    await expect(table.getByRole("columnheader")).toHaveText([
      "金额",
      "状态",
      "来源",
      "业务号",
      "创建时间",
      "操作",
    ]);
    await expect(table.locator("tbody tr")).toHaveCount(20);
    const rowHeight = await table
      .locator("tbody tr")
      .first()
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(rowHeight).toBeGreaterThanOrEqual(44);
    expect(rowHeight).toBeLessThanOrEqual(48);
    const dimensions = await list.boundingBox();
    expect(dimensions?.width).toBeLessThanOrEqual(
      width === 375 ? width - 24 : 960,
    );
    expect(dimensions?.height).toBeLessThanOrEqual(800 * 0.85 + 1);
    const row = table.locator("tbody tr").first();
    const detailTrigger = row.getByRole("button", {
      name: "查看详情",
      exact: true,
    });
    await detailTrigger.click();
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    await expect(detail).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    await expect(
      detail.getByRole("list", { name: "付款时间线" }),
    ).toBeVisible();
    await expect(
      detail.getByRole("list", { name: "付款时间线" }).locator("li > span"),
    ).toHaveText(["创建付款"]);
    await expect(
      detail.getByRole("table", { name: "付款处理记录" }),
    ).toBeVisible();
    await expect(
      detail.getByLabel("原订单商户密钥", { exact: true }),
    ).toHaveCount(0);
    await expect(detail).not.toContainText(
      /凭证版本|身份更正版本|检查恢复条件|凭证检查/,
    );
    await page.goBack();
    await expect(list).toBeVisible();
    await expect(detailTrigger).toBeFocused();
    await page.goForward();
    await expect(detail).toBeVisible();
    await page.reload();
    await expect(detail).toBeVisible();
    await detail
      .getByRole("button", { name: "返回付款记录", exact: true })
      .click();
    await expect(list).toBeVisible();
    const waiting = table
      .locator('tbody tr[data-payment-status="waiting"]')
      .first();
    await waiting
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    await expect(
      detail.getByLabel("原订单商户密钥", { exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("list", { name: "付款时间线" }).locator("li > span"),
    ).toHaveText(["创建付款", "首次发送"]);
    const repair = detail.getByRole("button", {
      name: "保存原订单凭证",
      exact: true,
    });
    await expect(repair).toBeDisabled();
    await detail
      .getByLabel("原订单商户密钥", { exact: true })
      .fill("VIRTUAL-ORIGINAL");
    await expect(repair).toBeEnabled();
    await repair.click();
    await expect(
      detail.getByLabel("原订单商户密钥", { exact: true }),
    ).toHaveValue("");
    await expect(
      detail.getByText("演示原订单凭证已保存。", { exact: true }),
    ).toBeVisible();
    await detail
      .getByRole("button", { name: "返回付款记录", exact: true })
      .click();
    await expect(list).toBeVisible();
    await table
      .locator('tbody tr[data-payment-status="confirmed"]')
      .first()
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    const timeline = detail.getByRole("list", { name: "付款时间线" });
    await expect(timeline.locator("li > span")).toHaveText([
      "创建付款",
      "首次发送",
      "收到分发响应",
      "查到订单",
      "本站确认发放",
    ]);
    const times = await timeline
      .locator("time")
      .evaluateAll((nodes) =>
        nodes.map((node) => Date.parse(node.getAttribute("datetime") ?? "")),
      );
    expect(
      times.every((at, index) => index === 0 || at >= (times[index - 1] ?? at)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(input).toHaveValue("");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
    ).not.toContain("VIRTUAL-");
  });
}

test("付款工作台保持三栏，处理详情接入共用弹窗且手机不叠加模态", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/#payment");
  await expect(page.locator(".work-payment-detail")).toBeVisible();
  await page
    .locator(".work-payment-detail")
    .getByRole("button", { name: "查看处理详情", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "付款详情", exact: true })
      .getByRole("table", { name: "付款处理记录" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page
      .locator(".work-payment-detail")
      .getByRole("button", { name: "查看处理详情", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.locator(".work-payment-activity-row").first().click();
  await page.locator(".work-payment-row").first().click();
  const summary = page.getByRole("dialog", { name: "付款详情", exact: true });
  await summary
    .getByRole("button", { name: "查看处理详情", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(
    summary.getByRole("table", { name: "付款处理记录" }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    summary.getByRole("button", { name: "查看处理详情", exact: true }),
  ).toBeFocused();
});
