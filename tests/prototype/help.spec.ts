import { test as base, expect } from "@playwright/test";

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

test("context help is keyboard accessible, exclusive, and returns focus on Escape", async ({
  page,
}) => {
  await page.goto("/#account");
  const email = page.getByRole("button", { name: "Connect 邮箱说明" });
  const tier = page.getByRole("button", { name: "账号资格说明" });
  await email.focus();
  await expect(
    page.getByRole("dialog", { name: "Connect 邮箱说明" }),
  ).toBeVisible();
  await tier.focus();
  await expect(page.locator(".context-help-popover")).toHaveCount(1);
  const panel = page.getByRole("dialog", { name: "账号资格说明" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: "关闭说明" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".context-help-popover")).toHaveCount(0);
  await expect(tier).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".context-help-popover")).toHaveCount(0);
});

test("help remains open while pointer enters and closes on an outside click", async ({
  page,
}) => {
  await page.goto("/#account");
  const trigger = page.getByRole("button", { name: "Connect 邮箱说明" });
  await trigger.hover();
  const panel = page.getByRole("dialog", { name: "Connect 邮箱说明" });
  await expect(panel).toBeVisible();
  await panel.locator(".context-help-content").hover();
  await expect(panel).toBeVisible();
  await trigger.click();
  await page.mouse.move(0, 0);
  await expect(panel).toBeVisible();
  await page.getByRole("heading", { name: "账号信息", exact: true }).click();
  await expect(panel).toHaveCount(0);
});

test("help does not toggle settings, submit forms, or collapse expanded settings", async ({
  page,
}) => {
  await page.goto("/#create");
  const listed = page.getByRole("checkbox", {
    name: "加入活动广场",
    exact: true,
  });
  await expect(listed).not.toBeChecked();
  await page
    .getByRole("button", { name: "加入活动广场说明", exact: true })
    .click();
  await expect(listed).not.toBeChecked();
  await expect(page.locator(".work-dialog")).toHaveCount(0);
  await page.getByRole("heading", { name: "参与与分享", exact: true }).click();
  await page.locator(".work-more-settings > summary").click();
  await page.getByRole("button", { name: "数量展示说明", exact: true }).click();
  await expect(page.locator(".work-more-settings")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("checkbox", { name: "展示领取名单", exact: true }),
  ).toBeChecked();
  await expect(page.locator("label .context-help-trigger")).toHaveCount(0);
  await expect(page.locator("summary .context-help-trigger")).toHaveCount(0);
  await expect(page.locator(".work-dialog")).toHaveCount(0);
});

test("mobile field help escapes the scroll container and remains within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 430 });
  await page.goto("/#create");
  await page.getByRole("button", { name: "限时开奖", exact: true }).click();
  await page.getByRole("button", { name: "报名上限说明", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "报名上限说明" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("上限与获奖名额独立");
  expect(
    await panel.evaluate((element) =>
      element.parentElement?.classList.contains("site-main"),
    ),
  ).toBe(true);
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(11);
  expect(box.y).toBeGreaterThanOrEqual(11);
  expect(box.x + box.width).toBeLessThanOrEqual(364);
  expect(box.y + box.height).toBeLessThanOrEqual(419);
  const size = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    main: document.querySelector(".site-main")?.scrollWidth,
  }));
  expect(size.document).toBeLessThanOrEqual(size.viewport);
  expect(size.main).toBeLessThanOrEqual(size.viewport);
  await panel.getByRole("button", { name: "关闭说明" }).click();
  await expect(panel).toHaveCount(0);
});

test("merchant errors and credential-change confirmation remain directly visible", async ({
  page,
}) => {
  await page.goto("/#merchant");
  await page.getByLabel("Client ID", { exact: true }).fill("TEST-REVISED");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("同时填写对应");
  await page.getByRole("button", { name: "商户密钥说明", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "商户密钥说明" }),
  ).toContainText("新凭证检查通过");
  await page
    .getByLabel("商户密钥", { exact: true })
    .fill("prototype-only-secret");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认更换商户配置" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    "已发送或结果未知的订单沿用原身份核对",
  );
  await confirmation
    .getByRole("button", { name: "返回修改", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
});
