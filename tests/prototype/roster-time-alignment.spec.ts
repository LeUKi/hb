import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.push(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(forbidden, "Roster display stays local").toEqual([]);
    },
    { auto: true },
  ],
});

async function checkTimeRows(page: Page, enlarged = false) {
  const rows = page.locator(".public-roster .recipient-time");
  await expect(rows.first()).toBeVisible();
  const geometry = await rows.evaluateAll((nodes) =>
    nodes.slice(0, 5).map((node) => {
      const [absolute, relative] = [...node.querySelectorAll("time")];
      const full = absolute.getBoundingClientRect();
      const short = relative.getBoundingClientRect();
      const parent = node.getBoundingClientRect();
      const style = getComputedStyle(absolute);
      const range = document.createRange();
      range.selectNodeContents(absolute);
      return {
        fullText: absolute.textContent,
        firstClass: absolute.className,
        secondClass: relative.className,
        sameDate: absolute.dateTime === relative.dateTime,
        font: style.fontFamily,
        digits: style.fontVariantNumeric,
        basis: Number.parseFloat(style.flexBasis),
        left: full.left,
        width: full.width,
        relativeLeft: short.left,
        gap: short.left - full.right,
        wrapped: short.top > full.top + 1,
        textFits: range.getBoundingClientRect().width <= full.width + 1,
        fits: full.right <= parent.right + 1 && short.right <= parent.right + 1,
      };
    }),
  );
  expect(geometry.length).toBeGreaterThan(1);
  for (const row of geometry) {
    expect(row.fullText).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    expect(row.firstClass).toBe("recipient-time__absolute");
    expect(row.secondClass).toBe("recipient-time__relative");
    expect(row.sameDate).toBe(true);
    expect(row.font).toContain("monospace");
    expect(row.digits).toContain("tabular-nums");
    expect(row.basis).toBeCloseTo(row.width, 1);
    expect(row.width).toBeCloseTo(geometry[0].width, 1);
    expect(row.left).toBeCloseTo(geometry[0].left, 1);
    expect(row.relativeLeft).toBeCloseTo(geometry[0].relativeLeft, 1);
    expect(row.textFits).toBe(true);
    expect(row.fits).toBe(true);
    if (enlarged) {
      expect(row.wrapped).toBe(true);
      expect(row.relativeLeft).toBeCloseTo(row.left, 1);
    } else {
      expect(row.wrapped).toBe(false);
      expect(row.gap).toBeCloseTo(8, 1);
    }
  }
}

for (const width of [1440, 375]) {
  test(`claim, registration and winner times align and wrap at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#activity?sample=history-random-active");
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    await checkTimeRows(page);
    await page.getByRole("dialog").press("Escape");

    await page.goto("/#activity?sample=history-draw-won");
    await page
      .getByRole("button", { name: "查看中奖名单", exact: true })
      .click();
    await expect(page.getByRole("tab", { name: /中奖名单/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await checkTimeRows(page);
    await page.getByRole("tab", { name: /报名名单/u }).click();
    await checkTimeRows(page);
    if (width === 375) {
      await page.addStyleTag({
        content: "html { font-size: 200% !important; }",
      });
      await checkTimeRows(page, true);
      const list = page.locator(".public-roster .recipient-list");
      expect(
        await list.evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
  });
}

test("relative roster time advances while the complete timestamp stays fixed", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-07T04:00:00.000Z") });
  await page.goto("/#activity?sample=history-random-active");
  await page.getByRole("button", { name: "查看领取名单", exact: true }).click();
  const row = page.locator(".public-roster .recipient-time").first();
  const absolute = row.locator(".recipient-time__absolute");
  const relative = row.locator(".recipient-time__relative");
  const original = await absolute.textContent();
  const before = await relative.textContent();
  await page.clock.fastForward(2 * 24 * 60 * 60 * 1000);
  await expect(absolute).toHaveText(original ?? "");
  await expect(relative).not.toHaveText(before ?? "");
});
