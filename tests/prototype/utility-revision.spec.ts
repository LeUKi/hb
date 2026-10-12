import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const presentRoute = '.route-frame[data-route-presence="present"]';
const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/.test(url.pathname)) {
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

async function setScenario(page: Page, value: string) {
  const control = page.getByRole("button", { name: "场景与身份" });
  if ((await control.getAttribute("aria-expanded")) !== "true")
    await control.click();
  await page
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption(value);
  await control.click();
}

async function openRoster(page: Page) {
  await page
    .locator(presentRoute)
    .getByRole("button", { name: /^查看(领取|报名|中奖)名单$/u })
    .click();
  const dialog = page.locator(".public-roster-dialog[open]");
  await expect(dialog).toBeVisible();
  return dialog;
}

const slogans =
  /心意|好运|惊喜|相遇|朋友|开心|快乐|轻轻|好事|礼物|GOOD THINGS|WITH A LITTLE LUCK/;
test("all routes and activity states use functional copy with no decorative icons", async ({
  page,
}) => {
  for (const route of [
    "home",
    "square",
    "activity",
    "participations",
    "manage",
    "create",
    "account",
    "merchant",
    "payment",
  ]) {
    await page.goto(`/#${route}`);
    if (route === "square")
      await expect(
        page.getByRole("dialog", { name: "活动广场", exact: true }),
      ).toBeVisible();
    else if (route === "home")
      await expect(
        page.locator(`${presentRoute} #home-password`),
      ).toBeVisible();
    else await expect(page.locator(`${presentRoute} h1`)).toBeVisible();
    await expect(page.locator("main")).not.toContainText(slogans);
    await expect(
      page.locator(
        "main .lucide-heart, main .lucide-flower-2, main .lucide-sparkles",
      ),
    ).toHaveCount(0);
  }
  await page.goto("/#activity");
  for (const state of [
    "ready",
    "random",
    "pending",
    "registered",
    "drawing",
    "won",
    "not-won",
    "ended",
    "long",
    "multiple",
  ]) {
    await setScenario(page, state);
    await expect(page.locator("main")).not.toContainText(slogans);
  }
});

for (const width of [1920, 1440, 768, 375]) {
  test(`centered bounds and compact roster at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#square");
    const route = await page.locator(".public-square-dialog").boundingBox();
    expect(route).not.toBeNull();
    if (!route) throw new Error("Missing page bounds");
    expect(route.width).toBeLessThanOrEqual(1120);
    if (width > 1200)
      expect(Math.abs(route.x - (width - route.width) / 2)).toBeLessThan(12);
    await page.goto("/#activity");
    await setScenario(page, "won");
    await expect(page.getByTestId("envelope")).toHaveAttribute(
      "data-phase",
      "open",
    );
    if (width === 1440 || width === 375) {
      await page.locator("main h1").click();
      await page.mouse.move(0, 0);
    }
    const dialog = await openRoster(page);
    await expect(dialog.locator(".recipient-title.title-highest")).toHaveText(
      "手气王",
    );
    await expect(dialog.locator(".recipient-title.title-lowest")).toHaveText(
      "手气亡",
    );
    const bounds = await page.locator(".activity-page").boundingBox();
    const list = await dialog.boundingBox();
    if (!bounds || !list) throw new Error("Missing activity bounds");
    expect(bounds.width).toBeLessThanOrEqual(960);
    expect(list.width).toBeLessThanOrEqual(Math.min(440, width - 24));
    const overflow = await page.evaluate(() => {
      const main = document.querySelector(".site-main");
      if (!main) throw new Error("Missing main region");
      return {
        document: document.documentElement.scrollWidth,
        viewport: innerWidth,
        main: main.scrollWidth,
        width: main.clientWidth,
      };
    });
    expect(overflow.document).toBeLessThanOrEqual(width);
    expect(overflow.main).toBeLessThanOrEqual(overflow.width + 1);
    if (width === 1440 || width === 375) {
      await page.mouse.move(0, 0);
    }
  });
}

test("title visibility follows publication and roster privacy rather than payment state", async ({
  page,
}) => {
  await page.goto("/#activity");
  await setScenario(page, "ready");
  let dialog = await openRoster(page);
  await expect(dialog.locator(".recipient-title")).toHaveCount(0);
  await dialog.press("Escape");
  await setScenario(page, "registered");
  dialog = await openRoster(page);
  await expect(dialog.locator(".recipient")).toHaveCount(20);
  await expect(
    dialog.locator(".recipient-award, .recipient-title"),
  ).toHaveCount(0);
  await dialog.getByRole("tab", { name: "中奖名单", exact: true }).click();
  await expect(dialog.locator(".recipient")).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveText("等待开奖");
  await dialog.press("Escape");
  await setScenario(page, "won");
  dialog = await openRoster(page);
  await expect(dialog.locator(".recipient-title")).toHaveCount(2);
  await dialog.press("Escape");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.getByLabel("展示领取名单", { exact: true }).uncheck();
  await expect(page.locator(".recipient-title")).toHaveCount(0);
  await expect(page.locator(".public-roster-dialog")).toHaveCount(0);
  await expect(
    page
      .locator(presentRoute)
      .getByRole("button", { name: /^查看(领取|报名|中奖)名单$/u }),
  ).toHaveCount(0);
  await page.getByLabel("展示领取名单", { exact: true }).check();
  await page.getByLabel("模糊数量", { exact: true }).check();
  await page.getByRole("button", { name: "场景与身份" }).click();
  dialog = await openRoster(page);
  await expect(dialog.locator(".recipient-title")).toHaveCount(2);
  await expect(dialog.locator(".section-heading > span")).toHaveCount(0);
  await dialog.press("Escape");
  await page.goto("/#activity?sample=reading-ldc");
  dialog = await openRoster(page);
  await expect(dialog.locator(".recipient-title")).toHaveCount(0);
  await expect(dialog.locator(".recipient-award")).toHaveCount(4);
});
