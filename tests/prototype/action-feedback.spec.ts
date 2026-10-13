import { expect, test } from "@playwright/test";

for (const width of [1440, 375]) {
  test(`home immediate result stays on submit button without reflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#home");
    await page
      .getByRole("textbox", { name: "口令", exact: true })
      .fill("这不是正确口令");
    const button = page.locator('[data-redemption-action="true"]');
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    await button.click();
    await expect(button).toHaveText(/未匹配|口令不正确/);
    await expect(page.locator(".home-exchange > .form-message")).toHaveCount(0);
    expect(await button.boundingBox()).toEqual(box);
    await expect(button).toHaveText("兑奖", { timeout: 5000 });
  });
}

for (const width of [1440, 375]) {
  test(`repeated refresh restarts only its own three-second feedback at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#account");
    const refresh = page.getByRole("button", { name: /^刷新资料/ });
    await expect(refresh).toBeVisible();
    await page.clock.pauseAt(Date.now() + 1000);
    const box = await refresh.boundingBox();
    await refresh.click();
    await expect(refresh).toHaveText("已刷新");
    await page.clock.runFor(2000);
    await refresh.click();
    await page.clock.runFor(2999);
    await expect(refresh).toHaveText("已刷新");
    expect(await refresh.boundingBox()).toEqual(box);
    await expect(
      page.locator(".work-account-card .work-inline-success"),
    ).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(refresh).toHaveText("刷新资料");
    expect(await refresh.boundingBox()).toEqual(box);
  });
}
