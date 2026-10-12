import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";

const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      const isForbidden = (address: string) => {
        const url = new URL(address);
        return url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname);
      };
      page.on("request", (request) => {
        if (isForbidden(request.url())) forbidden.add(request.url());
      });
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).host !== new URL(origin).host)
          forbidden.add(socket.url());
      });
      await page.route("**/*", async (route) => {
        if (isForbidden(route.request().url())) {
          forbidden.add(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(
        [...forbidden],
        "User cards must not request any API or external service",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

function profile(page: Page) {
  return page.getByRole("dialog", { name: "用户资料", exact: true });
}

function authors(page: Page) {
  return page.locator(".activity-rows-author .user-identity");
}

test("desktop profiles switch immediately beside the user column and bridge the hover gap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#square");
  const first = authors(page).nth(0);
  const second = authors(page).nth(1);
  const firstName = await first.locator(":scope > span").last().textContent();
  const secondName = await second.locator(":scope > span").last().textContent();
  await first.hover();
  await expect(profile(page)).toHaveCount(1);
  await expect(profile(page)).toHaveAttribute("data-side", "right");
  await expect(profile(page).locator("strong")).toHaveText(firstName ?? "");
  const firstBox = await first.boundingBox();
  const popupBox = await profile(page).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(popupBox).not.toBeNull();
  if (!firstBox || !popupBox) return;
  expect(popupBox.x).toBeGreaterThanOrEqual(firstBox.x + firstBox.width + 7);
  expect(
    Math.abs(
      popupBox.y + popupBox.height / 2 - (firstBox.y + firstBox.height / 2),
    ),
  ).toBeLessThanOrEqual(2);

  await page.mouse.move(
    firstBox.x + firstBox.width + 4,
    firstBox.y + firstBox.height / 2,
  );
  // Crossing the 8px bridge must keep the link reachable after the leave delay.
  await page.waitForTimeout(200);
  await expect(profile(page)).toBeVisible();
  await profile(page).getByRole("link", { name: "查看 Linux DO 主页" }).hover();
  await expect(profile(page)).toBeVisible();

  await second.hover();
  await expect(profile(page)).toHaveCount(1);
  await expect(profile(page).locator("strong")).toHaveText(secondName ?? "");
  const secondBox = await second.boundingBox();
  const nextPopupBox = await profile(page).boundingBox();
  expect(secondBox).not.toBeNull();
  expect(nextPopupBox).not.toBeNull();
  if (!secondBox || !nextPopupBox) return;
  expect(nextPopupBox.x).toBeGreaterThanOrEqual(
    secondBox.x + secondBox.width + 7,
  );
  await page.mouse.move(10, 10);
  await expect(profile(page)).toHaveCount(0);
});

test("profiles use the left edge fallback and clamp measured height inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#square");
  const author = authors(page).first();
  await author.evaluate((element) => {
    Object.assign(element.style, {
      position: "fixed",
      top: "12px",
      right: "12px",
      width: "150px",
      zIndex: "10",
    });
  });
  await author.hover();
  await expect(profile(page)).toHaveAttribute("data-side", "left");
  const anchor = await author.boundingBox();
  const card = await profile(page).boundingBox();
  expect(anchor).not.toBeNull();
  expect(card).not.toBeNull();
  if (!anchor || !card) return;
  expect(card.x + card.width).toBeLessThanOrEqual(anchor.x - 7);
  expect(card.x).toBeGreaterThanOrEqual(12);
  expect(card.y).toBeGreaterThanOrEqual(12);
  expect(card.y + card.height).toBeLessThanOrEqual(888);
});

test("list scrolling keeps a profile in the scroll chain while resize closes it", async ({
  page,
}) => {
  await page.goto("/#square");
  await authors(page).first().click();
  await expect(profile(page)).toBeVisible();
  await profile(page)
    .locator(".identity-detail__body")
    .dispatchEvent("scroll", { bubbles: false });
  await expect(profile(page)).toBeVisible();
  const scrollPanel = page.locator(".list-panel__scroll");
  await scrollPanel.hover();
  await page.mouse.wheel(0, 320);
  await expect
    .poll(() => scrollPanel.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(profile(page)).toBeVisible();
  expect(
    await profile(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }),
  ).toBe(true);
  await authors(page).nth(3).click();
  await expect(profile(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(profile(page)).toHaveCount(0);
});

test("keyboard profiles survive the queued event from a scroll completed before opening", async ({
  page,
}) => {
  await page.goto("/#square");
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".list-panel__scroll");
    const author = document.querySelectorAll<HTMLButtonElement>(
      ".activity-rows-author .user-identity",
    )[3];
    if (!main || !author) throw new Error("Missing scrollable author list");
    main.scrollTop = 100;
    author.focus({ preventScroll: true });
  });
  await expect(profile(page)).toBeVisible();
  await page.locator(".list-panel__scroll").evaluate((element) => {
    // A browser may deliver the previous scroll notification after focus opened.
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(profile(page)).toBeVisible();
  await page.locator(".list-panel__scroll").evaluate((element) => {
    element.scrollTop += 80;
  });
  await expect(profile(page)).toHaveCount(0);
});

test("keyboard users can enter the portal, visit its link, and close without reopening", async ({
  page,
}) => {
  await page.goto("/#square");
  const author = authors(page).first();
  await author.focus();
  await expect(profile(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    profile(page).getByRole("button", { name: "关闭资料" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const link = profile(page).getByRole("link", { name: "查看 Linux DO 主页" });
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute("href", /^https:\/\/linux\.do\/u\//u);
  await page.keyboard.press("Escape");
  await expect(profile(page)).toHaveCount(0);
  await expect(author).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    profile(page).getByRole("link", { name: "查看 Linux DO 主页" }),
  ).toBeFocused();
  await profile(page).getByRole("button", { name: "关闭资料" }).click();
  await expect(profile(page)).toHaveCount(0);
  await expect(author).toBeFocused();
});

test.describe("narrow touch layouts", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("tap opens an accessible bottom sheet with focus cycling and outside close", async ({
    page,
  }) => {
    await page.goto("/#square");
    const author = authors(page).first();
    await author.tap();
    const card = profile(page);
    await expect(card).toHaveAttribute("data-side", "sheet");
    await expect(card).toHaveAttribute("aria-modal", "true");
    await expect(card.getByRole("button", { name: "关闭资料" })).toBeFocused();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(363);
      expect(box.y + box.height).toBeLessThanOrEqual(800);
      expect(box.y).toBeGreaterThan(400);
    }
    await page.keyboard.press("Tab");
    await expect(
      card.getByRole("link", { name: "查看 Linux DO 主页" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "关闭资料" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      card.getByRole("link", { name: "查看 Linux DO 主页" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(author).toBeFocused();
    await author.tap();
    await expect(card).toBeVisible();
    await page.touchscreen.tap(10, 20);
    await expect(card).toHaveCount(0);
  });

  test("hover does not open a bottom sheet or replace the direct own-account link", async ({
    page,
  }) => {
    await page.goto("/#square");
    await authors(page).first().hover();
    await expect(profile(page)).toHaveCount(0);
    await page.getByRole("button", { name: "关闭活动广场" }).click();
    await expect(page.locator(".public-square-dialog")).toHaveCount(0);
    const account = page
      .locator(".site-header")
      .getByRole("link", { name: "我的账号", exact: true });
    await account.tap();
    await expect(page).toHaveURL(/#account$/u);
    await expect(profile(page)).toHaveCount(0);
  });
});
