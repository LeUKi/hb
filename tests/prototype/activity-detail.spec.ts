import { mkdir } from "node:fs/promises";
import { test as base, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4177";
const presentRoute = '.route-frame[data-route-presence="present"]';
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
      expect(forbidden).toEqual([]);
    },
    { auto: true },
  ],
});

async function controls(page: Page) {
  const button = page.getByRole("button", { name: "场景与身份" });
  if ((await button.getAttribute("aria-expanded")) !== "true")
    await button.click();
  return button;
}

test("detail header separates type, configured pool and personal reward", async ({
  page,
}) => {
  for (const [id, mode, pool] of [
    ["weekend", "LDC · 固定均分", "17.60"],
    ["random", "LDC · 即时随机（拼手气）", "30.00"],
    ["evening", "LDC · 限时开奖", "20.00"],
    ["thanks", "LDC · 固定均分", "15.00"],
  ]) {
    await page.goto(`/#activity?sample=${id}`);
    const header = page.locator(`${presentRoute} .activity-heading`);
    await expect(header).toContainText(mode ?? "");
    await expect(header).toContainText(`总奖池 ${pool} LDC`);
    await expect(page.locator(".activity-page .breadcrumb")).toHaveCount(0);
  }
  await page.goto("/#activity?sample=history-random-active");
  await expect(page.locator(".activity-heading")).toContainText(
    "总奖池 30.00 LDC",
  );
  await expect(page.locator(".slip-amount")).toContainText("0.98");
  await page.goto("/#activity?sample=reading");
  await expect(page.locator(".activity-heading")).toContainText("文本 / CDK");
  await expect(page.locator(".activity-heading")).not.toContainText("总奖池");
});

test("fuzzy fixed quantities do not leak a calculable pool in the header", async ({
  page,
}) => {
  await page.goto("/#activity?sample=weekend");
  const toggle = await controls(page);
  await page.getByRole("checkbox", { name: "模糊数量" }).check();
  await toggle.click();
  const header = page.locator(".activity-meta");
  await expect(header).not.toContainText("总奖池");
  await expect(header).not.toContainText("共 20 份");
  await expect(header).toContainText("奖励充足");
});

test("unknown password rows appear before participation without answer text or reveal controls", async ({
  page,
}) => {
  await page.goto("/#activity?sample=weekend");
  const list = page.locator(".password-list");
  await expect(
    page.getByRole("heading", { name: "活动口令", exact: true }),
  ).toBeVisible();
  await expect(list.locator(".pw-locked")).toHaveCount(3);
  await expect(list.locator("button")).toHaveCount(0);
  await expect(page.locator(".solve-row")).toHaveCount(0);
  expect(await list.innerHTML()).not.toMatch(
    /公共口令2026|开奖口令2026|周末口令2026/u,
  );
  const before = await list.textContent();
  await page.getByRole("textbox", { name: "兑换口令" }).fill("公共口令2026");
  await page
    .locator(".claim-form")
    .getByRole("button", { name: "领取红包", exact: true })
    .click();
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "claimed",
  );
  await expect(list.locator(".pw-reveal")).toHaveCount(1);
  await expect(list.locator(".pw-locked")).toHaveCount(2);
  expect(before).not.toContain("公共口令2026");
  await expect(page.locator(".solve-row")).toBeVisible();
  await page.locator("#solve-password").fill("开奖口令2026");
  await page.getByRole("button", { name: "验证口令", exact: true }).click();
  await expect(list.locator(".pw-reveal")).toHaveCount(2);
  await expect(list.locator(".pw-locked")).toHaveCount(1);
  await expect(list).not.toContainText(/口令 [123]/u);
});

test("ended activities publish all passwords while active guests see only locked rows", async ({
  page,
}) => {
  await page.goto("/#activity?sample=thanks");
  await expect(page.locator(".password-list .pw-reveal")).toHaveCount(2);
  for (const value of await page.locator(".pw-reveal__value").all())
    await expect(value).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator(".password-list .pw-locked")).toHaveCount(0);
  await expect(page.locator(".activity-heading")).not.toContainText("距结束");
  await expect(page.locator(".activity-heading")).toContainText("已结束");
  await page.goto("/#activity?sample=weekend");
  const toggle = await controls(page);
  await page.getByRole("combobox", { name: "体验身份" }).selectOption("guest");
  await toggle.click();
  await expect(page.locator(".password-list .pw-locked")).toHaveCount(3);
  await expect(page.locator(".password-list .pw-reveal")).toHaveCount(0);
});

test("author records expose configured passwords and distinct assigned amounts", async ({
  page,
}) => {
  for (const [suffix, label, pool] of [
    ["005", "LDC · 即时随机（拼手气）", "20.00"],
    ["003", "LDC · 自定义金额", "25.80"],
  ]) {
    await page.goto(
      `/#activity?sample=20000000-0000-4000-8000-000000000${suffix}`,
    );
    await expect(page.locator(".activity-heading")).toContainText(label ?? "");
    await expect(page.locator(".activity-heading")).toContainText(
      `总奖池 ${pool} LDC`,
    );
    await expect(page.locator(".password-list .pw-reveal")).toHaveCount(1);
    await expect(page.locator(".password-list .pw-locked")).toHaveCount(0);
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const amounts = await page
      .locator(".recipient-award strong")
      .allTextContents();
    const sum = amounts.reduce(
      (total, value) => total + Math.round(Number.parseFloat(value) * 100),
      0,
    );
    expect(sum).toBeLessThanOrEqual(Math.round(Number(pool) * 100));
    expect(new Set(amounts).size).toBeGreaterThan(1);
  }
});

test("a guest can open another user's profile in the published roster", async ({
  page,
}) => {
  await page.goto("/#activity?sample=history-random-active");
  const toggle = await controls(page);
  await page.getByRole("combobox", { name: "体验身份" }).selectOption("guest");
  await toggle.click();
  await page.getByRole("button", { name: "查看领取名单", exact: true }).click();
  await page
    .locator(".recipient-list")
    .getByRole("button", { name: "林间", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "用户资料", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#activity\?sample=history-random-active$/u);
});

test("draw countdown does not restart on navigation or publish a result at zero", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T06:00:00Z") });
  await page.goto("/#activity?sample=evening");
  const timer = page.getByRole("timer", { name: "开奖倒计时" });
  await expect(timer).toContainText("00:10:00");
  const placeholders = await page.locator(".pw-locked").allTextContents();
  await page.clock.fastForward(3_000);
  await expect(timer).toContainText("00:09:57");
  expect(await page.locator(".pw-locked").allTextContents()).toEqual(
    placeholders,
  );
  await page
    .locator(".desktop-nav")
    .getByRole("link", { name: "活动广场", exact: true })
    .click();
  await page.evaluate(() => {
    location.hash = "activity?sample=evening";
  });
  await expect(timer).toContainText("00:09:57");
  expect(await page.locator(".pw-locked").allTextContents()).toEqual(
    placeholders,
  );
  await page.clock.fastForward(597_000);
  await expect(timer).toHaveCount(0);
  await expect(page.locator(".activity-heading")).toContainText("正在开奖");
  await expect(page.locator(".activity-status-copy")).toHaveText(
    "报名已截止，正在开奖。",
  );
  await expect(page.locator(".claim-form")).toHaveCount(0);
  await expect(page.locator(".password-list .pw-locked")).toHaveCount(2);
  await expect(page.locator(".password-list .pw-reveal")).toHaveCount(0);
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-draw-progress",
    "settling",
  );
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator(".reward-slip")).toHaveCount(0);
  await page.getByRole("button", { name: "查看报名名单", exact: true }).click();
  await expect(page.locator(".recipient")).toHaveCount(20);
  await expect(page.locator(".recipient-award, .recipient-title")).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: "中奖名单", exact: true }).click();
  await expect(page.locator(".recipient")).toHaveCount(0);
  await expect(page.locator(".public-roster")).toContainText("正在开奖");
  await expect(page.locator(".public-roster")).not.toContainText(
    /开奖后揭晓|开奖后公布中奖名单/u,
  );
});

test("a request crossing the deadline cannot acquire a reward", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-06T06:00:00Z") });
  await page.goto("/#activity?sample=weekend");
  await page.clock.fastForward(8_314_800);
  await page.getByRole("textbox", { name: "兑换口令" }).fill("公共口令2026");
  await page
    .locator(".claim-form")
    .getByRole("button", { name: "领取红包", exact: true })
    .click();
  await page.clock.fastForward(550);
  await expect(page.locator(".activity-page")).toHaveAttribute(
    "data-participation",
    "none",
  );
  await expect(page.getByTestId("envelope")).toHaveAttribute(
    "data-open",
    "false",
  );
  await expect(page.locator(".password-list .pw-locked")).toHaveCount(3);
  await expect(page.locator(".reward-slip")).toHaveCount(0);
});

for (const width of [1920, 1440, 768, 375]) {
  test(`detail rows and independent roster scrolling fit ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.goto("/#activity?sample=thanks");
    await page
      .getByRole("button", { name: "查看领取名单", exact: true })
      .click();
    const list = page.locator(".recipient-list");
    await expect(list.locator(".recipient")).toHaveCount(20);
    const metrics = await list.evaluate((element) => ({
      height: element.clientHeight,
      scroll: element.scrollHeight,
      max: getComputedStyle(element).maxHeight,
    }));
    expect(metrics.scroll).toBeGreaterThan(metrics.height);
    expect(metrics.height).toBeLessThanOrEqual(
      Math.min(720, (width === 375 ? 812 : 900) * 0.85),
    );
    const overflowingRows = await list.locator(".recipient").evaluateAll(
      (rows) =>
        rows.filter((row) => {
          const bounds = row.getBoundingClientRect();
          return [...row.children].some(
            (child) => child.getBoundingClientRect().bottom > bounds.bottom,
          );
        }).length,
    );
    expect(overflowingRows).toBe(0);
    await list.scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("navigation", { name: "公开名单分页" }),
    ).toHaveCount(0);
    const main = page.locator("#main");
    const before = await main.evaluate((element) => element.scrollTop);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(list.locator(".recipient")).toHaveCount(30);
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(
      0,
    );
    expect(
      Math.abs((await main.evaluate((element) => element.scrollTop)) - before),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.goto("/#activity?sample=history-random-active");
    await expect(page.locator(".slip-amount")).toContainText("0.98");
    await mkdir(".wrangler/verification/prototype", { recursive: true });
    if (width === 1440 || width === 375) {
      await page.screenshot({
        path: `.wrangler/verification/prototype/detail-result-${width}.png`,
      });
      await page.locator(".password-section").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.wrangler/verification/prototype/detail-passwords-${width}.png`,
      });
      await page
        .getByRole("button", { name: "查看领取名单", exact: true })
        .click();
      await page.screenshot({
        path: `.wrangler/verification/prototype/detail-roster-${width}.png`,
      });
    }
  });
}
