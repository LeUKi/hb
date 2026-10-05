import { expect, type Page, test } from "@playwright/test";
import {
  type ClaimDetail,
  type CreateActivityInput,
  type CreateMerchantInput,
  emptyActivityInput,
  type LdcActivityInput,
  ldcRewardCount,
  type ManagedActivity,
  type Merchant,
  type MerchantPaymentDetail,
  type PaymentMode,
  type PublicActivity,
  type SimulationScenario,
  type UpdateActivityInput,
  type UpdateMerchantInput,
} from "../packages/contracts/src";

const merchantId = "ae2d5421-df38-45e4-a5fb-daf144416734";
const activityId = "fc4a5a84-1a37-47e0-834b-32564408004f";
const claimId = "5b9b5e02-d64c-45be-b007-853c96b29e28";
const user = {
  id: "payment-tester",
  username: "tester",
  displayName: "测试用户",
  avatarUrl: null,
};
const author = {
  id: "payment-author",
  username: "author",
  displayName: "奖励作者",
  avatarUrl: null,
};

async function mockPayments(page: Page, mode: PaymentMode = "simulation") {
  const { rewards: _rewards, ...base } = emptyActivityInput();
  const config: LdcActivityInput = {
    ...base,
    rewardType: "ldc",
    merchantId,
    title: "LDC 模拟活动",
    passwords: ["Answer123"],
    money: { mode: "fixed", totalAmount: "10.00", count: 2 },
  };
  const merchantBase = {
    id: merchantId,
    label: "测试商户",
    clientId: "mock_client",
    version: 1,
    credentialVersion: 1,
    usageStatus: "current" as const,
    publicationEligibility: {
      allowed: mode === "simulation",
      reason: mode === "real" ? ("REAL_LDC_NOT_ENABLED" as const) : null,
      credentialVersion: 1,
    },
    credentialVerification: {
      status: "unverified" as const,
      credentialVersion: 1,
      checkedAt: null,
      nextCheckAt: null,
      reason: null,
    },
    pausedReason: null,
    paymentCheckNextAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const merchant: Merchant =
    mode === "simulation"
      ? {
          ...merchantBase,
          mode,
          scenario: "normal",
          capabilities: {
            canExecutePayments: true,
            canCheck: true,
            canSimulate: true,
            canVerify: false,
          },
        }
      : {
          ...merchantBase,
          mode,
          capabilities: {
            canExecutePayments: false,
            canCheck: false,
            canSimulate: false,
            canVerify: true,
          },
        };
  const activity: ManagedActivity = {
    id: activityId,
    author,
    title: config.title,
    rewardType: "ldc",
    status: "active",
    version: 2,
    createdAt: new Date().toISOString(),
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
    topicUrl: null,
    totalCount: 2,
    claimedCount: 0,
    config,
    paymentMode: mode,
    ...(mode === "real"
      ? {
          openingBlockedReason: "REAL_LDC_NOT_ENABLED" as const,
          status: "draft" as const,
          openedAt: null,
          deadlineAt: null,
        }
      : {}),
  };
  const state = {
    signedIn: true,
    merchant,
    activity,
    merchants: [merchant] as Merchant[],
    currentMerchantId: merchantId as string | null,
    canSimulate: true,
    viewerIsAuthor: false,
    creates: [] as CreateMerchantInput[],
    updates: [] as UpdateMerchantInput[],
    activityCreates: [] as CreateActivityInput[],
    activityUpdates: [] as UpdateActivityInput[],
    activityOpens: 0,
    openRequests: [] as {
      version: number;
      merchantId?: string;
      credentialVersion?: number;
    }[],
    scenarios: [] as SimulationScenario[],
    checks: 0,
    verifies: 0,
    merchantReads: 0,
    paymentReads: 0,
    paymentCursors: [] as Array<string | null>,
    payments: [] as MerchantPaymentDetail[],
    paymentAccessDenied: false,
    delayPaymentRead: false,
    releasePaymentRead: undefined as (() => void) | undefined,
    csrf: [] as Array<string | undefined>,
    claim: null as ClaimDetail | null,
    claimReads: 0,
    delayClaimRead: false,
    releaseClaimRead: undefined as (() => void) | undefined,
    claimPosts: 0,
    claimAmount: "5.00",
    claimPaymentReason: "quota",
    showRecipients: false,
    recipientAmount: undefined as string | undefined,
    delayCreate: false,
    createError: null as { code: string; message: string } | null,
    updateConflict: false,
    releaseCreate: undefined as (() => void) | undefined,
  };
  function claim(): ClaimDetail {
    return {
      id: claimId,
      activity: {
        id: activityId,
        title: state.activity.title,
        status: state.activity.status,
      },
      rewardType: "ldc",
      claimedAt: new Date().toISOString(),
      afterClaimInfo: "## 领取后已解锁",
      amount: state.claimAmount,
      payment: {
        id: "payment-1",
        mode: state.activity.paymentMode ?? "simulation",
        status: "waiting",
        reason: state.claimPaymentReason,
        confirmedAt: null,
      },
    };
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/me")
      return route.fulfill({
        json: state.signedIn
          ? {
              user: state.viewerIsAuthor ? author : user,
              csrfToken: "payment-csrf",
            }
          : { user: null, csrfToken: null },
      });
    if (path === "/api/auth/logout") {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === `/api/activities/${activityId}`) {
      const data: PublicActivity = {
        id: activityId,
        title: state.activity.title,
        rewardType: "ldc",
        author,
        status: state.activity.status,
        forceDedicated: false,
        topicUrl: null,
        openedAt: state.activity.openedAt,
        deadlineAt: state.activity.deadlineAt,
        quantity: { mode: "fuzzy", level: "limited" },
        showRecipientList: state.showRecipients,
        showRecipientUsername: false,
        showRecipientTime: false,
        beforeInfo: "",
        paymentMode: state.activity.paymentMode,
        openingBlockedReason: state.activity.openingBlockedReason,
        showRecipientAmount: state.recipientAmount !== undefined,
      };
      return route.fulfill({ json: { activity: data } });
    }
    if (path === `/api/activities/${activityId}/recipients`)
      return route.fulfill({
        json: {
          enabled: state.showRecipients,
          items: state.showRecipients
            ? [
                {
                  id: claimId,
                  username: user.username,
                  displayName: user.displayName,
                  avatarUrl: user.avatarUrl,
                  ...(state.recipientAmount === undefined
                    ? {}
                    : { amount: state.recipientAmount }),
                },
              ]
            : [],
          nextCursor: null,
        },
      });
    if (!state.signedIn)
      return route.fulfill({
        status: 401,
        json: { error: { code: "HTTP_401", message: "请先登录" } },
      });
    if (path === "/api/me/merchants" && request.method() === "POST") {
      const body = request.postDataJSON() as CreateMerchantInput;
      state.creates.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      if (state.createError)
        return route.fulfill({
          status: 409,
          json: { error: state.createError },
        });
      const {
        scenario: _scenario,
        mode: _mode,
        capabilities: _capabilities,
        ...common
      } = { ...state.merchant, scenario: undefined };
      const fields = {
        ...common,
        label: body.label,
        clientId: body.clientId,
      };
      state.merchant =
        body.mode === "real"
          ? {
              ...fields,
              mode: "real",
              capabilities: {
                canExecutePayments: false,
                canCheck: false,
                canSimulate: false,
                canVerify: true,
              },
              credentialVerification: {
                status: "checking",
                credentialVersion: 1,
                checkedAt: null,
                nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
                reason: null,
              },
              publicationEligibility: {
                allowed: false,
                reason: "MERCHANT_CREDENTIALS_CHECKING",
                credentialVersion: 1,
              },
            }
          : {
              ...fields,
              mode: "simulation",
              scenario: "normal",
              capabilities: {
                canExecutePayments: true,
                canCheck: true,
                canSimulate: true,
                canVerify: false,
              },
            };
      state.merchants = [state.merchant];
      state.currentMerchantId = state.merchant.id;
      if (state.delayCreate)
        await new Promise<void>((resolve) => {
          state.releaseCreate = resolve;
        });
      try {
        return await route.fulfill({ json: { merchant: state.merchant } });
      } catch {
        return;
      }
    }
    if (path === "/api/me/merchants")
      return route.fulfill({
        json: {
          items: state.merchants.map((item) =>
            item.id === state.merchant.id ? state.merchant : item,
          ),
          currentMerchantId: state.currentMerchantId,
          canCreate: state.currentMerchantId === null,
          canSimulate: state.canSimulate,
          nextCursor: null,
        },
      });
    if (path === `/api/me/merchants/${merchantId}/payments`)
      return route.fulfill({
        json: { items: state.payments, nextCursor: null },
      });
    if (path.startsWith(`/api/me/merchants/${merchantId}/payments/`)) {
      state.paymentReads++;
      if (state.paymentAccessDenied)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "未找到付款任务" } },
        });
      const payment = state.payments.find(
        (item) => item.id === path.split("/").at(-1),
      );
      if (!payment)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "未找到付款任务" } },
        });
      const cursor = new URL(request.url()).searchParams.get("cursor");
      state.paymentCursors.push(cursor);
      if (state.delayPaymentRead)
        await new Promise<void>((resolve) => {
          state.releasePaymentRead = resolve;
        });
      try {
        return await route.fulfill({
          json: {
            payment: cursor
              ? { ...payment, attempts: [], nextAttemptsCursor: null }
              : payment,
          },
        });
      } catch {
        return;
      }
    }
    if (path === `/api/me/merchants/${merchantId}/check`) {
      state.checks++;
      state.csrf.push(request.headers()["x-csrf-token"]);
      state.merchant = {
        ...state.merchant,
        paymentCheckNextAt: new Date(Date.now() + 30_000).toISOString(),
      };
      return route.fulfill({
        json: {
          merchant: state.merchant,
          accepted: true,
          retryAfterSeconds: null,
        },
      });
    }
    if (path === `/api/me/merchants/${merchantId}/verify`) {
      state.verifies++;
      state.csrf.push(request.headers()["x-csrf-token"]);
      state.merchant = {
        ...state.merchant,
        credentialVerification: {
          status: "checking",
          credentialVersion: state.merchant.credentialVersion,
          checkedAt: null,
          nextCheckAt: new Date(Date.now() + 30_000).toISOString(),
          reason: null,
        },
        publicationEligibility: {
          allowed: false,
          reason: "MERCHANT_CREDENTIALS_CHECKING",
          credentialVersion: state.merchant.credentialVersion,
        },
      };
      return route.fulfill({ status: 202, json: { merchant: state.merchant } });
    }
    if (path === `/api/me/merchants/${merchantId}/simulation`) {
      const { scenario } = request.postDataJSON() as {
        scenario: SimulationScenario;
      };
      state.scenarios.push(scenario);
      state.csrf.push(request.headers()["x-csrf-token"]);
      if (state.merchant.mode === "simulation")
        state.merchant = { ...state.merchant, scenario };
      return route.fulfill({ json: { merchant: state.merchant } });
    }
    if (path === `/api/me/merchants/${merchantId}`) {
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as UpdateMerchantInput;
        state.updates.push(body);
        state.csrf.push(request.headers()["x-csrf-token"]);
        if (state.updateConflict || body.version !== state.merchant.version)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "MERCHANT_CONFLICT",
                message:
                  "商户配置已更新。当前输入已保留，请先刷新商户配置后重试。",
              },
            },
          });
        state.merchant = {
          ...state.merchant,
          label: body.label,
          version: state.merchant.version + 1,
          credentialVersion:
            state.merchant.credentialVersion + Number(Boolean(body.secret)),
          ...(body.secret
            ? {
                publicationEligibility: {
                  allowed: state.merchant.mode === "simulation",
                  reason:
                    state.merchant.mode === "real"
                      ? ("MERCHANT_CREDENTIALS_CHECKING" as const)
                      : null,
                  credentialVersion: state.merchant.credentialVersion + 1,
                },
                credentialVerification: {
                  status:
                    state.merchant.mode === "real"
                      ? ("checking" as const)
                      : ("unverified" as const),
                  credentialVersion: state.merchant.credentialVersion + 1,
                  checkedAt: null,
                  nextCheckAt:
                    state.merchant.mode === "real"
                      ? new Date(Date.now() + 30_000).toISOString()
                      : null,
                  reason: null,
                },
              }
            : {}),
        };
      }
      state.merchantReads++;
      return route.fulfill({ json: { merchant: state.merchant } });
    }
    const otherMerchant = state.merchants.find(
      (item) => path === `/api/me/merchants/${item.id}`,
    );
    if (otherMerchant && request.method() === "GET")
      return route.fulfill({ json: { merchant: otherMerchant } });
    if (path === "/api/activities" && request.method() === "POST") {
      const body = request.postDataJSON() as CreateActivityInput;
      state.activityCreates.push(body);
      state.csrf.push(request.headers()["x-csrf-token"]);
      state.activity = {
        ...state.activity,
        title: body.activity.title,
        config: body.activity,
        rewardType: body.activity.rewardType,
        totalCount:
          body.activity.rewardType === "ldc"
            ? ldcRewardCount(body.activity)
            : body.activity.rewards.length,
        status: "draft",
        openedAt: null,
        deadlineAt: null,
        paymentMode: state.merchant.mode,
        openingBlockedReason:
          state.merchant.publicationEligibility.reason ?? undefined,
      };
      return route.fulfill({ json: { activity: state.activity } });
    }
    if (path === `/api/me/activities/${activityId}/claims`)
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === `/api/me/activities/${activityId}/open`) {
      state.activityOpens++;
      state.openRequests.push(request.postDataJSON());
      state.csrf.push(request.headers()["x-csrf-token"]);
      if (!state.merchant.publicationEligibility.allowed)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "REAL_LDC_NOT_ENABLED",
              message: "真实 LDC 接入待验，暂不能开放领取。",
            },
          },
        });
      if (state.activity.status === "draft") {
        state.activity = {
          ...state.activity,
          status: "active",
          version: state.activity.version + 1,
          openedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
          openingBlockedReason: undefined,
        };
      }
      return route.fulfill({ json: { activity: state.activity } });
    }
    if (path === `/api/me/activities/${activityId}`) {
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as UpdateActivityInput;
        state.activityUpdates.push(body);
        state.csrf.push(request.headers()["x-csrf-token"]);
        state.activity = {
          ...state.activity,
          title: body.activity.title,
          config: body.activity,
          version: state.activity.version + 1,
          totalCount:
            body.activity.rewardType === "ldc"
              ? ldcRewardCount(body.activity)
              : body.activity.rewards.length,
        };
      }
      return route.fulfill({ json: { activity: state.activity } });
    }
    if (path === `/api/activities/${activityId}/claim`) {
      if (request.method() === "POST") {
        state.claimPosts++;
        state.claim ??= claim();
        state.csrf.push(request.headers()["x-csrf-token"]);
        return route.fulfill({
          json: { result: "claimed", claim: state.claim },
        });
      }
      state.claimReads++;
      if (state.delayClaimRead)
        await new Promise<void>((resolve) => {
          state.releaseClaimRead = resolve;
        });
      return route.fulfill({ json: { claim: state.claim } });
    }
    if (path === `/api/activities/${activityId}/passwords`) {
      const ended =
        state.activity.status === "ended" ||
        state.activity.status === "archived";
      const revealed = ended || (state.signedIn && state.viewerIsAuthor);
      return route.fulfill({
        json: {
          passwords: revealed
            ? state.activity.config.passwords.map((text) => ({
                text,
                isClaimPassword: false,
                isSolved: false,
              }))
            : state.signedIn && state.claim
              ? [{ text: "Answer123", isClaimPassword: true, isSolved: false }]
              : [],
          hiddenCount:
            revealed || (state.signedIn && state.claim)
              ? 0
              : state.activity.config.passwords.length,
          canSolve: state.signedIn && Boolean(state.claim) && !ended,
        },
      });
    }
    return route.fallback();
  });
  return { state, claim };
}

async function ldcWizard(page: Page) {
  await page.goto("/activities/new");
  await page
    .getByRole("combobox", { name: "奖励类型", exact: true })
    .selectOption("ldc");
  await page.locator("#activity-title").fill("新 LDC 活动");

  await page.getByLabel("口令 1", { exact: true }).fill("Answer123");
  await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
    /测试商户.*当前商户/,
  );
}

function acceptancePayment(): MerchantPaymentDetail {
  const now = new Date().toISOString();
  return {
    id: "bdd0d4d3-b1a5-4cb0-a64c-0ec0e2cc3535",
    source: "acceptance",
    mode: "real",
    acceptanceId: "local-acceptance-fixture",
    claimId: null,
    activityId: null,
    amount: "0.10",
    businessNo: "hb-acceptance-fixture-100001",
    externalOrderId: "external-acceptance-order",
    createdAt: now,
    nextRunAt: now,
    status: "reconciling",
    reason: "checking_not_found",
    confirmedAt: null,
    recipientProfile: null,
    recipientId: "100001",
    recipientUsername: "tester7369",
    usernameCorrection: null,
    attemptCount: 1,
    reconciliationCount: 2,
    unknownOutcome: true,
    sendAcknowledgedAt: now,
    firstSendAt: now,
    recoveryPolicy: null,
    nextAction: "query",
    nextSendAt: null,
    nextQueryAt: now,
    sendBlockReason: null,
    orderObservedAt: now,
    orderEvidence: "receipt",
    retryAuthorization: null,
    duplicateProbe: null,
    attempts: [
      {
        id: "query-2",
        httpStatus: 404,
        operation: "query",
        recipientUsername: null,
        purpose: "recovery",
        diagnosticSummary: null,
        outcome: "unknown",
        reason: "checking_not_found",
        credentialVersion: 2,
        startedAt: now,
        finishedAt: now,
      },
      {
        id: "query-1",
        httpStatus: null,
        operation: "query",
        recipientUsername: null,
        purpose: "recovery",
        diagnosticSummary: null,
        outcome: "unknown",
        reason: "timeout",
        credentialVersion: 1,
        startedAt: now,
        finishedAt: now,
      },
      {
        id: "send-1",
        httpStatus: 200,
        operation: "send",
        recipientUsername: "tester7369",
        purpose: "recovery",
        diagnosticSummary: null,
        outcome: "succeeded",
        reason: null,
        credentialVersion: 1,
        startedAt: now,
        finishedAt: now,
      },
    ],
    nextAttemptsCursor: "attempt-page-2",
  };
}

test("凭证检查独立于付款恢复，检查中加快轮询且检查后遵守冷却", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  await page.clock.install();
  await page.goto(`/my/merchants/${merchantId}`);
  await expect(page.getByText("未验证", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检查凭证", exact: true }).click();
  await expect(page.getByText("检查中", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "正在检查凭证…", exact: true }),
  ).toBeDisabled();
  expect(state.verifies).toBe(1);
  expect(state.checks).toBe(0);
  const checkingReads = state.merchantReads;
  state.merchant = {
    ...state.merchant,
    credentialVerification: {
      ...state.merchant.credentialVerification,
      status: "passed",
      reason: "not_found_after_auth",
      checkedAt: new Date().toISOString(),
    },
  };
  await page.clock.runFor(2_100);
  await expect(page.getByText("凭证通过", { exact: true })).toBeVisible();
  expect(state.merchantReads).toBeGreaterThan(checkingReads);
  await expect(
    page.getByRole("button", { name: "检查凭证", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "前往 LDC 查看余额", exact: true }),
  ).toHaveAttribute("href", "https://credit.linux.do");
  await expect(page.getByText(/检查通过仅证明接口接受当前凭证/)).toBeVisible();
  await page.clock.runFor(30_000);
  await expect(
    page.getByRole("button", { name: "检查凭证", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "检查凭证", exact: true }).click();
  await expect(page.getByText("检查中", { exact: true })).toBeVisible();
  state.merchant = {
    ...state.merchant,
    credentialVerification: {
      ...state.merchant.credentialVerification,
      status: "rejected",
      reason: "credentials",
      checkedAt: new Date().toISOString(),
    },
  };
  await page.clock.runFor(2_100);
  await expect(page.getByText("认证未通过", { exact: true })).toBeVisible();
  await expect(
    page.getByText("认证未通过，请检查商户 ID 和密钥。", { exact: true }),
  ).toBeVisible();
  expect(state.verifies).toBe(2);
  expect(state.csrf).toEqual(["payment-csrf", "payment-csrf"]);
});

test("凭证异常仅显示安全提示，轮换立即显示新版本检查而不沿用旧通过结果", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  state.merchant = {
    ...state.merchant,
    credentialVerification: {
      ...state.merchant.credentialVerification,
      status: "unavailable",
      reason: "RAW-RESPONSE-MUST-NOT-RENDER",
    },
  };
  await page.goto(`/my/merchants/${merchantId}`);
  await expect(page.getByText("暂时无法验证", { exact: true })).toBeVisible();
  await expect(
    page.getByText("暂时无法验证，请稍后重试。", { exact: true }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("RAW-RESPONSE-MUST-NOT-RENDER");
  state.merchant = {
    ...state.merchant,
    credentialVerification: {
      ...state.merchant.credentialVerification,
      status: "passed",
      reason: "not_found_after_auth",
    },
  };
  await page.reload();
  await expect(page.getByText("凭证通过", { exact: true })).toBeVisible();
  await page
    .getByLabel("更换商户密钥", { exact: true })
    .fill("VIRTUAL-NEW-VERSION");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("检查中", { exact: true })).toBeVisible();
  await expect(page.getByText(/当前凭证版本：2/)).toBeVisible();
  await expect(page.getByText("凭证通过", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "",
  );
  expect(await page.content()).not.toContain("VIRTUAL-NEW-VERSION");
  expect(state.verifies).toBe(0);
});

test("接入验收付款独立展示详情，记录凭证版本、安全核对和尝试分页且窄屏可用", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  state.merchant = {
    ...state.merchant,
    pausedReason: "unknown",
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  const payment = acceptancePayment();
  state.payments = [payment];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/my/merchants/${merchantId}`);
  await expect(page.getByText("来源：接入验收", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "查看活动", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "查看付款详情", exact: true }).click();
  await expect(page).toHaveURL(
    `/my/merchants/${merchantId}/payments/${payment.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "付款详情", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0.10 LDC", { exact: true })).toBeVisible();
  await expect(page.getByText("100001", { exact: true })).toBeVisible();
  await expect(page.getByText("@tester7369", { exact: true })).toBeVisible();
  await expect(
    page.getByText(payment.businessNo, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(payment.externalOrderId ?? "", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("凭证版本：2 · HTTP 404", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("凭证版本：1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("凭证版本：1 · HTTP 200", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("请求超时，尚未取得可确认的结果，将继续核对原订单。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /强制重发|标记付款成功|清除未知/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "立即检查恢复条件", exact: true })
    .click();
  await expect(
    page.getByText("已请求检查恢复条件。", { exact: true }),
  ).toBeVisible();
  expect(state.checks).toBe(1);
  expect(state.csrf).toEqual(["payment-csrf"]);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText("暂无尝试记录。", { exact: true })).toBeVisible();
  expect(state.paymentCursors).toContain("attempt-page-2");
  await page.getByRole("button", { name: "上一页", exact: true }).click();
  await expect(page.getByText("分发请求", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "付款详情", exact: true }),
  ).toBeVisible();
});

test("用户名大小写更正保留原始快照，每次发送展示实际用户名，查单不展示发送用户名", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  const send = payment.attempts.find((attempt) => attempt.operation === "send");
  if (!send) throw new Error("Missing original send fixture");
  const now = new Date().toISOString();
  state.payments = [
    {
      ...payment,
      usernameCorrection: {
        originalUsername: "tester7369",
        correctedUsername: "Tester7369",
        createdAt: now,
      },
      attempts: [
        {
          ...send,
          id: "corrected-send",
          recipientUsername: "Tester7369",
          startedAt: now,
          finishedAt: now,
        },
        ...payment.attempts,
      ],
    },
  ];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(page.getByText("100001", { exact: true })).toBeVisible();
  await expect(page.getByText("当前发送用户名", { exact: true })).toBeVisible();
  await expect(page.getByText("@Tester7369", { exact: true })).toBeVisible();
  await expect(page.getByText("原始用户名快照", { exact: true })).toBeVisible();
  await expect(page.getByText("@tester7369", { exact: true })).toBeVisible();
  await expect(page.getByText("用户名更正时间", { exact: true })).toBeVisible();
  await expect(
    page.getByText("发送时用户名：@Tester7369", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("发送时用户名：@tester7369", { exact: true }),
  ).toBeVisible();
  const queryAttempts = page.getByRole("listitem").filter({
    has: page.getByText("订单查询", { exact: true }),
  });
  await expect(queryAttempts).toHaveCount(2);
  await expect(queryAttempts.getByText(/发送时用户名/)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(state.checks).toBe(0);
});

test("付款核对确认后停止该任务轮询且关闭唤醒操作", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  state.payments = [payment];
  state.merchant = {
    ...state.merchant,
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  await page.clock.install();
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(
    page.getByRole("heading", { name: "核对中", exact: true }),
  ).toBeVisible();
  state.payments = [
    {
      ...payment,
      status: "confirmed",
      reason: null,
      unknownOutcome: false,
      confirmedAt: new Date().toISOString(),
    },
  ];
  await page.clock.runFor(15_100);
  await expect(
    page.getByRole("heading", {
      name: "LDC 已确认发放，实际可用时间以 LDC 为准",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  const reads = state.paymentReads;
  await page.clock.runFor(31_000);
  expect(state.paymentReads).toBe(reads);
});

test("发送与查单时间独立展示，原单恢复次数、业务限制和脱敏诊断清晰可见", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  const attempt = payment.attempts[0];
  if (!attempt) throw new Error("Missing diagnostic fixture attempt");
  state.payments = [
    {
      ...payment,
      nextAction: "send",
      nextSendAt: new Date(Date.now() + 60_000).toISOString(),
      sendBlockReason: "quota",
      orderEvidence: "query",
      retryAuthorization: {
        policy: "same_order_v1",
        maxAdditionalSends: 5,
        usedAdditionalSends: 2,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        revokedAt: null,
      },
      attempts: [
        {
          ...attempt,
          id: "diagnostic-attempt",
          purpose: "recovery",
          diagnosticSummary: "余额不足 key=[redacted] [URL] [auth]",
        },
      ],
    },
  ];
  state.merchant = {
    ...state.merchant,
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(page.getByText("发送尝试次数", { exact: true })).toBeVisible();
  await expect(page.getByText("下次发送", { exact: true })).toBeVisible();
  await expect(page.getByText("下次查单", { exact: true })).toBeVisible();
  await expect(page.getByText("等待按计划发送", { exact: true })).toBeVisible();
  await expect(page.getByText("查单已返回订单", { exact: true })).toBeVisible();
  await expect(
    page.getByText("发送限制：每日发放额度不足，等待可用额度。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("授权状态：有效", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已用 2 / 5 次，剩余 3 次", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("上游说明：余额不足 key=[redacted] [URL] [auth]", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  expect(state.checks).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

for (const authorizationState of ["expired", "exhausted", "revoked"] as const)
  test(`原单恢复授权 ${authorizationState} 时显示真实限制且没有手动发款入口`, async ({
    page,
  }) => {
    const { state } = await mockPayments(page, "real");
    const payment = acceptancePayment();
    state.payments = [
      {
        ...payment,
        retryAuthorization: {
          policy: "same_order_v1",
          maxAdditionalSends: 5,
          usedAdditionalSends: authorizationState === "exhausted" ? 5 : 1,
          expiresAt: new Date(
            Date.now() + (authorizationState === "expired" ? -1_000 : 60_000),
          ).toISOString(),
          revokedAt:
            authorizationState === "revoked" ? new Date().toISOString() : null,
        },
      },
    ];
    await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
    const label = {
      expired: "已到期",
      exhausted: "次数已用尽",
      revoked: "已撤销",
    }[authorizationState];
    await expect(
      page.getByText(`授权状态：${label}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /强制重发|发送付款|标记付款成功/ }),
    ).toHaveCount(0);
  });

test("订单已确认后仍轮询进行中的重复业务号验证，验证结束才停止", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  const attempt = payment.attempts[0];
  if (!attempt) throw new Error("Missing probe fixture attempt");
  const now = new Date().toISOString();
  const probe: NonNullable<MerchantPaymentDetail["duplicateProbe"]> = {
    status: "reconciling",
    baselineExternalOrderId: "baseline-probe-order",
    permitConsumedAt: now,
    nextRunAt: now,
    queryCount: 1,
    reason: "checking_not_found",
    protocolVerifiedAt: null,
    backendVerifiedAt: null,
  };
  state.payments = [
    {
      ...payment,
      status: "confirmed",
      reason: null,
      unknownOutcome: false,
      confirmedAt: now,
      nextAction: "none",
      nextQueryAt: null,
      duplicateProbe: probe,
      attempts: [{ ...attempt, purpose: "probe" }],
    },
  ];
  state.merchant = {
    ...state.merchant,
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  await page.clock.install();
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(
    page.getByRole("heading", { name: "重复业务号验证", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("核对验证订单", { exact: true })).toBeVisible();
  await expect(page.getByText("重复请求验证", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeEnabled();
  const activeReads = state.paymentReads;
  await page.clock.runFor(15_100);
  await expect.poll(() => state.paymentReads).toBeGreaterThan(activeReads);
  const activePayment = state.payments[0];
  if (!activePayment) throw new Error("Missing active probe fixture");
  state.payments = [
    {
      ...activePayment,
      duplicateProbe: {
        ...probe,
        status: "passed",
        reason: null,
        protocolVerifiedAt: now,
        backendVerifiedAt: now,
      },
    },
  ];
  await page.clock.runFor(15_100);
  await expect(page.getByText("验证通过", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  const stoppedReads = state.paymentReads;
  await page.clock.runFor(31_000);
  expect(state.paymentReads).toBe(stoppedReads);
});

test("已确认付款停止轮询后，恢复授权在页面内到期仍及时更新", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  await page.clock.install();
  state.payments = [
    {
      ...payment,
      status: "confirmed",
      reason: null,
      unknownOutcome: false,
      confirmedAt: new Date().toISOString(),
      nextAction: "none",
      nextQueryAt: null,
      retryAuthorization: {
        policy: "same_order_v1",
        maxAdditionalSends: 5,
        usedAdditionalSends: 1,
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        revokedAt: null,
      },
    },
  ];
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(page.getByText("授权状态：有效", { exact: true })).toBeVisible();
  const reads = state.paymentReads;
  await page.clock.runFor(10_100);
  await expect(
    page.getByText("授权状态：已到期", { exact: true }),
  ).toBeVisible();
  expect(state.paymentReads).toBe(reads);
});

test("协议核对完成后等待后台证据，继续状态刷新但不再唤醒自动查单", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  const now = new Date().toISOString();
  const probe: NonNullable<MerchantPaymentDetail["duplicateProbe"]> = {
    status: "awaiting_evidence",
    baselineExternalOrderId: "baseline-awaiting-order",
    permitConsumedAt: now,
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    queryCount: 1,
    reason: "probe_backend_evidence_required",
    protocolVerifiedAt: now,
    backendVerifiedAt: null,
  };
  const confirmedPayment: MerchantPaymentDetail = {
    ...payment,
    status: "confirmed",
    reason: null,
    unknownOutcome: false,
    confirmedAt: now,
    nextAction: "none",
    nextQueryAt: null,
    duplicateProbe: probe,
  };
  state.payments = [confirmedPayment];
  state.merchant = {
    ...state.merchant,
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  await page.clock.install();
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(
    page.getByText("等待后台交易记录核验", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("等待后台交易记录证据", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("协议核对已完成，等待后台交易记录核验。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  const reads = state.paymentReads;
  await page.clock.runFor(15_100);
  await expect.poll(() => state.paymentReads).toBeGreaterThan(reads);
  expect(state.checks).toBe(0);
  state.payments = [
    {
      ...confirmedPayment,
      duplicateProbe: {
        ...probe,
        status: "passed",
        reason: null,
        backendVerifiedAt: now,
      },
    },
  ];
  await page.clock.runFor(15_100);
  await expect(page.getByText("验证通过", { exact: true })).toBeVisible();
  const finalReads = state.paymentReads;
  await page.clock.runFor(31_000);
  expect(state.paymentReads).toBe(finalReads);
});

test("商户安全核对冷却在详情与管理页共享，刷新保留且期满才可再次操作", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  state.payments = [payment];
  state.merchant = {
    ...state.merchant,
    capabilities: { ...state.merchant.capabilities, canCheck: true },
  };
  await page.clock.install();
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  const check = page.getByRole("button", {
    name: "立即检查恢复条件",
    exact: true,
  });
  await check.click();
  await expect(check).toBeDisabled();
  await expect(page.getByText(/\d+ 秒后可再次检查恢复条件/)).toBeVisible();
  await page.getByRole("link", { name: "返回商户管理", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByText(/\d+ 秒后可再次检查恢复条件/)).toBeVisible();
  await page.clock.runFor(31_000);
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeEnabled();
  expect(state.checks).toBe(1);
});

test("付款详情越权不展示数据，退出后迟到详情响应不会恢复私有内容", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const payment = acceptancePayment();
  state.payments = [payment];
  state.paymentAccessDenied = true;
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(
    page.getByText("未找到付款任务，或你无权查看。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(payment.businessNo, { exact: true })).toHaveCount(
    0,
  );
  state.paymentAccessDenied = false;
  state.delayPaymentRead = true;
  await page.reload();
  await expect.poll(() => Boolean(state.releasePaymentRead)).toBe(true);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "请先登录", exact: true }),
  ).toBeVisible();
  state.releasePaymentRead?.();
  await expect(page.getByText(payment.businessNo, { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "付款详情", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain(payment.businessNo);
});

test("真实商户保存后自动检查当前凭证，模式锁定、密钥不回显且没有模拟出口", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  state.merchants = [];
  state.currentMerchantId = null;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/my/merchants");
  await page.getByLabel("付款模式（保存后不可修改）").selectOption("real");
  await expect(page.getByText(/保存配置不代表凭证有效/)).toBeVisible();
  await page.getByLabel("商户名称", { exact: true }).fill("真实配置待验");
  await page
    .getByLabel("Client ID", { exact: true })
    .fill("virtual_real_client");
  await page
    .getByLabel("商户密钥", { exact: true })
    .fill("VIRTUAL-REAL-SECRET");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page).toHaveURL(`/my/merchants/${merchantId}`);
  expect(state.creates[0]?.mode).toBe("real");
  await expect(
    page.getByRole("button", { name: "立即检查恢复条件", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("检查中", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "正在检查凭证…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "模拟故障", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("付款模式（保存后不可修改）")).toHaveCount(0);
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "",
  );
  expect(await page.content()).not.toContain("VIRTUAL-REAL-SECRET");
  await page
    .getByLabel("更换商户密钥", { exact: true })
    .fill("VIRTUAL-ROTATED");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("更换商户密钥", { exact: true })).toHaveValue(
    "",
  );
  expect(state.checks).toBe(0);
  expect(state.scenarios).toHaveLength(0);
  expect(state.merchant.mode).toBe("real");
  expect(state.merchant.credentialVersion).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("真实随机活动可保存编辑及预览，不能开放或切换到模拟商户", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  state.merchants.push({
    ...state.merchant,
    id: "f95c759d-435a-400b-8748-89a9a2076122",
    mode: "simulation",
    scenario: "normal",
    label: "另一个模拟商户",
    capabilities: {
      canExecutePayments: true,
      canCheck: true,
      canSimulate: true,
      canVerify: false,
    },
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await ldcWizard(page);
  await expect(page.getByText(/真实 LDC 活动先保存为准备中/)).toBeVisible();
  await page
    .getByRole("combobox", { name: "奖励方式", exact: true })
    .selectOption("random");
  await page.locator("#ldc-random-algorithm").selectOption("bounded_mean_v1");
  await page.getByLabel("总奖池（LDC）", { exact: true }).fill("0.10");
  await page.getByLabel("奖励份数", { exact: true }).fill("4");
  await expect(page.getByText(/4 份 LDC/)).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开放领取", exact: true }),
  ).toBeDisabled();
  expect(state.activityOpens).toBe(0);
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  await page.locator("#activity-title").fill("真实随机草稿已编辑");

  await expect(page.getByLabel("发放商户", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(
    page.getByRole("combobox", { name: "发放商户", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "改用当前商户", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开放领取", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "预览专属页", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "真实随机草稿已编辑", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/准备中预览，仅作者可见/)).toBeVisible();
  await expect(page.getByText(/真实 LDC 活动先保存为准备中/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  expect(state.claimPosts).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("后端拒绝真实开放时显示原因并保留草稿", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  // A stale client response can lack capabilities; the server remains authoritative.
  delete state.activity.paymentMode;
  delete state.activity.openingBlockedReason;
  await page.goto(`/my/activities/${activityId}`);
  await page.getByRole("button", { name: "开放领取", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "真实 LDC 接入待验，暂不能开放领取。",
  );
  expect(state.activity.status).toBe("draft");
  expect(state.activity.openedAt).toBeNull();
});

test("创建模拟商户后不回显密钥，轮换保持client_id，故障和重新检查带CSRF", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  state.merchants = [];
  state.currentMerchantId = null;
  await page.goto("/my/merchants");
  await expect(page.getByText(/不调用 LDC 外部接口/)).toBeVisible();
  await page.getByLabel("商户名称", { exact: true }).fill("新模拟商户");
  await page.getByLabel("Client ID", { exact: true }).fill("mock_new");
  await page.getByLabel("模拟密钥", { exact: true }).fill("VIRTUAL-SECRET-1");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page).toHaveURL(`/my/merchants/${merchantId}`);
  await expect(page.getByLabel("更换模拟密钥", { exact: true })).toHaveValue(
    "",
  );
  expect(await page.content()).not.toContain("VIRTUAL-SECRET-1");
  await page
    .getByLabel("更换模拟密钥", { exact: true })
    .fill("VIRTUAL-SECRET-2");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByText("商户配置已保存。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("更换模拟密钥", { exact: true })).toHaveValue(
    "",
  );
  expect(state.merchant.clientId).toBe("mock_new");
  expect(state.merchant.credentialVersion).toBe(2);
  expect(state.updates[0]?.secret).toBe("VIRTUAL-SECRET-2");
  await page
    .getByRole("combobox", { name: "付款情形", exact: true })
    .selectOption("response_lost");
  await page.getByRole("button", { name: "应用模拟情形", exact: true }).click();
  await expect(
    page.getByText("模拟情形已设置。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "立即检查恢复条件", exact: true })
    .click();
  await expect(
    page.getByText("已请求检查恢复条件。", { exact: true }),
  ).toBeVisible();
  expect(state.scenarios).toEqual(["response_lost"]);
  expect(state.checks).toBe(1);
  expect(state.csrf).toEqual(Array(4).fill("payment-csrf"));
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("VIRTUAL-SECRET");
});

test("商户重复应用和原请求冲突展示具体原因，并保留可修改输入", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  state.merchants = [];
  state.currentMerchantId = null;
  state.createError = {
    code: "MERCHANT_CONFLICT",
    message: "此商户应用已配置，请使用原配置维护",
  };
  await page.goto("/my/merchants");
  await page.getByLabel("商户名称", { exact: true }).fill("待保存商户");
  await page.getByLabel("Client ID", { exact: true }).fill("mock_client");
  await page.getByLabel("模拟密钥", { exact: true }).fill("VIRTUAL-CONFLICT");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(state.createError.message);
  await expect(page.getByLabel("Client ID", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("模拟密钥", { exact: true })).toHaveValue(
    "VIRTUAL-CONFLICT",
  );
  await expect(page.getByText(/活动已在其他页面修改/)).toHaveCount(0);
  state.createError = {
    code: "MERCHANT_CONFLICT",
    message: "同一创建请求不能更换商户配置",
  };
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(state.createError.message);
});

test("商户版本冲突提示刷新商户配置且保留未保存名称和密钥", async ({ page }) => {
  const { state } = await mockPayments(page);
  state.updateConflict = true;
  await page.goto(`/my/merchants/${merchantId}`);
  await page.getByLabel("商户名称", { exact: true }).fill("未保存的商户改动");
  await page
    .getByLabel("更换模拟密钥", { exact: true })
    .fill("VIRTUAL-PENDING");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText(/请先刷新商户配置后重试/)).toBeVisible();
  await expect(page.getByLabel("商户名称", { exact: true })).toHaveValue(
    "未保存的商户改动",
  );
  await expect(page.getByLabel("更换模拟密钥", { exact: true })).toHaveValue(
    "VIRTUAL-PENDING",
  );
  await expect(page.getByText(/活动已在其他页面修改/)).toHaveCount(0);
});

for (const action of ["立即检查恢复条件", "应用模拟情形"] as const) {
  test(`${action}不会提升未刷新的商户表单版本或覆盖另一页面的修改`, async ({
    page,
  }) => {
    const { state } = await mockPayments(page);
    await page.goto(`/my/merchants/${merchantId}`);
    await expect(page.getByLabel("商户名称", { exact: true })).toHaveValue(
      "测试商户",
    );
    await page
      .getByLabel("商户名称", { exact: true })
      .fill("页面 A 未保存改动");
    await page.getByLabel("更换模拟密钥", { exact: true }).fill("VIRTUAL-A");
    state.merchant = {
      ...state.merchant,
      label: "页面 B 已保存名称",
      version: 2,
    };
    if (action === "应用模拟情形")
      await page
        .getByRole("combobox", { name: "付款情形", exact: true })
        .selectOption("response_lost");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(
      page.getByText(
        action === "立即检查恢复条件"
          ? "已请求检查恢复条件。"
          : "模拟情形已设置。",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByText(/请先刷新商户配置后重试/)).toBeVisible();
    expect(state.updates).toEqual([
      { version: 1, label: "页面 A 未保存改动", secret: "VIRTUAL-A" },
    ]);
    expect(state.merchant.label).toBe("页面 B 已保存名称");
    expect(state.merchant.version).toBe(2);
    await expect(page.getByLabel("商户名称", { exact: true })).toHaveValue(
      "页面 A 未保存改动",
    );
    await expect(page.getByLabel("更换模拟密钥", { exact: true })).toHaveValue(
      "VIRTUAL-A",
    );
  });
}

test("固定金额输入每份金额并无损计算总额，格式错误不创建活动", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  await ldcWizard(page);
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.001");
  await page.getByLabel("奖励份数", { exact: true }).fill("2");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("两位小数");
  expect(state.activityCreates).toHaveLength(0);
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("5.00");
  await expect(page.getByText(/总发放金额：10.00 LDC/)).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${activityId}`);
  const config = state.activityCreates[0]?.activity;
  expect(config?.rewardType).toBe("ldc");
  expect(config).not.toHaveProperty("rewards");
  if (config?.rewardType === "ldc")
    expect(config.money).toEqual({
      mode: "fixed",
      totalAmount: "10.00",
      count: 2,
    });
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  await expect(page.getByLabel("每份金额（LDC）", { exact: true })).toHaveValue(
    "5.00",
  );
});

test("自定义金额逐份保留并支持随机抽取，金额公开开关独立保存", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  await ldcWizard(page);
  await page
    .getByRole("combobox", { name: "奖励方式", exact: true })
    .selectOption("custom");
  await page
    .getByLabel("每份金额（每行一个）", { exact: true })
    .fill("1.11\n2.22\n1.11");
  await page.locator("#ldc-custom-allocation").selectOption("random");

  await page.getByLabel("展示领取名单", { exact: true }).check();

  await expect(page.getByText(/总发放金额：4.44 LDC/)).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${activityId}`);
  const config = state.activityCreates[0]?.activity;
  if (config?.rewardType !== "ldc") throw new Error("Expected LDC activity");
  expect(config.money).toEqual({
    mode: "custom",
    amounts: ["1.11", "2.22", "1.11"],
  });
  expect(config.allocation).toBe("random");
  expect(config.showRecipientAmount).toBe(true);
});

for (const algorithm of ["double_mean_v1", "bounded_mean_v1"] as const) {
  test(`随机金额 ${algorithm} 校验、草稿修改与开放冻结，窄屏流程可用`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { state } = await mockPayments(page);
    await ldcWizard(page);
    await page
      .getByRole("combobox", { name: "奖励方式", exact: true })
      .selectOption("random");
    await page.locator("#ldc-random-algorithm").selectOption(algorithm);
    await expect(page.locator("#activity-money")).toHaveValue("random");
    await expect(page.locator("#ldc-random-algorithm")).toHaveValue(algorithm);
    await expect(page.locator("#activity-allocation")).toHaveCount(0);
    await page.getByLabel("总奖池（LDC）", { exact: true }).fill("0.02");
    await page.getByLabel("奖励份数", { exact: true }).fill("3");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(
      page.getByText("总金额不足，每份至少需要 0.01 LDC", { exact: true }),
    ).toBeVisible();
    expect(state.activityCreates).toHaveLength(0);
    await page.getByLabel("总奖池（LDC）", { exact: true }).fill("10.00");
    if (algorithm === "bounded_mean_v1")
      await expect(
        page.getByText("每份金额范围：1.66–5.00 LDC", { exact: true }),
      ).toBeVisible();
    await expect(page.getByText(/总发放金额：10.00 LDC/)).toBeVisible();
    await expect(
      page.getByText(/保存草稿时生成金额；修改总额、份数或算法会重新生成/),
    ).toBeVisible();
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page).toHaveURL(`/my/activities/${activityId}`);
    await expect(page.getByText("10.00 LDC", { exact: true })).toBeVisible();
    expect(state.activityCreates[0]?.activity).toMatchObject({
      rewardType: "ldc",
      allocation: "random",
      money: { mode: "random", algorithm, totalAmount: "10.00", count: 3 },
    });
    await expect(
      page.getByText(/保存草稿时生成金额；修改总额、份数或算法会重新生成/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /重抽|预览金额/ }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "编辑活动", exact: true }).click();

    await expect(
      page.getByRole("combobox", { name: "奖励方式", exact: true }),
    ).toHaveValue("random");
    await expect(page.locator("#ldc-random-algorithm")).toHaveValue(algorithm);
    await page.getByLabel("总奖池（LDC）", { exact: true }).fill("21.00");
    await page.getByLabel("奖励份数", { exact: true }).fill("7");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "开放领取", exact: true }),
    ).toBeEnabled();
    await expect(page.getByText("21.00 LDC", { exact: true })).toBeVisible();
    expect(state.activityUpdates[0]?.activity).toMatchObject({
      allocation: "random",
      money: { mode: "random", algorithm, totalAmount: "21.00", count: 7 },
    });
    await page.getByRole("button", { name: "开放领取", exact: true }).click();
    await expect(page.getByText("活动已开放。", { exact: true })).toBeVisible();
    await expect(
      page.getByText("金额已固定，领取和付款重试不会重新生成。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(state.activityOpens).toBe(1);
    expect(state.csrf.every((token) => token === "payment-csrf")).toBe(true);

    await page.getByRole("button", { name: "编辑活动", exact: true }).click();

    for (const selector of [
      "#activity-money",
      "#ldc-total",
      "#ldc-count",
      "#activity-merchantId",
    ])
      await expect(page.locator(selector)).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("限时草稿尚未开始报名，开放后才显示报名中", async ({ page }) => {
  const { state } = await mockPayments(page);
  state.activity.config = {
    ...state.activity.config,
    rewardType: "ldc",
    merchantId,
    allocation: "random",
    money: {
      mode: "timed_draw",
      algorithm: "double_mean_v1",
      totalAmount: "10.00",
      count: 2,
      participantLimit: 3,
      countdownSeconds: 90,
      distributeFullPool: true,
    },
  };
  state.activity.status = "draft";
  state.activity.openedAt = null;
  state.activity.deadlineAt = null;
  state.activity.draw = {
    state: "waiting",
    deadlineAt: null,
    closedAt: null,
    reason: null,
    registeredCount: 0,
    winnerCount: null,
    participantLimit: 3,
  };
  await page.route(
    `**/api/me/activities/${activityId}/registrations*`,
    (route) => route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.goto(`/my/activities/${activityId}`);
  await expect(
    page.getByText("准备中，开放后开始报名和倒计时", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("报名中，等待开奖", { exact: true })).toHaveCount(
    0,
  );
  const deadlineAt = new Date(Date.now() + 90_000).toISOString();
  state.activity.status = "active";
  state.activity.openedAt = new Date().toISOString();
  state.activity.deadlineAt = deadlineAt;
  state.activity.draw.deadlineAt = deadlineAt;
  await page.getByRole("button", { name: "刷新最新版本", exact: true }).click();
  await expect(
    page.getByText("报名中，等待开奖", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("准备中，开放后开始报名和倒计时", { exact: true }),
  ).toHaveCount(0);
});

test("限时开奖方案保存名额、报名上限、短倒计时和算法，允许报名上限小于名额", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  await ldcWizard(page);
  const choice = page.getByRole("combobox", { name: "奖励方式", exact: true });
  await page.locator("summary").filter({ hasText: "更多设置" }).click();
  await page.locator("#activity-deadline").selectOption("at");
  await expect(page.locator("#activity-deadline")).toHaveValue("at");
  await choice.selectOption("timed_draw");
  await expect(page.locator("#activity-money")).toHaveValue("timed_draw");
  await page.locator("#timed-total").fill("0.50");
  await page.locator("#timed-count").fill("5");
  await page.locator("#timed-participant-limit").fill("3");
  await page.locator("#timed-countdown").fill("90");
  await page.locator("#timed-algorithm").selectOption("bounded_mean_v1");
  await page.getByLabel(/人数不足时发完奖池/).uncheck();
  await expect(page.getByText(/3 人报名/).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "活动摘要" })).toContainText(
    "最多 5 人获奖",
  );
  await expect(page.getByRole("region", { name: "活动摘要" })).toContainText(
    "最多 3 人报名，满员提前开奖",
  );
  await expect(page.getByRole("region", { name: "活动摘要" })).toContainText(
    "剩余不发",
  );
  await expect(
    page
      .getByRole("region", { name: "活动摘要" })
      .getByText(/总奖池 0.50 LDC.*最晚在开放后 90 秒/),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${activityId}`);
  expect(state.activityCreates[0]?.activity).toMatchObject({
    rewardType: "ldc",
    allocation: "random",
    deadline: { mode: "duration" },
    money: {
      mode: "timed_draw",
      algorithm: "bounded_mean_v1",
      totalAmount: "0.50",
      count: 5,
      participantLimit: 3,
      countdownSeconds: 90,
      distributeFullPool: false,
    },
  });
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  await expect(page.locator("#timed-participant-limit")).toHaveValue("3");
  await expect(page.locator("#timed-countdown")).toHaveValue("90");
});

test("四类 LDC 方案保留临时输入，算法和发放顺序是独立子选项", async ({
  page,
}) => {
  await mockPayments(page);
  await ldcWizard(page);
  const choice = page.getByRole("combobox", { name: "奖励方式", exact: true });
  await expect(choice.locator("option")).toHaveCount(4);
  await expect(choice.locator("option")).toHaveText([
    "固定均分",
    "即时随机",
    "自定义金额",
    "限时开奖",
  ]);
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("4.00");
  await page.getByLabel("奖励份数", { exact: true }).fill("3");
  await choice.selectOption("random");
  await expect(page.getByLabel("总奖池（LDC）", { exact: true })).toHaveValue(
    "12.00",
  );
  await page.getByLabel("总奖池（LDC）", { exact: true }).fill("10.00");
  await page.getByLabel("奖励份数", { exact: true }).fill("4");
  await page.locator("#ldc-random-algorithm").selectOption("bounded_mean_v1");
  await page.getByLabel("总奖池（LDC）", { exact: true }).fill("20.00");
  await page.getByLabel("奖励份数", { exact: true }).fill("3");
  await choice.selectOption("custom");
  await page
    .getByLabel("每份金额（每行一个）", { exact: true })
    .fill("1.00\n2.00");
  await page.locator("#ldc-custom-allocation").selectOption("random");
  await expect(
    page.getByLabel("每份金额（每行一个）", { exact: true }),
  ).toHaveValue("1.00\n2.00");
  await page
    .getByLabel("每份金额（每行一个）", { exact: true })
    .fill("3.00\n4.00");
  await choice.selectOption("fixed");
  await expect(page.getByLabel("每份金额（LDC）", { exact: true })).toHaveValue(
    "4.00",
  );
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("3");
  await choice.selectOption("random");
  await expect(page.locator("#ldc-random-algorithm")).toHaveValue(
    "bounded_mean_v1",
  );
  await expect(page.getByLabel("总奖池（LDC）", { exact: true })).toHaveValue(
    "20.00",
  );
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("3");
  await page.locator("#ldc-random-algorithm").selectOption("double_mean_v1");
  await expect(page.getByLabel("总奖池（LDC）", { exact: true })).toHaveValue(
    "20.00",
  );
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("3");
  await choice.selectOption("custom");
  await expect(
    page.getByLabel("每份金额（每行一个）", { exact: true }),
  ).toHaveValue("3.00\n4.00");
  await expect(page.locator("#ldc-custom-allocation")).toHaveValue("random");
  await choice.selectOption("timed_draw");
  await expect(page.locator("#timed-count")).toHaveValue("2");
  await expect(page.locator("#timed-participant-limit")).toHaveValue("2");
  await page.locator("#timed-participant-limit").clear();
  await expect(page.locator("#timed-participant-limit")).toHaveValue("");
  await choice.selectOption("fixed");
  await choice.selectOption("timed_draw");
  await expect(page.locator("#timed-participant-limit")).toHaveValue("");
  await choice.selectOption("random");
  await page.locator("#ldc-random-algorithm").selectOption("bounded_mean_v1");
  await page.getByLabel("总奖池（LDC）", { exact: true }).fill("0.03");
  await page.getByLabel("奖励份数", { exact: true }).fill("3");
  await expect(
    page.getByText("每份金额范围：0.01–0.01 LDC", { exact: true }),
  ).toBeVisible();
});

test("后台付款响应结束后返回前台仍继续轮询，隐藏期间不发送轮询请求", async ({
  page,
}) => {
  const { state, claim } = await mockPayments(page);
  state.claim = claim();
  state.delayClaimRead = true;
  await page.clock.install();
  await page.goto(`/activities/${activityId}`);
  await expect.poll(() => Boolean(state.releaseClaimRead)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  state.delayClaimRead = false;
  state.releaseClaimRead?.();
  await expect(page.getByText("等待恢复", { exact: true })).toBeVisible();
  const hiddenReads = state.claimReads;
  await page.clock.runFor(31_000);
  expect(state.claimReads).toBe(hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(15_100);
  await expect.poll(() => state.claimReads).toBeGreaterThan(hiddenReads);
});

test("LDC领取锁定金额并解锁说明，确认模拟发放后停止付款轮询", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  await page.clock.install();
  await page.goto(`/activities/${activityId}`);
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await expect(page.getByText("5.00 LDC", { exact: true })).toBeVisible();
  await expect(page.getByText("等待恢复", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "领取后已解锁" }),
  ).toBeVisible();
  if (state.claim?.rewardType !== "ldc") throw new Error("Expected LDC claim");
  state.claim = {
    ...state.claim,
    payment: {
      ...state.claim.payment,
      status: "confirmed",
      reason: null,
      confirmedAt: new Date().toISOString(),
    },
  };
  await page.clock.fastForward(15_100);
  await expect(page.getByText("模拟发放已确认", { exact: true })).toBeVisible();
  await expect(page.getByText(/不会产生真实 LDC 转账/)).toBeVisible();
  const reads = state.claimReads;
  await page.clock.fastForward(46_000);
  await expect(page.getByText("5.00 LDC", { exact: true })).toBeVisible();
  expect(state.claimReads).toBe(reads);
  expect(state.claimPosts).toBe(1);
});

test("公开名单金额开关关闭时不展示金额，开启后仅展示服务端提供金额", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  state.signedIn = false;
  state.showRecipients = true;
  await page.goto(`/activities/${activityId}`);
  await expect(
    page.getByRole("button", { name: user.displayName }),
  ).toBeVisible();
  await expect(page.getByText("5.00 LDC", { exact: true })).toHaveCount(0);
  state.recipientAmount = "5.00";
  await page.reload();
  await expect(page.getByText("5.00 LDC", { exact: true })).toBeVisible();
  expect(state.claimReads).toBe(0);
});

test("退出后清除商户密钥输入，迟到的创建响应不能恢复页面或导航", async ({
  page,
}) => {
  const { state } = await mockPayments(page);
  state.merchants = [];
  state.currentMerchantId = null;
  state.delayCreate = true;
  await page.goto("/my/merchants");
  await page.getByLabel("商户名称", { exact: true }).fill("未决模拟商户");
  await page.getByLabel("Client ID", { exact: true }).fill("mock_pending");
  await page.getByLabel("模拟密钥", { exact: true }).fill("DO-NOT-RETAIN");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect.poll(() => Boolean(state.releaseCreate)).toBe(true);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "请先登录", exact: true }),
  ).toBeVisible();
  state.releaseCreate?.();
  await expect(page.getByLabel("模拟密钥", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL("/my/merchants");
  expect(await page.content()).not.toContain("DO-NOT-RETAIN");
});

test("已有当前商户只能维护，历史商户保留查看入口", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  state.merchants.push({
    ...state.merchant,
    id: "8c9473a5-e887-4290-9e20-9cc51681fca0",
    label: "历史发放商户",
    usageStatus: "legacy",
    publicationEligibility: {
      allowed: false,
      reason: "MERCHANT_LEGACY",
      credentialVersion: 1,
    },
  });
  await page.goto("/my/merchants");
  await expect(page.getByText("当前商户", { exact: true })).toBeVisible();
  await expect(page.getByText("历史商户", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存商户", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "管理商户", exact: true }),
  ).toHaveCount(2);
  expect(state.creates).toHaveLength(0);
});

test("非本地环境只提供真实商户配置，模拟选项不可见", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  state.merchants = [];
  state.currentMerchantId = null;
  state.canSimulate = false;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/my/merchants");
  const mode = page.getByLabel("付款模式（保存后不可修改）");
  await expect(mode).toHaveValue("real");
  await expect(mode.locator("option")).toHaveCount(1);
  await expect(page.getByLabel("模拟密钥", { exact: true })).toHaveCount(0);
  await page.getByLabel("商户名称", { exact: true }).fill("生产商户");
  await page
    .getByLabel("Client ID", { exact: true })
    .fill("virtual_production");
  await page
    .getByLabel("商户密钥", { exact: true })
    .fill("VIRTUAL-NO-LIVE-SECRET");
  await page.getByRole("button", { name: "保存商户", exact: true }).click();
  await expect(page).toHaveURL(`/my/merchants/${merchantId}`);
  expect(state.creates[0]?.mode).toBe("real");
  await expect(
    page.getByRole("heading", { name: "模拟故障", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("历史商户随机草稿无关编辑保留原绑定，明确同模式重新绑定才修改商户", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  const currentId = "74a7204a-5d13-4f14-bd35-be6a7275dc09";
  const money = {
    mode: "random",
    algorithm: "bounded_mean_v1",
    totalAmount: "10.00",
    count: 4,
  } as const;
  state.merchant = {
    ...state.merchant,
    usageStatus: "legacy",
    publicationEligibility: {
      allowed: false,
      reason: "MERCHANT_LEGACY",
      credentialVersion: 1,
    },
  };
  state.merchants = [
    state.merchant,
    {
      ...state.merchant,
      id: currentId,
      label: "当前真实商户",
      clientId: "current_real_client",
      usageStatus: "current",
      publicationEligibility: {
        allowed: true,
        reason: null,
        credentialVersion: 1,
      },
    },
  ];
  state.currentMerchantId = currentId;
  state.activity.config = {
    ...state.activity.config,
    rewardType: "ldc",
    merchantId,
    money,
    allocation: "random",
  };
  state.activity.openingBlockedReason = "MERCHANT_LEGACY";
  await page.goto(`/my/activities/${activityId}`);
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  await page.locator("#activity-title").fill("历史草稿只改标题");

  await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
    /测试商户.*历史商户/,
  );
  await expect(page.getByText(/草稿保留原商户，不会自动切换/)).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
  expect(state.activityUpdates[0]?.activity).toMatchObject({
    merchantId,
    money,
  });
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();

  await page.getByRole("button", { name: "改用当前商户", exact: true }).click();
  await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
    /当前真实商户.*当前商户/,
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("修改已保存。", { exact: true })).toBeVisible();
  expect(state.activityUpdates[1]?.activity).toMatchObject({
    merchantId: currentId,
    money,
  });
});

test("历史真实草稿不能重新绑定到不同模式的当前商户", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  const currentId = "820f13c6-6941-44a4-92f2-d1b6d134693f";
  state.merchants.push({
    ...state.merchant,
    id: currentId,
    usageStatus: "current",
    mode: "simulation",
    scenario: "normal",
    label: "当前模拟商户",
  });
  state.currentMerchantId = currentId;
  await page.goto(`/my/activities/${activityId}`);
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();

  await expect(
    page.getByText("当前商户付款模式与草稿不一致，不能重新绑定。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "改用当前商户", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("发放商户", { exact: true })).toHaveValue(
    /测试商户.*历史商户/,
  );
  expect(state.activityUpdates).toHaveLength(0);
});

for (const reason of [
  "MERCHANT_CREDENTIALS_UNVERIFIED",
  "MERCHANT_CREDENTIALS_CHECKING",
  "MERCHANT_CREDENTIALS_REJECTED",
  "MERCHANT_CREDENTIALS_UNAVAILABLE",
] as const) {
  test(`新真实活动开放受 ${reason} 限制，草稿保留可编辑`, async ({ page }) => {
    const { state } = await mockPayments(page, "real");
    state.activity.openingBlockedReason = reason;
    state.merchant.publicationEligibility = {
      allowed: false,
      reason,
      credentialVersion: 1,
    };
    if (reason === "MERCHANT_CREDENTIALS_UNVERIFIED")
      state.merchant.credentialVerification = {
        ...state.merchant.credentialVerification,
        status: "passed",
        checkedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      };
    await page.goto(`/my/activities/${activityId}`);
    await expect(
      page.getByRole("button", { name: "检查凭证并开放", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "编辑活动", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("link", { name: "检查发放商户凭证", exact: true }),
    ).toHaveAttribute("href", `/my/merchants/${merchantId}`);
    expect(state.activityOpens).toBe(0);
    expect(state.activity.status).toBe("draft");
  });
}

async function checkingActivity(page: Page) {
  const { state } = await mockPayments(page, "real");
  state.activity.openingBlockedReason = "MERCHANT_CREDENTIALS_UNVERIFIED";
  state.merchant.publicationEligibility = {
    allowed: false,
    reason: "MERCHANT_CREDENTIALS_UNVERIFIED",
    credentialVersion: 1,
  };
  await page.route(`**/api/me/activities/${activityId}/open`, async (route) => {
    if (state.activityOpens > 0) return route.fallback();
    state.activityOpens++;
    state.openRequests.push(route.request().postDataJSON());
    state.csrf.push(route.request().headers()["x-csrf-token"]);
    state.activity.openingBlockedReason = "MERCHANT_CREDENTIALS_CHECKING";
    state.merchant.credentialVerification = {
      ...state.merchant.credentialVerification,
      status: "checking",
    };
    state.merchant.publicationEligibility = {
      ...state.merchant.publicationEligibility,
      reason: "MERCHANT_CREDENTIALS_CHECKING",
    };
    return route.fulfill({
      status: 409,
      json: {
        error: {
          code: "MERCHANT_CREDENTIALS_CHECKING",
          message: "凭证检查已启动",
        },
      },
    });
  });
  const passed = () => {
    state.activity.openingBlockedReason = undefined;
    state.merchant.credentialVerification = {
      ...state.merchant.credentialVerification,
      status: "passed",
      checkedAt: new Date().toISOString(),
    };
    state.merchant.publicationEligibility = {
      allowed: true,
      reason: null,
      credentialVersion: state.merchant.credentialVersion,
    };
  };
  return { state, passed };
}

test("一次点击等待凭证检查并续接开放，所有请求固定初始活动和凭证版本", async ({
  page,
}) => {
  const { state, passed } = await checkingActivity(page);
  await page.goto(`/my/activities/${activityId}`);
  await page
    .getByRole("button", { name: "检查凭证并开放", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "正在检查凭证…", exact: true }),
  ).toBeDisabled();
  expect(state.activityOpens).toBe(1);
  expect(state.activity.status).toBe("draft");
  passed();
  await expect(page.getByText("活动已开放。", { exact: true })).toBeVisible();
  expect(state.activityOpens).toBe(2);
  expect(state.openRequests).toEqual([
    { version: 2, merchantId, credentialVersion: 1 },
    { version: 2, merchantId, credentialVersion: 1 },
  ]);
});

for (const change of ["activity", "credentials", "merchant"] as const) {
  test(`等待凭证时${change}改变取消续接，不采用最新版本自动开放`, async ({
    page,
  }) => {
    const { state, passed } = await checkingActivity(page);
    await page.goto(`/my/activities/${activityId}`);
    await page
      .getByRole("button", { name: "检查凭证并开放", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "正在检查凭证…", exact: true }),
    ).toBeVisible();
    if (change === "activity") state.activity.version++;
    else if (change === "credentials") state.merchant.credentialVersion++;
    else if (state.activity.config.rewardType === "ldc")
      state.activity.config = {
        ...state.activity.config,
        merchantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      };
    passed();
    await expect(
      page.getByText(
        /已修改，请检查最新配置后重新开放|凭证已更新，请检查最新配置后重新开放/,
      ),
    ).toBeVisible();
    expect(state.activityOpens).toBe(1);
    expect(state.activity.status).toBe("draft");
  });
}

for (const leave of ["navigation", "logout"] as const) {
  test(`凭证检查等待期间${leave}取消页面续接，迟到通过不能开放`, async ({
    page,
  }) => {
    const { state, passed } = await checkingActivity(page);
    await page.clock.install();
    await page.goto(`/my/activities/${activityId}`);
    await page
      .getByRole("button", { name: "检查凭证并开放", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "正在检查凭证…", exact: true }),
    ).toBeVisible();
    if (leave === "navigation")
      await page.getByRole("link", { name: "首页", exact: true }).click();
    else await page.getByRole("button", { name: "退出", exact: true }).click();
    passed();
    await page.clock.fastForward(10_000);
    expect(state.activityOpens).toBe(1);
    expect(state.activity.status).toBe("draft");
    if (leave === "navigation") await expect(page).toHaveURL("/");
    else
      await expect(
        page.getByRole("button", { name: "开放领取", exact: true }),
      ).toHaveCount(0);
  });
}

test("当前凭证允许时真实活动可开放，旧的付款能力字段不禁用领取", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  state.activity.openingBlockedReason = undefined;
  state.activity.config = {
    ...state.activity.config,
    rewardType: "ldc",
    merchantId,
    money: { mode: "fixed", totalAmount: "0.50", count: 5 },
  };
  state.activity.totalCount = 5;
  state.claimAmount = "0.10";
  state.claimPaymentReason = "credentials";
  state.merchant.publicationEligibility = {
    allowed: true,
    reason: null,
    credentialVersion: 1,
  };
  state.merchant.credentialVerification = {
    ...state.merchant.credentialVerification,
    status: "passed",
    checkedAt: new Date().toISOString(),
  };
  await page.goto(`/my/activities/${activityId}`);
  await page.getByRole("button", { name: "开放领取", exact: true }).click();
  await expect(page.getByText("活动已开放。", { exact: true })).toBeVisible();
  expect(state.activityOpens).toBe(1);
  expect(state.merchant.capabilities.canExecutePayments).toBe(false);
  state.merchant.credentialVerification = {
    ...state.merchant.credentialVerification,
    status: "rejected",
  };
  state.merchant.publicationEligibility = {
    allowed: false,
    reason: "MERCHANT_CREDENTIALS_REJECTED",
    credentialVersion: 1,
  };
  await page.getByRole("link", { name: "查看专属页", exact: true }).click();
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await expect(page.getByText("0.10 LDC", { exact: true })).toBeVisible();
  await expect(page.getByText(/奖励金额已锁定/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "领取后已解锁", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("0.10 LDC", { exact: true })).toBeVisible();
  expect(state.claimPosts).toBe(1);
});

test("已开放真实活动轮换检查中继续领取，作者自领仍被拦截", async ({ page }) => {
  const { state } = await mockPayments(page, "real");
  state.activity = {
    ...state.activity,
    status: "active",
    openingBlockedReason: undefined,
    openedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 86400000).toISOString(),
  };
  state.merchant.credentialVersion = 2;
  state.merchant.publicationEligibility = {
    allowed: false,
    reason: "MERCHANT_CREDENTIALS_CHECKING",
    credentialVersion: 2,
  };
  state.merchant.credentialVerification = {
    ...state.merchant.credentialVerification,
    credentialVersion: 2,
    status: "checking",
  };
  state.viewerIsAuthor = true;
  await page.goto(`/activities/${activityId}`);
  await expect(
    page.getByText("作者不能领取自己创建的 LDC 活动。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toHaveCount(0);
  state.viewerIsAuthor = false;
  await page.reload();
  await expect(
    page.getByRole("button", { name: "领取", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("兑换口令", { exact: true }).fill("Answer123");
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await expect(page.getByText(/奖励金额已锁定/)).toBeVisible();
  expect(state.claimPosts).toBe(1);
});

test("普通活动付款展示自动恢复与安全唤醒，不显示验收许可或重复验证", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  state.merchant.capabilities.canCheck = true;
  const payment: MerchantPaymentDetail = {
    ...acceptancePayment(),
    source: "claim",
    acceptanceId: null,
    claimId,
    activityId,
    status: "waiting",
    reason: "funds",
    unknownOutcome: false,
    recoveryPolicy: "claim_same_order_v1",
    nextAction: "send",
    nextSendAt: new Date().toISOString(),
    nextQueryAt: null,
  };
  state.payments = [payment];
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/my/merchants/${merchantId}/payments/${payment.id}`);
  await expect(page.getByText("活动领取", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "自动付款恢复", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "原单恢复授权", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "重复业务号验证", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "立即检查恢复条件", exact: true })
    .click();
  await expect(
    page.getByText("已请求检查恢复条件。", { exact: true }),
  ).toBeVisible();
  expect(state.checks).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("非整数份数不会使表单崩溃，保存明确拒绝且不创建活动", async ({ page }) => {
  const { state } = await mockPayments(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ldcWizard(page);
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.10");
  await page.getByLabel("奖励份数", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(state.activityCreates).toHaveLength(0);
  await page
    .getByRole("combobox", { name: "奖励方式", exact: true })
    .selectOption("random");
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("1.5");
  expect(errors).toEqual([]);
});

test("草稿随机模式首次切固定复用可精确均分的单价和份数", async ({ page }) => {
  const { state } = await mockPayments(page);
  state.activity.status = "draft";
  state.activity.openedAt = null;
  state.activity.deadlineAt = null;
  state.activity.config = {
    ...state.activity.config,
    rewardType: "ldc",
    merchantId,
    money: {
      mode: "random",
      algorithm: "bounded_mean_v1",
      totalAmount: "10.00",
      count: 4,
    },
    allocation: "random",
  };
  await page.goto(`/my/activities/${activityId}`);
  await page.getByRole("button", { name: "编辑活动", exact: true }).click();
  await page
    .getByRole("combobox", { name: "奖励方式", exact: true })
    .selectOption("fixed");
  await expect(page.getByLabel("每份金额（LDC）", { exact: true })).toHaveValue(
    "2.50",
  );
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("4");
});

test("奖励类型切换保留文本、批量输入与各金额方案的页面内存", async ({
  page,
}) => {
  await mockPayments(page);
  await ldcWizard(page);
  const type = page.getByRole("combobox", { name: "奖励类型", exact: true });
  const choice = page.getByRole("combobox", { name: "奖励方式", exact: true });
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.50");
  await page.getByLabel("奖励份数", { exact: true }).fill("3");
  await choice.selectOption("random");
  await page.locator("#ldc-random-algorithm").selectOption("bounded_mean_v1");
  await page.getByLabel("总奖池（LDC）", { exact: true }).fill("10.00");
  await page.getByLabel("奖励份数", { exact: true }).fill("4");
  await type.selectOption("text");
  await page.getByLabel("奖励 1", { exact: true }).fill("仅页面保留的文本");
  await page.locator("summary").filter({ hasText: "批量添加奖励" }).click();
  await page
    .getByLabel("批量添加：每行一份", { exact: true })
    .fill("还未添加的一份");
  await type.selectOption("ldc");
  await expect(choice).toHaveValue("random");
  await expect(page.locator("#ldc-random-algorithm")).toHaveValue(
    "bounded_mean_v1",
  );
  await expect(page.getByLabel("总奖池（LDC）", { exact: true })).toHaveValue(
    "10.00",
  );
  await choice.selectOption("fixed");
  await expect(page.getByLabel("每份金额（LDC）", { exact: true })).toHaveValue(
    "0.50",
  );
  await expect(page.getByLabel("奖励份数", { exact: true })).toHaveValue("3");
  await type.selectOption("text");
  await expect(page.getByLabel("奖励 1", { exact: true })).toHaveValue(
    "仅页面保留的文本",
  );
  await page.locator("summary").filter({ hasText: "批量添加奖励" }).click();
  await expect(
    page.getByLabel("批量添加：每行一份", { exact: true }),
  ).toHaveValue("还未添加的一份");
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toMatch(/仅页面保留|还未添加|Answer123/);
});

test("保存并开放失败保留已保存LDC草稿和输入，下次点击只更新原草稿", async ({
  page,
}) => {
  const { state } = await mockPayments(page, "real");
  await ldcWizard(page);
  await page.getByLabel("每份金额（LDC）", { exact: true }).fill("0.10");
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已保存");
  await expect(page).toHaveURL("/activities/new");
  await expect(
    page.getByRole("combobox", { name: "奖励类型", exact: true }),
  ).toHaveValue("ldc");
  await expect(page.getByLabel("每份金额（LDC）", { exact: true })).toHaveValue(
    "0.10",
  );
  expect(state.activityCreates).toHaveLength(1);
  state.merchant.publicationEligibility = {
    allowed: true,
    reason: null,
    credentialVersion: 1,
  };
  state.merchant.credentialVerification = {
    ...state.merchant.credentialVerification,
    status: "passed",
    checkedAt: new Date().toISOString(),
  };
  await page.getByRole("button", { name: "保存并开放", exact: true }).click();
  await expect(page).toHaveURL(`/my/activities/${activityId}`);
  expect(state.activityCreates).toHaveLength(1);
  expect(state.activityUpdates).toHaveLength(1);
  expect(state.activity.status).toBe("active");
});
