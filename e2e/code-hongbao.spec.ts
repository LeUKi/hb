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
  JUDGE_PROTOCOL,
  type JudgeChallenger,
  type JudgeChallengerList,
  type JudgeCheck,
  type JudgeVersions,
  type ManagedActivity,
  type MyJudgment,
  type MyJudgmentList,
  type ParticipationList,
  type PublicActivity,
  type PublicJudge,
  type PublicRecipient,
} from "../packages/contracts/src";
import {
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
  /** 参与名单 · 挑战: everyone judged, the latest first. */
  challengers: JudgeChallenger[];
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
    challengers: [
      {
        username: "trying",
        displayName: "还在猜的人",
        avatarUrl: null,
        judged: 6,
        lastAt: new Date(Date.now() - 20_000).toISOString(),
        claimed: false,
      },
      {
        username: "early",
        displayName: "早到的人",
        avatarUrl: null,
        judged: 3,
        lastAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        claimed: true,
      },
    ],
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
    if (rest === "/challengers")
      return route.fulfill({
        json: {
          items: state.challengers,
          total: state.challengers.length,
          nextCursor: null,
        } satisfies JudgeChallengerList,
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
 * The sender's own reads: the 红包 as saved (with the versions its draft
 * deployed, if given), no 出错记录, and the 名单 with each claim's input and
 * both amounts (07 §6). `draft`: still a draft, saved with this code and
 * these tests, never run (the server says JUDGE_CHECK_REQUIRED) unless
 * `passed`: a run of its sender's passed them, in this 红包 or another.
 */
/** The 判定器 a sender's draft is in (mockSenderReads, mockDeploys). */
const E2E_JUDGE = "11111111-2222-4333-8444-555555555555";

async function mockSenderReads(
  page: Page,
  {
    versions,
    draft,
    passed = !draft,
  }: {
    versions?: JudgeVersions;
    draft?: { code: string; tests: string };
    passed?: boolean;
  } = {},
) {
  const managed: ManagedActivity = {
    id,
    title,
    rewardType: "ldc",
    participationMode: "code",
    funding: "balance",
    forceDedicated: true,
    status: draft ? "draft" : "active",
    version: draft ? 1 : 2,
    createdAt: openedAt,
    openedAt: draft ? null : openedAt,
    deadlineAt: publicActivity().deadlineAt,
    topicUrl: null,
    totalCount: 5,
    claimedCount: draft ? 0 : 1,
    author: authorProfile,
    judgePassed: passed,
    ...(passed
      ? {}
      : { openingBlockedReason: "JUDGE_CHECK_REQUIRED" as const }),
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
      judge: {
        prompt,
        code: draft?.code ?? judgeCode,
        tests: draft?.tests ?? '{ "tests": [] }',
        // Its 判定器 (judge-square §1): one's own, by its name.
        ...(versions
          ? { versions, judgeId: E2E_JUDGE, name: "猜数字", description: "" }
          : {}),
      },
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
    // Its braces before it, as wherever 代码判定 is named.
    await expect(chips.first().locator("svg.lucide-braces")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "代码判定", exact: true }),
    ).toHaveAccessibleDescription(
      "每次领多少由红包作者的代码判定；开放时公布代码的指纹，结束后公开代码。",
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

    // 参与名单 (05 §7): 领到, on which of their judged submissions each one
    // came; 挑战, everyone judged, the latest first, how many times.
    await expect(page.locator("#roster-entry")).toContainText("参与名单");
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: "参与名单" });
    const tabs = roster.getByRole("group", { name: "名单" });
    await expect(tabs.getByRole("button")).toHaveText(["领到1", "挑战2"]);
    await expect(
      roster.getByRole("listitem").filter({ hasText: "早到的人" }),
    ).toContainText("第 3 次领到");
    await tabs.getByRole("button", { name: /^挑战/ }).click();
    const challengers = roster.getByRole("listitem");
    await expect(challengers).toHaveCount(2);
    await expect(challengers.nth(0)).toContainText("还在猜的人");
    await expect(challengers.nth(0)).toContainText("判定 6 次");
    await expect(challengers.nth(0)).toContainText("刚刚");
    await expect(challengers.nth(0)).not.toContainText("领到了");
    await expect(challengers.nth(1)).toContainText("早到的人");
    await expect(challengers.nth(1)).toContainText("领到了");
    await expect(challengers.nth(1)).toContainText("3 分钟前");
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
      page.getByText("点「开」，输入后提交，由红包作者的代码判定"),
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
    // Before the first: taking part puts one's name in 参与名单 (02 §4).
    const panel = page.locator(".glass-pop");
    await expect(
      panel.getByText("提交后，你的昵称和判定次数会出现在参与名单里。"),
    ).toBeVisible();
    await input.fill("50");
    await expect(
      shown(page, "原样提交：区分大小写，符号都算，首尾空格会去掉 · 2 / 200"),
    ).toBeVisible();
    // No rows: what is typed goes straight to the code.
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(page.getByText("在全部红包中查找")).toHaveCount(0);
    const action = page.locator("search button.btn-lacquer");
    await expect(action).toHaveText("领取");
    await page.keyboard.press("Enter");

    // Turned down: the record under the box leads with it, the code's own
    // words large; the box empties for the next try.
    const record = panel.getByRole("region", { name: "我的提交" });
    await expect(record).toContainText("第 1 次");
    await expect(record).toContainText("没领到");
    await expect(record.getByText("大了", { exact: true })).toBeVisible();
    await expect(record.getByText("50", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "第 1 次：没领到。代码的回复：大了" }),
    ).toHaveCount(1);
    await expect(input).toHaveValue("");
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: "50" },
    ]);
    // The cooldown the answer carried shows once something is typed.
    await input.fill("40");
    const waiting = page.getByRole("button", { name: /还需等待 \d 秒/ });
    await expect(waiting).toBeVisible();
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的提交 · 1 次");
    const first = mine.getByRole("listitem");
    await expect(first).toHaveCount(1);
    await expect(first).toContainText("第 1 次");
    await expect(first).toContainText("没领到");
    await expect(first).toContainText("代码的回复：大了");
    // What was typed shows as typed (05 §3).
    await expect(first.getByText("50", { exact: true })).toBeVisible();
    // Nothing is said about 口令 here.
    await expect(shown(page, "输入的口令会匿名汇总给红包作者。")).toHaveCount(
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

  // A share text of several lines pasted whole (programmable-hongbao-design
  // §3), as a daily Bingo's: the code gets it as one line.
  test("粘贴多行文字：换行换成空格，插在光标处，框下说一句；提交的是接起来的一行", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    await mockLive(page);
    await openApp(page, path);
    await seal(page).click();
    const input = omniboxInput(page);
    await expect(input).toBeFocused();
    const paste = async (text: string) => {
      await page.evaluate(
        (value) => navigator.clipboard.writeText(value),
        text,
      );
      await page.keyboard.press("ControlOrMeta+V");
    };
    // Each run of line breaks, blank lines and the spaces and tabs around
    // them included, is one space; spaces inside a line stay.
    await input.fill("[]");
    await page.keyboard.press("ArrowLeft");
    await paste("第一行  \r\n\r\n \t第二行\n第三  行");
    await expect(input).toHaveValue("[第一行 第二行 第三  行]");
    await expect(shown(page, "粘贴的换行已换成空格 · 15 / 200")).toBeVisible();
    // Typing on: still said; cleared, the usual line again.
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect(shown(page, "粘贴的换行已换成空格 · 16 / 200")).toBeVisible();
    await input.fill("");
    await expect(
      shown(page, "原样提交：区分大小写，符号都算，首尾空格会去掉 · 0 / 200"),
    ).toBeVisible();
    // Dropped in, as a drag of text from elsewhere puts it: the same, the
    // caret after what was dropped.
    await input.evaluate((element: HTMLTextAreaElement) => {
      const value = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      value?.call(element, "甲\n\n乙丙");
      element.setSelectionRange(4, 4);
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertFromDrop" }),
      );
    });
    await expect(input).toHaveValue("甲 乙丙");
    expect(
      await input.evaluate(
        (element: HTMLTextAreaElement) => element.selectionStart,
      ),
    ).toBe(3);
    await expect(shown(page, "粘贴的换行已换成空格 · 4 / 200")).toBeVisible();
    await input.fill("");

    // Seven lines, the last a link: one line, its ends trimmed on submit.
    const bingo = [
      "每日 Bingo #12",
      "3 连线，用时 02:41",
      "🟩⬜🟩⬜🟩",
      "⬜🟩🟩🟩⬜",
      "🟩🟩🟩⬜🟩",
      "⬜🟩⬜🟩⬜",
      "https://bingo.example.test/r/12-abc",
      "",
    ].join("\n");
    const joined = bingo.trim().split("\n").join(" ");
    await paste(bingo);
    await expect(input).toHaveValue(`${joined} `);
    await expect(
      shown(page, `粘贴的换行已换成空格 · ${Array.from(joined).length} / 200`),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".glass-pop").getByRole("region", { name: "我的提交" }),
    ).toContainText("第 1 次");
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: joined },
    ]);
  });

  test("我的提交：页面上最近 3 次，输入直接显示；全部 N 次的弹窗滚到底再读", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(25));
    await mockLive(page);
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
    // As typed, no eye (05 §3, 2026-10-25).
    await expect(mine.getByText("答案-25")).toBeVisible();
    await expect(mine.getByText("已隐藏")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "显示输入" })).toHaveCount(0);

    // 全部 25 次: the dialog, twenty more as it scrolls.
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
  });

  test("代码弹窗（红包作者）：只读的代码带行号，复制代码；指纹、封存值和不联网；名单写输入和代码给的数", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockLive(page);
    await mockSenderReads(page);
    await openApp(page, path);
    // Its sender may try it too (自领, docs/self-claim-design.md); 我的提交
    // shows once they have.
    await expect(
      page.getByRole("button", { name: "输入后提交" }),
    ).toBeEnabled();
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

    // The sender's 名单: what was typed, as typed, and both amounts when
    // the code's was pulled in (07 §6).
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: "参与名单" });
    const row = roster.getByRole("listitem").filter({ hasText: "早到的人" });
    await expect(row).toContainText("第 3 次领到");
    await expect(row).toContainText("代码给 0.50，按上限发 0.20");
    await expect(row).toContainText("输入");
    await expect(row.getByText(answer, { exact: true })).toHaveCount(1);
    await expect(row).not.toContainText("已隐藏");
    await expect(
      roster.getByRole("button", { name: "显示名单里的输入" }),
    ).toHaveCount(0);
  });

  // The sender's 名单 line under a name (roster.tsx, the detail span) holds
  // 第 N 次领到, the 输入, 代码给 …，按上限发 … and 已存入🐟额: in the 480px
  // dialog it wraps rather than squeezing the input or running over the
  // time and the amount (07 §6 “写他的输入和发了多少”).
  test("名单（红包作者）：输入看得见，那行小字不压到右边的时间和金额", async ({
    page,
  }) => {
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockLive(page);
    await mockSenderReads(page);
    await openApp(page, path);
    await page.locator("#roster-entry").click();
    const roster = page.getByRole("dialog", { name: "参与名单" });
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

  test("联网的红包：红包皮写联网，代码弹窗列出地址，第一次提交前说清提交会被发去哪", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    state.judge = { ...state.judge, network: ["https://api.example.com/hb/"] };
    await mockLive(page);
    await openApp(page, path);
    await expect(
      page.getByRole("button", { name: "联网", exact: true }),
    ).toBeVisible();
    await page.locator("#code-entry").click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog.getByText("https://api.example.com/hb/")).toBeVisible();
    await expect(dialog.getByText("不联网", { exact: true })).toHaveCount(0);
    await expect(dialog).toContainText(
      "判定时代码会请求这些地址，你的提交（数字 ID、用户名、等级和输入）可能随请求发送给对方。判定结果取决于对方的回答，开放后对方的回答可能变化，本站无法核对。",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await seal(page).click();
    await expect(
      page
        .locator(".glass-pop")
        .getByText(
          "提交后，你的昵称和判定次数会出现在参与名单里。这个红包会联网：你的提交（数字 ID、用户名、等级和输入）可能被发到 api.example.com。",
        ),
    ).toBeVisible();
  });

  test("已结束（联网，参与过）：我的提交里展开看得到每个请求的返回，看不到请求", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const judged = rejected(1);
    const state = await mockCodeHongbao(page, [
      {
        ...(judged[0] as MyJudgment),
        fetches: [
          {
            host: "api.example.com",
            status: 200,
            response: '{"right":false,"say":"小了"}',
          },
          { host: "api.example.com", error: "timeout" },
        ],
      },
    ]);
    state.activity = { ...state.activity, status: "ended" };
    state.judge = {
      ...state.judge,
      code: judgeCode,
      seed,
      network: ["https://api.example.com/hb/"],
    };
    await mockLive(page);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    const toggle = mine.getByRole("button", { name: "联网返回 · 2 个" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(mine.getByText("api.example.com · 200")).toBeVisible();
    await expect(mine.getByText('{"right":false,"say":"小了"}')).toBeVisible();
    await expect(mine.getByText("api.example.com · 超时")).toBeVisible();
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
    await expect(
      lacquer.locator(".hb-lacquer-chip svg.lucide-braces"),
    ).toHaveCount(1);
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
  /** judge.js as pasted: eight lines, so it folds to six. */
  const firstCode = [
    "// 猜对 42 的人领一份",
    "export function judge(submission, tools) {",
    "  const guess = Number(submission.input);",
    "  if (guess === 42)",
    '    return { ok: true, amount: tools.money.even(), message: "猜对了！" };',
    '  if (guess > 42) return { ok: false, message: "大了" };',
    '  return { ok: false, message: "小了" };',
    "}",
  ].join("\n");
  /** The same with one line changed: another 判定器. */
  const secondCode = firstCode.replace("猜对了！", "恭喜！");
  const testsFile =
    '{ "tests": [{ "name": "答对", "input": "42", "expect": { "ok": true } }] }';

  /**
   * 🐟额 PLUS with its switch on (代码判定 offered, from 🐟额), no merchant,
   * and 部署 as the server would answer it: a code this person never ran
   * deploys and counts, one ran before reruns and does not (§5 次数). A
   * dynamic import() is found without running; BROKEN in the code or FAIL
   * in the tests fails the test.
   */
  /**
   * 部署 as the site does it (docs/judge-square-design.md §1): into a
   * 判定器 — one named, or one made by the first deploy — each new code its
   * next version, a code it has its rerun. `judge` is one there already
   * (a draft opened again), with its versions and their code.
   */
  async function mockDeploys(
    page: Page,
    {
      deploysLeft = 7,
      deployLimit = 10,
      user = { ...viewer, balance: true, balancePlus: true },
      judge,
    }: {
      deploysLeft?: number;
      deployLimit?: number;
      user?: MockUser;
      judge?: {
        id: string;
        name: string;
        versions: JudgeVersions;
        codes?: Record<number, string>;
      };
    } = {},
  ) {
    type Kept = {
      name: string;
      description: string;
      versions: JudgeVersions["versions"];
      codes: Map<number, string>;
    };
    const state = {
      deploysLeft,
      requests: [] as {
        code: string;
        tests: string;
        judge?: { id: string } | { name: string; description?: string };
      }[],
      ran: new Set<string>(),
      judges: new Map<string, Kept>(),
    };
    if (judge)
      state.judges.set(judge.id, {
        name: judge.name,
        description: "",
        versions: [...judge.versions.versions],
        codes: new Map(
          Object.entries(judge.codes ?? {}).map(([n, code]) => [
            Number(n),
            code,
          ]),
        ),
      });
    /** A 判定器's versions as a draft shows them, 换回 the newest that passed. */
    const versionsOf = (kept: Kept): JudgeVersions => {
      const restore = [...kept.versions].reverse().find((v) => v.passed);
      const code = restore ? kept.codes.get(restore.n) : undefined;
      return {
        next: (kept.versions.at(-1)?.n ?? 0) + 1,
        versions: kept.versions,
        ...(restore && code ? { restore: { n: restore.n, code } } : {}),
      };
    };
    await mockSession(page, user);
    await page.route("**/api/me/balance/hongbao", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          available: true,
          availableMinor: 1_000_000,
          // Its presence offers 代码判定 (hongbao-form.tsx codeOffered).
          code: { deploysLeft: state.deploysLeft, deployLimit },
        },
      }),
    );
    await mockNoMerchant(page);
    // 我的判定器: none with a version to use unless a test deploys one.
    await page.route("**/api/me/judges**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me/judges")
        return route.fulfill({ json: { items: [] } });
      const [, , , , judgeId] = path.split("/");
      const kept = state.judges.get(judgeId ?? "");
      if (!kept) return route.fulfill({ status: 404, json: { error: {} } });
      return route.fulfill({
        json: {
          judge: {
            id: judgeId,
            name: kept.name,
            description: kept.description,
            codePublic: "ended",
            createdAt: openedAt,
            updatedAt: openedAt,
            latest: null,
            usable: null,
            opened: 0,
            versions: kept.versions.map((version) => ({
              n: version.n,
              fingerprint: version.fingerprint,
              deployedAt: version.at,
              checkedAt: version.at,
              protocol: version.protocol ?? 1,
              testsDigest: version.testsDigest,
              passed: version.passed,
              network: version.network ?? null,
              declarations: {
                meta: null,
                params: [],
                hongbao: null,
                check: false,
              },
              opened: 0,
            })),
          },
        },
      });
    });
    await page.route("**/api/judge/check", (route) => {
      const input = route
        .request()
        .postDataJSON() as (typeof state.requests)[number];
      state.requests.push(input);
      const fingerprint = sha256(input.code);
      const kind = state.ran.has(fingerprint) ? "rerun" : "deploy";
      state.ran.add(fingerprint);
      if (kind === "deploy") state.deploysLeft -= 1;
      const problems = input.code.split("\n").flatMap((line, index) =>
        line.includes("import(")
          ? [
              {
                line: index + 1,
                message: "不能用动态 import()，只能在文件开头静态 import",
              },
            ]
          : [],
      );
      const passed =
        problems.length === 0 &&
        !input.code.includes("BROKEN") &&
        !input.tests.includes("FAIL");
      const network = input.code.includes("export const network")
        ? ["https://api.example.com/hb/"]
        : null;
      // Into its 判定器: the next version, or this code's rerun.
      const target = input.judge;
      const judgeId =
        target && "id" in target ? target.id : `judge-${state.judges.size + 1}`;
      const kept: Kept = state.judges.get(judgeId) ?? {
        name: target && "name" in target ? target.name : "判定器",
        description:
          target && "name" in target ? (target.description ?? "") : "",
        versions: [],
        codes: new Map(),
      };
      state.judges.set(judgeId, kept);
      const known = kept.versions.find((v) => v.fingerprint === fingerprint);
      const run = {
        testsDigest: sha256(input.tests),
        passed,
        protocol: JUDGE_PROTOCOL,
        ...(network ? { network } : {}),
      };
      const n = known?.n ?? (kept.versions.at(-1)?.n ?? 0) + 1;
      kept.versions = known
        ? kept.versions.map((v) => (v === known ? { ...v, ...run } : v))
        : [
            ...kept.versions,
            { n, fingerprint, at: new Date().toISOString(), ...run },
          ];
      kept.codes.set(n, input.code);
      return route.fulfill({
        json: {
          check: {
            fingerprint,
            testsDigest: sha256(input.tests),
            protocol: JUDGE_PROTOCOL,
            passed,
            // 联网 (§9): what the code exports, read by the deploy.
            network,
            problems,
            tests:
              problems.length > 0
                ? []
                : [
                    {
                      name: "答对",
                      passed,
                      ms: 3,
                      ...(passed ? {} : { problem: "应该发，实际没发" }),
                    },
                  ],
            unstable: [],
            slowestMs: problems.length > 0 ? null : 3,
            checkedAt: new Date().toISOString(),
            kind,
            deploysLeft: state.deploysLeft,
            declarations: {
              meta: null,
              params: [],
              hongbao: null,
              check: false,
            },
            judge: {
              id: judgeId,
              name: kept.name,
              description: kept.description,
              version: n,
              versions: versionsOf(kept),
            },
          } satisfies JudgeCheck,
        },
      });
    });
    return state;
  }

  /** No LDC merchant: 代码判定 is sent from 🐟额 anyway. */
  async function mockNoMerchant(page: Page) {
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
  }

  /** /new, 代码判定, 1.00 over 5 shares, on to ③ 代码. */
  /**
   * /new to 代码判定's second step, 判定器 (judge-square §6): with none of
   * one's own, straight to writing one, its name typed.
   */
  async function toCodeStep(page: Page, name = "猜数字") {
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await expect(page.locator("#hb-code-code")).toBeVisible();
    if (name) await page.locator("#hb-judge-name").fill(name);
  }

  /** From 判定器 on to 起个标题, 发多少 filled in on the way. */
  async function toTitleStep(page: Page) {
    await page.locator("#hb-code-prompt").click();
    await page.keyboard.press("Enter");
    await expect(page.locator("#hb-code-total")).toBeVisible();
    await page.locator("#hb-code-total").fill("1.00");
    await page.locator("#hb-code-count").fill("5");
    await page.keyboard.press("Enter");
    await expect(page.locator("#hb-title")).toBeVisible();
  }

  async function pasteCode(page: Page, code: string, button: string) {
    await page.evaluate((text) => navigator.clipboard.writeText(text), code);
    await page
      .locator("#hb-code-code")
      .getByRole("button", { name: button })
      .click();
  }

  /**
   * tests.json, written over in its editor at once, as typed text arrives
   * from an input method. Typed key by key, CI's Linux Chromium now and
   * then dropped the " after 猜中 or 答对, and the tests sent were not
   * these (2026-10-25).
   */
  async function typeTests(page: Page, text: string) {
    const editor = page.getByRole("textbox", { name: /^tests\.json/ });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
  }

  const card = (page: Page) => page.locator("#hb-code-code");
  const cardName = (page: Page) => card(page).locator(".hb-judge-name");
  const cardState = (page: Page) => card(page).locator(".hb-judge-state");
  const deployButton = (page: Page) =>
    page.getByRole("button", { name: "部署并跑测试" });

  /** Pasted, deployed and passed: 判定器 第 1 版. */
  async function deployFirst(page: Page) {
    await pasteCode(page, firstCode, "粘贴代码");
    await typeTests(page, testsFile);
    await deployButton(page).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
  }

  test("没开通 PLUS、只有商户也能发（2026-10-28）：卡上没有 PLUS；从商户直发，说明写分发费", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page, {
      deploysLeft: 2,
      deployLimit: 2,
      user: { ...viewer, balance: false, balancePlus: false },
    });
    await page.route("**/api/me/merchants", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "m-code",
              label: "我的商户",
              usageStatus: "current",
              clientId: "client_code",
              mode: "real",
              pausedReason: null,
              credentialVerification: {
                status: "passed",
                credentialVersion: 1,
                checkedAt: new Date().toISOString(),
                nextCheckAt: null,
                reason: null,
              },
            },
          ],
          nextCursor: null,
          currentMerchantId: "m-code",
          canCreate: true,
          canSimulate: false,
        },
      }),
    );
    await openApp(page, "/new");
    const pick = page.getByRole("button", { name: /^代码判定/ });
    await expect(pick).toBeVisible();
    await expect(pick).not.toContainText("PLUS");
    await pick.click();
    // 判定器 first (judge-square §6), then 发多少.
    await page.locator("#hb-judge-name").fill("猜数字");
    await pasteCode(page, firstCode, "粘贴代码");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(page.locator("#hb-code-total")).toBeVisible();
    await expect(
      page.getByText(/Credit 站会按你在 Credit 站的等级扣分发费/),
    ).toBeVisible();
    await expect(page.getByText("代码判定红包只能从🐟额发。")).toHaveCount(0);
  });

  test("第 3 步：judge.js 是判定器卡，不是编辑框；tests.json 还是 CodeMirror 编辑器，能打字，条数跟着变，空的时候光标只有一行高", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toCodeStep(page);
    // Nothing to type judge.js into: the card is pasted into, deployed.
    await expect(page.getByRole("textbox", { name: /^judge\.js/ })).toHaveCount(
      0,
    );
    await expect(card(page)).toHaveAccessibleName("judge.js");

    // tests.json: CodeMirror's own editable line, not the fallback.
    const editor = page.getByRole("textbox", { name: /^tests\.json/ });
    await expect(editor).toHaveAttribute("id", "hb-code-tests");
    await expect(editor).toHaveClass(/\bcm-content\b/);
    await expect(page.locator("textarea#hb-code-tests")).toHaveCount(0);
    await expect(editor).toHaveAccessibleName(/没有测试$/);

    // Empty, beside its five-line placeholder: one line's caret.
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

    await page.keyboard.type('{ "tests": [{}, {}] }');
    await expect(editor).toHaveAccessibleName(/2 条测试$/);
    await page.keyboard.type("\n");
    await expect(
      box.locator(".cm-lineNumbers .cm-gutterElement:not([style*=hidden])"),
    ).toHaveText(["1", "2"]);
  });

  test("还没有代码：卡里只有粘贴代码和从文件选；部署并跑测试灰着，旁边写今天还能部署几次", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toCodeStep(page);
    await expect(card(page)).toContainText(
      "在本地开发包里写好 judge.js，跑过 npm test 再贴过来。贴上就是一个新的判定器，部署以后才能开放。",
    );
    await expect(card(page).getByRole("button")).toHaveText([
      "粘贴代码",
      "从文件选",
    ]);
    await expect(deployButton(page)).toBeDisabled();
    await expect(page.locator("#hb-code-check")).toContainText(
      "今天还能部署 7 次",
    );
    await expect(page.locator("#hb-code-check")).not.toContainText(
      "把这一版代码做成判定器",
    );
  });

  test("部署新代码：贴上是新代码、未部署，折起只露前 6 行；部署并跑测试以后是判定器 第 1 版，测试全过，展开看得到指纹", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await pasteCode(page, firstCode, "粘贴代码");
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
    // 粘贴代码 went with the empty card: focus stays on the card.
    await expect(card(page)).toBeFocused();
    await expect(card(page)).toContainText(/刚贴上 · \d\d:\d\d/);
    await expect(page.getByText(/^8 行 · \d+ B$/)).toBeVisible();
    // Folded: the first six lines, then 展开全部 8 行.
    const lines = card(page).locator(
      ".cm-lineNumbers .cm-gutterElement:not([style*=hidden])",
    );
    await expect(lines).toHaveText(["1", "2", "3", "4", "5", "6"]);
    await expect(card(page)).not.toContainText("代码指纹");
    await expect(page.locator("#hb-code-check")).toContainText(
      "部署：把这一版代码做成判定器，在线上跑你的测试。开放前谁也领不到；只改测试再跑，不算部署。",
    );
    await expect(page.locator("#hb-code-check")).toContainText(
      "今天还能部署 7 次",
    );

    await typeTests(page, testsFile);
    await deployButton(page).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    await expect(card(page)).toContainText(/\d\d:\d\d 部署/);
    // Into a new 判定器, by the name typed (judge-square §1).
    expect(server.requests).toEqual([
      {
        code: firstCode,
        tests: testsFile,
        judge: { name: "猜数字", description: "" },
      },
    ]);
    const rows = page.getByRole("list", { name: "测试结果" });
    await expect(rows).toContainText("import 都在清单里");
    await expect(rows).toContainText("代码能加载、导出了 judge");
    await expect(rows).toContainText("测试 1 / 1 通过 · 最慢 3 毫秒");
    // Deployed and passed: nothing more to deploy, focus on the rows.
    await expect(deployButton(page)).toHaveCount(0);
    await expect(page.locator("#hb-code-check")).toBeFocused();
    await expect(
      page.getByText(
        "开放后由判定器 第 1 版 判定每次提交，不能再换；结束后所有人都能看到代码。",
      ),
    ).toBeVisible();

    await card(page).getByRole("button", { name: "展开全部 8 行" }).click();
    await expect(lines).toHaveCount(8);
    await expect(card(page)).toContainText(`代码指纹 ${sha256(firstCode)}`);
    await card(page).getByRole("button", { name: "收起" }).click();
    await expect(lines).toHaveCount(6);
  });

  test("联网的代码：部署后在测试结果下面列出白名单，写清对领的人、对令牌、对结束后的返回意味着什么", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    await toCodeStep(page);
    const networked = `export const network = ["https://api.example.com/hb/"];\n${firstCode}`;
    await pasteCode(page, networked, "粘贴代码");
    await typeTests(page, testsFile);
    await deployButton(page).click();
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText("联网：https://api.example.com/hb/");
    await expect(area).toContainText("领的人提交的内容可能被发到这些地址。");
    await expect(area).toContainText(
      "结束后代码公开，写在代码里的令牌也会公开，结束后请作废。",
    );
    await expect(area).toContainText(
      "红包结束后，领的人能看到自己那几次判定的返回内容，别在返回里放不想公开的东西。",
    );
  });

  test("换了代码：卡上是新代码，写和第 1 版比改了几行，上面一条琥珀提示；换回第 1 版不发部署请求、不算次数", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await deployFirst(page);

    // A new version, from a file this time.
    const chooser = page.waitForEvent("filechooser");
    await card(page).getByRole("button", { name: "从文件选" }).click();
    await (await chooser).setFiles({
      name: "judge.js",
      mimeType: "text/javascript",
      buffer: Buffer.from(secondCode),
    });
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
    await expect(
      page.getByText(/^8 行 · \d+ B · 和第 1 版比改了 1 行$/),
    ).toBeVisible();
    await expect(
      page.getByText(
        "代码换了：和测试全过的判定器 第 1 版不一样，要部署这一版才能开放；或者换回去。",
      ),
    ).toBeVisible();
    await expect(page.locator("#hb-code-check")).toContainText(
      "今天还能部署 6 次",
    );
    await expect(deployButton(page)).toBeEnabled();

    await page.getByRole("button", { name: "换回第 1 版" }).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    await expect(page.getByRole("button", { name: "换回第 1 版" })).toHaveCount(
      0,
    );
    // The callout went with its button: focus on the card put back.
    await expect(card(page)).toBeFocused();
    await expect(page.getByText(/^8 行 · \d+ B$/)).toBeVisible();
    // Its run of these tests is still the word: no new request.
    await expect(page.getByRole("list", { name: "测试结果" })).toContainText(
      "测试 1 / 1 通过",
    );
    expect(server.requests).toHaveLength(1);

    // Pasted back by hand, a deployed version is known by its fingerprint.
    await pasteCode(page, secondCode, "粘贴新版本");
    await expect(cardName(page)).toHaveText("新代码");
    await pasteCode(page, firstCode, "粘贴新版本");
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    expect(server.requests).toHaveLength(1);
  });

  test("只改了测试：同一版换成提示和重新跑测试，不算部署；保存并开放被拦住时写测试改过了", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await deployFirst(page);

    const changedTests = testsFile.replace("答对", "猜中");
    await typeTests(page, changedTests);
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText(
      "tests.json 改过了：在判定器 第 1 版 上重新跑一遍才能开放。不算部署，不扣次数。",
    );
    await expect(deployButton(page)).toHaveCount(0);
    // The version's own last run still shows on the card.
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");

    // 保存并开放 waits for the rerun, and says so on step 3.
    await toTitleStep(page);
    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect(area.getByText("测试改过了，要重新跑一遍")).toBeVisible();

    await area.getByRole("button", { name: "重新跑测试" }).click();
    await expect(area).not.toContainText("tests.json 改过了");
    await expect(area).toBeFocused();
    await expect(area.getByText("测试改过了，要重新跑一遍")).toHaveCount(0);
    expect(server.requests).toEqual([
      {
        code: firstCode,
        tests: testsFile,
        judge: { name: "猜数字", description: "" },
      },
      // Into the 判定器 the first made.
      { code: firstCode, tests: changedTests, judge: { id: "judge-1" } },
    ]);
    // A rerun counts nothing: the same 6 left.
    expect(server.deploysLeft).toBe(6);
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
  });

  test("没有部署过的代码：保存并开放被拦住，第 3 步写还没有测试全过的判定器", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await pasteCode(page, firstCode, "粘贴代码");
    await toTitleStep(page);
    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect(
      page.locator("#hb-code-check").getByText("还没有测试全过的判定器"),
    ).toBeVisible();
    expect(server.requests).toHaveLength(0);
  });

  test("今天的部署次数用完了：新代码部署不了，写明天再来，部署过的判定器换回去照样能开放", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page, { deploysLeft: 0 });
    await toCodeStep(page);
    await pasteCode(page, firstCode, "粘贴代码");
    const area = page.locator("#hb-code-check");
    await expect(deployButton(page)).toBeDisabled();
    await expect(area).toContainText("今天的 10 次部署用完了，明天再来");
    await expect(area).toContainText("已经部署过的判定器换回去照样能开放。");
    await expect(area).not.toContainText("把这一版代码做成判定器");
    expect(server.requests).toHaveLength(0);
  });

  test("本月判定器用量到了上限：新版本没有部署，原样写出来，不给版号", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    // Registered last, so it answers first.
    await page.route("**/api/judge/check", (route) =>
      route.fulfill({
        status: 429,
        json: {
          error: {
            code: "JUDGE_MONTHLY_LIMIT",
            message: "本月判定器用量到了上限，新版本暂时不能部署。",
          },
        },
      }),
    );
    await toCodeStep(page);
    await pasteCode(page, firstCode, "粘贴代码");
    await deployButton(page).click();
    await expect(page.locator("#hb-code-check")).toContainText(
      "本月判定器用量到了上限，新版本暂时不能部署。",
    );
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
  });

  test("部署时服务出错（500）：不照搬服务端的英文，写没有完成、可以再试一次", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    await page.route("**/api/judge/check", (route) =>
      route.fulfill({
        status: 500,
        json: {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Unexpected API error",
          },
        },
      }),
    );
    await toCodeStep(page);
    await pasteCode(page, firstCode, "粘贴代码");
    await deployButton(page).click();
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText(
      "部署没有完成：网络或服务出了问题。可以再试一次。",
    );
    await expect(page.getByText("Unexpected API error")).toHaveCount(0);
  });

  test("在这里改：单独的编辑窗口先说改完的后果；没改动不能用，取消什么都不变；用了就是新代码，能换回", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await deployFirst(page);

    const open = card(page).getByRole("button", { name: "在这里改" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "改代码" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "judge.js · 现在是猜数字 · 第 1 版（已部署 · 测试全过）",
    );
    await expect(dialog).toContainText(
      "改完就是一个新的判定器：要重新部署才能开放，今天还能部署 6 次。在本地开发包里改、跑过测试再贴回来，更省次数。",
    );
    // The window itself has focus (no keyboard yet): its warning first.
    await expect(dialog).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: "judge.js" })).toHaveText(
      firstCode.replaceAll("\n", ""),
    );
    await expect(dialog).toContainText("没有改动");
    const use = dialog.getByRole("button", { name: "用这份代码" });
    await expect(use).toHaveAttribute("aria-disabled", "true");

    // A change, then 取消: nothing changes.
    await dialog
      .getByRole("textbox", { name: "judge.js" })
      .getByText("小了")
      .click();
    await page.keyboard.type("一点");
    await expect(dialog).toContainText("改了 1 行 · 会是新的判定器");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");

    // Opened again: the code as it is, unchanged.
    await open.click();
    await expect(dialog).toContainText("没有改动");
    await dialog
      .getByRole("textbox", { name: "judge.js" })
      .getByText("小了")
      .click();
    await page.keyboard.type("一点");
    await use.click();
    await expect(dialog).toHaveCount(0);
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
    await expect(card(page)).toContainText(/刚改过 · \d\d:\d\d/);
    await expect(
      page.getByRole("button", { name: "换回第 1 版" }),
    ).toBeVisible();
    expect(server.requests).toHaveLength(1);
  });

  test("部署了测试没过：卡上写已部署 · 测试没过，折起的代码也露出标红的行号；按钮灰着，写改出新版本才能再部署", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    // Ten lines, a dynamic import() on the eighth.
    const brokenCode = [
      ...firstCode.split("\n").slice(0, 7),
      '  import("node:fs");',
      "}",
      "// 完",
    ].join("\n");
    await toCodeStep(page);
    await pasteCode(page, brokenCode, "粘贴代码");
    await typeTests(page, testsFile);
    const button = deployButton(page);
    await button.click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试没过");
    const rows = page.getByRole("list", { name: "测试结果" });
    await expect(rows).toContainText(
      "第 8 行：不能用动态 import()，只能在文件开头静态 import",
    );
    // Folded, the code still reaches the line found wrong, red.
    const lines = card(page).locator(
      ".cm-lineNumbers .cm-gutterElement:not([style*=hidden])",
    );
    await expect(lines).toHaveText([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    await expect(card(page).locator(".hb-code-problem")).toHaveText("8");
    await expect(
      card(page).getByRole("button", { name: "展开全部 10 行" }),
    ).toBeVisible();
    // The same version takes no second deploy; the button keeps focus.
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toBeFocused();
    await expect(page.locator("#hb-code-check")).toContainText(
      "改出新版本才能再部署 · 今天还能部署 6 次",
    );
    // Pressed anyway (it is only greyed): nothing is sent.
    await button.click({ force: true });
    expect(server.requests).toHaveLength(1);
  });

  test("换成部署过、测试没过的第 2 版：琥珀提示不叫人再部署它，写可以换回第 1 版", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    await toCodeStep(page);
    await deployFirst(page);
    await pasteCode(
      page,
      firstCode.replace("猜对了！", "BROKEN"),
      "粘贴新版本",
    );
    await deployButton(page).click();
    await expect(cardName(page)).toHaveText("判定器 第 2 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试没过");
    await expect(
      page.getByText(
        "代码换了：判定器 第 2 版还没有测试全过，可以换回测试全过的第 1 版。",
      ),
    ).toBeVisible();
    await expect(page.getByText(/要部署这一版才能开放/)).toHaveCount(0);
    await expect(page.locator("#hb-code-check")).toContainText(
      "改出新版本才能再部署",
    );
    await expect(
      page.getByRole("button", { name: "换回第 1 版" }),
    ).toBeVisible();
  });

  test("换代码时，离开的那一版在现在的测试下全过就能换回，哪怕它上一次跑别的测试没过", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toCodeStep(page);
    await deployFirst(page);
    const area = page.locator("#hb-code-check");

    // Other tests, which fail on it.
    const failingTests = testsFile.replace("答对", "FAIL");
    await typeTests(page, failingTests);
    await area.getByRole("button", { name: "重新跑测试" }).click();
    await expect(cardState(page)).toHaveText("已部署 · 测试没过");

    // The first tests again: this tab's run of them passed.
    await typeTests(page, testsFile);
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    await pasteCode(page, secondCode, "粘贴新版本");
    await expect(cardName(page)).toHaveText("新代码");
    await page.getByRole("button", { name: "换回第 1 版" }).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    expect(server.requests).toHaveLength(2);
  });

  test("存草稿：带上它的判定器、名字和说明，不带版本（版本在判定器上）", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    const sent: {
      activity: {
        judge?: {
          judgeId?: string;
          name?: string;
          description?: string;
          versions?: JudgeVersions;
        };
      };
    }[] = [];
    await page.route("**/api/activities", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent.push(route.request().postDataJSON());
      return route.abort();
    });
    await toCodeStep(page);
    await page.locator("#hb-judge-description").fill("猜中的领");
    await deployFirst(page);
    await pasteCode(page, secondCode, "粘贴新版本");
    await expect(cardName(page)).toHaveText("新代码");
    // On to the last step, where the form saves.
    await toTitleStep(page);
    await page.getByRole("button", { name: "存草稿" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.activity.judge).toMatchObject({
      judgeId: "judge-1",
      name: "猜数字",
      description: "猜中的领",
      code: secondCode,
    });
    expect(sent[0]?.activity.judge?.versions).toBeUndefined();
  });

  test("草稿重新打开（新的页面）：换回第 1 版不说测试改过了，保存并开放不被拦住，由服务器说", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    // Its sender's own 📝 page, 🐟额 PLUS.
    const server = await mockDeploys(page, { user: author });
    await mockSenderReads(page, {
      draft: { code: secondCode, tests: testsFile },
      versions: {
        next: 2,
        versions: [
          {
            n: 1,
            fingerprint: sha256(firstCode),
            at: openedAt,
            testsDigest: sha256(testsFile),
            passed: true,
            protocol: JUDGE_PROTOCOL,
          },
        ],
        restore: { n: 1, code: firstCode },
      },
    });
    const saves: { activity: { judge?: { code: string } } }[] = [];
    await page.route(`**/api/me/activities/${id}`, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      saves.push(route.request().postDataJSON());
      return route.abort();
    });
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：新代码/ }).click();
    await expect(cardName(page)).toHaveText("新代码");
    await page.getByRole("button", { name: "换回第 1 版" }).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    const area = page.locator("#hb-code-check");
    await expect(area).not.toContainText("tests.json 改过了");
    await expect(area.getByRole("button", { name: "重新跑测试" })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]?.activity.judge?.code).toBe(firstCode);
    await expect(area).not.toContainText("测试改过了，要重新跑一遍");
    await expect(area).not.toContainText("还没有测试全过的判定器");
    expect(server.requests).toHaveLength(0);
  });

  test("草稿重新打开：第 1 版上次跑的是另一份测试，换回后要重新跑", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    await mockDeploys(page, { user: author });
    await mockSenderReads(page, {
      draft: { code: secondCode, tests: testsFile },
      versions: {
        next: 2,
        versions: [
          {
            n: 1,
            fingerprint: sha256(firstCode),
            at: openedAt,
            testsDigest: sha256('{ "tests": [] }'),
            passed: true,
            protocol: JUDGE_PROTOCOL,
          },
        ],
        restore: { n: 1, code: firstCode },
      },
    });
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：新代码/ }).click();
    await page.getByRole("button", { name: "换回第 1 版" }).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText(
      "tests.json 改过了：在判定器 第 1 版 上重新跑一遍才能开放。",
    );
    await expect(
      area.getByRole("button", { name: "重新跑测试" }),
    ).toBeVisible();
  });

  test("草稿重新打开：旧协议上部署过、测试全过的版本，换回后要在第三版上重新跑一遍，不算部署", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const server = await mockDeploys(page, { user: author });
    await mockSenderReads(page, {
      draft: { code: secondCode, tests: testsFile },
      versions: {
        next: 2,
        versions: [
          {
            // Run before 第二版: no protocol written (v1), now on 第三版.
            n: 1,
            fingerprint: sha256(firstCode),
            at: openedAt,
            testsDigest: sha256(testsFile),
            passed: true,
          },
        ],
        restore: { n: 1, code: firstCode },
      },
    });
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：新代码/ }).click();
    await page.getByRole("button", { name: "换回第 1 版" }).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText(
      "判定器升级到第三版了：在判定器 第 1 版 上重新跑一遍测试才能开放。不算部署，不扣次数。",
    );
    await area.getByRole("button", { name: "重新跑测试" }).click();
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    // Its rerun, in the 判定器 the draft is in.
    expect(server.requests).toEqual([
      { code: firstCode, tests: testsFile, judge: { id: E2E_JUDGE } },
    ]);
  });

  test("草稿重新打开：测试没过的那一版没留下是哪几条，重新跑测试就看得到，不算部署", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const failing = firstCode.replace("猜对了！", "BROKEN");
    const server = await mockDeploys(page, { user: author });
    // Deployed before, on the page that saved the draft.
    server.ran.add(sha256(failing));
    await mockSenderReads(page, {
      draft: { code: failing, tests: testsFile },
      versions: {
        next: 2,
        versions: [
          {
            n: 1,
            fingerprint: sha256(failing),
            at: openedAt,
            testsDigest: sha256(testsFile),
            passed: false,
          },
        ],
      },
    });
    await openApp(page, `${path}/📝`);
    await page
      .getByRole("button", { name: /^第 2 步 判定器：猜数字 · 第 1 版/ })
      .click();
    await expect(cardState(page)).toHaveText("已部署 · 测试没过");
    const area = page.locator("#hb-code-check");
    await expect(area).toContainText(
      "没过的是哪几条没留下：重新跑测试就能看到，不算部署。",
    );
    await expect(page.getByRole("list", { name: "测试结果" })).toHaveCount(0);
    await area.getByRole("button", { name: "重新跑测试" }).click();
    await expect(page.getByRole("list", { name: "测试结果" })).toContainText(
      "应该发，实际没发",
    );
    await expect(area).toContainText("今天还能部署 7 次");
    expect(server.requests).toHaveLength(1);
    // The rows are back: nothing more to bring back.
    await expect(area.getByRole("button", { name: "重新跑测试" })).toHaveCount(
      0,
    );
  });

  test("草稿重新打开：这份代码在别处测试全过过，但不是这个红包的版本：还是新代码 · 未部署，部署后是第 1 版，不扣次数", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const server = await mockDeploys(page, { user: author });
    // Its sender ran it in another 红包.
    server.ran.add(sha256(firstCode));
    await mockSenderReads(page, {
      draft: { code: firstCode, tests: testsFile },
      passed: true,
    });
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：新代码/ }).click();
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
    // A draft from before 判定器, never deployed here: it has none yet,
    // and waits for a name (judge-square §1).
    await expect(deployButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#hb-code-check")).toContainText(
      "先给判定器起个名字",
    );
    await page.locator("#hb-judge-name").fill("猜数字");
    await expect(deployButton(page)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await deployButton(page).click();
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    expect(server.deploysLeft).toBe(7);
  });

  test("Windows 换行的 judge.js：在这里改打一个字再删掉，还是没有改动，用这份代码不能按", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toCodeStep(page);
    const chooser = page.waitForEvent("filechooser");
    await card(page).getByRole("button", { name: "从文件选" }).click();
    await (await chooser).setFiles({
      name: "judge.js",
      mimeType: "text/javascript",
      buffer: Buffer.from(firstCode.replaceAll("\n", "\r\n")),
    });
    await expect(cardName(page)).toHaveText("新代码");
    await expect(page.getByText(/^8 行 · \d+ B$/)).toBeVisible();

    await card(page).getByRole("button", { name: "在这里改" }).click();
    const dialog = page.getByRole("dialog", { name: "改代码" });
    await dialog
      .getByRole("textbox", { name: "judge.js" })
      .getByText("小了")
      .click();
    await page.keyboard.type("x");
    await expect(dialog).toContainText("改了 1 行 · 会是新的判定器");
    await page.keyboard.press("Backspace");
    await expect(dialog).toContainText("没有改动");
    await expect(
      dialog.getByRole("button", { name: "用这份代码" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  test("编辑页（开放后，没有存下版本）：条上和卡上都写判定器，不写新代码", async ({
    page,
  }) => {
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockNoMerchant(page);
    await mockSenderReads(page);
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：判定器/ }).click();
    await expect(cardName(page)).toHaveText("判定器");
  });

  test("编辑页（开放后）：判定器卡锁住，只能展开代码，写开放后不能再换", async ({
    page,
  }) => {
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockNoMerchant(page);
    await mockSenderReads(page, {
      versions: {
        next: 3,
        versions: [
          {
            n: 2,
            fingerprint,
            at: openedAt,
            testsDigest: sha256('{ "tests": [] }'),
            passed: true,
          },
        ],
      },
    });
    await openApp(page, `${path}/📝`);
    // Its strip names the 判定器 it opened with.
    await page
      .getByRole("button", { name: /^第 2 步 判定器：猜数字 · 第 2 版/ })
      .click();
    await expect(cardName(page)).toHaveText("判定器 第 2 版");
    await expect(card(page)).toContainText("开放时部署的这一版 · 测试全过");
    await expect(card(page)).toContainText("开放后不能再换");
    await expect(card(page).getByRole("button")).toHaveText(["展开代码"]);
    await expect(card(page).locator(".cm-editor")).toHaveCount(0);
    await card(page).getByRole("button", { name: "展开代码" }).click();
    await expect(card(page)).toContainText(`代码指纹 ${fingerprint}`);
    await expect(page.locator("#hb-code-check")).toHaveCount(0);
    await expect(
      page.getByText(
        "由判定器 第 2 版 判定每次提交，不能再换；结束后所有人都能看到代码。",
      ),
    ).toBeVisible();
  });

  // 判定器 (docs/judge-square-design.md §6, §14.4): one of one's own picked
  // on step 2, its params and ranges, 试一试; a name from the code's meta.
  const GUESS_ID = "22222222-3333-4444-8555-666666666666";
  const guessDeclarations = {
    meta: null,
    params: [
      {
        key: "max",
        label: "最大",
        type: "integer" as const,
        min: 2,
        default: 100,
      },
      {
        key: "answer",
        label: "答案",
        type: "integer" as const,
        secret: true,
      },
    ],
    hongbao: {
      count: { min: 1, max: 10, default: 5 },
      total: { default: 500 },
    },
    check: true,
  };

  /** 我的判定器: 猜数字, its 第 3 版 usable, with params; what is asked of it. */
  async function mockMyJudges(page: Page) {
    const asked = {
      checks: [] as { params: Record<string, unknown> }[],
      tries: [] as { input: string; params: Record<string, unknown> }[],
      saved: [] as {
        activity: { judge?: Record<string, unknown>; money: unknown };
      }[],
    };
    const version = {
      n: 3,
      fingerprint: sha256(firstCode),
      at: openedAt,
      testsDigest: sha256(testsFile),
      passed: true,
      protocol: JUDGE_PROTOCOL,
    };
    const judge = {
      id: GUESS_ID,
      name: "猜数字",
      description: "猜中的领",
      codePublic: "ended",
      createdAt: openedAt,
      updatedAt: openedAt,
      latest: { n: 3, deployedAt: openedAt, passed: true },
      usable: { n: 3, declarations: guessDeclarations, network: null },
      opened: 2,
    };
    await page.route("**/api/me/judges**", (route) => {
      const url = new URL(route.request().url());
      const rest = url.pathname.slice("/api/me/judges".length);
      if (rest === "") return route.fulfill({ json: { items: [judge] } });
      if (rest === `/${GUESS_ID}`)
        return route.fulfill({
          json: {
            judge: {
              ...judge,
              versions: [
                {
                  n: 3,
                  fingerprint: version.fingerprint,
                  deployedAt: openedAt,
                  checkedAt: openedAt,
                  protocol: JUDGE_PROTOCOL,
                  testsDigest: version.testsDigest,
                  passed: true,
                  network: null,
                  declarations: guessDeclarations,
                  opened: 2,
                },
              ],
            },
          },
        });
      if (rest === `/${GUESS_ID}/versions/3`)
        return route.fulfill({
          json: {
            code: firstCode,
            tests: testsFile,
            versions: { next: 4, versions: [version] },
            declarations: guessDeclarations,
          },
        });
      if (rest === `/${GUESS_ID}/versions/3/check`) {
        const body = route.request().postDataJSON();
        asked.checks.push(body);
        return route.fulfill({
          json: {
            problems:
              Number(body.params.answer) > Number(body.params.max)
                ? [{ key: "answer", message: "答案不能大于最大" }]
                : [],
          },
        });
      }
      if (rest === `/${GUESS_ID}/versions/3/try`) {
        const body = route.request().postDataJSON();
        asked.tries.push(body);
        return route.fulfill({
          json:
            body.input === "慢"
              ? { failure: "timeout", detail: "超过 300 毫秒没有判定完" }
              : Number(body.input) === body.params.answer
                ? { ok: true, amount: 100, message: "猜中了" }
                : { ok: false, message: "不对" },
        });
      }
      return route.fulfill({ status: 404, json: { error: {} } });
    });
    await page.route("**/api/activities", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      asked.saved.push(route.request().postDataJSON());
      return route.abort();
    });
    return asked;
  }

  test("我的判定器：挑一个收起成一张卡，参数按它的声明、过它的 check，发多少按它的默认值和范围", async ({
    page,
  }) => {
    await mockDeploys(page);
    const asked = await mockMyJudges(page);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    const mine = page.getByRole("group", { name: "我的判定器" });
    const card = mine.getByRole("button", { name: /猜数字/ });
    await expect(card).toContainText("猜中的领");
    await expect(card).toContainText("第 3 版 · 开放过 2 个");
    await expect(
      page.getByRole("button", { name: "自己写一个" }),
    ).toBeVisible();
    await card.click();
    // Folded into one card; its params under it.
    await expect(page.getByText("我的 · 第 3 版")).toBeVisible();
    await expect(page.getByRole("button", { name: "查看代码" })).toBeVisible();
    await expect(page.locator("#hb-param-max")).toHaveValue("100");
    const lock = page.getByRole("button", { name: "保密" });
    await expect(lock).toHaveAccessibleDescription(
      "开放后保密，结束后公开。回复里会不会透露它，要看判定器的代码。",
    );
    // 下一步: its own rules first, then its check().
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(page.getByText("请填写答案", { exact: true })).toBeVisible();
    expect(asked.checks).toHaveLength(0);
    await page.locator("#hb-param-answer").fill("500");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(
      page.getByText("答案不能大于最大", { exact: true }),
    ).toBeVisible();
    await page.locator("#hb-param-answer").fill("42");
    await page.getByRole("button", { name: "下一步" }).first().click();
    // 发多少: its defaults, its range said when left.
    await expect(page.locator("#hb-code-count")).toHaveValue("5");
    await expect(page.locator("#hb-code-total")).toHaveValue("5.00");
    expect(asked.checks.at(-1)?.params).toEqual({ max: 100, answer: 42 });
    await page.locator("#hb-code-count").fill("20");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(
      page.getByText("这个判定器要求 1–10 份", { exact: true }),
    ).toBeVisible();
    await page.locator("#hb-code-count").fill("5");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => asked.saved.length).toBe(1);
    expect(asked.saved[0]?.activity.judge).toMatchObject({
      judgeId: GUESS_ID,
      name: "猜数字",
      code: firstCode,
      params: { max: 100, answer: 42 },
    });
  });

  test("试一试：默认折起，按现在的参数判定一次，写会发多少和回复，超时写判定超时", async ({
    page,
  }) => {
    await mockDeploys(page);
    const asked = await mockMyJudges(page);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await page
      .getByRole("group", { name: "我的判定器" })
      .getByRole("button", { name: /猜数字/ })
      .click();
    await page.locator("#hb-param-answer").fill("42");
    const toggle = page.getByRole("button", { name: /^试一试/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText(
      "· 按现在的参数判定一次，不发钱，不记录",
    );
    await toggle.click();
    const input = page.getByRole("textbox", { name: "试一试的输入" });
    await input.fill("42");
    await page.getByRole("button", { name: "判定", exact: true }).click();
    await expect(page.getByText("会发 1.00 LDC")).toBeVisible();
    await expect(page.getByText("回复：猜中了")).toBeVisible();
    expect(asked.tries.at(-1)).toMatchObject({
      input: "42",
      params: { max: 100, answer: 42 },
    });
    await input.fill("7");
    await page.getByRole("button", { name: "判定", exact: true }).click();
    await expect(page.getByText("不发", { exact: true })).toBeVisible();
    await input.fill("慢");
    await page.getByRole("button", { name: "判定", exact: true }).click();
    await expect(page.getByText("判定超时")).toBeVisible();
  });

  test("换一个回到卡片；自己写一个是空的，名字在最前；贴上带 meta 的代码就填好名字和说明", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    await mockMyJudges(page);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await page
      .getByRole("group", { name: "我的判定器" })
      .getByRole("button", { name: /猜数字/ })
      .click();
    await page.getByRole("button", { name: "换一个" }).click();
    await expect(page.getByRole("group", { name: "我的判定器" })).toBeVisible();
    await page.getByRole("button", { name: "自己写一个" }).click();
    await expect(page.locator("#hb-judge-name")).toHaveValue("");
    await expect(page.locator("#hb-param-max")).toHaveCount(0);
    // Code without a name: its deploy waits for one.
    await pasteCode(page, firstCode, "粘贴代码");
    await expect(page.locator("#hb-code-check")).toContainText(
      "先给判定器起个名字",
    );
    await pasteCode(
      page,
      `export const meta = { name: "猜大小", description: "大了小了" };\n${firstCode}`,
      "粘贴新版本",
    );
    await expect(page.locator("#hb-judge-name")).toHaveValue("猜大小");
    await expect(page.locator("#hb-judge-description")).toHaveValue("大了小了");
    await expect(page.locator("#hb-code-check")).not.toContainText(
      "先给判定器起个名字",
    );
  });
});
