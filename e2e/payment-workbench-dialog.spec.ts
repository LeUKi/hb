import { expect, type Page, test } from "@playwright/test";
import {
  merchantId,
  mockMerchantConfig,
  paymentId,
} from "./fixtures/merchant-config";

async function setup(page: Page) {
  const state = await mockMerchantConfig(page);
  const payment = state.payment;
  const activityId = payment.activityId;
  const profile = {
    id: "recipient",
    username: "Tester7369",
    displayName: "收款人",
    avatarUrl: null,
    accountTier: "standard",
  };
  await page.route(`**/api/me/activities/${activityId}`, (route) =>
    route.fulfill({
      json: {
        activity: {
          id: activityId,
          title: "工作台关联活动",
          rewardType: "ldc",
          status: "active",
          version: 1,
          createdAt: payment.createdAt,
          openedAt: payment.createdAt,
          deadlineAt: null,
          topicUrl: null,
          totalCount: 1,
          claimedCount: 1,
        },
      },
    }),
  );
  await page.route("**/api/me/payment-activities*", (route) =>
    route.fulfill({
      json: {
        total: 1,
        nextCursor: null,
        items: [
          {
            id: activityId,
            title: "工作台关联活动",
            rewardType: "ldc",
            status: "active",
            version: 1,
            createdAt: payment.createdAt,
            openedAt: payment.createdAt,
            deadlineAt: null,
            topicUrl: null,
            totalCount: 1,
            claimedCount: 1,
            merchantId,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/me/activities/${activityId}/payments*`, (route) =>
    route.fulfill({
      json: {
        activityId,
        merchantId,
        total: 1,
        nextCursor: null,
        summary: {
          pendingAmount: "0.10",
          confirmedAmount: "0.00",
          totalAmount: "0.10",
          pendingCount: 1,
          confirmedCount: 0,
          totalCount: 1,
        },
        items: [
          { ...state.payment, status: "pending", recipientProfile: profile },
        ],
      },
    }),
  );
  return { state, activityId };
}

for (const width of [1440, 375]) {
  test(`工作台 ${width}px 处理详情在原页弹窗打开，后退和关闭恢复入口`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const { state, activityId } = await setup(page);
    await page.goto(`/my/payments?activityId=${activityId}`);
    const row = page.locator(`[data-payment-id="${paymentId}"]`);
    await expect(row).toBeVisible();
    if (width === 375) await row.click();
    const source =
      width === 375
        ? page.getByRole("dialog")
        : page.locator(".work-payment-detail");
    const trigger = source.getByRole("link", {
      name: "查看处理详情",
      exact: true,
    });
    await expect(trigger).toHaveAttribute(
      "href",
      `/my/merchants?merchantId=${merchantId}&dialog=payment&taskId=${paymentId}`,
    );
    const sourceUrl = page.url();
    await trigger.click();
    const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
    await expect(
      detail.getByRole("table", { name: "付款处理记录" }),
    ).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(1);
    expect(page.url()).toBe(sourceUrl);
    await page.goBack();
    await expect(page.locator(".merchant-payment-dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.goForward();
    await expect(
      detail.getByRole("table", { name: "付款处理记录" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      detail.getByRole("table", { name: "付款处理记录" }),
    ).toBeVisible();
    await detail
      .getByRole("button", { name: "返回付款摘要", exact: true })
      .click();
    await expect(page.locator(".merchant-payment-dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(width === 375 ? row : trigger).toBeFocused();
    expect(state.retiredRequests).toEqual([]);
  });
}

test("工作台原订单修复未保存时返回需确认，取消保留密钥且关闭不堆叠模态", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 600 });
  const { activityId } = await setup(page);
  await page.goto(`/my/payments?activityId=${activityId}`);
  await page.locator(`[data-payment-id="${paymentId}"]`).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "查看处理详情", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  await detail
    .getByRole("button", { name: "更新原订单密钥", exact: true })
    .click();
  const input = detail.getByLabel("原订单商户密钥", { exact: true });
  await input.fill("VIRTUAL-UNSAVED-ORIGINAL");
  page.once("dialog", (dialog) => dialog.dismiss());
  await detail
    .getByRole("button", { name: "返回付款摘要", exact: true })
    .click();
  await expect(input).toHaveValue("VIRTUAL-UNSAVED-ORIGINAL");
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("VIRTUAL-UNSAVED-ORIGINAL");
});
