// tests.json (协议第 5 节): read, filled in and compared the same way by the
// kit's npm test and npm run check and by the site's 在线检查. Each test
// says only what matters to it; everything else takes the defaults below.
import { sha256Text } from "./hash.mjs";
import { shareRange } from "./money.mjs";
import { submissionSeed, userSeed } from "./seeds.mjs";
import { LIMITS, readVerdict } from "./verdict.mjs";

/** The 红包 ID tests run as, for their seeds. */
export const TEST_HONGBAO_ID = "test";
/** 2026-10-24 12:00 北京时间. */
const TEST_NOW = Date.parse("2026-10-24T12:00:00+08:00");
/** The seed when a test names none: fixed, so random answers repeat. */
export const TEST_SEED = sha256Text("hb.lafi.sh/judge/v1/test-seed");

export const TEST_DEFAULTS = Object.freeze({
  user: Object.freeze({ id: 10000, username: "tester", level: 2, attempts: 0 }),
  hongbao: Object.freeze({
    title: "测试红包",
    total: 10000,
    count: 10,
    minEach: 1,
  }),
  now: TEST_NOW,
});

const HEX64 = /^[0-9a-f]{64}$/;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isWhole = (value) => Number.isSafeInteger(value);
const characters = (text) => [...text].length;

function only(value, keys, where) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  return extra.length > 0 ? `${where}没有 ${extra.join("、")} 这一项` : null;
}

function checkInput(input) {
  if (typeof input !== "string") return "input 要是字符串";
  const text = input.trim();
  if (/[\r\n]/.test(text)) return "input 只能是一行";
  if (characters(text) < 1 || characters(text) > LIMITS.inputCharacters)
    return `input 要是 1–${LIMITS.inputCharacters} 个字`;
  return null;
}

function checkJson(value) {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** One test's problem, or null. */
function problemOf(test) {
  if (!isObject(test)) return "要是一个对象";
  const extra = only(
    test,
    [
      "name",
      "input",
      "user",
      "hongbao",
      "claims",
      "state",
      "now",
      "seed",
      "expect",
    ],
    "",
  );
  if (extra) return extra;
  if (typeof test.name !== "string" || !test.name.trim())
    return "要有 name（测试的名字）";
  if (characters(test.name) > 100) return "name 最多 100 个字";
  const input = checkInput(test.input);
  if (input) return input;
  if (test.user !== undefined) {
    if (!isObject(test.user)) return "user 要是一个对象";
    const userExtra = only(
      test.user,
      ["id", "username", "level", "attempts"],
      "user 里",
    );
    if (userExtra) return userExtra;
    const { id, username, level, attempts } = test.user;
    if (id !== undefined && (!isWhole(id) || id < 1))
      return "user.id 要是正整数";
    if (
      username !== undefined &&
      (typeof username !== "string" || !username || characters(username) > 60)
    )
      return "user.username 要是 1–60 个字";
    if (
      level !== undefined &&
      level !== null &&
      ![0, 1, 2, 3, 4].includes(level)
    )
      return "user.level 要是 0–4 或 null";
    if (attempts !== undefined && (!isWhole(attempts) || attempts < 0))
      return "user.attempts 要是 0 或正整数";
  }
  if (test.hongbao !== undefined) {
    if (!isObject(test.hongbao)) return "hongbao 要是一个对象";
    const hongbaoExtra = only(
      test.hongbao,
      [
        "title",
        "total",
        "count",
        "minEach",
        "remaining",
        "remainingCount",
        "openedAt",
        "endsAt",
      ],
      "hongbao 里",
    );
    if (hongbaoExtra) return hongbaoExtra;
    const hongbao = test.hongbao;
    if (
      hongbao.title !== undefined &&
      (typeof hongbao.title !== "string" || characters(hongbao.title) > 100)
    )
      return "hongbao.title 要是最多 100 个字的字符串";
    for (const key of ["total", "count", "minEach", "remainingCount"])
      if (
        hongbao[key] !== undefined &&
        (!isWhole(hongbao[key]) || hongbao[key] < 1)
      )
        return `hongbao.${key} 要是正整数`;
    if (hongbao.count !== undefined && hongbao.count > 1000)
      return "hongbao.count 最多 1000";
    if (
      hongbao.remaining !== undefined &&
      (!isWhole(hongbao.remaining) || hongbao.remaining < 0)
    )
      return "hongbao.remaining 要是 0 或正整数";
    for (const key of ["openedAt", "endsAt"])
      if (hongbao[key] !== undefined && !isWhole(hongbao[key]))
        return `hongbao.${key} 要是毫秒（整数）`;
  }
  if (test.claims !== undefined) {
    if (typeof test.claims === "number") {
      if (!isWhole(test.claims) || test.claims < 0)
        return "claims 写数字时要是 0 或正整数";
    } else if (!Array.isArray(test.claims)) return "claims 要是数字或数组";
    else
      for (const [index, claim] of test.claims.entries()) {
        const where = `claims 第 ${index + 1} 条`;
        if (!isObject(claim)) return `${where}要是一个对象`;
        const claimExtra = only(
          claim,
          ["user", "amount", "input", "at"],
          `${where}里`,
        );
        if (claimExtra) return claimExtra;
        if (
          !isObject(claim.user) ||
          !isWhole(claim.user.id) ||
          claim.user.id < 1 ||
          typeof claim.user.username !== "string" ||
          !claim.user.username
        )
          return `${where}的 user 要有 id（正整数）和 username`;
        if (!isWhole(claim.amount) || claim.amount < 1)
          return `${where}的 amount 要是正整数（分）`;
        if (typeof claim.input !== "string")
          return `${where}的 input 要是字符串`;
        if (!isWhole(claim.at)) return `${where}的 at 要是毫秒（整数）`;
      }
  }
  if (test.state !== undefined && !checkJson(test.state))
    return "state 要能转成 JSON";
  if (test.now !== undefined) {
    const valid =
      typeof test.now === "number"
        ? isWhole(test.now)
        : typeof test.now === "string" && Number.isFinite(Date.parse(test.now));
    if (!valid) return "now 要是毫秒（整数）或 ISO 时间";
  }
  if (
    test.seed !== undefined &&
    (typeof test.seed !== "string" || !HEX64.test(test.seed))
  )
    return "seed 要是 64 位小写十六进制";
  if (!isObject(test.expect)) return "要有 expect";
  const expectExtra = only(
    test.expect,
    ["ok", "amount", "message", "state"],
    "expect 里",
  );
  if (expectExtra) return expectExtra;
  if (typeof test.expect.ok !== "boolean")
    return "expect.ok 要是 true 或 false";
  if (
    test.expect.amount !== undefined &&
    (!isWhole(test.expect.amount) || test.expect.amount < 1)
  )
    return "expect.amount 要是正整数（分）";
  if (
    test.expect.message !== undefined &&
    typeof test.expect.message !== "string"
  )
    return "expect.message 要是字符串";
  if (test.expect.state !== undefined && !checkJson(test.expect.state))
    return "expect.state 要能转成 JSON";
  return null;
}

/**
 * tests.json, read: `{ tests }`, or `{ problem }` saying what is wrong
 * with the file or which test.
 */
export function readTests(text) {
  if (typeof text !== "string" || !text.trim())
    return { problem: "至少写一条测试" };
  let tests;
  try {
    tests = JSON.parse(text);
  } catch (error) {
    return { problem: `tests.json 不是有效的 JSON：${error.message}` };
  }
  if (!Array.isArray(tests))
    return { problem: "tests.json 要是一个数组，每条测试是其中一项" };
  if (tests.length === 0) return { problem: "至少写一条测试" };
  if (tests.length > LIMITS.tests)
    return { problem: `测试最多 ${LIMITS.tests} 条` };
  const names = new Set();
  for (const [index, test] of tests.entries()) {
    const problem = problemOf(test);
    if (problem)
      return {
        problem: `第 ${index + 1} 条测试${typeof test?.name === "string" && test.name.trim() ? `（${test.name}）` : ""}：${problem}`,
      };
    if (names.has(test.name))
      return { problem: `第 ${index + 1} 条测试：名字“${test.name}”重复了` };
    names.add(test.name);
  }
  return { tests };
}

/**
 * What one test hands the code: its submission with the defaults filled
 * in, its two seeds and its share's range. `{ problem }` when its numbers
 * cannot be a 红包 (more claimed than there is).
 */
export function testSubmission(test) {
  const now =
    test.now === undefined
      ? TEST_DEFAULTS.now
      : typeof test.now === "number"
        ? test.now
        : Date.parse(test.now);
  const user = { ...TEST_DEFAULTS.user, ...test.user };
  const base = { ...TEST_DEFAULTS.hongbao, ...test.hongbao };
  const each = Math.floor(base.total / base.count);
  const claims =
    typeof test.claims === "number"
      ? Array.from({ length: test.claims }, (_, index) => ({
          user: { id: 20001 + index, username: `claimer${index + 1}` },
          amount: each,
          input: "",
          at: now - (test.claims - index) * 60_000,
        }))
      : (test.claims ?? []);
  const paid = claims.reduce((sum, claim) => sum + claim.amount, 0);
  const hongbao = {
    title: base.title,
    total: base.total,
    count: base.count,
    minEach: base.minEach,
    remaining: base.remaining ?? base.total - paid,
    remainingCount: base.remainingCount ?? base.count - claims.length,
    openedAt: base.openedAt ?? now - 3_600_000,
    endsAt: base.endsAt ?? now + 86_400_000,
  };
  if (hongbao.minEach * hongbao.count > hongbao.total)
    return { problem: "总奖池不够每份都拿到每份至少" };
  if (hongbao.remainingCount < 1)
    return { problem: "已经领完了，没有剩下的份" };
  if (hongbao.remaining < hongbao.remainingCount * hongbao.minEach)
    return { problem: "剩余奖池不够剩下的每份都拿到每份至少" };
  const secret = test.seed ?? TEST_SEED;
  return {
    submission: {
      input: test.input.trim(),
      now,
      user,
      hongbao,
      share: shareRange(hongbao),
      claims,
      state: test.state ?? null,
    },
    seeds: {
      submission: submissionSeed(
        TEST_HONGBAO_ID,
        secret,
        user.id,
        user.attempts,
      ),
      user: userSeed(TEST_HONGBAO_ID, secret, user.id),
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

/** Equal as JSON, whatever the order of keys. */
export function sameJson(left, right) {
  return (
    JSON.stringify(canonical(left ?? null)) ===
    JSON.stringify(canonical(right ?? null))
  );
}

const failureWords = {
  load: "代码加载不了",
  "no-judge": "judge.js 没有导出 judge 函数",
  threw: "代码抛错",
  invalid: "返回不对",
  timeout: "超时",
  memory: "内存超了",
  unavailable: "沙箱暂时不可用",
};

/**
 * One test's result from what the sandbox answered (`{ verdict }` or
 * `{ failure, detail }`): passed, or the first thing that differs.
 */
export function judgeTest(test, submission, outcome) {
  if ("failure" in outcome)
    return {
      passed: false,
      problem: `${failureWords[outcome.failure] ?? "出错"}：${outcome.detail}`,
    };
  const reading = readVerdict(outcome.verdict, submission.share);
  if ("error" in reading)
    return { passed: false, problem: `返回不对：${reading.error.detail}` };
  const state = reading.state.keep ? submission.state : reading.state.value;
  const actual = {
    ok: reading.ok,
    ...(reading.ok ? { amount: reading.paid } : {}),
    ...(reading.message !== undefined ? { message: reading.message } : {}),
    state,
  };
  const { expect } = test;
  let problem = null;
  if (expect.ok !== reading.ok)
    problem = expect.ok ? "应该发，实际没发" : "不应该发，实际发了";
  else if (
    reading.ok &&
    expect.amount !== undefined &&
    expect.amount !== reading.paid
  )
    problem =
      reading.paid === reading.asked
        ? `应该发 ${expect.amount}，实际发 ${reading.paid}`
        : `应该发 ${expect.amount}，实际发 ${reading.paid}（代码给的是 ${reading.asked}，${reading.note === "last" ? "最后一份发完剩下的" : reading.note === "floor" ? "按每份至少发" : "按上限发"}）`;
  else if (
    expect.message !== undefined &&
    expect.message !== (reading.message ?? "")
  )
    problem = `回复应该是“${expect.message}”，实际是“${reading.message ?? ""}”`;
  else if (expect.state !== undefined && !sameJson(expect.state, state))
    problem = "state 和 expect.state 不一样";
  return {
    passed: problem === null,
    ...(problem ? { problem } : {}),
    actual,
    ...(reading.unknown.length > 0 ? { unknown: reading.unknown } : {}),
  };
}
