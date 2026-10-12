import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const test = base.extend<{ localOnly: undefined }>({
  localOnly: [
    async ({ context }, use) => {
      const forbidden: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || /^\/api(?:\/|$)/u.test(url.pathname)) {
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

const current = (page: Page) => page.locator('[data-route-presence="present"]');
async function freeze(page: Page, hash = "home") {
  await page.clock.install({ time: new Date("2026-10-07T04:00:00Z") });
  await page.goto(`/#${hash}`);
  await expect(current(page)).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1_000));
}
async function submit(page: Page, password: string) {
  await current(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill(password);
  await current(page)
    .getByRole("button", { name: "兑奖", exact: true })
    .click();
}
async function lookup(page: Page, value: string) {
  await current(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill(value);
  await current(page)
    .getByRole("button", { name: "跳转活动", exact: true })
    .click();
}
async function expectLocatorMode(page: Page, value: string) {
  await current(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill(value);
  await expect(
    current(page).getByRole("button", { name: "跳转活动", exact: true }),
  ).toBeVisible();
  await expect(
    current(page).getByRole("button", { name: "兑奖", exact: true }),
  ).toHaveCount(0);
  await expect(current(page).locator(".pw-input__hint")).toHaveCount(0);
  await expect(current(page).locator(".pw-input__count")).toHaveCount(0);
  await expect(
    current(page).getByRole("button", { name: "一键优化" }),
  ).toHaveCount(0);
}
async function scenario(page: Page, value: string) {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption(value);
  await page.getByRole("button", { name: "场景与身份" }).click();
}

for (const width of [1440, 375]) {
  test(`multiple matches close before navigation and redeem once on destination at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await freeze(page);
    await submit(page, "公共口令2026");
    const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(Math.min(640, width - 24));
    await dialog
      .getByRole("button", { name: "周末红包 · 20 份", exact: true })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page).toHaveURL(/sample=weekend$/u);
    await expect(
      current(page).getByRole("button", { name: "正在确认…", exact: true }),
    ).toBeDisabled();
    await expect(current(page).locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "none",
    );
    const envelope = current(page).getByTestId("envelope");
    expect(
      await envelope.evaluate((node) => node.getBoundingClientRect().height),
    ).toBe(340);
    await page.clock.runFor(320);
    await expect(envelope).toHaveAttribute("data-phase", "closed");
    await page.clock.runFor(280);
    await expect(current(page).locator(".activity-page")).toHaveAttribute(
      "data-participation",
      "claimed",
    );
    // Confirmation arrived after the shared move: do not wait another 300ms.
    await expect(envelope).toHaveAttribute("data-phase", "opening");
    await expect(envelope).toHaveAttribute("data-opening-count", "1");
    await page.clock.runFor(850);
    await expect(envelope).toHaveAttribute("data-phase", "open");
    await expect(current(page).locator(".slip-amount")).toHaveText("+0.88");
    await expect(current(page).locator(".activity-quantity")).toContainText(
      "已领取 9 / 20 份",
    );
    await expect(
      current(page).getByRole("button", { name: "奖励份数" }),
    ).toHaveCount(0);
    await current(page)
      .getByRole("button", { name: "返回兑奖", exact: true })
      .click();
    await page.clock.runFor(320);
    await submit(page, "周末口令2026");
    await page.clock.runFor(1200);
    await expect(current(page).locator(".activity-quantity")).toContainText(
      "已领取 9 / 20 份",
    );
    await current(page)
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    await expect(
      page.locator('.public-roster .recipient[data-username="linjian"]'),
    ).toHaveCount(1);
    await expect(page.locator(".public-roster .recipient")).toHaveCount(9);
  });
}

test("lookup handles empty, missing, UUID, link and forum choices without redeeming", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freeze(page);
  await expect(current(page).getByRole("button", { name: "兑奖" })).toHaveCount(
    0,
  );
  await expect(
    current(page).getByRole("button", { name: "跳转活动" }),
  ).toHaveCount(0);
  await expect(current(page).locator(".pw-input__hint")).toHaveCount(0);
  await expect(current(page).locator(".pw-input__count")).toHaveCount(0);
  await current(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill("abc123");
  await expect(
    current(page).getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await expect(current(page).locator(".pw-input__hint")).toHaveCount(0);
  await current(page)
    .getByRole("textbox", { name: "口令", exact: true })
    .fill("abc!");
  await expect(current(page).locator(".pw-input__hint")).toContainText("6–18");
  await expect(current(page).locator(".pw-input__count")).toHaveText("4 / 18");
  await expect(current(page).locator("#home-password-error")).toContainText(
    "有 1 个不可用字符",
  );
  await expect(
    current(page).getByRole("button", { name: "一键优化", exact: true }),
  ).toBeVisible();
  await expectLocatorMode(page, "https://linux.do/t/topic/999999999/1");
  await current(page)
    .getByRole("button", { name: "跳转活动", exact: true })
    .click();
  await expect(page.locator(".form-message")).toContainText("未匹配到活动。");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await lookup(page, "https://linux.do/t/topic/2964597/1216");
  const dialog = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".activity-selection-list > li")).toHaveCount(2);
  await dialog.press("Escape");
  await expect(
    current(page).getByRole("button", { name: "跳转活动", exact: true }),
  ).toBeFocused();
  await current(page).locator("#home-password").fill("图书口令2026");
  await expect(
    current(page).getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await lookup(page, "https://linux.do/t/topic/2964597/1216");
  await dialog
    .getByRole("button", { name: "电子书阅读红包", exact: true })
    .click();
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await page.clock.runFor(1500);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await expect(current(page).locator("#activity-password")).toHaveValue("");
  for (const value of [
    "20000000-0000-4000-8000-000000000005",
    `${origin}/#activity?sample=weekend`,
  ]) {
    await current(page)
      .getByRole("button", { name: "返回兑奖", exact: true })
      .click();
    await lookup(page, value);
    await expect(current(page).locator(".activity-page")).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
  }
});

test("selecting a draw match registers once and keeps the envelope closed", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freeze(page);
  await submit(page, "开奖口令2026");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "十分钟限时开奖", exact: true })
    .click();
  await expect(
    current(page).getByRole("button", { name: "正在确认…", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(600);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "registered",
  );
  await expect(current(page).getByTestId("envelope")).toHaveAttribute(
    "data-phase",
    "closed",
  );
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await submit(page, "限时口令2026");
  await page.clock.runFor(700);
  await current(page)
    .getByRole("button", { name: "查看报名名单", exact: true })
    .click();
  await expect(
    page.locator('.public-roster .recipient[data-username="linjian"]'),
  ).toHaveCount(1);
});

test("automatic confirmation failures retry on detail and leaving cancels a slow attempt", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freeze(page, "activity?sample=weekend");
  await scenario(page, "failure");
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await submit(page, "周末口令2026");
  await page.clock.runFor(600);
  await expect(current(page).locator(".form-message")).toContainText(
    "结果暂未确认",
  );
  await expect(page).toHaveURL(/sample=weekend$/u);
  await current(page)
    .getByRole("button", { name: "再次确认", exact: true })
    .click();
  await page.clock.runFor(600);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "claimed",
  );

  await scenario(page, "slow");
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await submit(page, "周末口令2026");
  await expect(
    current(page).getByRole("button", { name: "正在确认…", exact: true }),
  ).toBeVisible();
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await page.clock.runFor(4000);
  await lookup(page, `${origin}/#activity?sample=weekend`);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
});

test("multi-match modal paginates internally, traps focus and fits enlarged mobile text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freeze(page);
  const appModule = await (await page.request.get("/app.tsx")).text();
  const storeUrl = appModule.match(
    /from "([^"]*\/pages\/workbench-store\.ts[^"]*)"/u,
  )?.[1];
  if (!storeUrl) throw new Error("Loaded workbench store is missing");
  const ids = await page.evaluate(async (moduleUrl) => {
    const store = await import(moduleUrl);
    return Array.from({ length: 21 }, (_, index) => {
      const config = store.defaultActivityConfig("standard");
      config.title = `分页活动 ${index + 1} · 较长名称测试`;
      config.rewardKind = "ldc";
      config.fixed = { amount: "0.50", count: "1" };
      config.passwords = [{ id: 1, value: "分页匹配口令" }];
      if (index === 0) config.topic = "https://linux.do/t/topic/12345/7";
      const saved = store.saveWorkbenchActivity("standard", config, "active");
      if (!saved) throw new Error("Local fixture was not saved");
      return saved.id;
    });
  }, storeUrl);
  await submit(page, "分页匹配口令");
  const dialog = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(dialog.locator(".activity-selection-list > li")).toHaveCount(20);
  const next = dialog.getByRole("button", { name: "下一页", exact: true });
  await expect(next).toBeEnabled();
  await dialog.locator(".activity-selection-list").evaluate((node) => {
    node.scrollTop = 200;
  });
  await next.click();
  expect(
    await dialog
      .locator(".activity-selection-list")
      .evaluate((node) => node.scrollTop),
  ).toBe(0);
  await expect(dialog.getByText("第 2 页", { exact: true })).toBeVisible();
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await dialog.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(700 * 0.85);
  await dialog.getByRole("button", { name: "关闭选择活动" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((node) => node.contains(document.activeElement)),
  ).toBe(true);
  await dialog.press("Escape");
  await expect(
    current(page).getByRole("button", { name: "兑奖", exact: true }),
  ).toBeFocused();
  await expect(current(page).locator("#home-password")).toHaveValue(
    "分页匹配口令",
  );
  await expect(page).toHaveURL(/#home$/u);
  await lookup(page, ids[0]);
  await expect(current(page).locator(".activity-page h1")).toHaveText(
    "分页活动 1 · 较长名称测试",
  );
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await lookup(page, "https://linux.do/t/topic/12345/7");
  await expect(current(page).locator(".activity-page h1")).toHaveText(
    "分页活动 1 · 较长名称测试",
  );
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await expectLocatorMode(page, `${origin}/activities/${ids[0]}`);
  await current(page)
    .getByRole("button", { name: "跳转活动", exact: true })
    .click();
  await expect(current(page).locator(".activity-page h1")).toHaveText(
    "分页活动 1 · 较长名称测试",
  );
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  const emojiCode = await page.evaluate(async (activityId) => {
    const links = await import(
      "/@fs/Users/lafish/Documents/ChatGPT/hb/apps/web/src/lib/emoji-links.ts"
    );
    return links.encodeActivityEmoji(activityId);
  }, ids[0]);
  await expectLocatorMode(page, emojiCode);
  await current(page)
    .getByRole("button", { name: "跳转活动", exact: true })
    .click();
  await expect(current(page).locator(".activity-page h1")).toHaveText(
    "分页活动 1 · 较长名称测试",
  );
});

test("changing identity cancels automatic confirmation and restricted targets stay unclaimed", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await freeze(page, "activity?sample=weekend");
  await scenario(page, "slow");
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await submit(page, "周末口令2026");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "体验身份", exact: true })
    .selectOption("lite");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.clock.runFor(4000);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await expect(current(page).locator(".slip-amount")).toHaveCount(0);
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await submit(page, "公共口令2026");
  await expect(current(page).locator(".form-message")).toContainText(
    "官方 Connect 升级",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await lookup(page, `${origin}/#activity?sample=weekend`);
  await expect(
    current(page).getByRole("button", {
      name: "使用官方 Connect",
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.runFor(4000);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await current(page)
    .getByRole("button", { name: "返回兑奖", exact: true })
    .click();
  await lookup(page, `${origin}/#activity?sample=thanks`);
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-lifecycle",
    "ended",
  );
  await expect(current(page).locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
});
