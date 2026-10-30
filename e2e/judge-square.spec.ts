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

type Asked = Awaited<ReturnType<typeof mockSquare>>["asked"];

/** The 广场's reads and one's own 判定器, as the server would answer them. */
async function mockSquare(page: Page, user: MockUser | null) {
  const asked = {
    lists: [] as string[],
    listings: [] as { listed: boolean; featurable: boolean }[],
    deploys: [] as Record<string, unknown>[],
    saved: [] as { activity: { judge?: Record<string, unknown> } }[],
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
    if (rest === `/${NETWORKED}`)
      return route.fulfill({
        json: {
          judge: {
            ...guessPage,
            ...networked,
            version: {
              n: 1,
              fingerprint: sha256("networked"),
              deployedAt,
              declarations: null,
              network: ["https://api.example.com/hb/"],
              code: "export const network = ['https://api.example.com/hb/'];",
            },
          } satisfies JudgePage,
        },
      });
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
  // A draft saved: what was sent is all a test looks at.
  await page.route("**/api/activities", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    asked.saved.push(route.request().postDataJSON());
    return route.abort();
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
  test("游客：一进来是大家做的，能按用得最多排；站长精选另一个页签；卡上写作者、数据和标签；没有我的", async ({
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
    // 大家做的 first (2026-10-30).
    await expect(
      page.getByRole("button", { name: "大家做的" }),
    ).toHaveAttribute("aria-pressed", "true");
    const online = page.getByRole("article").filter({ hasText: "联网问答" });
    await expect(
      online.getByRole("button", { name: "联网" }),
    ).toHaveAccessibleDescription(
      "会把领的人提交的内容发到别的服务器，由对方决定发不发、发多少。",
    );
    await page.getByRole("button", { name: "用得最多" }).click();
    await expect.poll(() => asked.lists.at(-1)).toContain("sort=used");
    await expect(page.getByRole("button", { name: "我的" })).toHaveCount(0);
    await page.getByRole("button", { name: "站长精选" }).click();
    await expect(page).toHaveURL(/[?&]tab=featured(&|$)/);
    const card = page.getByRole("article").filter({ hasText: "猜数字" });
    await expect(card).toContainText("@maker");
    await expect(card).toContainText("猜 1–100 之间的数，猜中的领");
    await expect(card).toContainText(
      "发过 3 个红包 · 判定 120 次 · 领到 15 人次",
    );
    await expect(
      card.getByRole("button", { name: "精选" }),
    ).toHaveAccessibleDescription("站长挑选或改进过的判定器。");
  });

  test("别人的判定器页：参数、发多少、代码、版本；复制一份来改带着代码和名字，测试自己写，有帮助入口，能选加入广场（§16.1），部署后到它的判定器页", async ({
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
    // Where writing one is told, in new tabs (§16.1).
    for (const [name, href] of [
      ["开发文档 ↗", "/help/code"],
      ["给 AI 的说明 ↗", "/help/code#ai"],
    ] as const) {
      const link = page.getByRole("link", { name, exact: true });
      await expect(link).toHaveAttribute("href", href);
      await expect(link).toHaveAttribute("target", "_blank");
    }
    // 设置, made with its first deploy: the 广场 asked as on its page.
    const join = page.getByRole("switch", { name: "加入判定器广场" });
    await join.click();
    const asking = page.getByRole("dialog", { name: "加入判定器广场？" });
    await expect(asking).toContainText(
      "代码会一直公开，改不回来；别人能看代码、用它发红包。",
    );
    await asking.getByRole("switch", { name: "允许站长选入精选" }).click();
    await asking.getByRole("button", { name: "加入" }).click();
    await expect(asking).toBeHidden();
    await expect(join).toHaveAttribute("aria-checked", "true");
    // In the 广场 is public for good: 一直公开, not to be changed here.
    const always = page
      .getByRole("group", { name: "代码公开" })
      .getByRole("button", { name: "一直公开" });
    await expect(always).toHaveAttribute("aria-pressed", "true");
    await expect(always).toBeDisabled();
    await expect(
      page.getByText("第一次部署时一起保存，以后在判定器页改。"),
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
      judge: {
        name: "猜数字",
        basedOn: GUESS,
        codePublic: "always",
        listing: { listed: true, featurable: false },
      },
    });
  });

  test("自己的判定器页：参数和试一试（§16.2）用测试全过的最新一版，参数带默认值，发多少照判定器写，试一试按默认值的红包判定；没有测试全过的版本时只写一句", async ({
    page,
  }) => {
    const { state } = await mockSquare(page, member);
    const declarations = guessPage.version?.declarations;
    if (!declarations) throw new Error("NO_DECLARATIONS");
    state.mine = {
      ...mineDetail(),
      usable: {
        n: 1,
        declarations: {
          ...declarations,
          meta: { name: "我的猜谜", page: "https://game.example.com/play" },
          hongbao: {
            ...declarations.hongbao,
            title: "猜一猜",
            note: "猜中就领，[开始](#附带网页)",
          },
        },
        network: null,
      },
    };
    const tried: Record<string, unknown>[] = [];
    await page.route(`**/api/me/judges/${MINE}/versions/1/try`, (route) => {
      tried.push(route.request().postDataJSON());
      return route.fulfill({
        json: { ok: true, amount: 30, message: "猜对了" },
      });
    });
    await openApp(page, `/judges/${MINE}`);
    await expect(
      page.getByRole("heading", { name: "参数和试一试" }),
    ).toBeVisible();
    await expect(
      page.getByText("第 1 版测试全过，用它发红包时是这样。"),
    ).toBeVisible();
    await expect(page.locator("#hb-try-param-max")).toHaveValue("100");
    await expect(page.locator("#hb-try-param-answer")).toHaveValue("");
    for (const line of ["份数 1–10，默认 5", "默认标题：猜一猜"])
      await expect(page.getByText(line, { exact: true })).toBeVisible();
    await expect(page.getByText("自带说明", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "game.example.com ↗" }),
    ).toHaveAttribute("href", "https://game.example.com/play");
    await page.locator("#hb-try-param-answer").fill("42");
    await page.getByRole("button", { name: /^试一试/ }).click();
    await page.getByRole("textbox", { name: "试一试的输入" }).fill("42");
    await page.getByRole("button", { name: "判定", exact: true }).click();
    await expect(page.getByText("会发 0.30 LDC")).toBeVisible();
    await expect(page.getByText("回复：猜对了")).toBeVisible();
    expect(tried).toEqual([
      {
        params: { max: 100, answer: 42 },
        hongbao: { title: "猜一猜", count: 5, minEach: 10, total: 500 },
        input: "42",
      },
    ]);
    state.mine = { ...mineDetail(), usable: null };
    await page.reload();
    await expect(
      page.getByText(
        "还没有测试全过的版本。部署一版测试全过的，就能在这里看参数、试一试。",
      ),
    ).toBeVisible();
  });

  test("自己的判定器页：加入判定器广场先确认，能不勾允许精选；退出也先确认；被站长撤下时写原因，开关灰掉；顶上能自己写一个", async ({
    page,
  }) => {
    const { asked, state } = await mockSquare(page, member);
    await openApp(page, `/judges/${MINE}`);
    await expect(page.getByText("第 1 版 · 还没发过红包")).toBeVisible();
    // 部署新版本 says where writing one is told too (§16.2).
    await expect(
      page.getByRole("link", { name: "本地开发包 ↗", exact: true }),
    ).toBeVisible();
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

  test("发红包第 2 步：在广场弹窗的站长精选里挑别人的判定器，收起的卡写站长精选，查看代码是只读弹窗；草稿存判定器和版本，不发测试", async ({
    page,
  }) => {
    const { asked } = await mockSquare(page, member);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    // Two ways only (§16.3): no cards of the 广场 or of one's own here.
    await expect(page.getByRole("group", { name: "站长精选" })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /^自己写一个/ }),
    ).toHaveAttribute("href", "/judges/new");
    await page.getByRole("button", { name: /^去判定器广场挑一个/ }).click();
    const square = page.getByRole("dialog", { name: "判定器广场" });
    // It opens on 站长精选 (§8).
    await expect(
      square.getByRole("button", { name: "站长精选" }),
    ).toHaveAttribute("aria-pressed", "true");
    const card = square.getByRole("article").filter({ hasText: "猜数字" });
    await expect(card).toContainText("@maker");
    await card.getByRole("button", { name: "用这个" }).click();
    await expect(square).toBeHidden();
    await expect(page.getByText("站长精选 · 第 2 版")).toBeVisible();
    await expect(page.locator("#hb-param-max")).toHaveValue("100");
    await page.getByRole("button", { name: "查看代码" }).click();
    const code = page.getByRole("dialog", { name: "代码" });
    await expect(code).toContainText("判定器「猜数字」· @maker · 第 2 版");
    await expect(code.getByRole("textbox")).toContainText(
      "submission.params.answer",
    );
    await code.getByRole("button", { name: "关闭" }).click();
    await expect(code).toBeHidden();
    await page.locator("#hb-param-answer").fill("42");
    await expect(page.locator("#hb-param-answer")).toHaveValue("42");
    await page.getByRole("button", { name: "下一步" }).first().click();
    // Its ranges and defaults for 发多少 (§4).
    await expect(page.locator("#hb-code-count")).toHaveValue("5");
    await expect(page.locator("#hb-code-total")).toHaveValue("5.00");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await expect(
      page.getByText("这个判定器要求每份至少 0.10 LDC", { exact: true }),
    ).toBeVisible();
    await page.locator("#hb-code-min").fill("0.10");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => asked.saved.length).toBe(1);
    expect(asked.saved[0]?.activity.judge).toMatchObject({
      judgeId: GUESS,
      version: 2,
      code: guessCode,
      tests: "",
      params: { max: 100, answer: 42 },
    });
    expect(asked.saved[0]?.activity.judge).not.toHaveProperty("name");
  });

  test("去判定器广场挑一个：弹窗里挑联网的判定器先问这个判定器会联网，返回就不选；我知道，继续用以后草稿记住确认过的地址", async ({
    page,
  }) => {
    const { asked } = await mockSquare(page, member);
    await openApp(page, "/new");
    await page.getByRole("button", { name: /^代码判定/ }).click();
    await page.getByRole("button", { name: "去判定器广场挑一个" }).click();
    const square = page.getByRole("dialog", { name: "判定器广场" });
    await expect(
      square.getByRole("link", { name: "在新页面看判定器广场 ↗" }),
    ).toHaveAttribute("target", "_blank");
    await square.getByRole("button", { name: "大家做的" }).click();
    const online = square.getByRole("article").filter({ hasText: "联网问答" });
    await expect(online.getByRole("link", { name: "查看 ↗" })).toBeVisible();
    await online.getByRole("button", { name: "用这个" }).click();
    const ask = page.getByRole("dialog", { name: "这个判定器会联网" });
    await expect(ask).toContainText(
      "它会把领的人提交的内容发到 https://api.example.com/hb/。那不是本站，也不是你的服务器。",
    );
    await expect(ask).toContainText(
      "判定结果由对方的服务器决定，对方随时能改，可能让奖池被领走，或者谁都领不到。",
    );
    await expect(ask).toContainText("只在你信任 @maker 时使用。");
    await ask.getByRole("button", { name: "返回" }).click();
    await expect(page.getByText("@maker · 第 1 版")).toHaveCount(0);
    await page.getByRole("button", { name: "去判定器广场挑一个" }).click();
    await page
      .getByRole("dialog", { name: "判定器广场" })
      .getByRole("button", { name: "大家做的" })
      .click();
    await page
      .getByRole("dialog", { name: "判定器广场" })
      .getByRole("article")
      .filter({ hasText: "联网问答" })
      .getByRole("button", { name: "用这个" })
      .click();
    await page
      .getByRole("dialog", { name: "这个判定器会联网" })
      .getByRole("button", { name: "我知道，继续用" })
      .click();
    await expect(page.getByText("@maker · 第 1 版")).toBeVisible();
    await page.locator("#hb-code-prompt").click();
    await page.keyboard.press("Enter");
    await page.locator("#hb-code-total").fill("1.00");
    await page.locator("#hb-code-count").fill("5");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => asked.saved.length).toBe(1);
    expect(asked.saved[0]?.activity.judge).toMatchObject({
      judgeId: NETWORKED,
      version: 1,
      networkAck: ["https://api.example.com/hb/"],
    });
  });

  test("用它发红包（别人的）：/new?judge= 到第 2 步，挑好它，焦点在第一项参数", async ({
    page,
  }) => {
    await mockSquare(page, member);
    await openApp(page, `/new?judge=${GUESS}`);
    await expect(page.getByText("站长精选 · 第 2 版")).toBeVisible();
    await expect(page.locator("#hb-param-max")).toBeFocused();
  });

  test("站长在别人的判定器页撤下它：原因必填，撤下后页上写原因，能恢复", async ({
    page,
  }) => {
    await mockSquare(page, { ...member, isAdmin: true });
    let shown: JudgePage = guessPage;
    const sent: { path: string; body: unknown }[] = [];
    await page.route(`**/api/judges/${GUESS}`, (route) =>
      route.fulfill({ json: { judge: shown } }),
    );
    await page.route("**/api/admin/judges/**", (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      sent.push({
        path,
        body: request.postData() ? request.postDataJSON() : undefined,
      });
      shown = path.endsWith("/take-down")
        ? {
            ...guessPage,
            listed: false,
            takenDown: { at: deployedAt, reason: "抄袭别人的判定器" },
          }
        : guessPage;
      return route.fulfill({ json: { ok: true } });
    });
    await openApp(page, `/judges/${GUESS}`);
    await page.getByRole("button", { name: "撤下" }).click();
    const dialog = page.getByRole("dialog", { name: "从判定器广场撤下？" });
    await expect(dialog).toContainText(
      "新的红包选不到它，已经选进草稿的也不能开放；已经开放的照常。作者会看到原因。",
    );
    const reason = dialog.getByRole("textbox", { name: "原因" });
    await expect(reason).toHaveAccessibleDescription(
      "作者看得到，最多 100 个字",
    );
    await dialog.getByRole("button", { name: "撤下" }).click();
    await expect(dialog.getByText("请写原因")).toBeVisible();
    expect(sent).toHaveLength(0);
    await reason.fill("抄袭别人的判定器");
    await dialog.getByRole("button", { name: "撤下" }).click();
    await expect(dialog).toBeHidden();
    expect(sent.at(-1)).toEqual({
      path: `/api/admin/judges/${GUESS}/take-down`,
      body: { reason: "抄袭别人的判定器" },
    });
    await expect(page.getByText("原因：抄袭别人的判定器")).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).click();
    await page
      .getByRole("dialog", { name: "恢复到判定器广场？" })
      .getByRole("button", { name: "恢复" })
      .click();
    await expect(page.getByRole("button", { name: "撤下" })).toBeVisible();
    expect(sent.at(-1)?.path).toBe(`/api/admin/judges/${GUESS}/restore`);
  });
});

test.describe("判定器带的附带网页（judge-page §4、§11.9）", () => {
  const carried = "https://game.example.com/play";

  /** 猜数字 carrying a page; 附带网页's switch on, PLUS or not. */
  async function mockCarried(page: Page, user: MockUser) {
    const { asked } = await mockSquare(page, user);
    const version = guessPage.version;
    if (!version?.declarations) throw new Error("GUESS_VERSION_MISSING");
    const withPage: JudgePage = {
      ...guessPage,
      page: carried,
      version: {
        ...version,
        declarations: {
          ...version.declarations,
          meta: { name: "猜数字", page: carried },
          hongbao: {
            ...version.declarations.hongbao,
            title: "猜数字红包",
            note: "猜 1 到 100 之间的数。\n\n[打开网页参与游戏](#附带网页)",
          },
        },
      },
    };
    await page.route("**/api/judges**", (route) => {
      const url = new URL(route.request().url());
      const rest = url.pathname.slice("/api/judges".length);
      if (rest === "")
        return route.fulfill({
          json: { items: [{ ...guess, page: carried }], nextCursor: null },
        });
      if (rest === `/${GUESS}`)
        return route.fulfill({ json: { judge: withPage } });
      return route.fallback();
    });
    await page.route("**/api/me/balance/hongbao", (route) =>
      route.fulfill({
        json: {
          enabled: true,
          available: true,
          availableMinor: 1_000_000,
          code: { deploysLeft: 7, deployLimit: 10 },
          // Everyone's while the switch is on (2026-10-30).
          page: true,
          pageEnabled: true,
        },
      }),
    );
    return asked;
  }

  /** From /new?judge=: 猜数字 picked, its params and 发多少 filled. */
  async function pickGuess(page: Page) {
    await openApp(page, `/new?judge=${GUESS}`);
    await expect(page.getByText("站长精选 · 第 2 版")).toBeVisible();
    await page.locator("#hb-param-answer").fill("42");
    await page.getByRole("button", { name: "下一步" }).first().click();
    await page.getByRole("button", { name: "下一步" }).first().click();
    await page.locator("#hb-code-min").fill("0.10");
    await page.getByRole("button", { name: "下一步" }).first().click();
  }

  const saveDraft = async (page: Page, count: number, asked: Asked) => {
    await page.getByRole("button", { name: "存草稿" }).first().click();
    await expect.poll(() => asked.saved.length).toBe(count);
    return asked.saved[count - 1]?.activity as { pageUrl?: string };
  };

  test("判定器带的标题和说明（judge-square §4.1）：挑了就替你填好，说明自己展开；判定器页写默认标题，自带说明悬停看全文", async ({
    page,
  }) => {
    await mockCarried(page, member);
    await pickGuess(page);
    await expect(page.locator("#hb-title")).toHaveValue("猜数字红包");
    await expect(page.locator("#hb-before-info")).toHaveValue(
      "猜 1 到 100 之间的数。\n\n[打开网页参与游戏](#附带网页)",
    );
    await openApp(page, `/judges/${GUESS}`);
    await expect(page.getByText("默认标题：猜数字红包")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "自带说明" }),
    ).toHaveAccessibleDescription(
      "猜 1 到 100 之间的数。 [打开网页参与游戏](#附带网页)",
    );
  });

  test("广场的卡上写带附带网页，判定器页参数下面一行地址，新标签页打开", async ({
    page,
  }) => {
    await mockCarried(page, member);
    await openApp(page, "/judges");
    const card = page.getByRole("article").filter({ hasText: "猜数字" });
    await expect(
      card.getByRole("button", { name: "带附带网页" }),
    ).toHaveAccessibleDescription("用它发红包时，判定器带的网页一起带上。");
    await card.getByRole("link", { name: "查看" }).click();
    const link = page.getByRole("link", { name: "game.example.com ↗" });
    await expect(link).toHaveAttribute("href", carried);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(page.getByText(/^附带网页：/)).toBeVisible();
  });

  test("没开通 PLUS 也一样（附带网页人人都能用）：替你填好、能改，没有 PLUS 标签；清空就不带", async ({
    page,
  }) => {
    const asked = await mockCarried(page, { ...viewer, balance: true });
    await pickGuess(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const field = sheet.locator("#hb-page");
    await expect(field).toHaveValue(carried);
    await expect(field).not.toHaveAttribute("readonly", "");
    await expect(
      sheet.getByText(
        "判定器带的网页，可以改成别的，也可以删掉。开放后不能改。",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(sheet.getByText("PLUS", { exact: true })).toHaveCount(0);
    await field.fill("");
    await sheet.getByRole("button", { name: "完成" }).click();
    expect(await saveDraft(page, 1, asked)).not.toHaveProperty("pageUrl");
  });

  test("开通了 PLUS：替你填好，照旧能改，下面写可以改成别的", async ({
    page,
  }) => {
    const asked = await mockCarried(page, member);
    await pickGuess(page);
    await page.getByRole("button", { name: /更多设置/ }).click();
    const sheet = page.getByRole("dialog", { name: "更多设置" });
    const field = sheet.locator("#hb-page");
    await expect(field).toHaveValue(carried);
    await expect(field).not.toHaveAttribute("readonly", "");
    await expect(
      sheet.getByText(
        "判定器带的网页，可以改成别的，也可以删掉。开放后不能改。",
        {
          exact: false,
        },
      ),
    ).toBeVisible();
    await field.fill("https://my.example.com/");
    await sheet.getByRole("button", { name: "完成" }).click();
    expect((await saveDraft(page, 1, asked)).pageUrl).toBe(
      "https://my.example.com/",
    );
  });
});
