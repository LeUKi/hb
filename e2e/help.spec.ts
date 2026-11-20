import { expect, test } from "@playwright/test";
import { mockSession, openApp, viewer } from "./support/app";

// 帮助中心 (docs/help-center-design.md).

const entries = [
  ["领红包", "/help/claim"],
  ["发红包", "/help/send"],
  ["收打赏", "/help/tips"],
  ["🐟额和 PLUS", "/help/fish"],
  ["做玩法", "/help/start"],
  ["发行三方积分", "/help/points"],
] as const;

test.describe("帮助中心", () => {
  test("首页：先选要做的事；大家常问的八条都落在一个真有的问题上", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await openApp(page, "/help");
    for (const [name, href] of entries)
      await expect(
        // The card says what it is and one line more.
        page.getByRole("link", { name: new RegExp(`^${name} `) }),
      ).toHaveAttribute("href", href);
    const asked = page
      .locator("section", {
        has: page.getByRole("heading", { name: "大家常问" }),
      })
      .getByRole("link");
    await expect(asked).toHaveCount(8);
    const targets = await asked.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href") ?? ""),
    );
    for (const [index, href] of targets.entries()) {
      const [path, id] = href.split("#");
      await asked.nth(index).click();
      await expect(page).toHaveURL(new RegExp(`${path}#${id}$`));
      await expect(page.locator(`#${id}`)).toBeInViewport();
      await page.goBack();
      await expect(asked).toHaveCount(8);
    }
  });

  test("问题页：从常问进来滚到那一条并亮一下；右边的目录标着它，点章名滚过去", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await openApp(page, "/help");
    await page
      .getByRole("link", { name: "口令没错，为什么匹配不到红包？" })
      .click();
    await expect(page).toHaveURL(/\/help\/claim#q-no-match$/);
    const question = page.locator("#q-no-match");
    await expect(question).toBeInViewport();
    await expect(question).toHaveAttribute("data-flash", "");
    const rail = page.getByRole("complementary", { name: "本页目录" });
    await expect(
      rail.getByRole("button", { name: "口令没错，为什么匹配不到红包？" }),
    ).toHaveAttribute("aria-current", "location");

    await rail.getByRole("button", { name: "领到以后" }).click();
    await expect(page).toHaveURL(/\/help\/claim#after$/);
    await expect(page.locator("#after")).toBeInViewport();
    // Every question always listed: nothing opens or closes as one moves.
    await expect(
      rail.getByRole("button", { name: "领到的什么时候到账？" }),
    ).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "口令没错，为什么匹配不到红包？" }),
    ).not.toHaveAttribute("aria-current");
    // The last one, which the page cannot bring to the top: still the one
    // marked once the scroll is over.
    const last = rail.getByRole("button", { name: "能用脚本领吗？" });
    await last.click();
    await expect(page).toHaveURL(/#q-token$/);
    await page.waitForTimeout(1200);
    await expect(last).toHaveAttribute("aria-current", "location");
    await expect(
      page
        .locator("#q-when-paid")
        .getByRole("button", { name: "复制这个问题的链接" }),
    ).toBeVisible();
  });

  test("手机：没有右栏，“目录”的弹层列出全部章和问题，选一项后收起并滚过去", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSession(page, viewer);
    await openApp(page, "/help/claim");
    await expect(
      page.getByRole("complementary", { name: "本页目录" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "目录" }).click();
    const sheet = page.getByRole("dialog", { name: "目录" });
    await sheet.getByRole("button", { name: "领不到", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/\/help\/claim#cannot$/);
    await expect(page.locator("#cannot")).toBeInViewport();
    // A question of another section is right there, not behind a tap.
    await page.getByRole("button", { name: "目录" }).click();
    await sheet
      .getByRole("button", { name: "提示没有 Credit 账户怎么办？" })
      .click();
    await expect(sheet).toBeHidden();
    await expect(page).toHaveURL(/#q-no-credit$/);
    await expect(page.locator("#q-no-credit")).toBeInViewport();
  });

  test("开发文档也有目录：判定器开发文档跳到联网，例子里的代码有高亮", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await openApp(page, "/help/code");
    const rail = page.getByRole("complementary", { name: "本页目录" });
    await rail.getByRole("button", { name: "联网" }).click();
    await expect(page).toHaveURL(/\/help\/code#network$/);
    await expect(page.locator("#network")).toBeInViewport();
    // Its examples coloured as the 判定器 editor colours them; prose not.
    const example = page
      .locator("section", { has: page.locator("#network") })
      .locator("pre")
      .first();
    await expect(
      example.locator(".tok-keyword", { hasText: "export" }).first(),
    ).toBeVisible();
    await expect(
      page
        .locator("section", { has: page.locator("#ai") })
        .locator("pre [class^=tok-]"),
    ).toHaveCount(0);
  });

  test("每个入口页：标题对，问题编号是固定的短词且不重复", async ({ page }) => {
    await mockSession(page, viewer);
    for (const [name, path] of entries) {
      await openApp(page, path);
      const ids = await page
        .locator("[data-question]")
        .evaluateAll((blocks) => blocks.map((block) => block.id));
      expect(ids.length, path).toBeGreaterThan(3);
      expect(new Set(ids).size, path).toBe(ids.length);
      for (const id of ids) expect(id, path).toMatch(/^q-[a-z0-9-]+$/);
      if (path !== "/help/start" && path !== "/help/points")
        await expect(
          page.getByRole("heading", { level: 1, name }),
        ).toBeVisible();
    }
  });
});
