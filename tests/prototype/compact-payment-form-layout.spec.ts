import { test as base, expect, type Page } from "@playwright/test";
import { historySamples } from "../../apps/web/prototype/fixtures";

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
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
      await use(undefined);
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

async function checkOverflow(page: Page) {
  const sizes = await page.evaluate(() => {
    const main = document.querySelector("#main");
    return {
      document: document.documentElement.scrollWidth - innerWidth,
      main: (main?.scrollWidth ?? 0) - (main?.clientWidth ?? 0),
    };
  });
  expect(sizes.document).toBeLessThanOrEqual(1);
  expect(sizes.main).toBeLessThanOrEqual(1);
}

async function selectLargePaymentActivity(page: Page) {
  await page
    .locator(".work-payment-activity-row")
    .filter({
      hasText: /^十月第一期红包已结束/u,
    })
    .click();
}

for (const width of [1920, 1440, 768, 375]) {
  test(`payment, edited form and roster fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.goto("/#payment");
    await selectLargePaymentActivity(page);
    await page.locator('[data-payment-id="HB202610060002"]').click();
    const detail = page.locator(
      width >= 1120 ? ".work-payment-detail" : ".work-dialog",
    );
    await expect(detail).toContainText("本站确认发放时间");
    if (width >= 1120) {
      const activity = await page
        .locator(".work-payment-activities")
        .boundingBox();
      const targets = await page.locator(".work-payment-targets").boundingBox();
      const body = await page.locator(".work-payment-detail").boundingBox();
      expect(activity?.width).toBeCloseTo(224, 0);
      expect(targets?.width).toBeCloseTo(288, 0);
      expect(
        (targets?.x ?? 0) - (activity?.x ?? 0) - (activity?.width ?? 0),
      ).toBeCloseTo(16, 0);
      expect(
        (body?.x ?? 0) - (targets?.x ?? 0) - (targets?.width ?? 0),
      ).toBeCloseTo(16, 0);
    } else {
      await expect(page.locator(".work-payment-detail")).toBeHidden();
    }
    await checkOverflow(page);

    await page.goto("/#create");
    await expect(page.locator("#work-title")).toHaveValue("");
    await page.locator("#work-fixed-amount").fill("0");
    await page.locator("#work-fixed-count").focus();
    await expect(page.locator("#work-fixed-amount")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator("#work-fixed-amount-error")).toHaveCSS(
      "opacity",
      "1",
    );
    await checkOverflow(page);

    await page.goto("/#activity?sample=history-random-active");
    await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.98 LDC");
    await expect(
      page.locator('[data-note-region="after"] .activity-note'),
    ).toHaveText(
      historySamples.find((activity) => activity.id === "history-random-active")
        ?.afterClaimInfo ?? "",
      { useInnerText: true },
    );
    await checkOverflow(page);
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const roster = page.locator(".public-roster-dialog");
    await expect(roster).toBeVisible();
    await expect(roster.locator(".public-roster__summary")).toContainText(
      "领取名单",
    );
    const award = roster.locator(".recipient-award").first();
    const badge = await award.locator(".recipient-title").boundingBox();
    const amount = await award.locator(".recipient-award-amount").boundingBox();
    expect((badge?.x ?? 0) + (badge?.width ?? 0)).toBeLessThanOrEqual(
      amount?.x ?? 0,
    );
    expect((await roster.boundingBox())?.width).toBeLessThanOrEqual(
      Math.min(440, width - 24),
    );
    await expect(roster.locator(".recipient").first()).toContainText(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u,
    );
    await checkOverflow(page);
  });
}

test("payment and create remain usable with doubled text and long raw links", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#create");
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await page.locator("#work-title").fill("长活动名称".repeat(16));
  await page
    .locator("#work-topic")
    .fill(
      `https://linux.do/t/${"中文帖子标题".repeat(20)}/2964597/1216?utm=example#reply`,
    );
  await expect(
    page.getByRole("button", { name: "一键优化", exact: true }),
  ).toBeVisible();
  await checkOverflow(page);
  await page.getByRole("button", { name: "限时开奖", exact: true }).click();
  await expect(page.locator("#work-draw-seconds")).toHaveValue("600");
  await checkOverflow(page);
  await page.goto("/#payment");
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await selectLargePaymentActivity(page);
  await page.locator('[data-payment-id="HB202610060002"]').click();
  await expect(page.getByRole("dialog")).toContainText("本站业务号");
  await checkOverflow(page);
});
