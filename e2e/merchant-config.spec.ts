import { expect, type Page, test } from "@playwright/test";
import type {
  Merchant,
  MerchantChangeImpact,
  MerchantPaymentDetail,
  RepairPaymentCredentialInput,
  UpdateMerchantInput,
} from "../packages/contracts/src";

const merchantId = "0e6bfcc0-8c62-4379-bd19-7f04a9032224";
const paymentId = "a3dcdfce-ad13-4f21-990b-2f214c5e122d";
const user = {
  id: "merchant-config-author",
  username: "author",
  displayName: "配置作者",
  avatarUrl: null,
  accountTier: "standard" as const,
  canUseLdc: true,
  loginProvider: "connect" as const,
};

async function mockMerchantConfig(page: Page) {
  const now = new Date().toISOString();
  const merchant: Merchant = {
    id: merchantId,
    label: "当前付款商户",
    mode: "real",
    usageStatus: "current",
    clientId: "original_client",
    version: 1,
    credentialVersion: 1,
    publicationEligibility: {
      allowed: true,
      reason: null,
      credentialVersion: 1,
    },
    credentialVerification: {
      status: "passed",
      credentialVersion: 1,
      checkedAt: now,
      nextCheckAt: null,
      reason: null,
    },
    pausedReason: null,
    paymentCheckNextAt: null,
    createdAt: now,
    updatedAt: now,
    capabilities: {
      canExecutePayments: true,
      canCheck: true,
      canSimulate: false,
      canVerify: true,
    },
  };
  const payment: MerchantPaymentDetail = {
    id: paymentId,
    source: "claim",
    claimId: "b62f9043-a883-4da9-a9d4-30fa8d9490ab",
    activityId: "a03f37bf-6b22-40a1-bbc3-984fe6eb53fe",
    acceptanceId: null,
    mode: "real",
    status: "reconciling",
    reason: "credentials",
    amount: "0.10",
    businessNo: "same-original-business-no",
    externalOrderId: null,
    confirmedAt: null,
    createdAt: now,
    nextRunAt: now,
    config: {
      originalClientId: "original_client",
      effectiveClientId: "original_client",
      credentialVersion: 1,
      identityCorrectionVersion: 0,
      canRepairCredentials: true,
    },
    identityCorrections: [],
    recipientId: "100001",
    recipientUsername: "Tester7369",
    recipientProfile: null,
    recoveryPolicy: "claim_same_order_v1",
    firstSendAt: now,
    usernameCorrection: null,
    nextAction: "query",
    nextSendAt: null,
    nextQueryAt: now,
    sendBlockReason: "credentials",
    orderObservedAt: null,
    orderEvidence: null,
    retryAuthorization: null,
    duplicateProbe: null,
    attemptCount: 1,
    reconciliationCount: 1,
    unknownOutcome: true,
    sendAcknowledgedAt: null,
    attempts: [
      {
        id: "original-send",
        operation: "send",
        clientId: "original_client",
        identityCorrectionVersion: 0,
        noOrderEvidence: null,
        recipientUsername: "Tester7369",
        purpose: "recovery",
        diagnosticSummary: null,
        httpStatus: null,
        outcome: "unknown",
        reason: "timeout",
        credentialVersion: 1,
        startedAt: now,
        finishedAt: now,
      },
    ],
    nextAttemptsCursor: null,
  };
  const state = {
    merchant,
    payment,
    signedIn: true,
    impact: {
      activeActivities: 0,
      unfinishedDraws: 0,
      pendingPayments: 0,
      sendingPayments: 0,
      reconcilingPayments: 0,
    } satisfies MerchantChangeImpact,
    previewReads: 0,
    updates: [] as UpdateMerchantInput[],
    repairs: [] as RepairPaymentCredentialInput[],
    csrf: [] as Array<string | undefined>,
    renewWarning: false,
    failUpdateResponse: false,
    failRepairResponse: false,
    delayImpact: false,
    releaseImpact: undefined as (() => void) | undefined,
    delayRepair: false,
    releaseRepair: undefined as (() => void) | undefined,
    denyAccess: false,
  };
  const savedUpdates = new Map<string, { merchant: Merchant }>();
  const savedRepairs = new Map<
    string,
    { merchant: Merchant; payment: MerchantPaymentDetail }
  >();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session" || path === "/api/me")
      return route.fulfill({
        json: state.signedIn
          ? { user, csrfToken: "merchant-config-csrf" }
          : { user: null, csrfToken: null },
      });
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (!state.signedIn)
      return route.fulfill({
        status: 401,
        json: { error: { code: "HTTP_401", message: "请先登录" } },
      });
    if (state.denyAccess)
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "未找到商户" } },
      });
    if (path === `/api/me/merchants/${merchantId}/change-impact`) {
      state.previewReads++;
      if (state.delayImpact)
        await new Promise<void>((resolve) => {
          state.releaseImpact = resolve;
        });
      return route.fulfill({
        json: {
          impact: state.impact,
          confirmationToken: `preview-token-${state.previewReads}`,
        },
      });
    }
    if (path === `/api/me/merchants/${merchantId}`) {
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as UpdateMerchantInput;
        state.updates.push(body);
        state.csrf.push(request.headers()["x-csrf-token"]);
        if (body.requestId && savedUpdates.has(body.requestId))
          return route.fulfill({ json: savedUpdates.get(body.requestId) });
        if (state.renewWarning) {
          state.renewWarning = false;
          state.impact = { ...state.impact, sendingPayments: 1 };
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "MERCHANT_CHANGE_REQUIRES_CONFIRMATION",
                message: "付款影响范围已变化，请重新确认后保存。",
                impact: state.impact,
                confirmationToken: "renewed-confirmation-token",
              },
            },
          });
        }
        state.merchant = {
          ...state.merchant,
          label: body.label,
          clientId: body.clientId ?? state.merchant.clientId,
          version: state.merchant.version + 1,
          credentialVersion:
            state.merchant.credentialVersion + Number(Boolean(body.secret)),
        };
        const result = { merchant: state.merchant };
        if (body.requestId) savedUpdates.set(body.requestId, result);
        if (state.failUpdateResponse) {
          state.failUpdateResponse = false;
          return route.abort("failed");
        }
        return route.fulfill({ json: result });
      }
      return route.fulfill({ json: { merchant: state.merchant } });
    }
    if (
      path ===
      `/api/me/merchants/${merchantId}/payments/${paymentId}/credentials`
    ) {
      const body = request.postDataJSON() as RepairPaymentCredentialInput;
      state.repairs.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      const previous = savedRepairs.get(body.requestId);
      if (previous) return route.fulfill({ json: previous });
      state.merchant = {
        ...state.merchant,
        version: state.merchant.version + 1,
      };
      const result = { merchant: state.merchant, payment: state.payment };
      savedRepairs.set(body.requestId, result);
      if (state.delayRepair)
        await new Promise<void>((resolve) => {
          state.releaseRepair = resolve;
        });
      if (state.failRepairResponse) {
        state.failRepairResponse = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: result });
    }
    if (path === `/api/me/merchants/${merchantId}/payments/${paymentId}`)
      return route.fulfill({ json: { payment: state.payment } });
    if (path === `/api/me/merchants/${merchantId}/payments`)
      return route.fulfill({
        json: { items: [state.payment], nextCursor: null },
      });
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: "未找到接口" } },
    });
  });
  return state;
}

test("同一商户 Client ID 可编辑，改应用必须同时填写对应密钥", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  await page.goto(`/my/merchants/${merchantId}`);
  await page.getByLabel("Client ID", { exact: true }).fill("corrected_client");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText(/修改 Client ID 时，请同时填写/)).toBeVisible();
  expect(state.updates).toHaveLength(0);
  expect(state.previewReads).toBe(0);
  await page.getByLabel("更换商户密钥", { exact: true }).fill("VIRTUAL-NEW-ID");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  expect(state.updates[0]).toMatchObject({
    clientId: "corrected_client",
    secret: "VIRTUAL-NEW-ID",
    requestId: expect.any(String),
    version: 1,
  });
  await expect(page).toHaveURL(`/my/merchants/${merchantId}`);
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.getByRole("button", { name: /删除商户/ })).toHaveCount(0);
  expect(state.csrf).toEqual(["merchant-config-csrf"]);
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
  await page.goto(`/my/merchants/${merchantId}`);
  await page.getByLabel("更换商户密钥", { exact: true }).fill("VIRTUAL-RISK");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "谨慎更换商户配置" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("进行中活动2");
  await expect(dialog).toContainText("核对中任务4");
  await expect(dialog).toContainText("继续核对原订单");
  expect(state.updates).toHaveLength(0);
  await dialog.getByRole("button", { name: "返回修改", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "VIRTUAL-RISK",
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  expect(state.updates).toHaveLength(1);
  expect(state.updates[0]?.confirmationToken).toBe("preview-token-2");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("仅改名称不触发凭证风险提醒，密钥留空保留配置", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  state.impact.pendingPayments = 8;
  await page.goto(`/my/merchants/${merchantId}`);
  await page.getByLabel("商户名称", { exact: true }).fill("修改后的名称");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  expect(state.previewReads).toBe(0);
  expect(state.updates[0]).not.toHaveProperty("secret");
  expect(state.updates[0]).not.toHaveProperty("clientId");
  expect(state.merchant.credentialVersion).toBe(1);
});

test("保存时新增付款风险返回最新提醒，重新确认沿用提交标识", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  state.impact.activeActivities = 1;
  state.renewWarning = true;
  await page.goto(`/my/merchants/${merchantId}`);
  await page
    .getByLabel("更换商户密钥", { exact: true })
    .fill("VIRTUAL-RECHECK");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("发送中任务1");
  await expect(page.getByRole("dialog")).toContainText("重新确认");
  expect(state.updates).toHaveLength(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认更换" })
    .click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  expect(state.updates).toHaveLength(2);
  expect(state.updates[1]?.requestId).toBe(state.updates[0]?.requestId);
  expect(state.updates[1]?.confirmationToken).toBe(
    "renewed-confirmation-token",
  );
});

test("保存响应丢失后重试完全相同请求，不重新生成凭证版本", async ({ page }) => {
  const state = await mockMerchantConfig(page);
  state.failUpdateResponse = true;
  await page.goto(`/my/merchants/${merchantId}`);
  await page.getByLabel("Client ID", { exact: true }).fill("corrected_client");
  await page.getByLabel("更换商户密钥", { exact: true }).fill("VIRTUAL-LOST");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "VIRTUAL-LOST",
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
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
  const state = await mockMerchantConfig(page);
  state.merchant.clientId = "current_client";
  state.failRepairResponse = true;
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
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
  await page
    .getByRole("button", { name: "保存原订单凭证", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "保存原订单凭证", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "保存原订单凭证", exact: true })
    .click();
  await expect(
    page.getByText("原订单凭证已保存，系统将继续安全核对原订单。"),
  ).toBeVisible();
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
  await page.goto(`/my/merchants/${merchantId}`);
  await page
    .getByLabel("更换商户密钥", { exact: true })
    .fill("VIRTUAL-PRIVATE");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => state.releaseImpact !== undefined).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("link", { name: "我的账号", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "登录解meme", exact: true }),
  ).toBeVisible();
  state.releaseImpact?.();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveCount(0);
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
  await page.getByLabel("原订单商户密钥", { exact: true }).fill("VIRTUAL-LATE");
  await page
    .getByRole("button", { name: "保存原订单凭证", exact: true })
    .click();
  await expect.poll(() => state.releaseRepair !== undefined).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
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
  await page.goto(`/my/merchants/${merchantId}`);
  const secret = page.getByLabel("更换商户密钥", { exact: true });
  await secret.fill("VIRTUAL-UNSAVED-NAV");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  await expect(secret).toHaveValue("VIRTUAL-UNSAVED-NAV");
  page.once("dialog", (dialog) => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/account$/);
  await page.goForward();
  await expect(secret).toHaveValue("");
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  const repair = page.getByLabel("原订单商户密钥", { exact: true });
  await repair.fill("VIRTUAL-REPAIR-NAV");
  const cancelled = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await page.evaluate(() => window.history.back());
  await cancelled;
  await expect(repair).toHaveValue("VIRTUAL-REPAIR-NAV");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "返回上一页", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/my/merchants/${merchantId}$`));
  await page.goForward();
  await expect(repair).toHaveValue("");
  expect(state.repairs).toHaveLength(0);
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
  ).not.toContain("VIRTUAL-");
});
