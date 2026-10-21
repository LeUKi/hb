import { expect, type Page, test } from "@playwright/test";
import { mockSession, omniboxInput, openApp } from "./support/app";

// 网站更新提示 (docs/redesign/02-shell.md §8): another build on the site, a
// dialog to reload; again at every check after 稍后; never while typing.

async function serveBuild(page: Page, offset: number) {
  await page.route("**/version.json", async (route) => {
    const build = await page.evaluate(() =>
      Number(document.getElementById("build-stamp")?.dataset.buildUnixSeconds),
    );
    return route.fulfill({ json: { build: build + offset } });
  });
}

/** Coming back to the window: what makes the page look again. */
const comeBack = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));

test.describe("网站更新提示", () => {
  test("同一个构建不弹；换了构建就弹，稍后关掉，下次检测到还弹", async ({
    page,
  }) => {
    await mockSession(page, null);
    let offset = 0;
    await page.route("**/version.json", async (route) => {
      const build = await page.evaluate(() =>
        Number(
          document.getElementById("build-stamp")?.dataset.buildUnixSeconds,
        ),
      );
      return route.fulfill({ json: { build: build + offset } });
    });
    await openApp(page);
    await comeBack(page);
    await page.waitForTimeout(500);
    const dialog = page.getByRole("dialog", { name: "网站更新了" });
    await expect(dialog).toHaveCount(0);

    offset = 1;
    await comeBack(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("刷新一下就能用上新版本。")).toBeVisible();
    await dialog.getByRole("button", { name: "稍后" }).click();
    await expect(dialog).toHaveCount(0);
    await comeBack(page);
    await expect(dialog).toBeVisible();
  });

  test("正在输入时先不弹，输完再弹；刷新会重新加载", async ({ page }) => {
    await mockSession(page, null);
    await serveBuild(page, 1);
    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill("还在输入的口令");
    await comeBack(page);
    await page.waitForTimeout(800);
    const dialog = page.getByRole("dialog", { name: "网站更新了" });
    await expect(dialog).toHaveCount(0);
    await omniboxInput(page).fill("");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible({ timeout: 6000 });
    const reloaded = page.waitForEvent("framenavigated");
    await dialog.getByRole("button", { name: "刷新" }).click();
    await reloaded;
  });
});
