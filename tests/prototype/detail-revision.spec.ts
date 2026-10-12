import { test as base, expect, type Page } from "@playwright/test";
import { activities, historySamples } from "../../apps/web/prototype/fixtures";

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

async function scenario(page: Page, value: string) {
  if (
    await page
      .getByRole("button", { name: "关闭名单", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "关闭名单", exact: true }).click();
  const toggle = page.getByRole("button", { name: "场景与身份" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await page
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption(value);
  await toggle.click();
}

test("ended passwords are initially visible and explicit hiding survives clock ticks", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#activity?sample=thanks");
  await expect(page.locator(".pw-reveal__value--hidden")).toHaveCount(0);
  await page.getByRole("button", { name: "隐藏全部口令" }).click();
  await expect(page.locator(".pw-reveal__value--hidden")).toHaveCount(2);
  await page.clock.fastForward(5000);
  await expect(page.locator(".pw-reveal__value--hidden")).toHaveCount(2);
  await page.getByRole("button", { name: "返回兑奖" }).click();
  await expect(page).toHaveURL(/#home$/u);
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
});

test("only a published activity author can copy selected invitation content", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=history-random-active");
  await expect(page.getByRole("button", { name: "复制活动链接" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "复制领取文案" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);
  await page.goto("/#activity?sample=20000000-0000-4000-8000-000000000005");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copied = text;
        },
      },
    });
  });
  await page.getByRole("button", { name: "复制领取文案" }).click();
  await page.getByRole("menuitem", { name: "不含口令", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "领取文案已复制" }),
  ).toBeVisible();
  const without = await page.locator("html").getAttribute("data-copied");
  const passwords = await page.locator(".pw-reveal__value").allTextContents();
  expect(without).toContain("#activity?sample=20000000");
  for (const password of passwords) expect(without).not.toContain(password);
  await page.getByRole("button", { name: "复制领取文案" }).click();
  await page.getByRole("menuitem", { name: "包含全部口令" }).click();
  const withPasswords = await page.locator("html").getAttribute("data-copied");
  for (const password of passwords) expect(withPasswords).toContain(password);
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.getByRole("combobox", { name: "体验身份" }).selectOption("guest");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(page.getByRole("button", { name: "复制领取文案" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "管理活动" })).toHaveCount(0);
});

for (const width of [1440, 375]) {
  test(`author management actions stay accessible with any title at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#activity?sample=20000000-0000-4000-8000-000000000001");
    const copy = page.getByRole("button", { name: "复制领取文案" });
    const manage = page.getByRole("button", { name: "管理活动" });
    const title = page.locator(".activity-title-row h1");
    const copyBox = await copy.boundingBox();
    const manageBox = await manage.boundingBox();
    expect(copyBox?.height).toBe(width === 375 ? 36 : 32);
    expect(manageBox?.y).toBe(copyBox?.y);
    expect(manageBox?.x).toBeGreaterThan(
      (copyBox?.x ?? 0) + (copyBox?.width ?? 0),
    );
    if (width === 375) {
      const titleBox = await title.boundingBox();
      expect(copyBox?.y).toBeGreaterThanOrEqual(
        (titleBox?.y ?? 0) + (titleBox?.height ?? 0),
      );
    }

    for (const value of ["短", "", "很长的活动名称".repeat(12)]) {
      await title.evaluate((element, value) => {
        element.textContent = value;
      }, value);
      await expect(copy).toBeVisible();
      await manage.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "编辑配置" }),
      ).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("menuitem", { name: "兑换尝试统计" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(manage).toBeFocused();
    }
    await page
      .locator(".activity-title-row h1, .activity-title-actions button")
      .evaluateAll((elements) => {
        for (const element of elements) {
          (element as HTMLElement).style.fontSize =
            `${Number.parseFloat(getComputedStyle(element).fontSize) * 2}px`;
        }
      });
    for (const control of [copy, manage]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    }
    await copy.click();
    await expect(
      page.getByRole("menu", { name: "复制领取文案" }),
    ).toBeVisible();
    await manage.click();
    await expect(page.getByRole("menu", { name: "复制领取文案" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("menu", { name: "管理活动" })).toBeVisible();
    await title.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  });
}

test("deadline stops admission without fabricating results, published empty states are final", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#activity?sample=evening");
  await page.getByRole("button", { name: "查看报名名单", exact: true }).click();
  await expect(page.getByRole("tab", { name: "报名名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".recipient-list .recipient")).toHaveCount(20);
  await expect(page.getByRole("button", { name: "加载更多" })).toBeEnabled();
  await page.getByRole("button", { name: "关闭名单", exact: true }).click();
  await page.clock.fastForward(601_000);
  await expect(page.locator(".activity-heading")).toContainText("正在开奖");
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-draw-progress",
    "settling",
  );
  await expect(page.locator("#activity-password")).toHaveCount(0);
  await expect(page.locator(".pw-locked")).toHaveCount(2);
  await page.getByRole("button", { name: "查看报名名单", exact: true }).click();
  await page.getByRole("tab", { name: "中奖名单" }).click();
  await expect(page.locator(".public-roster")).toContainText("正在开奖");
  await expect(page.locator(".public-roster")).not.toContainText("开奖后");
  await scenario(page, "draw-no-winners");
  await page.getByRole("button", { name: "查看中奖名单", exact: true }).click();
  await expect(page.getByRole("tab", { name: "中奖名单" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".public-roster")).toContainText("无人中奖");
  await page.getByRole("tab", { name: "报名名单" }).click();
  await expect(page.locator(".recipient-list .recipient")).toHaveCount(20);
  await scenario(page, "draw-empty");
  await page.getByRole("button", { name: "查看中奖名单", exact: true }).click();
  await page.getByRole("tab", { name: "中奖名单" }).click();
  await expect(page.locator(".public-roster")).toContainText("无人中奖");
  await page.getByRole("tab", { name: "报名名单" }).click();
  await expect(page.locator(".public-roster")).toContainText("无人报名");
  await expect(page.getByRole("button", { name: "加载更多" })).toHaveCount(0);
});

test("public winners survive viewer changes and registration remains separately accessible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=evening");
  await scenario(page, "won");
  await page.getByRole("button", { name: "查看中奖名单", exact: true }).click();
  const before = await page.locator(".recipient").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".user-identity")?.textContent,
      amount: row.querySelector(".recipient-award")?.textContent,
    })),
  );
  expect(before.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "关闭名单", exact: true }).click();
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page.getByRole("combobox", { name: "体验身份" }).selectOption("guest");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-draw-progress",
    "completed",
  );
  await page.getByRole("button", { name: "查看中奖名单", exact: true }).click();
  const after = await page.locator(".recipient").evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.querySelector(".user-identity")?.textContent,
      amount: row.querySelector(".recipient-award")?.textContent,
    })),
  );
  expect(after).toEqual(before);
  await page.getByRole("tab", { name: "报名名单" }).click();
  await expect(page.locator(".recipient-award")).toHaveCount(0);
  await expect(page.locator(".recipient")).toHaveCount(20);
});

test("square uses status-only filtering and clearing keeps drawings active", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=evening");
  await scenario(page, "drawing");
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await page.getByRole("button", { name: "已公开的活动", exact: true }).click();
  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "进行中" }).click();
  await expect(
    page.locator(".activity-rows-row").filter({ hasText: "十分钟限时开奖" }),
  ).toContainText("正在开奖");
  await page.getByRole("button", { name: "活动状态筛选" }).click();
  await page.getByRole("menuitemradio", { name: "已结束" }).click();
  await expect(
    page.locator('.activity-rows-row[data-lifecycle="active"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "清空状态筛选" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "奖励筛选" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清空状态筛选" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("navigation", { name: "活动广场分页" }),
  ).toContainText("第 1 页");
});

for (const width of [1920, 1440, 768, 375]) {
  test(`detail alignment, blur margins and shared artwork geometry at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#activity?sample=history-random-active");
    await expect(
      page.locator('[data-note-region="after"] .activity-note'),
    ).toHaveText(
      historySamples.find((activity) => activity.id === "history-random-active")
        ?.afterClaimInfo ?? "",
      { useInnerText: true },
    );
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? { left: r.left, width: r.width, height: r.height } : null;
      };
      return {
        header: rect(".activity-heading"),
        passwords: rect(".password-section"),
        roster: rect(".recipients-section"),
        art: rect(".envelope"),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.header?.left).toBe(geometry.passwords?.left);
    expect(geometry.header?.width).toBe(geometry.passwords?.width);
    expect(geometry.roster).toBeNull();
    expect(geometry.header?.width).toBeLessThanOrEqual(640);
    await expect(page.locator(".pw-reveal__body")).toHaveCSS(
      "overflow",
      "visible",
    );
    if (width === 1440 || width === 375) {
      await page.locator(".password-section").scrollIntoViewIfNeeded();
    }
    await page.getByRole("button", { name: "返回兑奖" }).click();
    const homeArt = await page.locator(".envelope").boundingBox();
    expect((homeArt?.width ?? 0) / (homeArt?.height ?? 1)).toBeCloseTo(
      (geometry.art?.width ?? 0) / (geometry.art?.height ?? 1),
      2,
    );
  });
}

for (const width of [1440, 375]) {
  test(`capture roster tabs and author/filter menus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.goto("/#activity?sample=evening");
    await expect(
      page.locator('[data-note-region="before"] .activity-note'),
    ).toContainText(activities[2]?.beforeInfo?.split("\n\n")[1] ?? "");
    await page
      .getByRole("button", { name: "查看报名名单", exact: true })
      .click();

    await scenario(page, "won");
    await expect(
      page.locator('[data-note-region="after"] .activity-note'),
    ).toHaveText(activities[2]?.afterClaimInfo ?? "", { useInnerText: true });
    await page
      .getByRole("button", { name: "查看中奖名单", exact: true })
      .click();

    await page.goto("/#square");
    await page.getByRole("button", { name: "活动状态筛选" }).click();
    await page.getByRole("menuitemradio", { name: "已结束" }).click();
    await page.getByRole("button", { name: "活动状态筛选" }).click();
    await expect(page.getByRole("menu")).toBeVisible();

    await page.getByRole("menu").press("Escape");
    await page.goto("/#activity?sample=20000000-0000-4000-8000-000000000005");
    await page.getByRole("button", { name: "复制领取文案" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
  });
}

test("participation history follows the cutoff without navigation or inventing results", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#participations");
  const row = page
    .locator(".activity-rows-row")
    .filter({ hasText: "晚间限时开奖 · 已报名" });
  await expect(row).toHaveAttribute("data-draw", "waiting");
  await page.clock.fastForward(601_000);
  await expect(row).toHaveAttribute("data-draw", "settling");
  await expect(row).toHaveAttribute("data-participation", "drawing");
  await expect(row).toContainText("正在开奖");
  await expect(row).not.toContainText("等待开奖");
  await expect(row).not.toContainText("已中奖");
});
