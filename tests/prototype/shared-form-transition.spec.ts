import { expect, test } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`redemption form moves as one interactive target with ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/#home");
    await page
      .locator("#home-password")
      .fill("https://linux.do/t/topic/2964597/1216");
    await page.getByRole("button", { name: "跳转活动", exact: true }).click();
    const matches = page.getByRole("dialog", { name: "选择活动", exact: true });
    await expect(matches).toBeVisible();
    await matches
      .getByRole("button", { name: "周末红包 · 20 份", exact: true })
      .click();

    const current = page.locator('.route-frame[data-route-presence="present"]');
    await expect(current.locator("#activity-password")).toHaveValue("");
    await expect(page.locator(".pw-input__textarea")).toHaveCount(1);
    await expect(current.locator(".pw-input__label")).toHaveText("兑换口令");
    await expect(current.locator(".pw-input__hint")).toContainText("6–18");
    await expect(
      current.getByRole("button", { name: "领取红包", exact: true }),
    ).toHaveAttribute("data-redemption-action", "true");
    await expect(current.locator(".pw-input__label")).toBeVisible();
    await expect(
      page.locator('.route-frame[data-route-presence="exiting"] textarea'),
    ).toHaveCount(0);
    await expect(current.locator("#activity-password")).not.toBeFocused();
    await current
      .getByRole("button", { name: "返回兑奖", exact: true })
      .click();
    await expect(current.locator("#home-password")).toHaveValue("");
    await expect(page.locator(".pw-input__textarea")).toHaveCount(1);
    await expect(
      current.getByRole("button", { name: "兑奖", exact: true }),
    ).toHaveCount(0);
    await expect(current.locator("#home-password")).not.toBeFocused();
  });
}
