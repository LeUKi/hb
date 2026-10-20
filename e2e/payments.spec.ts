import { expect, type Page, test } from "@playwright/test";
import type {
  AccountPayment,
  AccountPaymentDetail,
  AccountPaymentList,
  Merchant,
  MerchantList,
  MerchantPaymentDetail,
  MerchantUsage,
} from "../packages/contracts/src";
import { mockSession, openApp, shown, viewer } from "./support/app";

// 付款记录, 付款详情 and LDC 商户配置 (migration phase 3), mocked.

const activityId = "aaaaaaaa-1111-4222-8333-444444444444";
const merchantId = "bbbbbbbb-1111-4222-8333-444444444444";
const hour = 3_600_000;

function payment(
  id: string,
  status: AccountPayment["status"],
  extra: Partial<AccountPayment> = {},
): AccountPayment {
  return {
    id,
    mode: "real",
    status,
    reason: status === "attention" ? "recipient" : null,
    confirmedAt:
      status === "confirmed" ? new Date(Date.now() - hour).toISOString() : null,
    amount: "0.66",
    businessNo: `hb_${id.replaceAll("-", "")}`,
    externalOrderId: status === "confirmed" ? "ldc_order_1" : null,
    createdAt: new Date(Date.now() - 2 * hour).toISOString(),
    nextRunAt: new Date(Date.now() + hour).toISOString(),
    source: "claim",
    claimId: `claim-${id}`,
    activityId,
    acceptanceId: null,
    merchantId,
    recipientProfile: {
      username: "linjian",
      displayName: "林间",
      avatarUrl: null,
    },
    ...extra,
  };
}

const list: AccountPaymentList = {
  items: [
    payment("11111111-2222-4333-8444-555555555551", "waiting", {
      reason: "credentials",
    }),
    payment("11111111-2222-4333-8444-555555555552", "attention"),
    payment("11111111-2222-4333-8444-555555555553", "confirmed"),
  ],
  activities: {
    [activityId]: {
      id: activityId,
      title: "周末红包",
      rewardType: "ldc",
      participationMode: "password",
      forceDedicated: false,
      status: "active",
      version: 2,
      createdAt: new Date(Date.now() - 3 * hour).toISOString(),
      openedAt: new Date(Date.now() - 3 * hour).toISOString(),
      deadlineAt: new Date(Date.now() + hour).toISOString(),
      topicUrl: null,
      totalCount: 5,
      claimedCount: 3,
      reward: {
        mode: "fixed",
        totalAmount: "3.30",
        unitAmount: "0.66",
        count: 5,
      },
      confirmedAmount: "0.66",
    },
  },
  summary: {
    confirmedAmount: "0.66",
    confirmedCount: 1,
    openAmount: "1.32",
    openCount: 2,
    attentionCount: 1,
    repairableCount: 1,
    firstRepairableId: "11111111-2222-4333-8444-555555555551",
  },
  total: 3,
  nextCursor: null,
};

function merchant(extra: Partial<Merchant> = {}): Merchant {
  return {
    id: merchantId,
    label: "默认商户",
    usageStatus: "current",
    publicationEligibility: {
      allowed: true,
      reason: null,
      credentialVersion: 2,
    },
    clientId: "new_client_2026",
    version: 3,
    credentialVersion: 2,
    pausedReason: null,
    createdAt: new Date(Date.now() - 48 * hour).toISOString(),
    updatedAt: new Date(Date.now() - hour).toISOString(),
    credentialVerification: {
      status: "passed",
      credentialVersion: 2,
      checkedAt: new Date(Date.now() - hour).toISOString(),
      nextCheckAt: null,
      reason: null,
    },
    capabilities: { canExecutePayments: true, canSimulate: false },
    mode: "real",
    ...extra,
  } as Merchant;
}

function detail(repaired: boolean): AccountPaymentDetail {
  const base = list.items[0] as AccountPayment;
  const payment: MerchantPaymentDetail = {
    ...base,
    status: repaired ? "reconciling" : "waiting",
    reason: repaired ? "unknown" : "credentials",
    config: {
      originalClientId: "old_client_2025",
      effectiveClientId: "old_client_2025",
      credentialVersion: 1,
      identityCorrectionVersion: 0,
      canRepairCredentials: !repaired,
    },
    identityCorrections: [],
    recipientProfile: base.recipientProfile,
    recoveryPolicy: "claim_same_order_v1",
    firstSendAt: base.createdAt,
    usernameCorrection: null,
    nextAction: repaired ? "query" : "none",
    nextSendAt: null,
    nextQueryAt: repaired ? new Date(Date.now() + 60_000).toISOString() : null,
    sendBlockReason: null,
    orderObservedAt: null,
    orderEvidence: null,
    retryAuthorization: null,
    duplicateProbe: null,
    recipientId: "1001",
    recipientUsername: "linjian",
    attemptCount: 1,
    reconciliationCount: 0,
    unknownOutcome: repaired,
    sendAcknowledgedAt: null,
    attempts: [
      {
        id: "attempt-1",
        operation: "send",
        purpose: "recovery",
        outcome: "rejected",
        reason: "credentials",
        httpStatus: 400,
        diagnosticSummary: null,
        recipientUsername: "linjian",
        credentialVersion: 1,
        startedAt: base.createdAt,
        finishedAt: base.createdAt,
      },
    ],
    nextAttemptsCursor: null,
  };
  return {
    payment,
    merchant: merchant(),
    activity: { id: activityId, title: "周末红包", draw: false },
  };
}

async function mockPayments(page: Page) {
  const filters: string[] = [];
  await page.route("**/api/me/payments?**", (route) => {
    filters.push(
      new URL(route.request().url()).searchParams.get("status") ?? "",
    );
    return route.fulfill({ json: list });
  });
  return filters;
}

test.describe("付款记录", () => {
  test("合计、两条提示、按红包分组和筛选", async ({ page }) => {
    await mockSession(page, viewer);
    const filters = await mockPayments(page);
    await openApp(page, "/payments");
    await expect(
      page
        .getByText("1 笔，其中 1 笔已暂停")
        .or(page.getByText("2 笔，其中 1 笔已暂停")),
    ).toBeVisible();
    await expect(page.getByText("有 1 笔付款等你更新原订单密钥")).toBeVisible();
    await expect(page.getByText("有 1 笔付款发送已暂停")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "周末红包", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText("已领 3 / 5 份 · 已发放 0.66 LDC"),
    ).toBeVisible();
    await expect(
      page.getByText("商户凭证失效，等待发红包的人更新。"),
    ).toBeVisible();
    await page
      .getByRole("group", { name: "付款状态" })
      .getByRole("button", { name: /未完成/ })
      .click();
    await expect(page).toHaveURL(/\/payments\?filter=open$/);
    await expect.poll(() => filters).toContain("open");
  });

  test("切走再回到标签页：列表和详情都不闪骨架屏", async ({ page }) => {
    await mockSession(page, viewer);
    await mockPayments(page);
    const id = "11111111-2222-4333-8444-555555555551";
    await page.route(`**/api/me/payments/${id}`, (route) =>
      route.fulfill({ json: detail(false) }),
    );
    let sessionReads = 0;
    await page.route("**/api/session", (route) => {
      sessionReads += 1;
      return route.fallback();
    });
    // Away and back (coming back reads the session again): the page must
    // stay as it is, never going back to its skeleton.
    const awayAndBack = async () => {
      await page.evaluate(() => {
        const flag = window as unknown as { sawSkeleton?: boolean };
        flag.sawSkeleton = false;
        new MutationObserver(() => {
          for (const node of document.querySelectorAll("[role=status]"))
            if (node.textContent === "正在读取…") flag.sawSkeleton = true;
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      const before = sessionReads;
      await page.evaluate(() => {
        const show = (state: "hidden" | "visible") => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => state,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        };
        show("hidden");
        show("visible");
      });
      await expect.poll(() => sessionReads).toBeGreaterThan(before);
      await page.waitForTimeout(1000);
      return page.evaluate(
        () => (window as unknown as { sawSkeleton?: boolean }).sawSkeleton,
      );
    };

    await openApp(page, "/payments");
    const list = page.getByRole("heading", { name: "付款记录", level: 1 });
    await expect(list).toBeVisible();
    expect(await awayAndBack()).toBe(false);
    await expect(list).toBeVisible();

    await openApp(page, `/payments/${id}`);
    const one = page.getByRole("heading", { name: "付给 林间" });
    await expect(one).toBeVisible();
    expect(await awayAndBack()).toBe(false);
    await expect(one).toBeVisible();
  });

  test("付款详情：更新原订单密钥后转为核对中", async ({ page }) => {
    await mockSession(page, viewer);
    let repaired = false;
    const id = "11111111-2222-4333-8444-555555555551";
    await page.route(`**/api/me/payments/${id}`, (route) =>
      route.fulfill({ json: detail(repaired) }),
    );
    const sent: unknown[] = [];
    await page.route(
      `**/api/me/merchants/${merchantId}/payments/${id}/credentials`,
      (route) => {
        sent.push(route.request().postDataJSON());
        repaired = true;
        return route.fulfill({
          json: { merchant: merchant(), payment: detail(true).payment },
        });
      },
    );
    await openApp(page, `/payments/${id}`);
    await expect(
      page.getByRole("heading", { name: "付给 林间" }),
    ).toBeVisible();
    await expect(
      page.getByText("这笔付款用的是更换前的集市应用，它的密钥失效了。", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("LDC 拒绝：商户凭证失效，等待发红包的人更新"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "订单用的是更换前的 Client ID；商户现在是 new_client_2026。",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("原订单 Client ID")).toHaveValue(
      "old_client_2025",
    );
    await page.getByLabel("原订单商户密钥").fill("local-test-only");
    await page.getByRole("button", { name: "保存原订单密钥" }).click();
    await expect(
      page.getByText("付款结果尚未明确，正在核对原订单。").first(),
    ).toBeVisible();
    await expect(page.getByLabel("原订单商户密钥")).toBeHidden();
    expect(sent[0]).toMatchObject({ version: 3, secret: "local-test-only" });
  });
});

test.describe("LDC 商户配置", () => {
  const usage: MerchantUsage = {
    activities: 3,
    activeActivities: 1,
    payments: 3,
    openPayments: 2,
    openAmount: "1.32",
    confirmedAmount: "0.66",
  };

  test("当前商户：凭证未通过、付款暂停和三个数", async ({ page }) => {
    await mockSession(page, viewer);
    await page.route("**/api/me/merchants", (route) =>
      route.fulfill({
        json: {
          items: [
            merchant({
              pausedReason: "funds",
              credentialVerification: {
                status: "rejected",
                credentialVersion: 2,
                checkedAt: new Date().toISOString(),
                nextCheckAt: null,
                reason: "credentials",
              },
            }),
          ],
          nextCursor: null,
          currentMerchantId: merchantId,
          canCreate: true,
          canSimulate: false,
        } satisfies MerchantList,
      }),
    );
    await page.route(`**/api/me/merchants/${merchantId}/usage`, (route) =>
      route.fulfill({ json: usage }),
    );
    await openApp(page, "/merchant");
    await expect(page.getByText("凭证未通过", { exact: true })).toBeVisible();
    await expect(
      page.getByText("凭证认证未通过，请核对 Client ID 和密钥。"),
    ).toBeVisible();
    await expect(page.getByText("付款已暂停：商户资金不足")).toBeVisible();
    await expect(page.getByText("进行中 1 个")).toBeVisible();
    await expect(page.getByText("1.32 LDC")).toBeVisible();
    // A new Client ID needs its own key.
    await page
      .getByRole("textbox", { name: "Client ID" })
      .fill("another_client");
    await expect(
      shown(page, "改了 Client ID，请同时填写这个应用的密钥"),
    ).toBeVisible();
  });

  test("每日额度用完：写明什么时候继续、几笔在排队", async ({ page }) => {
    await mockSession(page, viewer);
    await page.route("**/api/me/merchants", (route) =>
      route.fulfill({
        json: {
          items: [
            merchant({
              pausedReason: "quota",
              quotaResumeAt: new Date(
                Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) *
                  86_400_000 +
                  86_400_000 -
                  8 * 3_600_000 +
                  12 * 60_000,
              ).toISOString(),
            }),
          ],
          nextCursor: null,
          currentMerchantId: merchantId,
          canCreate: true,
          canSimulate: false,
        } satisfies MerchantList,
      }),
    );
    await page.route(`**/api/me/merchants/${merchantId}/usage`, (route) =>
      route.fulfill({ json: usage }),
    );
    await openApp(page, "/merchant");
    await expect(
      page.getByText("付款已暂停：今日 Credit 发放额度已用完"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "明天 0 点后自动继续，2 笔在排队，不需要在这里操作。领取不受影响。",
      ),
    ).toBeVisible();
  });

  test("还没有商户：填好三项保存后显示商户", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    let created = false;
    await page.route("**/api/me/merchants", (route) => {
      if (route.request().method() === "POST") {
        created = true;
        return route.fulfill({
          json: {
            merchant: merchant({
              credentialVerification: {
                status: "checking",
                credentialVersion: 1,
                checkedAt: null,
                nextCheckAt: null,
                reason: null,
              },
            }),
          },
        });
      }
      return route.fulfill({
        json: {
          items: created ? [merchant()] : [],
          nextCursor: null,
          currentMerchantId: created ? merchantId : null,
          canCreate: true,
          canSimulate: false,
        } satisfies MerchantList,
      });
    });
    await page.route(`**/api/me/merchants/${merchantId}/usage`, (route) =>
      route.fulfill({
        json: {
          ...usage,
          activities: 0,
          activeActivities: 0,
          payments: 0,
          openPayments: 0,
          openAmount: "0.00",
          confirmedAmount: "0.00",
        },
      }),
    );
    await openApp(page, "/merchant");
    await expect(page.getByLabel("商户名称")).toHaveValue("默认商户");

    // 怎么填: the two steps in LDC, with the address to paste.
    const help = page.getByRole("button", { name: "怎么填" });
    await help.click();
    const guide = page.getByRole("dialog", { name: "在 LDC 创建集市应用" });
    await expect(guide.getByText("第 1 步：创建集市应用")).toBeVisible();
    // It starts on LDC's 集市应用 page, in a new tab.
    const credit = guide.getByRole("link", {
      name: "打开 credit.linux.do/merchant",
    });
    await expect(credit).toHaveAttribute(
      "href",
      "https://credit.linux.do/merchant",
    );
    await expect(credit).toHaveAttribute("target", "_blank");
    await expect(guide.getByText("第 2 步：复制 API 配置")).toBeVisible();
    await expect(guide.getByRole("img")).toHaveCount(2);
    await guide.getByRole("button", { name: "复制建议地址" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("http://localhost:3000/");
    await guide.getByRole("button", { name: "知道了" }).click();
    await expect(guide).toHaveCount(0);
    await expect(help).toBeFocused();

    await page
      .getByRole("textbox", { name: "Client ID" })
      .fill("my_client_2026");
    await page.getByLabel("商户密钥").fill("local-test-only");
    await page.getByRole("button", { name: "保存配置" }).click();
    // Exact: the form fading out says 每个账号有一个当前商户 too.
    await expect(page.getByText("当前商户", { exact: true })).toBeVisible();
    await expect(page.getByText("还没有红包用它")).toBeVisible();
  });
});
