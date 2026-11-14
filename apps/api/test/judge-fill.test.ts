import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runsToday } from "../src/judge/check";
import { checkMyParams, fillMyParams } from "../src/judge/judges";
import {
  type Actor,
  actor,
  bindings,
  check,
  give,
  JUDGE,
  judgeSettings,
  plus,
  rejects,
  settings,
  TESTS,
  unique,
} from "./code-fixtures";

// 看情况显示 and 填表试算 (docs/judge-square-design.md §3.2, §3.3): a param
// shown only for some values of an earlier choice, and check() and
// explain() asked as a sender fills the form — not their runs a day,
// counted apart in 用量.

const PARAMS = `export const params = [
  { key: "mode", label: "怎么定", type: "choice", default: "auto",
    options: [{ value: "auto", label: "按奖池分" }, { value: "fixed", label: "自己定" }] },
  { key: "people", label: "人数", type: "integer", min: 1, default: 10, when: { param: "mode", is: ["auto"] } },
  { key: "each", label: "每人", type: "money", min: 1, when: { param: "mode", is: ["fixed"] } },
];
export function check(params, hongbao) {
  return params.mode === "fixed" && params.each * 20 > hongbao.total
    ? [{ key: "each", message: "奖池至少要够 20 份" }]
    : [];
}
export function explain(params, hongbao) {
  if (params.mode === "auto")
    return { hints: { people: "每人约 " + Math.floor(hongbao.total / params.people) + " 分" }, summary: ["人数 " + params.people + "，each " + params.each] };
  return { hints: { each: "够 " + Math.floor(hongbao.total / params.each) + " 份" } };
}
`;

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({ enabled: 1, daily_deploy_limit: 20 });
  await plus(author);
  await give(admin, author, "20.00");
});

async function deployed(code: string) {
  const made = await check(author, unique(code), TESTS, { name: "试算" });
  expect(made.body.check.passed).toBe(true);
  return made.body.check.judge?.id ?? "";
}

const hongbao = { title: "试", total: 1000 };

describe("填表试算", () => {
  it("answers check() and explain() on the shown params, the hidden one null", async () => {
    const id = await deployed(`${PARAMS}${JUDGE}`);
    // Hidden (each): what the form still holds is not the code's.
    expect(
      await fillMyParams(bindings, author.id, id, 1, {
        params: { mode: "auto", people: 4, each: 5 },
        hongbao,
      }),
    ).toEqual({
      problems: [],
      explanation: {
        hints: { people: "每人约 250 分" },
        warnings: {},
        summary: ["人数 4，each null"],
      },
    });
    expect(
      await fillMyParams(bindings, author.id, id, 1, {
        params: { mode: "fixed", each: 100 },
        hongbao,
      }),
    ).toEqual({
      problems: [{ key: "each", message: "奖池至少要够 20 份" }],
      explanation: { hints: { each: "够 10 份" }, warnings: {}, summary: [] },
    });
    // The site's own rules first: shown and empty, nothing is asked.
    expect(
      await fillMyParams(bindings, author.id, id, 1, {
        params: { mode: "fixed" },
        hongbao,
      }),
    ).toEqual({
      problems: [{ key: "each", message: "请填写每人" }],
      explanation: null,
    });
  });

  it("is not the sender's runs a day, and 用量 counts it apart", async () => {
    const id = await deployed(`${PARAMS}${JUDGE}`);
    const before = (await runsToday(bindings, author.id)).runs;
    for (const people of [1, 2, 3])
      await fillMyParams(bindings, author.id, id, 1, {
        params: { mode: "auto", people },
        hongbao,
      });
    expect((await runsToday(bindings, author.id)).runs).toBe(before);
    const usage = await env.DB.prepare(
      "SELECT SUM(fills) AS fills, SUM(tries) AS tries FROM judge_usage WHERE user_id = ?",
    )
      .bind(author.id)
      .first<{ fills: number; tries: number }>();
    expect(usage).toEqual({ fills: 3, tries: 0 });
    // 下一步's check() is still one of the runs, as before.
    await checkMyParams(bindings, author.id, id, 1, {
      params: { mode: "auto", people: 1 },
      hongbao,
    });
    expect((await runsToday(bindings, author.id)).runs).toBe(before + 1);
  });

  it("asks nothing of a 判定器 with neither check() nor explain()", async () => {
    const id = await deployed(JUDGE);
    expect(
      await fillMyParams(bindings, author.id, id, 1, { params: {}, hongbao }),
    ).toEqual({ problems: [], explanation: null });
    const usage = await env.DB.prepare(
      "SELECT COUNT(*) AS rows FROM judge_usage WHERE user_id = ? AND fills > 0",
    )
      .bind(author.id)
      .first<{ rows: number }>();
    expect(usage?.rows).toBe(0);
  });

  it("holds a sender past their minute's share", async () => {
    const id = await deployed(`${PARAMS}${JUDGE}`);
    await rejects(
      fillMyParams(
        {
          ...bindings,
          JUDGE_FILLS: { limit: async () => ({ success: false }) },
        },
        author.id,
        id,
        1,
        { params: { mode: "auto", people: 2 }, hongbao },
      ),
      "JUDGE_FILL_LIMIT",
    );
  });
});
