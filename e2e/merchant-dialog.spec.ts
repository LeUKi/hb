import { expect, test } from "@playwright/test";
import {
  merchantId,
  mockMerchantConfig,
  paymentId,
} from "./fixtures/merchant-config";

test("商户配置按实际修改启用保存，打开付款表不丢配置输入", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  await page.goto("/my/merchants");
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  const name = page.getByLabel("商户名称", { exact: true });
  await expect(save).toBeDisabled();
  await name.fill("修改名称");
  await expect(save).toBeEnabled();
  await name.fill(state.merchant.label);
  await expect(save).toBeDisabled();
  await name.fill("待保存名称");
  await page.getByRole("link", { name: "付款记录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "付款记录", exact: true });
  await expect(
    dialog.getByRole("table", { name: "商户付款记录" }),
  ).toBeVisible();
  await expect(dialog.getByRole("columnheader")).toHaveText([
    "金额",
    "状态",
    "来源",
    "业务号",
    "创建时间",
    "操作",
  ]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(name).toHaveValue("待保存名称");
  await expect(
    page.getByRole("link", { name: "付款记录", exact: true }),
  ).toBeFocused();
  expect(state.retiredRequests).toEqual([]);
});

test("旧商户和付款路径只恢复同一弹窗，返回前进和刷新保留视图", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  await page.goto(`/my/merchants/${merchantId}`);
  await expect(page).toHaveURL(
    new RegExp(`/my/merchants\\?merchantId=${merchantId}&dialog=payments$`),
  );
  const list = page.getByRole("dialog", { name: "付款记录", exact: true });
  await list.getByRole("link", { name: "查看详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  await expect(
    detail.getByRole("table", { name: "付款处理记录" }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`dialog=payment&taskId=${paymentId}$`),
  );
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(
    list.getByRole("link", { name: "查看详情", exact: true }),
  ).toBeFocused();
  await page.goForward();
  await expect(detail).toBeVisible();
  await page.reload();
  await expect(detail).toBeVisible();
  await detail
    .getByRole("button", { name: "关闭付款详情", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "商户配置", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /付款凭证版本|身份更正版本|立即检查恢复条件|凭证检查与异常恢复/,
    ),
  ).toHaveCount(0);
  expect(state.retiredRequests).toEqual([]);
});

test("同版本刷新成功才重置配置，失败保留输入", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  await page.goto("/my/merchants");
  const name = page.getByLabel("商户名称", { exact: true });
  await name.fill("未保存修改");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(name).toHaveValue("未保存修改");
  state.failRead = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    page.getByText("刷新失败，请重试。", { exact: true }),
  ).toBeVisible();
  await expect(name).toHaveValue("未保存修改");
  state.failRead = false;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(name).toHaveValue(state.merchant.label);
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
});

test("保存后的新修改重新启用保存与离开保护，后台读取不覆盖表单", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockMerchantConfig(page);
  await page.goto("/my/merchants");
  const name = page.getByLabel("商户名称", { exact: true });
  const save = page.getByRole("button", { name: "保存配置", exact: true });
  await name.fill("第一次保存");
  await save.click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await name.fill("再次修改");
  state.merchant = {
    ...state.merchant,
    label: "后台更新",
    version: state.merchant.version + 1,
  };
  await page.clock.runFor(16_000);
  await expect(name).toHaveValue("再次修改");
  await expect(save).toBeEnabled();
  const cancelled = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await cancelled;
  await expect(name).toHaveValue("再次修改");
  await expect(page).toHaveURL(/\/my\/merchants$/);
  expect(state.updates).toHaveLength(1);
});

test("保存权限失效立即撤下输入，未知商户不会切换到默认商户", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  await page.goto("/my/merchants");
  await page.getByLabel("商户名称", { exact: true }).fill("私有修改");
  state.denyAccess = true;
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByText("未找到商户，或你无权查看。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("商户名称", { exact: true })).toHaveCount(0);
  state.denyAccess = false;
  for (const id of ["missing-merchant", ""]) {
    state.resourceReads = [];
    await page.goto(`/my/merchants?merchantId=${id}`);
    await expect(
      page.getByText("未找到商户，或你无权查看。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("商户名称", { exact: true })).toHaveCount(0);
    expect(state.resourceReads).toEqual([]);
  }
  expect(state.retiredRequests).toEqual([]);
});

test("无效与缺失付款目标显示未找到，不恢复其他记录或发起目标读取", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  for (const task of ["missing-task", ""]) {
    state.resourceReads = [];
    await page.goto(
      `/my/merchants?merchantId=${merchantId}&dialog=payment${task ? `&taskId=${task}` : ""}`,
    );
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    await expect(
      detail.getByText("未找到付款任务，或你无权查看。", { exact: true }),
    ).toBeVisible();
    await expect(detail.getByRole("table")).toHaveCount(0);
    expect(
      state.resourceReads.some((path) => path.includes("/payments/")),
    ).toBe(false);
  }
  state.resourceReads = [];
  await page.goto(`/my/merchants?dialog=payment&taskId=${paymentId}`);
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  await expect(
    detail.getByText("未找到付款任务，或你无权查看。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("商户名称", { exact: true })).toHaveCount(0);
  expect(state.resourceReads).toEqual([]);
});

for (const width of [1440, 375]) {
  test(`付款弹窗 ${width}px 紧凑表格独立横向滚动，详情不重复金额`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await mockMerchantConfig(page);
    await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("0.10 LDC", { exact: true })).toHaveCount(1);
    await expect(
      detail.getByRole("list", { name: "付款时间线" }),
    ).toBeVisible();
    const dimensions = await detail.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(Math.min(960, width - 24));
    expect(dimensions.height).toBeLessThanOrEqual(
      dimensions.viewportHeight * 0.85 + 1,
    );
    expect(dimensions.documentWidth).toBeLessThanOrEqual(width);
    await expect(
      page.getByRole("button", { name: /检查恢复条件|凭证检查/ }),
    ).toHaveCount(0);
  });
}
