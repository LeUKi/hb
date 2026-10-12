import {
  test as base,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const navigationItems = [
  { label: "兑奖", route: "home" },
  { label: "活动历史", route: "participations" },
  { label: "我的", route: "account" },
] as const;
const oldSlogans =
  /一份心意\s*·\s*一次相遇|把好运[，,\s]*拆开来|有人把心意藏进了口令里|输入它，收下属于你的那份惊喜|每一份红包，都是来自佬友的心意|FOR THE LITTLE JOYS IN LIFE|愿你与好运撞个满怀|广场里，好事正在发生|一点开心，大家分|好事发生的地方|随意逛逛，也许下一份惊喜就是你的|小小的心意，慢慢遇见|把一点好运，送给每一次相遇|今天也有好事发生/u;

const test = base.extend<{ isolatedNetwork: undefined }>({
  isolatedNetwork: [
    async ({ page }, use) => {
      const forbidden = new Set<string>();
      const isForbidden = (address: string) => {
        const url = new URL(address);
        return url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname);
      };
      page.on("request", (request) => {
        if (isForbidden(request.url())) forbidden.add(request.url());
      });
      page.on("websocket", (socket) => {
        const url = new URL(socket.url());
        if (url.host !== new URL(origin).host) forbidden.add(socket.url());
      });
      await page.route("**/*", async (route) => {
        if (isForbidden(route.request().url())) {
          forbidden.add(route.request().url());
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await use(undefined);
      expect(
        [...forbidden],
        "Framework verification must not request any API or external service",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

async function assertHorizontalBounds(page: Page) {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".site-main");
    return {
      viewport: window.innerWidth,
      html: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      mainContent: main?.scrollWidth,
      mainWidth: main?.clientWidth,
    };
  });
  expect(dimensions.html, "Document must fit the viewport").toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
  expect(dimensions.body, "Body must fit the viewport").toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
  expect(
    dimensions.mainContent,
    "Main must not clip horizontal content",
  ).toBeLessThanOrEqual((dimensions.mainWidth ?? 0) + 1);
}

async function assertViewportShell(page: Page) {
  await expect(page.locator(".tool-shell")).toBeVisible();
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator(".site-main")).toBeVisible();
  await expect(page.locator("#build-stamp")).toBeVisible();
  await assertHorizontalBounds(page);
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerHeight,
    html: document.documentElement.scrollHeight,
    body: document.body.scrollHeight,
    scrollY: window.scrollY,
  }));
  expect(
    dimensions.html,
    "Document must not scroll vertically",
  ).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(
    dimensions.body,
    "Body must not scroll vertically",
  ).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.scrollY).toBe(0);
}

async function assertTapTarget(control: Locator, viewportWidth: number) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, "Visible control must have layout bounds").not.toBeNull();
  if (!box) return;
  const compact = await control.evaluate(
    (element) =>
      element.classList.contains("create-link") ||
      element.classList.contains("row-action"),
  );
  const minimum = compact ? (viewportWidth <= 760 ? 36 : 32) : 44;
  expect(
    box.height,
    "Control follows its agreed size tier",
  ).toBeGreaterThanOrEqual(minimum - 0.01);
  expect(
    box.width,
    "Control must offer a 44px tap target width",
  ).toBeGreaterThanOrEqual(43.99);
  expect(box.x, "Control starts inside the viewport").toBeGreaterThanOrEqual(
    -1,
  );
  expect(
    box.x + box.width,
    "Control ends inside the viewport",
  ).toBeLessThanOrEqual(viewportWidth + 1);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, navigation: "主导航" },
  { name: "tablet", width: 768, height: 900, navigation: "手机导航" },
  { name: "mobile", width: 375, height: 812, navigation: "手机导航" },
] as const) {
  test(`${viewport.name} framework keeps navigation accessible and scrolls only its main region`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/#home");
    const navigation = page.getByRole("navigation", {
      name: viewport.navigation,
      exact: true,
    });
    const header = page.locator(".site-header");
    const main = page.locator(".site-main");
    const create = header.getByRole("link", { name: "发起活动", exact: true });
    const account = header.getByRole("link", { name: "我的账号", exact: true });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link")).toHaveCount(4);

    for (const { label, route } of navigationItems) {
      const link = navigation.getByRole("link", { name: label, exact: true });
      await assertTapTarget(link, viewport.width);
      await expect(link).toHaveAttribute("href", `#${route}`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#${route}$`, "u"));
      if (route === "home")
        await expect(main.locator("#home-password")).toBeVisible();
      else await expect(main.locator("h1")).toBeVisible();
      await expect(link).toHaveAttribute("aria-current", "page");
      await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
      await assertTapTarget(create, viewport.width);
      await assertTapTarget(account, viewport.width);
      await assertViewportShell(page);
      if (route === "home") {
        await expect(page.locator(".tool-shell")).not.toContainText(oldSlogans);
        await expect(page.getByText("运行状态", { exact: true })).toHaveCount(
          0,
        );
      }
    }

    const history = navigation.getByRole("link", {
      name: "活动历史",
      exact: true,
    });
    await history.click();
    const participating = main.getByRole("tab", {
      name: "我参与的",
      exact: true,
    });
    const initiated = main.getByRole("tab", {
      name: "我发起的",
      exact: true,
    });
    await expect(participating).toBeVisible();
    await expect(initiated).toBeVisible();
    await expect(participating).toHaveAttribute("aria-selected", "true");
    await expect(initiated).toHaveAttribute("aria-selected", "false");
    await expect(page).toHaveURL(/#participations$/u);
    await initiated.click();
    await expect(page).toHaveURL(/#manage$/u);
    await expect(initiated).toHaveAttribute("aria-selected", "true");
    await expect(participating).toHaveAttribute("aria-selected", "false");
    await expect(history).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await assertViewportShell(page);
    await main.getByRole("tab", { name: "我参与的", exact: true }).click();
    await expect(page).toHaveURL(/#participations$/u);
    await expect(history).toHaveAttribute("aria-current", "page");

    await create.click();
    await expect(page).toHaveURL(/#create$/u);
    await expect(main.locator("h1")).toBeVisible();
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(0);
    await assertTapTarget(create, viewport.width);
    await assertTapTarget(account, viewport.width);
    await assertViewportShell(page);
    await account.click();
    await expect(page).toHaveURL(/#account$/u);
    await expect(
      navigation.getByRole("link", { name: "我的", exact: true }),
    ).toHaveAttribute("aria-current", "page");

    await navigation.getByRole("link", { name: "兑奖", exact: true }).click();
    await page
      .getByRole("button", { name: "已公开的活动", exact: true })
      .click();
    const rows = page.locator(".activity-rows-row");
    await expect(rows).toHaveCount(20);
    await expect(page.locator(".activity-rows button button")).toHaveCount(0);
    const rowLayout = await rows.evaluateAll((elements) =>
      elements.map((element) => ({
        content: element.scrollWidth,
        width: element.clientWidth,
      })),
    );
    for (const row of rowLayout)
      expect(row.content).toBeLessThanOrEqual(row.width + 1);
    await assertTapTarget(
      rows.first().locator(".view-activity-action"),
      viewport.width,
    );
    await assertTapTarget(
      rows.first().locator(".user-identity"),
      viewport.width,
    );
    const before = await header.boundingBox();
    expect(before).not.toBeNull();
    const scroller = page.locator(".list-panel__scroll");
    const scrollRange = await scroller.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(
      scrollRange,
      "Square fixture must exercise vertical scrolling",
    ).toBeGreaterThan(0);
    await scroller.evaluate((element) => {
      element.scrollTop = Math.min(
        240,
        element.scrollHeight - element.clientHeight,
      );
    });
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(
      await header.boundingBox(),
      "Header must remain fixed while main scrolls",
    ).toEqual(before);
    await assertViewportShell(page);

    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("heading", { name: "活动广场", exact: true }).click();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
  });
}

test("framework remains dark under both system color preferences", async ({
  page,
}) => {
  const appearances = [];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/#home");
    await expect(page.locator(".tool-shell")).toBeVisible();
    const appearance = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        background: root.backgroundColor,
        color: root.color,
        colorScheme: root.colorScheme,
      };
    });
    expect(appearance.colorScheme).toBe("dark");
    const channels = appearance.background
      .match(/[\d.]+/gu)
      ?.slice(0, 3)
      .map(Number);
    expect(channels).toHaveLength(3);
    expect(
      Math.max(...(channels ?? [255])),
      "Root background must be dark",
    ).toBeLessThanOrEqual(60);
    appearances.push(appearance);
  }
  expect(appearances[0]).toEqual(appearances[1]);
});

test("keyboard focus reaches the home input within a compact mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 430 });
  await page.goto("/#home");
  const input = page.locator("#home-password");
  await expect(input).toBeVisible();
  for (
    let step = 0;
    step < 30 &&
    !(await input.evaluate((element) => element === document.activeElement));
    step++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(input).toBeFocused();
  const mainBox = await page.locator(".site-main").boundingBox();
  const inputBox = await input.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(inputBox).not.toBeNull();
  if (mainBox && inputBox) {
    expect(
      inputBox.y,
      "Focused input must be below the header",
    ).toBeGreaterThanOrEqual(mainBox.y - 1);
    expect(
      inputBox.y + inputBox.height,
      "Focused input must remain above mobile navigation",
    ).toBeLessThanOrEqual(mainBox.y + mainBox.height + 1);
  }
  await input.fill("有效Ab123");
  await expect(input).toHaveValue("有效Ab123");
  await assertViewportShell(page);
});

test("200 percent root font retains navigation and avoids horizontal clipping", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900, navigation: "主导航" },
    { width: 375, height: 812, navigation: "手机导航" },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/#home");
    await page.addStyleTag({ content: "html { font-size: 32px !important; }" });
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    const navigation = page.getByRole("navigation", {
      name: viewport.navigation,
      exact: true,
    });
    await expect(navigation).toBeVisible();
    for (const { label } of navigationItems) {
      await assertTapTarget(
        navigation.getByRole("link", { name: label, exact: true }),
        viewport.width,
      );
    }
    await assertTapTarget(
      page
        .locator(".site-header")
        .getByRole("link", { name: "发起活动", exact: true }),
      viewport.width,
    );
    await assertTapTarget(
      page
        .locator(".site-header")
        .getByRole("link", { name: "我的账号", exact: true }),
      viewport.width,
    );
    await expect(page.locator("#home-password")).toBeVisible();
    await assertHorizontalBounds(page);
  }
});

test("user profile is keyboard accessible outside the scrolling list", async ({
  page,
}) => {
  await page.goto("/#square");
  const author = page.locator(".activity-rows-author .user-identity").first();
  await author.focus();
  await page.keyboard.press("Tab");
  const profile = page.getByRole("dialog", { name: "用户资料" });
  await expect(profile.getByRole("button", { name: "关闭资料" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    profile.getByRole("link", { name: "查看 Linux DO 主页" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  await expect(author).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    profile.getByRole("link", { name: "查看 Linux DO 主页" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
});
