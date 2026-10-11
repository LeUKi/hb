import { expect, test } from "@playwright/test";

for (const width of [1440, 375]) {
  test(`activity back icon and password eyes align without extra rows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const forbidden: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin !== "http://127.0.0.1:4177" ||
        /^\/api(?:\/|$)/u.test(url.pathname)
      ) {
        forbidden.push(url.href);
        await route.abort();
      } else await route.continue();
    });

    await page.goto("/#activity?sample=history-random-active");
    const back = page.getByRole("button", { name: "返回兑奖", exact: true });
    await expect(back).toBeVisible();
    await expect(back).toHaveText("");
    const backBox = await back.boundingBox();
    const titleBox = await page.locator(".activity-heading h1").boundingBox();
    expect(backBox?.width).toBe(width === 375 ? 36 : 32);
    expect((backBox?.x ?? 0) + (backBox?.width ?? 0)).toBeLessThan(
      titleBox?.x ?? 0,
    );
    expect(
      Math.abs(
        (backBox?.y ?? 0) +
          (backBox?.height ?? 0) / 2 -
          (titleBox?.y ?? 0) -
          (titleBox?.height ?? 0) / 2,
      ),
    ).toBeLessThan(1);
    await expect(page.locator(".activity-heading-actions")).toHaveCount(0);

    const title = page.locator(".password-list-title");
    const bulk = title.getByRole("button", { name: "隐藏全部口令" });
    const centers = await title.evaluate((element) => {
      const heading = element.querySelector("h2");
      const eye = element.querySelector("button");
      if (!heading || !eye) throw new Error("Password header is missing");
      const h = heading.getBoundingClientRect();
      const e = eye.getBoundingClientRect();
      return {
        heading: h.y + h.height / 2,
        eye: e.y + e.height / 2,
        margin: getComputedStyle(heading).margin,
      };
    });
    expect(centers.margin).toBe("0px");
    expect(Math.abs(centers.heading - centers.eye)).toBeLessThan(1);
    await bulk.focus();
    await bulk.press("Enter");
    await expect(
      title.getByRole("button", { name: "显示全部口令" }),
    ).toBeFocused();
    await expect(page.locator(".pw-reveal__value--hidden")).toHaveCount(1);
    const row = page.locator(".pw-reveal__interaction").first();
    const alignment = await row.evaluate((element) => {
      const boxes = Array.from(element.children).map((child) =>
        child.getBoundingClientRect(),
      );
      return boxes.map((box) => box.y + box.height / 2);
    });
    expect(alignment).toHaveLength(2);
    expect(
      Math.abs((alignment[0] ?? NaN) - (alignment[1] ?? NaN)),
    ).toBeLessThan(1);
    await back.click();
    await expect(page).toHaveURL(/#home$/u);
    await expect(page.locator("#home-password")).not.toBeFocused();

    await page.goto("/#activity?sample=20000000-0000-4000-8000-000000000005");
    const header = page.locator(".activity-heading");
    await expect(
      header.getByRole("button", { name: "复制领取文案" }),
    ).toBeVisible();
    await expect(page.locator(".activity-title-row .action-menu")).toHaveCount(
      2,
    );
    expect(
      await header.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    expect(forbidden).toEqual([]);
  });
}
