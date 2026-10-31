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
  JUDGE_OLDEST_PROTOCOL,
  JUDGE_PROTOCOL,
  type JudgeAnnouncement,
  type JudgeAnnouncementList,
  type JudgeChallenger,
  type JudgeChallengerList,
  type JudgeCheck,
  type JudgeVersions,
  type ManagedActivity,
  type MyJudgment,
  type MyJudgmentList,
  type MyStanding,
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
// the 代码判定 scope in the 指令框, 我的记录, the 代码 dialog, the paused,
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
  /** Protocol 5: the viewer's 待结算 and what only they see. */
  standing?: MyStanding;
  /** 我的记录, newest first. */
  judgments: MyJudgment[];
  /** What each claim sent. */
  submissions: { participationMode?: string; input?: string }[];
  /** The cursor of each read of 我的记录 (null: the first page). */
  judgmentReads: (string | null)[];
  /** 参与名单 · 挑战: everyone judged, the latest first. */
  challengers: JudgeChallenger[];
  /** 动态 (protocol 4): every line, newest first; the cursors read. */
  announcements: JudgeAnnouncement[];
  announcementReads: (string | null)[];
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
 * One 代码判定红包's server, mocked: its reads, 我的记录 twenty at a time,
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
    announcements: [],
    announcementReads: [],
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
        json: {
          claim: state.claim,
          registration: null,
          ...(state.standing ? { standing: state.standing } : {}),
        },
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
    if (rest === "/announcements") {
      const cursor = url.searchParams.get("cursor");
      state.announcementReads.push(cursor);
      const below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
      const older = state.announcements.filter((item) => item.n < below);
      const items = older.slice(0, 20);
      return route.fulfill({
        json: {
          items,
          total: state.announcements.length,
          nextCursor: older.length > 20 ? String(items.at(-1)?.n ?? 0) : null,
        } satisfies JudgeAnnouncementList,
      });
    }
    if (rest === "/judgments") {
      const cursor = url.searchParams.get("cursor");
      state.judgmentReads.push(cursor);
      const from = Number(cursor ?? 0);
      const items = state.judgments.slice(from, from + 20);
      return route.fulfill({
        json: {
          items,
          total: state.judgments.length,
          attempts: state.judgments.filter((item) => !item.by).length,
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
      const attempt = state.judgments.filter((item) => !item.by).length + 1;
      const at = new Date().toISOString();
      state.judge = { ...state.judge, judged: state.judge.judged + 1 };
      // The 红包's DO puts the account's cooldown on every claim answer: a
      // code claim takes no local ticket, so this is what starts it.
      const attemptCooldown = {
        revision: state.submissions.length,
        serverTime: Date.now(),
        nextAllowedAt: Date.now() + 2_000,
      };
      // Protocol 5 (multi-prize §2): each adds 0.20 to their 待结算.
      if (state.judge.protocol >= 5) {
        const pending = (Number(state.standing?.pending ?? "0") + 0.2).toFixed(
          2,
        );
        state.standing = {
          pending,
          settled: false,
          view: { summary: `抽了 ${attempt} 张牌` },
        };
        const moved = { added: "0.20", pending };
        state.judgments.unshift({
          attempt,
          at,
          input: body.input ?? "",
          message: "抽到一张",
          moved: { ...moved, settled: false },
        });
        return route.fulfill({
          json: {
            result: "judged",
            message: "抽到一张",
            moved,
            attemptCooldown,
          } satisfies ClaimResult,
        });
      }
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

/** 代码判定's count, in the box under what is typed (judge-page §11.3). */
const boxCount = (page: Page) =>
  page.locator("search").getByText(/^\d+ \/ 200$/);

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
      "每次领多少由判定器判定；开放时公布它的代码指纹，结束后公开代码。",
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
    await expect(entry).toHaveText(/^判定器代码结束后公开$/);
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

  // 自领 (docs/self-claim-design.md): asked the first time for each 红包,
  // kept in this browser once said yes to.
  test("红包作者自己试玩：第一次提交前确认一次，返回什么都不发；确认后这个红包不再问，记在这个浏览器里", async ({
    page,
  }) => {
    await mockSession(page, author);
    const state = await mockCodeHongbao(page);
    await mockLive(page);
    await mockSenderReads(page);
    await openApp(page, path);
    await seal(page).click();
    const input = omniboxInput(page);
    await input.fill("50");
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("dialog", { name: "领自己的红包" });
    await expect(confirm).toContainText("会占掉一份，名单里显示「自领的屑」。");
    await expect(confirm).toContainText("确认后，这个红包不再问。");
    await confirm.getByRole("button", { name: "返回" }).click();
    await expect(confirm).toBeHidden();
    expect(state.submissions).toHaveLength(0);
    await expect(input).toHaveValue("50");
    await input.press("Enter");
    await confirm.getByRole("button", { name: "领取" }).click();
    await expect.poll(() => state.submissions.length).toBe(1);
    // Past the attempt interval: straight on.
    await page.waitForTimeout(2_100);
    await input.fill("40");
    await input.press("Enter");
    await expect.poll(() => state.submissions.length).toBe(2);
    await expect(confirm).toHaveCount(0);
    // Kept in this browser, for this 红包 alone.
    expect(
      await page.evaluate(() => localStorage.getItem("hb.self-claim")),
    ).toBe(JSON.stringify([state.activity.id]));
  });

  test("开：黑漆的代码判定作用域和等宽输入；没领到写判定器的回复，领到后结果里不再写输入；我的记录随之更新", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    await mockLive(page);
    await openApp(page, path);
    await expect(
      page.getByText("点「开」，输入后提交，由判定器判定"),
    ).toBeVisible();
    // Nothing judged yet: no 我的记录.
    await expect(page.locator("[data-hb-part=my-judgments]")).toHaveCount(0);
    await seal(page).click();
    await expect(seal(page)).toHaveAccessibleName("输入后提交");
    const input = omniboxInput(page);
    await expect(input).toBeFocused();
    // The sender's prompt as its placeholder, typed in fixed width.
    await expect(input).toHaveAttribute("placeholder", prompt);
    await expect(input).toHaveClass(/\bfont-mono\b/);
    // 作用域标签 (02 §4): its 主标签 above the box, in lacquer.
    const chip = page.locator("[data-scope-tag=code]");
    // Only the title by the braces; the rules on ⓘ, the count in the box
    // (judge-page §11.3).
    await expect(
      chip.getByText(title, { exact: true }).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(chip).not.toContainText("代码判定");
    await expect(
      page.locator("search").getByRole("button", { name: "提交规则" }),
    ).toHaveAccessibleDescription(
      "原样提交：区分大小写，符号都算，首尾空格会去掉。你的每次提交和判定器的回复，红包作者都看得到。",
    );
    await expect(boxCount(page)).toHaveText("0 / 200");
    // Nothing typed, nothing to run.
    await expect(page.getByRole("option")).toHaveCount(0);
    // Before the first: taking part puts one's name in 参与名单 (02 §4).
    const panel = page.locator(".glass-pop");
    await expect(
      panel.getByText("提交后，你的昵称和判定次数会出现在参与名单里。"),
    ).toBeVisible();
    await input.fill("50");
    await expect(boxCount(page)).toHaveText("2 / 200");
    // No rows: what is typed goes straight to the code.
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(page.getByText("在全部红包中查找")).toHaveCount(0);
    const action = page.locator("search button.btn-lacquer");
    await expect(action).toHaveText("领取");
    await page.keyboard.press("Enter");

    // Turned down: the record under the box leads with it, the code's own
    // words large; the box empties for the next try.
    const record = panel.getByRole("region", { name: "我的记录" });
    await expect(record).toContainText("第 1 次");
    await expect(record).toContainText("没领到");
    await expect(record.getByText("大了", { exact: true })).toBeVisible();
    // What was typed, its own line (the time's digits may read 50 too).
    await expect(record.locator("p", { hasText: /^50$/ })).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "第 1 次：没领到。判定器的回复：大了" }),
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
    await expect(mine.getByRole("heading")).toHaveText("我的记录 · 1 条");
    const first = mine.getByRole("listitem");
    await expect(first).toHaveCount(1);
    await expect(first).toContainText("第 1 次");
    await expect(first).toContainText("没领到");
    await expect(first).toContainText("大了");
    await expect(first).not.toContainText("判定器的回复");
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
    await expect(result).toContainText("判定器的回复：猜对了！");
    await expect(result).toContainText("按上限发");
    await expect(result).toContainText("金额和发放状态仅你可见");
    // What was typed is in 我的记录, not again here (05 §3).
    await expect(result).not.toContainText("口令");
    await expect(result).not.toContainText("输入");
    await expect(result.getByText(answer, { exact: true })).toHaveCount(0);
    await expect(mine.getByRole("heading")).toHaveText("我的记录 · 2 条");
    const latest = mine.getByRole("listitem").first();
    await expect(latest).toContainText("第 2 次");
    await expect(latest).toContainText("领到 0.30 LDC");
    await expect(latest).toContainText("猜对了！");
    await expect(latest).toContainText("按上限发");
    expect(state.judgmentReads.length).toBeGreaterThanOrEqual(3);
  });

  test("判定中：一提交输入就进到最上面的卡里，写正在判定…、扫着金色的光，过 2 秒说还在判定；判定完同一张卡变成结果；没交给代码的卡收起，输入回到框里", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockCodeHongbao(page);
    await mockLive(page);
    // The first answer is lost; the second waits until let go.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route("**/api/activities/*/claim", async (route) => {
      calls += 1;
      if (calls === 1)
        return route.fulfill({
          status: 503,
          json: { error: { code: "HTTP_503", message: "unavailable" } },
        });
      await held;
      return route.fallback();
    });
    await openApp(page, path);
    await seal(page).click();
    const input = omniboxInput(page);
    const panel = page.locator(".glass-pop");
    const action = page.locator("search button.btn-lacquer");
    await input.fill("50");
    await page.keyboard.press("Enter");
    // Never judged: the card folds, the input is back for 重试原提交.
    await expect(action).toHaveText("重试原提交");
    await expect(input).toHaveValue("50");
    await expect(
      panel.getByText("提交后，你的昵称和判定次数会出现在参与名单里。"),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    const record = panel.getByRole("region", { name: "我的记录" });
    await expect(input).toHaveValue("");
    await expect(record).toContainText("第 1 次");
    await expect(record).toContainText("正在判定…");
    // What was typed, its own line (the time's digits may read 50 too).
    await expect(record.locator("p", { hasText: /^50$/ })).toBeVisible();
    await expect(record.locator(".loading-sheen-gold")).toHaveCount(1);
    await expect(
      page.locator("search").getByRole("button", { name: "正在判定…" }),
    ).toBeVisible();
    await expect(panel.getByText("还在判定…")).toBeVisible();
    release();
    // The same card turns into its result.
    await expect(record).toContainText("没领到");
    await expect(record.getByText("大了", { exact: true })).toBeVisible();
    await expect(record.locator(".loading-sheen-gold")).toHaveCount(0);
    await expect(panel.getByText("还在判定…")).toBeHidden();
    await expect(input).toHaveValue("");
  });

  test("排队（一批一起写）：前面有人时马上写前面还有 N 个人，按推来的已判定次数往下减，轮到了回到还在判定…", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    await mockCodeHongbao(page);
    const sockets = await mockLive(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/activities/*/claim", async (route) => {
      await held;
      return route.fallback();
    });
    await openApp(page, path);
    await expect.poll(() => sockets.length).toBe(1);
    await seal(page).click();
    await omniboxInput(page).fill("50");
    await page.keyboard.press("Enter");
    const panel = page.locator(".glass-pop");
    // The 红包's DO: it joined behind three (judged 7 so far).
    sockets[0]?.send(JSON.stringify({ type: "queued", ahead: 3 }));
    await expect(panel.getByText("前面还有 3 个人")).toBeVisible();
    // Two judged ahead of it, pushed together.
    sockets[0]?.send(JSON.stringify({ type: "judged", count: 9, seq: 1 }));
    await expect(panel.getByText("前面还有 1 个人")).toBeVisible();
    sockets[0]?.send(JSON.stringify({ type: "judged", count: 10, seq: 2 }));
    await expect(panel.getByText("还在判定…")).toBeVisible();
    release();
    await expect(panel.getByRole("region", { name: "我的记录" })).toContainText(
      "没领到",
    );
    await expect(panel.getByText("还在判定…")).toBeHidden();
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
    await expect(shown(page, "粘贴的换行已换成空格")).toBeVisible();
    await expect(boxCount(page)).toHaveText("15 / 200");
    // Typing on: still said; cleared, the usual line again.
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect(shown(page, "粘贴的换行已换成空格")).toBeVisible();
    await expect(boxCount(page)).toHaveText("16 / 200");
    await input.fill("");
    await expect(shown(page, "粘贴的换行已换成空格")).toHaveCount(0);
    await expect(boxCount(page)).toHaveText("0 / 200");
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
    await expect(shown(page, "粘贴的换行已换成空格")).toBeVisible();
    await expect(boxCount(page)).toHaveText("4 / 200");
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
    await expect(shown(page, "粘贴的换行已换成空格")).toBeVisible();
    await expect(boxCount(page)).toHaveText(
      `${Array.from(joined).length} / 200`,
    );
    await page.keyboard.press("Enter");
    await expect(
      page.locator(".glass-pop").getByRole("region", { name: "我的记录" }),
    ).toContainText("第 1 次");
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: joined },
    ]);
  });

  test("能赢好几次（multi-prize §4.1）：红包皮写奖池还剩；玩过没结算的人看到只给他看的一句和待结算；我的记录写加减，别人改到他的写是谁的第几次；提交以后待结算马上更新", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const at = (seconds: number) =>
      new Date(Date.parse(openedAt) + seconds * 1000).toISOString();
    const state = await mockCodeHongbao(page, [
      {
        attempt: 2,
        at: at(20),
        by: { name: "小红" },
        message: "小红出了一张大牌",
        moved: { added: "-0.10", pending: "0.30", settled: false },
      },
      {
        attempt: 1,
        at: at(10),
        input: "抽一张",
        message: "抽到 4",
        moved: { added: "0.40", pending: "0.40", settled: false },
      },
    ]);
    state.activity = {
      ...state.activity,
      quantity: { mode: "pool", left: "0.70" },
      reward: { mode: "code", totalAmount: "1.00" },
    };
    state.judge = { ...state.judge, protocol: 5, unclaimed: "0.70" };
    state.standing = {
      pending: "0.30",
      settled: false,
      view: { summary: "手里 3 张牌" },
    };
    await mockLive(page);
    await openApp(page, path);
    // 奖池还剩, not 已领 x / y 份; no 每份至少 under the pool.
    await expect(page.getByText("奖池还剩 70%", { exact: true })).toBeVisible();
    await expect(page.getByText("0.70 LDC", { exact: true })).toBeVisible();
    await expect(page.getByText(/每份至少/)).toHaveCount(0);
    await expect(page.getByText(/ 份$/)).toHaveCount(0);
    // Played and not settled: go on; what only they see, and 待结算.
    await expect(page.getByText("点「开」接着玩")).toBeVisible();
    const standing = page.locator("[data-hb-part=standing]");
    await expect(standing).toContainText("手里 3 张牌");
    await expect(standing).toContainText(
      "待结算 0.30 LDC · 判定器结算或红包结束时发",
    );
    // 我的记录: each move; another's, whose and what it told them.
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的记录 · 2 条");
    const rows = mine.getByRole("listitem");
    await expect(rows.nth(0)).toContainText("小红的第 2 次");
    await expect(rows.nth(0)).toContainText("−0.10 → 0.30");
    await expect(rows.nth(0)).toContainText("小红出了一张大牌");
    await expect(rows.nth(1)).toContainText("第 1 次");
    await expect(rows.nth(1)).toContainText("+0.40 → 0.40");
    await expect(
      rows.nth(1).getByText("抽一张", { exact: true }),
    ).toBeVisible();

    // A submission: its move in full under the box, 待结算 at once.
    await seal(page).click();
    await omniboxInput(page).fill("再抽");
    await page.keyboard.press("Enter");
    const record = page
      .locator(".glass-pop")
      .getByRole("region", { name: "我的记录" });
    await expect(record).toContainText("第 2 次");
    await expect(record).toContainText("+0.20 · 待结算 0.50 LDC");
    await expect(record).toContainText("抽到一张");
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: "再抽" },
    ]);
    await page.keyboard.press("Escape");
    await expect(standing).toContainText("待结算 0.50 LDC");
    await expect(standing).toContainText("抽了 2 张牌");
  });

  test("我的记录：页面上最近 3 次，输入直接显示；全部 N 条的弹窗滚到底再读", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(25));
    await mockLive(page);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的记录 · 25 条");
    await expect(mine.getByText("你和红包作者看得到")).toBeVisible();
    const rows = mine.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("第 25 次");
    await expect(rows.nth(2)).toContainText("第 23 次");
    await expect(rows.nth(0)).toContainText("没领到");
    await expect(rows.nth(0)).toContainText("小了");
    // As typed, no eye (05 §3, 2026-10-25).
    await expect(mine.getByText("答案-25")).toBeVisible();
    await expect(mine.getByText("已隐藏")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "显示输入" })).toHaveCount(0);

    // 全部 25 条: the dialog, twenty more as it scrolls.
    await mine.getByRole("button", { name: "全部 25 条" }).click();
    const dialog = page.getByRole("dialog", { name: "我的记录 · 25 条" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`小满的红包 · ${title}`);
    await expect(dialog.getByText("你和红包作者看得到")).toBeVisible();
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
      dialog.getByText("共 25 条").and(page.locator(":not(.sr-only)")),
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
    // Its sender may try it too (自领, docs/self-claim-design.md); 我的记录
    // shows once they have.
    await expect(
      page.getByRole("button", { name: "输入后提交" }),
    ).toBeEnabled();
    await expect(page.locator("[data-hb-part=my-judgments]")).toHaveCount(0);

    const entry = page.locator("#code-entry");
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "判定器" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`小满的红包 · ${title}`);
    await expect(dialog.getByText("判定器代码 · 结束后公开")).toBeVisible();
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
      dialog.getByText("判定器碰不到网络，只拿得到你的输入、用户名和等级。"),
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
    await expect(row).toContainText("判定器给 0.50，按上限发 0.20");
    await expect(row).toContainText("输入");
    await expect(row.getByText(answer, { exact: true })).toHaveCount(1);
    await expect(row).not.toContainText("已隐藏");
    await expect(
      roster.getByRole("button", { name: "显示名单里的输入" }),
    ).toHaveCount(0);
  });

  // The sender's 名单 line under a name (roster.tsx, the detail span) holds
  // 第 N 次领到, the 输入, 判定器给 …，按上限发 … and 已存入🐟额: in the 480px
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
    const dialog = page.getByRole("dialog", { name: "判定器" });
    await expect(dialog.getByText("判定器代码 · 结束后公开")).toBeVisible();
    await expect(dialog.locator(".cm-editor")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "复制代码", exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByText(fingerprint)).toBeVisible();
    await expect(dialog.getByText(seedCommitment)).toBeVisible();
    await expect(dialog.getByText("不联网", { exact: true })).toBeVisible();
  });

  test("已暂停：印章变淡但不透明、不能点，提示判定器连续出错", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    state.judge = { ...state.judge, paused: true };
    await mockLive(page);
    await openApp(page, path);
    const button = seal(page);
    await expect(button).toHaveAccessibleName("判定器连续出错，暂停领取");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("data-state", "disabled");
    // On the lacquer a see-through seal turns muddy: a faded, solid gold.
    await expect
      .poll(() =>
        button.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await expect(
      page.locator("[data-hb-part=hint]").getByText("判定器连续出错，暂停领取"),
    ).toBeVisible();
    // Pressed anyway: nothing opens, nothing is sent.
    await button.click({ force: true });
    await page.waitForTimeout(300);
    await expect(page.locator("[data-scope-tag]")).toHaveCount(0);
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
    await expect(entry).toHaveText(/^判定器代码已公开$/);
    await entry.click();
    const dialog = page.getByRole("dialog", { name: "判定器" });
    await expect(dialog.getByText("判定器代码 · 已公开")).toBeVisible();
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
      const dialog = page.getByRole("dialog", { name: "判定器" });
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

  test("判定器和参数（judge-square §10）：开放时写判定器、公开参数和几项保密的封存值；结束后保密参数和盐公开，在这里核对", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockCodeHongbao(page);
    const answer = {
      key: "answer",
      label: "答案",
      type: "text" as const,
      secret: true,
    };
    const salt = "5a17".repeat(16);
    const commitment = sha256(`{"answer":"flag{ok}"}\n${salt}`);
    const open: Partial<PublicJudge> = {
      judge: {
        id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
        name: "猜数字",
        version: 3,
        author: { username: "author", displayName: "小满" },
        listed: false,
        featured: false,
        bySiteOwner: false,
        basedOn: null,
      },
      params: [
        {
          param: { key: "max", label: "最大", type: "integer", min: 2 },
          value: 100,
        },
        {
          param: {
            key: "words",
            label: "提示",
            type: "list",
          },
          value: ["一", "二"],
        },
        {
          param: { key: "prize", label: "奖金", type: "money" },
          value: 150,
        },
      ],
      sealedParams: { count: 1, commitment },
    };
    state.judge = { ...publicJudge(), protocol: 3, ...open };
    await openApp(page, path);
    await page.locator("#code-entry").click();
    const dialog = page.getByRole("dialog", { name: "判定器" });
    await expect(
      dialog.getByText("判定器「猜数字」· @author · 第 3 版"),
    ).toBeVisible();
    await expect(dialog.getByText("最大：100")).toBeVisible();
    await expect(dialog.getByText("奖金：1.50 LDC")).toBeVisible();
    const list = dialog.getByText("提示：2 项");
    await list.click();
    await expect(dialog.getByText("二", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("另有 1 项保密参数，结束后公开"),
    ).toBeVisible();
    await expect(dialog.getByText(commitment)).toBeVisible();
    await page.keyboard.press("Escape");

    // Over: the secret one and the salt, checked here.
    state.activity = { ...state.activity, status: "ended" };
    state.judge = {
      ...publicJudge(),
      protocol: 3,
      code: judgeCode,
      seed,
      ...open,
      params: [...(open.params ?? []), { param: answer, value: "flag{ok}" }],
      sealedParams: { count: 1, commitment, salt },
    };
    await openApp(page, path);
    await page.locator("#code-entry").click();
    await expect(dialog.getByText("答案：flag{ok}")).toBeVisible();
    await expect(dialog.getByText(salt)).toBeVisible();
    await expect(
      dialog.getByText(
        "参数封存值 = SHA-256（按键排序的保密参数 JSON、换行、盐）",
      ),
    ).toBeVisible();
    await expect(dialog.getByText("和封存值一致")).toHaveCount(2);
    await expect(dialog.getByText("另有 1 项保密参数，结束后公开")).toHaveCount(
      0,
    );
  });

  test("已结束（参与过）：我的记录照样留着，输入直接显示，没有眼睛", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(5));
    state.activity = { ...state.activity, status: "ended" };
    state.judge = { ...state.judge, code: judgeCode, seed };
    await mockLive(page);
    await openApp(page, path);
    const mine = page.locator("[data-hb-part=my-judgments]");
    await expect(mine.getByRole("heading")).toHaveText("我的记录 · 5 条");
    await expect(mine.getByText("你和红包作者看得到")).toBeVisible();
    await expect(mine.getByRole("listitem")).toHaveCount(3);
    await expect(mine.getByText("答案-5", { exact: true })).toBeVisible();
    await expect(mine.getByText("答案-3", { exact: true })).toBeVisible();
    await expect(mine.getByText("已隐藏")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "显示输入" })).toHaveCount(0);
    // The dialog the same: all of them, plain.
    await mine.getByRole("button", { name: "全部 5 条" }).click();
    const dialog = page.getByRole("dialog", { name: "我的记录 · 5 条" });
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
    const dialog = page.getByRole("dialog", { name: "判定器" });
    await expect(dialog.getByText("https://api.example.com/hb/")).toBeVisible();
    await expect(dialog.getByText("不联网", { exact: true })).toHaveCount(0);
    await expect(dialog).toContainText(
      "判定时判定器会请求这些地址，你的提交（数字 ID、用户名、等级和输入）可能随请求发送给对方。判定结果取决于对方的回答，开放后对方的回答可能变化，本站无法核对。",
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

  test("已结束（联网，参与过）：我的记录里展开看得到每个请求的返回，看不到请求", async ({
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

  test("公开数据和动态（judge-page §11.3）：印章那句话下面是红包状态和最近 5 条动态；推送来的换掉那句话、从上面滑进新动态；全部 N 条的弹窗滚到底再读，读完写已全部加载", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    const line = (n: number, name: string, text: string) => ({
      n,
      at: new Date(Date.parse(openedAt) + n * 30_000).toISOString(),
      text,
      user: { username: name, displayName: name, avatarUrl: null },
    });
    state.announcements = Array.from({ length: 26 }, (_, index) =>
      line(
        25 - index,
        `玩家${25 - index}`,
        `@玩家${25 - index} 猜了 ${50 - index}，安全`,
      ),
    );
    state.judge = {
      ...state.judge,
      protocol: JUDGE_PROTOCOL,
      view: {
        at: new Date(Date.parse(openedAt) + 60_000).toISOString(),
        summary: "安全区间 23–67，还剩 3 颗炸弹",
        data: { low: 23, high: 67 },
      },
      announcements: {
        total: state.announcements.length,
        latest: state.announcements.slice(0, 5),
      },
    };
    const sockets = await mockLive(page);
    await openApp(page, path);
    const board = page.locator("[data-hb-part=judge-board]");
    await expect(
      board.getByRole("heading", { name: "红包状态" }),
    ).toBeVisible();
    await expect(
      board.getByText("安全区间 23–67，还剩 3 颗炸弹"),
    ).toBeVisible();
    const rows = board.getByRole("listitem");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("玩家25");
    await expect(rows.first()).toContainText("@玩家25 猜了 50，安全");
    // It sits right under the seal's line, before anything else on the page.
    const hint = await page.locator("[data-hb-part=hint]").boundingBox();
    const top = await board.boundingBox();
    expect(top && hint && top.y > hint.y).toBe(true);

    // Pushed with 已判定: the sentence changes, a new line slides in on top.
    await expect.poll(() => sockets.length).toBe(1);
    const before = { ...state.reads };
    sockets[0]?.send(
      JSON.stringify({
        type: "view",
        view: {
          at: new Date().toISOString(),
          summary: "安全区间 23–40，还剩 3 颗炸弹",
        },
      }),
    );
    sockets[0]?.send(
      JSON.stringify({
        type: "announce",
        items: [line(26, "新来的", "@新来的 猜了 41，安全")],
        total: 27,
      }),
    );
    await expect(
      board.getByText("安全区间 23–40，还剩 3 颗炸弹"),
    ).toBeVisible();
    await expect(rows.first()).toContainText("@新来的 猜了 41，安全");
    await expect(rows).toHaveCount(5);
    expect(state.reads).toEqual(before);

    // 全部 27 条: the dialog, twenty at a time.
    state.announcements.unshift(line(26, "新来的", "@新来的 猜了 41，安全"));
    await board.getByRole("button", { name: "全部 27 条" }).click();
    const dialog = page.getByRole("dialog", { name: "动态 · 27 条" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("listitem").first()).toContainText(
      "@新来的 猜了 41，安全",
    );
    // Short rows: the next twenty are read ahead (600 px before the end).
    await dialog
      .locator(".view-scroll")
      .evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(dialog.getByRole("listitem")).toHaveCount(27);
    await expect(
      dialog.getByText("已全部加载").and(page.locator(":not(.sr-only)")),
    ).toBeVisible();
    expect(state.announcementReads.filter((cursor) => cursor !== null)).toEqual(
      ["7"],
    );
  });

  test("指令框（judge-page §11.3）：框下面先是红包状态和最新一条动态，再是我的记录 · N 次，每次一样排：第几次和时间、结果，判定器的回复，输入；最新一次只是底色不同", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page, rejected(3));
    state.judge = {
      ...state.judge,
      protocol: JUDGE_PROTOCOL,
      view: { at: openedAt, summary: "安全区间 23–67，还剩 3 颗炸弹" },
      announcements: {
        total: 1,
        latest: [
          {
            n: 0,
            at: openedAt,
            text: "猜了 22，安全",
            user: { username: "p1", displayName: "玩家1", avatarUrl: null },
          },
        ],
      },
    };
    const sockets = await mockLive(page);
    await openApp(page, path);
    await seal(page).click();
    const panel = page.locator(".glass-pop");
    const status = panel.getByRole("region", { name: "红包状态" });
    await expect(status).toContainText("红包状态");
    await expect(status).toContainText("安全区间 23–67，还剩 3 颗炸弹");
    await expect(status).toContainText("@玩家1：猜了 22，安全");
    const record = panel.getByRole("region", { name: "我的记录" });
    await expect(record.getByRole("heading")).toHaveText("我的记录 · 3 条");
    const rows = record.getByRole("listitem");
    await expect(rows).toHaveCount(3);
    // In order: 第几次 and when with the result; the reply; what was typed.
    await expect(rows.first()).toHaveText(/^第 3 次 · [\d:]+没领到小了答案-3$/);
    await expect(rows.nth(1)).toHaveText(/^第 2 次 · [\d:]+没领到小了答案-2$/);
    // The newest differs in its ground alone.
    const ground = (index: number) =>
      rows
        .nth(index)
        .locator(".grid")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(await ground(0)).not.toBe(await ground(1));
    expect(await ground(1)).toBe(await ground(2));
    // A push changes the sentence and the line under it.
    await expect.poll(() => sockets.length).toBe(1);
    sockets[0]?.send(
      JSON.stringify({
        type: "view",
        view: { at: new Date().toISOString(), summary: "安全区间 23–40" },
      }),
    );
    sockets[0]?.send(
      JSON.stringify({
        type: "announce",
        total: 2,
        items: [
          {
            n: 1,
            at: new Date().toISOString(),
            text: "猜了 41，安全",
            user: { username: "p2", displayName: "玩家2", avatarUrl: null },
          },
        ],
      }),
    );
    await expect(status).toContainText("安全区间 23–40");
    await expect(status).toContainText("@玩家2：猜了 41，安全");
  });

  test("判定器结束：状态写判定器结束，印章下面写判定器结束了这个红包，红包状态照样在", async ({
    page,
  }) => {
    await mockSession(page, null);
    const state = await mockCodeHongbao(page);
    state.activity = { ...state.activity, status: "ended" };
    state.judge = {
      ...state.judge,
      protocol: JUDGE_PROTOCOL,
      endedByCode: true,
      code: judgeCode,
      seed,
      view: { at: openedAt, summary: "炸弹在 42，被玩家1 踩中了" },
    };
    await openApp(page, path);
    await expect(
      page
        .locator("[data-hb-part=stats]")
        .getByText("判定器结束", { exact: true }),
    ).toBeVisible();
    await expect(seal(page)).toHaveAccessibleName("判定器结束了这个红包");
    await expect(
      page.locator("[data-hb-part=hint]").getByText("判定器结束了这个红包"),
    ).toBeVisible();
    await expect(page.locator("[data-hb-part=hero]")).toHaveClass(
      /\bhb-ended\b/,
    );
    // Guests see what everyone sees; no 动态 yet, no such part.
    const board = page.locator("[data-hb-part=judge-board]");
    await expect(board.getByText("炸弹在 42，被玩家1 踩中了")).toBeVisible();
    await expect(board.getByRole("heading", { name: "动态" })).toHaveCount(0);
  });

  test("作用域标签（02 §4）：主标签在框上方、左边和框对齐，框让出位置；不比框宽，太长省略、悬停看全名；点 × 去掉作用域，框回到原位", async ({
    page,
  }) => {
    await mockSession(page, viewer);
    const state = await mockCodeHongbao(page);
    const long =
      "2026 年终抽奖 · 数字炸弹大挑战（第二季）请大家踊跃参与，规则见红包说明，猜中的人领一份，没猜中的明天还有机会再来";
    state.activity = { ...state.activity, title: long };
    await mockLive(page);
    await openApp(page, path);
    await seal(page).click();
    const input = omniboxInput(page);
    await expect(input).toBeFocused();
    const tag = page.locator("[data-scope-tag=code]");
    const box = page.locator("search");
    // Settled: the box below the 主标签, 6px apart, their left edges as one.
    await page.waitForTimeout(800);
    const tagBox = await tag.boundingBox();
    const boxBox = await box.boundingBox();
    if (!tagBox || !boxBox) throw new Error("No tag or box");
    expect(Math.abs(tagBox.x - boxBox.x)).toBeLessThan(1);
    expect(boxBox.y - (tagBox.y + 26)).toBeCloseTo(6, 0);
    // Never wider than the box; cut short, its whole name on hover.
    const shown = tag.getByRole("button", { name: long });
    const shownBox = await shown.boundingBox();
    expect((shownBox?.x ?? 0) + (shownBox?.width ?? 0)).toBeLessThanOrEqual(
      boxBox.x + boxBox.width,
    );
    await expect(shown).toHaveAccessibleDescription(long);
    // The input starts past the 图标标签, nearly the whole row.
    const inputBox = await input.boundingBox();
    expect((inputBox?.x ?? 0) - boxBox.x).toBeLessThan(70);
    // ×: the scope goes, and the box moves back up by the 主标签's room.
    await tag.getByRole("button", { name: "改为查找全部红包" }).click();
    await expect(tag).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect
      .poll(async () => (await box.boundingBox())?.y ?? 0)
      .toBeCloseTo(boxBox.y - 32, 0);
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
        /** Each version's tests as last run (testsFile when not given). */
        tests?: Record<number, string>;
      };
    } = {},
  ) {
    type Kept = {
      name: string;
      description: string;
      versions: JudgeVersions["versions"];
      codes: Map<number, string>;
      tests: Map<number, string>;
    };
    const state = {
      deploysLeft,
      requests: [] as {
        code: string;
        tests: string;
        judge?:
          | { id: string }
          | { name: string; description?: string; codePublic?: string };
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
        tests: new Map(
          Object.entries(judge.tests ?? {}).map(([n, tests]) => [
            Number(n),
            tests,
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
    /** 我的判定器 as the 广场's 我的 and the 判定器页 read it. */
    const declarations = {
      meta: null,
      params: [],
      hongbao: null,
      check: false,
    };
    const mineOf = (judgeId: string, kept: Kept) => {
      const latest = kept.versions.at(-1);
      const usable = [...kept.versions]
        .reverse()
        .find((v) => v.passed && (v.protocol ?? 1) >= JUDGE_OLDEST_PROTOCOL);
      return {
        id: judgeId,
        name: kept.name,
        description: kept.description,
        codePublic: "ended" as const,
        createdAt: openedAt,
        updatedAt: openedAt,
        latest: latest
          ? { n: latest.n, deployedAt: latest.at, passed: latest.passed }
          : null,
        usable: usable
          ? { n: usable.n, declarations, network: usable.network ?? null }
          : null,
        opened: 0,
        listed: false,
        featurable: true,
        takenDown: null,
        featured: null,
        stats: { hongbao: 0, judged: 0, claimed: 0 },
      };
    };
    // 判定器广场: empty; a 判定器页 only for one's own (made here).
    await page.route("**/api/judges**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/judges")
        return route.fulfill({ json: { items: [], nextCursor: null } });
      const judgeId = path.split("/")[3] ?? "";
      const kept = state.judges.get(judgeId);
      if (!kept || path !== `/api/judges/${judgeId}`)
        return route.fulfill({ status: 404, json: { error: {} } });
      return route.fulfill({
        json: {
          judge: {
            ...mineOf(judgeId, kept),
            author: {
              username: user.username,
              displayName: user.displayName,
              avatarUrl: null,
            },
            basedOn: null,
            featured: false,
            bySiteOwner: false,
            network: false,
            own: true,
            version: null,
            versions: [],
          },
        },
      });
    });
    // 我的判定器: those deployed here (or given), each version's code and
    // tests as the 判定器页's 部署新版本 starts from.
    await page.route("**/api/me/judges**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/me/judges")
        return route.fulfill({
          json: {
            items: [...state.judges].map(([judgeId, kept]) =>
              mineOf(judgeId, kept),
            ),
          },
        });
      const [, , , , judgeId, more, n] = path.split("/");
      const kept = state.judges.get(judgeId ?? "");
      if (!kept) return route.fulfill({ status: 404, json: { error: {} } });
      if (more === "versions" && n) {
        const code = kept.codes.get(Number(n));
        if (code === undefined)
          return route.fulfill({ status: 404, json: { error: {} } });
        return route.fulfill({
          json: {
            code,
            tests: kept.tests.get(Number(n)) ?? testsFile,
            versions: versionsOf(kept),
            declarations,
          },
        });
      }
      return route.fulfill({
        json: {
          judge: {
            ...mineOf(judgeId ?? "", kept),
            publicN: null,
            versions: kept.versions.map((version) => ({
              n: version.n,
              fingerprint: version.fingerprint,
              deployedAt: version.at,
              checkedAt: version.at,
              protocol: version.protocol ?? 1,
              testsDigest: version.testsDigest,
              passed: version.passed,
              network: version.network ?? null,
              declarations,
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
        tests: new Map(),
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
      kept.tests.set(n, input.tests);
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

  /**
   * /judges/new (judge-square §16.1), where a 判定器 is written now (发红包
   * only picks one, §16.3): its name typed. Its first deploy goes on to
   * its 判定器页, whose 部署新版本 is the same card.
   */
  async function toWriter(page: Page, name = "猜数字") {
    await openApp(page, "/judges/new");
    await expect(page.locator("#hb-code-code")).toBeVisible();
    if (name) await page.locator("#hb-judge-name").fill(name);
  }

  /** The first deploy made it: its 判定器页, one card again (not two). */
  async function onJudgePage(page: Page, judgeId = "judge-1") {
    await expect(page).toHaveURL(new RegExp(`/judges/${judgeId}$`));
    await expect(page.locator("#hb-code-code")).toHaveCount(1);
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

  /**
   * Pasted, deployed and passed: 判定器 第 1 版, on its 判定器页 now, where
   * 部署新版本 starts from it.
   */
  async function deployFirst(page: Page) {
    await pasteCode(page, firstCode, "粘贴代码");
    await typeTests(page, testsFile);
    await deployButton(page).click();
    await onJudgePage(page);
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
  }

  test("没开通 PLUS、只有商户也能发（2026-10-28）：卡上没有 PLUS；从商户直发，说明写分发费", async ({
    page,
  }) => {
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
    await mockMyJudges(page);
    await openApp(page, "/new");
    const pick = page.getByRole("button", { name: /^代码判定/ });
    await expect(pick).toBeVisible();
    await expect(pick).not.toContainText("PLUS");
    // 判定器 first (judge-square §6), then 发多少.
    await pickMine(page);
    await page.locator("#hb-param-answer").fill("42");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(page.locator("#hb-code-total")).toBeVisible();
    await expect(
      page.getByText(/Credit 站会按你在 Credit 站的等级扣分发费/),
    ).toBeVisible();
    await expect(page.getByText("代码判定红包只能从🐟额发。")).toHaveCount(0);
  });

  test("/judges/new：judge.js 是判定器卡，不是编辑框；tests.json 还是 CodeMirror 编辑器，能打字，条数跟着变，空的时候光标只有一行高", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toWriter(page);
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

  test("/judges/new 还没有代码：卡里只有粘贴代码和从文件选；部署并跑测试灰着，旁边写今天还能部署几次", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toWriter(page);
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

  test("部署新代码：贴上是新代码、未部署，折起只露前 6 行；部署并跑测试以后到它的判定器页，是判定器 第 1 版，测试全过，展开看得到指纹", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toWriter(page);
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
    // Made: on to its 判定器页 (§15.4), whose 部署新版本 starts from it.
    await onJudgePage(page);
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    await expect(card(page)).toContainText(/\d\d:\d\d 部署/);
    // Into a new 判定器, by the name typed (judge-square §1), with its
    // 设置 (§16.1).
    expect(server.requests).toEqual([
      {
        code: firstCode,
        tests: testsFile,
        judge: { name: "猜数字", description: "", codePublic: "ended" },
      },
    ]);
    const rows = page.getByRole("list", { name: "测试结果" });
    await expect(rows).toContainText("import 都在清单里");
    await expect(rows).toContainText("代码能加载、导出了 judge");
    await expect(rows).toContainText("测试 1 / 1 通过 · 最慢 3 毫秒");
    // Deployed and passed: nothing more to deploy, focus on the rows.
    await expect(deployButton(page)).toHaveCount(0);
    await expect(page.locator("#hb-code-check")).toBeFocused();

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
    await toWriter(page);
    const networked = `export const network = ["https://api.example.com/hb/"];\n${firstCode}`;
    await pasteCode(page, networked, "粘贴代码");
    await typeTests(page, testsFile);
    await deployButton(page).click();
    await onJudgePage(page);
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
    await toWriter(page);
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

  test("只改了测试：同一版换成提示和重新跑测试，不算部署", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page);
    await toWriter(page);
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

    await area.getByRole("button", { name: "重新跑测试" }).click();
    await expect(area).not.toContainText("tests.json 改过了");
    await expect(area).toBeFocused();
    expect(server.requests).toEqual([
      {
        code: firstCode,
        tests: testsFile,
        judge: { name: "猜数字", description: "", codePublic: "ended" },
      },
      // Into the 判定器 the first made.
      { code: firstCode, tests: changedTests, judge: { id: "judge-1" } },
    ]);
    // A rerun counts nothing: the same 6 left.
    expect(server.deploysLeft).toBe(6);
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
  });

  // A draft whose code was written on 发红包 before it only picked (§16.3).
  const unsaved = (page: Page) => page.locator("#hb-judge-picked");

  test("草稿里没部署过的代码（§16.3）：第 2 步是一条琥珀提示，没有判定器卡；保存并开放被拦住，回到这条提示", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const server = await mockDeploys(page, { user: author });
    await mockSenderReads(page, {
      draft: { code: firstCode, tests: testsFile },
    });
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：新代码/ }).click();
    await expect(unsaved(page)).toContainText(
      "这份草稿里的代码还没有部署成判定器。发红包这里不再写代码：去写一个判定器部署它，或者换一个判定器。",
    );
    await expect(unsaved(page).getByRole("button")).toHaveText([
      "去写一个判定器",
      "换一个",
    ]);
    // Nothing to write or deploy here.
    await expect(page.locator(".hb-judge-name")).toHaveCount(0);
    await expect(deployButton(page)).toHaveCount(0);
    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect(unsaved(page)).toBeFocused();
    expect(server.requests).toHaveLength(0);
  });

  test("今天的部署次数用完了：新代码部署不了，写明天再来，部署过的判定器换回去照样能开放", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const server = await mockDeploys(page, { deploysLeft: 0 });
    await toWriter(page);
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
    await toWriter(page);
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
    await toWriter(page);
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
    await toWriter(page);
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

  test("部署了测试没过：到它的判定器页，卡上写已部署 · 测试没过，折起的代码也露出标红的行号；按钮灰着，写改出新版本才能再部署", async ({
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
    await toWriter(page);
    await pasteCode(page, brokenCode, "粘贴代码");
    await typeTests(page, testsFile);
    const button = deployButton(page);
    await button.click();
    // Made, though its tests failed: on to its 判定器页.
    await onJudgePage(page);
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
    // The same version takes no second deploy; its results have focus
    // on the 判定器页 it went on to.
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#hb-code-check")).toBeFocused();
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
    await toWriter(page);
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
    await toWriter(page);
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

  test("草稿重新打开（新的页面）：代码不是测试全过的版本，换回第 1 版就是那张卡，不说测试改过了，保存并开放不被拦住，由服务器说", async ({
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
    await expect(unsaved(page)).toContainText(
      "这份草稿里的代码还没有部署成判定器。",
    );
    await expect(unsaved(page).getByRole("button")).toHaveText([
      "去写一个判定器",
      "换回第 1 版",
      "换一个",
    ]);
    await unsaved(page).getByRole("button", { name: "换回第 1 版" }).click();
    // The version that passed, picked: its card.
    await expect(page.getByText("我的 · 第 1 版")).toBeVisible();
    await expect(page.getByText(/还没有部署成判定器/)).toHaveCount(0);
    await expect(page.getByText(/重新跑一遍测试/)).toHaveCount(0);

    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(saves[0]?.activity.judge?.code).toBe(firstCode);
    expect(server.requests).toHaveLength(0);
  });

  test("草稿重新打开：第 1 版上次跑的是另一份测试，换回后提示要在线上重新跑，重新跑就是那张卡，不算部署", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const server = await mockDeploys(page, { user: author });
    // Its 第 1 版 is on the server: running it again is a rerun.
    server.ran.add(sha256(firstCode));
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
    await unsaved(page).getByRole("button", { name: "换回第 1 版" }).click();
    await expect(unsaved(page)).toContainText(
      "这份草稿里的判定器 第 1 版要在线上重新跑一遍测试才能开放，不算部署。",
    );
    await expect(unsaved(page).getByRole("button")).toHaveText([
      "重新跑测试",
      "换一个",
    ]);
    // 保存并开放 waits for the rerun, back on this callout.
    await page.getByRole("button", { name: "保存并开放" }).click();
    await expect(unsaved(page)).toBeFocused();
    expect(server.requests).toHaveLength(0);
    await unsaved(page).getByRole("button", { name: "重新跑测试" }).click();
    await expect(page.getByText("我的 · 第 1 版")).toBeVisible();
    // Its rerun, in the 判定器 the draft is in: no deploy counted.
    expect(server.requests).toEqual([
      { code: firstCode, tests: testsFile, judge: { id: E2E_JUDGE } },
    ]);
    expect(server.deploysLeft).toBe(7);
  });

  test("草稿重新打开：旧协议上部署过、测试全过的版本（旧判定器），换回后要按新规则重新跑一遍，不算部署", async ({
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
            // Run before 第二版: no protocol written (v1), a 旧判定器 now.
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
    await unsaved(page).getByRole("button", { name: "换回第 1 版" }).click();
    await expect(unsaved(page)).toContainText(
      "这份草稿里的判定器 第 1 版是按旧规则（有份数）写的，要按新规则重新跑一遍测试才能开放，不算部署。",
    );
    await unsaved(page)
      .getByRole("button", { name: "按新规则重新跑测试" })
      .click();
    await expect(page.getByText("我的 · 第 1 版")).toBeVisible();
    // Its rerun, in the 判定器 the draft is in.
    expect(server.requests).toEqual([
      { code: firstCode, tests: testsFile, judge: { id: E2E_JUDGE } },
    ]);
  });

  test("草稿重新打开：草稿里的那一版测试没过，提示去判定器页部署新版本或者换一个", async ({
    page,
  }) => {
    await mockCodeHongbao(page);
    const failing = firstCode.replace("猜对了！", "BROKEN");
    const server = await mockDeploys(page, { user: author });
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
            protocol: JUDGE_PROTOCOL,
          },
        ],
      },
    });
    await openApp(page, `${path}/📝`);
    await page
      .getByRole("button", { name: /^第 2 步 判定器：猜数字 · 第 1 版/ })
      .click();
    await expect(unsaved(page)).toContainText(
      "这份草稿里的判定器 第 1 版测试没过。去判定器页部署新版本，或者换一个判定器。",
    );
    const there = unsaved(page).getByRole("link", { name: "去判定器页 ↗" });
    await expect(there).toHaveAttribute("href", `/judges/${E2E_JUDGE}`);
    await expect(there).toHaveAttribute("target", "_blank");
    await expect(
      unsaved(page).getByRole("button", { name: "换一个" }),
    ).toBeVisible();
    // 换一个: the two ways to pick, and back to this callout.
    await unsaved(page).getByRole("button", { name: "换一个" }).click();
    await expect(
      page.getByRole("button", { name: /^去判定器广场挑一个/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "不换了" }).click();
    await expect(unsaved(page)).toContainText("测试没过");
    expect(server.requests).toHaveLength(0);
  });

  test("判定器页：最新一版测试没过、没留下是哪几条，重新跑测试就看得到，不算部署", async ({
    page,
  }) => {
    const failing = firstCode.replace("猜对了！", "BROKEN");
    const server = await mockDeploys(page, {
      judge: {
        id: "judge-9",
        name: "猜数字",
        versions: {
          next: 2,
          versions: [
            {
              n: 1,
              fingerprint: sha256(failing),
              at: openedAt,
              testsDigest: sha256(testsFile),
              passed: false,
              protocol: JUDGE_PROTOCOL,
            },
          ],
        },
        codes: { 1: failing },
      },
    });
    // Deployed before, on the page that made it.
    server.ran.add(sha256(failing));
    await openApp(page, "/judges/judge-9");
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
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
    expect(server.requests).toEqual([
      { code: failing, tests: testsFile, judge: { id: "judge-9" } },
    ]);
    // The rows are back: nothing more to bring back.
    await expect(area.getByRole("button", { name: "重新跑测试" })).toHaveCount(
      0,
    );
  });

  test("草稿重新打开：从判定器以前写在这里、没部署的代码，去写一个判定器把代码和测试带到 /judges/new；在别处测试全过过的部署后是第 1 版，不扣次数", async ({
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
    await unsaved(page).getByRole("button", { name: "去写一个判定器" }).click();
    await expect(page).toHaveURL(/\/judges\/new$/);
    await expect(
      page.getByRole("heading", { name: "写一个判定器", level: 1 }),
    ).toBeVisible();
    // Its code and tests came along (this tab only); no name before 判定器.
    await expect(cardName(page)).toHaveText("新代码");
    await expect(cardState(page)).toHaveText("未部署");
    await expect(
      page.getByRole("textbox", { name: /^tests\.json/ }),
    ).toHaveAccessibleName(/1 条测试$/);
    await expect(page.locator("#hb-judge-name")).toHaveValue("");
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
    await onJudgePage(page);
    await expect(cardName(page)).toHaveText("判定器 第 1 版");
    await expect(cardState(page)).toHaveText("已部署 · 测试全过");
    expect(server.requests).toEqual([
      {
        code: firstCode,
        tests: testsFile,
        judge: { name: "猜数字", description: "", codePublic: "ended" },
      },
    ]);
    expect(server.deploysLeft).toBe(7);
    // Taken once: /judges/new opens empty again.
    await openApp(page, "/judges/new");
    await expect(card(page)).toContainText("在本地开发包里写好 judge.js");
  });

  test("Windows 换行的 judge.js：在这里改打一个字再删掉，还是没有改动，用这份代码不能按", async ({
    page,
  }) => {
    await mockDeploys(page);
    await toWriter(page);
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

  test("编辑页（开放后，没有存下版本）：条上和卡上都写判定器，不写新代码，也不提示去部署", async ({
    page,
  }) => {
    await mockSession(page, author);
    await mockCodeHongbao(page);
    await mockNoMerchant(page);
    await mockSenderReads(page);
    await openApp(page, `${path}/📝`);
    await page.getByRole("button", { name: /^第 2 步 判定器：判定器/ }).click();
    const picked = page.locator("#hb-judge-picked");
    await expect(picked).toContainText("判定器");
    await expect(picked).toContainText("我的");
    await expect(picked).not.toContainText("第");
    await expect(picked).not.toContainText("新代码");
    await expect(picked).not.toContainText("还没有部署成判定器");
    await expect(picked.getByRole("button")).toHaveText(["查看代码"]);
    await picked.getByRole("button", { name: "查看代码" }).click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog).toContainText("判定器「判定器」");
    await expect(dialog).not.toContainText("第 ");
    await expect(dialog.getByRole("textbox")).toContainText("export function");
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
    // The folded card (§16.3), 查看代码 only: no 换一个, no writer.
    const picked = page.locator("#hb-judge-picked");
    await expect(picked).toContainText("猜数字");
    await expect(picked).toContainText("我的 · 第 2 版");
    await expect(picked.getByRole("button")).toHaveText(["查看代码"]);
    await expect(page.locator(".hb-judge-name")).toHaveCount(0);
    await expect(page.locator("#hb-code-check")).toHaveCount(0);
    await picked.getByRole("button", { name: "查看代码" }).click();
    const dialog = page.getByRole("dialog", { name: "代码" });
    await expect(dialog).toContainText("判定器「猜数字」· 第 2 版");
    await expect(dialog.getByRole("textbox")).toContainText("export function");
    // One's own: changed on its 判定器页, in a new tab.
    const there = dialog.getByRole("link", { name: "去判定器页改 ↗" });
    await expect(there).toHaveAttribute("href", `/judges/${E2E_JUDGE}`);
    await expect(there).toHaveAttribute("target", "_blank");
    await dialog.getByRole("button", { name: "关闭" }).click();
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
      updates: [] as Record<string, unknown>[],
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
      listed: false,
      featurable: true,
      takenDown: null,
      featured: null,
      stats: { hongbao: 2, judged: 9, claimed: 3 },
      publicN: null,
    };
    // Its 判定器页 is its author's own.
    await page.route(`**/api/judges/${GUESS_ID}`, (route) =>
      route.fulfill({
        json: {
          judge: {
            ...judge,
            author: { username: "e2e", displayName: "测", avatarUrl: null },
            basedOn: null,
            bySiteOwner: false,
            network: false,
            own: true,
            version: null,
            versions: [],
          },
        },
      }),
    );
    await page.route("**/api/me/judges**", (route) => {
      const url = new URL(route.request().url());
      const rest = url.pathname.slice("/api/me/judges".length);
      if (rest === "") return route.fulfill({ json: { items: [judge] } });
      // 判定器页's settings: name, line and 代码公开 together.
      if (rest === `/${GUESS_ID}` && route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        asked.updates.push(body);
        Object.assign(judge, body);
      }
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
              ? { failure: "timeout", detail: "超过 1 秒没有判定完" }
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

  /**
   * /new to 代码判定's 第 2 步 (§16.3): its two ways — the 广场 over the
   * form, /judges/new — and 猜数字 picked from the 广场's 我的.
   */
  async function pickMine(page: Page) {
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await page.getByRole("button", { name: /^去判定器广场挑一个/ }).click();
    const square = page.getByRole("dialog", { name: "判定器广场" });
    await square.getByRole("button", { name: "我的" }).click();
    const mine = square.getByRole("button", { name: /猜数字/ });
    await expect(mine).toContainText("猜中的领");
    await mine.click();
    await expect(square).toBeHidden();
    // Folded into one card; its params under it.
    await expect(page.getByText("我的 · 第 3 版")).toBeVisible();
  }

  test("我的判定器：在广场弹窗的我的里挑一个收起成一张卡，参数按它的声明、过它的 check，发多少按它的默认值和范围；存草稿带上它的判定器、名字和说明，不带版本", async ({
    page,
  }) => {
    await mockDeploys(page);
    const asked = await mockMyJudges(page);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    // Two ways only (§16.3): no list of one's own on the step.
    await expect(page.getByRole("group", { name: "我的判定器" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: /^去判定器广场挑一个/ }),
    ).toContainText("站长精选、大家做的，还有我的判定器");
    await expect(page.getByRole("link", { name: /^自己写一个/ })).toContainText(
      "在新页面写好、部署，再回来挑",
    );
    // 下一步 with none picked: said under the two.
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(
      page.getByText("先挑一个判定器", { exact: true }),
    ).toBeVisible();
    await pickMine(page);
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
    // 发多少: its default pool; no 份数 any more (multi-prize §4.2).
    await expect(page.locator("#hb-code-total")).toHaveValue("5.00");
    await expect(page.locator("#hb-code-count")).toHaveCount(0);
    expect(asked.checks.at(-1)?.params).toEqual({ max: 100, answer: 42 });
    await page.getByRole("button", { name: "下一步" }).first().click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => asked.saved.length).toBe(1);
    expect(asked.saved[0]?.activity.judge).toMatchObject({
      judgeId: GUESS_ID,
      name: "猜数字",
      description: "猜中的领",
      code: firstCode,
      params: { max: 100, answer: 42 },
    });
    // Its versions are the 判定器's (judge-square §1), not the draft's.
    expect(asked.saved[0]?.activity.judge).not.toHaveProperty("versions");
  });

  test("试一试：默认折起，按现在的参数判定一次，写会发多少和回复，超时写判定超时", async ({
    page,
  }) => {
    await mockDeploys(page);
    const asked = await mockMyJudges(page);
    await pickMine(page);
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

  test("换一个回到两张卡，不换了回到原来那张；自己写一个去 /judges/new（先问没保存的修改），那里是空的，贴上带 meta 的代码就填好名字和说明", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockDeploys(page);
    await mockMyJudges(page);
    await pickMine(page);
    await page.locator("#hb-param-answer").fill("42");
    await page.getByRole("button", { name: "换一个" }).click();
    await expect(
      page.getByRole("button", { name: /^去判定器广场挑一个/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "不换了" }).click();
    await expect(page.getByText("我的 · 第 3 版")).toBeVisible();
    await expect(page.locator("#hb-param-answer")).toHaveValue("42");
    await page.getByRole("button", { name: "换一个" }).click();
    await page.getByRole("link", { name: /^自己写一个/ }).click();
    // What was filled in is not saved: asked first, as any link is.
    const leave = page.getByRole("dialog", { name: "还有没保存的修改" });
    await leave.getByRole("button", { name: "放弃修改并离开" }).click();
    await expect(page).toHaveURL(/\/judges\/new$/);
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

  // 我的判定器 and 判定器页 (docs/judge-square-design.md §8, §14.4).
  test("我的判定器：一行写名字、说明、第几版和部署日期、开放过几个；点进判定器页，用它发红包回到第 2 步，焦点在第一项参数", async ({
    page,
  }) => {
    await mockDeploys(page);
    await mockMyJudges(page);
    await openApp(page, "/judges?tab=mine");
    await expect(
      page.getByRole("heading", { name: "判定器广场", level: 1 }),
    ).toBeVisible();
    const day = `${new Date(openedAt).getMonth() + 1}月${new Date(openedAt).getDate()}日`;
    const row = page.getByRole("link", { name: /猜数字/ });
    await expect(row).toContainText("猜中的领");
    await expect(row).toContainText(`第 3 版 · ${day}部署 · 开放过 2 个`);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/judges/${GUESS_ID}$`));
    await expect(
      page.getByRole("heading", { name: "猜数字", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("第 3 版 · 发过 2 个红包 · 判定 9 次 · 领到 3 人次"),
    ).toBeVisible();
    await page.getByRole("link", { name: "用它发红包" }).click();
    await expect(page).toHaveURL(new RegExp(`/new\\?judge=${GUESS_ID}$`));
    await expect(page.getByText("我的 · 第 3 版")).toBeVisible();
    await expect(page.locator("#hb-param-max")).toBeFocused();
    await expect(page.locator("#hb-param-max")).toHaveValue("100");
    // A starting point, not a change: leaving asks nothing.
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/judges/${GUESS_ID}$`));
  });

  test("用它发红包：一进来就是代码判定的第 2 步，判定器读到以前那张卡写正在读取…；没有测试全过的版本，就在第 2 步说出来，下面照常是两条挑法", async ({
    page,
  }) => {
    await mockDeploys(page);
    await mockMyJudges(page);
    // Its version held until the card has been seen.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/me/judges/${GUESS_ID}/versions/3`,
      async (route) => {
        await held;
        return route.fallback();
      },
    );
    await openApp(page, `/new?judge=${GUESS_ID}`);
    await expect(
      page.getByRole("status").filter({ hasText: "猜数字" }),
    ).toContainText("正在读取…");
    await expect(
      page.getByText("代码判定", { exact: true }).first(),
    ).toBeVisible();
    release();
    await expect(page.getByText("我的 · 第 3 版")).toBeVisible();
    await expect(page.locator("#hb-param-max")).toBeFocused();

    const NONE = "33333333-4444-4555-8666-777777777777";
    await page.route(`**/api/me/judges/${NONE}`, (route) =>
      route.fulfill({
        json: {
          judge: {
            id: NONE,
            name: "还在改",
            description: "",
            usable: null,
            versions: [],
          },
        },
      }),
    );
    await openApp(page, `/new?judge=${NONE}`);
    await expect(
      page.getByText("这个判定器还没有测试全过的版本。"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^去判定器广场挑一个/ }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /^自己写一个/ })).toBeVisible();
  });

  test("判定器页：改名字和说明，保存后写已保存；改成一直公开先确认，改了就改不回来", async ({
    page,
  }) => {
    await mockDeploys(page);
    const asked = await mockMyJudges(page);
    await openApp(page, `/judges/${GUESS_ID}`);
    const name = page.getByRole("textbox", { name: "名字" });
    await expect(name).toHaveValue("猜数字");
    await name.fill("猜大小");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("已保存")).toBeVisible();
    expect(asked.updates.at(-1)).toEqual({
      name: "猜大小",
      description: "猜中的领",
      codePublic: "ended",
    });
    await expect(
      page.getByRole("heading", { name: "猜大小", level: 1 }),
    ).toBeVisible();
    await name.fill("");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("先给判定器起个名字")).toBeVisible();
    expect(asked.updates).toHaveLength(1);
    await name.fill("猜大小");
    const shown = page.getByRole("group", { name: "代码公开" });
    await shown.getByText("一直公开").click();
    const dialog = page.getByRole("dialog", { name: "改成一直公开？" });
    await expect(dialog).toContainText(
      "所有人都能看到这个判定器的代码。改了就改不回来。",
    );
    await dialog.getByRole("button", { name: "返回" }).click();
    await expect(dialog).toBeHidden();
    expect(asked.updates).toHaveLength(1);
    await shown.getByText("一直公开").click();
    await page
      .getByRole("dialog", { name: "改成一直公开？" })
      .getByRole("button", { name: "一直公开" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(asked.updates.at(-1)).toEqual({
      name: "猜大小",
      description: "猜中的领",
      codePublic: "always",
    });
    await expect(shown).toHaveAttribute("disabled", "");
  });

  test("判定器页：版本一行写第几版、部署时间、测试和开放过几个，展开看指纹和代码；部署新版本从最新一版的代码改起", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const deploys = await mockDeploys(page, {
      judge: {
        id: GUESS_ID,
        name: "猜数字",
        versions: {
          next: 4,
          versions: [
            {
              n: 3,
              fingerprint: sha256(firstCode),
              at: openedAt,
              testsDigest: sha256(testsFile),
              passed: true,
              protocol: JUDGE_PROTOCOL,
            },
          ],
        },
        codes: { 3: firstCode },
      },
    });
    await mockMyJudges(page);
    await openApp(page, `/judges/${GUESS_ID}`);
    const at = new Date(openedAt);
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const version = page.getByRole("button", { name: /^第 3 版/ });
    await expect(version).toContainText(
      `第 3 版 · ${at.getMonth() + 1}月${at.getDate()}日 ${clock} 部署`,
    );
    await expect(version).toContainText("测试全过 · 开放过 2 个红包");
    await version.click();
    await expect(version).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(sha256(firstCode))).toBeVisible();
    await expect(page.getByRole("textbox", { name: /^第 3 版/ })).toContainText(
      "猜对 42 的人领一份",
    );
    // 部署新版本: the form's own card, on 第 3 版's code and tests.
    await expect(card(page)).toBeVisible();
    await expect(cardName(page)).toHaveText("判定器 第 3 版");
    await pasteCode(page, secondCode, "粘贴新版本");
    await expect(cardName(page)).toHaveText("新代码");
    await deployButton(page).click();
    await expect(cardName(page)).toHaveText("判定器 第 4 版");
    expect(deploys.requests.at(-1)).toEqual({
      code: secondCode,
      tests: testsFile,
      judge: { id: GUESS_ID },
    });
  });

  test("我的判定器还没有：写在发红包第 2 步自己写一个；别人的判定器：未找到判定器", async ({
    page,
  }) => {
    await mockDeploys(page);
    await openApp(page, "/judges?tab=mine");
    await expect(page.getByText("还没有判定器")).toBeVisible();
    await expect(
      page.getByText("按右上的“自己写一个”，部署以后就在这里。"),
    ).toBeVisible();
    await openApp(page, `/judges/${GUESS_ID}`);
    await expect(
      page.getByRole("heading", { name: "未找到判定器" }),
    ).toBeVisible();
  });
});

test.describe("附带网页 SDK（judge-page §3、§11.8）", () => {
  const gameUrl = "https://game.example.com/play";
  const gameFrame = "iframe[title='game.example.com 的网页']";
  type Hb = {
    ready(): Promise<unknown>;
    view(): Promise<unknown>;
    on(kind: string, listener: (value: unknown) => void): () => void;
    submit(input: string): Promise<Record<string, unknown>>;
    mine(next?: string | null): Promise<unknown>;
  };
  type GameWindow = { hb: Hb; heard?: [string, unknown][] };

  /** The 猜数字 红包 with a page that loads the SDK from this site. */
  async function mockGame(page: Page, user: MockUser | null = viewer) {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Here the SDK comes from this machine's dev server, which Chrome keeps
    // from a public page unless allowed (hb.lafi.sh is not local).
    await page.context().grantPermissions(["local-network-access"]);
    // 打开附带网页？ answered before (attached-page §2.5).
    await page.addInitScript(() =>
      localStorage.setItem(
        "hb.page-sites",
        JSON.stringify(["game.example.com"]),
      ),
    );
    await mockSession(page, user);
    const sockets = await mockLive(page);
    const state = await mockCodeHongbao(page);
    state.activity = {
      ...state.activity,
      page: { url: gameUrl, host: "game.example.com" },
    };
    // The context's: a page of its own opens it too.
    await page.context().route("https://game.example.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><title>猜数字</title><h1>猜数字</h1><script src="${new URL(page.url()).origin}/sdk/v1.js"></script>`,
      }),
    );
    return { state, sockets };
  }

  /** Opens the page beside the 红包 and hands back its frame. */
  async function openGame(page: Page) {
    await page.locator("#page-button").click();
    await expect(
      page.frameLocator(gameFrame).getByRole("heading", { name: "猜数字" }),
    ).toBeVisible();
    const frame = page.frame({ url: gameUrl });
    if (!frame) throw new Error("GAME_FRAME_MISSING");
    // The heading shows before the SDK has loaded.
    await frame.waitForFunction(() => "hb" in window);
    return frame;
  }

  const allowDialog = (page: Page) =>
    page.getByRole("dialog", { name: "让这个网页替你提交？" });

  test("hb.ready() 给红包的公开信息和看的人的昵称；第一次提交先问，允许以后拿到结果，判定中的那一行在页面上的我的记录最上面；冷却中给秒数，之后不再问；hb.mine() 读自己的提交", async ({
    page,
  }) => {
    const { state } = await mockGame(page);
    await openApp(page, path);
    const frame = await openGame(page);
    const readsBefore = state.reads.public;
    const ready = await frame.evaluate(() =>
      (window as unknown as GameWindow).hb.ready(),
    );
    expect(ready).toEqual({
      hongbao: {
        id,
        title,
        url: expect.stringContaining(path),
        code: true,
        status: "active",
        endedByCode: false,
        unit: "🐟",
        shares: { total: 5, claimed: 1, remaining: 4 },
        pool: "1.00",
        // A protocol 4 红包: shares, no 奖池还剩 (multi-prize §4.4).
        unclaimed: null,
        deadlineAt: state.activity.deadlineAt,
        judged: 7,
      },
      viewer: { signedIn: true, name: viewer.displayName },
      theme: "light",
    });
    expect(
      await frame.evaluate(() => (window as unknown as GameWindow).hb.view()),
    ).toBeNull();

    // The first: asked on the 红包's side, nothing sent until 允许.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/activities/*/claim", async (route) => {
      await held;
      await route.fallback();
    });
    const first = frame.evaluate(() =>
      (window as unknown as GameWindow).hb.submit("50"),
    );
    const dialog = allowDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      "game.example.com 会替你提交输入，提交的内容和结果会出现在你的「我的记录」里，冷却和人机验证照旧。只对这个红包有效。",
    );
    expect(state.submissions).toEqual([]);
    await dialog.getByRole("button", { name: "允许", exact: true }).click();
    // On its way: the page's 我的记录 appears with it on top.
    const record = page.locator("[data-hb-part=my-judgments]");
    await expect(record.getByText("正在判定…")).toBeVisible();
    await expect(record.getByText("50", { exact: true })).toBeVisible();
    release();
    expect(await first).toEqual({
      judged: true,
      claimed: false,
      reply: "大了",
    });
    expect(state.submissions).toMatchObject([
      { participationMode: "code", input: "50" },
    ]);
    await expect(record).toContainText("我的记录 · 1 条");
    await expect(record.getByText("正在判定…")).toBeHidden();
    // The page reads the 红包 again after it, with its own way to read it
    // (2026-10-29: the frame's bridge, a reader of the same query, had left
    // it none, and the read failed: 刷新失败).
    await expect.poll(() => state.reads.public).toBeGreaterThan(readsBefore);
    await expect(page.getByText("刷新失败，当前内容已保留。")).toHaveCount(0);

    // Within the cooldown the claim answered: the seconds left, not sent.
    const cooling = await frame.evaluate(() =>
      (window as unknown as GameWindow).hb.submit("42"),
    );
    expect(cooling).toMatchObject({ judged: false, reason: "cooldown" });
    expect(Number(cooling.seconds)).toBeGreaterThan(0);
    expect(state.submissions).toHaveLength(1);

    // After it, not asked again; paid in 🐟.
    await page.waitForTimeout(2_100);
    expect(
      await frame.evaluate(() =>
        (window as unknown as GameWindow).hb.submit("42"),
      ),
    ).toEqual({
      judged: true,
      claimed: true,
      amount: "0.30",
      unit: "🐟",
      reply: "猜对了！",
    });
    await expect(dialog).toBeHidden();
    expect(state.submissions).toHaveLength(2);

    expect(
      await frame.evaluate(() => (window as unknown as GameWindow).hb.mine()),
    ).toEqual({
      total: 2,
      items: [
        {
          n: 2,
          at: expect.any(String),
          input: "42",
          claimed: true,
          amount: "0.30",
          reply: "猜对了！",
        },
        {
          n: 1,
          at: expect.any(String),
          input: "50",
          claimed: false,
          reply: "大了",
        },
      ],
      next: null,
    });
  });

  test("不允许：这次不提交、网页拿到 denied，下次再问；输入不合规则不问；离开红包页后网页还开着也不能提交", async ({
    page,
  }) => {
    const { state } = await mockGame(page);
    await openApp(page, path);
    const frame = await openGame(page);
    const dialog = allowDialog(page);
    for (let round = 0; round < 2; round += 1) {
      const denied = frame.evaluate(() =>
        (window as unknown as GameWindow).hb.submit("50"),
      );
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "不允许" }).click();
      expect(await denied).toEqual({ judged: false, reason: "denied" });
      await expect(dialog).toBeHidden();
    }
    expect(
      await frame.evaluate(() =>
        (window as unknown as GameWindow).hb.submit("第一行\n第二行"),
      ),
    ).toMatchObject({ judged: false, reason: "invalid_input" });
    await expect(dialog).toBeHidden();
    expect(state.submissions).toEqual([]);

    // The start page: the page stays loaded, hidden, and may not submit.
    await page.getByRole("link", { name: "首页" }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(
      await frame.evaluate(() =>
        (window as unknown as GameWindow).hb.submit("50"),
      ),
    ).toEqual({ judged: false, reason: "away" });
    await expect(dialog).toBeHidden();
    expect(state.submissions).toEqual([]);
  });

  test("没登录：hb.ready() 说没登录，hb.mine() 是 null；提交弹出登录卡片，网页拿到 login", async ({
    page,
  }) => {
    const { state } = await mockGame(page, null);
    await openApp(page, path);
    const frame = await openGame(page);
    expect(
      await frame.evaluate(() =>
        (window as unknown as GameWindow).hb
          .ready()
          .then((ready) => (ready as { viewer: unknown }).viewer),
      ),
    ).toEqual({ signedIn: false });
    expect(
      await frame.evaluate(() => (window as unknown as GameWindow).hb.mine()),
    ).toBeNull();
    expect(
      await frame.evaluate(() =>
        (window as unknown as GameWindow).hb.submit("50"),
      ),
    ).toEqual({ judged: false, reason: "login" });
    await expect(page.getByRole("dialog", { name: "登录" })).toBeVisible();
    await expect(allowDialog(page)).toBeHidden();
    expect(state.submissions).toEqual([]);
  });

  test("推送：公开数据变了、来了新动态，网页的 hb.on 一条一条收到，从旧到新", async ({
    page,
  }) => {
    const { state, sockets } = await mockGame(page);
    state.judge = { ...state.judge, protocol: JUDGE_PROTOCOL };
    await openApp(page, path);
    const frame = await openGame(page);
    await frame.evaluate(async () => {
      const game = window as unknown as GameWindow;
      game.heard = [];
      for (const kind of ["view", "announce", "hongbao"])
        game.hb.on(kind, (value) => game.heard?.push([kind, value]));
      await game.hb.ready();
    });
    await expect.poll(() => sockets.length).toBe(1);
    const at = new Date().toISOString();
    sockets[0]?.send(
      JSON.stringify({
        type: "view",
        view: { at, summary: "安全区间 1–49", data: { high: 49 } },
      }),
    );
    const line = (n: number, text: string) => ({
      n,
      at,
      text,
      user: { username: "p", displayName: "玩家", avatarUrl: null },
    });
    sockets[0]?.send(
      JSON.stringify({
        type: "announce",
        items: [line(1, "@玩家 猜了 30，安全"), line(0, "@玩家 猜了 50，大了")],
        total: 2,
      }),
    );
    sockets[0]?.send(JSON.stringify({ type: "judged", count: 9 }));
    // Each kind in the order it came; kinds pushed together may interleave.
    const heard = async (kind: string) =>
      (
        (await frame.evaluate(() => (window as unknown as GameWindow).heard)) ??
        []
      )
        .filter(([each]) => each === kind)
        .map(([, value]) => value);
    await expect.poll(() => heard("hongbao")).toHaveLength(1);
    expect(await heard("hongbao")).toEqual([
      expect.objectContaining({ judged: 9 }),
    ]);
    expect(await heard("view")).toEqual([
      { summary: "安全区间 1–49", data: { high: 49 }, at },
    ]);
    expect(await heard("announce")).toEqual([
      {
        n: 0,
        at,
        user: { name: "玩家", avatar: null },
        text: "@玩家 猜了 50，大了",
      },
      {
        n: 1,
        at,
        user: { name: "玩家", avatar: null },
        text: "@玩家 猜了 30，安全",
      },
    ]);
    expect(
      await frame.evaluate(() => (window as unknown as GameWindow).hb.view()),
    ).toEqual({ summary: "安全区间 1–49", data: { high: 49 }, at });
  });

  test("宽屏全屏时网页要提交：先退出全屏让确认露出来，答完回到全屏；单独打开网页时 hb.ready() 报错", async ({
    page,
  }) => {
    await mockGame(page);
    await openApp(page, path);
    const frame = await openGame(page);
    const enter = page.getByRole("button", { name: "全屏", exact: true });
    await enter.click();
    const exit = page.getByRole("button", { name: "退出全屏", exact: true });
    await expect(exit).toBeVisible();
    const asked = frame.evaluate(() =>
      (window as unknown as GameWindow).hb.submit("50"),
    );
    const dialog = allowDialog(page);
    await expect(dialog).toBeVisible();
    await expect(exit).toBeHidden();
    await dialog.getByRole("button", { name: "不允许" }).click();
    expect(await asked).toEqual({ judged: false, reason: "denied" });
    await expect(exit).toBeVisible();

    // On its own: nobody answers.
    const alone = await page.context().newPage();
    await alone.goto(gameUrl);
    expect(
      await alone.evaluate(() =>
        (window as unknown as GameWindow).hb
          .ready()
          .then(() => "connected")
          .catch((error: { code?: string }) => error.code),
      ),
    ).toBe("not_embedded");
  });
});
