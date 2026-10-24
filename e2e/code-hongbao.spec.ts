import { createHash } from "node:crypto";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  type ActivityPasswords,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimResult,
  type CodeFailureList,
  type DiscoveryCard,
  type DiscoveryList,
  emptyActivityInput,
  encodeActivityEmoji,
  type ManagedActivity,
  type MyJudgment,
  type MyJudgmentList,
  type ParticipationList,
  type PublicActivity,
  type PublicJudge,
  type PublicRecipient,
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

// 代码判定红包 (docs/programmable-hongbao-design.md) on the web, against a
// mocked API that keeps its own state: the lacquer cover and its counts,
// the 代码判定 scope in the 指令框, 我的提交, the 代码 dialog, the paused,
// ended and stopped looks, the lists, and the code step of 发红包.

const id = "51515151-6262-4737-8848-595959595959";
const path = `/🧧/${encodeActivityEmoji(id)}`;
const title = "猜数字红包";
const prompt = "猜一个 1 到 100 的数";
/** The one input the mocked code pays for. */
const answer = "42";

const author: MockUser = {
  id: "author-e2e",
  username: "author",
  displayName: "小满",
  avatarUrl: null,
  isAdmin: false,
  balance: true,
  balancePlus: true,
};
const authorProfile = {
  id: author.id,
  username: author.username,
  displayName: author.displayName,
  avatarUrl: null,
};

/** judge.js as its sender pasted it: five lines. */
const judgeCode = [
  "export function judge(submission, tools) {",
  `  const guess = Number(submission.input);`,
  `  if (guess === ${answer}) return { ok: true, amount: tools.money.even(), message: "猜对了！" };`,
  `  return { ok: false, message: guess > ${answer} ? "大了" : "小了" };`,
  "}",
].join("\n");
const seed = "5eed".repeat(16);
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const fingerprint = sha256(judgeCode);
const seedCommitment = sha256(`hb.lafi.sh/judge/v1\n${id}\n${seed}`);

const openedAt = new Date(Date.now() - 10 * 60_000).toISOString();

function publicActivity(): PublicActivity {
  return {
    id,
    title,
    rewardType: "ldc",
    participationMode: "code",
    // Only ever from 🐟额, and only on its page (§1, §3).
    funding: "balance",
    status: "active",
    author: authorProfile,
    forceDedicated: true,
    topicUrl: null,
    openedAt,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    quantity: { mode: "exact", total: 5, claimed: 1, remaining: 4 },
    reward: { mode: "code", totalAmount: "1.00", count: 5, minEach: "0.01" },
    beforeInfo: "猜对了就有。",
  };
}

function publicJudge(): PublicJudge {
  return { protocol: 1, prompt, fingerprint, seedCommitment, judged: 7 };
}

function recipient(
  name: string,
  minutes: number,
  attempt: number,
): PublicRecipient {
  return {
    id: `claim-${name}`,
    username: name,
    displayName: name,
    avatarUrl: null,
    claimedAt: new Date(Date.parse(openedAt) + minutes * 60_000).toISOString(),
    amount: "0.20",
    attempt,
  };
}

/** Earlier judged submissions of the viewer's, newest first, all turned down. */
function rejected(count: number): MyJudgment[] {
  return Array.from({ length: count }, (_, index) => {
    const attempt = count - index;
    return {
      attempt,
      at: new Date(Date.parse(openedAt) + attempt * 10_000).toISOString(),
      input: `答案-${attempt}`,
      message: "小了",
    };
  });
}

type CodeState = {
  activity: PublicActivity;
  judge: PublicJudge;
  recipients: PublicRecipient[];
  claim: ClaimDetail | null;
  /** 我的提交, newest first. */
  judgments: MyJudgment[];
  /** What each claim sent. */
  submissions: { participationMode?: string; input?: string }[];
  /** The cursor of each read of 我的提交 (null: the first page). */
  judgmentReads: (string | null)[];
  reads: { public: number; participation: number };
};

const publicRead = (state: CodeState): PublicActivity => ({
  ...state.activity,
  judge: state.judge,
  rosterPreview: [...state.recipients]
    .reverse()
    .slice(0, 5)
    .map(({ id, username, displayName, avatarUrl }) => ({
      id,
      username,
      displayName,
      avatarUrl,
    })),
});

/**
 * One 代码判定红包's server, mocked: its reads, 我的提交 twenty at a time,
 * and claims judged as the code above would (42 pays 0.30, capped).
 */
async function mockCodeHongbao(page: Page, judgments: MyJudgment[] = []) {
  // A 🐟额红包's claimant: under 1 in 🐟额 still.
  await page.route("**/api/me/balance/hongbao", (route) =>
    route.fulfill({ json: { available: false, availableMinor: 10 } }),
  );
  const state: CodeState = {
    activity: publicActivity(),
    judge: publicJudge(),
    recipients: [recipient("早到的人", 1, 3)],
    claim: null,
    judgments,
    submissions: [],
    judgmentReads: [],
    reads: { public: 0, participation: 0 },
  };
  await page.route(`**/api/activities/${id}**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rest = url.pathname.slice(`/api/activities/${id}`.length);
    if (rest === "" && request.method() === "GET") {
      state.reads.public += 1;
      return route.fulfill({ json: { activity: publicRead(state) } });
    }
    if (rest === "/participation") {
      state.reads.participation += 1;
      return route.fulfill({
        json: { claim: state.claim, registration: null },
      });
    }
    if (rest === "/passwords")
      return route.fulfill({
        json: {
          passwords: [],
          hiddenCount: 0,
          canSolve: false,
        } satisfies ActivityPasswords,
      });
    if (rest === "/recipients")
      return route.fulfill({
        json: {
          items: state.recipients,
          nextCursor: null,
          titles: { highestClaimIds: [], lowestClaimIds: [] },
        },
      });
    if (rest === "/judgments") {
      const cursor = url.searchParams.get("cursor");
      state.judgmentReads.push(cursor);
      const from = Number(cursor ?? 0);
      const items = state.judgments.slice(from, from + 20);
      return route.fulfill({
        json: {
          items,
          total: state.judgments.length,
          nextCursor:
            from + 20 < state.judgments.length ? String(from + 20) : null,
        } satisfies MyJudgmentList,
      });
    }
    if (rest === "/claim" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        participationMode?: string;
        input?: string;
      };
      state.submissions.push(body);
      const attempt = state.judgments.length + 1;
      const at = new Date().toISOString();
      state.judge = { ...state.judge, judged: state.judge.judged + 1 };
      // The 红包's DO puts the account's cooldown on every claim answer: a
      // code claim takes no local ticket, so this is what starts it.
      const attemptCooldown = {
        revision: state.submissions.length,
        serverTime: Date.now(),
        nextAllowedAt: Date.now() + 2_000,
      };
      if (body.input === answer) {
        state.judgments.unshift({
          attempt,
          at,
          input: answer,
          message: "猜对了！",
          amount: "0.30",
          note: "cap",
        });
        state.claim = {
          id: "claim-mine",
          activity: {
            id,
            title,
            status: "active",
            funding: "balance",
            participationMode: "code",
          },
          rewardType: "ldc",
          claimedAt: at,
          amount: "0.30",
          afterClaimInfo: "",
          judge: { input: answer, message: "猜对了！", note: "cap", attempt },
        };
        return route.fulfill({
          json: {
            result: "claimed",
            claim: state.claim,
            attemptCooldown,
          } satisfies ClaimResult,
        });
      }
      const message = Number(body.input) > Number(answer) ? "大了" : "小了";
      state.judgments.unshift({
        attempt,
        at,
        input: body.input ?? "",
        message,
      });
      return route.fulfill({
        json: {
          result: "rejected",
          message,
          attemptCooldown,
        } satisfies ClaimResult,
      });
    }
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  return state;
}

/** The live channel, open and answering pings; the sockets it opened. */
async function mockLive(page: Page) {
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/activities\/[^/]+\/live$/, (ws) => {
    sockets.push(ws);
    ws.onMessage((message) => {
      if (message === "ping") ws.send("pong");
    });
  });
  return sockets;
}

/**
 * The sender's own reads: the 红包 as saved, no 出错记录, and the 名单 with
 * each claim's input and both amounts (07 §6).
 */
async function mockSenderReads(page: Page) {
  const managed: ManagedActivity = {
    id,
    title,
    rewardType: "ldc",
    participationMode: "code",
    funding: "balance",
    forceDedicated: true,
    status: "active",
    version: 2,
    createdAt: openedAt,
    openedAt,
    deadlineAt: publicActivity().deadlineAt,
    topicUrl: null,
    totalCount: 5,
    claimedCount: 1,
    author: authorProfile,
    judgePassed: true,
    config: {
      ...emptyActivityInput(),
      title,
      participationMode: "code",
      funding: "balance",
      forceDedicated: true,
      joinSquare: true,
      money: {
        mode: "code",
        totalAmount: "1.00",
        count: 5,
        minEach: "0.01",
      },
      judge: { prompt, code: judgeCode, tests: '{ "tests": [] }' },
    },
  };
  await page.route(`**/api/me/activities/${id}**`, (route) => {
    const rest = new URL(route.request().url()).pathname.slice(
      `/api/me/activities/${id}`.length,
    );
    if (rest === "") return route.fulfill({ json: { activity: managed } });
    if (rest === "/code-failures")
      return route.fulfill({
        json: {
          items: [],
          failuresInRow: 0,
          pausedAt: null,
        } satisfies CodeFailureList,
      });
    if (rest === "/claims")
      return route.fulfill({
        json: {
          items: [
            {
              id: "claim-早到的人",
              activity: { id, title, status: "active", funding: "balance" },
              rewardType: "ldc",
              claimedAt: new Date(Date.parse(openedAt) + 60_000).toISOString(),
              amount: "0.20",
              judge: { input: answer, attempt: 3, asked: "0.50", note: "cap" },
              claimant: {
                id: "early",
                username: "早到的人",
                displayName: "早到的人",
                avatarUrl: null,
              },
            },
          ],
          nextCursor: null,
        } satisfies AuthorClaimList,
      });
    return route.fulfill({ status: 404, json: { error: {} } });
  });
}

/** 红包记录's reads: nothing sent, and these taken part in. */
async function mockHistory(page: Page, joined: ParticipationList["items"]) {
  await page.route("**/api/me/history-summary", (route) =>
    route.fulfill({
      json: {
        initiatedCount: 0,
        participatedCount: joined.length,
        sentAmount: "0.00",
        receivedAmount: "0.30",
      },
    }),
  );
  await page.route("**/api/me/activities?**", (route) =>
    route.fulfill({
      json: {
        items: [],
        nextCursor: null,
        total: 0,
        statusCounts: { all: 0, draft: 0, active: 0, ended: 0, archived: 0 },
      },
    }),
  );
  await page.route("**/api/me/participations?**", (route) =>
    route.fulfill({
      json: {
        items: joined,
        nextCursor: null,
        total: joined.length,
      } satisfies ParticipationList,
    }),
  );
}

/** The cover's three cells, by their third row. */
function thirdRows(page: Page) {
  return page.locator("[data-hb-part=stats] dd.hb-data-note");
}

function seal(page: Page) {
  return page.locator("[data-hb-part=seal] button");
}

async function readClipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("代码判定红包", () => {
  test("进行中：黑漆描金的红包皮，代码判定是第一个标签，奖池和每份至少，已判定次数代替进度条", async ({
    page,
  }) => {
    await mockSession(page, null);
    await mockCodeHongbao(page);
    await openApp(page, path);
    const hero = page.locator("[data-hb-part=hero]");
    await expect(hero).toHaveClass(/\bhb-code\b/);
    // Gold words: the gradient shows through a transparent fill.
    const heading = page.getByRole("heading", { name: title, level: 1 });
    await expect(heading).toBeVisible();
    expect(
      await heading.evaluate(
        (element) => getComputedStyle(element).webkitTextFillColor,
      ),
    ).toBe("rgba(0, 0, 0, 0)");
    // 代码判定 first, in gold, in place of 口令红包 / 无需口令; no 分法 and
    // no 关闭首页领取 (it is only ever on its page).
    const chips = hero.locator(".hb-chip-red");
    await expect(chips).toHaveText(["代码判定", "🐟额"]);
    await expect(chips.first()).toHaveClass(/\bhb-chip-code\b/);
    await expect(
      page.getByRole("button", { name: "代码判定", exact: true }),
    ).toHaveAccessibleDescription(
      "每次领多少由发红包的人的代码判定；开放时公布代码的指纹，结束后公开代码。",
    );
    await expect(page.getByRole("button", { name: "🐟额" })).toBeVisible();
    // 奖池 over 每份至少; 已领 over 已判定 N 次, no bar.
    const stats = page.locator("[data-hb-part=stats]");
    await expect(stats.getByText("奖池", { exact: true })).toBeVisible();
    await expect(stats).toContainText("1.00 LDC");
    await expect(thirdRows(page).nth(0)).toHaveText("每份至少 0.01 LDC");
    await expect(stats.getByText("1 / 5 份", { exact: true })).toBeVisible();
    await expect(thirdRows(page).nth(1)).toHaveText("已判定 7 次");
    await expect(stats.getByRole("progressbar")).toHaveCount(0);
    // A guest signs in first; the 代码 section stands where 口令 would.
    await expect(
      page.getByRole("button", { name: "登录", description: "登录后领取" }),
    ).toBeVisible();
    await expect(page.locator("[data-hb-part=passwords]")).toHaveCount(0);
    await expect(page.locator("[data-hb-part=my-judgments]")).toHaveCount(0);
    const entry = page.locator("#code-entry");
    await expect(entry).toHaveText(/^代码结束后公开$/);
    await expect(entry).toHaveAttribute("aria-haspopup", "dialog");

    // The roster: on which of their judged submissions each one came.
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await expect(
      roster.getByRole("listitem").filter({ hasText: "早到的人" }),
    ).toContainText("第 3 次领到");
  });

  test("登录后：已判定次数随推送的 judged 变化，不重读公开数据", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    const sockets = await mockLive(page);
    await openApp(page, path);
    await expect.poll(() => sockets.length).toBe(1);
    await expect(thirdRows(page).nth(1)).toHaveText("已判定 7 次");
    await page.waitForTimeout(500);
    const before = { ...state.reads };
    // The 红包's DO says its code judged again (turn-downs too).
    sockets[0]?.send(JSON.stringify({ type: "judged", count: 12 }));
    await expect(thirdRows(page).nth(1)).toHaveText("已判定 12 次", {
      timeout: 1_500,
    });
    // A pushed read later on carries a bigger count: it follows.
    state.judge = { ...state.judge, judged: 13 };
    sockets[0]?.send(
      JSON.stringify({ type: "activity", activity: publicRead(state) }),
    );
    await expect(thirdRows(page).nth(1)).toHaveText("已判定 13 次", {
      timeout: 1_500,
    });
    expect(state.reads).toEqual(before);
  });

  test("开：黑漆的代码判定作用域和等宽输入；没领到写代码的回复，领到后结果里不再写输入；我的提交随之更新", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    await mockLive(page);
    await openApp(page, path);
    await expect(
      page.getByText("点「开」，输入后提交，由发红包的人的代码判定"),
    ).toBeVisible();
    // Nothing judged yet: no 我的提交.
    await expect(page.locator("[data-hb-part=my-judgments]")).toHaveCount(0);
    await seal(page).click();
    await expect(seal(page)).toHaveAccessibleName("输入后提交");
    const input = omniboxInput(page);
    await expect(input).toBeFocused();
    // The sender's prompt as its placeholder, typed in fixed width.
    await expect(input).toHaveAttribute("placeholder", prompt);
    await expect(input).toHaveClass(/\bfont-mono\b/);
    const chip = page.locator(".chip.hb-lacquer-button");
    await expect(chip).toContainText(`代码判定 · ${title}`);
    await expect(
      shown(page, "原样提交：区分大小写，符号都算，首尾空格会去掉 · 0 / 200"),
    ).toBeVisible();
    // Nothing typed, nothing to run.
    await expect(page.getByRole("option")).toHaveCount(0);
    await input.fill("50");
    await expect(
      shown(page, "原样提交：区分大小写，符号都算，首尾空格会去掉 · 2 / 200"),
    ).toBeVisible();
    // One row only: this 红包 (the start page cannot find it). 02 §4 writes
    // it “领取「标题」”; the row is the 口令 scope's “领取 标题”, without 「」
    // (suggestions.tsx), pending the owner's word on which is meant.
    await expect(page.getByRole("option")).toHaveText([`领取${title}`]);
    await expect(page.getByText("在全部红包中查找")).toHaveCount(0);
    const action = page.locator("search button.btn-lacquer");
    await expect(action).toHaveText("领取");
    await page.keyboard.press("Enter");

    // Turned down: the code's own words, and the turn joins 我的提交.
    const panel = page.locator(".glass-pop");
    await expect(
      panel.getByText("代码的回复：大了", { exact: true }),
    ).toBeVisible();
    // With the cooldown the answer carried (02 §4).
    const waiting = page.getByRole("button", { name: /还需等待 \d 秒/ });
    await expect(waiting).toBeVisible();
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: "50" },
    ]);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的提交 · 1 次");
    const first = mine.getByRole("listitem");
    await expect(first).toHaveCount(1);
    await expect(first).toContainText("第 1 次");
    await expect(first).toContainText("没领到");
    await expect(first).toContainText("代码的回复：大了");
    // What was typed hides while it runs (the 指令框 still holds it).
    await expect(first).toContainText("已隐藏");
    await expect(first.getByText("50", { exact: true })).toHaveCount(0);
    // Nothing is said about 口令 here.
    await expect(shown(page, "输入的口令会匿名汇总给发红包的人。")).toHaveCount(
      0,
    );

    // Once the cooldown is over: ends trimmed, the code pays.
    await expect(waiting).toBeHidden({ timeout: 10_000 });
    await expect(action).toHaveText("领取");
    await input.fill(`  ${answer}  `);
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "已领取 0.30 LDC，存进了🐟额。" }),
    ).toHaveCount(1);
    expect(state.submissions[1]).toMatchObject({
      participationMode: "code",
      input: answer,
    });
    const result = page.locator("[data-hb-part=result]");
    await expect(result).toContainText("代码的回复：猜对了！");
    await expect(result).toContainText("按上限发");
    await expect(result).toContainText("金额、发放状态和代码的回复仅你可见");
    // What was typed is in 我的提交, not again here (05 §3).
    await expect(result).not.toContainText("口令");
    await expect(result).not.toContainText("输入");
    await expect(result.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(mine.getByRole("heading")).toHaveText("我的提交 · 2 次");
    const latest = mine.getByRole("listitem").first();
    await expect(latest).toContainText("第 2 次");
    await expect(latest).toContainText("领到 0.30 LDC");
    await expect(latest).toContainText("代码的回复：猜对了！");
    await expect(latest).toContainText("按上限发");
    expect(state.judgmentReads.length).toBeGreaterThanOrEqual(3);
  });

  test("我的提交：页面上最近 3 次，输入在一个眼睛后面；全部 N 次的弹窗滚到底再读；离开页面后又遮住", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(25));
    await mockLive(page);
    await mockHistory(page, []);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的提交 · 25 次");
    await expect(mine.getByText("仅你可见")).toBeVisible();
    const rows = mine.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("第 25 次");
    await expect(rows.nth(2)).toContainText("第 23 次");
    await expect(rows.nth(0)).toContainText("没领到");
    await expect(rows.nth(0)).toContainText("代码的回复：小了");
    // Hidden while it runs, behind one eye for them all.
    await expect(mine.getByText("已隐藏")).toHaveCount(3);
    await expect(mine.getByText("答案-25")).toHaveCount(0);
    const eye = page.getByRole("button", { name: "显示输入" });
    await expect(eye).toHaveCount(1);
    await expect(eye).toHaveAttribute("aria-pressed", "false");
    await eye.click();
    await expect(mine.getByText("答案-25")).toBeVisible();
    await expect(mine.getByText("答案-23")).toBeVisible();

    // 全部 25 次: the dialog, the same eye, twenty more as it scrolls.
    await mine.getByRole("button", { name: "全部 25 次" }).click();
    const dialog = page.getByRole("dialog", { name: "我的提交 · 25 次" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`小满的红包 · ${title}`);
    await expect(dialog.getByText("仅你可见")).toBeVisible();
    const all = dialog.getByRole("listitem");
    await expect(all).toHaveCount(20);
    await expect(dialog.getByText("答案-6", { exact: true })).toBeVisible();
    // Only the first twenty so far (read again as the dialog opened).
    expect(state.judgmentReads).not.toContain("20");
    await dialog
      .locator(".view-scroll")
      .evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(all).toHaveCount(25);
    await expect(
      dialog.getByText("共 25 次").and(page.locator(":not(.sr-only)")),
    ).toBeVisible();
    expect(state.judgmentReads.filter((cursor) => cursor !== null)).toEqual([
      "20",
    ]);
    await expect(dialog.getByText("答案-1", { exact: true })).toBeVisible();
    // Hidden from the dialog: hidden on the page as well.
    const dialogEye = dialog.getByRole("button", { name: "显示输入" });
    await expect(dialogEye).toHaveAttribute("aria-pressed", "true");
    await dialogEye.click();
    await expect(dialog.getByText("答案-1", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(mine.getByText("已隐藏")).toHaveCount(3);
    await eye.click();
    await expect(mine.getByText("答案-25")).toBeVisible();

    // Away and back: not remembered, hidden again.
    await page
      .getByRole("banner")
      .getByRole("link", { name: "红包记录" })
      .click();
    await expectPath(page, "/history");
    await expect(mine).toHaveCount(0);
    await page.goBack();
    await expectPath(page, path);
    await expect(mine.getByRole("listitem")).toHaveCount(3);
    await expect(mine.getByText("已隐藏")).toHaveCount(3);
    await expect(mine.getByText("答案-25")).toHaveCount(0);
    await expect(eye).toHaveAttribute("aria-pressed", "false");
  });

  // Back within the view's exit (0.14 s, view-stage.tsx) re-enters the
  // leaving 红包 page instead of mounting it again: MyJudgments resets its
  // eye as the page starts to leave, not only on unmount (05 §9 “不记住选择”).
  test("我的提交：离开后马上回来（离场动画还没放完）也要重新遮住", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockCodeHongbao(page, rejected(5));
    await mockLive(page);
    await mockHistory(page, []);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await mine.getByRole("button", { name: "显示输入" }).click();
    await expect(mine.getByText("答案-5")).toBeVisible();
    await page
      .getByRole("banner")
      .getByRole("link", { name: "红包记录" })
      .click();
    await expectPath(page, "/history");
    await page.goBack();
    await expectPath(page, path);
    await expect(mine.getByText("已隐藏")).toHaveCount(3);
    await expect(mine.getByText("答案-5")).toHaveCount(0);
  });

  test("代码弹窗（发红包的人）：只读的代码带行号，复制代码；指纹、封存值和不联网；名单写输入和代码给的数", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockLive(page);
    await mockSenderReads(page);
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "这是你发的红包，你不能领取" }),
    ).toBeDisabled();
    // No 我的提交 for its sender.
    await expect(page.locator("[data-hb-part=my-judgments]")).toHaveCount(0);

    const entry = page.locator("#code-entry");
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`小满的红包 · ${title}`);
    await expect(dialog.getByText("代码 · 结束后公开")).toBeVisible();
    await expect(
      dialog.getByText("只有你看得到：别人要等红包结束后才看得到代码。"),
    ).toBeVisible();
    // CodeMirror, read only, with its line numbers.
    const content = dialog.locator(".cm-editor .cm-content");
    await expect(content).toHaveAttribute("contenteditable", "false");
    await expect(content).toHaveAttribute("aria-readonly", "true");
    await expect(content).toContainText("export function judge(submission");
    await expect(
      dialog.locator(".cm-lineNumbers .cm-gutterElement:not([style*=hidden])"),
    ).toHaveText(["1", "2", "3", "4", "5"]);
    await expect(dialog.locator("textarea")).toHaveCount(0);
    await dialog.getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "已复制" })).toBeVisible();
    await expect.poll(() => readClipboard(page)).toBe(judgeCode);
    // What anyone can check: the fingerprint and the seed's 封存值.
    await expect(dialog.getByText("代码指纹")).toBeVisible();
    await expect(dialog.getByText(fingerprint)).toBeVisible();
    await expect(
      dialog.getByText(
        "开放时记下的 SHA-256。结束后公开代码，谁都能核对它没有换过。",
      ),
    ).toBeVisible();
    await expect(dialog.getByText("随机种子的封存值")).toBeVisible();
    await expect(dialog.getByText(seedCommitment)).toBeVisible();
    await expect(dialog.getByText("和开放时一致")).toHaveCount(0);
    await expect(dialog.getByText("联网", { exact: true })).toBeVisible();
    await expect(dialog.getByText("不联网", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("代码碰不到网络，只拿得到你的输入、用户名和等级。"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(entry).toBeFocused();

    // The sender's 名单: what was typed (hidden while it runs) and both
    // amounts when the code's was pulled in (07 §6).
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    const row = roster.getByRole("listitem").filter({ hasText: "早到的人" });
    await expect(row).toContainText("第 3 次领到");
    await expect(row).toContainText("代码给 0.50，按上限发 0.20");
    await expect(row).toContainText("输入");
    await expect(row).toContainText("已隐藏");
    await expect(row.getByText(answer, { exact: true })).toHaveCount(0);
    // Its eye puts what each one typed in (readable or not: see below).
    await roster.getByRole("button", { name: "显示名单里的输入" }).click();
    await expect(row.getByText(answer, { exact: true })).toHaveCount(1);
    await expect(row).not.toContainText("已隐藏");
  });

  // The sender's 名单 line under a name (roster.tsx, the detail span) holds
  // 第 N 次领到, the 输入, 代码给 …，按上限发 … and 已存入🐟额: in the 480px
  // dialog it wraps rather than squeezing the input or running over the
  // time and the amount (07 §6 “写他的输入和发了多少”).
  test("名单（发红包的人）：输入显示出来看得见，那行小字不压到右边的时间和金额", async ({
    page,
  }) => {
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockLive(page);
    await mockSenderReads(page);
    await openApp(page, path);
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: /领取名单/ });
    await roster.getByRole("button", { name: "显示名单里的输入" }).click();
    const row = roster.getByRole("listitem").filter({ hasText: "早到的人" });
    const input = row.getByText(answer, { exact: true });
    await expect(input).toBeVisible();
    expect((await input.boundingBox())?.width ?? 0).toBeGreaterThan(8);
    const line = row.locator("span.text-xs", { hasText: "第 3 次领到" });
    expect(
      await line.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });

  test("代码弹窗（领的人，进行中）：代码结束后才公开，只有指纹、封存值和不联网", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockCodeHongbao(page);
    await mockLive(page);
    await openApp(page, path);
    await page.locator("#code-entry").click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog.getByText("代码 · 结束后公开")).toBeVisible();
    await expect(dialog.locator(".cm-editor")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "复制代码", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByText(fingerprint)).toBeVisible();
    await expect(dialog.getByText(seedCommitment)).toBeVisible();
    await expect(dialog.getByText("不联网", { exact: true })).toBeVisible();
  });

  test("已暂停：印章变淡但不透明、不能点，提示代码连续出错", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    state.judge = { ...state.judge, paused: true };
    await mockLive(page);
    await openApp(page, path);
    const button = seal(page);
    await expect(button).toHaveAccessibleName("红包的代码连续出错，暂停领取");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("data-state", "disabled");
    // On the lacquer a see-through seal turns muddy: a faded, solid gold.
    await expect
      .poll(() =>
        button.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await expect(
      page
        .locator("[data-hb-part=hint]")
        .getByText("红包的代码连续出错，暂停领取"),
    ).toBeVisible();
    // Pressed anyway: nothing opens, nothing is sent.
    await button.click({ force: true });
    await page.waitForTimeout(300);
    await expect(page.locator(".chip.hb-lacquer-button")).toHaveCount(0);
    expect(state.submissions).toEqual([]);
  });

  test("已结束（没参与）：冷灰的红包皮和印章；代码和种子公开，和开放时一致", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockCodeHongbao(page);
    state.activity = {
      ...state.activity,
      status: "ended",
      quantity: { mode: "exact", total: 5, claimed: 5, remaining: 0 },
    };
    state.judge = { ...state.judge, judged: 31, code: judgeCode, seed };
    await openApp(page, path);
    const hero = page.locator("[data-hb-part=hero]");
    await expect(hero).toHaveClass(/\bhb-code\b/);
    await expect(hero).toHaveClass(/\bhb-ended\b/);
    // Graphite, not the lacquer darkened (05 §14); a cool seal.
    await expect
      .poll(() =>
        hero.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--color-cover-top"),
        ),
      )
      .toBe("rgb(90, 94, 101)");
    const button = seal(page);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleName("红包已领完");
    await expect
      .poll(() => button.evaluate((element) => getComputedStyle(element).color))
      .toBe("rgb(95, 100, 107)");
    await expect(hero.getByText("已结束", { exact: true })).toBeVisible();
    await expect(thirdRows(page).nth(1)).toHaveText("已判定 31 次");
    await expect(
      page.locator("[data-hb-part=stats]").getByText("已领完", { exact: true }),
    ).toBeVisible();

    // The code and the seed are public now, each checked against opening.
    const entry = page.locator("#code-entry");
    await expect(entry).toHaveText(/^代码已公开$/);
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog.getByText("代码 · 已公开")).toBeVisible();
    await expect(dialog.locator(".cm-editor .cm-content")).toContainText(
      "export function judge(submission",
    );
    await expect(
      dialog.getByRole("button", { name: "复制代码", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("和开放时一致")).toBeVisible();
    await expect(dialog.getByText("随机种子", { exact: true })).toBeVisible();
    await expect(dialog.getByText(seed)).toBeVisible();
    await expect(dialog.getByText("和封存值一致")).toBeVisible();
    // Over: nothing about the network any more.
    await expect(dialog.getByText("不联网", { exact: true })).toHaveCount(0);
  });

  test("已结束：公开的代码或种子和开放时封存的不一样，就不写一致", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockCodeHongbao(page);
    state.activity = { ...state.activity, status: "ended" };
    const cases = [
      // The code swapped after opening, the seed as sealed.
      {
        judge: { code: `${judgeCode}\n// 换过`, seed },
        matched: "和封存值一致",
        unmatched: "和开放时一致",
      },
      // The code as sealed, another seed.
      {
        judge: { code: judgeCode, seed: "6eed".repeat(16) },
        matched: "和开放时一致",
        unmatched: "和封存值一致",
      },
    ];
    for (const { judge, matched, unmatched } of cases) {
      state.judge = { ...publicJudge(), ...judge };
      await openApp(page, path);
      await page.locator("#code-entry").click();
      const dialog = page.getByRole("dialog", { name: "代码" });
      await expect(dialog.locator(".cm-editor .cm-content")).toContainText(
        judge.code === judgeCode ? "export function judge" : "换过",
      );
      // Both are checked at once: one shown, the other one was compared.
      await expect(dialog.getByText(matched)).toBeVisible();
      await expect(dialog.getByText(unmatched)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });

  test("已结束（参与过）：我的提交照样留着，输入直接显示，没有眼睛", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(5));
    state.activity = { ...state.activity, status: "ended" };
    state.judge = { ...state.judge, code: judgeCode, seed };
    await mockLive(page);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的提交 · 5 次");
    await expect(mine.getByText("仅你可见")).toBeVisible();
    await expect(mine.getByRole("listitem")).toHaveCount(3);
    await expect(mine.getByText("答案-5", { exact: true })).toBeVisible();
    await expect(mine.getByText("答案-3", { exact: true })).toBeVisible();
    await expect(mine.getByText("已隐藏")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "显示输入" })).toHaveCount(0);
    // The dialog the same: all of them, plain.
    await mine.getByRole("button", { name: "全部 5 次" }).click();
    const dialog = page.getByRole("dialog", { name: "我的提交 · 5 次" });
    await expect(dialog.getByRole("listitem")).toHaveCount(5);
    await expect(dialog.getByText("答案-1", { exact: true })).toBeVisible();
    await expect(dialog.getByText("已隐藏")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "显示输入" })).toHaveCount(
      0,
    );
  });

  test("站长停用：状态写已停用，印章下面写红包已被站长停用", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockCodeHongbao(page);
    state.activity = { ...state.activity, status: "ended", stopped: true };
    state.judge = { ...state.judge, stopped: true, code: judgeCode, seed };
    await openApp(page, path);
    await expect(
      page.locator("[data-hb-part=stats]").getByText("已停用", { exact: true }),
    ).toBeVisible();
    await expect(seal(page)).toHaveAccessibleName("红包已被站长停用");
    await expect(
      page.locator("[data-hb-part=hint]").getByText("红包已被站长停用"),
    ).toBeVisible();
    await expect(page.locator("[data-hb-part=hero]")).toHaveClass(
      /\bhb-ended\b/,
    );
  });

  test("红包广场和红包记录：代码判定红包是黑漆的，我参与的写代码判定领取", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const card = (
      cardId: string,
      cardTitle: string,
      extra: Partial<DiscoveryCard>,
    ): DiscoveryCard => {
      const { beforeInfo: _, ...rest } = publicActivity();
      return { ...rest, id: cardId, title: cardTitle, myClaim: null, ...extra };
    };
    await page.route("**/api/discovery/activities?**", (route) =>
      route.fulfill({
        json: {
          items: [
            card(id, title, { judge: publicJudge() }),
            card("62626262-7373-4848-9959-6a6a6a6a6a6a", "周末红包", {
              participationMode: "password",
              funding: undefined,
              forceDedicated: false,
              reward: {
                mode: "fixed",
                totalAmount: "0.50",
                unitAmount: "0.10",
                count: 5,
              },
            }),
          ],
          nextCursor: null,
          total: 2,
        } satisfies DiscoveryList,
      }),
    );
    await openApp(page, "/square");
    const lacquer = page.getByRole("button", { name: new RegExp(title) });
    await expect(lacquer.locator(".hb-card-cover")).toHaveClass(/\bhb-code\b/);
    await expect(lacquer.locator(".hb-lacquer-chip")).toHaveText("代码判定");
    await expect(lacquer).not.toContainText("口令红包");
    await expect(lacquer).not.toContainText("关闭首页领取");
    const red = page.getByRole("button", { name: /周末红包/ });
    await expect(red.locator(".hb-card-cover")).not.toHaveClass(/\bhb-code\b/);
    await expect(red).toContainText("口令红包");

    await mockHistory(page, [
      {
        kind: "claim",
        claim: {
          id: "claim-mine",
          activity: {
            id,
            title,
            status: "active",
            funding: "balance",
            participationMode: "code",
            author: authorProfile,
          },
          rewardType: "ldc",
          claimedAt: new Date(Date.now() - 60_000).toISOString(),
          amount: "0.30",
        },
      },
    ]);
    await openApp(page, "/history?tab=joined");
    const row = page.getByRole("button", { name: new RegExp(title) });
    await expect(row).toContainText("小满的红包 · 代码判定领取");
    await expect(row.locator(".mini-lacquer")).toHaveCount(1);
    await expect(row).toContainText("+0.30");
  });
});

test.describe("发红包 · 代码判定", () => {
  // Today's judge.js editor; 07 §5 (2026-10-24) puts a 判定器卡 in its
  // place, “不是编辑框”: rewrite this once the card is built.
  test("第 3 步：judge.js 是 CodeMirror 编辑器，能打字，大小跟着变；空的时候光标只有一行高", async ({
    page,
  }) => {
    // 🐟额 PLUS with its switch on: 代码判定 is offered, from 🐟额.
    await mockSession(page, { ...viewer, balance: true, balancePlus: true });
    await page.route("**/api/me/balance/hongbao", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          available: true,
          availableMinor: 1_000_000,
          // Its presence offers 代码判定 (hongbao-form.tsx codeOffered).
          code: { checksLeft: 10 },
        },
      }),
    );
    await page.route("**/api/me/merchants", (route) =>
      route.fulfill({
        json: {
          items: [],
          nextCursor: null,
          currentMerchantId: null,
          canCreate: true,
          canSimulate: false,
        },
      }),
    );
    await openApp(page, "/new");
    await page.getByRole("button", { name: "更多玩法" }).click();
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await expect(page.locator("#hb-code-total")).toBeVisible();
    await page.locator("#hb-code-total").fill("1.00");
    await page.locator("#hb-code-count").fill("5");
    await page.keyboard.press("Enter");
    // CodeMirror's own editable line, not the textarea it falls back to.
    const editor = page.getByRole("textbox", { name: /^judge\.js/ });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute("id", "hb-code-code");
    await expect(editor).toHaveClass(/\bcm-content\b/);
    await expect(page.locator("textarea#hb-code-code")).toHaveCount(0);
    await expect(editor).toHaveAccessibleName(/还没贴$/);

    // Empty, beside its three-line placeholder: one line's caret.
    await editor.click();
    const box = page.locator(".cm-editor", { has: editor });
    await expect(box).toHaveClass(/\bcm-focused\b/);
    const caret = box.locator(".cm-cursor-primary");
    await expect(caret).toHaveCount(1);
    const placeholder = await box.locator(".cm-placeholder").boundingBox();
    const height = (await caret.boundingBox())?.height ?? 0;
    expect(height).toBeGreaterThan(10);
    expect(height).toBeLessThanOrEqual(22);
    expect(placeholder?.height ?? 0).toBeGreaterThan(2 * height);

    const typed = "export function judge() {}";
    await page.keyboard.type(typed);
    await expect(editor).toHaveText(typed);
    await expect(editor).toHaveAccessibleName(/26 B$/);
    await page.keyboard.type("\n// 一");
    // A line more, and three bytes for 一: 26 + 1 + 3 + 3.
    await expect(editor).toHaveAccessibleName(/33 B$/);
    await expect(
      box.locator(".cm-lineNumbers .cm-gutterElement:not([style*=hidden])"),
    ).toHaveText(["1", "2"]);
  });
});
