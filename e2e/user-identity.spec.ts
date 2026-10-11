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
      accountTier: "standard" as const,
      canUseLdc: true,
      loginProvider: "connect" as const,
    },
    csrfToken: "csrf-token-1",
  };
}

async function mockSession(
  page: Page,
  getSession = () => session(),
  publicTier?: "standard" | "lite" | null,
  beforeInfo = "",
) {
  await page.route(/\/api\/(?:session|me)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getSession()),
    }),
  );
  await page.route("**/api/activities/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/passwords"))
      return route.fulfill({
        json: { passwords: [], hiddenCount: 0, canSolve: false },
      });
    if (path.endsWith("/claim"))
      return route.fulfill({ json: { claim: null } });
    const user = getSession().user;
    return route.fulfill({
      json: {
        activity: {
          id: "profile-activity",
          title: "用户卡片交互测试",
          rewardType: "text",
          status: "ended",
          author: {
            id: "profile-author",
            username: user.username,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
            accountTier:
              publicTier === undefined ? user.accountTier : publicTier,
          },
          forceDedicated: false,
          topicUrl: "https://linux.do/t/topic/123/1",
          openedAt: "2026-10-01T00:00:00.000Z",
          deadlineAt: "2026-10-02T00:00:00.000Z",
          quantity: { mode: "exact", total: 1, claimed: 1, remaining: 0 },
          showRecipientList: false,
          showRecipientUsername: true,
          showRecipientTime: true,
          beforeInfo,
        },
      },
    });
  });
}

function publicUserButton(page: Page, name = "Ada") {
  return page
    .getByTestId("envelope")
    .getByRole("button", { name, exact: true });
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

  test("触屏点击打开、内容点击保持，关闭和外部点击均可退出", async ({
    page,
  }) => {
    await mockSession(page);
    await page.goto("/activities/profile-activity");

    const trigger = publicUserButton(page);
    await trigger.tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText("ada-private@example.test");
    await page.waitForTimeout(180);
    await expect(dialog).toBeVisible();

    await dialog.getByText("@ada").tap();
    await page.waitForTimeout(180);
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "关闭资料" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await trigger.tap();
    await expect(dialog).toBeVisible();
    await page
      .getByRole("heading", { name: "用户卡片交互测试", exact: true })
      .tap();
    await expect(dialog).toHaveCount(0);
  });
});

test("Tab 从触发按钮进入弹层链接并能退出到后续操作", async ({ page }) => {
  await mockSession(page, undefined, undefined, "后续公开说明。");
  await page.goto("/activities/profile-activity");
  const topicLink = page.getByRole("link", {
    name: "关联论坛帖子",
    exact: true,
  });
  await expect(topicLink).toHaveAttribute(
    "href",
    "https://linux.do/t/topic/123/1",
  );
  await expect(topicLink).toHaveAttribute("target", "_blank");

  const trigger = publicUserButton(page);
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭资料" })).toBeFocused();
  await page.keyboard.press("Tab");
  const profileLink = page.getByRole("link", { name: "查看 Linux DO 主页" });
  await expect(profileLink).toBeFocused();

  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const focused = document.activeElement;
      return Boolean(
        focused &&
          focused !== document.body &&
          !focused.closest('[role="dialog"]'),
      );
    }),
  ).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Esc 从弹层链接回到触发按钮且不会重开或污染下一次聚焦", async ({
  page,
}) => {
  await mockSession(page);
  await page.goto("/activities/profile-activity");

  const trigger = publicUserButton(page);
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "关闭资料" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "查看 Linux DO 主页" }),
  ).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.waitForTimeout(180);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("link", { name: "我的账号", exact: true }).focus();
  await trigger.focus();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "我的账号", exact: true }).focus();
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
  await page.goto("/activities/profile-activity");

  await publicUserButton(page).hover();
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
  await page.goto("/activities/profile-activity");

  await publicUserButton(page, longName).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  if (!box) throw new Error("User popup bounding box is unavailable");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
});

test("窄屏资料卡避让短视口，列表滚动关闭资料卡", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 260 });
  await mockSession(page, undefined, undefined, "公开说明。\n\n".repeat(40));
  await page.goto("/activities/profile-activity");
  const trigger = publicUserButton(page);
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  if (!box) throw new Error("User popup bounding box is unavailable");
  expect(box.y).toBeGreaterThanOrEqual(12);
  expect(box.y + box.height).toBeLessThanOrEqual(260);
  await page.locator(".site-main").evaluate((element) => {
    element.scrollTop += 120;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(dialog).toHaveCount(0);
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

  await page.goto("/activities/profile-activity");
  const trigger = publicUserButton(page);
  await expect.poll(() => badHits).toBeGreaterThan(0);
  await expect(trigger.locator("img")).toHaveCount(0);

  avatarUrl = "https://avatar.example.test/good.png";
  await refocusAfterSessionStale(page);
  await expect.poll(() => goodHits).toBeGreaterThan(0);
  await expect(trigger.locator("img")).toHaveAttribute("src", avatarUrl);
});

test("无本地资格关联的历史用户名不显示青春版标记", async ({ page }) => {
  await mockSession(page, () => session(), null);
  await page.goto("/activities/profile-activity");
  const trigger = publicUserButton(page);
  await expect(trigger).not.toContainText("青春版");
  await trigger.hover();
  await expect(page.getByRole("dialog")).not.toContainText("青春版");
  await expect(page.getByRole("dialog")).toContainText("@ada");
});
