import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Submission } from "../../../kit/judge";
import {
  createRandom,
  readCheckAnswer,
  readDeclarations,
  sha256Text,
  submissionSeed,
  userSeed,
} from "../../../kit/runtime/index.mjs";
import {
  checkParamsInJudge,
  describeJudge,
  runJudge,
} from "../src/judge/sandbox";

const secret = "0123456789abcdef".repeat(4);
const seeds = {
  submission: submissionSeed("hb-test", secret, 7, 0),
  user: userSeed("hb-test", secret, 7),
};

/** A protocol 5 submission: 100 LDC, nobody paid, nothing pending. */
function submission(): Submission {
  return {
    input: "flag{x}",
    now: Date.UTC(2026, 9, 24, 0, 30),
    user: { id: 7, username: "tester", level: 2, attempts: 0 },
    hongbao: {
      title: "测试红包",
      total: 10000,
      unclaimed: 10000,
      remaining: 10000,
      count: 100,
      minEach: 1,
      remainingCount: 100,
      openedAt: Date.UTC(2026, 9, 24),
      endsAt: Date.UTC(2026, 9, 25),
    },
    share: { min: 1, max: 10000, last: false },
    claims: [],
    state: null,
    params: {},
    player: { pending: 0, state: null, view: null },
  };
}

/** Each code gets its own isolate, as each 红包's code does. */
function judge(
  code: string,
  extra: { capture?: boolean; waitMs?: number } = {},
) {
  return runJudge(
    env,
    {
      code,
      fingerprint: sha256Text(code),
      submission: submission(),
      seeds,
      ...extra,
    },
    true,
  );
}

describe("the judge sandbox", () => {
  it("gives judge() the submission and the tools, and returns its answer", async () => {
    const outcome = await judge(`import { createHash } from "node:crypto";
export function judge(submission, tools) {
  return {
    ok: true,
    amount: tools.money.even(10),
    message: createHash("sha256").update(submission.input).digest("hex").slice(0, 8),
    state: { user: submission.user.username, hour: tools.time.parts().hour },
  };
}`);
    expect(outcome).toEqual({
      verdict: {
        ok: true,
        amount: 1000,
        message: sha256Text("flag{x}").slice(0, 8),
        state: { user: "tester", hour: 8 },
      },
    });
  });

  it("pins the time and draws Math.random() from this submission's stream", async () => {
    const outcome = await judge(`export function judge(submission, tools) {
  return { ok: false, state: [Date.now(), new Date().getTime(), Math.random(), tools.random.next(), tools.userRandom.next()] };
}`);
    const stream = createRandom(seeds.submission).api;
    const now = Date.UTC(2026, 9, 24, 0, 30);
    expect(outcome).toEqual({
      verdict: {
        ok: false,
        state: [
          now,
          now,
          stream.next(),
          stream.next(),
          createRandom(seeds.user).api.next(),
        ],
      },
    });
  });

  it("has no network, no cache and no secrets", async () => {
    const outcome = await judge(`export async function judge() {
  let network = "open";
  try { await fetch("https://example.com/"); } catch { network = "blocked"; }
  return { ok: false, state: { network, caches: typeof caches, env: Object.keys(globalThis.process?.env ?? {}).length } };
}`);
    expect(outcome).toEqual({
      verdict: {
        ok: false,
        state: { network: "blocked", caches: "undefined", env: 0 },
      },
    });
  });

  it("keeps console output only when asked", async () => {
    const code = `export function judge(s) { console.log("input", s.input, { n: 1 }); console.warn("careful"); return { ok: false }; }`;
    expect(await judge(code, { capture: true })).toEqual({
      verdict: { ok: false },
      logs: ['input flag{x} {"n":1}', "warn: careful"],
    });
    expect(await judge(code)).toEqual({ verdict: { ok: false } });
  });

  it("tells each kind of failure apart", async () => {
    expect(
      await judge(`export function judge() { throw new TypeError("坏了"); }`),
    ).toMatchObject({
      failure: "threw",
      detail: "TypeError: 坏了",
    });
    expect(
      await judge(`export function decide() { return { ok: false }; }`),
    ).toMatchObject({
      failure: "no-judge",
    });
    expect(
      await judge(
        `export function judge() { return { ok: false, state: 1n }; }`,
      ),
    ).toMatchObject({
      failure: "invalid",
    });
    // Too deep for JSON.stringify on some machines: refused on all.
    expect(
      await judge(
        `export function judge() { return { ok: false, state: JSON.parse("[".repeat(5000) + "]".repeat(5000)) }; }`,
      ),
    ).toMatchObject({
      failure: "invalid",
      detail: "state 嵌套超过 100 层",
    });
    expect(
      await judge(
        `export function judge() { return { ok: false, state: JSON.parse("[".repeat(100) + "]".repeat(100)) }; }`,
      ),
    ).toMatchObject({ verdict: { ok: false } });
    expect(await judge(`export function judge( {`)).toMatchObject({
      failure: "load",
    });
    expect(
      await judge(
        `const START = Date.now(); export function judge() { return { ok: false }; }`,
      ),
    ).toMatchObject({
      failure: "load",
      detail: expect.stringContaining("Date.now() 只能在 judge 里用"),
    });
  });

  // The runtime cancels a judgment nothing is left to answer: it would
  // never end, so it times out (a deploy and a claim alike), as in the kit.
  it("times out a judgment that awaits a promise that never settles", async () => {
    const code = `export async function judge() { await new Promise(() => {}); return { ok: false }; }`;
    for (const loading of [true, false])
      expect(
        await runJudge(
          env,
          {
            code,
            fingerprint: sha256Text(code),
            submission: submission(),
            seeds,
          },
          loading,
        ),
      ).toEqual({
        failure: "timeout",
        detail: "代码一直没有返回（在等一个永远不会完成的 Promise）",
        hung: true,
      });
    // Not at its top level: that is code that never loads.
    expect(
      await judge(
        `await new Promise(() => {}); export function judge() { return { ok: false }; }`,
      ),
    ).toMatchObject({ failure: "load" });
  });

  // Locally workerd neither limits CPU nor runs the sandbox apart from its
  // caller, so a real endless loop would stall the test; in production the
  // caller's clock keeps going (docs/programmable-hongbao-design.md §7). This
  // checks the caller's own deadline with a sandbox that never answers.
  it("stops waiting after its deadline", async () => {
    const silent = {
      LOADER: {
        get: () => ({
          getEntrypoint: () => ({
            fetch: () => new Promise<Response>(() => {}),
          }),
        }),
      },
    } as unknown as typeof env;
    const outcome = await runJudge(silent, {
      code: "",
      fingerprint: "silent",
      submission: submission(),
      seeds,
      waitMs: 50,
    });
    expect(outcome).toEqual({
      failure: "timeout",
      detail: "超过 50 毫秒没有判定完",
    });
  });

  // Only code that does not compile fails to start on its own account;
  // Dynamic Workers failing is no fault of the code, a deploy or a claim.
  it("tells the platform failing apart from code that does not compile", async () => {
    expect(await judge(`export function judge( {`)).toMatchObject({
      failure: "load",
      detail: expect.stringContaining("SyntaxError"),
    });
    const down = {
      LOADER: {
        get: () => ({
          getEntrypoint: () => ({
            fetch: () =>
              Promise.reject(new Error("Dynamic Worker loader unavailable")),
          }),
        }),
      },
    } as unknown as typeof env;
    for (const loading of [true, false])
      expect(
        await runJudge(
          down,
          {
            code: "",
            fingerprint: "down",
            submission: submission(),
            seeds,
          },
          loading,
        ),
      ).toEqual({
        failure: "unavailable",
        detail: "Dynamic Worker loader unavailable",
      });
  });

  // 协议第三版 (docs/judge-square-design.md §3, §4).
  it("describes meta, params, hongbao and check, and hands the params to judge()", async () => {
    const code = `export const meta = { name: "猜数字" };
export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
];
export const hongbao = { count: { min: 1, max: 10, default: 5 } };
export function check(params, hongbao) {
  return params.answer > params.max
    ? [{ key: "answer", message: \`答案不能大于 \${params.max}（\${hongbao.count} 份）\` }]
    : [];
}
export function judge(submission) {
  return { ok: Number(submission.input) === submission.params.answer };
}`;
    const run = { code, fingerprint: sha256Text(code) };
    const described = await describeJudge(env, run);
    expect(readDeclarations(described)).toEqual({
      meta: { name: "猜数字" },
      params: [
        { key: "max", label: "最大", type: "integer", min: 2, default: 100 },
        { key: "answer", label: "答案", type: "integer", secret: true },
      ],
      hongbao: { count: { min: 1, max: 10, default: 5 } },
      check: true,
      setup: false,
      problems: [],
    });
    const checked = await checkParamsInJudge(env, run, {
      params: { max: 100, answer: 120 },
      hongbao: { title: "测试红包", total: 10000, count: 5, minEach: 1 },
    });
    expect(
      "answer" in checked &&
        readCheckAnswer(checked.answer, readDeclarations(described).params),
    ).toEqual({
      problems: [{ key: "answer", message: "答案不能大于 100（5 份）" }],
    });
    const outcome = await runJudge(
      env,
      {
        ...run,
        submission: {
          ...submission(),
          input: "42",
          params: { max: 100, answer: 42 },
        },
        seeds,
      },
      true,
    );
    expect(outcome).toEqual({ verdict: { ok: true } });
  });

  it("says what is wrong with the declarations, and when check() throws", async () => {
    const code = `export const params = [{ key: "a-b", label: "x", type: "date" }];
export const hongbao = { count: { min: 5, max: 2 } };
export const check = 3;
export function judge() { return { ok: false }; }`;
    const run = { code, fingerprint: sha256Text(code) };
    expect(readDeclarations(await describeJudge(env, run)).problems).toEqual([
      "params 第 1 项（a-b）：type 只能是 text、textarea、integer、money、switch、choice、list、table",
      "hongbao.count.min 不能大于 hongbao.count.max",
      "check 要是一个函数",
    ]);
    const throwing = `export function check() { throw new Error("坏了"); }
export function judge() { return { ok: false }; }`;
    expect(
      await checkParamsInJudge(
        env,
        { code: throwing, fingerprint: sha256Text(throwing) },
        { params: {}, hongbao: {} },
      ),
    ).toEqual({ failure: "threw", detail: "Error: 坏了" });
  });
});
