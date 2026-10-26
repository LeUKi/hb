import { expect, type Page, test } from "@playwright/test";
import {
  type CreateActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
  type Merchant,
  type MerchantList,
} from "../packages/contracts/src";
import {
  expectPath,
  haptics,
  mockSession,
  openApp,
  recordHaptics,
  shown,
  viewer,
} from "./support/app";

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
  fish: {
    enabled: boolean;
    available: boolean;
    availableMinor: number;
    page?: true;
  } = {
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

  test("口令：粘贴多行拆成多个口令，最多 32 个，多出来的写明", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
    const row = (n: number) => page.getByLabel(`口令 ${n}`, { exact: true });
    const paste = async (n: number, text: string) => {
      await page.evaluate(
        (value) => navigator.clipboard.writeText(value),
        text,
      );
      await row(n).focus();
      await page.keyboard.press("ControlOrMeta+V");
    };
    await expect(page.getByText("粘贴多行会拆成多个口令。")).toBeVisible();

    // Into the empty first row: one 口令 a line, blank lines skipped.
    await paste(1, "周末口令2026\n\n  公共口令2026  \r\n第三个口令88");
    await expect(row(1)).toHaveValue("周末口令2026");
    await expect(row(2)).toHaveValue("公共口令2026");
    await expect(row(3)).toHaveValue("第三个口令88");
    await expect(row(4)).toHaveCount(0);
    await expect(row(3)).toBeFocused();
    await expect(page.getByText("3 / 32", { exact: true })).toBeVisible();

    // Into a filled row: under it, up to 32; the rest are said.
    const batch = Array.from(
      { length: 31 },
      (_, index) => `批量口令${String(index + 1).padStart(2, "0")}`,
    );
    await paste(1, batch.join("\n"));
    await expect(row(1)).toHaveValue("周末口令2026");
    await expect(row(2)).toHaveValue("批量口令01");
    await expect(row(30)).toHaveValue("批量口令29");
    await expect(row(31)).toHaveValue("公共口令2026");
    await expect(row(32)).toHaveValue("第三个口令88");
    await expect(row(30)).toBeFocused();
    await expect(row(30)).toBeInViewport();
    await expect(page.getByText("32 / 32", { exact: true })).toBeVisible();
    // Said under the list, so it is in view by the rows just put in.
    const note = page.getByText("最多 32 个口令，后面 2 行没有加进来。");
    await expect(note).toBeInViewport();
    await expect(page.getByRole("button", { name: "再加一个" })).toBeHidden();
    // Typing again folds the note away.
    await row(2).fill("改过的口令01");
    await expect(note).toBeHidden();
  });

  test("发多少：手续费按红包作者的 Credit 等级；超过 800 提示可能顺延", async ({
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
        "填的是每份发出的金额。领取者到账时，Credit 站会按你在 Credit 站的等级扣分发费（4%–15%）。",
        { exact: false },
      ),
    ).toBeVisible();
    const overflow = page.getByText(
      "Credit 站每天最多能发 800–2000 LDC（按你在 Credit 站的等级），超出的部分可能顺延到第二天发放。",
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
      "领取前先通过 Cloudflare 人机验证，挡住抢红包脚本；部分网络或浏览器可能加载不出，这些人会领不了。开放后也能改。",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("button", { name: "完成" }).click();
    await expect(page.getByRole("button", { name: /更多设置/ })).toContainText(
      "领取前人机验证",
    );
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity).toMatchObject({ humanCheck: true });
  });

  test("更多设置：附带网页只给 PLUS，地址按规矩检查、整理，存草稿时带上", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant], {
      enabled: false,
      available: false,
      availableMinor: 0,
      page: true,
    });
    const sent = await mockCreate(page);
    // The page's own headers, read by the API: this one refuses frames.
    const checked: string[] = [];
    await page.route("**/api/me/attached-page/check**", (route) => {
      checked.push(
        new URL(route.request().url()).searchParams.get("url") ?? "",
      );
      return route.fulfill({ json: { embeddable: "no" } });
    });
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const field = sheet.getByRole("region", { name: "附带网页" });
    await expect(field).toContainText(
      "选填。红包页旁边会显示这个网页（手机上在底部），比如题目、规则或排行榜。开放后不能改。说明里写 [文字](#附带网页) 会显示成打开它的按钮。",
    );
    const input = sheet.locator("#hb-page");
    await input.fill("http://example.com/题目");
    await expect(field).toContainText("只能用 https:// 开头的地址");
    await input.fill("https://Puzzle.Example.com/题目?day=3");
    await input.blur();
    await expect(input).toHaveValue(
      "https://puzzle.example.com/%E9%A2%98%E7%9B%AE?day=3",
    );
    const refused =
      "这个网站不允许被嵌入，红包页上会显示不出来，只能在新标签页打开。";
    await expect(field).toContainText(refused);
    expect(checked).toEqual([
      "https://puzzle.example.com/%E9%A2%98%E7%9B%AE?day=3",
    ]);
    // Typing again: the warning is for the address it was read for.
    await input.fill("https://puzzle.example.com/other");
    await expect(field).not.toContainText(refused);
    await input.blur();
    await sheet.getByRole("button", { name: "完成" }).click();
    // With a page, the 说明 offers 插入网页按钮: the link at the cursor,
    // its words selected to type over.
    await page.getByRole("button", { name: "加一段红包说明" }).click();
    const note = page.locator("#hb-before-info");
    // Typed as a person does, the cursor after the words (fill() may leave
    // it at the start).
    await note.click();
    await page.keyboard.type("今天的题在旁边，");
    await page.getByRole("button", { name: "插入网页按钮" }).click();
    await expect(note).toHaveValue("今天的题在旁边，[打开网页](#附带网页)");
    await page.keyboard.type("看题");
    await expect(note).toHaveValue("今天的题在旁边，[看题](#附带网页)");
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    // Only a warning: it is saved all the same.
    expect(sent[0]?.activity).toMatchObject({
      pageUrl: "https://puzzle.example.com/other",
      beforeInfo: "今天的题在旁边，[看题](#附带网页)",
    });
  });

  test("更多设置：不能附带网页的人看不到这一项，存草稿不带", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    await expect(sheet.getByRole("region", { name: "关联帖子" })).toBeVisible();
    await expect(sheet.locator("#hb-page")).toHaveCount(0);
    await sheet.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity).not.toHaveProperty("pageUrl");
  });

  test("震动反馈：下一步被拦下震出错；选择类的控件换了才轻震；存草稿成功震成功", async ({
    page,
  }) => {
    const felt = await recordHaptics(page);
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    await mockCreate(page);
    await openApp(page, "/new");
    // 发多少 left empty, Enter is turned back: an error.
    await fillRandom(page);
    expect(await felt()).toContainEqual(haptics.error);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const scope = sheet.getByRole("region", { name: "领取范围" });
    const count = async () => (await felt()).length;
    const start = await count();
    await scope.getByRole("button", { name: /^限定/ }).click();
    await expect
      .poll(felt)
      .toEqual(expect.arrayContaining([haptics.selection]));
    await expect.poll(count).toBe(start + 1);
    // The one already picked: nothing.
    await scope.getByRole("button", { name: /^限定/ }).click();
    await page.waitForTimeout(100);
    await scope.getByRole("button", { name: /^Lv2/ }).click();
    await expect.poll(count).toBe(start + 2);
    // A person's next tap: picks closer than 45 ms are felt as one.
    await page.waitForTimeout(100);
    await sheet.getByRole("switch", { name: "首页领取" }).click();
    await expect.poll(count).toBe(start + 3);
    expect((await felt()).slice(start)).toEqual([
      haptics.selection,
      haptics.selection,
      haptics.selection,
    ]);
    await sheet.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect((await felt()).at(-1)).toEqual(haptics.success);
  });

  test("领取范围：等级加指定的人，“或”说清楚，保存的输入带上", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    // Who that name is here: one has been, one has not.
    await page.route("**/api/people?**", (route) => {
      const name = new URL(route.request().url()).searchParams.get("username");
      return route.fulfill({
        json: {
          person:
            name === "xiaoman"
              ? {
                  linuxDoId: "730001",
                  username: "XiaoMan",
                  displayName: "小满",
                  avatarUrl: null,
                }
              : null,
        },
      });
    });
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const scope = sheet.getByRole("region", { name: "领取范围" });
    await expect(
      scope.getByRole("button", { name: /^所有人/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await scope.getByRole("button", { name: /^限定/ }).click();
    // Both parts start empty: it says what to pick, and stays open.
    const level = (name: string) =>
      scope.getByRole("button", { name: new RegExp(`^${name}`) });
    for (const name of ["Lv0", "Lv1", "Lv2", "Lv3", "Lv4"])
      await expect(level(name)).toHaveAttribute("aria-pressed", "false");
    await expect(scope).toContainText("至少选一项：指定的人，或按等级");
    await expect(sheet).toBeVisible();
    // Each card names its level as LINUX DO does.
    await expect(level("Lv3")).toHaveText("Lv3活跃用户");
    for (const name of ["Lv2", "Lv3", "Lv4"]) await level(name).click();
    await expect(level("Lv2")).toHaveAttribute("aria-pressed", "true");
    await expect(scope).toContainText("Lv2 及以上的人能领。");
    const field = scope.getByLabel("指定的人");
    await field.fill("@xiaoman");
    await expect(scope).toContainText("小满 @XiaoMan");
    await field.press("Enter");
    await field.fill("newcomer");
    await expect(scope).toContainText("这个人还没来过本站，按用户名认。");
    await scope.getByRole("button", { name: "添加" }).click();
    await expect(scope.getByRole("button", { name: /^去掉 @/ })).toHaveCount(2);
    await expect(scope).toContainText(
      "Lv2 及以上的人，或指定的 2 位，都能领。",
    );
    await sheet.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity.scope).toEqual({
      levels: [2, 3, 4],
      users: [
        { username: "XiaoMan", linuxDoId: null },
        { username: "newcomer", linuxDoId: null },
      ],
    });
  });

  test("领取范围：等级任意组合，不连着的分开写；全选不行", async ({ page }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const scope = sheet.getByRole("region", { name: "领取范围" });
    await scope.getByRole("button", { name: /^限定/ }).click();
    const level = (name: string) =>
      scope.getByRole("button", { name: new RegExp(`^${name}`) });
    // One level alone.
    await level("Lv3").click();
    await expect(scope).toContainText("Lv3 的人能领。");
    // Two apart: each said, a 顿号 between, picked in any order.
    await level("Lv1").click();
    await expect(scope).toContainText("Lv1、Lv3 的人能领。");
    // Every level is everyone: it says so.
    for (const name of ["Lv0", "Lv2", "Lv4"]) await level(name).click();
    await expect(scope).toContainText("等级全选就等于所有人");
    // One off again (Lv2): two runs.
    await level("Lv2").click();
    await expect(level("Lv2")).toHaveAttribute("aria-pressed", "false");
    await expect(scope).toContainText("Lv0–1、Lv3–4 的人能领。");
    await expect(scope).not.toContainText("等级全选就等于所有人");
    await sheet.getByRole("button", { name: "完成" }).click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity.scope).toEqual({ levels: [0, 1, 3, 4] });
  });

  test("更多设置：关掉首页领取，加入红包广场跟着打开并锁住，摘要和保存的输入都带上", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockMerchants(page, [merchant]);
    const sent = await mockCreate(page);
    await openApp(page, "/new");
    await fillRandom(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const home = sheet.getByRole("switch", { name: "首页领取" });
    const square = sheet.getByRole("switch", { name: "加入红包广场" });
    await expect(home).toHaveAttribute("aria-checked", "true");
    await expect(square).toHaveAttribute("aria-checked", "false");
    await expect(sheet).not.toContainText("领取者只能在红包页输入口令");
    await home.click();
    await expect(home).toHaveAttribute("aria-checked", "false");
    // A 口令 sent alone would match nothing: it says how to share.
    await expect(sheet).toContainText(
      "领取者只能在红包页输入口令。开放后请通过“分享”复制文案，文案中带有红包入口。",
    );
    // Found in 红包广场 by those without the link: it goes on, and stays.
    await expect(square).toHaveAttribute("aria-checked", "true");
    await expect(square).toBeDisabled();
    await expect(square).toHaveAccessibleDescription(
      "关闭首页领取的红包要加入红包广场，方便大家找到。",
    );
    await sheet.getByRole("button", { name: "完成" }).click();
    await expect(page.getByRole("button", { name: /更多设置/ })).toContainText(
      "关闭首页领取",
    );
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect(
      shown(page, "草稿已保存。开放前只有你能看到它。").first(),
    ).toBeVisible();
    expect(sent[0]?.activity).toMatchObject({
      forceDedicated: true,
      joinSquare: true,
    });
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
      page.getByText(/Credit 站会按你在 Credit 站的等级扣分发费/),
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
