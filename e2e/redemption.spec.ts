import { expect, type Page, test } from "@playwright/test";
import {
  type DiscoveryCard,
  encodeActivityEmoji,
  type GlobalRedemptionResult,
} from "../packages/contracts/src";
import {
  expectPath,
  mockSession,
  omniboxInput,
  openApp,
  shown,
  viewer,
} from "./support/app";

// Lookups skip 红包 that take their 口令 on their own page: the line says so.
const noMatch = "未匹配到红包。部分红包只能在红包页输入口令领取。";

/**
 * The no-match line, whose “部分红包” and “红包页” are 名词解释: buttons
 * described by what they mean, so the sentence is read around them.
 */
async function expectNoMatch(page: Page) {
  const which = page.getByRole("button", { name: "部分红包", exact: true });
  const where = page.getByRole("button", { name: "红包页", exact: true });
  await expect(which).toBeVisible();
  await expect(which).toHaveAccessibleDescription(
    /^开启了“统计口令尝试”的红包/,
  );
  await expect(where).toHaveAccessibleDescription(
    /^红包页是每个红包自己的页面/,
  );
  await expect
    .poll(() =>
      where.locator("xpath=..").evaluate((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
        return copy.textContent;
      }),
    )
    .toBe(noMatch);
}

const first = "11111111-2222-4333-8444-555555555555";
const second = "22222222-3333-4444-8555-666666666666";
const resultId = "33333333-4444-4555-8666-777777777777";

function card(id: string, title: string): DiscoveryCard {
  return {
    id,
    title,
    rewardType: "ldc",
    status: "active",
    author: {
      id: "author-e2e",
      username: "author",
      displayName: "测试发红包的人",
      avatarUrl: null,
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
    quantity: { mode: "exact", total: 5, claimed: 1, remaining: 4 },
    reward: {
      mode: "fixed",
      totalAmount: "0.50",
      unitAmount: "0.10",
      count: 5,
    },
    myClaim: null,
  };
}

function discovered(
  result: GlobalRedemptionResult["result"],
  items: DiscoveryCard[],
): GlobalRedemptionResult {
  return {
    id: resultId,
    claimSubmissionId: "44444444-5555-4666-8777-888888888888",
    result,
    items,
    nextCursor: null,
    total: items.length,
    ...(result === "single" && items[0]
      ? { selectedActivityId: items[0].id }
      : {}),
    attemptCooldown: {
      revision: 1,
      serverTime: Date.now(),
      nextAllowedAt: Date.now() + 5_000,
    },
  };
}

/** Answers each lookup in turn; records what was sent. */
async function mockDiscover(
  page: Page,
  answers: Array<
    | { status: 200; body: GlobalRedemptionResult }
    | { status: number; body: unknown }
  >,
) {
  const sent: Array<{ submissionId: string; password: string }> = [];
  await page.route("**/api/redemptions/discover", async (route) => {
    sent.push(route.request().postDataJSON());
    const answer = answers.shift() ?? answers.at(-1);
    if (!answer) return route.abort();
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  return sent;
}

async function lookUp(page: Page, password: string) {
  await omniboxInput(page).click();
  await omniboxInput(page).fill(password);
  await page.keyboard.press("Enter");
}

test.describe("兑奖", () => {
  test("输入口令时一直看得到字数：起始页在框下，展开后跟在要查的口令后面", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await openApp(page);
    const input = omniboxInput(page);
    await input.click();
    await input.fill("测试口令");
    // Too short: the rules, with the count beside them.
    await expect(shown(page, "还差 2 个字，口令至少 6 个字。")).toBeVisible();
    await expect(shown(page, "4 / 32")).toBeVisible();
    // Enough: the rules go, the count stays in its place.
    await input.fill("测试口令一二三");
    await expect(shown(page, "还差 2 个字，口令至少 6 个字。")).toHaveCount(0);
    await expect(shown(page, "7 / 32")).toBeVisible();
    await input.fill("");
    await expect(shown(page, "7 / 32")).toHaveCount(0);

    // The box expanded on another page: right after the 口令 it looks up.
    await page.goto("/help");
    await page.getByRole("button", { name: /\/help/ }).click();
    await omniboxInput(page).fill("测试口令一二三四");
    await expect(
      page.getByRole("option", { name: "查找口令 测试口令一二三四 8 / 32" }),
    ).toBeVisible();
  });

  test("没匹配到：说明、记进最近输入、按服务端的冷却倒数", async ({ page }) => {
    await mockSession(page, viewer);
    const sent = await mockDiscover(page, [
      { status: 200, body: discovered("none", []) },
    ]);
    await openApp(page);
    await lookUp(page, "测试口令2099");
    await expectNoMatch(page);
    await expect(
      page.getByRole("button", { name: /还需等待 \d 秒/ }),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.password).toBe("测试口令2099");
    await expect(
      page.getByRole("button", { name: "填入 测试口令2099，未匹配" }),
    ).toBeVisible();
  });

  test("手机上点最近输入、全部命令：打开的输入框里填着它们", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await mockSession(page, viewer);
    await mockDiscover(page, [{ status: 200, body: discovered("none", []) }]);
    await openApp(page);
    await lookUp(page, "测试口令2099");
    await expectNoMatch(page);
    // The answer is kept a moment after it shows: leave once it is.
    await expect(
      page.getByRole("button", { name: "填入 测试口令2099，未匹配" }),
    ).toBeAttached();

    // A fresh start page (another address first: reloading this one would
    // keep the open box's history state), not focused until tapped.
    const fresh = async () => {
      await page.goto("about:blank");
      await openApp(page);
    };
    await fresh();
    await page
      .getByRole("button", { name: "填入 测试口令2099，未匹配" })
      .click();
    await expect(omniboxInput(page)).toBeFocused();
    await expect(omniboxInput(page)).toHaveValue("测试口令2099");

    await fresh();
    await page.getByRole("button", { name: /全部命令/ }).click();
    await expect(omniboxInput(page)).toBeFocused();
    await expect(omniboxInput(page)).toHaveValue("/");
    await expect(page.getByRole("option", { name: /红包广场/ })).toBeVisible();
  });

  test("匹配到多个：去 /🔑/ 结果页，选一个就去那个红包", async ({ page }) => {
    await mockSession(page, viewer);
    await mockDiscover(page, [
      {
        status: 200,
        body: discovered("multiple", [
          card(first, "共享口令甲"),
          card(second, "共享口令乙"),
        ]),
      },
    ]);
    await openApp(page);
    await lookUp(page, "共享口令2026");
    await expectPath(page, `/🔑/${resultId}`);
    await expect(page.getByRole("heading", { name: "选择红包" })).toBeVisible();
    await expect(
      page.getByText("口令 共享口令2026 匹配到 2 个红包"),
    ).toBeVisible();
    await expect(page).toHaveTitle("选择红包 · lafish的红包站");
    await page.getByRole("button", { name: /共享口令乙/ }).click();
    await expectPath(page, `/🧧/${encodeActivityEmoji(second)}`);
  });

  test("结果页刷新后从服务端读列表，口令不保留", async ({ page }) => {
    await mockSession(page, viewer);
    let reads = 0;
    await page.route(`**/api/redemptions/${resultId}**`, (route) => {
      reads++;
      return route.fulfill({
        json: discovered("multiple", [
          card(first, "共享口令甲"),
          card(second, "共享口令乙"),
        ]),
      });
    });
    await openApp(page, `/🔑/${resultId}`);
    await expect(
      page.locator("#view p").filter({ hasText: "匹配到 2 个红包" }),
    ).toBeVisible();
    await expect(
      page.getByText("口令没有保留（刷新过页面或换过账号）"),
    ).toBeVisible();
    expect(reads).toBeGreaterThan(0);
  });

  test("只匹配到一个：直接去那个红包", async ({ page }) => {
    await mockSession(page, viewer);
    await mockDiscover(page, [
      { status: 200, body: discovered("single", [card(first, "单独口令")]) },
    ]);
    await openApp(page);
    await lookUp(page, "单独口令2026");
    await expectPath(page, `/🧧/${encodeActivityEmoji(first)}`);
  });

  test("没收到结果：再次确认发的是同一笔提交", async ({ page }) => {
    await mockSession(page, viewer);
    const sent = await mockDiscover(page, [
      { status: 503, body: { error: { code: "HTTP_503", message: "" } } },
      { status: 200, body: discovered("none", []) },
    ]);
    await openApp(page);
    await lookUp(page, "测试口令2100");
    await expect(shown(page, "查找结果未确认，请再次确认。")).toBeVisible();
    await page.getByRole("button", { name: "再次确认" }).click();
    await expectNoMatch(page);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.submissionId).toBe(sent[0]?.submissionId);
  });

  test("系统维护中：直接说明，不当作结果未确认", async ({ page }) => {
    await mockSession(page, viewer);
    await mockDiscover(page, [
      {
        status: 503,
        body: {
          error: { code: "MAINTENANCE", message: "系统维护中，请稍后再试。" },
        },
      },
    ]);
    await openApp(page);
    await lookUp(page, "测试口令2102");
    await expect(shown(page, "系统维护中，请稍后再试。")).toBeVisible();
    await expect(page.getByRole("button", { name: "再次确认" })).toHaveCount(0);
  });

  test("太频繁：说明并按服务端给的冷却倒数", async ({ page }) => {
    await mockSession(page, viewer);
    await mockDiscover(page, [
      {
        status: 429,
        body: {
          attemptCooldown: {
            revision: 2,
            serverTime: Date.now(),
            nextAllowedAt: Date.now() + 4_000,
          },
          error: { code: "ATTEMPT_COOLDOWN", message: "尝试过于频繁" },
        },
      },
    ]);
    await openApp(page);
    await lookUp(page, "测试口令2101");
    await expect(shown(page, "尝试过于频繁，请稍后重试。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /还需等待 \d 秒/ }),
    ).toBeVisible();
  });

  test("游客输入口令：请先登录，点登录打开用户卡片", async ({ page }) => {
    await mockSession(page, null);
    await openApp(page);
    await lookUp(page, "测试口令2102");
    await expect(shown(page, /^请先登录。/)).toBeVisible();
    await page
      .getByRole("button", { name: "登录", exact: true })
      .last()
      .click();
    await expect(page.getByRole("dialog", { name: "登录" })).toBeVisible();
  });

  test("系统维护中的游客输入口令：说明在维护，不叫人登录", async ({ page }) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: { code: "MAINTENANCE", message: "系统维护中，请稍后再试。" },
        },
      }),
    );
    await openApp(page);
    await lookUp(page, "测试口令2103");
    await expect(shown(page, "系统维护中，请稍后再试。")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toHaveCount(0);
  });

  test("帖子链接：一个红包直接打开，多个去 /💬/ 页", async ({ page }) => {
    await mockSession(page, viewer);
    await page.route("**/api/topics/12345/activities**", (route) => {
      const post = new URL(route.request().url()).searchParams.get(
        "postNumber",
      );
      const items =
        post === "6"
          ? [card(first, "帖子红包甲"), card(second, "帖子红包乙")]
          : [card(first, "帖子红包甲")];
      return route.fulfill({
        json: { items, nextCursor: null, total: items.length },
      });
    });
    await openApp(page);
    await lookUp(page, "https://linux.do/t/topic/12345/6");
    await expectPath(page, "/💬/12345/6");
    await expect(
      page.getByRole("heading", { name: "帖子里的红包" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /帖子红包乙/ }),
    ).toBeVisible();

    await openApp(page);
    await lookUp(page, "https://linux.do/t/topic/12345/7");
    await expectPath(page, `/🧧/${encodeActivityEmoji(first)}`);
  });
});
