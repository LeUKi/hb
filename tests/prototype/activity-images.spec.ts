import { expect, type Locator, test } from "@playwright/test";

const feedbackLabel = (button: Locator) =>
  button.locator('[aria-live="polite"]').last();

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
    /<picture>/,
  );
  await expect(dialog.getByLabel("内嵌代码", { exact: true })).toHaveValue(
    /<a href="http:\/\/127\.0\.0\.1:4177\/e\//,
  );
  const code = await dialog
    .getByLabel("内嵌代码", { exact: true })
    .inputValue();
  const activityHref = code.match(/<a href="([^"]+)"/)?.[1];
  expect(activityHref).toBeTruthy();
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

test("原型时区偏好没有修改时禁用，内联预览不生成请求记录", async ({ page }) => {
  await page.goto("/#account");
  const panel = page.getByRole("region", { name: "本浏览器图片设置" });
  await expect(panel.getByRole("button", { name: "保存时区" })).toBeDisabled();
  await panel.getByLabel("图片时区", { exact: true }).selectOption("UTC");
  const save = panel.getByRole("button", { name: "保存时区" });
  await save.click();
  await expect(feedbackLabel(save)).toHaveText("已保存");
  await expect(save).toHaveAccessibleName("保存时区，已保存");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel.getByText("暂无可读取的图片请求记录。")).toBeVisible();
});
