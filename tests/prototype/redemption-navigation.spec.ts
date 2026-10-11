import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const knownActivity = "history-random-active";
const knownTitle = "周六即时随机红包";
const newTitle = "周末红包 · 20 份";
const uniquePassword = "周末口令2026";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      const check = (address: string) => {
        const url = new URL(address);
        return url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname);
      };
      page.on("request", (request) => {
        if (check(request.url())) forbidden.add(request.url());
      });
      page.on("websocket", (socket) => {
        if (new URL(socket.url()).host !== new URL(origin).host)
          forbidden.add(socket.url());
      });
      await page.route("**/*", async (route) => {
        if (check(route.request().url())) {
          forbidden.add(route.request().url());
          await route.abort();
        } else await route.continue();
      });
      await use(undefined);
      expect(
        [...forbidden],
        "Actual prototype navigation has no business/external requests",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

function currentRoute(page: Page) {
  return page.locator('.route-frame[data-route-presence="present"]');
}
function envelope(page: Page) {
  return currentRoute(page).getByTestId("envelope");
}
async function freezeApp(page: Page, hash = "#home") {
  await page.clock.install({ time: new Date("2026-10-06T03:59:00.000Z") });
  await page.goto(`/${hash}`);
  await expect(currentRoute(page)).toBeVisible();
  await page.clock.pauseAt(new Date("2026-10-06T04:00:00.000Z"));
}
async function openLocator(page: Page, id: string, title: string) {
  const route = currentRoute(page);
  await route
    .getByRole("textbox", { name: "口令" })
    .fill(`${origin}/#activity?sample=${id}`);
  await route.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(currentRoute(page).locator(".activity-page h1")).toHaveText(
    title,
  );
  await expect(currentRoute(page).locator(".activity-page")).toBeVisible();
}
async function openControls(page: Page) {
  const toggle = page.getByRole("button", { name: "场景与身份", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  return page.getByRole("complementary", { name: "原型场景" });
}
async function expectRecipientCount(page: Page, count: number) {
  await currentRoute(page)
    .getByRole("button", { name: "查看领取名单", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /领取名单/u });
  await expect(dialog.locator(".recipient")).toHaveCount(count);
  await expect(
    dialog.locator('.recipient[data-username="linjian"]'),
  ).toHaveCount(1);
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
}

for (const viewport of [
  { width: 1440, height: 950 },
  { width: 375, height: 900 },
]) {
  test(`actual locator, return and browser history animate the same envelope at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await freezeApp(page);
    await openLocator(page, knownActivity, knownTitle);
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await expect(envelope(page)).toHaveAttribute("data-opening-count", "0");
    await page.clock.runFor(250);
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await page.clock.runFor(60);
    await expect(envelope(page)).toHaveAttribute("data-phase", "opening");
    await expect(envelope(page)).toHaveAttribute("data-opening-count", "1");
    await page.clock.runFor(850);
    await expect(envelope(page)).toHaveAttribute("data-phase", "open");
    await expect(currentRoute(page).locator(".slip-amount")).toHaveText(
      "+0.98",
    );
    await currentRoute(page)
      .getByRole("button", { name: "返回兑奖", exact: true })
      .click();
    await expect(envelope(page)).toHaveAttribute("data-size", "small");
    await expect(envelope(page)).toHaveAttribute("data-phase", "closing");
    await expect(envelope(page).locator(".slip-amount")).toHaveText("+0.98");
    await page.clock.runFor(320);
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await expect(envelope(page).locator(".reward-slip")).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`sample=${knownActivity}`));
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await page.clock.runFor(320);
    await expect(envelope(page)).toHaveAttribute("data-phase", "opening");
    await page.clock.runFor(850);
    await expect(envelope(page)).toHaveAttribute("data-phase", "open");
    await expect(envelope(page)).toHaveAttribute("data-opening-count", "1");
    await page.goForward();
    await page.clock.runFor(320);
    await expect(page).toHaveURL(/#home$/u);
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(
      0,
    );
  });
}

test("a single home match confirms one reward and consumes one opening event", async ({
  page,
}) => {
  await freezeApp(page);
  await currentRoute(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill(uniquePassword);
  await currentRoute(page)
    .getByRole("button", { name: "兑奖", exact: true })
    .click();
  await expect(
    currentRoute(page).getByRole("button", { name: "正在确认…", exact: true }),
  ).toBeDisabled();
  await expect(envelope(page)).toHaveAttribute("data-open", "false");
  await page.clock.runFor(560);
  await expect(currentRoute(page).locator(".activity-page h1")).toHaveText(
    newTitle,
  );
  await expect(envelope(page)).toHaveAttribute("data-phase", "opening");
  await expect(envelope(page)).toHaveAttribute("data-opening-count", "1");
  await page.clock.runFor(1_200);
  await expect(envelope(page)).toHaveAttribute("data-phase", "open");
  await expect(envelope(page)).toHaveAttribute("data-opening-count", "1");
  await expectRecipientCount(page, 9);
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("link", { name: "活动历史", exact: true })
    .click();
  await expect(
    currentRoute(page).getByRole("button", { name: newTitle, exact: true }),
  ).toHaveCount(1);
  await currentRoute(page)
    .getByRole("button", { name: newTitle, exact: true })
    .click();
  await expect(envelope(page)).toHaveAttribute("data-phase", "open");
  await expect(envelope(page)).toHaveAttribute("data-animate", "false");
  await expect(envelope(page)).toHaveAttribute("data-opening-count", "0");
  await expectRecipientCount(page, 9);
});

test("shared input transitions leave only the destination editor and no exited plaintext", async ({
  page,
}) => {
  await freezeApp(page);
  await openLocator(page, "weekend", newTitle);
  const exiting = page.locator('[data-route-presence="exiting"]');
  await expect(exiting).toHaveAttribute("inert", "");
  await expect(exiting).toHaveAttribute("aria-hidden", "true");
  await expect(exiting.locator("textarea")).toHaveCount(0);
  await expect(exiting.locator(".pw-input__shared-frame")).toHaveCount(1);
  expect(await exiting.textContent()).not.toContain(`${origin}/#activity`);
  await expect(page.locator("textarea")).toHaveCount(1);
  await expect(
    currentRoute(page).getByRole("textbox", { name: "兑换口令", exact: true }),
  ).toHaveValue("");
  await expect(
    currentRoute(page).locator(".pw-input__shared-frame"),
  ).toHaveCount(1);
  await page.clock.runFor(320);
  await expect(exiting).toHaveCount(0);
  await currentRoute(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await expect(page.locator("textarea")).toHaveCount(1);
  await expect(
    currentRoute(page).getByRole("textbox", { name: "口令", exact: true }),
  ).toHaveValue("");
  await expect(
    currentRoute(page).getByRole("button", { name: "兑奖", exact: true }),
  ).toHaveCount(0);
  const focus = await page.evaluate(() => document.activeElement?.id);
  expect(focus).toBe("main");
});

test("a slow submission and rapid navigation cannot publish a late result", async ({
  page,
}) => {
  await freezeApp(page, "#activity?sample=weekend");
  const tools = await openControls(page);
  await tools
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption("slow");
  await page.getByRole("button", { name: "场景与身份", exact: true }).click();
  await currentRoute(page)
    .getByRole("textbox", { name: "兑换口令", exact: true })
    .fill(uniquePassword);
  await currentRoute(page)
    .getByRole("button", { name: "领取红包", exact: true })
    .click();
  await expect(
    currentRoute(page).getByRole("textbox", { name: "兑换口令", exact: true }),
  ).toBeDisabled();
  await page.clock.runFor(200);
  await currentRoute(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await page.clock.runFor(3_500);
  await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
  await expect(envelope(page).locator(".reward-slip")).toHaveCount(0);
  await openLocator(page, "weekend", newTitle);
  await expect(envelope(page)).toHaveAttribute("data-open", "false");
  await expect(currentRoute(page).locator(".claim-form")).toBeVisible();
  await page.clock.runFor(320);
  await currentRoute(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await page.clock.runFor(320);
  await openLocator(page, knownActivity, knownTitle);
  await page.clock.runFor(100);
  await currentRoute(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await page.clock.runFor(1_300);
  await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
  await expect(envelope(page)).toHaveAttribute("data-opening-count", "0");
  await expect(envelope(page).locator(".reward-slip")).toHaveCount(0);
  await expect(page.locator('[data-route-presence="exiting"]')).toHaveCount(0);
});

for (const identity of ["guest", "lite"]) {
  test(`${identity} returns from a published draw without another account's amount`, async ({
    page,
  }) => {
    await freezeApp(page, "#activity?sample=history-draw-won");
    const tools = await openControls(page);
    await tools
      .getByRole("combobox", { name: "体验身份", exact: true })
      .selectOption(identity);
    await page.getByRole("button", { name: "场景与身份", exact: true }).click();
    await expect(envelope(page)).toHaveAttribute("data-open", "true");
    await expect(envelope(page)).toHaveAttribute("data-opening-count", "0");
    await expect(envelope(page).locator(".slip-amount")).toHaveCount(0);
    await expect(envelope(page).locator(".reward-slip")).toContainText(
      /已结束|错过了/u,
    );
    await currentRoute(page)
      .getByRole("button", { name: "返回兑奖", exact: true })
      .click();
    await expect(envelope(page).locator(".slip-amount")).toHaveCount(0);
    await page.clock.runFor(400);
    await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
    await expect(envelope(page).locator(".reward-slip")).toHaveCount(0);
  });
}

test("reduced-motion app navigation shows historical rewards immediately", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freezeApp(page);
  await openLocator(page, knownActivity, knownTitle);
  await expect(envelope(page)).toHaveAttribute("data-phase", "open");
  await expect(envelope(page)).toHaveAttribute("data-opening-count", "0");
  await expect(envelope(page)).toHaveAttribute("data-animate", "false");
  await currentRoute(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await expect(envelope(page)).toHaveAttribute("data-phase", "closed");
  await expect(envelope(page).locator(".reward-slip")).toHaveCount(0);
});
