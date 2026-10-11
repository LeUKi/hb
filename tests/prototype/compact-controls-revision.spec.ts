import { expect, test } from "@playwright/test";

for (const width of [1440, 375]) {
  test(`secondary control outer heights and unified home entry at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/#square");
    const expected = width === 375 ? 36 : 32;
    const controls = [
      page.locator(".gallery-toolbar .segmented-control__scroll"),
      page.locator(".gallery-status-filter .action-menu-trigger"),
      page.locator(".create-link"),
      page.getByRole("button", { name: "下一页", exact: true }),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.height).toBeCloseTo(expected, 0);
    }
    await page.locator(".create-link").click();
    await expect(page).toHaveURL(/#create$/u);
    await expect(
      page.locator(".desktop-nav [aria-current], .mobile-nav [aria-current]"),
    ).toHaveCount(0);
    await page.goto("/#create?edit=20000000-0000-4000-8000-000000000002");
    await expect(page.locator(".desktop-nav [aria-current]")).toHaveText(
      "活动历史",
    );
    await expect(page.locator(".mobile-nav [aria-current]")).toHaveText(
      "活动历史",
    );
    await page.goto("/#home");
    await expect(page.locator(".activity-locator")).toHaveCount(0);
    await expect(page.locator("main h1")).toHaveCount(0);
    await expect(page.locator("#home-password")).toHaveAttribute(
      "placeholder",
      "",
    );
    const field = page.locator(".home-exchange .pw-input__field");
    const input = page.getByRole("textbox", { name: "口令", exact: true });
    const help = page.getByRole("button", {
      name: "口令输入说明",
      exact: true,
    });
    await expect(input).toHaveCount(1);
    await expect(help).toBeVisible();
    const fieldBox = await field.boundingBox();
    const helpBox = await help.boundingBox();
    if (!fieldBox || !helpBox) throw new Error("Home field geometry missing");
    expect(helpBox.y + helpBox.height / 2).toBeGreaterThanOrEqual(fieldBox.y);
    expect(helpBox.y + helpBox.height / 2).toBeLessThanOrEqual(
      fieldBox.y + fieldBox.height,
    );
    expect(
      await page
        .locator(".home-exchange")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await expect(page.getByRole("button", { name: "兑奖" })).toHaveCount(0);
    await expect(page.locator(".pw-input__count")).toHaveCount(0);
    await expect(page.locator(".pw-input__hint")).toHaveCount(0);
  });
}

test("unified home entry accepts strict forum links and restores focus to the primary action", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin !== "http://127.0.0.1:4177" ||
      url.pathname.startsWith("/api/")
    )
      requests.push(url.href);
  });
  await page.goto("/#home");
  const input = page.getByRole("textbox", {
    name: "口令",
    exact: true,
  });
  await page.getByRole("button", { name: "口令输入说明" }).click();
  await expect(
    page.getByRole("dialog", { name: "口令输入说明" }),
  ).toContainText("输入口令兑奖，或输入活动标识跳转活动。");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "口令输入说明" })).toHaveCount(
    0,
  );
  await input.dispatchEvent("compositionstart", { data: "口" });
  await input.fill("口令Ab12");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeDisabled();
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await input.dispatchEvent("compositionend", { data: "口" });
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeEnabled();
  await input.fill(
    "https://linux.do/t/topic/2964597/1216?source=prototype#reply",
  );
  await expect(
    page.getByRole("button", { name: "跳转活动", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "一键优化" })).toHaveCount(0);
  await expect(page.locator(".pw-input__count")).toHaveCount(0);
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await dialog.press("Escape");
  await expect(
    page.getByRole("button", { name: "跳转活动", exact: true }),
  ).toBeFocused();
  await input.fill("https://linux.do/t/2964597/1216");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([]);
});
