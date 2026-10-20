import { expect, type Page, test } from "@playwright/test";
import {
  type CreateActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
  type Merchant,
  type MerchantList,
} from "../packages/contracts/src";
import { expectPath, mockSession, openApp, shown, viewer } from "./support/app";

// 发红包 (migration phase 3) against a mocked API: the four steps, what is
// sent, a lost answer sent again as it was, and a missing merchant.

const merchantId = "cccccccc-1111-4222-8333-444444444444";
const createdId = "dddddddd-1111-4222-8333-444444444444";

const merchant = {
  id: merchantId,
  label: "默认商户",
  usageStatus: "current",
  publicationEligibility: { allowed: true, reason: null, credentialVersion: 1 },
  clientId: "my_client_2026",
  version: 1,
  credentialVersion: 1,
  pausedReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  credentialVerification: {
    status: "passed",
    credentialVersion: 1,
    checkedAt: new Date().toISOString(),
    nextCheckAt: null,
    reason: null,
  },
  capabilities: { canExecutePayments: true, canSimulate: false },
  mode: "real",
} as Merchant;

async function mockMerchants(
  page: Page,
  items: Merchant[],
  fish: { enabled: boolean; available: boolean; availableMinor: number } = {
    enabled: false,
    available: false,
    availableMinor: 0,
  },
) {
  // 从哪发 (🐟额红包) shows only with 🐟额 to send.
  await page.route("**/api/me/balance/hongbao", (route) =>
    route.fulfill({ json: fish }),
  );
  await page.route("**/api/me/merchants", (route) =>
    route.fulfill({
      json: {
        items,
        nextCursor: null,
        currentMerchantId: items[0]?.id ?? null,
        canCreate: true,
        canSimulate: false,
      } satisfies MerchantList,
    }),
  );
}

/** What the server keeps of a create: the saved draft, as 📝 reads it. */
function managed(input: CreateActivityInput["activity"]): ManagedActivity {
  const now = new Date().toISOString();
  return {
    id: createdId,
    title: input.title,
    rewardType: "ldc",
    participationMode: input.participationMode ?? "password",
    forceDedicated: input.forceDedicated,
    status: "draft",
    version: 1,
    createdAt: now,
    openedAt: null,
    deadlineAt: null,
    topicUrl: null,
    totalCount:
      input.money.mode === "custom"
        ? input.money.amounts.length
        : input.money.count,
    claimedCount: 0,
    author: {
      id: viewer.id,
      username: viewer.username,
      displayName: viewer.displayName,
      avatarUrl: null,
    },
    config: input,
  };
}

/** Answers creates (the first `fail` of them with a 503); records them. */
async function mockCreate(page: Page, fail = 0) {
  const sent: CreateActivityInput[] = [];
  let saved: ManagedActivity | null = null;
  await page.route("**/api/activities", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as CreateActivityInput;
    sent.push(body);
    if (sent.length <= fail)
      return route.fulfill({
        status: 503,
        json: { error: { code: "HTTP_503", message: "" } },
      });
    saved = managed(body.activity);
    return route.fulfill({ json: { activity: saved } });
  });
  await page.route(`**/api/me/activities/${createdId}`, (route) =>
    route.fulfill({ json: { activity: saved } }),
  );
  await page.route(`**/api/activities/${createdId}`, (route) =>
    saved
      ? route.fulfill({
          json: {
            activity: {
              id: createdId,
              title: saved.title,
              rewardType: "ldc",
              participationMode: "password",
              status: "draft",
              author: saved.author,
              forceDedicated: false,
              topicUrl: null,
              openedAt: null,
              deadlineAt: null,
              quantity: { mode: "exact", total: 3, claimed: 0, remaining: 3 },
              beforeInfo: "",
            },
          },
        })
      : route.fulfill({ status: 404, json: { error: {} } }),
  );
  return sent;
}

/** 拼手气, 0.30 LDC in 3 shares, one 口令: the four steps of /new. */
async function fillRandom(page: Page) {
  await page
    .getByRole("button", { name: /拼手气/ })
    .first()
    .click();
  // Picking a 玩法 moves on by itself, to 发多少.
  await expect(page.locator("#hb-random-total")).toBeVisible();
  // Enter is 下一步 (the step's own button; the last card's is leaving).
  await page.locator("#hb-random-total").press("Enter");
  await expect(shown(page, "总额要大于 0，最多两位小数")).toBeVisible();
  await page.locator("#hb-random-total").fill("0.30");
  await page.locator("#hb-random-count").fill("3");
  await page.keyboard.press("Enter");
  await page.getByLabel("口令 1").fill("表单口令2026");
  await page.keyboard.press("Enter");
  await expect(page.locator("#hb-title")).toBeVisible();
}

test.describe("发红包", () => {
  test("四步填完存草稿：发出去的就是生产要的输入", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expectPath(page, `/🧧/${encodeActivityEmoji(createdId)}/📝`);
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.activity).toMatchObject({
      title: "拼手气红包 · 3 份",
      participationMode: "password",
      passwords: ["表单口令2026"],
      allocation: "random",
      deadline: { mode: "duration", value: 24, unit: "hours" },
      merchantId,
      money: {
        mode: "random",
        algorithm: "double_mean_v1",
        totalAmount: "0.30",
        count: 3,
      },
    });
    // Off, it is left out: an older request keeps its parsed shape.
    expect(sent[0]?.activity).not.toHaveProperty("humanCheck");
  });

  test("发多少：手续费按发红包的人的 Credit 等级；超过 800 提示可能顺延", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    await openApp(page, "/new");
    await page
      .getByRole("button", { name: /拼手气/ })
      .first()
      .click();
    await expect(
      page.getByText(
        "填的是每份发出的金额。领取的人到账时，Credit 会按你的 Credit 等级扣分发费（4%–15%）。",
        { exact: false },
      ),
    ).toBeVisible();
    const overflow = page.getByText(
      "Credit 每天最多能发 800–2000 LDC（按你的 Credit 等级），超出的部分可能顺延到第二天发放。",
    );
    await page.locator("#hb-random-total").fill("800");
    await page.locator("#hb-random-count").fill("3");
    await expect(overflow).toBeHidden();
    await page.locator("#hb-random-total").fill("800.01");
    await expect(overflow).toBeVisible();
  });

  test("更多设置：领取前人机验证写明代价，打开后摘要和保存的输入都带上", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const toggle = sheet.getByRole("switch", { name: "领取前人机验证" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(sheet).toContainText(
      "中国大陆网络、广告拦截插件或部分隐私浏览器可能加载不出验证，这些人会领不了。",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("button", { name: "完成" }).click();
    await expect(page.getByRole("button", { name: /更多设置/ })).toContainText(
      "领取需人机验证",
    );
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity).toMatchObject({ humanCheck: true });
  });

  test("限时开奖：最晚开奖默认 180 秒，时长可以按秒填", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await page
      .getByRole("button", { name: /限时开奖/ })
      .first()
      .click();
    await expect(page.locator("#hb-draw-pool")).toBeVisible();
    await page.locator("#hb-draw-pool").fill("0.20");
    await page.locator("#hb-draw-winners").fill("1");
    await page.locator("#hb-draw-winners").press("Enter");
    const timing = page.locator("#hb-quiet-timing");
    await expect(timing).toContainText("开放后 180 秒内开奖");
    await timing.click();
    const units = page.getByRole("group", { name: "时长单位" });
    await expect(units.getByRole("button", { name: "秒" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#hb-timing-value")).toHaveValue("180");
    await page.locator("#hb-timing-value").fill("90");
    await page.keyboard.press("Escape");
    await expect(timing).toContainText("开放后 90 秒内开奖");
    await page.getByLabel("口令 1").fill("开奖口令2026");
    await page.keyboard.press("Enter");
    await expect(page.locator("#hb-title")).toBeVisible();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.activity).toMatchObject({
      deadline: { mode: "duration" },
      money: { mode: "timed_draw", countdownSeconds: 90 },
    });
  });

  test("截止时间没有秒：普通红包的时长单位从分钟起", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    await openApp(page, "/new");
    await page
      .getByRole("button", { name: /拼手气/ })
      .first()
      .click();
    await page.locator("#hb-random-total").fill("0.30");
    await page.locator("#hb-random-count").fill("3");
    await page.keyboard.press("Enter");
    const timing = page.locator("#hb-quiet-timing");
    await expect(timing).toContainText("开放后 24 小时截止");
    await timing.click();
    await expect(
      page.getByRole("group", { name: "时长单位" }).getByRole("button"),
    ).toHaveText(["分钟", "小时", "天"]);
  });

  test("没收到保存结果：重试原提交，发的是同一个请求", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page, 1);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "尚未确认保存结果，请重试原提交，避免重复提交。").first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "重试原提交" }).first().click();
    await expectPath(page, `/🧧/${encodeActivityEmoji(createdId)}/📝`);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.requestId).toBe(sent[0]?.requestId);
  });

  test("从哪发：没有商户、有🐟额就默认🐟额，商户那张变灰并给入口，超过可用当场说，存下的输入不带商户", async ({
    page,
  }) => {
    await mockSession(page, { ...viewer, balance: true });
    await mockMerchants(page, [], {
      enabled: true,
      available: true,
      availableMinor: 1234,
    });
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await page
      .getByRole("button", { name: /拼手气/ })
      .first()
      .click();
    const fish = page.getByRole("button", { name: /^🐟额/ });
    await expect(fish).toContainText("可用 12.34 🐟");
    await expect(fish).toHaveAttribute("aria-pressed", "true");
    const merchant = page.getByRole("button", { name: /^LDC 商户/ });
    await expect(merchant).toContainText("还没有配置商户");
    await expect(merchant).toBeDisabled();
    await expect(page.getByRole("link", { name: "去配置商户" })).toBeVisible();
    await expect(
      page.getByText(/Credit 会按你的 Credit 等级扣分发费/),
    ).toHaveCount(0);
    await page.locator("#hb-random-total").fill("20");
    await page.locator("#hb-random-count").fill("3");
    await expect(
      shown(page, "可用只有 12.34 🐟，不够发这个红包。"),
    ).toBeVisible();
    await page.locator("#hb-random-total").fill("0.30");
    await expect(
      shown(page, "可用只有 12.34 🐟，不够发这个红包。"),
    ).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.getByLabel("口令 1").fill("表单口令2026");
    await page.keyboard.press("Enter");
    await expect(page.locator("#hb-title")).toBeVisible();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.activity).toMatchObject({
      funding: "balance",
      merchantId: "",
      money: { mode: "random", totalAmount: "0.30", count: 3 },
    });
  });

  test("还没有商户：发多少里提示去配置，保存不会发出", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, []);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    // Not over the whole form: where the money is set.
    await expect(page.getByText(/还没有配置 LDC 商户/)).toHaveCount(0);
    await page
      .getByRole("button", { name: /拼手气/ })
      .first()
      .click();
    await expect(
      page.getByText("还没有配置 LDC 商户，配置好才能保存和开放。"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "去配置商户" })).toBeVisible();
    await page.locator("#hb-random-total").fill("0.30");
    await page.locator("#hb-random-count").fill("3");
    await page.keyboard.press("Enter");
    await page.getByLabel("口令 1").fill("表单口令2026");
    await page.keyboard.press("Enter");
    await expect(page.locator("#hb-title")).toBeVisible();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(
        page,
        "还没有配置商户，不能保存。先到 LDC 商户配置填好商户。",
      ).first(),
    ).toBeVisible();
    expect(sent).toHaveLength(0);
  });
});
