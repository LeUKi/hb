import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const viewports = [
  { width: 1920, height: 950 },
  { width: 1440, height: 950 },
  { width: 768, height: 900 },
  { width: 375, height: 900 },
] as const;

const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
          forbidden.add(url.href);
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect([...forbidden], "Compact layout tests stay local").toEqual([]);
    },
    { auto: true },
  ],
});

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    main:
      (document.querySelector(".site-main")?.scrollWidth ?? 0) -
      (document.querySelector(".site-main")?.clientWidth ?? 0),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.main).toBeLessThanOrEqual(1);
}

async function expectMaxWidth(locator: Locator, maximum: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Expected element has no bounds");
  expect(box.width).toBeLessThanOrEqual(maximum + 1);
  return box;
}

test.describe("compact page geometry", () => {
  for (const viewport of viewports) {
    test(`home, activity and account widths stay compact at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);

      await page.goto("/#home");
      await expect(page.locator(".home-page")).toBeVisible();
      await expectMaxWidth(
        page.locator(".home-hero"),
        Math.min(640, viewport.width),
      );
      await expectMaxWidth(
        page.locator(".home-exchange .pw-input__field"),
        Math.min(420, viewport.width),
      );
      await expectNoHorizontalOverflow(page);

      await page.goto("/#activity?sample=thanks");
      await expect(page.locator(".activity-page")).toBeVisible();
      await expectMaxWidth(
        page.locator(".claim-layout"),
        Math.min(720, viewport.width),
      );
      await expectMaxWidth(
        page.locator(".password-display-list"),
        Math.min(640, viewport.width),
      );
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await expectMaxWidth(
        page.locator(".public-roster-dialog"),
        Math.min(440, viewport.width - 24),
      );
      await page.getByRole("button", { name: "关闭名单", exact: true }).click();
      await expectNoHorizontalOverflow(page);

      await page.goto("/#activity?sample=history-random-active");
      await expect(page.locator(".solve-row .pw-input__field")).toBeVisible();
      await expectMaxWidth(
        page.locator(".solve-row .pw-input__field"),
        Math.min(421, viewport.width),
      );
      await expectNoHorizontalOverflow(page);

      await page.goto("/#create");
      await expect(
        page.locator(".work-password-row .pw-input__field").first(),
      ).toBeVisible();
      await expectMaxWidth(
        page.locator(".work-password-row .pw-input__field").first(),
        Math.min(420, viewport.width),
      );
      await expectNoHorizontalOverflow(page);

      await page.goto("/#account");
      await expect(page.locator(".work-account-page")).toBeVisible();
      await expectMaxWidth(
        page.locator(".work-account-page"),
        Math.min(760, viewport.width),
      );
      const management = page.locator(".work-account-nav");
      if (viewport.width >= 900) {
        await expectMaxWidth(management, 260);
        const layoutGap = await page
          .locator(".work-account-layout")
          .evaluate((element) => getComputedStyle(element).columnGap);
        expect(Number.parseFloat(layoutGap)).toBeCloseTo(24, 0);
      } else {
        await expect(management).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
    });
  }
});

test("account labels and long values remain left aligned and wrap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/#account");
  const rows = page.locator(".work-account-rows > div");
  const first = rows.first();
  const label = first.locator("dt");
  const value = first.locator("dd");
  const labelBox = await label.boundingBox();
  const valueBox = await value.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(valueBox).not.toBeNull();
  if (!labelBox || !valueBox) throw new Error("Account row has no bounds");
  expect(valueBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
  expect(Math.abs(valueBox.y - labelBox.y)).toBeLessThanOrEqual(2);
  expect(
    await value.evaluate((element) => getComputedStyle(element).textAlign),
  ).toBe("start");

  const emailValue = rows
    .filter({ hasText: "Connect 邮箱" })
    .locator("dd span")
    .first();
  await emailValue.evaluate((element) => {
    element.textContent =
      "linjian.very-long-connect-email-address-for-layout-check@example-subdomain.invalid";
  });
  const emailBox = await emailValue.boundingBox();
  const accountBox = await page.locator(".work-account-page").boundingBox();
  expect(emailBox).not.toBeNull();
  expect(accountBox).not.toBeNull();
  if (!emailBox || !accountBox) throw new Error("Long email has no bounds");
  expect(emailBox.x).toBeGreaterThanOrEqual(accountBox.x);
  expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(
    accountBox.x + accountBox.width + 1,
  );
});

test("account long values avoid overflow at 375px with enlarged text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.goto("/#account");
  await page
    .locator(".work-account-rows > div", { hasText: "Connect 邮箱" })
    .locator("dd span")
    .first()
    .evaluate((element) => {
      element.textContent =
        "linjian.very-long-connect-email-address-for-layout-check@example-subdomain.invalid";
    });
  await expectNoHorizontalOverflow(page);
});

test("fresh random activity keeps claim input and action compact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/#activity?sample=random");
  await expect(page.locator(".claim-form")).toBeVisible();
  const fieldBox = await page
    .locator(".claim-form .pw-input__field")
    .boundingBox();
  const buttonBox = await page
    .locator(".claim-form")
    .getByRole("button", { name: "领取红包", exact: true })
    .boundingBox();
  expect(fieldBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  if (!fieldBox || !buttonBox) throw new Error("Claim controls have no bounds");
  expect(fieldBox.width).toBeLessThanOrEqual(421);
  expect(buttonBox.width).toBeLessThan(180);
  expect(Math.abs(buttonBox.x - fieldBox.x)).toBeLessThanOrEqual(1);
});

test("desktop and mobile navigation use independent red underlines", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900, nav: "主导航" },
    { width: 375, height: 900, nav: "手机导航" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/#home");
    const nav = page.getByRole("navigation", { name: viewport.nav });
    await expect(nav).toBeVisible();
    const links = ["兑奖", "活动历史", "我的"];
    for (const label of links) {
      await nav.getByRole("link", { name: label, exact: true }).click();
      await expect(
        nav.getByRole("link", { name: label, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      const indicator = nav.locator(".nav-active-indicator");
      await expect(indicator).toHaveCount(1);
      await expect(indicator).toHaveCSS("height", "2px");
      await expect(indicator).toHaveCSS(
        "background-color",
        "rgb(255, 137, 123)",
      );
    }
  }
});

test("reduced motion positions navigation underline without sliding", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#home");
  const nav = page.getByRole("navigation", { name: "主导航" });
  for (const label of ["活动历史", "我的", "兑奖"]) {
    await nav.getByRole("link", { name: label, exact: true }).click();
  }
  const active = nav.getByRole("link", { name: "兑奖", exact: true });
  const indicator = nav.locator(".nav-active-indicator");
  await expect(active).toHaveAttribute("aria-current", "page");
  await expect(indicator).toHaveCSS("height", "2px");
  await expect(indicator).toHaveCSS("transform", "none");
  const [activeBox, indicatorBox] = await Promise.all([
    active.boundingBox(),
    indicator.boundingBox(),
  ]);
  expect(activeBox).not.toBeNull();
  expect(indicatorBox).not.toBeNull();
  if (!activeBox || !indicatorBox) throw new Error("Nav bounds missing");
  expect(indicatorBox.x).toBeGreaterThanOrEqual(activeBox.x + 8);
  expect(indicatorBox.x + indicatorBox.width).toBeLessThanOrEqual(
    activeBox.x + activeBox.width - 8,
  );
});

async function scrollMainTo(page: Page, selector: string) {
  await page.locator(selector).waitFor({ state: "visible" });
  await page.evaluate((targetSelector) => {
    const main = document.querySelector<HTMLElement>(".site-main");
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!main || !target) return;
    main.scrollTop = Math.max(0, target.offsetTop - main.offsetTop - 16);
  }, selector);
  await page.evaluate(() => document.fonts.ready);
}

test("compact layouts retain usable controls and settled geometry", async ({
  page,
}) => {
  // Check settled geometry; normal Motion transitions are exercised above.
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of [
    { width: 1440, height: 950 },
    { width: 375, height: 900 },
  ] as const) {
    await page.setViewportSize(viewport);
    for (const [name, path, selector] of [
      ["compact-home", "/#home", ".home-page"],
      ["compact-passwords", "/#activity?sample=thanks", ".password-section"],
      ["compact-account", "/#account", ".work-account-page"],
      [
        "compact-roster",
        "/#activity?sample=history-random-active",
        ".public-roster-dialog",
      ],
    ] as const) {
      await page.goto(path);
      await expect(
        page.getByText("正在显示说明…", { exact: true }),
      ).toHaveCount(0);
      if (name === "compact-roster") {
        await page
          .getByRole("button", { name: "查看领取名单", exact: true })
          .click();
        await expect(page.locator(selector)).toBeVisible();
      } else await scrollMainTo(page, selector);
      await expect(page.locator(selector)).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }
});
