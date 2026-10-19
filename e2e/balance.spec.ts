import { expect, type Page, test } from "@playwright/test";
import type { BalanceTopup } from "../packages/contracts/src";
import {
  expectPath,
  mockSession,
  omniboxInput,
  openApp,
  viewer,
} from "./support/app";

// 站内🐟额 (docs/balance-design.md) against a mocked API: who sees it, the
// page, and the 转入 dialog's two boxes.

const topupId = "11111111-2222-4333-8444-555555555555";

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

async function mockBalance(page: Page) {
  const sent: unknown[] = [];
  await page.route("**/api/me/balance?**", (route) =>
    route.fulfill({
      json: {
        settings: {
          version: 3,
          topupEnabled: true,
          withdrawEnabled: false,
          topupFeePercent: 12,
          withdrawFeePercent: 12,
          withdrawMaxMinor: 100_000,
          topupMinMinor: 100,
          topupMaxMinor: 200_000,
          topupDailyHintMinor: 80_000,
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
});
