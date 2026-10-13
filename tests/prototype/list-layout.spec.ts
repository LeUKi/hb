import { test as base, expect } from "@playwright/test";
import { historySamples } from "../../apps/web/prototype/fixtures";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden: string[] = [];
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/.test(url.pathname)) {
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

for (const width of [1920, 1440, 768, 375]) {
  test(`list pagination stays fixed and content fits at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const route of ["square", "participations", "manage", "payment"]) {
      await page.goto(`/#${route}`);
      const panel = page.locator(".list-panel").first();
      await expect(panel).toBeVisible();
      const footer = panel.locator(".list-panel__footer");
      await expect(footer).toBeInViewport();
      const original = await footer.boundingBox();
      await panel.locator(".list-panel__scroll").evaluate((element) => {
        element.scrollTop = 300;
      });
      await expect(footer).toBeInViewport();
      expect(await footer.boundingBox()).toEqual(original);
      const bounds = await page.evaluate(() => {
        const main = document.querySelector(".site-main");
        const scroll = document.querySelector(".list-panel__scroll");
        return {
          doc: document.documentElement.scrollWidth,
          width: innerWidth,
          main: main?.scrollWidth,
          scroll: scroll?.scrollWidth,
          client: scroll?.clientWidth,
          body: document.body.scrollHeight,
          height: innerHeight,
        };
      });
      expect(bounds.doc).toBeLessThanOrEqual(width);
      expect(bounds.main).toBeLessThanOrEqual(width);
      expect(bounds.scroll).toBeLessThanOrEqual((bounds.client ?? 0) + 1);
      expect(bounds.body).toBeLessThanOrEqual(bounds.height);
      await panel.locator(".list-panel__scroll").evaluate((element) => {
        element.scrollTop = 0;
      });
    }
    if (width === 1440 || width === 375) {
      await page.goto("/#activity?sample=history-random-active");
      await expect(page.locator(".envelope-svg .prize")).toHaveText(
        "+0.98 LDC",
      );
      await expect(
        page.locator('[data-note-region="after"] .activity-note'),
      ).toHaveText(
        historySamples.find(
          (activity) => activity.id === "history-random-active",
        )?.afterClaimInfo ?? "",
        { useInnerText: true },
      );
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: /领取名单/u }),
      ).toBeVisible();
    }
  });
}

test("list controls remain usable with enlarged text and reduced motion", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#manage");
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(0);
  const next = page
    .getByRole("navigation", { name: "作者活动分页" })
    .getByRole("button", { name: "下一页", exact: true });
  await next.focus();
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();
  await expect(page.locator(".list-pagination")).toBeInViewport();
  const widths = await page.evaluate(() => ({
    full: document.documentElement.scrollWidth,
    main: document.querySelector(".site-main")?.scrollWidth,
  }));
  expect(widths.full).toBeLessThanOrEqual(375);
  expect(widths.main).toBeLessThanOrEqual(375);
});

function contrast(first: string, second: string) {
  const lum = (color: string) => {
    const values = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const value = Number(part) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (
      (values[0] ?? 0) * 0.2126 +
      (values[1] ?? 0) * 0.7152 +
      (values[2] ?? 0) * 0.0722
    );
  };
  const a = lum(first),
    b = lum(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("dark text, controls and focus indicators meet the chosen contrast thresholds", async ({
  page,
}) => {
  await page.goto("/#square");
  const colors = await page.evaluate(() => {
    const css = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing ${selector}`);
      return getComputedStyle(node);
    };
    const row = css(".activity-rows-row"),
      surface = css(".activity-rows"),
      text = css(".activity-rows-open"),
      muted = css(".activity-rows-type");
    const button = css(".gallery-status-filter .action-menu-trigger");
    const next = css(".list-pagination__button:last-child");
    return {
      bodyText: text.color,
      muted: muted.color,
      surface: surface.backgroundColor,
      row: row.backgroundColor,
      control: button.backgroundColor,
      border: button.borderTopColor,
      controlText: button.color,
      next: next.color,
      nextBg: next.backgroundColor,
      nextBorder: next.borderTopColor,
    };
  });
  expect(contrast(colors.bodyText, colors.surface)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.controlText, colors.control)).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrast(colors.border, colors.control)).toBeGreaterThanOrEqual(3);
  expect(contrast(colors.next, colors.nextBg)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(colors.nextBorder, colors.nextBg)).toBeGreaterThanOrEqual(3);
  const chosen = page.locator(".gallery-status-filter .action-menu-trigger");
  await chosen.focus();
  const focus = await chosen.evaluate((node) => ({
    outline: getComputedStyle(node).outlineColor,
    bg: getComputedStyle(node).backgroundColor,
  }));
  expect(contrast(focus.outline, focus.bg)).toBeGreaterThanOrEqual(3);
});
