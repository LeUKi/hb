import { describe, expect, it } from "vitest";
import type { Submission, TestCase, Tools } from "../../kit/judge";
import {
  createTools,
  readTests,
  runTest,
  type SandboxAnswer,
  type Seeds,
  sameJson,
  startScenario,
  submissionSeed,
  TEST_HONGBAO_ID,
  TEST_SEED,
  userSeed,
} from "../../kit/runtime/index.mjs";

// tests.json v1 (docs/programmable-hongbao-design.md §5): one set of rules
// for the kit's npm test and npm run check and the site's 部署. Most of
// these are protocols 1–4's rules, with shares (OLD); protocol 5's
// (docs/multi-prize-design.md) are at the end.

/** Protocol 4: shares, as 红包 opened before protocol 5 have them. */
const OLD = 4;

const seed = "a".repeat(64);
const NOW = Date.parse("2026-10-24T12:00:00+08:00");
const MINUTE = 60_000;

type Judge = (submission: Submission, tools: Tools) => unknown;

/** A sandbox in this process: judge() as main.mjs calls it, and what it was given. */
function sandbox(judge: Judge) {
  const seen: { submission: Submission; seeds: Seeds }[] = [];
  const run = async (
    submission: Submission,
    seeds: Seeds,
  ): Promise<SandboxAnswer> => {
    seen.push({ submission: structuredClone(submission), seeds });
    try {
      const { tools } = createTools(submission, seeds);
      return { verdict: await judge(structuredClone(submission), tools) };
    } catch (error) {
      return { failure: "threw", detail: String(error) };
    }
  };
  return { run, seen };
}

function problemOf(file: unknown, protocol = OLD) {
  const read = readTests(
    typeof file === "string" ? file : JSON.stringify(file),
    { protocol },
  );
  return "problem" in read ? read.problem : null;
}

function readTestsOrThrow(text: string, protocol = OLD): TestCase[] {
  const read = readTests(text, { protocol });
  if ("problem" in read) throw new Error(read.problem);
  return read.tests;
}

async function runOne(
  test: unknown,
  judge: Judge,
  options?: { twice?: boolean; protocol?: number },
) {
  const protocol = options?.protocol ?? OLD;
  const [only] = readTestsOrThrow(JSON.stringify({ tests: [test] }), protocol);
  if (!only) throw new Error("No test");
  const box = sandbox(judge);
  return {
    result: await runTest(only, box.run, { ...options, protocol }),
    seen: box.seen,
  };
}

const pays: Judge = () => ({ ok: true, amount: 30, message: "对了" });

describe("tests.json: the file", () => {
  it("is an object whose tests are the tests", () => {
    expect(problemOf("")).toBe("至少写一条测试");
    expect(problemOf("{")).toContain("不是有效的 JSON");
    expect(problemOf([{ name: "a", input: "x", expect: { ok: true } }])).toBe(
      'tests.json 要是一个对象，测试写在它的 tests 里：{ "tests": [ … ] }',
    );
    expect(problemOf({ tests: [], extra: 1 })).toBe(
      "tests.json 里没有 extra 这一项",
    );
    expect(problemOf({ $schema: 1, tests: [] })).toBe("$schema 要是字符串");
    expect(problemOf({ tests: {} })).toBe(
      "tests 要是一个数组，每条测试是其中一项",
    );
    expect(problemOf({ tests: [] })).toBe("至少写一条测试");
    expect(
      problemOf({
        $schema: "./tests.schema.json",
        tests: [{ name: "a", input: "x", expect: { ok: true } }],
      }),
    ).toBeNull();
  });

  it("names the test and what is wrong with how it is written", () => {
    const single = { name: "a", input: "x", expect: { ok: true } };
    const step = { who: "小明", input: "x", expect: { ok: true } };
    const cases: [unknown, string][] = [
      [
        { input: "x", expect: { ok: true } },
        "第 1 条测试：要有 name（测试的名字）",
      ],
      [{ name: "a", input: "x" }, "第 1 条测试（a）：要有 expect"],
      [{ ...single, users: {} }, "第 1 条测试（a）：没有 users 这一项"],
      [
        { name: "a", expect: { ok: true } },
        "第 1 条测试（a）：要有 input（一次提交）或 steps（几个人依次提交）",
      ],
      [
        { ...single, steps: [step] },
        "第 1 条测试（a）：input 和 steps 只能写一个",
      ],
      [
        { name: "a", user: { id: 1 }, steps: [step] },
        "第 1 条测试（a）：多步场景不写 user：每一步的人写在 who 和 level 上",
      ],
      [
        { name: "a", expect: { ok: true }, steps: [step] },
        "第 1 条测试（a）：多步场景不写 expect：写在每一步上",
      ],
      [
        { name: "a", steps: [] },
        "第 1 条测试（a）：steps 要是一个数组，至少一步",
      ],
      [
        { ...single, hongbao: { remaining: 10 } },
        "第 1 条测试（a）：hongbao.remaining 由 claims 推出来，不能直接写",
      ],
      [
        { ...single, hongbao: { remainingCount: 3 } },
        "第 1 条测试（a）：hongbao.remainingCount 由 claims 推出来，不能直接写",
      ],
      [
        { ...single, share: { min: 1 } },
        "第 1 条测试（a）：share 由 claims 推出来，不能直接写",
      ],
      [{ ...single, input: "两\n行" }, "第 1 条测试（a）：input 只能是一行"],
      [
        { ...single, now: "明天" },
        "第 1 条测试（a）：now 要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00",
      ],
      // Without a zone the machine's own is used: npm test and 部署
      // would read it differently.
      [
        { ...single, now: "2026-10-24T12:00:00" },
        "第 1 条测试（a）：now 要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00",
      ],
      [
        { ...single, hongbao: { endsAt: "Oct 25 2026 12:00" } },
        "第 1 条测试（a）：hongbao.endsAt 要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00",
      ],
      [
        {
          ...single,
          claims: [
            {
              user: { id: 1, username: "a" },
              amount: 1,
              input: "x",
              at: "2026-10-24",
            },
          ],
        },
        "第 1 条测试（a）：claims 第 1 条的 at 要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00",
      ],
      [
        { name: "a", steps: [{ ...step, at: "2026-10-24T12:01:00" }] },
        "第 1 条测试（a）：第 1 步（小明）：at 要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00",
      ],
      [
        { ...single, seed: "ABC" },
        "第 1 条测试（a）：seed 要是 64 位小写十六进制",
      ],
      [
        {
          ...single,
          claims: [
            {
              user: { id: 1, username: "a", level: 2 },
              amount: 1,
              input: "x",
              at: 0,
            },
          ],
        },
        "第 1 条测试（a）：claims 第 1 条的 user 里没有 level 这一项",
      ],
      [
        {
          ...single,
          claims: [
            { user: { id: 1, username: "a" }, amount: 1, input: "", at: 0 },
          ],
        },
        "第 1 条测试（a）：claims 第 1 条的 input 要是 1–200 个字",
      ],
      [
        { name: "a", steps: [step, { ...step, level: 5 }] },
        "第 1 条测试（a）：第 2 步（小明）：level 要是 0–4 或 null",
      ],
      [
        { name: "a", steps: [{ ...step, by: "x" }] },
        "第 1 条测试（a）：第 1 步（小明）：没有 by 这一项",
      ],
      [
        { name: "a", steps: [{ input: "x", expect: { ok: true } }] },
        "第 1 条测试（a）：第 1 步：要有 who（谁提交的）",
      ],
      [
        { name: "a", steps: [{ who: "小明", input: "x" }] },
        "第 1 条测试（a）：第 1 步（小明）：要有 expect",
      ],
      [
        { ...single, expect: { ok: true, amout: 1 } },
        "第 1 条测试（a）：expect 里没有 amout 这一项",
      ],
      [
        { ...single, expect: { ok: false, amount: 1, note: null } },
        "第 1 条测试（a）：expect.ok 是 false 时不能写 amount、note",
      ],
      [
        { ...single, expect: { ok: true, asked: 1.5 } },
        "第 1 条测试（a）：expect.asked 要是整数（分）",
      ],
      [
        { ...single, expect: { ok: true, note: "max" } },
        '第 1 条测试（a）：expect.note 要是 "cap"、"floor"、"last" 或 null',
      ],
      [
        { ...single, expect: { ok: true, message: "a", messageIncludes: "a" } },
        "第 1 条测试（a）：expect.message 和 expect.messageIncludes 只能写一个",
      ],
      [
        { ...single, expect: { ok: true, messageIncludes: "" } },
        "第 1 条测试（a）：expect.messageIncludes 要是不空的字符串",
      ],
      [
        { ...single, expect: { ok: true, state: {}, stateIncludes: {} } },
        "第 1 条测试（a）：expect.state 和 expect.stateIncludes 只能写一个",
      ],
      [
        { ...single, expect: { ok: true, stateIncludes: [1] } },
        "第 1 条测试（a）：expect.stateIncludes 要是一个对象（只比写了的键）",
      ],
    ];
    for (const [test, problem] of cases)
      expect(problemOf({ tests: [test] })).toBe(problem);
    expect(problemOf({ tests: [single, { ...single, input: "y" }] })).toBe(
      "第 2 条测试：名字“a”重复了",
    );
    for (const now of ["2026-10-24T04:00Z", "2026-10-24T12:00:00.5+08:00"])
      expect(problemOf({ tests: [{ ...single, now }] })).toBeNull();
    // JSON.parse takes nesting that JSON.stringify cannot write back: such
    // a state could never be handed to the code.
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(
      problemOf(
        `{"tests":[{"name":"a","input":"x","expect":{"ok":true},"state":${deep}}]}`,
      ),
    ).toBe("第 1 条测试（a）：state 要能转成 JSON");
  });

  it("judges at most 200 times in all, a step counting as one", () => {
    const step = { who: "小明", input: "x", expect: { ok: false } };
    const pairs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `第 ${index} 对`,
        steps: [step, { ...step, who: "小红" }],
      }));
    expect(problemOf({ tests: pairs(100) })).toBeNull();
    expect(
      problemOf({
        tests: [
          ...pairs(99),
          { name: "多一步", steps: [step, step, { ...step, who: "小红" }] },
        ],
      }),
    ).toBe("所有测试加起来最多判定 200 次（多步的一步算一次），现在是 201 次");
  });
});

describe("tests.json: one submission", () => {
  it("fills in what a test leaves out", async () => {
    const plain = await runOne(
      { name: "默认", input: "  flag  ", expect: { ok: true, amount: 30 } },
      pays,
    );
    expect(plain.result).toMatchObject({
      passed: true,
      ms: expect.any(Number),
    });
    expect(plain.seen[0]?.submission).toEqual({
      input: "flag",
      now: NOW,
      user: { id: 10000, username: "tester", level: 2, attempts: 0 },
      hongbao: {
        title: "测试红包",
        total: 10000,
        count: 10,
        minEach: 1,
        remaining: 10000,
        remainingCount: 10,
        openedAt: NOW - 3_600_000,
        endsAt: NOW + 86_400_000,
      },
      share: { min: 1, max: 9991, last: false },
      claims: [],
      state: null,
    });
    expect(plain.seen[0]?.seeds).toEqual({
      submission: submissionSeed(TEST_HONGBAO_ID, TEST_SEED, 10000, 0),
      user: userSeed(TEST_HONGBAO_ID, TEST_SEED, 10000),
    });

    const fourth = await runOne(
      {
        name: "第 4 个",
        input: "x",
        user: { level: 3, attempts: 2 },
        claims: 3,
        now: "2026-10-25T08:00:00+08:00",
        hongbao: { openedAt: "2026-10-25T00:00:00+08:00" },
        seed,
        state: { n: 1 },
        expect: { ok: true },
      },
      pays,
    );
    const given = fourth.seen[0]?.submission;
    const at = Date.parse("2026-10-25T08:00:00+08:00");
    expect(given?.user).toMatchObject({ level: 3, attempts: 2 });
    expect(given?.hongbao).toMatchObject({
      remaining: 7000,
      remainingCount: 7,
      openedAt: Date.parse("2026-10-25T00:00:00+08:00"),
      endsAt: at + 86_400_000,
    });
    expect(given?.claims).toEqual(
      [1, 2, 3].map((n) => ({
        user: { id: 20000 + n, username: `claimer${n}` },
        amount: 1000,
        input: "占位",
        at: at - (4 - n) * MINUTE,
      })),
    );
    expect(given?.state).toEqual({ n: 1 });
    expect(fourth.seen[0]?.seeds).toEqual({
      submission: submissionSeed(TEST_HONGBAO_ID, seed, 10000, 2),
      user: userSeed(TEST_HONGBAO_ID, seed, 10000),
    });
  });

  it("spreads many placeholder claims between the opening and now", async () => {
    const { result, seen } = await runOne(
      {
        name: "已领 99 份",
        input: "x",
        hongbao: { count: 100 },
        claims: 99,
        expect: { ok: true, amount: 100, note: "last" },
      },
      pays,
    );
    expect(result.passed).toBe(true);
    const claims = seen[0]?.submission.claims ?? [];
    expect(claims).toHaveLength(99);
    expect(claims[0]?.at).toBeGreaterThanOrEqual(NOW - 3_600_000);
    expect(claims.at(-1)?.at).toBeLessThanOrEqual(NOW);
  });

  it("fails a test that could not happen on the site, before the code runs", async () => {
    const claim = (
      id: number,
      at: number,
      amount = 100,
      username = `p${id}`,
    ) => ({
      user: { id, username },
      amount,
      input: "x",
      at,
    });
    const cases: [Record<string, unknown>, string][] = [
      [
        { now: NOW - 7_200_000, hongbao: { openedAt: NOW - 3_600_000 } },
        "now 要在开放和截止之间（不早于 hongbao.openedAt，早于 hongbao.endsAt）",
      ],
      [
        { hongbao: { endsAt: NOW } },
        "now 要在开放和截止之间（不早于 hongbao.openedAt，早于 hongbao.endsAt）",
      ],
      [
        { hongbao: { openedAt: NOW, endsAt: NOW } },
        "hongbao.endsAt 要晚于 hongbao.openedAt",
      ],
      [{ hongbao: { total: 9, count: 10 } }, "总奖池不够每份都拿到每份至少"],
      [{ claims: 10 }, "claims 写了 10 份，红包一共 10 份，要留至少一份没领"],
      // Counted before any placeholder is made.
      [
        { claims: 1e10 },
        "claims 写了 10000000000 份，红包一共 10 份，要留至少一份没领",
      ],
      [
        { claims: [claim(1, NOW - 7_200_000)] },
        "已领的第 1 份早于开放（hongbao.openedAt）",
      ],
      [{ claims: [claim(1, NOW + 1)] }, "已领的第 1 份晚于 now"],
      [
        { claims: [claim(1, NOW - 60_000), claim(2, NOW - 120_000)] },
        "已领的第 2 份早于第 1 份，要按先后写",
      ],
      [
        { hongbao: { minEach: 100 }, claims: [claim(1, NOW, 99)] },
        "已领的第 1 份少于每份至少（100）",
      ],
      [
        {
          hongbao: { total: 1000, minEach: 100 },
          claims: [claim(1, NOW, 200)],
        },
        "已领的加起来太多，剩下的不够剩下每份都拿到每份至少",
      ],
      [
        { claims: [claim(1, NOW), claim(1, NOW, 100, "又是他")] },
        "已领的第 2 份和第 1 份是同一个人（又是他）",
      ],
      [
        { claims: [claim(2, NOW, 100, "same"), claim(3, NOW, 100, "same")] },
        "已领的第 2 份和第 1 份是同一个人（same）",
      ],
      [
        { claims: [claim(10000, NOW)] },
        "这个人（tester）已经领过了，线上不会交给代码",
      ],
      [{ state: { big: "x".repeat(66_000) } }, "state 超过 64 KB"],
      [
        { state: JSON.parse(`${"[".repeat(101)}${"]".repeat(101)}`) },
        "state 嵌套超过 100 层",
      ],
    ];
    for (const [change, problem] of cases) {
      const { result, seen } = await runOne(
        { name: "不可能", input: "x", expect: { ok: true }, ...change },
        pays,
      );
      expect(result).toEqual({ passed: false, problem, ms: 0 });
      expect(seen).toEqual([]);
    }

    const step = { who: "小明", input: "x", expect: { ok: true } };
    for (const [change, problem] of [
      [
        { steps: [step, { ...step, who: "小红", at: NOW - 1 }] },
        "第 2 步（小红）：时间早于上一步，要按先后写",
      ],
      [
        { steps: [step, { ...step, who: "小红", at: NOW + 86_400_000 }] },
        "第 2 步（小红）：这一步的时间要在开放和截止之间（不早于 hongbao.openedAt，早于 hongbao.endsAt）",
      ],
      [
        { claims: [claim(1, NOW + 1)], steps: [step] },
        "已领的第 1 份晚于第一步",
      ],
    ] as const) {
      const { result, seen } = await runOne(
        { name: "不可能", ...change },
        pays,
      );
      expect(result).toEqual({ passed: false, problem, ms: 0 });
      expect(seen).toEqual([]);
    }
  });
});

describe("tests.json: expect", () => {
  const judge: Judge = (s) =>
    s.input === "no"
      ? { ok: false, message: "差一点", state: { tried: ["no"], n: 1 } }
      : {
          ok: true,
          amount: 50_000,
          message: "  对了，\n前三名  ",
          state: { tried: ["a", "b"], n: 2, deep: { x: 1, y: 2 } },
        };

  it("compares what was paid, what the code asked, why, the reply and the state", async () => {
    const { result } = await runOne(
      {
        name: "全对",
        input: "yes",
        expect: {
          ok: true,
          amount: 9991,
          asked: 50_000,
          note: "cap",
          message: "对了， 前三名",
          stateIncludes: { tried: ["a", "b"], deep: { x: 1 } },
        },
      },
      judge,
    );
    expect(result).toMatchObject({
      passed: true,
      actual: {
        ok: true,
        amount: 9991,
        asked: 50_000,
        note: "cap",
        message: "对了， 前三名",
        state: { tried: ["a", "b"], n: 2, deep: { x: 1, y: 2 } },
      },
    });
    expect(
      (
        await runOne(
          {
            name: "含",
            input: "no",
            expect: {
              ok: false,
              messageIncludes: "一点",
              state: { n: 1, tried: ["no"] },
            },
          },
          judge,
        )
      ).result.passed,
    ).toBe(true);
    expect(
      (
        await runOne(
          {
            name: "没拉",
            input: "x",
            expect: { ok: true, amount: 30, asked: 30, note: null },
          },
          pays,
        )
      ).result.passed,
    ).toBe(true);
  });

  it("lists every difference, not only the first", async () => {
    const { result } = await runOne(
      {
        name: "全错",
        input: "yes",
        expect: {
          ok: true,
          amount: 100,
          asked: 100,
          note: null,
          messageIncludes: "第一",
          stateIncludes: { tried: ["a"], deep: { x: 2 }, gone: 1 },
        },
      },
      judge,
    );
    expect(result.passed).toBe(false);
    expect(result.problem?.split("；")).toEqual([
      "应该发 100，实际发 9991（代码给的是 50000，按上限发）",
      "代码应该给 100，实际给 50000",
      'note 应该是 null（没拉进范围），实际是 "cap"（按上限发）',
      "回复应该含“第一”，实际是“对了， 前三名”",
      "state 里的 tried、deep.x、gone 和 expect.stateIncludes 不一样",
    ]);
    const quiet = await runOne(
      {
        name: "没回复",
        input: "x",
        expect: { ok: false, message: "好", state: null },
      },
      () => ({ ok: true, amount: 1, state: [1] }),
    );
    expect(quiet.result.problem).toBe(
      "不应该发，实际发了；回复应该是“好”，实际没有回复；state 和 expect.state 不一样",
    );
    const flat = await runOne(
      {
        name: "不是对象",
        input: "x",
        expect: { ok: false, stateIncludes: { a: 1 } },
      },
      () => ({ ok: false, state: "a" }),
    );
    expect(flat.result.problem).toBe("state 和 expect.stateIncludes 不一样");
  });

  it("compares states nested deeper than the stack goes", async () => {
    const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
    const keyed = (depth: number) =>
      `${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`;
    const [whole, part] = readTestsOrThrow(
      `{"tests":[
        {"name":"整份","input":"x","expect":{"ok":false,"state":${nested(50_000)}}},
        {"name":"部分","input":"x","expect":{"ok":false,"stateIncludes":${keyed(50_000)}}}
      ]}`,
    );
    if (!whole || !part) throw new Error("No test");
    const shallow = sandbox(() => ({ ok: false, state: { a: { a: 2 } } }));
    expect((await runTest(whole, shallow.run, { protocol: OLD })).problem).toBe(
      "state 和 expect.state 不一样",
    );
    expect((await runTest(part, shallow.run, { protocol: OLD })).problem).toBe(
      "state 里的 a.a 和 expect.stateIncludes 不一样",
    );
    // The code's own state compares at the deepest it may nest (100); past
    // that it is refused, however deep, as JSON.stringify's depth depends on
    // the machine's stack.
    const [same] = readTestsOrThrow(
      `{"tests":[{"name":"深","input":"x","expect":{"ok":false,"state":${nested(100)}}}]}`,
    );
    if (!same) throw new Error("No test");
    const deep = sandbox(() => ({
      ok: false,
      state: JSON.parse(nested(100)),
    }));
    const result = await runTest(same, deep.run, {
      twice: true,
      protocol: OLD,
    });
    expect(result.passed).toBe(true);
    expect(result.unstable).toBeUndefined();
    const deeper = sandbox(() => ({
      ok: false,
      state: JSON.parse(nested(5_000)),
    }));
    expect((await runTest(same, deeper.run, { protocol: OLD })).problem).toBe(
      "返回不对：state 嵌套超过 100 层",
    );
  });

  it("fails an answer with fields outside the protocol", async () => {
    const { result } = await runOne(
      { name: "拼错", input: "x", expect: { ok: false } },
      () => ({ ok: false, mesage: "拼错了", extra: 1 }),
    );
    expect(result.problem).toBe("代码返回了协议以外的字段：mesage、extra");
  });

  it("says how the code failed", async () => {
    const thrown = await runOne(
      { name: "抛错", input: "x", expect: { ok: true } },
      () => {
        throw new Error("x");
      },
    );
    expect(thrown.result).toMatchObject({
      passed: false,
      problem: "代码抛错：Error: x",
      failure: { kind: "threw", detail: "Error: x" },
    });
    expect(
      (
        await runOne(
          { name: "不对", input: "x", expect: { ok: true } },
          () => ({ ok: "yes" }),
        )
      ).result.problem,
    ).toBe("返回不对：ok 要是 true 或 false");
  });
});

describe("tests.json: steps", () => {
  // Says what it was given, keeps a count in its state on a turn-down only.
  const echo: Judge = (s) => {
    const said = `${s.user.username}#${s.user.id} Lv${s.user.level} 第${s.user.attempts}次 ${s.claims.length}人领过 剩${s.hongbao.remaining}/${s.hongbao.remainingCount}`;
    if (s.input === "go") return { ok: true, amount: 400, message: said };
    const seen = ((s.state as { seen?: number } | null)?.seen ?? 0) + 1;
    return { ok: false, message: said, state: { seen } };
  };

  it("carries the state, the claims and each person's attempts forward as the site does", async () => {
    const { result, seen } = await runOne(
      {
        name: "三个人",
        hongbao: { total: 1000, count: 3, minEach: 100 },
        steps: [
          {
            who: "小明",
            input: "no",
            expect: { ok: false, state: { seen: 1 } },
          },
          {
            who: "小明",
            input: "go",
            expect: {
              ok: true,
              amount: 400,
              message: "小明#10001 Lv2 第1次 0人领过 剩1000/3",
              state: { seen: 1 },
            },
          },
          {
            who: "小红",
            input: "no",
            level: 4,
            at: NOW + 10 * MINUTE,
            expect: {
              ok: false,
              message: "小红#10002 Lv4 第0次 1人领过 剩600/2",
            },
          },
          {
            who: "小红",
            input: "go",
            expect: { ok: true, amount: 400, asked: 400, note: null },
          },
          {
            who: "小刚",
            input: "go",
            level: null,
            expect: {
              ok: true,
              amount: 200,
              note: "last",
              stateIncludes: { seen: 2 },
            },
          },
        ],
      },
      echo,
    );
    expect(result).toMatchObject({ passed: true, ms: expect.any(Number) });
    expect(
      result.steps?.map((step) => [step.who, step.at, step.passed]),
    ).toEqual([
      ["小明", NOW, true],
      ["小明", NOW + MINUTE, true],
      ["小红", NOW + 10 * MINUTE, true],
      ["小红", NOW + 11 * MINUTE, true],
      ["小刚", NOW + 12 * MINUTE, true],
    ]);
    const last = seen[4]?.submission;
    expect(last?.claims).toEqual([
      {
        user: { id: 10001, username: "小明" },
        amount: 400,
        input: "go",
        at: NOW + MINUTE,
      },
      {
        user: { id: 10002, username: "小红" },
        amount: 400,
        input: "go",
        at: NOW + 11 * MINUTE,
      },
    ]);
    expect(last?.user).toEqual({
      id: 10003,
      username: "小刚",
      level: null,
      attempts: 0,
    });
    expect(last?.share).toEqual({ min: 200, max: 200, last: true });
    // Kept when a judgment wrote none, replaced when it did.
    expect(seen.map((judged) => judged.submission.state)).toEqual([
      null,
      { seen: 1 },
      { seen: 1 },
      { seen: 2 },
      { seen: 2 },
    ]);
    expect(seen[1]?.seeds.submission).toBe(
      submissionSeed(TEST_HONGBAO_ID, TEST_SEED, 10001, 1),
    );
  });

  it("fails a step for someone who has claimed, or once the shares are gone, and stops there", async () => {
    const claimed = await runOne(
      {
        name: "领两次",
        steps: [
          { who: "小明", input: "go", expect: { ok: true } },
          { who: "小明", input: "go", expect: { ok: true } },
          { who: "小红", input: "go", expect: { ok: true } },
        ],
      },
      echo,
    );
    expect(claimed.result).toMatchObject({
      passed: false,
      problem: "第 2 步（小明）：已经领过了，线上不会交给代码",
    });
    // The code never saw the second: there is no answer to show.
    expect(claimed.result.actual).toBeUndefined();
    expect(claimed.result.steps).toHaveLength(2);
    expect(claimed.seen).toHaveLength(1);

    const gone = await runOne(
      {
        name: "领完了",
        hongbao: { total: 2, count: 2 },
        claims: [
          {
            user: { id: 7, username: "早到的" },
            amount: 1,
            input: "go",
            at: NOW,
          },
        ],
        steps: [
          { who: "小明", input: "go", expect: { ok: true, amount: 1 } },
          { who: "小红", input: "go", expect: { ok: true } },
        ],
      },
      echo,
    );
    expect(gone.result.problem).toBe(
      "第 2 步（小红）：份已经领完了，线上不会交给代码",
    );
    // Someone in claims by name is that person.
    const again = await runOne(
      {
        name: "早到的又来",
        claims: [
          {
            user: { id: 10001, username: "早到的" },
            amount: 1,
            input: "go",
            at: NOW,
          },
        ],
        steps: [
          { who: "小明", input: "no", expect: { ok: false } },
          { who: "早到的", input: "go", expect: { ok: true } },
        ],
      },
      echo,
    );
    expect(again.seen[0]?.submission.user.id).toBe(10002);
    expect(again.result.problem).toBe(
      "第 2 步（早到的）：已经领过了，线上不会交给代码",
    );
  });

  it("names the step and who when the answer differs or the code fails", async () => {
    const differs = await runOne(
      {
        name: "第二步错",
        steps: [
          { who: "小明", input: "no", expect: { ok: false } },
          { who: "小红", input: "no", expect: { ok: true, amount: 5 } },
          { who: "小刚", input: "no", expect: { ok: false } },
        ],
      },
      echo,
    );
    expect(differs.result).toMatchObject({
      passed: false,
      problem: "第 2 步（小红）：应该发，实际没发",
      actual: { ok: false, state: { seen: 2 } },
    });
    expect(differs.result.steps).toHaveLength(2);

    const failed = await runOne(
      {
        name: "第二步抛错",
        steps: [
          { who: "小明", input: "no", expect: { ok: false } },
          { who: "小红", input: "boom", expect: { ok: false } },
        ],
      },
      (s) => {
        if (s.input === "boom") throw new Error("炸了");
        return { ok: false };
      },
    );
    expect(failed.result).toMatchObject({
      passed: false,
      problem: "第 2 步（小红）：代码抛错：Error: 炸了",
      failure: { kind: "threw" },
    });
  });
});

describe("tests.json: twice", () => {
  it("judges everything again in order and says when an answer changed", async () => {
    let calls = 0;
    const drifting: Judge = (s) => {
      calls += 1;
      return {
        ok: false,
        message: s.input === "b" && calls > 2 ? "变了" : "一样",
      };
    };
    const scenario = {
      name: "两步",
      steps: [
        { who: "小明", input: "a", expect: { ok: false } },
        { who: "小红", input: "b", expect: { ok: false } },
      ],
    };
    const changed = await runOne(scenario, drifting, { twice: true });
    expect(changed.result).toMatchObject({ passed: true, unstable: true });
    expect(
      changed.seen.map((judged) => judged.submission.user.username),
    ).toEqual(["小明", "小红", "小明", "小红"]);
    const steady = await runOne(scenario, () => ({ ok: false }), {
      twice: true,
    });
    expect(steady.result.unstable).toBeUndefined();
    expect(steady.seen).toHaveLength(4);
    // Once is once; and code that failed is not run again.
    expect((await runOne(scenario, () => ({ ok: false }))).seen).toHaveLength(
      2,
    );
    const thrown = await runOne(
      { name: "抛错", input: "x", expect: { ok: false } },
      () => {
        throw new Error("x");
      },
      { twice: true },
    );
    expect(thrown.seen).toHaveLength(1);
  });
});

describe("scenario.mjs", () => {
  it("starts from the claims and state it is given", () => {
    const scenario = startScenario({
      hongbao: { total: 100, count: 3, minEach: 1, openedAt: 0, endsAt: 1 },
      claims: [
        { user: { id: 1, username: "a" }, amount: 40, input: "x", at: 0 },
      ],
      state: { a: 1 },
      protocol: OLD,
    });
    expect(scenario).toMatchObject({ paid: 40, state: { a: 1 } });
    expect(
      sameJson(scenario.claims, [
        { at: 0, input: "x", amount: 40, user: { username: "a", id: 1 } },
      ]),
    ).toBe(true);
  });
});

describe("tests.json: protocol 5 (docs/multi-prize-design.md)", () => {
  const NEW = 5;
  const run = (test: unknown, judge: Judge) =>
    runOne(test, judge, { protocol: NEW });
  /** 刮一格: +50, a try used, what is left shown only to them. */
  const scratch: Judge = (submission) => {
    const own = submission.player.state as { tries?: number } | null;
    const tries = own?.tries ?? 3;
    if (submission.input === "收手") return { settle: true, message: "收好" };
    if (submission.input === "炸") return { add: -20 };
    return {
      add: 50,
      player: {
        state: { tries: tries - 1 },
        view: { summary: `还剩 ${tries - 1} 次` },
      },
      message: "刮到了",
    };
  };

  it("has a pool and no shares", () => {
    expect(
      problemOf(
        {
          tests: [{ name: "a", input: "x", hongbao: { count: 5 }, expect: {} }],
        },
        NEW,
      ),
    ).toBe(
      "第 1 条测试（a）：第五版没有份数和每份至少，只有总奖池：去掉 hongbao.count",
    );
    expect(
      problemOf(
        {
          tests: [{ name: "a", input: "x", expect: { ok: true, note: "cap" } }],
        },
        NEW,
      ),
    ).toBe(
      "第 1 条测试（a）：第五版没有 note：判定器给的写 add，加上以后的待结算写 pending",
    );
    expect(
      problemOf(
        {
          tests: [
            {
              name: "a",
              input: "x",
              players: { 小明: { pending: -1 } },
              expect: {},
            },
          ],
        },
        NEW,
      ),
    ).toBe(
      "第 1 条测试（a）：players 里的“小明”的 pending 要是 0 或正整数（分）",
    );
    expect(
      problemOf({
        tests: [{ name: "a", input: "x", players: {}, expect: {} }],
      }),
    ).toBe("第 1 条测试（a）：没有 players 这一项");
  });

  it("gives the one judged their pending and own state, and keeps what moved", async () => {
    const { result, seen } = await run(
      {
        name: "接着刮",
        input: "刮",
        players: { tester: { pending: 120, state: { tries: 2 } } },
        expect: {
          add: 50,
          pending: 170,
          settled: null,
          player: { state: { tries: 1 }, view: { summary: "还剩 1 次" } },
          message: "刮到了",
        },
      },
      scratch,
    );
    expect(result.passed).toBe(true);
    const [first] = seen;
    expect(first?.submission.player).toEqual({
      pending: 120,
      state: { tries: 2 },
      view: null,
    });
    expect(first?.submission.user.attempts).toBe(1);
    expect(first?.submission.hongbao).toMatchObject({
      total: 10000,
      count: 100,
      minEach: 1,
      remaining: 10000,
      unclaimed: 9880,
      remainingCount: 100,
    });
    expect(first?.submission.share).toEqual({
      min: 1,
      max: 9880,
      last: false,
    });
  });

  it("takes off to 0, settles once, and reads { ok, amount } as short for it", async () => {
    expect(
      (
        await run(
          {
            name: "扣到 0",
            input: "炸",
            players: { tester: { pending: 10 } },
            expect: { add: -20, pending: 0 },
          },
          scratch,
        )
      ).result.passed,
    ).toBe(true);
    expect(
      (
        await run(
          {
            name: "收手",
            input: "收手",
            players: { tester: { pending: 120 } },
            expect: {
              ok: true,
              amount: 120,
              settle: true,
              settled: 120,
              pending: 0,
            },
          },
          scratch,
        )
      ).result.passed,
    ).toBe(true);
    const old = await run(
      { name: "旧写法", input: "x", expect: { ok: true, amount: 30 } },
      pays,
    );
    expect(old.result.passed).toBe(true);
    expect(old.result.actual).toMatchObject({
      ok: true,
      amount: 30,
      add: 30,
      settle: true,
      settled: 30,
    });
  });

  it("ends as the pool is taken, settling everyone", async () => {
    const { result } = await run(
      {
        name: "占满",
        input: "刮",
        hongbao: { total: 120 },
        players: { 小红: { pending: 100 } },
        expect: {
          pending: 0,
          settled: 20,
          end: true,
          people: { 小红: { settled: 100, pending: 0 } },
        },
      },
      scratch,
    );
    expect(result.problem).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it("moves others at the same table, and refuses the settled", async () => {
    const table: Judge = (submission) => {
      const first = (submission.state as { first?: number } | null)?.first;
      if (!first) return { state: { first: submission.user.id } };
      return {
        add: 30,
        settle: true,
        others: [{ id: first, add: 20, settle: true, message: "开桌了" }],
      };
    };
    const { result } = await run(
      {
        name: "两人一桌",
        steps: [
          { who: "小明", input: "坐", expect: { pending: 0 } },
          {
            who: "小红",
            input: "坐",
            expect: {
              settled: 30,
              people: { 小明: { settled: 20, message: "开桌了" } },
            },
          },
          { who: "小明", input: "坐", expect: {} },
        ],
      },
      table,
    );
    expect(result.steps?.[1]?.passed).toBe(true);
    expect(result.steps?.[1]?.actual?.others).toEqual([
      { who: "小明", settled: 20, message: "开桌了" },
    ]);
    expect(result.problem).toBe(
      "第 3 步（小明）：已经结算了，线上不会交给代码",
    );
    // Naming someone never judged here is the code's error.
    const stranger = await run(
      { name: "外人", input: "x", expect: {} },
      () => ({ others: [{ id: 42, add: 1 }] }),
    );
    expect(stranger.result.problem).toBe(
      "返回不对：others 第 1 项（42）没有在这个红包里被判定过",
    );
  });

  it("lists every difference in pending, settling and each person", async () => {
    const { result } = await run(
      {
        name: "都不对",
        input: "刮",
        players: { 小红: { pending: 5 } },
        expect: {
          ok: true,
          add: 40,
          settle: true,
          pending: 10,
          playerIncludes: { state: { tries: 9 } },
          people: { 小红: { pending: 6 }, 小刚: {} },
        },
      },
      scratch,
    );
    expect(result.problem).toBe(
      [
        "应该结算并领到钱，实际没有",
        "add 应该是 40，实际是 50",
        "应该说结算（settle: true），实际没说",
        "待结算应该是 10，实际是 50",
        "player.state 里的 tries 和 expect.playerIncludes.state 不一样",
        "“小红”的待结算应该是 6，实际是 5",
        "“小刚”没有在这个红包里玩过",
      ].join("；"),
    );
  });
});
