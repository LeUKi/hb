import { expect, type Page, test } from "@playwright/test";
import type {
  BalanceTopup,
  BalanceWithdrawal,
} from "../packages/contracts/src";
import {
  expectPath,
  mockSession,
  omniboxInput,
  openApp,
  viewer,
} from "./support/app";

// 站内🐟额 (docs/balance-design.md) against a mocked API: who sees it, the
// page, the 转入 and 转出 dialogs' two boxes, and a 转出 as it is sent.

const topupId = "11111111-2222-4333-8444-555555555555";
const withdrawalId = "66666666-7777-4888-8999-aaaaaaaaaaaa";

function withdrawal(extra: Partial<BalanceWithdrawal> = {}): BalanceWithdrawal {
  return {
    id: withdrawalId,
    businessNo: "hb.lafi.sh_out_0123456789abcdef0123456789abcdef",
    externalOrderId: null,
    status: "sending",
    debitMinor: 1000,
    feeMinor: 120,
    creditMinor: 880,
    feePercent: 12,
    recipientUsername: viewer.username,
    createdAt: Date.now() - 30_000,
    sentAt: null,
    failedAt: null,
    failure: null,
    wait: "queued",
    resumeAt: null,
    ...extra,
  };
}

function topup(extra: Partial<BalanceTopup> = {}): BalanceTopup {
  const now = Date.now();
  return {
    id: topupId,
    businessNo: "hb.lafi.sh_in_0123456789abcdef0123456789abcdef",
    externalOrderId: null,
    status: "pending",
    flag: null,
    debitMinor: 11_364,
    feeMinor: 1364,
    creditMinor: 10_000,
    feePercent: 12,
    createdAt: now - 60_000,
    payableUntil: now + 9 * 60_000,
    creditedAt: null,
    creditedBy: null,
    lastCheckedAt: null,
    ...extra,
  };
}

async function mockBalance(page: Page, options: { withdraw?: boolean } = {}) {
  const sent: unknown[] = [];
  await page.route("**/api/me/balance?**", (route) =>
    route.fulfill({
      json: {
        settings: {
          version: 3,
          topupEnabled: true,
          withdrawEnabled: options.withdraw ?? false,
          topupFeePercent: 12,
          withdrawFeePercent: 12,
          withdrawMaxMinor: 100_000,
          topupMinMinor: 100,
          topupMaxMinor: 200_000,
          topupDailyHintMinor: 80_000,
          withdrawMinMinor: 100,
        },
        account: { availableMinor: 1234, lockedMinor: 0 },
        openTopups: 1,
        items: [
          { type: "topup", createdAt: Date.now() - 60_000, topup: topup() },
          {
            type: "adjustment",
            createdAt: Date.now() - 120_000,
            adjustment: {
              id: "adj-e2e-1",
              direction: "deduct",
              amountMinor: 200,
              reason: "Credit 退款后扣回",
              createdAt: Date.now() - 120_000,
            },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/me/balance/topups/check-open", (route) =>
    route.fulfill({ json: { credited: 0 } }),
  );
  await page.route("**/api/me/balance/topups", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { topup: topup(), cashierUrl: null } });
  });
  await page.route(`**/api/me/balance/topups/${topupId}/check`, (route) =>
    route.fulfill({ json: { topup: topup() } }),
  );
  return sent;
}

test.describe("站内🐟额", () => {
  test("名单外的人：用户卡片和命令里都没有，直接打开说暂未开放", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await page.route("**/api/me/balance?**", (route) =>
      route.fulfill({
        status: 404,
        json: {
          error: { code: "BALANCE_NOT_OPEN", message: "站内🐟额暂未开放" },
        },
      }),
    );
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/余额");
    await expect(page.getByRole("option", { name: /站内🐟额/ })).toHaveCount(0);
    await openApp(page, "/balance");
    await expect(
      page.getByRole("heading", { name: "站内🐟额暂未开放" }),
    ).toBeVisible();
  });

  test("名单里的人：能搜到；页面写着可用和明细；转入两个框互算，越界不能确认", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    const sent = await mockBalance(page);
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("/余额");
    await expect(page.getByRole("option", { name: /站内🐟额/ })).toBeVisible();

    await openApp(page, "/balance");
    await expect(page.getByRole("heading", { name: "站内🐟额" })).toBeVisible();
    await expect(page.locator("dl dd").first()).toHaveText(/12\.34\s*🐟/);
    await expect(
      page.getByText("有 1 笔转入还没到账", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Credit 退款后扣回")).toBeVisible();
    await expect(page.getByText("站长扣回")).toBeVisible();

    await page
      .locator("header")
      .getByRole("button", { name: "转入", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转入🐟额" });
    await dialog.getByLabel("到账").fill("100");
    await expect(dialog.getByLabel("Credit 扣除")).toHaveValue("113.64");
    await dialog.getByLabel("Credit 扣除").fill("100");
    await expect(dialog.getByLabel("到账")).toHaveValue("88.00");
    await dialog.getByLabel("Credit 扣除").fill("900");
    await expect(dialog.getByText(/每天最多能花出 800–2000 LDC/)).toBeVisible();
    // The bounds show only once an amount is past one, and say which.
    await expect(dialog.getByText(/一笔转入/)).toHaveCount(0);
    await dialog.getByLabel("Credit 扣除").fill("2000.01");
    await expect(dialog.getByText("一笔转入最多 2000.00 LDC。")).toBeVisible();
    await expect(dialog.getByText(/每天最多能花出/)).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "去 Credit 确认" }),
    ).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("到账").fill("0.5");
    await expect(dialog.getByText("一笔转入至少 1.00 LDC。")).toBeVisible();

    await dialog.getByLabel("到账").fill("100");
    await dialog.getByRole("button", { name: "去 Credit 确认" }).click();
    // No cashier this time: the 转入 itself, waiting to be confirmed.
    await expectPath(page, `/balance/${topupId}`);
    await expect(page.getByText("等你在 Credit 确认。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "去 Credit 确认" }),
    ).toBeVisible();
    expect(sent).toEqual([
      expect.objectContaining({
        settingsVersion: 3,
        by: "credit",
        amount: "100",
      }),
    ]);
  });

  test("转出：两个框互算，越界说是哪一头，申请后跟着它发出去", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockBalance(page, { withdraw: true });
    const asked: unknown[] = [];
    await page.route("**/api/me/balance/withdrawals", (route) => {
      asked.push(route.request().postDataJSON());
      return route.fulfill({ json: { withdrawal: withdrawal() } });
    });
    // The queue moves it: held by the daily limit, then 已发放.
    let reads = 0;
    await page.route(
      `**/api/me/balance/withdrawals/${withdrawalId}`,
      (route) => {
        reads += 1;
        return route.fulfill({
          json: {
            withdrawal:
              reads === 1
                ? withdrawal({
                    wait: "quota",
                    resumeAt: Date.now() + 3_600_000,
                  })
                : withdrawal({
                    status: "sent",
                    wait: null,
                    sentAt: Date.now(),
                    externalOrderId: "credit_9",
                  }),
          },
        });
      },
    );
    await openApp(page, "/balance");
    await page
      .locator("header")
      .getByRole("button", { name: "转出", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "转出🐟额" });
    await expect(
      dialog.getByText(`@${viewer.username}`, { exact: false }),
    ).toBeVisible();
    await dialog.getByLabel("扣除").fill("10");
    await expect(dialog.getByLabel("预计到账")).toHaveValue("8.80");
    await expect(dialog.getByText("分发费 1.20 LDC（12%）")).toBeVisible();
    // From what should arrive: the least that brings at least that much.
    await dialog.getByLabel("预计到账").fill("8.81");
    await expect(dialog.getByLabel("扣除")).toHaveValue("10.01");
    // 可用 is 12.34: more is refused, and so is less than 1.
    await expect(dialog.getByText(/一笔转出|可用只有/)).toHaveCount(0);
    await dialog.getByLabel("扣除").fill("20");
    await expect(dialog.getByText("可用只有 12.34 🐟。")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "转出", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await dialog.getByLabel("扣除").fill("0.5");
    await expect(dialog.getByText("一笔转出至少 1.00 🐟。")).toBeVisible();
    await dialog.getByLabel("扣除").fill("10");
    await dialog.getByRole("button", { name: "转出", exact: true }).click();

    await expectPath(page, `/balance/out/${withdrawalId}`);
    await expect(page.getByText(/平台今天的额度用完了/).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("已发放", { exact: true }).first()).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.getByText(`已发到你的 Credit 账户 @${viewer.username}。`),
    ).toBeVisible();
    await expect(page.getByText("credit_9")).toBeVisible();
    expect(asked).toEqual([
      expect.objectContaining({
        settingsVersion: 3,
        by: "debit",
        amount: "10",
      }),
    ]);
  });
});
