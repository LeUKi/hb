import { expect, test } from "@playwright/test";

for (const width of [1440, 375]) {
  test(`SVG 总览覆盖所有状态且印章居中，布局不溢出 ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const businessRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.endsWith("/live.svg")
      )
        businessRequests.push(url.pathname);
    });
    await page.goto("/#svg-gallery");
    await expect(
      page.getByRole("heading", { name: "SVG 红包总览", exact: true }),
    ).toBeVisible();
    expect(
      await page.locator("[data-sample-id]").count(),
    ).toBeGreaterThanOrEqual(42);
    const facts = await page.locator(".svg-gallery-grid").evaluate((grid) => {
      const svgs = [...grid.querySelectorAll("svg[data-scope]")];
      const ids = [...grid.querySelectorAll("[id]")].map(
        (element) => element.id,
      );
      const offsets = [
        ...grid.querySelectorAll<SVGTextElement>(
          ".seal-text, .ended-stamp-text",
        ),
      ]
        .filter((element) => element.textContent?.trim())
        .map((element) => {
          const shape = element.parentElement?.querySelector(
            "circle, rect",
          ) as SVGGraphicsElement;
          const shapeBox = shape.getBBox();
          const textBox = element.getBBox();
          return {
            text: element.textContent,
            x: Math.abs(
              textBox.x + textBox.width / 2 - shapeBox.x - shapeBox.width / 2,
            ),
            y: Math.abs(
              textBox.y + textBox.height / 2 - shapeBox.y - shapeBox.height / 2,
            ),
          };
        });
      return {
        states: [...new Set(svgs.map((svg) => svg.dataset.state))].sort(),
        uniqueIds: new Set(ids).size === ids.length,
        offsets,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(facts.states).toEqual([
      "active",
      "claimed",
      "drawing",
      "ended",
      "error",
      "loading",
      "neutral",
      "not_won",
      "pending",
      "registered",
      "unavailable",
    ]);
    expect(facts.uniqueIds).toBe(true);
    expect(facts.overflow).toBe(false);
    for (const offset of facts.offsets) {
      expect(offset.x, offset.text ?? "label").toBeLessThan(1);
      expect(offset.y, offset.text ?? "label").toBeLessThan(1);
    }
    const last = page.locator('[data-sample-id="large-amount"]');
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(businessRequests).toEqual([]);
    expect(await page.context().cookies()).toEqual([]);
  });
}

test("总览的数量隐私、付款文案、时区和原型入口可查看", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#home");
  await page.getByRole("link", { name: "SVG 红包总览", exact: true }).click();
  await expect(page).toHaveURL(/#svg-gallery$/);
  await expect(
    page.locator('[data-sample-id="neutral-blank"] .seal-text'),
  ).toBeEmpty();
  await expect(
    page.locator('[data-sample-id="public-fallback"] .seal-text'),
  ).toHaveText("查看活动");
  await expect(
    page.locator('[data-sample-id="public-fallback"] .snapshot-time'),
  ).toHaveCount(0);
  await page.getByLabel("样例分类", { exact: true }).selectOption("quantity");
  await expect(
    page.locator('[data-sample-id="quantity-hidden"] .data-row'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-sample-id="quantity-exact"] .data-row'),
  ).toHaveText(/剩余/);
  await page.getByLabel("样例分类", { exact: true }).selectOption("payment");
  await expect(
    page.locator('[data-sample-id="payment-reconciling"] .claimed-status'),
  ).toHaveText("正在核对原订单");
  await expect(
    page.locator('[data-sample-id="payment-confirmed"] .claimed-status'),
  ).toHaveText("已发放");
  const claimedAt = await page
    .locator('[data-sample-id="payment-confirmed"] .claimed-time')
    .getAttribute("data-claimed-at");
  await page.getByLabel("时区", { exact: true }).selectOption("UTC");
  await expect(
    page.locator('[data-sample-id="payment-confirmed"] .claimed-time'),
  ).toHaveText(/03:14:18 · UTC/);
  await expect(
    page.locator('[data-sample-id="payment-confirmed"] .claimed-time'),
  ).toHaveAttribute("data-claimed-at", claimedAt ?? "");
  await page.goBack();
  await expect(page).toHaveURL(/#home$/);
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "SVG 红包总览", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "SVG 红包总览", exact: true }),
  ).toBeVisible();
});

test("快照对照固定在指定时效，重播不更改快照或领取时间", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#svg-gallery");
  await page.getByLabel("样例分类", { exact: true }).selectOption("snapshot");
  await expect(page.locator("[data-sample-id]")).toHaveCount(4);
  await expect(
    page.locator('[data-sample-id="snapshot-0"] .freshness-warning'),
  ).toHaveCSS("opacity", "0");
  await expect(
    page.locator('[data-sample-id="snapshot-10"] .freshness-warning'),
  ).toHaveCSS("opacity", "1");
  await expect(
    page.locator('[data-sample-id="snapshot-30"] .stale-prompt'),
  ).toHaveCSS("opacity", "1");
  await expect(
    page.locator('[data-sample-id="snapshot-60"] .patina-wash'),
  ).toHaveCSS("opacity", "0.5");
  await expect(
    page.locator('[data-sample-id="snapshot-0"] .stale-prompt'),
  ).toHaveCSS("animation-play-state", "paused");
  await page.getByLabel("样例分类", { exact: true }).selectOption("payment");
  const svg = page.locator(
    '[data-sample-id="payment-confirmed"] svg[data-scope]',
  );
  const scope = await svg.getAttribute("data-scope");
  const time = await svg
    .locator(".claimed-time")
    .getAttribute("data-claimed-at");
  const button = page.getByRole("button", { name: /^重播动画/ });
  await button.click();
  await expect(button).toHaveText("已重播");
  await expect(svg).not.toHaveAttribute("data-scope", scope ?? "");
  await expect(svg.locator(".claimed-time")).toHaveAttribute(
    "data-claimed-at",
    time ?? "",
  );
  await page.getByLabel("减少动态效果", { exact: true }).check();
  await expect(button).toBeDisabled();
  await expect(svg.locator(".open-lower")).toHaveCount(0);
});

test("单张重播只更新当前红包，反馈留在原按钮", async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#svg-gallery");
  await page.getByLabel("样例分类", { exact: true }).selectOption("payment");
  const sample = page.locator('[data-sample-id="payment-confirmed"]');
  const other = page.locator(
    '[data-sample-id="payment-pending"] svg[data-scope]',
  );
  const otherNode = await other.elementHandle();
  const oldScope = await sample
    .locator("svg[data-scope]")
    .getAttribute("data-scope");
  const otherScope = await other.getAttribute("data-scope");
  const time = await sample
    .locator(".claimed-time")
    .getAttribute("data-claimed-at");
  const replay = sample.getByRole("button");
  await replay.scrollIntoViewIfNeeded();
  const box = await replay.boundingBox();
  await replay.click();
  await expect(replay).toHaveText("已重播");
  expect(await replay.boundingBox()).toEqual(box);
  await expect(sample.locator("svg[data-scope]")).not.toHaveAttribute(
    "data-scope",
    oldScope ?? "",
  );
  await expect(sample.locator(".claimed-time")).toHaveAttribute(
    "data-claimed-at",
    time ?? "",
  );
  await expect(other).toHaveAttribute("data-scope", otherScope ?? "");
  expect(await otherNode?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await page.clock.runFor(3000);
  await expect(replay).toHaveText("重播");
  await expect(replay).toBeFocused();
});
