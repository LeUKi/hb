import { mkdir } from "node:fs/promises";
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

async function scenario(page: Page, value: string) {
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "活动状态", exact: true })
    .selectOption(value);
  await page.getByRole("button", { name: "场景与身份" }).click();
}

test("known passwords start visible and explicit hiding survives new solves and clock updates", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#activity?sample=history-random-active");
  const known = page
    .locator('.password-section [data-password-state="known"]')
    .first();
  await expect(known.locator(".pw-reveal__value--hidden")).toHaveCount(0);
  await expect(known).toContainText("已用此口令兑换");
  await known.getByRole("button", { name: "隐藏内容" }).click();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(4000);
  await expect(known.locator(".pw-reveal__value--hidden")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "验证其他口令", exact: true })
    .fill("活动口令02");
  await page.getByRole("button", { name: "验证口令", exact: true }).click();
  await expect(
    page.locator('.password-section [data-password-state="known"]'),
  ).toHaveCount(2);
  await expect(known.locator(".pw-reveal__value--hidden")).toHaveCount(1);
  await expect(
    page
      .locator('.password-section [data-password-state="known"]')
      .last()
      .locator(".pw-reveal__value--hidden"),
  ).toHaveCount(0);
});

test("completed nonparticipants see a neutral open paper and public roster entry", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=thanks");
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.locator(".reward-slip")).toContainText("错过了");
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-opening-count",
    "0",
  );
  await expect(page.locator(".recipients-section")).toHaveCount(0);
  await page.getByRole("button", { name: "查看领取名单", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("十月第一期红包");
  await expect(dialog.getByRole("button", { name: "下一页" })).toHaveCount(0);
  await dialog.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看领取名单", exact: true }),
  ).toBeFocused();
});

test("draw pending and losing results use different envelope facts", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#activity?sample=evening");
  await scenario(page, "drawing");
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator(".claim-copy")).toContainText("正在开奖");
  await scenario(page, "not-won");
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "true",
  );
  await expect(page.locator(".reward-slip")).toContainText("未中奖");
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-opening-count",
    "0",
  );
});

for (const width of [1920, 1440, 768, 375]) {
  test(`revised history, paper and roster fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mkdir(".wrangler/verification/prototype", { recursive: true });
    for (const [name, hash] of [
      ["participations", "participations"],
      ["manage", "manage"],
      ["result", "activity?sample=history-random-active"],
    ]) {
      await page.goto(`/#${hash}`);
      await expect(page.locator("#main")).not.toContainText("正在加载页面");
      if (name === "manage")
        await expect(
          page.getByRole("button", { name: "编辑草稿" }).first(),
        ).toBeVisible();
      if (name === "result")
        await expect(
          page.locator('[data-note-region="after"] .activity-note'),
        ).toHaveText(
          historySamples.find(
            (activity) => activity.id === "history-random-active",
          )?.afterClaimInfo ?? "",
          { useInnerText: true },
        );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      if (width === 1440 || width === 375)
        await page.screenshot({
          path: `.wrangler/verification/prototype/history-paper-${name}-${width}.png`,
        });
    }
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(
      await page
        .getByRole("dialog")
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(Math.min(440, width - 24));
    if (width === 1440 || width === 375)
      await page.screenshot({
        path: `.wrangler/verification/prototype/history-paper-roster-${width}.png`,
      });
  });
}

test("new random claims stay newest, deduplicated and consistent across fixture and viewer changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.goto("/#activity?sample=random");
  await expect(page.locator(".activity-quantity")).toContainText(
    "已领取 19 / 30 份",
  );
  await page
    .getByRole("textbox", { name: "兑换口令", exact: true })
    .fill("随机口令2026");
  await page.getByRole("button", { name: "领取红包", exact: true }).click();
  await expect(page.locator(".slip-amount")).toHaveText("+0.98");
  await expect(page.locator(".activity-quantity")).toContainText(
    "已领取 20 / 30 份",
  );
  const readConfirmation = async () => {
    await page.getByRole("button", { name: "已发放说明", exact: true }).click();
    const help = page.locator(".context-help-popover");
    await expect(help).toBeVisible();
    const time = await help.locator("time").getAttribute("datetime");
    await page.keyboard.press("Escape");
    return time;
  };
  const originalConfirmation = await readConfirmation();
  const openRoster = async () => {
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const dialog = page.locator(".public-roster-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".recipient")).toHaveCount(20);
    await expect(dialog.locator(".recipient").first()).toHaveAttribute(
      "data-username",
      "linjian",
    );
    await expect(
      dialog.locator('.recipient[data-username="linjian"]'),
    ).toHaveCount(1);
    return dialog;
  };
  let dialog = await openRoster();
  const own = dialog.locator('.recipient[data-username="linjian"]');
  const recordedTime = await own
    .locator(".recipient-time__absolute")
    .getAttribute("datetime");
  await expect(own).toContainText("0.98");
  await dialog.getByRole("button", { name: "关闭名单", exact: true }).click();
  await page.getByRole("button", { name: "场景与身份" }).click();
  await page
    .getByRole("combobox", { name: "拼手气称号样例", exact: true })
    .selectOption("tie-two");
  await page.getByRole("button", { name: "场景与身份" }).click();
  await expect(page.locator(".slip-amount")).toHaveText("+0.20");
  dialog = await openRoster();
  await expect(own).toContainText("0.20");
  const publicRows = await dialog.locator(".recipient").evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute("data-record-id"),
      username: row.getAttribute("data-username"),
      time: row
        .querySelector(".recipient-time__absolute")
        ?.getAttribute("datetime"),
      amount: row.querySelector(".recipient-award strong")?.textContent,
    })),
  );
  await expect(own.locator(".recipient-time__absolute")).toHaveAttribute(
    "datetime",
    recordedTime ?? "",
  );
  await dialog.getByRole("button", { name: "关闭名单", exact: true }).click();
  for (const identity of ["guest", "standard"]) {
    await page.getByRole("button", { name: "场景与身份" }).click();
    await page
      .getByRole("combobox", { name: "体验身份", exact: true })
      .selectOption(identity);
    await expect(
      page.getByRole("combobox", { name: "拼手气称号样例", exact: true }),
    ).toHaveValue("tie-two");
    await page.getByRole("button", { name: "场景与身份" }).click();
    if (identity === "guest") {
      await expect(page.locator(".slip-amount")).toHaveCount(0);
      await expect(
        page.getByText("已用此口令兑换", { exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(page.locator(".slip-amount")).toHaveText("+0.20");
      expect(await readConfirmation()).toBe(originalConfirmation);
      await expect(
        page.locator('.password-section [data-password-state="known"]').first(),
      ).toContainText("随机口令2026");
      await expect(
        page.getByRole("textbox", { name: "兑换口令", exact: true }),
      ).toHaveCount(0);
    }
    dialog = await openRoster();
    expect(
      await dialog.locator(".recipient").evaluateAll((rows) =>
        rows.map((row) => ({
          id: row.getAttribute("data-record-id"),
          username: row.getAttribute("data-username"),
          time: row
            .querySelector(".recipient-time__absolute")
            ?.getAttribute("datetime"),
          amount: row.querySelector(".recipient-award strong")?.textContent,
        })),
      ),
    ).toEqual(publicRows);
    await dialog.getByRole("button", { name: "关闭名单", exact: true }).click();
  }
});

test("a published archived draw retains its lifecycle in history and detail", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#participations");
  const row = page.locator('[data-activity-id="history-draw-archived"]');
  await expect(row).toHaveAttribute("data-lifecycle", "archived");
  await row
    .getByRole("button", { name: "八月限时开奖 · 已归档", exact: true })
    .click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-lifecycle",
    "archived",
  );
  await expect(page.locator(".slip-amount")).toHaveText("+2.18");
});
