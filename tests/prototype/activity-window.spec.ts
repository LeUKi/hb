import { test as base, expect } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ context }, use) => {
      const forbidden: string[] = [];
      await context.route("**/*", async (route) => {
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

test("a newly claimed reward survives keyboard and middle-click detail windows without changing the source list", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=weekend");
  await page.locator("#activity-password").fill("周末口令2026");
  await page.getByRole("button", { name: "领取红包", exact: true }).click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "claimed",
  );
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "活动历史", exact: true })
    .click();
  const row = page.locator('[data-activity-id="weekend"]');
  const action = row.getByRole("link", { name: "查看活动", exact: true });
  const recordFields = row.locator(
    ".activity-rows-source, .activity-reward, .activity-table-date",
  );
  await expect(recordFields).toHaveCount(3);
  const sourceText = await recordFields.allTextContents();
  for (const method of ["keyboard", "middle"] as const) {
    await action.focus();
    const scrollBefore = await page
      .locator(".list-panel__scroll")
      .evaluate((node) => node.scrollTop);
    const popupPromise = context.waitForEvent("page");
    if (method === "keyboard") await action.press("Enter");
    else await action.click({ button: "middle" });
    const popup = await popupPromise;
    await expect(popup.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "claimed",
    );
    await expect(popup.locator(".activity-status-copy")).toHaveText(
      "兑换成功。",
    );
    await expect(popup).toHaveURL(`${origin}/#activity?sample=weekend`);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(
      await popup.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
    await expect(popup.locator("#activity-password")).toHaveCount(0);
    await popup.close();
    await expect(page).toHaveURL(`${origin}/#participations`);
    await expect(recordFields).toHaveText(sourceText);
    await expect(action).toBeFocused();
    expect(
      await page
        .locator(".list-panel__scroll")
        .evaluate((node) => node.scrollTop),
    ).toBe(scrollBefore);
  }
});

test("note validation survives mode changes and composition, and submit reveals the invalid source", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#create");
  await page.locator("#work-title").fill("说明校验");
  await page.locator("#work-fixed-amount").fill("1");
  await page.locator("#work-fixed-count").fill("2");
  await page.locator("#work-password-1").fill("说明校验2026");
  await page.locator(".work-more-settings > summary").click();
  const input = page.locator("#work-after-note");
  const modes = page.getByRole("group", { name: "说明预览模式" });
  const long = "字".repeat(10001);
  await input.dispatchEvent("compositionstart", { data: "字" });
  await input.fill(long);
  await input.blur();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await input.dispatchEvent("compositionend", { data: "字" });
  await input.focus();
  await input.blur();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await modes.getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(input).toBeHidden();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  const errorId = await input.getAttribute("aria-describedby");
  expect(errorId).toContain("work-after-note-error");
  await input.fill("**修正后的附言**");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await modes.getByRole("button", { name: "分栏", exact: true }).click();
  await expect(page.locator('[data-note-stage="after"] strong')).toHaveText(
    "修正后的附言",
  );
  await expect(input).toHaveValue("**修正后的附言**");
});
