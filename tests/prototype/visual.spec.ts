import { test as base, expect, type Page } from "@playwright/test";
import { activities } from "../../apps/web/prototype/fixtures";
import type { Activity } from "../../apps/web/prototype/types";
import { projectActivityViewState } from "../../apps/web/prototype/view-state";

const origin = "http://127.0.0.1:4177";
const firstPassword = "公共口令2026";
const secondPassword = "开奖口令2026";
const uniquePassword = "周末口令2026";
const firstTitle = "周末红包 · 20 份";

function currentRoute(page: Page) {
  return page.locator('.route-frame[data-route-presence="present"]');
}

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
        "Prototype must not request any API or external service",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

async function openControls(page: Page) {
  const button = page.getByRole("button", { name: "场景与身份" });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  return page.getByRole("complementary", { name: "原型场景" });
}

async function scenario(page: Page, value: string) {
  const controls = await openControls(page);
  await controls.getByLabel("活动状态").selectOption(value);
  await expect(currentRoute(page).getByTestId("envelope")).toBeVisible();
}

async function openRoster(page: Page) {
  const controls = page.getByRole("button", {
    name: "场景与身份",
    exact: true,
  });
  if ((await controls.getAttribute("aria-expanded")) === "true")
    await controls.click();
  await currentRoute(page)
    .getByRole("button", { name: /^查看(领取|报名|中奖)名单$/u })
    .click();
  const dialog = page.locator(".public-roster-dialog[open]");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { prototypeCopies: string[] };
    state.prototypeCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          state.prototypeCopies.push(text);
        },
      },
    });
  });
}

test("preserves mixed raw input and pasted newlines while marking invalid characters", async ({
  page,
}) => {
  await page.goto("/#activity");
  const input = page.getByLabel("兑换口令", { exact: true });
  const raw = "　口令Ａｂ１２!\n好🙂";
  await input.fill(raw);
  await input.blur();
  await expect(input).toHaveValue(raw);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".pw-input__invalid")).toHaveCount(8);
  await expect(page.locator(".pw-input__line-break")).toHaveCount(1);
  await expect(page.locator("#activity-password-error")).toContainText(
    "有 8 个不可用字符",
  );
  await page.getByRole("button", { name: /领取红包|领取奖励/u }).click();
  await expect(input).toHaveValue(raw);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator("[data-redemption-action]")).toHaveAttribute(
    "title",
    /请先检查口令/,
  );
});

test("explicit optimization converts fullwidth ASCII before removing invalid characters", async ({
  page,
}) => {
  await page.goto("/#activity");
  const input = page.getByLabel("兑换口令", { exact: true });
  await input.fill("　口令Ａｂ１２!\n好🙂");
  await page.getByRole("button", { name: "一键优化", exact: true }).click();
  await expect(input).toHaveValue("口令Ab12好");
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(input).toBeFocused();
  await expect(page.locator(".pw-input__invalid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "一键优化" })).toHaveCount(0);
});

test("validates the six and eighteen character boundaries without truncating input", async ({
  page,
}) => {
  await page.goto("/#activity");
  const input = page.getByLabel("兑换口令", { exact: true });
  for (const [value, invalid] of [
    ["abcde", "true"],
    ["abc123", "false"],
    ["a".repeat(18), "false"],
    ["a".repeat(19), "true"],
  ]) {
    await input.fill(value);
    await expect(input).toHaveValue(value);
    await expect(input).toHaveAttribute("aria-invalid", invalid);
  }
  await expect(page.locator("#activity-password-error")).toContainText(
    "当前有 19 个字符",
  );
  await input.fill("Ａ! ");
  await page.getByRole("button", { name: "一键优化" }).click();
  await expect(input).toHaveValue("A");
  await expect(page.locator("#activity-password-error")).toContainText(
    "还需 5 个字符",
  );
});

test("does not validate, optimize, or submit during IME composition", async ({
  page,
}) => {
  await page.goto("/#activity");
  const input = page.getByLabel("兑换口令", { exact: true });
  await input.dispatchEvent("compositionstart", { data: "Ａ" });
  await input.fill("口令Ａbc1");
  await expect(input).toHaveValue("口令Ａbc1");
  await expect(input).toHaveAttribute("aria-invalid", "false");
  await expect(page.getByRole("button", { name: "一键优化" })).toBeDisabled();
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  await expect(page.locator(".form-message")).toHaveCount(0);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await input.dispatchEvent("compositionend", { data: "Ａ" });
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "一键优化" })).toBeEnabled();
  await expect(page.locator("#activity-password-error")).toContainText(
    "有 1 个不可用字符",
  );
});

test("authorized passwords start visible, hide independently, and identities support focus and click", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "multiple");
  const list = page.locator("main .password-list");
  const rows = list.locator(".pw-reveal");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.locator(".pw-reveal__value")).toHaveAttribute(
      "aria-hidden",
      "false",
    );
    await expect(row.locator(".pw-reveal__value")).toHaveCSS("filter", "none");
  }
  const visibleSnapshot = await list.ariaSnapshot();
  expect(visibleSnapshot).toContain(firstPassword);
  expect(visibleSnapshot).toContain(secondPassword);
  await rows.nth(0).getByRole("button", { name: "隐藏内容" }).click();
  await expect(rows.nth(0).locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(rows.nth(1).locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  expect(await list.ariaSnapshot()).not.toContain(firstPassword);
  expect(await list.ariaSnapshot()).toContain(secondPassword);
  await rows.nth(0).getByRole("button", { name: "显示内容" }).click();
  await expect(rows.nth(0).locator(".pw-reveal__value")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await page.getByRole("button", { name: "场景与身份" }).click();
  const author = page.locator(".activity-meta .user-identity");
  await author.scrollIntoViewIfNeeded();
  // Restore keyboard modality after the preceding pointer interactions.
  await page.keyboard.press("Tab");
  await author.focus();
  const profile = page.getByRole("dialog", { name: "用户资料" });
  await expect(profile).toBeVisible();
  await author.click();
  await expect(profile).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
});

test("readonly passwords have no copy action and do not write the clipboard", async ({
  page,
}) => {
  await captureClipboard(page);
  await page.goto("/#activity");
  await scenario(page, "multiple");
  await expect(
    page.locator(".password-list").getByRole("button", { name: /复制/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "prototypeCopies")),
  ).toEqual([]);
});

test("a new confirmed claim opens automatically once and history does not replay", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "ready");
  const envelope = currentRoute(page).getByTestId("envelope");
  await page.getByLabel("兑换口令", { exact: true }).fill(uniquePassword);
  await page.getByRole("button", { name: /领取红包|领取奖励/u }).click();
  await expect(page.getByRole("button", { name: "正在确认…" })).toBeDisabled();
  await expect(envelope).toHaveAttribute("data-open", "false");
  await expect(envelope).toHaveAttribute("data-open", "true");
  await expect(envelope).toHaveAttribute("data-animate", "true");
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(1);
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCSS("opacity", "1");
  await expect(envelope).toHaveAttribute("data-phase", "open");
  await expect(envelope).toHaveAttribute("data-opening-count", "1");
  const roster = await openRoster(page);
  await expect(roster.locator(".recipient")).toHaveCount(9);
  await expect(
    roster.locator('.recipient[data-username="linjian"]'),
  ).toHaveCount(1);
  await expect(roster.getByRole("status")).toHaveText("已显示全部");
  await expect(
    roster.getByRole("navigation", { name: "公开名单分页" }),
  ).toHaveCount(0);
  await roster.press("Escape");
  await page.evaluate(() => {
    Reflect.set(
      window,
      "prototypeSlip",
      document.querySelector(
        ".envelope-svg :is(.claimed-result, .ended-stamp)",
      ),
    );
  });
  await openControls(page);
  await page.getByLabel("展示领取名单", { exact: true }).uncheck();
  expect(
    await page.evaluate(
      () =>
        Reflect.get(window, "prototypeSlip") ===
        document.querySelector(
          ".envelope-svg :is(.claimed-result, .ended-stamp)",
        ),
    ),
  ).toBe(true);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("link", { name: "活动历史" })
    .click();
  await expect(page.locator("main .activity-rows-row")).toHaveCount(20);
  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  await expect(envelope).toHaveAttribute("data-open", "true");
  await expect(envelope).toHaveAttribute("data-animate", "false");
  await expect(envelope).toHaveAttribute("data-opening-count", "0");
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(1);
});

for (const [value, statusCopy, publicRecipients] of [
  ["registered", "报名已确认，等待开奖。", 20],
  ["drawing", "报名已截止，正在开奖。", 20],
  ["not-won", "未中奖", 3],
] as const) {
  test(`${value} preserves personal participation and public-result visibility`, async ({
    page,
  }) => {
    await page.goto("/#activity");
    await scenario(page, value);
    await expect(page.locator(".activity-page")).toHaveAttribute(
      "data-participation",
      value,
    );
    if (value === "not-won")
      await expect(
        page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
      ).toContainText(statusCopy);
    else
      await expect(currentRoute(page).locator(".claim-copy")).toContainText(
        statusCopy,
      );
    await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
      "data-open",
      String(value === "not-won"),
    );
    await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
      "data-animate",
      "false",
    );
    await expect(
      page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
    ).toHaveCount(value === "not-won" ? 1 : 0);
    await expect(page.locator(".envelope-svg .prize")).toHaveCount(0);
    await expect(page.locator(".payout-summary")).toHaveCount(0);
    const roster = await openRoster(page);
    await expect(roster.locator(".recipient")).toHaveCount(publicRecipients);
    if (value !== "not-won") {
      await expect(
        roster.locator(".recipient-award, .recipient-title"),
      ).toHaveCount(0);
      await roster.getByRole("tab", { name: "中奖名单", exact: true }).click();
      await expect(roster.locator(".recipient")).toHaveCount(0);
      await expect(roster.getByRole("status")).toHaveText(
        value === "drawing" ? "正在开奖" : "等待开奖",
      );
    } else {
      await expect(
        roster.locator('.recipient[data-username="linjian"]'),
      ).toHaveCount(0);
    }
  });
}

test("published winnings and pending payment remain distinct from animation and settlement", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "won");
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "won",
  );
  await expect(page.locator(".activity-meta")).toContainText("开奖结果已公布");
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-animate",
    "false",
  );
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+2.18 LDC");
  await page.getByRole("button", { name: "已发放说明", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "已发放说明", exact: true }),
  ).toContainText("确认时间");
  await page.keyboard.press("Escape");
  await scenario(page, "pending");
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-animate",
    "false",
  );
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-payment-progress",
    "pending",
  );
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.88 LDC");
  await expect(page.locator(".payment-confirmation")).toHaveCount(0);
  await expect(page.locator(".payout-summary")).toHaveCount(0);
  await expect(
    page.locator('[data-note-region="after"] .activity-note'),
  ).toHaveText(activities[0]?.afterClaimInfo ?? "", { useInnerText: true });
});

test("a lite identity can browse but must upgrade before creating or participating", async ({
  page,
}) => {
  await page.goto("/#activity");
  const controls = await openControls(page);
  await controls.getByLabel("体验身份").selectOption("lite");
  await controls.getByLabel("活动状态").selectOption("ready");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(
    page.getByRole("button", { name: "使用官方 Connect", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveCount(0);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await page.getByRole("link", { name: "发起活动", exact: true }).click();
  await expect(page.locator("#work-title")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "保存并开放", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "使用官方 Connect", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("link", { name: "兑奖", exact: true })
    .click();
  await page.getByLabel("口令", { exact: true }).fill(firstPassword);
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  await expect(page.locator("[data-redemption-action]")).toHaveAttribute(
    "title",
    /官方 Connect 升级/,
  );
  await expect(
    page.getByRole("dialog", { name: "选择要兑奖的活动" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "使用官方 Connect", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "通过官方 Connect 升级" }),
  ).toBeVisible();
});

test("slow responses keep the envelope closed and prevent duplicate submissions", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "slow");
  const input = page.getByLabel("兑换口令", { exact: true });
  await input.fill(uniquePassword);
  await page.getByRole("button", { name: /领取红包|领取奖励/u }).click();
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue(uniquePassword);
  await expect(page.getByRole("button", { name: "正在确认…" })).toBeDisabled();
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator(".payout-summary")).toHaveCount(0);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
    { timeout: 6_000 },
  );
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(1);
});

test("an uncertain response preserves the original submission until explicit reconfirmation", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "failure");
  const input = page.getByLabel("兑换口令", { exact: true });
  await input.fill(uniquePassword);
  await page.getByRole("button", { name: /领取红包|领取奖励/u }).click();
  await expect(page.locator("[data-redemption-action]")).toHaveAttribute(
    "title",
    /结果暂未确认/,
  );
  await expect(input).toHaveValue(uniquePassword);
  await expect(input).toBeDisabled();
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /再次确认/ }).click();
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(1);
});

for (const viewport of [
  { width: 375, height: 812, navigation: "手机导航" },
  { width: 768, height: 1024, navigation: "手机导航" },
] as const) {
  test(`all prototype pages fit a ${viewport.width}px viewport without horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const name of [
      "home",
      "activity",
      "square",
      "participations",
      "create",
      "manage",
      "account",
      "merchant",
      "payment",
    ]) {
      await page.goto(`/#${name}`);
      if (name === "square")
        await expect(
          page.getByRole("dialog", { name: "活动广场", exact: true }),
        ).toBeVisible();
      else if (name === "home")
        await expect(
          currentRoute(page).getByRole("region", { name: "口令兑奖" }),
        ).toBeVisible();
      else await expect(currentRoute(page).locator("h1")).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: viewport.navigation }),
      ).toBeVisible();
      const width = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(width.content, `${name} horizontal overflow`).toBeLessThanOrEqual(
        width.viewport,
      );
      for (const field of await page.getByRole("textbox").all()) {
        if (!(await field.isVisible())) continue;
        const box = await field.boundingBox();
        expect(box, `${name} textbox must have layout bounds`).not.toBeNull();
        if (box) {
          expect(
            box.x,
            `${name} textbox starts inside viewport`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            box.x + box.width,
            `${name} textbox ends inside viewport`,
          ).toBeLessThanOrEqual(viewport.width + 1);
        }
      }
    }
  });
}

test("reduced motion reveals the confirmed result without the opening animation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 850 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity");
  await page.getByLabel("兑换口令", { exact: true }).fill(uniquePassword);
  await page.getByRole("button", { name: /领取红包|领取奖励/u }).click();
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-animate",
    "false",
  );
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCSS("opacity", "1");
  await expect(
    page.locator('[data-note-region="after"] .activity-note'),
  ).toHaveText(activities[0]?.afterClaimInfo ?? "", { useInnerText: true });
  const [envelopeBox, copyBox] = await Promise.all([
    page.locator(".claim-art .envelope").boundingBox(),
    page.locator(".claim-copy").boundingBox(),
  ]);
  expect(envelopeBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  if (envelopeBox && copyBox) {
    expect(
      envelopeBox.y + envelopeBox.height,
      "The opened mobile envelope must end before the result copy starts",
    ).toBeLessThanOrEqual(copyBox.y + 1);
  }
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
});

test("create defaults use 600 seconds and no registration limit while preserving per-plan inputs", async ({
  page,
}) => {
  await page.goto("/#create");
  const plans = page.getByRole("group", { name: "LDC 奖励方式", exact: true });
  await plans.getByRole("button", { name: "限时开奖", exact: true }).click();
  await expect(page.locator("#work-draw-seconds")).toHaveValue("600");
  await expect(page.locator("#work-draw-limit")).toHaveValue("");
  await page.locator("#work-draw-winners").fill("3");
  await expect(page.locator("#work-draw-limit")).toHaveValue("");
  await page.locator("#work-draw-seconds").fill("900");
  await page.locator("#work-draw-limit").fill("2");
  await page.locator("#work-draw-amount").fill("7.50");
  await plans.getByRole("button", { name: "固定均分", exact: true }).click();
  await page.locator("#work-fixed-amount").fill("1.23");
  await page.locator("#work-fixed-count").fill("7");
  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await page.locator("#work-random-amount").fill("33.33");
  await page.locator("#work-random-count").fill("4");
  await plans.getByRole("button", { name: "限时开奖", exact: true }).click();
  await expect(page.locator("#work-draw-seconds")).toHaveValue("900");
  await expect(page.locator("#work-draw-limit")).toHaveValue("2");
  await expect(page.locator("#work-draw-winners")).toHaveValue("3");
  await expect(page.locator("#work-draw-amount")).toHaveValue("7.50");
  await plans.getByRole("button", { name: "固定均分", exact: true }).click();
  await expect(page.locator("#work-fixed-amount")).toHaveValue("1.23");
  await expect(page.locator("#work-fixed-count")).toHaveValue("7");
  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await expect(page.locator("#work-random-amount")).toHaveValue("33.33");
  await expect(page.locator("#work-random-count")).toHaveValue("4");
  await plans.getByRole("button", { name: "自定义金额", exact: true }).click();
  await page.locator("#work-custom-amounts").fill("0.50\n0.88");
  await plans.getByRole("button", { name: "即时随机", exact: true }).click();
  await expect(page.locator("#work-random-amount")).toHaveValue("33.33");
  await plans.getByRole("button", { name: "自定义金额", exact: true }).click();
  await expect(page.locator("#work-custom-amounts")).toHaveValue("0.50\n0.88");
  await expect(
    page.getByRole("group", { name: "奖励类型", exact: true }),
  ).toHaveCount(0);
});

test("multiple matches preserve the password and require confirmation of the selected activity", async ({
  page,
}) => {
  await captureClipboard(page);
  await page.goto("/");
  await page.getByLabel("口令", { exact: true }).fill(firstPassword);
  await page.getByRole("button", { name: "兑奖", exact: true }).click();
  const matches = page.getByRole("dialog", { name: "选择要兑奖的活动" });
  await expect(matches.locator(".activity-selection-list > li")).toHaveCount(2);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await matches
    .getByRole("button", { name: "电子书阅读红包", exact: true })
    .click();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveValue(
    firstPassword,
  );
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "复制奖励", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-note-region="after"]')).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /领取红包|领取奖励/u, exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.50 LDC");
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "prototypeCopies")),
  ).toEqual([]);
});

test("Markdown notes preserve formatting and respect before, after, and ended visibility", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "long");
  await page.keyboard.press("Escape");
  const beforeRegion = page.locator('[data-note-region="before"]');
  const before = beforeRegion.locator(".activity-note");
  const after = page.locator('[data-note-region="after"] .activity-note');
  const ended = page.locator('[data-note-region="ended"] .activity-note');
  await expect(before).toBeVisible();
  await expect(before.locator("strong")).toHaveText("活动规则");
  await expect(before.locator("ul li")).toHaveCount(3);
  await expect(
    before.getByRole("link", { name: "关联论坛回复", exact: true }),
  ).toHaveAttribute("href", "https://linux.do/t/2964597/1216");
  await expect(after).toHaveCount(0);
  await expect(ended).toHaveCount(0);
  await page.getByLabel("兑换口令", { exact: true }).fill(uniquePassword);
  await page
    .getByRole("button", { name: /领取红包|领取奖励/u, exact: true })
    .click();
  await expect(after).toBeVisible();
  await expect(after).toHaveText(activities[0]?.afterClaimInfo ?? "", {
    useInnerText: true,
  });
  await expect(before).toHaveCount(0);
  await expect(beforeRegion).toHaveCount(1);
  await expect(beforeRegion.locator("summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await beforeRegion.locator("summary").click();
  await expect(before).toBeVisible();
  await expect(before.locator("strong")).toHaveText("活动规则");
  await expect(ended).toHaveCount(0);
  await scenario(page, "registered");
  await expect(after).toHaveCount(0);
  await expect(ended).toHaveCount(0);
  await scenario(page, "not-won");
  await expect(after).toHaveCount(0);
  await expect(ended).toBeVisible();
  await expect(ended).toContainText(
    activities[2]?.afterEndInfo?.split("\n\n")[0] ?? "",
  );
  await scenario(page, "ended");
  await page.keyboard.press("Escape");
  await expect(ended).toContainText(
    activities[3]?.afterEndInfo?.split("\n\n")[0] ?? "",
  );
  await expect(ended).toContainText("查看活动广场中的其他活动");
  await expect(
    ended.getByRole("link", { name: "查看活动广场", exact: true }),
  ).toHaveCount(0);
});

test("strict topic lookup returns shared cards and selects without automatically claiming", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("口令", { exact: true });
  await input.fill("https://example.com/t/2964597/1216");
  await expect(
    page.getByRole("button", { name: "兑奖", exact: true }),
  ).toBeVisible();
  await input.fill("https://linux.do/t/topic/999999999/1");
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  await expect(page.locator("[data-redemption-action]")).toHaveAttribute(
    "title",
    "未匹配到活动。",
  );
  await expect(page.locator(".activity-page")).toHaveCount(0);
  await input.fill("https://linux.do/t/topic/2964597/1216");
  await page.getByRole("button", { name: "跳转活动", exact: true }).click();
  const results = page.getByRole("dialog", { name: "选择活动", exact: true });
  await expect(results.locator(".activity-selection-list > li")).toHaveCount(2);
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await results
    .getByRole("button", { name: "电子书阅读红包", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "电子书阅读红包",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("兑换口令", { exact: true })).toHaveValue("");
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(
    page.locator(".envelope-svg :is(.claimed-result, .ended-stamp)"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "复制奖励", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-note-region="after"]')).toHaveCount(0);
});

test("pending payment survives activity changes and unrelated input is cleared", async ({
  page,
}) => {
  await page.goto("/#activity");
  await scenario(page, "pending");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-payment-progress",
    "pending",
  );
  await expect(page.locator(".payment-confirmation")).toHaveCount(0);
  await navigation.getByRole("link", { name: "兑奖", exact: true }).click();
  await page.getByRole("button", { name: "已公开的活动", exact: true }).click();
  await page
    .getByRole("button", { name: "电子书阅读红包", exact: true })
    .click();
  const input = page.getByLabel("兑换口令", { exact: true });
  await expect(input).toHaveValue("");
  await input.fill("私有Ab123");
  await navigation.getByRole("link", { name: "活动历史", exact: true }).click();
  await expect(page.locator("main .activity-rows-row")).toHaveCount(20);
  await expect(
    page
      .locator(".activity-rows-row")
      .filter({ hasText: firstTitle })
      .locator(".activity-rows-amount"),
  ).toContainText("0.88 LDC");
  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-animate",
    "false",
  );
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-payment-progress",
    "pending",
  );
  await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.88 LDC");
  await expect(page.locator(".payment-confirmation")).toHaveCount(0);
  await expect(page.locator(".payout-summary")).toHaveCount(0);
  await navigation.getByRole("link", { name: "兑奖", exact: true }).click();
  await page.getByRole("button", { name: "已公开的活动", exact: true }).click();
  await page
    .getByRole("button", { name: "电子书阅读红包", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
});

test("state projection keeps ended and archived claims independent of payment and draw axes", () => {
  const activity: Activity = {
    id: "projection",
    title: "状态投影",
    author: "演示作者",
    username: "demo",
    color: "sage",
    type: "ldc",
    description: "",
    amount: "0.88",
    count: 2,
    remaining: 0,
    passwords: [],
    ended: true,
  };
  for (const paymentProgress of [null, "pending"] as const) {
    expect(
      projectActivityViewState(activity, "claimed", { paymentProgress }),
    ).toEqual({
      lifecycle: "ended",
      participation: "claimed",
      drawProgress: null,
      paymentProgress,
    });
  }
  expect(
    projectActivityViewState({ ...activity, type: "draw" }, "not-won", {
      drawProgress: "completed",
    }),
  ).toEqual({
    lifecycle: "ended",
    participation: "not-won",
    drawProgress: "completed",
    paymentProgress: null,
  });
  expect(
    projectActivityViewState(activity, "claimed", {
      lifecycle: "archived",
      paymentProgress: "waiting",
    }),
  ).toEqual({
    lifecycle: "archived",
    participation: "claimed",
    drawProgress: null,
    paymentProgress: "waiting",
  });
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 375, height: 850 },
] as const) {
  test(`settled ${viewport.name} layouts retain accessible controls`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });

    await page.goto("/");
    await expect(
      currentRoute(page).getByRole("region", { name: "口令兑奖" }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);

    await page.goto("/#activity");
    await page.getByLabel("兑换口令", { exact: true }).fill(uniquePassword);
    await page
      .getByRole("button", { name: /领取红包|领取奖励/u, exact: true })
      .click();
    await expect(currentRoute(page).getByTestId("envelope")).toHaveAttribute(
      "data-open",
      "true",
    );
    const slip = page.locator(
      ".envelope-svg :is(.claimed-result, .ended-stamp)",
    );
    await expect(slip).toHaveCSS("opacity", "1");
    await expect(
      page.getByRole("button", { name: "已发放说明", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".envelope-svg .prize")).toHaveText("+0.88 LDC");
    await expect(
      page.locator('[data-note-region="after"] .activity-note'),
    ).toHaveText(activities[0]?.afterClaimInfo ?? "", { useInnerText: true });
    let previous: number[] | undefined;
    let stableSamples = 0;
    await expect
      .poll(
        async () => {
          const box = await slip.boundingBox();
          if (!box) return false;
          const geometry = [box.x, box.y, box.width, box.height];
          stableSamples = previous?.every(
            (value, index) => Math.abs(value - geometry[index]) < 0.1,
          )
            ? stableSamples + 1
            : 0;
          previous = geometry;
          return stableSamples >= 3;
        },
        {
          message: "The opened reward must retain stable geometry",
          intervals: [100],
        },
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "隐藏全部口令", exact: true })
      .click();
    for (const value of await page.locator("main .pw-reveal__value").all()) {
      await expect(value).toHaveAttribute("aria-hidden", "true");
      await expect(value).toHaveCSS("filter", "blur(5px)");
    }
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "用户资料" })).toHaveCount(0);
    await page
      .locator(".site-main")
      .evaluate((element) => element.scrollTo(0, 0));
    await currentRoute(page).locator("h1").click();
    await expect(page.locator(".skip-link")).not.toBeFocused();
    await expect(page.locator(".skip-link")).toHaveCSS("top", "-80px");
    await page.mouse.move(0, 0);

    await page.goto("/#create");
    const plans = page.getByRole("group", {
      name: "LDC 奖励方式",
      exact: true,
    });
    await plans.getByRole("button", { name: "限时开奖", exact: true }).click();
    await expect(page.locator("#work-draw-seconds")).toHaveValue("600");
    await expect(page.locator("#work-draw-limit")).toHaveValue("");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
  });
}
