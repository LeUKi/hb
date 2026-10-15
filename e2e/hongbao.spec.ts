import { expect, type Page, test } from "@playwright/test";
import {
  type ActivityPasswords,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimResult,
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
  type PublicActivity,
  type PublicRecipient,
  type SolveResult,
} from "../packages/contracts/src";
import {
  expectPath,
  type MockUser,
  mockSession,
  omniboxInput,
  openApp,
  shown,
  viewer,
} from "./support/app";

// The 红包 page (migration phase 2) against a mocked API that keeps its own
// state: the public read, the viewer's part, their 口令, the roster.

const id = "44444444-5555-4666-8777-888888888888";
const code = encodeActivityEmoji(id);
const path = `/🧧/${code}`;

const author: MockUser = {
  id: "author-e2e",
  username: "author",
  displayName: "小满",
  avatarUrl: null,
  isAdmin: false,
};

const openedAt = new Date(Date.now() - 5 * 60_000).toISOString();

function publicActivity(): PublicActivity {
  return {
    id,
    title: "周末红包",
    rewardType: "ldc",
    participationMode: "password",
    status: "active",
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: null,
    },
    forceDedicated: false,
    topicUrl: null,
    openedAt,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    quantity: { mode: "exact", total: 3, claimed: 1, remaining: 2 },
    reward: {
      mode: "fixed",
      totalAmount: "0.30",
      unitAmount: "0.10",
      count: 3,
    },
    beforeInfo: [
      "**周末快乐**，口令在[帖子里](https://example.test/t/1)。",
      "",
      ...Array.from({ length: 12 }, (_, line) => `- 第 ${line + 1} 条说明`),
    ].join("\n"),
    paymentMode: "simulation",
  };
}

/** Forum avatars, served here as a small picture. */
const avatarOf = (name: string) =>
  `https://avatars.example.test/${encodeURIComponent(name)}.svg`;

function recipient(name: string, minutes: number): PublicRecipient {
  return {
    id: `claim-${name}`,
    username: name,
    displayName: name,
    avatarUrl: avatarOf(name),
    claimedAt: new Date(Date.parse(openedAt) + minutes * 60_000).toISOString(),
    amount: "0.10",
  };
}

const passwordOf = { mine: "周末口令2026", other: "公共口令2026" };

/** One 红包's server, mocked: answers reads and the two writes. */
async function mockHongbao(page: Page) {
  await page.route("https://avatars.example.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c82a30"/></svg>',
    }),
  );
  const state = {
    activity: publicActivity(),
    claim: null as ClaimDetail | null,
    recipients: [recipient("早到的人", 1)],
    solved: [] as string[],
    claims: [] as unknown[],
    solves: [] as unknown[],
  };
  const passwords = (): ActivityPasswords => {
    const known = state.claim
      ? [
          { text: passwordOf.mine, isClaimPassword: true, isSolved: false },
          ...state.solved.map((text) => ({
            text,
            isClaimPassword: false,
            isSolved: true,
          })),
        ]
      : [];
    return {
      passwords: known,
      hiddenCount: state.claim ? 2 - known.length : 0,
      canSolve: Boolean(state.claim),
    };
  };
  await page.route(`**/api/activities/${id}**`, async (route) => {
    const request = route.request();
    const rest = new URL(request.url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "" && request.method() === "GET")
      return route.fulfill({
        json: {
          activity: {
            ...state.activity,
            // The 名单入口's faces: the latest five claims, in this read.
            rosterPreview: [...state.recipients]
              .reverse()
              .slice(0, 5)
              .map(({ id, username, displayName, avatarUrl }) => ({
                id,
                username,
                displayName,
                avatarUrl,
              })),
          },
        },
      });
    if (rest === "/participation")
      return route.fulfill({
        json: { claim: state.claim, registration: null },
      });
    if (rest === "/passwords") return route.fulfill({ json: passwords() });
    if (rest === "/recipients")
      return route.fulfill({
        json: {
          items: state.recipients,
          nextCursor: null,
          titles: { highestClaimIds: [], lowestClaimIds: [] },
        },
      });
    if (rest === "/claim" && request.method() === "POST") {
      const input = request.postDataJSON() as {
        password?: string;
        submissionId: string;
      };
      state.claims.push(input);
      if (input.password !== passwordOf.mine)
        return route.fulfill({
          json: { result: "incorrect" } satisfies ClaimResult,
        });
      state.claim = {
        id: "claim-mine",
        activity: {
          id,
          title: state.activity.title,
          status: "active",
        },
        rewardType: "ldc",
        claimedAt: new Date().toISOString(),
        sourcePassword: passwordOf.mine,
        amount: "0.10",
        afterClaimInfo: "谢谢你来，**记得**看帖子。",
        payment: {
          id: "payment-mine",
          mode: "simulation",
          status: "pending",
          reason: null,
          confirmedAt: null,
        },
      };
      state.activity = {
        ...state.activity,
        quantity: { mode: "exact", total: 3, claimed: 2, remaining: 1 },
      };
      state.recipients = [
        ...state.recipients,
        {
          ...recipient(viewer.username, 6),
          displayName: viewer.displayName,
          claimedAt: state.claim.claimedAt,
        },
      ];
      return route.fulfill({
        json: { result: "claimed", claim: state.claim } satisfies ClaimResult,
      });
    }
    if (rest === "/password-solves" && request.method() === "POST") {
      const input = request.postDataJSON() as { password: string };
      state.solves.push(input);
      const solved = input.password === passwordOf.other;
      if (solved) state.solved.push(passwordOf.other);
      return route.fulfill({
        json: {
          outcome: solved ? "solved" : "incorrect",
          passwordMatched: solved,
        } satisfies SolveResult,
      });
    }
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  return state;
}

async function readClipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("红包页", () => {
  test("名单入口：真实头像和上面的数字同一次读取，名单随即跟上", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockHongbao(page);
    await openApp(page, path);
    const entry = page.locator("#roster-entry");
    await expect(entry.locator("img")).toHaveAttribute(
      "src",
      avatarOf("早到的人"),
    );
    await entry.click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await expect(roster.getByText("早到的人")).toBeVisible();
    // Someone else claims. The next read (every 5 s) shows the new count and
    // face, and the open 名单 follows at once, not on its own 15 s round.
    state.recipients.push(recipient("后来的人", 2));
    state.activity.quantity = {
      mode: "exact",
      total: 3,
      claimed: 2,
      remaining: 1,
    };
    await expect(roster.getByText("后来的人")).toBeVisible({ timeout: 9000 });
    await page.keyboard.press("Escape");
    await expect(entry.locator("img").first()).toHaveAttribute(
      "src",
      avatarOf("后来的人"),
    );
    await expect(page.getByText("2 / 3 份", { exact: true })).toBeVisible();
  });

  test("游客：大红包皮、说明全文、领取名单和分享", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, null);
    await mockHongbao(page);
    await openApp(page, path);
    await expect(page).toHaveTitle("周末红包 · lafish的红包站");
    await expect(
      page.getByRole("heading", { name: "周末红包", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("小满的红包")).toBeVisible();
    await expect(page.getByText("口令红包")).toBeVisible();
    await expect(page.getByText("固定均分 · 0.10 LDC / 份")).toBeVisible();
    await expect(page.getByText("1 / 3 份")).toBeVisible();
    // The seal (not the 顶栏's account button) says how to take part.
    await expect(
      page.getByRole("button", { name: "登录", description: "登录后领取" }),
    ).toBeVisible();

    // A long 说明 is cut on the cover and opens in full.
    const link = page
      .locator("[data-hb-part=note]")
      .getByRole("link", { name: "帖子里" });
    await expect(link).toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "展开全文" }).click();
    const note = page.getByRole("dialog", { name: "说明" });
    await expect(note.getByText("第 12 条说明")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(note).toBeHidden();

    // The roster is public, oldest first, with 用时.
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await expect(roster.getByText("早到的人")).toBeVisible();
    await expect(roster.getByText("1分00秒")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(roster).toBeHidden();

    // A guest sees no 口令, so the menu has the link and the forum code.
    await page.getByRole("button", { name: "分享" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await menu.getByRole("menuitem", { name: /红包链接/ }).click();
    await expect
      .poll(() => readClipboard(page))
      .toBe(`${new URL(page.url()).origin}/🧧/${code}`);
    // "已复制" shows, then the menu folds away.
    await expect(menu).toBeHidden();
    await page.getByRole("button", { name: "分享" }).click();
    await page.getByRole("menuitem", { name: /内嵌代码/ }).click();
    await expect
      .poll(() => readClipboard(page))
      .toBe(
        `<center><picture><source type="image/svg+xml" srcset="${new URL(page.url()).origin}/🧧/${code}/🖼️.svg 1x"><img width="420" height="560" alt="小满的红包：周末红包"></picture></center>`,
      );
  });

  test("登录后：点印章输入口令领取，再验证其他口令", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    await openApp(page, path);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await expect(omniboxInput(page)).toBeFocused();
    await omniboxInput(page).fill("不对的口令2026");
    await page.keyboard.press("Enter");
    await expect(shown(page, /^口令不正确/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /还需等待 \d 秒/ }),
    ).toBeHidden({ timeout: 10_000 });
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
    ).toHaveCount(1);
    await expect(
      page.locator("p", { hasText: /^\+0\.10\s*LDC$/ }),
    ).toBeVisible();
    await expect(page.getByText("待发放")).toBeVisible();
    await expect(page.getByText("2 / 3 份")).toBeVisible();
    await expect(page.getByText("记得")).toBeVisible();
    expect(state.claims).toHaveLength(2);
    const [wrong, right] = state.claims as Array<{ submissionId: string }>;
    expect(right?.submissionId).not.toBe(wrong?.submissionId);
    // Nothing secret goes into the address.
    await expectPath(page, path);

    // The 口令 区: one known, one still hidden.
    await expect(page.getByText("口令 · 2 个 · 1 个未解出")).toBeVisible();
    await page.getByRole("button", { name: "验证其他口令" }).click();
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect(shown(page, "你已经知道这个口令。")).toBeVisible();
    expect(state.solves).toHaveLength(0);
    await omniboxInput(page).fill(passwordOf.other);
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("口令已解锁，不会再次领取奖励。"),
    ).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: passwordOf.other }),
    ).toContainText("已解出");
    // Everything solved: nothing left to verify.
    await expect(
      page.getByRole("button", { name: "验证其他口令" }),
    ).toBeHidden();

    // The roster now ends with the viewer.
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await expect(roster.getByRole("listitem").last()).toContainText(
      viewer.displayName,
    );
    await page.keyboard.press("Escape");

    // The menu now offers the link with each 口令 the viewer knows.
    await page.getByRole("button", { name: "分享" }).click();
    await page.getByRole("menuitem", { name: /链接与口令 1/ }).click();
    await expect
      .poll(() => readClipboard(page))
      .toBe(
        `【周末红包】\n红包链接：${new URL(page.url()).origin}/🧧/${code}\n领取口令：${passwordOf.mine}`,
      );
  });

  test("发红包的人：看到全部口令，不能自己领", async ({ page }) => {
    await mockSession(page, author);
    await mockHongbao(page);
    const managed: ManagedActivity = {
      id,
      title: "周末红包",
      rewardType: "ldc",
      participationMode: "password",
      forceDedicated: false,
      status: "active",
      version: 2,
      createdAt: openedAt,
      openedAt,
      deadlineAt: publicActivity().deadlineAt,
      topicUrl: null,
      totalCount: 3,
      claimedCount: 1,
      author: publicActivity().author,
      config: {
        ...emptyActivityInput(),
        title: "周末红包",
        passwords: [passwordOf.mine, passwordOf.other],
        merchantId: "55555555-6666-4777-8888-999999999999",
        money: { mode: "fixed", totalAmount: "0.30", count: 3 },
      },
    };
    await page.route(`**/api/me/activities/${id}`, (route) =>
      route.fulfill({ json: { activity: managed } }),
    );
    await page.route(`**/api/me/activities/${id}/claims**`, (route) =>
      route.fulfill({
        json: { items: [], nextCursor: null } satisfies AuthorClaimList,
      }),
    );
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "这是你发的红包，你不能领取" }),
    ).toBeDisabled();
    for (const password of [passwordOf.mine, passwordOf.other])
      await expect(
        page.getByRole("listitem").filter({ hasText: password }),
      ).toContainText("你设置的");
    await expect(page.getByRole("link", { name: "编辑" })).toHaveAttribute(
      "href",
      `/🧧/${code}/📝`,
    );
    await expect(page.getByRole("link", { name: "付款记录" })).toBeVisible();
  });

  test("不存在的红包：未找到", async ({ page }) => {
    await mockSession(page, null);
    await page.route(`**/api/activities/${id}**`, (route) =>
      route.fulfill({
        status: 404,
        json: { error: { code: "ACTIVITY_NOT_FOUND", message: "未找到红包" } },
      }),
    );
    await openApp(page, path);
    await expect(page.getByText("未找到红包")).toBeVisible();
  });
});
