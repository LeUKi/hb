import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

async function selectLargePaymentActivity(page: Page) {
  await page
    .locator(".work-payment-activity-row")
    .filter({
      hasText: /^十月第一期红包已结束/u,
    })
    .click();
}

test("payment fixtures expose activity-scoped targets without old internal logs", async ({
  page,
}) => {
  await page.goto("/#payment");
  await selectLargePaymentActivity(page);

  await expect(page.locator(".work-payment-scope")).toContainText(
    "十月第一期红包",
  );
  await expect(page.locator("[data-payment-id]")).toHaveCount(20);
  const totals = await page
    .locator(".work-payment-heading-tools")
    .textContent();
  await page.locator('[data-payment-id="HB202610060002"]').click();
  const dates = await page
    .locator(".work-payment-detail time")
    .evaluateAll((nodes) =>
      nodes.map((node) => Date.parse(node.getAttribute("datetime") ?? "")),
    );
  expect(dates).toHaveLength(2);
  expect(dates[1]).toBeGreaterThanOrEqual(dates[0] ?? Infinity);
  await expect(
    page.locator("[data-payment-id]").locator(".work-payment-value > strong"),
  ).toHaveText(
    Array.from({ length: 20 }, (_, index) => {
      const amount = ["0.50", "0.88", "1.20"][index % 3];
      return `${amount}LDC`;
    }),
  );
  await expect(
    page.getByRole("navigation", { name: "发放目标分页" }),
  ).toContainText("第 1 页");

  await page
    .getByRole("navigation", { name: "发放目标分页" })
    .getByRole("button", { name: "下一页" })
    .click();
  await expect(page.locator("[data-payment-id]")).toHaveCount(10);
  await expect(page.locator(".work-payment-heading-tools")).toHaveText(
    totals ?? "",
  );
  await expect(
    page.locator("[data-payment-id]").locator(".work-payment-value > strong"),
  ).toHaveText(
    Array.from({ length: 10 }, (_, index) => {
      const amount = ["1.20", "0.50", "0.88"][index % 3];
      return `${amount}LDC`;
    }),
  );

  await page.locator('[data-payment-id="HB202610060021"]').click();
  const detail = page.locator(".work-payment-detail");
  await expect(detail).toContainText("CLAIM-000003-021");
  await expect(detail).toContainText("本站确认发放时间");
  await expect(detail).not.toContainText("处理记录");
  await expect(detail).not.toContainText("配置与更正");
  await expect(detail).not.toContainText("付款任务");
  await expect(detail).not.toContainText("首次发送");
});

test("payment activity filters follow deadlines without fabricating draw results", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/#payment");
  const filter = page.getByRole("tablist", { name: "付款活动状态筛选" });
  await filter.getByRole("tab", { name: /^进行中/u }).click();
  expect(
    await page.locator(".work-payment-activity-row").count(),
  ).toBeGreaterThan(1);
  await page.clock.fastForward("03:00:00");
  await expect(page.locator(".work-payment-activity-row")).toHaveCount(1);
  await expect(page.locator(".work-payment-activity-row")).toContainText(
    "正在开奖",
  );
  await expect(page.locator("[data-payment-id]")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "发放目标分页" }),
  ).toContainText("第 1 页");
});

test("payment page excludes operation acceptance fixtures", async ({
  page,
}) => {
  await page.goto("/#payment");
  await expect(page.getByRole("button", { name: /接入验收付款/u })).toHaveCount(
    0,
  );
  await expect(page.locator(".work-payment-page")).not.toContainText(
    "验收账号",
  );
  await selectLargePaymentActivity(page);
  await expect(page.locator("[data-payment-id]")).toHaveCount(20);
  await expect(page.locator(".work-payment-heading-tools")).toContainText(
    "已发放",
  );
});
