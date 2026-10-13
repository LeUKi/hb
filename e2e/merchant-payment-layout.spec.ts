import { expect, test } from "@playwright/test";
import {
  merchantId,
  mockMerchantConfig,
  paymentId,
} from "./fixtures/merchant-config";

test("付款时间线仅显示真实事件，按时间排序且不展示未来调度", async ({
  page,
}) => {
  const state = await mockMerchantConfig(page);
  state.payment = {
    ...state.payment,
    createdAt: "2026-10-12T01:00:00.000Z",
    firstSendAt: "2026-10-12T01:03:00.000Z",
    sendAcknowledgedAt: "2026-10-12T01:01:00.000Z",
    orderObservedAt: "2026-10-12T01:02:00.000Z",
    orderEvidence: "query",
    confirmedAt: "2026-10-12T01:04:00.000Z",
    nextRunAt: "2030-01-01T00:00:00.000Z",
    nextQueryAt: "2030-01-01T00:00:00.000Z",
  };
  await page.goto(`/my/merchants/${merchantId}/payments/${paymentId}`);
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  const timeline = detail.getByRole("list", { name: "付款时间线" });
  await expect(timeline.getByRole("listitem")).toHaveCount(5);
  expect(
    await timeline
      .getByRole("listitem")
      .evaluateAll((items) =>
        items.map((item) => item.querySelector("span")?.textContent),
      ),
  ).toEqual([
    "创建付款",
    "收到上游响应",
    "查到订单",
    "首次发送",
    "本站确认发放",
  ]);
  await expect(timeline).not.toContainText("2030");
  state.payment = {
    ...state.payment,
    firstSendAt: null,
    sendAcknowledgedAt: null,
    orderObservedAt: null,
    confirmedAt: null,
  };
  await detail.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(timeline.getByRole("listitem")).toHaveCount(1);
  await expect(timeline).toContainText("创建付款");
  expect(state.retiredRequests).toEqual([]);
});

test("付款表分页、阅读位置和原记录焦点在返回与刷新后恢复，读取失败保留记录", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  const state = await mockMerchantConfig(page);
  let failList = false;
  const reads: Array<string | null> = [];
  await page.route(
    new RegExp(`/api/me/merchants/${merchantId}/payments(?:\\?.*)?$`),
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      reads.push(cursor);
      if (failList)
        return route.fulfill({
          status: 503,
          json: { error: { code: "UNAVAILABLE", message: "暂不可用" } },
        });
      return route.fulfill({
        json: {
          items: Array.from({ length: 20 }, (_, index) => ({
            ...state.payment,
            id:
              index === 12
                ? paymentId
                : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            businessNo: `${cursor ? "page-two" : "page-one"}-${index}`,
            source: "acceptance",
            activityId: null,
          })),
          nextCursor: cursor ? null : "second-page",
        },
      });
    },
  );
  await page.goto("/my/merchants");
  await page.getByRole("link", { name: "付款记录", exact: true }).click();
  const list = page.getByRole("dialog", { name: "付款记录", exact: true });
  await expect(list.getByText("page-one-12", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(list.getByText("page-two-12", { exact: true })).toBeVisible();
  const scroll = list.locator(".merchant-payment-dialog__body");
  await scroll.evaluate((node) => {
    node.scrollTop = 400;
  });
  const row = list.locator(`tr[data-record-id="${paymentId}"]`);
  const trigger = row.getByRole("link", { name: "查看详情", exact: true });
  await trigger.focus();
  const position = await scroll.evaluate((node) => node.scrollTop);
  await trigger.click();
  const detail = page.getByRole("dialog", { name: "付款详情", exact: true });
  await detail
    .getByRole("button", { name: "返回付款记录", exact: true })
    .click();
  await expect(list.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBe(position);
  await page.reload();
  await expect(list.getByText("第 2 页", { exact: true })).toBeVisible();
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollTop))
    .toBe(position);
  failList = true;
  const refresh = list.locator(
    ".merchant-payment-dialog__header .list-refresh-button",
  );
  const before = await refresh.boundingBox();
  await refresh.click();
  await expect(refresh).toContainText("刷新失败");
  await expect(refresh).toHaveAttribute("title", "读取失败，请重试。");
  const during = await refresh.boundingBox();
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThan(1);
  await expect(list.locator(".refresh-notice")).toHaveCount(0);
  await expect(list.getByText("page-two-12", { exact: true })).toBeVisible();
  failList = false;
  await list.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(refresh).toContainText("已刷新");
  await expect(list.getByText("page-two-12", { exact: true })).toBeVisible();
  expect(reads.at(-1)).toBe("second-page");
  expect(state.retiredRequests).toEqual([]);
});

for (const width of [1440, 375]) {
  test(`短屏 ${width}px 放大文字仍保留紧凑表格、内部滚动及模态焦点`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 420 });
    await mockMerchantConfig(page);
    await page.goto("/my/merchants");
    await page.getByRole("link", { name: "付款记录", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "付款记录", exact: true });
    const row = modal.getByRole("table").locator("tbody tr");
    const rowHeight = await row.evaluate(
      (node) => node.getBoundingClientRect().height,
    );
    expect(rowHeight).toBeGreaterThanOrEqual(44);
    expect(rowHeight).toBeLessThanOrEqual(48);
    await page.addStyleTag({
      content: ".merchant-payment-dialog * { font-size: 20px !important; }",
    });
    const geometry = await modal.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const body = node.querySelector(".merchant-payment-dialog__body");
      const table = node.querySelector(".merchant-payment-table-scroll");
      return {
        width: bounds.width,
        height: bounds.height,
        pageWidth: document.documentElement.scrollWidth,
        bodyOverflow: body ? getComputedStyle(body).overflowY : "",
        tableOverflow: table ? getComputedStyle(table).overflowX : "",
        bodyOverscrollX: body ? getComputedStyle(body).overscrollBehaviorX : "",
        tableOverscrollX: table
          ? getComputedStyle(table).overscrollBehaviorX
          : "",
      };
    });
    expect(geometry.width).toBeLessThanOrEqual(Math.min(960, width - 24));
    expect(geometry.height).toBeLessThanOrEqual(420 * 0.85 + 1);
    expect(geometry.pageWidth).toBeLessThanOrEqual(width);
    expect(geometry.bodyOverflow).toBe("auto");
    expect(geometry.tableOverflow).toBe("auto");
    expect(geometry.bodyOverscrollX).toBe("auto");
    expect(geometry.tableOverscrollX).toBe("auto");
    const close = modal.getByRole("button", {
      name: "关闭付款记录",
      exact: true,
    });
    await expect(close).toBeInViewport();
    await close.focus();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("dialog[open]")),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "付款记录", exact: true }),
    ).toBeFocused();
  });
}
