import { expect, test } from "@playwright/test";

const square = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "活动广场", exact: true });

for (const width of [1440, 375]) {
  test(`public activities open above the input and browser history closes them at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#home");
    const input = page.locator("#home-password");
    const entry = page.getByRole("button", {
      name: "已公开的活动",
      exact: true,
    });
    await input.fill("保留的输入2026");
    await expect(entry).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(entry.locator("span")).toHaveCSS(
      "text-decoration-line",
      "underline",
    );
    const position = await entry.evaluate((node) => {
      const entry = node.getBoundingClientRect();
      const field = document
        .querySelector(".home-exchange .pw-input__field")
        ?.getBoundingClientRect();
      return { left: entry.left, bottom: entry.bottom, field };
    });
    expect(position.left).toBeCloseTo(position.field?.left ?? -1, 0);
    expect(position.bottom).toBeLessThanOrEqual(position.field?.top ?? -1);
    await expect(
      page.locator(
        '.site-header a[href="#square"], .mobile-nav a[href="#square"]',
      ),
    ).toHaveCount(0);
    await entry.click();
    await expect(square(page)).toBeVisible();
    await expect(
      square(page).getByRole("table", { name: "公开活动" }),
    ).toBeVisible();
    await expect(
      square(page).getByRole("button", { name: "关闭活动广场" }),
    ).toBeFocused();
    await page.goBack();
    await expect(square(page)).toHaveCount(0);
    await expect(input).toHaveValue("保留的输入2026");
    await expect(entry).toBeFocused();
    await page.goForward();
    await expect(square(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(square(page)).toHaveCount(0);
    await expect(entry).toBeFocused();
    await expect(input).toHaveValue("保留的输入2026");
  });
}

test("legacy square addresses restore a home modal and filter, page and scroll survive refresh", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#square");
  await expect(page).toHaveURL(/#home\?dialog=square$/u);
  await expect(page.locator(".home-page")).toBeVisible();
  await square(page).getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "进行中" }).click();
  const pagination = square(page).getByRole("navigation", {
    name: "活动广场分页",
  });
  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(pagination).toContainText("第 2 页");
  const scroll = square(page).locator(".list-panel__scroll");
  await scroll.evaluate((node) => {
    node.scrollTop = 120;
  });
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(120);
  await page.reload();
  await expect(square(page)).toBeVisible();
  await expect(
    square(page).getByRole("button", { name: "活动状态筛选" }),
  ).toHaveText("状态：进行中");
  await expect(pagination).toContainText("第 2 页");
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(120);
  await square(page).getByRole("button", { name: "刷新活动列表" }).click();
  await expect(pagination).toContainText("第 2 页");
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(120);
  await page.goBack();
  await expect(square(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#home$/u);
  await page.goForward();
  await expect(square(page)).toBeVisible();
  await expect(pagination).toContainText("第 2 页");
});

test("choosing an activity releases the modal and back restores the public list", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#home");
  await page.getByRole("button", { name: "已公开的活动", exact: true }).click();
  await square(page)
    .getByRole("button", { name: "周末红包 · 20 份", exact: true })
    .click();
  await expect(page).toHaveURL(/#activity\?sample=weekend$/u);
  await expect(square(page)).toHaveCount(0);
  await expect(page.locator(".activity-page h1")).toHaveText(
    "周末红包 · 20 份",
  );
  await page.goBack();
  await expect(square(page)).toBeVisible();
  await expect(page.locator(".home-page")).toBeVisible();
});

for (const width of [1440, 375]) {
  test(`short public activity modal keeps pagination and close keyboard accessible with 200 percent text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 320 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#square");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    const dialog = square(page);
    const close = dialog.getByRole("button", { name: "关闭活动广场" });
    await close.focus();
    await expect(close).toBeInViewport();
    const next = dialog
      .getByRole("navigation", { name: "活动广场分页" })
      .getByRole("button", { name: "下一页" });
    await next.focus();
    await expect(next).toBeInViewport();
    await expect(next).toBeFocused();
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "已公开的活动", exact: true }),
    ).toBeFocused();
  });
}
