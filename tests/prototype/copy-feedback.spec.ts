import { expect, type Page, test } from "@playwright/test";
import { decodeActivityEmoji } from "../../packages/contracts/src";

async function contentBounds(page: Page) {
  return page
    .locator(".activity-heading, .password-section, .activity-page")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
}

for (const width of [1440, 375]) {
  test(`share copy feedback stays on the initiating menu item without reflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            document.documentElement.dataset.copied = text;
            document.documentElement.dataset.copyCount = String(
              Number(document.documentElement.dataset.copyCount ?? 0) + 1,
            );
          },
        },
      });
    });
    await page.goto("/#activity?sample=history-random-active");
    await expect(page.locator(".password-section")).toBeVisible();
    await expect(page.getByText("正在显示说明…", { exact: true })).toHaveCount(
      0,
    );
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1000);
    const before = await contentBounds(page);
    expect(before).toHaveLength(3);
    await page.getByRole("button", { name: "分享活动", exact: true }).click();
    const menu = page.getByRole("menu", { name: "分享活动", exact: true });
    const copyLink = menu.getByRole("menuitem").nth(0);
    await expect(copyLink).toHaveAccessibleName("复制链接");
    await copyLink.click();
    await expect(menu).toBeVisible();
    await expect(copyLink).toHaveText("已复制");
    await expect(copyLink).toHaveAccessibleName("复制链接，已复制");
    await expect(page.locator(".copy-toast")).toHaveCount(0);
    expect(await contentBounds(page)).toEqual(before);
    const href = await page.locator("html").getAttribute("data-copied");
    if (!href) throw new Error("Missing copied activity link");
    expect(href).toContain("http://127.0.0.1:4177/e/");
    expect(href).not.toContain("%");
    const emoji = href.slice("http://127.0.0.1:4177/e/".length);
    expect(Array.from(emoji)).toHaveLength(14);
    expect(decodeActivityEmoji(emoji)).not.toBeNull();

    await page.clock.fastForward(2000);
    await expect(copyLink).toHaveText("已复制");
    await copyLink.click();
    await expect(page.locator("html")).toHaveAttribute("data-copy-count", "2");
    await expect(page.locator("html")).toHaveAttribute("data-copied", href);
    await page.clock.fastForward(2000);
    await expect(copyLink).toHaveText("已复制");
    const copyText = menu.getByRole("menuitem").nth(1);
    await copyText.click();
    await expect(copyText).toHaveText("已复制");
    await expect(copyText).toHaveAccessibleName("复制分享文案，已复制");
    await expect(page.locator("html")).toHaveAttribute("data-copy-count", "3");
    const text = await page.locator("html").getAttribute("data-copied");
    expect(text).toContain("周六即时随机红包");
    expect(text).toContain(href);
    expect(text).not.toContain("历史口令02");
    expect(text).not.toContain("活动口令02");
    await expect(copyLink).toHaveText("已复制");
    await page.clock.fastForward(500);
    await expect(copyLink).toHaveText("已复制");
    await page.clock.fastForward(500);
    await expect(copyLink).toHaveText("复制链接");
    await expect(copyLink).toHaveAccessibleName("复制链接");
    await expect(copyText).toHaveText("已复制");
    await page.clock.fastForward(1999);
    await expect(copyText).toHaveText("已复制");
    await page.clock.fastForward(1);
    await expect(copyText).toHaveText("复制分享文案");
    await expect(copyText).toHaveAccessibleName("复制分享文案");
    await expect(menu).toBeVisible();
    expect(await contentBounds(page)).toEqual(before);
    await expect(page.locator(".copy-toast")).toHaveCount(0);

    await menu.getByRole("menuitem", { name: "内嵌代码", exact: true }).click();
    await expect(menu).not.toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "内嵌代码", exact: true }),
    ).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "内嵌代码", exact: true });
    const embedCopy = dialog
      .locator(".activity-image-copy-actions button")
      .first();
    await expect(embedCopy).toHaveAccessibleName("复制内嵌代码");
    await embedCopy.click();
    await expect(embedCopy).toHaveText("已复制");
    await expect(embedCopy).toHaveAccessibleName("复制内嵌代码，已复制");
    await page.clock.fastForward(2500);
    await expect(embedCopy).toHaveText("已复制");
    await page.clock.fastForward(500);
    await expect(embedCopy).toHaveText("复制内嵌代码");
  });
}

test("account email copy feedback stays inside the trigger button", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await page.goto("/#account");
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  const row = page.locator(".work-account-rows > div", {
    hasText: "Connect 邮箱",
  });
  const before = await row.boundingBox();
  expect(before).not.toBeNull();
  const copyEmail = row.getByRole("button", { name: "复制 Connect 邮箱" });
  await copyEmail.click();
  await expect(copyEmail).toHaveText("已复制");
  await expect(copyEmail).toHaveAccessibleName("复制 Connect 邮箱，已复制");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied",
    "linjian@privacy.example.invalid",
  );
  await expect(page.getByText("Connect 邮箱已复制。")).toHaveCount(0);
  expect(await row.boundingBox()).toEqual(before);
  await page.clock.fastForward(3000);
  await expect(copyEmail).toHaveText("复制");
  await expect(copyEmail).toHaveAccessibleName("复制 Connect 邮箱");
  expect(await row.boundingBox()).toEqual(before);
});

test("failed share copies stay on the original menu item and can be retried", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (document.documentElement.dataset.allowCopy !== "true")
            throw new Error("Clipboard unavailable");
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await page.goto("/#activity?sample=history-random-active");
  await expect(page.locator(".password-section")).toBeVisible();
  await expect(page.getByText("正在显示说明…", { exact: true })).toHaveCount(0);
  const before = await contentBounds(page);
  await page.getByRole("button", { name: "分享活动", exact: true }).click();
  const menu = page.getByRole("menu", { name: "分享活动", exact: true });
  const copyText = menu.getByRole("menuitem").nth(1);
  await expect(copyText).toHaveAccessibleName("复制分享文案");
  await copyText.click();
  await expect(menu).toBeVisible();
  await expect(copyText).toHaveText("复制失败");
  await expect(copyText).toHaveAccessibleName("复制分享文案，复制失败");
  await expect(page.locator("html")).not.toHaveAttribute("data-copied");
  await expect(page.locator(".copy-toast")).toHaveCount(0);
  expect(await contentBounds(page)).toEqual(before);
  await page.evaluate(() => {
    document.documentElement.dataset.allowCopy = "true";
  });
  await copyText.click();
  await expect(copyText).toHaveText("已复制");
  await expect(copyText).toHaveAccessibleName("复制分享文案，已复制");
  await expect(menu).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied",
    /周六即时随机红包[\s\S]+http:\/\/127\.0\.0\.1:4177\/e\//u,
  );
  await expect(page.locator(".copy-toast")).toHaveCount(0);
  expect(await contentBounds(page)).toEqual(before);
});
