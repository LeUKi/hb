import { test as base, expect, type Locator } from "@playwright/test";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin !== "http://127.0.0.1:4177" ||
          /^\/api(?:\/|$)/u.test(url.pathname)
        ) {
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

async function scrollToRow(scroll: Locator, row: Locator) {
  await row.evaluate((element) => {
    const parent = element.closest(".list-panel__scroll");
    if (!parent) throw new Error("Missing list scroll region");
    parent.scrollTop +=
      element.getBoundingClientRect().top -
      parent.getBoundingClientRect().top -
      10;
    (element as HTMLElement).focus({ preventScroll: true });
  });
  return scroll.evaluate((element) => element.scrollTop);
}

for (const width of [1440, 900, 375]) {
  test(`payment density and selection preserve list position at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#payment");
    const activityScroll = page.locator(
      ".work-payment-activities .list-panel__scroll",
    );
    const activities = page.locator(".work-payment-activity-row");
    await expect(activities.first()).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "付款活动状态筛选" }).getByRole("tab"),
    ).toHaveText(["全部", "进行中", "已结束", "已归档"]);
    await expect(
      page.getByRole("button", { name: /接入验收付款/u }),
    ).toHaveCount(0);

    const row = activities.nth(8);
    const before = await scrollToRow(activityScroll, row);
    expect(before).toBeGreaterThan(0);
    const node = await row.elementHandle();
    await row.press("Enter");
    await expect(row).toHaveAttribute("aria-pressed", "true");
    if (width <= 760) {
      await page.getByRole("button", { name: "返回活动列表" }).click();
    }
    await expect
      .poll(() => activityScroll.evaluate((el) => el.scrollTop))
      .toBe(before);
    expect(await row.evaluate((el, previous) => el === previous, node)).toBe(
      true,
    );
    await expect(row).toBeFocused();

    const filter = page.getByRole("tablist", { name: "付款活动状态筛选" });
    await filter.getByRole("tab", { name: "已结束", exact: true }).click();
    await expect
      .poll(() => activityScroll.evaluate((el) => el.scrollTop))
      .toBe(0);
    const largeActivity = activities.filter({
      hasText: /^十月第一期红包已结束/u,
    });
    const activityHeight = await largeActivity.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(activityHeight).toBeGreaterThanOrEqual(width <= 760 ? 54 : 50);
    expect(activityHeight).toBeLessThanOrEqual(width <= 760 ? 58 : 54);
    await largeActivity.click();

    const targetScroll = page.locator(
      ".work-payment-targets .list-panel__scroll",
    );
    const targets = page.locator("[data-payment-id]");
    await expect(targets).toHaveCount(20);
    await expect(
      page.getByRole("tablist", { name: "发放目标状态筛选" }).getByRole("tab"),
    ).toHaveText(["全部", "待完成", "已发放"]);
    const target = targets.nth(12);
    const targetBefore = await scrollToRow(targetScroll, target);
    expect(targetBefore).toBeGreaterThan(0);
    await target.press("Enter");
    if (width < 1120) {
      const dialog = page.getByRole("dialog", { name: "付款详情" });
      await expect(dialog).toContainText("@");
      await page.keyboard.press("Escape");
    } else {
      await expect(page.locator(".work-payment-detail")).toContainText("@");
    }
    await expect
      .poll(() => targetScroll.evaluate((el) => el.scrollTop))
      .toBe(targetBefore);
    await expect(target).toBeFocused();
    const targetHeight = await target.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(targetHeight).toBeGreaterThanOrEqual(width <= 760 ? 54 : 50);
    expect(targetHeight).toBeLessThanOrEqual(width <= 760 ? 58 : 54);
    await expect(target.locator(".work-payment-copy strong")).toHaveCSS(
      "font-size",
      "13px",
    );
    await expect(target.locator(".work-payment-value strong")).toHaveCSS(
      "font-size",
      "14px",
    );
    await expect(target.locator("time")).toHaveCSS("font-size", "11px");
    await expect(target.locator(".work-payment-copy")).not.toContainText("@");
    if (width >= 1120)
      await expect(target.locator(".work-payment-chevron")).toBeHidden();
    else await expect(target.locator(".work-payment-chevron")).toBeVisible();

    await page
      .getByRole("navigation", { name: "发放目标分页" })
      .getByRole("button", { name: "下一页" })
      .click();
    await expect(targets).toHaveCount(10);
    await expect
      .poll(() => targetScroll.evaluate((el) => el.scrollTop))
      .toBe(0);
    await page
      .getByRole("tablist", { name: "发放目标状态筛选" })
      .getByRole("tab", { name: "已发放", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "发放目标分页" }),
    ).toContainText("第 1 页");

    if (width <= 760)
      await page.getByRole("button", { name: "返回活动列表" }).click();
    await filter.getByRole("tab", { name: "全部", exact: true }).click();
    await activities.filter({ hasText: /^限时开奖 · 10 个获奖名额/u }).click();
    await expect(targets).toHaveCount(0);
    await expect(
      page
        .getByRole("tablist", { name: "发放目标状态筛选" })
        .getByRole("tab", { name: "全部", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("navigation", { name: "发放目标分页" }),
    ).toContainText("第 1 页");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("payment rows accommodate enlarged text and long recipient names", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#payment?activity=20000000-0000-4000-8000-000000000003");
  const target = page.locator("[data-payment-id]").first();
  await expect(target).toBeVisible();
  const initialHeight = await target.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  // Stress the layout independently of the finite fixture names; no store is changed.
  await target.evaluate((el) => {
    const name = "一个需要完整保留辅助名称的很长很长的收款人昵称";
    const label = el.querySelector(".work-payment-copy strong");
    if (label) label.textContent = name;
    el.setAttribute("title", name);
    document.documentElement.style.fontSize = "200%";
  });
  await expect(target).toHaveAccessibleName(/一个需要完整保留辅助名称/u);
  await expect(target.locator(".work-payment-copy strong")).toHaveCSS(
    "font-size",
    "26px",
  );
  const geometry = await target.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    client: el.clientHeight,
    scroll: el.scrollHeight,
  }));
  expect(geometry.height).toBeGreaterThan(initialHeight);
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
  await target.focus();
  await target.press("Enter");
  await expect(page.getByRole("dialog", { name: "付款详情" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(target).toBeFocused();
});
