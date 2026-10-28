import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  type ActivityError,
  type ActivityPasswords,
  type AuthorClaim,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimResult,
  emptyActivityInput,
  encodeActivityEmoji,
  FORUM_EMOJI,
  forumShareWithPassword,
  type ManagedActivity,
  type PublicActivity,
  type PublicRecipient,
  type SolveResult,
} from "../packages/contracts/src";
import {
  csrfToken,
  expectPath,
  haptics,
  type MockUser,
  mockSession,
  omniboxInput,
  openApp,
  recordHaptics,
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

/** The public read as the server gives it (and pushes it, live). */
function publicRead(state: {
  activity: PublicActivity;
  recipients: PublicRecipient[];
}): PublicActivity {
  return {
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
  };
}

/**
 * Turnstile, faked: a widget that shows its spinner and passes after
 * `window.__turnstileDelay` ms (400 unless a test changes it).
 */
async function fakeTurnstile(page: Page) {
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js**",
    (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.__turnstileRenders = [];
          window.turnstile = {
            render(container, options) {
              window.__turnstileRenders.push({
                sitekey: options.sitekey,
                action: options.action,
                cData: options.cData,
                language: options.language,
              });
              container.textContent = "正在验证…";
              setTimeout(() => {
                container.textContent = "成功！";
                options.callback("e2e-turnstile-token");
              }, window.__turnstileDelay ?? 400);
              return "widget-" + window.__turnstileRenders.length;
            },
            reset() {},
            remove() {},
          };`,
      }),
  );
}

/** One 红包's server, mocked: answers reads and the two writes. */
async function mockHongbao(
  page: Page,
  /**
   * 领取前人机验证: a right 口令 asks for a token first. 🐟额红包: claims go
   * into 🐟额, with no payment (balance-design §14). `more`: 口令 past the
   * two, each one solvable. `note`: the 说明, in place of the long list.
   */
  options: {
    humanCheck?: boolean;
    fish?: boolean;
    more?: string[];
    note?: string;
  } = {},
) {
  // What a 🐟额红包's claimant has in 🐟额 then: under 1, not out yet.
  await page.route("**/api/me/balance/hongbao", (route) =>
    route.fulfill({ json: { available: false, availableMinor: 10 } }),
  );
  await page.route("https://avatars.example.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c82a30"/></svg>',
    }),
  );
  const state = {
    activity: {
      ...publicActivity(),
      ...(options.humanCheck ? { humanCheck: true as const } : {}),
      ...(options.fish ? { funding: "balance" as const } : {}),
      ...(options.note !== undefined ? { beforeInfo: options.note } : {}),
    },
    claim: null as ClaimDetail | null,
    recipients: [recipient("早到的人", 1)],
    solved: [] as string[],
    claims: [] as unknown[],
    solves: [] as unknown[],
    /** Reads of each endpoint, to tell polling from pushes. */
    reads: { public: 0, participation: 0, passwords: 0, recipients: 0 },
    /** The viewer's claim, as the server records one. */
    claimMine() {
      state.claim = {
        id: "claim-mine",
        activity: {
          id,
          title: state.activity.title,
          status: "active",
          ...(options.fish ? { funding: "balance" as const } : {}),
        },
        rewardType: "ldc",
        claimedAt: new Date().toISOString(),
        sourcePassword: passwordOf.mine,
        amount: "0.10",
        afterClaimInfo: "谢谢你来，**记得**看帖子。",
        ...(options.fish
          ? {}
          : {
              payment: {
                id: "payment-mine",
                mode: "simulation" as const,
                status: "pending" as const,
                reason: null,
                confirmedAt: null,
              },
            }),
      };
      const { quantity } = state.activity;
      if (quantity.mode === "exact")
        state.activity = {
          ...state.activity,
          quantity: {
            ...quantity,
            claimed: quantity.claimed + 1,
            remaining: quantity.remaining - 1,
          },
        };
      state.recipients = [
        ...state.recipients,
        {
          ...recipient(viewer.username, 6),
          displayName: viewer.displayName,
          claimedAt: state.claim.claimedAt,
        },
      ];
      return state.claim;
    },
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
      hiddenCount: state.claim
        ? 2 + (options.more?.length ?? 0) - known.length
        : 0,
      canSolve: Boolean(state.claim),
    };
  };
  await page.route(`**/api/activities/${id}**`, async (route) => {
    const request = route.request();
    const rest = new URL(request.url()).pathname.slice(
      `/api/activities/${id}`.length,
    );
    if (rest === "" && request.method() === "GET") {
      state.reads.public += 1;
      return route.fulfill({ json: { activity: publicRead(state) } });
    }
    if (rest.startsWith("/participation")) {
      state.reads.participation += 1;
      return route.fulfill({
        json: { claim: state.claim, registration: null },
      });
    }
    if (rest === "/passwords") {
      state.reads.passwords += 1;
      return route.fulfill({ json: passwords() });
    }
    if (rest.startsWith("/recipients")) state.reads.recipients += 1;
    if (rest.startsWith("/recipients"))
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
        humanToken?: string;
      };
      state.claims.push(input);
      if (input.password !== passwordOf.mine)
        return route.fulfill({
          json: { result: "incorrect" } satisfies ClaimResult,
        });
      if (options.humanCheck && !input.humanToken)
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "HUMAN_CHECK_REQUIRED",
              message: "领取这个红包需要先通过人机验证。",
            },
            humanCheck: {
              siteKey: "1x00000000000000000000AA",
              action: "claim",
              cData: id,
            },
          } satisfies ActivityError,
        });
      return route.fulfill({
        json: {
          result: "claimed",
          claim: state.claimMine(),
        } satisfies ClaimResult,
      });
    }
    if (rest === "/password-solves" && request.method() === "POST") {
      const input = request.postDataJSON() as { password: string };
      state.solves.push(input);
      const solved = [passwordOf.other, ...(options.more ?? [])].includes(
        input.password,
      );
      if (solved) state.solved.push(input.password);
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

/** A claim's payment, which the mock always makes. */
function paymentOf(claim: ClaimDetail) {
  if (!claim.payment) throw new Error("the mock claim has no payment");
  return claim.payment;
}

async function readClipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("红包页", () => {
  test("震动反馈：按印章轻触一下，口令不对震出错，领到时和打开的红包一起震成功；别的按钮轻点一下", async ({
    page,
  }) => {
    const felt = await recordHaptics(page);
    await mockSession(page, viewer);
    await mockHongbao(page);
    await openApp(page, path);
    // Nothing on the way in.
    expect(await felt()).toEqual([]);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await expect.poll(felt).toEqual([haptics.light]);
    await omniboxInput(page).fill("不对的口令123");
    await page.keyboard.press("Enter");
    await expect.poll(felt).toEqual([haptics.light, haptics.error]);
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect
      .poll(felt)
      .toEqual([haptics.light, haptics.error, haptics.success]);
    // Any other press: the lightest touch, once.
    await page.getByRole("button", { name: "验证其他口令" }).click();
    await expect
      .poll(felt)
      .toEqual([
        haptics.light,
        haptics.error,
        haptics.success,
        haptics.selection,
      ]);
  });

  test("🐟额红包：皮上写🐟额；领到后金额带小 🐟，状态是已存入🐟额，可以去转出", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockHongbao(page, { fish: true });
    await openApp(page, path);
    const cover = page.getByRole("button", { name: "🐟额" });
    await expect(cover).toBeVisible();
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "已领取 0.10 LDC，存进了🐟额。" }),
    ).toHaveCount(1);
    const result = page.locator("[data-hb-part=result]");
    await expect(result.getByText("已存入🐟额")).toBeVisible();
    await expect(result.getByRole("button", { name: "在🐟额" })).toBeVisible();
    await expect(result.getByRole("link", { name: "转出" })).toHaveAttribute(
      "href",
      "/balance",
    );
    // No payment to follow: nothing about 待发放 or Credit accounts.
    await expect(result.getByText("待发放")).toHaveCount(0);
  });

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

  test("登录后：连着时什么都不轮询，推送一到就更新，付款变了只读自己那份", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    state.activity.quantity = {
      mode: "exact",
      total: 5,
      claimed: 1,
      remaining: 4,
    };
    // Already claimed elsewhere; the payment is on its way.
    state.claimMine();
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
      sockets.push(ws);
      ws.onMessage((message) => {
        if (message === "ping") ws.send("pong");
      });
    });
    await openApp(page, path);
    const main = page.locator("main");
    const entry = page.locator("#roster-entry");
    await expect(page.getByText("2 / 5 份", { exact: true })).toBeVisible();
    await expect(main.getByText("待发放")).toBeVisible();
    await expect.poll(() => sockets.length).toBe(1);
    // Connected: nothing is read again on a clock, not even every 15 s.
    await page.waitForTimeout(1_000);
    const atConnect = { ...state.reads };
    await page.waitForTimeout(16_000);
    expect(state.reads).toEqual(atConnect);
    // Someone else claims: the 红包's DO pushes its public read, and the
    // 名单 follows the new face.
    state.recipients.push(recipient("后来的人", 8));
    state.activity = {
      ...state.activity,
      quantity: { mode: "exact", total: 5, claimed: 3, remaining: 2 },
    };
    sockets[0]?.send(
      JSON.stringify({ type: "activity", activity: publicRead(state) }),
    );
    await expect(page.getByText("3 / 5 份", { exact: true })).toBeVisible({
      timeout: 1_500,
    });
    await expect(entry.locator("img").first()).toHaveAttribute(
      "src",
      avatarOf("后来的人"),
    );
    expect(state.reads.public).toBe(atConnect.public);
    expect(state.reads.participation).toBe(atConnect.participation);
    // The payment goes through: `mine`, and only the viewer's part is read.
    if (state.claim)
      state.claim.payment = {
        ...paymentOf(state.claim),
        status: "confirmed",
        confirmedAt: new Date().toISOString(),
      };
    const beforeMine = { ...state.reads };
    sockets[0]?.send(JSON.stringify({ type: "mine" }));
    await expect(main.getByText("已发放")).toBeVisible({ timeout: 1_500 });
    expect(state.reads.participation).toBe(beforeMine.participation + 1);
    expect(state.reads.public).toBe(beforeMine.public);
    expect(state.reads.passwords).toBe(beforeMine.passwords);
  });

  test("登录后：进行中的红包左上角写着多少人在看，随推送变化，断线时收起", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockHongbao(page);
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
      sockets.push(ws);
      ws.onMessage((message) => {
        if (message === "ping") ws.send("pong");
      });
    });
    await openApp(page, path);
    await expect.poll(() => sockets.length).toBe(1);
    const viewers = page.locator('[data-hb-part="viewers"]');
    // Nothing until the channel says how many.
    await expect(viewers).toHaveText("");
    sockets[0]?.send(JSON.stringify({ type: "viewers", count: 3 }));
    await expect(viewers).toHaveText("3 人在看");
    sockets[0]?.send(JSON.stringify({ type: "viewers", count: 12 }));
    await expect(viewers).toHaveText("12 人在看");
    // The line drops: the number goes until the next one comes.
    await sockets[0]?.close({ code: 1012, reason: "restart" });
    await expect(viewers).toHaveText("");
    await expect.poll(() => sockets.length, { timeout: 5_000 }).toBe(2);
    sockets[1]?.send(JSON.stringify({ type: "viewers", count: 11 }));
    await expect(viewers).toHaveText("11 人在看");
  });

  test("登录后：连接断了退回轮询，重连后补读自己那份", async ({ page }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    state.claimMine();
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
      sockets.push(ws);
      ws.onMessage((message) => {
        if (message === "ping") ws.send("pong");
      });
    });
    await openApp(page, path);
    await expect.poll(() => sockets.length).toBe(1);
    await page.waitForTimeout(1_000);
    const connected = { ...state.reads };
    // A deploy drops the line: until it is back the page polls.
    await sockets[0]?.close({ code: 1012, reason: "restart" });
    await expect.poll(() => sockets.length, { timeout: 5_000 }).toBe(2);
    // Back: whatever it missed of its own is read once.
    await expect
      .poll(() => state.reads.participation)
      .toBeGreaterThan(connected.participation);
  });

  test("登录后：到截止时间页面自己翻成已结束，推送再带来结束说明", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    state.activity.deadlineAt = new Date(Date.now() + 4_000).toISOString();
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
      sockets.push(ws);
    });
    await openApp(page, path);
    await expect.poll(() => sockets.length).toBe(1);
    const main = page.locator("main");
    // Nothing is pushed or read: the clock alone turns the page over.
    await expect(main.getByText("红包已过期").first()).toBeVisible({
      timeout: 6_000,
    });
    // The DO's alarm pushes the end: its 结束说明, and every 口令 now.
    const before = state.reads.passwords;
    state.activity = {
      ...state.activity,
      status: "ended",
      afterEndInfo: "感谢参加，下周再见。",
    };
    sockets[0]?.send(
      JSON.stringify({ type: "activity", activity: publicRead(state) }),
    );
    await expect(main.getByText("感谢参加，下周再见。")).toBeVisible({
      timeout: 1_500,
    });
    await expect.poll(() => state.reads.passwords).toBe(before + 1);
  });

  test("没有 Credit 账户：5 分钟内注册后自己重新发送一次，过时不再补发", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    const claim = state.claimMine();
    claim.payment = {
      ...paymentOf(claim),
      mode: "real",
      status: "attention",
      reason: "recipient",
      resendUntil: new Date(Date.now() + 4 * 60_000).toISOString(),
    };
    const resends: (string | null)[] = [];
    await page.route("**/api/me/claims/claim-mine/resend", (route) => {
      resends.push(route.request().headers()["x-csrf-token"] ?? null);
      claim.payment = {
        ...paymentOf(claim),
        status: "reconciling",
        reason: "resend",
        resendUntil: undefined,
      };
      return route.fulfill({ json: { claim } });
    });
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
      sockets.push(ws);
    });
    await openApp(page, path);
    const main = page.locator("main");
    await expect(main.getByText("还没有 LINUX DO Credit 账户")).toBeVisible();
    // Where to open one: a new tab, never followed here.
    const register = main.getByRole("link", { name: /注册 Credit 账户/ });
    await expect(register).toHaveAttribute("href", "https://credit.linux.do");
    await expect(register).toHaveAttribute("target", "_blank");
    await expect(main.getByText(/还剩 [34]:\d\d 可以重新发送/)).toBeVisible();
    await expect(main.getByText(/只能重新发送一次/)).toBeVisible();

    await main.getByRole("button", { name: "重新发送" }).click();
    await expect(main.getByText("正在重新发送，稍等十几秒。")).toBeVisible();
    await expect(main.getByText("核对中")).toBeVisible();
    expect(resends).toEqual([csrfToken]);

    // Through: the 红包's DO says only the viewer's part moved.
    claim.payment = {
      ...paymentOf(claim),
      status: "confirmed",
      reason: null,
      confirmedAt: new Date().toISOString(),
    };
    await expect.poll(() => sockets.length).toBeGreaterThan(0);
    sockets.at(-1)?.send(JSON.stringify({ type: "mine" }));
    await expect(main.getByText("已发放")).toBeVisible({ timeout: 2_000 });

    // Another time, too late: nothing to press.
    claim.payment = {
      ...paymentOf(claim),
      status: "attention",
      reason: "recipient",
      confirmedAt: null,
      resendUntil: undefined,
    };
    await page.reload();
    await expect(main.getByText("这笔没能发出")).toBeVisible();
    await expect(
      main.getByText(/5 分钟内可以重新发送一次，现在已经不能再发/),
    ).toBeVisible();
    await expect(main.getByRole("button", { name: "重新发送" })).toHaveCount(0);

    // Past it, the payments job ends it 未发出: said the same way.
    claim.payment = { ...claim.payment, status: "failed" };
    await page.reload();
    await expect(main.getByText("未发出", { exact: true })).toBeVisible();
    await expect(main.getByText("这笔没能发出")).toBeVisible();
    await expect(main.getByText("异常待处理")).toHaveCount(0);
    expect(resends).toHaveLength(1);
  });

  test("论坛里复制的地址，表情成了 :名字:：打开和粘进指令框都到这个红包", async ({
    page,
  }) => {
    await mockSession(page, null);
    await mockHongbao(page);
    await page.routeWebSocket(/\/live$/, () => {});
    const nameOf = new Map(
      [...FORUM_EMOJI].map(([name, emoji]) => [emoji, name]),
    );
    const copied = `/:red_envelope:/${[...code]
      .map((emoji) => `:${nameOf.get(emoji)}:`)
      .join("")}`;
    await openApp(page, copied);
    await expectPath(page, path);
    await expect(
      page.getByRole("heading", { name: "周末红包", level: 1 }),
    ).toBeVisible();

    await openApp(page);
    await omniboxInput(page).click();
    await omniboxInput(page).fill(copied);
    await page.keyboard.press("Enter");
    await expectPath(page, path);
  });

  test("说明在笺卡里：一个回车就换行；窗口矮时只压缩说明，不叠在别的上面", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 560 });
    await mockSession(page, null);
    await mockHongbao(page, {
      note: [
        "周末快乐！口令藏在帖子一楼。",
        "每人限领一次。",
        "",
        ...Array.from({ length: 8 }, (_, line) => `第 ${line + 1} 行说明`),
      ].join("\n"),
    });
    await openApp(page, path);
    const card = page.locator(".hb-cover-note-card");
    await expect(card).toBeVisible();
    // One Enter is a new line (07 §5), a blank line a new paragraph; no
    // quotes around it any more (04 §3).
    const first = card.locator("p").first();
    await expect(first.locator("br")).toHaveCount(1);
    await expect(first).toHaveText(
      /^周末快乐！口令藏在帖子一楼。\n每人限领一次。$/,
    );
    expect(
      await first.evaluate((p) => getComputedStyle(p, "::before").content),
    ).toBe("none");

    // Short window: only the 说明 gives way, to two lines; the title keeps
    // its height and 展开全文 stays inside the card, above the numbers.
    const more = page.getByRole("button", { name: "展开全文" });
    await expect(more).toBeVisible();
    const layout = () =>
      page.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(selector);
          return element.getBoundingClientRect();
        };
        const title = document.querySelector(".hb-cover-title") as HTMLElement;
        const face = document.querySelector(
          "[data-hb-part=cover]",
        ) as HTMLElement;
        return {
          titleClipped: title.scrollHeight - title.clientHeight,
          noteHeight: box(".hb-cover-note-text").height,
          moreBelowCard:
            box("#note-more").bottom - box(".hb-cover-note-card").bottom,
          cardIntoNumbers:
            box(".hb-cover-note-card").bottom -
            box("[data-hb-part=cover] dl").top,
          pastTheRed:
            (face.firstElementChild as HTMLElement).offsetHeight -
            face.offsetHeight,
          coverHeight: face.offsetHeight,
        };
      });
    await expect
      .poll(async () => (await layout()).pastTheRed)
      .toBeLessThanOrEqual(1);
    const roomy = await layout();
    expect(roomy.titleClipped).toBe(0);
    expect(roomy.noteHeight).toBeGreaterThanOrEqual(48);
    expect(roomy.moreBelowCard).toBeLessThan(0);
    expect(roomy.cardIntoNumbers).toBeLessThan(0);

    // Shorter than even that holds: the cover grows past the window and the
    // page scrolls, rather than one part being drawn over another.
    await page.setViewportSize({ width: 700, height: 460 });
    await expect
      .poll(async () => (await layout()).pastTheRed)
      .toBeLessThanOrEqual(1);
    const tight = await layout();
    expect(tight.titleClipped).toBe(0);
    expect(tight.noteHeight).toBeGreaterThanOrEqual(48);
    expect(tight.moreBelowCard).toBeLessThan(0);
    expect(tight.cardIntoNumbers).toBeLessThan(0);
    expect(tight.coverHeight).toBeGreaterThan(460);
  });

  test("游客：大红包皮、说明全文、领取名单和分享", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, null);
    await mockHongbao(page);
    let live = 0;
    await page.routeWebSocket(/\/live$/, () => {
      live += 1;
    });
    await openApp(page, path);
    await expect(page).toHaveTitle("周末红包 · lafish的红包站");
    await expect(
      page.getByRole("heading", { name: "周末红包", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("小满的红包")).toBeVisible();
    // The labels say how to take part and the 玩法, each explaining itself;
    // the amounts are the numbers under them, not repeated in a label.
    const play = page.getByRole("button", { name: "固定均分" });
    await expect(page.getByRole("button", { name: "口令红包" })).toBeVisible();
    await expect(play).toHaveAccessibleDescription("每份金额一样。");
    // A squircle like every other label: its shape reaches the button.
    await expect(play).toHaveAttribute("data-squircle", "");
    await expect(page.getByText(/LDC \/ 份/)).toHaveCount(0);
    await expect(page.getByText("每份 0.10 LDC")).toBeVisible();
    const bubble = page.locator("p").filter({ hasText: "每份金额一样。" });
    await play.hover();
    await expect(bubble).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(bubble).toBeHidden();
    await expect(page.getByRole("button", { name: "需人机验证" })).toHaveCount(
      0,
    );
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

    // 分享 opens its panel (05 §5): a guest sees no 口令, so 发到社区 offers
    // the link and the image, 发到别处 the plain link.
    const origin = new URL(page.url()).origin;
    const shareButton = page.getByRole("button", { name: "分享" });
    await shareButton.click();
    const share = page.getByRole("dialog", { name: "分享红包" });
    await expect(share).toBeVisible();
    const where = share.getByRole("group", { name: "发到哪" });
    const what = share.getByRole("group", { name: "发什么" });
    await expect(
      where.getByRole("button", { name: "发到社区" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(what.getByRole("button")).toHaveText([
      "红包链接点链接或整段粘贴都能打开",
      "红包实况图嵌入帖子，实时更新",
    ]);
    // The preview shows the post, the copy waits behind 原文; 红包页 leads
    // to the site unless asked.
    await expect(share.getByText(`/🧧/${code}`)).toBeVisible();
    await expect(share.getByText("“红包页”链到这个红包")).toBeVisible();
    const copyButton = share.getByRole("button", { name: "复制红包链接" });
    await copyButton.click();
    await expect(
      page.getByRole("status").filter({ hasText: "已复制发到社区的红包链接" }),
    ).toHaveCount(1);
    await expect
      .poll(() => readClipboard(page))
      .toBe(
        `【周末红包】\n\`\`\`\n/🧧/${code}\n\`\`\`\n复制上面这段，粘贴到[红包页](${origin}/%F0%9F%A7%A7/${encodeURIComponent(code)})的输入框即可打开红包。`,
      );
    // Copied, it says so and stays open for another.
    await expect(share.getByRole("button", { name: "已复制" })).toBeVisible();
    await expect(share).toBeVisible();
    // Or the site's post, as before.
    await share
      .getByRole("switch", { name: "改链到社区里的红包站主贴" })
      .click();
    await expect(
      share.getByText("“红包站”链到社区里的红包站主贴"),
    ).toBeVisible();
    await expect(what.getByRole("button").first()).toHaveText(
      "红包链接不直接链到站外，整段粘贴就能打开",
    );
    await share.getByRole("button", { name: "复制红包链接" }).click();
    await expect
      .poll(() => readClipboard(page))
      .toContain("粘贴到[红包站](https://linux.do/t/3033290)的输入框");

    // 原文 is a dialog over it: Esc closes only that one.
    await share.getByRole("button", { name: "原文" }).click();
    const raw = page.getByRole("dialog", { name: "原文" });
    await expect(raw.locator("pre")).toContainText(
      "粘贴到[红包站](https://linux.do/t/3033290)的输入框",
    );
    await page.keyboard.press("Escape");
    await expect(raw).toBeHidden();
    await expect(share).toBeVisible();

    // 红包实况图: its sizes, 300 × 400 first; the post's link, or this 红包.
    await what.getByRole("button", { name: /^红包实况图/ }).click();
    const sizes = share.getByRole("group", { name: "大小" });
    await expect(sizes.getByRole("button")).toHaveText([
      "300 × 400",
      "360 × 480",
      "420 × 560",
    ]);
    await expect(
      sizes.getByRole("button", { name: "300 × 400" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(share.getByText("点图打开社区里的红包站主贴")).toBeVisible();
    await share.getByRole("button", { name: "复制实况图代码" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "已复制发到社区的红包实况图 300 × 400" }),
    ).toHaveCount(1);
    await expect
      .poll(() => readClipboard(page))
      .toBe(
        [
          '<a href="https://linux.do/t/3033290">',
          `<picture><source type="image/svg+xml" srcset="${origin}/%F0%9F%A7%A7/${encodeURIComponent(code)}/%F0%9F%96%BC%EF%B8%8F.svg 1x"><img width="300" height="400" `,
          `alt="小满的红包：${code}"></picture>`,
          "</a>",
        ].join("\n"),
      );
    await share
      .getByRole("switch", { name: "改链到社区里的红包站主贴" })
      .click();
    await sizes.getByRole("button", { name: "420 × 560" }).click();
    await expect(share.getByText("点图打开这个红包")).toBeVisible();
    await share.getByRole("button", { name: "复制实况图代码" }).click();
    await expect
      .poll(() => readClipboard(page))
      .toMatch(
        new RegExp(
          `^<a href="${origin}/%F0%9F%A7%A7/${encodeURIComponent(code)}">\n.*<img width="420" height="560" `,
          "u",
        ),
      );

    // 发到别处: the plain link.
    await where.getByRole("button", { name: "发到别处" }).click();
    await expect(what.getByRole("button")).toHaveText([
      "网页链接完整网址，可直接打开",
    ]);
    await share.getByRole("button", { name: "复制网页链接" }).click();
    await expect.poll(() => readClipboard(page)).toBe(`${origin}/🧧/${code}`);
    // Esc closes it, focus back on 分享; it opens on the choice left.
    await page.keyboard.press("Escape");
    await expect(share).toBeHidden();
    await expect(shareButton).toBeFocused();
    await shareButton.click();
    await expect(
      share.getByRole("group", { name: "发到哪" }).getByRole("button", {
        name: "发到别处",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    // A guest polls: no live channel.
    expect(live).toBe(0);
  });

  test("整段粘贴分享文案：起始页认出红包和口令，回车打开红包就自动领取", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    await openApp(page);
    // What 分享 hands out, as copied from the forum's code block.
    const shared = forumShareWithPassword(
      { id, title: "周末红包", draw: false, pageOnly: true },
      passwordOf.mine,
      { page: `https://hb.lafi.sh/🧧/${code}` },
    );
    await page.evaluate((text) => navigator.clipboard.writeText(text), shared);
    await omniboxInput(page).click();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(omniboxInput(page)).toHaveValue(`/🧧/${code}`);
    await expect(shown(page, "已识别口令，打开红包后自动提交。")).toBeVisible();
    await page.keyboard.press("Enter");
    await expectPath(page, path);
    await expect(
      page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
    ).toHaveCount(1);
    expect(state.claims).toMatchObject([{ password: passwordOf.mine }]);
  });

  // Only 代码判定's box joins pasted lines (02 §6): a 口令's keeps them, to
  // be marked rather than quietly dropped.
  test("口令红包的框粘贴多行文字：换行照样留着、标出来，不换成空格", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    await mockHongbao(page);
    await openApp(page, path);
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      "周末口令\n2026",
    );
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await expect(omniboxInput(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(omniboxInput(page)).toHaveValue("周末口令\n2026");
    await expect(shown(page, "粘贴的换行已换成空格")).toHaveCount(0);
  });

  // 分享's forum copy links to the 红包页 itself (05 §5): there the whole
  // paragraph goes into its box, which keeps only the 口令 (02 §6).
  test("红包页上整段粘贴分享文案：输入框只留下口令，按领取就领", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    await openApp(page, path);
    const shared = forumShareWithPassword(
      { id, title: "周末红包", draw: false, pageOnly: false },
      passwordOf.mine,
      { page: `${new URL(page.url()).origin}/🧧/${code}` },
    );
    await page.evaluate((text) => navigator.clipboard.writeText(text), shared);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await expect(omniboxInput(page)).toBeFocused();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(omniboxInput(page)).toHaveValue(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
    ).toHaveCount(1);
    expect(state.claims).toMatchObject([{ password: passwordOf.mine }]);
  });

  test("关闭了首页领取的红包：标签说明怎么领；输入口令时写明会汇总给红包作者", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    state.activity = { ...state.activity, forceDedicated: true };
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "关闭首页领取", exact: true }),
    ).toHaveAccessibleDescription(/^红包作者关闭首页领取后/);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await expect(shown(page, "输入的口令会匿名汇总给红包作者。")).toBeVisible();
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
    // The 口令 used is in the 口令区 only, not again on the result (05 §3),
    // and while it runs it starts hidden behind an eye: a screenshot must
    // not give it away. (The folded 指令框 still holds what was typed; it
    // is not on screen.)
    const main = page.getByRole("main");
    const result = page.locator("[data-hb-part=result]");
    const section = page.locator("[data-hb-part=passwords]");
    await expect(main.getByText(passwordOf.mine)).toHaveCount(0);
    await expect(result.getByRole("button", { name: "显示口令" })).toHaveCount(
      0,
    );
    await expect(result).toContainText("金额、发放状态和附言仅你可见");
    const used = section
      .getByRole("listitem")
      .filter({ hasText: "已用此口令领取" });
    await expect(used).toContainText("已隐藏");
    await used.getByRole("button", { name: "显示口令 1" }).click();
    await expect(used).toContainText(passwordOf.mine);
    await expect(result.getByText(passwordOf.mine)).toHaveCount(0);
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
    await expect(page.getByText("口令已解出，不会再领一次。")).toBeVisible();
    const solved = section.getByRole("listitem").filter({ hasText: "已解出" });
    await expect(solved).toContainText("已隐藏");
    await section.getByRole("button", { name: "显示全部口令" }).click();
    await expect(solved).toContainText(passwordOf.other);
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

    // 分享 now offers both links with a 口令: the ones the viewer knows (the
    // one used and the one verified), numbered, the chosen one previewed.
    await page.getByRole("button", { name: "分享" }).click();
    const share = page.getByRole("dialog", { name: "分享红包" });
    const what = share.getByRole("group", { name: "发什么" });
    await expect(what.getByRole("button")).toHaveText([
      /^红包链接点链接或整段粘贴都能打开/,
      "红包链接与口令整段粘贴到输入框就能领",
      "红包实况图嵌入帖子，实时更新",
    ]);
    await what.getByRole("button", { name: /^红包链接与口令/ }).click();
    const which = share.getByRole("group", { name: "口令" });
    await expect(which.getByRole("button")).toHaveText(["口令 1", "口令 2"]);
    await expect(share.getByText(`口令：${passwordOf.mine}`)).toBeVisible();
    await which.getByRole("button", { name: "口令 2" }).click();
    await expect(share.getByText(`口令：${passwordOf.other}`)).toBeVisible();
    await which.getByRole("button", { name: "口令 1" }).click();
    await share.getByRole("button", { name: "复制红包链接与口令" }).click();
    const origin = new URL(page.url()).origin;
    await expect
      .poll(() => readClipboard(page))
      .toBe(
        `【周末红包】\n\`\`\`\n/🧧/${code}\n口令：${passwordOf.mine}\n\`\`\`\n复制上面这段，粘贴到[红包页](${origin}/%F0%9F%A7%A7/${encodeURIComponent(code)})的输入框即可领取。`,
      );
    await share
      .getByRole("group", { name: "发到哪" })
      .getByRole("button", { name: "发到别处" })
      .click();
    await what.getByRole("button", { name: /^网页链接与口令/ }).click();
    await share.getByRole("button", { name: "复制网页链接与口令" }).click();
    await expect
      .poll(() => readClipboard(page))
      .toBe(`【周末红包】\n${origin}/🧧/${code}\n口令：${passwordOf.mine}`);
    await page.keyboard.press("Escape");
    await expect(share).toBeHidden();

    // Ended (the last share went): every 口令 plain, and no eye anywhere.
    state.activity = {
      ...state.activity,
      quantity: { mode: "exact", total: 3, claimed: 3, remaining: 0 },
    };
    await page.reload();
    await expect(section.getByText(passwordOf.mine)).toBeVisible();
    await expect(section.getByText(passwordOf.other)).toBeVisible();
    await expect(page.getByRole("button", { name: /^显示/ })).toHaveCount(0);
  });

  test("口令多时折起：先显示 5 行，刚解出的在折起处就展开；分享时口令换成列表", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const more = Array.from(
      { length: 6 },
      (_, index) => `更多口令2026${index}`,
    );
    await mockHongbao(page, { more });
    await openApp(page, path);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
    ).toHaveCount(1);
    const section = page.locator("[data-hb-part=passwords]");
    const rows = section.getByRole("listitem");
    await expect(section.getByText("口令 · 8 个 · 7 个未解出")).toBeVisible();
    await expect(rows).toHaveCount(5);
    await section.getByRole("button", { name: "展开全部 8 个" }).click();
    await expect(rows).toHaveCount(8);
    await section.getByRole("button", { name: "收起" }).click();
    await expect(rows).toHaveCount(5);

    // The fifth solved is the sixth row, folded away: the list opens on it.
    const solving = [passwordOf.other, ...more.slice(0, 4)];
    const lastSolved = more[3] ?? "";
    for (const [index, text] of solving.entries()) {
      await page.getByRole("button", { name: "验证其他口令" }).click();
      await omniboxInput(page).fill(text);
      await page.keyboard.press("Enter");
      await expect(
        section.getByText(`口令 · 8 个 · ${6 - index} 个未解出`),
      ).toBeVisible();
    }
    await expect(rows).toHaveCount(8);
    await expect(rows.nth(5)).toContainText("已解出");
    await expect(section.getByRole("button", { name: "收起" })).toBeVisible();

    // 分享: more than five known, so a list of them, numbered.
    await page.getByRole("button", { name: "分享" }).click();
    const share = page.getByRole("dialog", { name: "分享红包" });
    await share
      .getByRole("group", { name: "发什么" })
      .getByRole("button", { name: /^红包链接与口令/ })
      .click();
    const which = share.getByRole("group", { name: "口令" });
    const known = [passwordOf.mine, ...solving];
    await expect(which.getByRole("button")).toHaveText(
      known.map((text, index) => new RegExp(`^${index + 1}\\s*${text}$`)),
    );
    await expect(which.getByRole("button").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const last = which.getByRole("button", { name: new RegExp(lastSolved) });
    await last.click();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect(share.getByText(`口令：${lastSolved}`)).toBeVisible();
  });

  test("拼手气的标签带上分法，奖池下面写平均每份多少", async ({ page }) => {
    await mockSession(page, null);
    const state = await mockHongbao(page);
    state.activity = {
      ...state.activity,
      reward: {
        mode: "random",
        totalAmount: "10.00",
        count: 3,
        algorithm: "bounded_mean_v1",
      },
    };
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "拼手气 · 支付宝同款" }),
    ).toHaveAccessibleDescription(
      "均值上下 50%：每份在平均值上下 50% 之间随机，金额比较接近。",
    );
    await expect(page.getByText("平均约 3.33 LDC")).toBeVisible();
    await expect(page.getByText("10.00 LDC 奖池")).toHaveCount(0);
  });

  test("领取前人机验证：口令对了才弹窗，关掉不领，转圈通过后自动领取", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await fakeTurnstile(page);
    const state = await mockHongbao(page, { humanCheck: true });
    await openApp(page, path);
    // The cover says so up front, and what it may cost.
    await expect(
      page.getByRole("button", { name: "需人机验证" }),
    ).toHaveAccessibleDescription(/领取前要先通过 Cloudflare 人机验证/);
    await page.getByRole("button", { name: "输入口令领取" }).click();
    const dialog = page.getByRole("dialog", { name: "人机验证" });
    // A wrong 口令 never asks.
    await omniboxInput(page).fill("不对的口令2026");
    await page.keyboard.press("Enter");
    await expect(shown(page, /^口令不正确/)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: /还需等待 \d 秒/ }),
    ).toBeHidden({ timeout: 10_000 });

    // Asked, then closed before it passes: nothing is claimed.
    await page.evaluate(() => {
      (window as { __turnstileDelay?: number }).__turnstileDelay = 60_000;
    });
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "这是 @author 的要求：领取这个红包需要先通过人机验证，通过后会自动领取。",
    );
    await expect(dialog.getByText("正在验证…")).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toBeHidden();
    await expect(shown(page, "没有完成人机验证，这次没有领取。")).toBeVisible();
    expect(state.claims).toHaveLength(2);

    // Asked again: the spinner passes, and the same submission claims.
    await page.evaluate(() => {
      (window as { __turnstileDelay?: number }).__turnstileDelay = 400;
    });
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "已领取 0.10 LDC。" }),
    ).toHaveCount(1);
    await expect(dialog).toBeHidden();
    const [, , asked, passed] = state.claims as Array<{
      submissionId: string;
      humanToken?: string;
    }>;
    expect(state.claims).toHaveLength(4);
    expect(asked?.humanToken).toBeUndefined();
    expect(passed).toEqual({
      submissionId: asked?.submissionId,
      password: passwordOf.mine,
      humanToken: "e2e-turnstile-token",
    });
    expect(
      await page.evaluate(
        () => (window as { __turnstileRenders?: unknown[] }).__turnstileRenders,
      ),
    ).toEqual([
      {
        sitekey: "1x00000000000000000000AA",
        action: "claim",
        cData: id,
        language: "zh-cn",
      },
      {
        sitekey: "1x00000000000000000000AA",
        action: "claim",
        cData: id,
        language: "zh-cn",
      },
    ]);
  });

  test("我的结果：付款原因写成中文，不露出原因码", async ({ page }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    state.claim = {
      id: "claim-mine",
      activity: { id, title: "周末红包", status: "active" },
      rewardType: "ldc",
      claimedAt: new Date().toISOString(),
      sourcePassword: passwordOf.mine,
      amount: "0.10",
      afterClaimInfo: "",
      payment: {
        id: "payment-mine",
        mode: "real",
        status: "waiting",
        reason: "quota",
        confirmedAt: null,
        // A few minutes past the next midnight in Shanghai.
        quotaResumeAt: new Date(
          Math.floor((Date.now() + 8 * 3_600_000) / 86_400_000) * 86_400_000 +
            86_400_000 -
            8 * 3_600_000 +
            10 * 60_000,
        ).toISOString(),
      },
    };
    await openApp(page, path);
    const result = page.locator("[data-hb-part=result]");
    await expect(result.getByText("等待恢复")).toBeVisible();
    await expect(
      result.getByText(
        "红包作者今天在 Credit 站的发放额度用完了，明天 0 点后自动继续发放。",
      ),
    ).toBeVisible();
    await expect(result.getByText("quota")).toHaveCount(0);
  });

  test("红包作者：看到全部口令；也能自领，先确认一次，不付款，名单上是自领的屑", async ({
    page,
  }) => {
    await mockSession(page, author);
    const state = await mockHongbao(page);
    // The sender's own share, once taken (自领, docs/self-claim-design.md).
    let own: AuthorClaim | null = null;
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
        json: {
          items: [
            {
              id: "claim-viewer",
              activity: { id, title: "周末红包", status: "active" },
              rewardType: "ldc",
              claimedAt: new Date(Date.parse(openedAt) + 60_000).toISOString(),
              sourcePassword: passwordOf.mine,
              amount: "0.10",
              payment: {
                id: "payment-viewer",
                mode: "simulation",
                status: "confirmed",
                reason: null,
                confirmedAt: new Date().toISOString(),
              },
              claimant: {
                id: viewer.id,
                username: viewer.username,
                displayName: viewer.displayName,
                avatarUrl: null,
              },
            },
            ...(own ? [own] : []),
          ],
          nextCursor: null,
        } satisfies AuthorClaimList,
      }),
    );
    await openApp(page, path);
    const seal = page.getByRole("button", { name: "输入口令领取" });
    await expect(seal).toBeEnabled();
    // Even the sender's own 口令 start hidden while it runs.
    const section = page.locator("[data-hb-part=passwords]");
    await expect(
      section.getByRole("listitem").filter({ hasText: "你设置的" }),
    ).toHaveCount(2);
    const main = page.getByRole("main");
    await expect(main.getByText(passwordOf.mine)).toHaveCount(0);
    await section.getByRole("button", { name: "显示全部口令" }).click();
    for (const password of [passwordOf.mine, passwordOf.other])
      await expect(
        section.getByRole("listitem").filter({ hasText: password }),
      ).toContainText("你设置的");
    // So do the 口令 on the sender's 名单, behind one eye.
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await expect(roster.getByText(viewer.displayName)).toBeVisible();
    await expect(roster.getByText(passwordOf.mine)).toHaveCount(0);
    await roster.getByRole("button", { name: "显示名单里的口令" }).click();
    await expect(roster.getByText(passwordOf.mine)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "编辑" })).toHaveAttribute(
      "href",
      `/🧧/${code}/📝`,
    );
    await expect(page.getByRole("link", { name: "付款记录" })).toBeVisible();
    await expect(page.getByText("关闭了首页领取", { exact: true })).toHaveCount(
      0,
    );

    // 首页领取 off: it is shared from here, so here it says how.
    state.activity = { ...state.activity, forceDedicated: true };
    await page.reload();
    await expect(
      page.getByText("关闭了首页领取", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "领取者只能在红包页输入口令。请通过“分享”复制文案，文案中带有红包入口。",
      ),
    ).toBeVisible();

    // 自领: asked once before it goes; 返回 sends nothing, the 口令 stays.
    const sent: unknown[] = [];
    await page.route(`**/api/activities/${id}/claim`, (route) => {
      sent.push(route.request().postDataJSON());
      const claimedAt = new Date().toISOString();
      state.claim = {
        id: "claim-own",
        activity: { id, title: "周末红包", status: "active" },
        rewardType: "ldc",
        claimedAt,
        sourcePassword: passwordOf.mine,
        amount: "0.10",
        afterClaimInfo: "",
        self: true,
      };
      own = {
        id: "claim-own",
        activity: { id, title: "周末红包", status: "active" },
        rewardType: "ldc",
        claimedAt,
        sourcePassword: passwordOf.mine,
        amount: "0.10",
        self: true,
        claimant: {
          id: author.id,
          username: author.username,
          displayName: author.displayName,
          avatarUrl: null,
        },
      };
      state.recipients = [
        ...state.recipients,
        {
          ...recipient(author.username, 7),
          displayName: author.displayName,
          claimedAt,
          self: true,
        },
      ];
      return route.fulfill({
        json: { result: "claimed", claim: state.claim } satisfies ClaimResult,
      });
    });
    await seal.click();
    await expect(omniboxInput(page)).toBeFocused();
    await omniboxInput(page).fill(passwordOf.mine);
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("dialog", { name: "领自己的红包" });
    await expect(confirm).toContainText("会占掉一份，名单里显示「自领的屑」。");
    await confirm.getByRole("button", { name: "返回" }).click();
    await expect(confirm).toBeHidden();
    expect(sent).toHaveLength(0);
    await expect(omniboxInput(page)).toHaveValue(passwordOf.mine);
    await omniboxInput(page).press("Enter");
    await confirm.getByRole("button", { name: "领取" }).click();
    await expect.poll(() => sent.length).toBe(1);
    // Where it is, to the sender alone; 自领的屑 and no payment to follow.
    const result = page.locator("[data-hb-part=result]");
    await expect(result.getByText("自领", { exact: true })).toBeVisible();
    await expect(
      result.getByText("这份没有发出去，钱还在付款的商户账户里。"),
    ).toBeVisible();
    await expect(result.getByText("自领的屑")).toBeVisible();
    await expect(result.getByText("待发放")).toHaveCount(0);
    // The 口令 it went with is marked as anyone's would be; the rest are theirs.
    await expect(
      section.getByRole("listitem").filter({ hasText: "已用此口令领取" }),
    ).toHaveCount(1);
    await expect(
      section.getByRole("listitem").filter({ hasText: "你设置的" }),
    ).toHaveCount(1);
  });

  test("别人打开草稿：未开放，「开」变淡点不了；能分享；开放后自己变成可以领取", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockHongbao(page);
    const opened = state.activity;
    state.activity = {
      ...opened,
      status: "draft",
      openedAt: null,
      deadlineAt: null,
      quantity: { mode: "exact", total: 3, claimed: 0, remaining: 3 },
      draftDeadline: { mode: "duration", value: 7, unit: "days" },
    };
    state.recipients = [];
    await openApp(page, path);
    await expect(
      page.getByRole("heading", { name: "周末红包", level: 1 }),
    ).toBeVisible();
    const tag = page.getByRole("button", { name: "未开放" });
    await expect(tag).toHaveAccessibleDescription(
      "还没开放，开放后才能领取；开放前红包作者还能改。",
    );
    const seal = page.getByRole("button", {
      name: "还没开放，开放后才能领取",
    });
    await expect(seal).toHaveText("开");
    await expect(seal).toHaveAttribute("aria-disabled", "true");
    // Its deadline as set, counted from opening.
    await expect(page.getByText("开放后 7 天")).toBeVisible();
    // Not the sender's: no 草稿预览, no tools.
    await expect(page.locator("[data-hb-part=author]")).toHaveCount(0);
    await page.getByRole("button", { name: "分享" }).click();
    const share = page.getByRole("dialog", { name: "分享红包" });
    await expect(
      share.getByText("还没开放：拿到链接的人现在就能看到，开放后才能领取。"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    // It opens: the next read (every 5 s for a draft) turns it.
    state.activity = opened;
    await expect(page.getByRole("button", { name: "未开放" })).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(
      page.getByRole("button", { name: /输入口令领取/ }),
    ).toBeVisible();
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

test.describe("红包页 · 手机", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

  test("点一下标签看说明，再点一下或点别处收起", async ({ page }) => {
    await mockSession(page, null);
    await mockHongbao(page);
    await openApp(page, path);
    const play = page.getByRole("button", { name: "固定均分" });
    const bubble = page.locator("p").filter({ hasText: "每份金额一样。" });
    await play.tap();
    await expect(bubble).toBeVisible();
    await play.tap();
    await expect(bubble).toBeHidden();
    await play.tap();
    await expect(bubble).toBeVisible();
    await page.getByRole("heading", { name: "周末红包", level: 1 }).tap();
    await expect(bubble).toBeHidden();
  });
});
