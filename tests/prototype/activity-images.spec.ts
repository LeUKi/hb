import { expect, test } from "@playwright/test";

test("分享图片的查看文字与圆章同心", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=weekend");
  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  await page.getByRole("menuitem", { name: "内嵌代码" }).click();
  const preview = page.locator(".activity-image-preview svg");
  await expect(preview.locator(".seal-text")).toHaveText("查看");
  const offset = await preview.evaluate((svg) => {
    const circle = svg.querySelector(".seal circle") as SVGCircleElement;
    const text = svg.querySelector(".seal-text") as SVGTextElement;
    const box = text.getBBox();
    return {
      x: box.x + box.width / 2 - circle.cx.baseVal.value,
      y: box.y + box.height / 2 - circle.cy.baseVal.value,
    };
  });
  expect(Math.abs(offset.x)).toBeLessThan(1);
  expect(Math.abs(offset.y)).toBeLessThan(1);
});

test("原型公开图片分享弹窗在手机支持历史关闭和回焦", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity");
  const share = page.getByRole("button", { name: "分享活动", exact: true });
  await share.click();
  await page.getByRole("menuitem", { name: "内嵌代码" }).click();
  const dialog = page.getByRole("dialog", { name: "内嵌代码" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("内嵌代码", { exact: true })).toHaveValue(
    /^<center>\n {2}<picture>/,
  );
  const code = await dialog
    .getByLabel("内嵌代码", { exact: true })
    .inputValue();
  expect(code).toMatch(/<\/picture>\n<\/center>$/);
  expect(code).not.toMatch(/<\/?a(?:\s|>)/);
  expect(code).not.toContain("prefers-reduced-motion");
  expect(code).not.toContain("motion=reduced");
  expect(code.match(/<source /g)).toHaveLength(1);
  const activityHref = code.match(/srcset="([^"]+)\/live\.svg 1x"/)?.[1];
  expect(activityHref).toBeTruthy();
  expect(activityHref).toMatch(/\p{Extended_Pictographic}/u);
  expect(activityHref).not.toContain("%");
  expect(code).toContain(`srcset="${activityHref}/live.svg 1x"`);
  expect(code).toContain(`src="${activityHref}/live.svg?fallback=public"`);
  await expect(dialog.locator(".activity-image-preview svg")).toHaveCount(1);
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(351);
  expect(bounds?.height).toBeLessThanOrEqual(812 * 0.85 + 1);
  await page.goBack();
  await expect(dialog).not.toBeVisible();
  await expect(share).toBeFocused();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("账号页移除本浏览器图片设置", async ({ page }) => {
  await page.goto("/#account");
  await expect(
    page.getByRole("heading", { name: "账号信息", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "本浏览器图片设置" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("图片时区", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("本浏览器最近一次图片请求", { exact: true }),
  ).toHaveCount(0);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
  { width: 1440, height: 480 },
  { width: 375, height: 480 },
]) {
  test(`内嵌代码弹窗在 ${viewport.width}×${viewport.height} 视口居中且内部滚动`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/#activity?sample=weekend");
    await page.getByRole("button", { name: "分享活动", exact: true }).click();
    await page.getByRole("menuitem", { name: "内嵌代码" }).click();
    const dialog = page.getByRole("dialog", { name: "内嵌代码" });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Missing dialog bounds");
    expect(
      Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2),
    ).toBeLessThan(1);
    expect(
      Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2),
    ).toBeLessThan(1);
    expect(bounds.width).toBeLessThanOrEqual(viewport.width - 24);
    expect(bounds.height).toBeLessThanOrEqual(viewport.height * 0.85 + 1);
    await expect(dialog.locator("p.muted")).toHaveCount(0);
    const body = dialog.locator(".activity-image-dialog-body");
    const code = dialog.getByLabel("内嵌代码", { exact: true });
    await code.focus();
    await code.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "复制内嵌代码", exact: true }),
    ).toBeFocused();
    if (viewport.height === 480) {
      expect(
        await body.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await body.hover({ position: { x: 8, y: 8 } });
      await page.mouse.wheel(0, 500);
      await expect
        .poll(() => body.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    }
    const after = await dialog.boundingBox();
    expect(after).toEqual(bounds);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "分享活动", exact: true }),
    ).toBeFocused();
  });
}
