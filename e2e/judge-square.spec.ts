import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  JUDGE_PROTOCOL,
  type JudgeCheck,
  type JudgePage,
  type MyJudgeDetail,
  type SquareJudge,
} from "../packages/contracts/src";
import { type MockUser, mockSession, openApp, viewer } from "./support/app";

// 判定器广场 (docs/judge-square-design.md §8, §15) on the web, against a
// mocked API: 站长精选 and 大家做的, another's 判定器页, 复制一份来改 and
// 写一个判定器, and the 判定器广场 section of one's own page.

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const deployedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();

const guessCode = [
  "export const params = [",
  '  { key: "max", label: "最大", hint: "猜的范围", type: "integer", min: 2, max: 1000, default: 100 },',
  '  { key: "answer", label: "答案", type: "integer", secret: true },',
  "];",
  "export function judge(submission) {",
  "  return Number(submission.input) === submission.params.answer",
  '    ? { ok: true, amount: submission.share.min, message: "猜中了" }',
  '    : { ok: false, message: "不对" };',
  "}",
].join("\n");

const GUESS = "33333333-4444-4555-8666-777777777777";
const NETWORKED = "44444444-5555-4666-8777-888888888888";
const MINE = "55555555-6666-4777-8888-999999999999";
const COPIED = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const maker = { username: "maker", displayName: "做题家", avatarUrl: null };

const guess: SquareJudge = {
  id: GUESS,
  name: "猜数字",
  description: "猜 1–100 之间的数，猜中的领",
  author: maker,
  basedOn: null,
  featured: true,
  bySiteOwner: false,
  network: false,
  stats: { hongbao: 3, judged: 120, claimed: 15 },
};
const networked: SquareJudge = {
  ...guess,
  id: NETWORKED,
  name: "联网问答",
  description: "问对方的服务器",
  featured: false,
  network: true,
  stats: { hongbao: 1, judged: 4, claimed: 1 },
};

const guessPage: JudgePage = {
  ...guess,
  own: false,
  listed: true,
  codePublic: "always",
  version: {
    n: 2,
    fingerprint: sha256(guessCode),
    deployedAt,
    declarations: {
      meta: null,
      params: [
        {
          key: "max",
          label: "最大",
          hint: "猜的范围",
          type: "integer",
          min: 2,
          max: 1000,
          default: 100,
        },
        { key: "answer", label: "答案", type: "integer", secret: true },
      ],
      hongbao: {
        count: { min: 1, max: 10, default: 5 },
        total: { default: 500 },
        minEach: { min: 10 },
        deadline: { value: 3, unit: "days" },
        humanCheck: true,
      },
      check: false,
    },
    network: null,
    code: guessCode,
  },
  versions: [{ n: 2, deployedAt, opened: 3 }],
};

/** One's own, out of the 广场 at first. */
function mineDetail(): MyJudgeDetail {
  return {
    id: MINE,
    name: "我的猜谜",
    description: "",
    codePublic: "ended",
    createdAt: deployedAt,
    updatedAt: deployedAt,
    latest: { n: 1, deployedAt, passed: true },
    usable: { n: 1, declarations: null, network: null },
    opened: 0,
    listed: false,
    featurable: true,
    takenDown: null,
    featured: null,
    stats: { hongbao: 0, judged: 0, claimed: 0 },
    publicN: null,
    versions: [
      {
        n: 1,
        fingerprint: sha256("mine"),
        deployedAt,
        checkedAt: deployedAt,
        protocol: JUDGE_PROTOCOL,
        testsDigest: sha256("tests"),
        passed: true,
        network: null,
        declarations: null,
        opened: 0,
      },
    ],
  };
}

/** The 广场's reads and one's own 判定器, as the server would answer them. */
async function mockSquare(page: Page, user: MockUser | null) {
  const asked = {
    lists: [] as string[],
    listings: [] as { listed: boolean; featurable: boolean }[],
    deploys: [] as Record<string, unknown>[],
  };
  let mine = mineDetail();
  const state = {
    get mine() {
      return mine;
    },
    set mine(next) {
      mine = next;
    },
  };
  await mockSession(page, user);
  await page.route("**/api/me/balance/hongbao", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        available: true,
        availableMinor: 1_000_000,
        code: { deploysLeft: 7, deployLimit: 10 },
      },
    }),
  );
  await page.route("**/api/judges**", (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice("/api/judges".length);
    if (rest === "") {
      asked.lists.push(url.search);
      const tab = url.searchParams.get("tab");
      return route.fulfill({
        json: {
          items: tab === "all" ? [networked, guess] : [guess],
          nextCursor: null,
        },
      });
    }
    if (rest === `/${GUESS}`)
      return route.fulfill({ json: { judge: guessPage } });
    if (rest === `/${GUESS}/versions/2`)
      return route.fulfill({
        json: { code: guessCode, fingerprint: sha256(guessCode) },
      });
    if (rest.endsWith("/activities"))
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (rest === `/${MINE}` || rest === `/${COPIED}`)
      return route.fulfill({
        json: { judge: { ...guessPage, id: rest.slice(1), own: true } },
      });
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  await page.route("**/api/me/judges**", (route) => {
    const url = new URL(route.request().url());
    const rest = url.pathname.slice("/api/me/judges".length);
    if (rest === "") return route.fulfill({ json: { items: [mine] } });
    if (rest === `/${MINE}/listing`) {
      const body = route.request().postDataJSON();
      asked.listings.push(body);
      mine = {
        ...mine,
        listed: body.listed,
        featurable: body.featurable,
        codePublic: body.listed ? "always" : mine.codePublic,
      };
      return route.fulfill({ json: { judge: mine } });
    }
    if (rest === `/${MINE}`) return route.fulfill({ json: { judge: mine } });
    if (rest === `/${COPIED}`)
      return route.fulfill({
        json: { judge: { ...mineDetail(), id: COPIED, name: "猜数字" } },
      });
    if (rest.includes("/versions/"))
      return route.fulfill({
        json: {
          code: "export function judge() { return { ok: false }; }",
          tests: '{ "tests": [] }',
          versions: { next: 2, versions: [] },
          declarations: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: {} } });
  });
  await page.route("**/api/judge/check", (route) => {
    const body = route.request().postDataJSON();
    asked.deploys.push(body);
    return route.fulfill({
      json: {
        check: {
          fingerprint: sha256(body.code),
          testsDigest: sha256(body.tests),
          protocol: JUDGE_PROTOCOL,
          passed: true,
          network: null,
          problems: [],
          tests: [{ name: "答对", passed: true, ms: 3 }],
          unstable: [],
          slowestMs: 3,
          checkedAt: new Date().toISOString(),
          kind: "deploy",
          deploysLeft: 6,
          declarations: { meta: null, params: [], hongbao: null, check: false },
          judge: {
            id: COPIED,
            name: body.judge.name,
            description: body.judge.description ?? "",
            version: 1,
            versions: {
              next: 2,
              versions: [
                {
                  n: 1,
                  fingerprint: sha256(body.code),
                  at: new Date().toISOString(),
                  testsDigest: sha256(body.tests),
                  passed: true,
                  protocol: JUDGE_PROTOCOL,
                },
              ],
            },
          },
        } satisfies JudgeCheck,
      },
    });
  });
  return { asked, state };
}

const member: MockUser = { ...viewer, balance: true, balancePlus: true };

test.describe("判定器广场", () => {
  test("游客：站长精选和大家做的，卡上写作者、数据和标签；大家做的能按用得最多排；没有我的", async ({
    page,
  }) => {
    const { asked } = await mockSquare(page, null);
    await openApp(page, "/judges");
    await expect(
      page.getByRole("heading", { name: "判定器广场", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("挑一个判定器，填几项参数就能发红包。"),
    ).toBeVisible();
    const card = page.getByRole("article").filter({ hasText: "猜数字" });
    await expect(card).toContainText("@maker");
    await expect(card).toContainText("猜 1–100 之间的数，猜中的领");
    await expect(card).toContainText(
      "发过 3 个红包 · 判定 120 次 · 领到 15 人次",
    );
    await expect(
      card.getByRole("button", { name: "精选" }),
    ).toHaveAccessibleDescription("站长挑选或改进过的判定器。");
    await expect(page.getByRole("button", { name: "我的" })).toHaveCount(0);
    await page.getByRole("button", { name: "大家做的" }).click();
    await expect(page).toHaveURL(/\/judges\?tab=all$/);
    const online = page.getByRole("article").filter({ hasText: "联网问答" });
    await expect(
      online.getByRole("button", { name: "联网" }),
    ).toHaveAccessibleDescription(
      "会把领的人提交的内容发到别的服务器，由对方决定发不发、发多少。",
    );
    await page.getByRole("button", { name: "用得最多" }).click();
    await expect.poll(() => asked.lists.at(-1)).toContain("sort=used");
  });

  test("别人的判定器页：参数、发多少、代码、版本；复制一份来改带着代码和名字，测试自己写，部署后到它的判定器页", async ({
    page,
  }) => {
    const { asked } = await mockSquare(page, member);
    await openApp(page, "/judges");
    await page
      .getByRole("article")
      .filter({ hasText: "猜数字" })
      .getByRole("link", { name: "查看" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/judges/${GUESS}$`));
    await expect(
      page.getByRole("heading", { name: "猜数字", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("最大（整数，2–1000，默认 100）"),
    ).toBeVisible();
    await expect(page.getByText("猜的范围", { exact: true })).toBeVisible();
    await expect(page.getByText("答案（整数，保密）")).toBeVisible();
    for (const line of [
      "份数 1–10，默认 5",
      "总奖池默认 5 LDC",
      "每份至少 0.10 LDC",
      "截止默认 3 天",
      "建议打开领取前人机验证",
    ])
      await expect(page.getByText(line, { exact: true })).toBeVisible();
    await expect(
      page.getByText(`第 2 版 · 代码指纹 ${sha256(guessCode).slice(0, 8)}…`),
    ).toBeVisible();
    const version = page.getByRole("button", { name: /^第 2 版 ·/ });
    await expect(version).toContainText("部署 · 开放过 3 个红包");
    await version.click();
    await expect(page.getByText(`代码指纹 ${sha256(guessCode)}`)).toBeVisible();
    await expect(page.getByRole("heading", { name: "用它的红包" })).toHaveCount(
      0,
    );
    await page.getByRole("link", { name: "复制一份来改" }).click();
    await expect(page).toHaveURL(new RegExp(`/judges/new\\?from=${GUESS}$`));
    await expect(
      page.getByRole("heading", { name: "写一个判定器", level: 1 }),
    ).toBeVisible();
    await expect(page.locator("#hb-judge-name")).toHaveValue("猜数字");
    await expect(
      page.getByText("基于 @maker 的判定器，署名会一直留着。"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "只是数据，不算进代码，不公开。别人的测试不公开，要自己写。",
      ),
    ).toBeVisible();
    const tests = page.getByRole("textbox", { name: /^tests\.json/ });
    await tests.click();
    await page.keyboard.insertText(
      '{ "tests": [{ "name": "答对", "input": "42", "params": { "answer": 42 }, "expect": { "ok": true } }] }',
    );
    await page.getByRole("button", { name: "部署并跑测试" }).click();
    await expect(page).toHaveURL(new RegExp(`/judges/${COPIED}$`));
    expect(asked.deploys.at(-1)).toMatchObject({
      code: guessCode,
      judge: { name: "猜数字", basedOn: GUESS },
    });
  });

  test("自己的判定器页：加入判定器广场先确认，能不勾允许精选；退出也先确认；被站长撤下时写原因，开关灰掉；顶上能自己写一个", async ({
    page,
  }) => {
    const { asked, state } = await mockSquare(page, member);
    await openApp(page, `/judges/${MINE}`);
    await expect(page.getByText("第 1 版 · 还没发过红包")).toBeVisible();
    const join = page.getByRole("switch", { name: "加入判定器广场" });
    await expect(join).toHaveAccessibleDescription(
      "加入后别人能看代码、用它发红包。",
    );
    await join.click();
    const dialog = page.getByRole("dialog", { name: "加入判定器广场？" });
    await expect(dialog).toContainText(
      "代码会一直公开，改不回来；别人能看代码、用它发红包。",
    );
    const allow = dialog.getByRole("switch", { name: "允许站长选入精选" });
    await expect(allow).toHaveAttribute("aria-checked", "true");
    await allow.click();
    await dialog.getByRole("button", { name: "加入" }).click();
    await expect(dialog).toBeHidden();
    expect(asked.listings.at(-1)).toEqual({ listed: true, featurable: false });
    await expect(join).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByText("还没有开放过红包的版本，广场上暂时看不到它。"),
    ).toBeVisible();
    await join.click();
    const leave = page.getByRole("dialog", { name: "退出判定器广场？" });
    await expect(leave).toContainText(
      "新的红包不能再选它；已经开放的照旧，已经选进草稿的照样能开放。代码照旧一直公开。",
    );
    await leave.getByRole("button", { name: "退出" }).click();
    await expect(leave).toBeHidden();
    expect(asked.listings.at(-1)).toEqual({ listed: false, featurable: false });
    // Taken down: the 站长's reason, and no joining.
    state.mine = {
      ...state.mine,
      takenDown: { at: deployedAt, reason: "抄袭别人的判定器" },
    };
    await page.reload();
    await expect(page.getByText("已被站长撤下")).toBeVisible();
    await expect(page.getByText("原因：抄袭别人的判定器")).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "加入判定器广场" }),
    ).toBeDisabled();
    await openApp(page, "/judges");
    await page.getByRole("link", { name: "自己写一个" }).click();
    await expect(page).toHaveURL(/\/judges\/new$/);
    await expect(page.locator("#hb-judge-name")).toHaveValue("");
    await expect(page.getByText(/^基于 @/)).toHaveCount(0);
  });
});
