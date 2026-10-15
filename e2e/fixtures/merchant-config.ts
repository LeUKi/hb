import type { Page } from "@playwright/test";
import type {
  Merchant,
  MerchantChangeImpact,
  MerchantPaymentDetail,
  RepairPaymentCredentialInput,
  UpdateMerchantInput,
} from "../../packages/contracts/src";

export const merchantId = "0e6bfcc0-8c62-4379-bd19-7f04a9032224";
export const paymentId = "a3dcdfce-ad13-4f21-990b-2f214c5e122d";
const user = {
  id: "merchant-config-author",
  username: "author",
  displayName: "配置作者",
  avatarUrl: null,
};

export async function mockMerchantConfig(page: Page) {
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
    createdAt: now,
    updatedAt: now,
    capabilities: {
      canExecutePayments: true,
      canSimulate: false,
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
    failRead: false,
    reads: 0,
    resourceReads: [] as string[],
    retiredRequests: [] as string[],
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
    if (
      request.method() === "GET" &&
      /^\/api\/me\/merchants\/[^/]+(?:\/payments\/[^/]+)?$/.test(path)
    )
      state.resourceReads.push(path);
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
    if (path.endsWith("/check") || path.endsWith("/verify")) {
      state.retiredRequests.push(path);
      return route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "未找到接口" } },
      });
    }
    if (path === "/api/me/merchants")
      return route.fulfill({
        json: {
          items: [state.merchant],
          currentMerchantId: merchantId,
          canCreate: false,
          canSimulate: false,
          nextCursor: null,
        },
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
          ...(body.secret
            ? {
                credentialVerification: {
                  status: "checking" as const,
                  credentialVersion: state.merchant.credentialVersion + 1,
                  checkedAt: null,
                  nextCheckAt: null,
                  reason: null,
                },
              }
            : {}),
        };
        const result = { merchant: state.merchant };
        if (body.requestId) savedUpdates.set(body.requestId, result);
        if (state.failUpdateResponse) {
          state.failUpdateResponse = false;
          return route.abort("failed");
        }
        return route.fulfill({ json: result });
      }
      state.reads++;
      if (state.failRead)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "暂不可用" } },
        });
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
