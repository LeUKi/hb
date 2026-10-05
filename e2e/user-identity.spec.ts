import { expect, type Page, test } from "@playwright/test";

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function session(displayName = "Ada", avatarUrl: string | null = null) {
  return {
    user: {
      id: "u_123",
      username: "ada",
      displayName,
      avatarUrl,
      email: "ada-private@example.test",
    },
    csrfToken: "csrf-token-1",
  };
}

async function mockSession(page: Page, getSession = () => session()) {
  await page.route("**/api/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getSession()),
    }),
  );
}

function headerUserButton(page: Page, name = "Ada") {
  return page.locator("header").getByRole("button", { name, exact: true });
}

async function refocusAfterSessionStale(page: Page) {
  await page.clock.fastForward(31_000);
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.bringToFront();
  await other.close();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("触屏用户卡片", () => {
  test.use({ hasTouch: true });

  test("首 tap 打开、等待后第二次 tap 关闭，外部点击也关闭", async ({
    page,
  }) => {
    await mockSession(page);
    await page.goto("/account");

    const trigger = headerUserButton(page);
    await trigger.tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(180);
    await expect(dialog).toBeVisible();

    await dialog.getByText("@ada").tap();
    await page.waitForTimeout(180);
    await expect(dialog).toBeVisible();

    await trigger.tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await trigger.tap();
    await expect(dialog).toBeVisible();
    await page.getByRole("main").click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
  });
});

test("Tab 从触发按钮进入弹层链接并能退出到后续操作", async ({ page }) => {
  await mockSession(page);
  await page.goto("/account");

  const trigger = headerUserButton(page);
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Tab");
  const profileLink = page.getByRole("link", { name: "查看 Linux DO 主页" });
  await expect(profileLink).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "账号信息" })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "退出" })).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Esc 从弹层链接回到触发按钮且不会重开或污染下一次聚焦", async ({
  page,
}) => {
  await mockSession(page);
  await page.goto("/account");

  const trigger = headerUserButton(page);
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "查看 Linux DO 主页" }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.waitForTimeout(180);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "退出" }).focus();
  await trigger.focus();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "退出" }).focus();
  await trigger.focus();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("hover 移入弹层后可以点击 Linux DO 主页链接", async ({ page }) => {
  await mockSession(page);
  const context = page.context();
  await context.route("https://linux.do/u/ada", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Ada profile fixture</title>",
    }),
  );
  await page.goto("/account");

  await headerUserButton(page).hover();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const profileLink = page.getByRole("link", { name: "查看 Linux DO 主页" });
  await expect(profileLink).toHaveAttribute("href", "https://linux.do/u/ada");
  await profileLink.hover();

  const popupPromise = page.waitForEvent("popup");
  await profileLink.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://linux.do/u/ada");
  await popup.close();
});

test("长昵称窄屏时弹层避让屏幕边缘", async ({ page }) => {
  const longName = "Ada".repeat(80);
  await page.setViewportSize({ width: 320, height: 720 });
  await mockSession(page, () => session(longName));
  await page.goto("/account");

  await headerUserButton(page, longName).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  if (!box) throw new Error("User popup bounding box is unavailable");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
});

test("触发按钮滚离视口时弹层仍夹在视口内", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 260 });
  await mockSession(page);
  await page.goto("/account");
  await page.evaluate(() => window.scrollTo(0, 220));

  await headerUserButton(page).focus();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  if (!box) throw new Error("User popup bounding box is unavailable");
  expect(box.y).toBeGreaterThanOrEqual(12);
  expect(box.y + box.height).toBeLessThanOrEqual(260);
});

test("头像加载失败后更新为新 URL 会重新加载图片", async ({ page }) => {
  await page.clock.install();
  let avatarUrl = "https://avatar.example.test/bad.png";
  let badHits = 0;
  let goodHits = 0;

  await page.route("https://avatar.example.test/bad.png", (route) => {
    badHits += 1;
    return route.fulfill({ status: 404, body: "missing" });
  });
  await page.route("https://avatar.example.test/good.png", (route) => {
    goodHits += 1;
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: png1x1,
    });
  });
  await mockSession(page, () => session("Ada", avatarUrl));

  await page.goto("/account");
  const trigger = headerUserButton(page);
  await expect.poll(() => badHits).toBeGreaterThan(0);
  await expect(trigger.locator("img")).toHaveCount(0);

  avatarUrl = "https://avatar.example.test/good.png";
  await refocusAfterSessionStale(page);
  await expect.poll(() => goodHits).toBeGreaterThan(0);
  await expect(trigger.locator("img")).toHaveAttribute("src", avatarUrl);
});
