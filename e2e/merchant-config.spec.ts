import { expect, test } from "@playwright/test";
import {
  merchantId,
  mockMerchantConfig,
  paymentId,
} from "./fixtures/merchant-config";

function merchantSaveButton(page: import("@playwright/test").Page) {
  return page.locator(".work-merchant-actions button[type='submit']");
}

function originalOrderSaveButton(page: import("@playwright/test").Page) {
  return page.locator(
    ".merchant-payment-repair__actions button[type='submit']",
  );
}

test("同一商户 Client ID 可编辑，改应用必须同时填写对应密钥", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("Client ID", { exact: true }).fill("corrected_client");
  await expect(
    page.getByRole("button", { name: "保存配置", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/修改 Client ID 时，请同时填写/)).toBeVisible();
  expect(state.updates).toHaveLength(0);
  expect(state.previewReads).toBe(0);
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-NEW-ID");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
  expect(state.updates[0]).toMatchObject({
    clientId: "corrected_client",
    secret: "VIRTUAL-NEW-ID",
    requestId: expect.any(String),
    version: 1,
  });
  await expect(page).toHaveURL(`/my/merchants?merchantId=${merchantId}`);
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: /删除商户/ })).toHaveCount(0);
  expect(state.csrf).toEqual(["merchant-config-csrf"]);
});

test("保存反馈显示在原按钮内，三秒恢复且不改变按钮宽度", async ({ page }) => {
  await page.clock.install();
  await mockMerchantConfig(page);
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  const save = merchantSaveButton(page);
  const before = await save.boundingBox();
  await page.getByLabel("商户名称", { exact: true }).fill("按钮内反馈");
  await save.click();
  await expect(save).toHaveAccessibleName(/已保存/u);
  await expect(page.getByText("商户配置已保存。", { exact: true })).toHaveCount(
    0,
  );
  const during = await save.boundingBox();
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
  await page.clock.runFor(3000);
  await expect(save).toHaveAccessibleName("保存配置");
});

test("配置修改有活动和付款风险时先提醒，取消不保存且保留输入", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockMerchantConfig(page);
  state.impact = {
    activeActivities: 2,
    unfinishedDraws: 1,
    pendingPayments: 3,
    sendingPayments: 1,
    reconcilingPayments: 4,
  };
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-RISK");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "谨慎更换商户配置" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("进行中活动2");
  await expect(dialog).toContainText("核对中任务4");
  await expect(dialog).toContainText("继续核对原订单");
  expect(state.updates).toHaveLength(0);
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveValue(
    "VIRTUAL-RISK",
  );
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0]?.confirmationToken).toBe("preview-token-2");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("仅改名称不触发凭证风险提醒，密钥留空保留配置", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  state.impact.pendingPayments = 8;
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("商户名称", { exact: true }).fill("修改后的名称");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
  expect(state.previewReads).toBe(0);
  expect(state.updates[0]).not.toHaveProperty("secret");
  expect(state.updates[0]).not.toHaveProperty("clientId");
  expect(state.merchant.credentialVersion).toBe(1);
});

for (const status of ["rejected", "unavailable"] as const) {
  test(`保存密钥后的自动检查 ${status} 就近显示原因，保留修改且不触发手动检查`, async ({
    page,
  }) => {
    await page.clock.install();
    const state = await mockMerchantConfig(page);
    await page.goto(`/my/merchants?merchantId=${merchantId}`);
    const secret = page.getByLabel("商户密钥", { exact: true });
    await secret.fill("VIRTUAL-AUTO-CHECK");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
    expect(state.merchant.credentialVerification.status).toBe("checking");
    const problem = page.locator("#merchant-credential-error");
    await expect(problem).toHaveCount(0);
    const name = page.getByLabel("商户名称", { exact: true });
    await name.fill("未保存的商户名称");
    state.merchant = {
      ...state.merchant,
      credentialVerification: {
        ...state.merchant.credentialVerification,
        status,
        checkedAt: new Date().toISOString(),
        reason: status === "rejected" ? "credentials" : "network",
      },
    };
    await page.clock.runFor(2500);
    await expect(problem).toContainText(
      status === "rejected" ? "凭证认证未通过" : "网络连接失败",
    );
    await expect(secret).toHaveAttribute(
      "aria-describedby",
      "merchant-credential-error",
    );
    await expect(name).toHaveValue("未保存的商户名称");
    await expect(problem).not.toContainText(/原订单|奖励已锁定|等待作者/);
    await secret.fill("VIRTUAL-REPLACEMENT");
    state.merchant = {
      ...state.merchant,
      credentialVerification: {
        ...state.merchant.credentialVerification,
        credentialVersion: state.merchant.credentialVersion - 1,
      },
    };
    await page.clock.runFor(16000);
    await expect(problem).toHaveCount(0);
    await expect(name).toHaveValue("未保存的商户名称");
    await expect(secret).toHaveValue("VIRTUAL-REPLACEMENT");
    expect(state.updates).toHaveLength(1);
    expect(state.retiredRequests).toEqual([]);
    await expect(
      page.getByRole("button", { name: /检查恢复条件|凭证检查/ }),
    ).toHaveCount(0);
  });
}

test("保存时新增付款风险返回最新提醒，重新确认沿用提交标识", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  state.impact.activeActivities = 1;
  state.renewWarning = true;
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-RECHECK");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("发送中任务1");
  await expect(page.getByRole("dialog")).not.toContainText("重新确认");
  expect(state.updates).toHaveLength(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]?.requestId).toBe(state.updates[0]?.requestId);
  expect(state.updates[1]?.confirmationToken).toBe(
    "renewed-confirmation-token",
  );
});

test("保存响应丢失后重试完全相同请求，不重新生成凭证版本", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  state.failUpdateResponse = true;
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("Client ID", { exact: true }).fill("corrected_client");
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-LOST");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重试原提交", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveValue(
    "VIRTUAL-LOST",
  );
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(merchantSaveButton(page)).toHaveAccessibleName(/已保存/u);
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]).toEqual(state.updates[0]);
  expect(state.previewReads).toBe(1);
  expect(state.merchant.version).toBe(2);
  expect(state.merchant.credentialVersion).toBe(2);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("VIRTUAL-LOST");
});

test("付款详情保留历史身份并只修复固定原订单凭证，网络重试沿用同键", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockMerchantConfig(page);
  state.merchant.clientId = "current_client";
  state.failRepairResponse = true;
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  await page
    .getByRole("button", { name: "更新原订单密钥", exact: true })
    .click();
  await expect(
    page.getByLabel("原订单 Client ID", { exact: true }),
  ).toHaveValue("original_client");
  await expect(
    page.getByLabel("原订单 Client ID", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(page.getByText(/请求 Client ID：original_client/)).toBeVisible();
  await page
    .getByLabel("原订单商户密钥", { exact: true })
    .fill("VIRTUAL-ORIGINAL");
  const repair = originalOrderSaveButton(page);
  const before = await repair.boundingBox();
  await repair.click();
  await expect(
    page.getByRole("button", { name: "重试原提交", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("原订单商户密钥", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重试原提交", exact: true }).click();
  await expect(repair).toHaveAccessibleName(/已保存/u);
  const during = await repair.boundingBox();
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
  await page.clock.runFor(3000);
  await expect(repair).toHaveAccessibleName("保存原订单凭证");
  expect(state.repairs).toHaveLength(2);
  expect(state.repairs[1]).toEqual(state.repairs[0]);
  expect(state.repairs[0]).toEqual({
    requestId: expect.any(String),
    version: 1,
    secret: "VIRTUAL-ORIGINAL",
  });
  expect(state.payment.unknownOutcome).toBe(true);
  expect(state.payment.businessNo).toBe("same-original-business-no");
  expect(state.payment.amount).toBe("0.10");
  expect(state.merchant.clientId).toBe("current_client");
  await expect(page.getByLabel("原订单商户密钥", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByRole("button", { name: /强制重发|清除未知|标记付款成功/ }),
  ).toHaveCount(0);
});

test("退出后迟到的风险检查不会恢复弹窗或发起配置保存", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  state.delayImpact = true;
  state.impact.pendingPayments = 1;
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  await page.getByLabel("商户密钥", { exact: true }).fill("VIRTUAL-PRIVATE");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect.poll(() => state.releaseImpact !== undefined).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  state.releaseImpact?.();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("商户密钥", { exact: true })).toHaveCount(0);
  expect(state.updates).toHaveLength(0);
  expect(await page.content()).not.toContain("VIRTUAL-PRIVATE");
});

test("安全身份更正只展示追加记录，已确认付款不提供凭证修复", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  state.merchant.clientId = "corrected_client";
  state.payment.status = "confirmed";
  state.payment.confirmedAt = new Date().toISOString();
  state.payment.unknownOutcome = false;
  state.payment.nextAction = "none";
  state.payment.config = {
    originalClientId: "original_client",
    effectiveClientId: "corrected_client",
    credentialVersion: 2,
    identityCorrectionVersion: 1,
    canRepairCredentials: false,
  };
  state.payment.identityCorrections = [
    {
      version: 1,
      originalClientId: "original_client",
      correctedClientId: "corrected_client",
      evidence: "never_sent",
      createdAt: new Date().toISOString(),
    },
  ];
  const originalAttempt = state.payment.attempts[0];
  if (!originalAttempt) throw new Error("Missing fixture attempt");
  state.payment.attempts = [
    {
      ...originalAttempt,
      clientId: "corrected_client",
      credentialVersion: 2,
      identityCorrectionVersion: 1,
      outcome: "succeeded",
    },
  ];
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  await page.getByText("更多处理信息", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "付款身份更正记录" }),
  ).toBeVisible();
  await expect(
    page.getByText("original_client → corrected_client", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("依据：从未发送，没有在途请求", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/请求 Client ID：corrected_client/),
  ).toBeVisible();
  await expect(page.getByLabel("原订单商户密钥", { exact: true })).toHaveCount(
    0,
  );
  expect(state.repairs).toHaveLength(0);
});

test("原订单修复与商户配置均服从作者权限，退出清理迟到响应", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  state.merchant.clientId = "current_client";
  state.delayRepair = true;
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  await page
    .getByRole("button", { name: "更新原订单密钥", exact: true })
    .click();
  await page.getByLabel("原订单商户密钥", { exact: true }).fill("VIRTUAL-LATE");
  await page
    .getByRole("button", { name: "保存原订单凭证", exact: true })
    .click();
  await expect.poll(() => state.releaseRepair !== undefined).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭付款详情", exact: true }).click();
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  state.releaseRepair?.();
  await expect(page.getByLabel("原订单商户密钥", { exact: true })).toHaveCount(
    0,
  );
  expect(await page.content()).not.toContain("VIRTUAL-LATE");
  state.signedIn = true;
  state.denyAccess = true;
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  await expect(page.getByText("未找到付款任务，或你无权查看。")).toBeVisible();
  await expect(page.getByLabel("原订单商户密钥", { exact: true })).toHaveCount(
    0,
  );
});

test("商户与原订单凭证输入的返回保护不保存敏感草稿", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  await page.goto("/account");
  await page.goto(`/my/merchants?merchantId=${merchantId}`);
  const secret = page.getByLabel("商户密钥", { exact: true });
  await secret.fill("VIRTUAL-UNSAVED-NAV");
  const cancelledConfig = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await page.evaluate(() => window.history.back());
  await cancelledConfig;
  await expect(secret).toHaveValue("VIRTUAL-UNSAVED-NAV");
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/account$/);
  await page.goForward();
  await expect(secret).toHaveValue("");
  await page.getByRole("link", { name: "付款记录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "付款记录", exact: true })
    .getByRole("link", { name: "查看详情", exact: true })
    .click();
  await page
    .getByRole("button", { name: "更新原订单密钥", exact: true })
    .click();
  const repair = page.getByLabel("原订单商户密钥", { exact: true });
  await repair.fill("VIRTUAL-REPAIR-NAV");
  const cancelled = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await page.evaluate(() => window.history.back());
  await cancelled;
  await expect(repair).toHaveValue("VIRTUAL-REPAIR-NAV");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "返回付款记录", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`merchantId=${merchantId}&dialog=payments$`),
  );
  await page.goForward();
  await page
    .getByRole("button", { name: "更新原订单密钥", exact: true })
    .click();
  await expect(repair).toHaveValue("");
  expect(state.repairs).toHaveLength(0);
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
  ).not.toContain("VIRTUAL-");
});
