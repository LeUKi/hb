// tests.json (协议第 5 节): read, held to what can happen on the site, run
// and compared the same way by the kit's npm test and npm run check and by
// the site's 部署. A test is one submission, or steps: several people
// in turn, carried forward as the site does (scenario.mjs). Each test says
// only what matters to it; everything else takes the defaults below.
import { sha256Text } from "./hash.mjs";
import { NETWORK_LIMITS, NETWORK_METHODS } from "./network.mjs";
import { paramValues } from "./params.mjs";
import { judgeNext, startScenario } from "./scenario.mjs";
import { LIMITS, nestsDeeper } from "./verdict.mjs";

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

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The people in steps, numbered as they first appear. */
const FIRST_PERSON = 10001;
/** The claims a number stands for. */
const FIRST_PLACEHOLDER = 20001;

const HEX64 = /^[0-9a-f]{64}$/;
const NOTES = ["cap", "floor", "last"];
const NOTE_WORDS = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份，发完剩下的",
};
const encoder = new TextEncoder();
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isWhole = (value) => Number.isSafeInteger(value);
const characters = (text) => [...text].length;
const isName = (value) =>
  typeof value === "string" && value.trim() !== "" && characters(value) <= 60;
const isLevel = (value) => value === null || [0, 1, 2, 3, 4].includes(value);
// A written time names its zone: without one Date.parse reads the machine's
// own, and npm test (the author's zone) and 部署 (UTC) would disagree.
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME_WORDS =
  "要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00";
const isTime = (value) =>
  typeof value === "number"
    ? isWhole(value)
    : typeof value === "string" &&
      ISO_WITH_ZONE.test(value) &&
      Number.isFinite(Date.parse(value));
/** Whether this engine can write it as JSON: nested too deep, it cannot. */
const writable = (value) => {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
};
const toMs = (value) =>
  value === undefined
    ? undefined
    : typeof value === "number"
      ? value
      : Date.parse(value);

function only(value, keys, where) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  return extra.length > 0 ? `${where}没有 ${extra.join("、")} 这一项` : null;
}

function timeProblem(value, label) {
  return value !== undefined && !isTime(value)
    ? `${label} ${TIME_WORDS}`
    : null;
}

/** An input as the site takes it: one line, 1–200 characters once trimmed. */
function inputProblem(input, label = "input") {
  if (typeof input !== "string") return `${label} 要是字符串`;
  const text = input.trim();
  if (/[\r\n]/.test(text)) return `${label} 只能是一行`;
  if (characters(text) < 1 || characters(text) > LIMITS.inputCharacters)
    return `${label} 要是 1–${LIMITS.inputCharacters} 个字`;
  return null;
}

function userProblem(user) {
  if (user === undefined) return null;
  if (!isObject(user)) return "user 要是一个对象";
  const extra = only(user, ["id", "username", "level", "attempts"], "user 里");
  if (extra) return extra;
  const { id, username, level, attempts } = user;
  if (id !== undefined && (!isWhole(id) || id < 1)) return "user.id 要是正整数";
  if (username !== undefined && !isName(username))
    return "user.username 要是 1–60 个字";
  if (level !== undefined && !isLevel(level))
    return "user.level 要是 0–4 或 null";
  if (attempts !== undefined && (!isWhole(attempts) || attempts < 0))
    return "user.attempts 要是 0 或正整数";
  return null;
}

function hongbaoProblem(hongbao) {
  if (hongbao === undefined) return null;
  if (!isObject(hongbao)) return "hongbao 要是一个对象";
  // The table in §5: what follows from claims is never written.
  for (const key of ["remaining", "remainingCount"])
    if (Object.hasOwn(hongbao, key))
      return `hongbao.${key} 由 claims 推出来，不能直接写`;
  const extra = only(
    hongbao,
    ["title", "total", "count", "minEach", "openedAt", "endsAt"],
    "hongbao 里",
  );
  if (extra) return extra;
  if (
    hongbao.title !== undefined &&
    (typeof hongbao.title !== "string" ||
      !hongbao.title.trim() ||
      characters(hongbao.title) > 100)
  )
    return "hongbao.title 要是 1–100 个字";
  for (const key of ["total", "count", "minEach"])
    if (
      hongbao[key] !== undefined &&
      (!isWhole(hongbao[key]) || hongbao[key] < 1)
    )
      return `hongbao.${key} 要是正整数`;
  if (hongbao.count !== undefined && hongbao.count > 1000)
    return "hongbao.count 最多 1000";
  return (
    timeProblem(hongbao.openedAt, "hongbao.openedAt") ??
    timeProblem(hongbao.endsAt, "hongbao.endsAt")
  );
}

function claimsProblem(claims) {
  if (claims === undefined) return null;
  if (typeof claims === "number")
    return isWhole(claims) && claims >= 0
      ? null
      : "claims 写数字时要是 0 或正整数";
  if (!Array.isArray(claims)) return "claims 要是数字或数组";
  for (const [index, claim] of claims.entries()) {
    const where = `claims 第 ${index + 1} 条`;
    if (!isObject(claim)) return `${where}要是一个对象`;
    const extra =
      only(claim, ["user", "amount", "input", "at"], `${where}里`) ??
      (isObject(claim.user)
        ? only(claim.user, ["id", "username"], `${where}的 user 里`)
        : null);
    if (extra) return extra;
    if (
      !isObject(claim.user) ||
      !isWhole(claim.user.id) ||
      claim.user.id < 1 ||
      !isName(claim.user.username)
    )
      return `${where}的 user 要有 id（正整数）和 username（1–60 个字）`;
    if (!isWhole(claim.amount) || claim.amount < 1)
      return `${where}的 amount 要是正整数（分）`;
    const input = inputProblem(claim.input, `${where}的 input`);
    if (input) return input;
    if (!isTime(claim.at)) return `${where}的 at ${TIME_WORDS}`;
  }
  return null;
}

const ANSWER_ERRORS = ["timeout", "unreachable", "too-big"];

/**
 * fetch, one test's or one step's (协议第 9 节): the answers this judgment
 * gets, each `{ url, method, status, headers, json | text }`, or
 * `{ url, method, error }` for a request that fails. simulate.json's
 * submissions take the same.
 */
export function fetchProblem(list) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return "fetch 要是一个数组，每个是一个请求的返回";
  if (list.length > NETWORK_LIMITS.requests)
    return `fetch 最多写 ${NETWORK_LIMITS.requests} 个：一次判定最多发 ${NETWORK_LIMITS.requests} 个请求`;
  for (const [index, answer] of list.entries()) {
    const where = `fetch 第 ${index + 1} 个`;
    if (!isObject(answer)) return `${where}要是一个对象`;
    const extra = only(
      answer,
      ["url", "method", "status", "headers", "json", "text", "error"],
      `${where}里`,
    );
    if (extra) return extra;
    if (typeof answer.url !== "string") return `${where}要有 url`;
    try {
      new URL(answer.url);
    } catch {
      return `${where}的 url 不是有效的地址`;
    }
    if (answer.method !== undefined && !NETWORK_METHODS.includes(answer.method))
      return `${where}的 method 要是 ${NETWORK_METHODS.map((method) => `"${method}"`).join(" 或 ")}`;
    if (answer.error !== undefined) {
      if (!ANSWER_ERRORS.includes(answer.error))
        return `${where}的 error 要是 "timeout"（超时）、"unreachable"（连不上）或 "too-big"（返回超过 64 KB）`;
      const more = ["status", "headers", "json", "text"].filter((key) =>
        Object.hasOwn(answer, key),
      );
      if (more.length > 0)
        return `${where}写了 error 就不能写 ${more.join("、")}`;
      continue;
    }
    if (
      answer.status !== undefined &&
      (!isWhole(answer.status) || answer.status < 200 || answer.status > 599)
    )
      return `${where}的 status 要是 200–599 的整数`;
    if (
      answer.headers !== undefined &&
      (!isObject(answer.headers) ||
        Object.values(answer.headers).some(
          (value) => typeof value !== "string",
        ))
    )
      return `${where}的 headers 要是一个对象，值都是字符串`;
    if (Object.hasOwn(answer, "json") && Object.hasOwn(answer, "text"))
      return `${where}的 json 和 text 只能写一个`;
    if (answer.text !== undefined && typeof answer.text !== "string")
      return `${where}的 text 要是字符串`;
    if (Object.hasOwn(answer, "json") && !writable(answer.json))
      return `${where}的 json 要能转成 JSON`;
  }
  return null;
}

/** expect, one test's or one step's. */
function expectProblem(expect) {
  if (!isObject(expect)) return "要有 expect";
  const extra = only(
    expect,
    [
      "ok",
      "amount",
      "asked",
      "note",
      "message",
      "messageIncludes",
      "state",
      "stateIncludes",
      "view",
      "viewIncludes",
      "announce",
      "end",
    ],
    "expect 里",
  );
  if (extra) return extra;
  if (typeof expect.ok !== "boolean") return "expect.ok 要是 true 或 false";
  if (!expect.ok) {
    const money = ["amount", "asked", "note"].filter((key) =>
      Object.hasOwn(expect, key),
    );
    if (money.length > 0)
      return `expect.ok 是 false 时不能写 ${money.join("、")}`;
  }
  if (
    expect.amount !== undefined &&
    (!isWhole(expect.amount) || expect.amount < 1)
  )
    return "expect.amount 要是正整数（分）";
  if (expect.asked !== undefined && !isWhole(expect.asked))
    return "expect.asked 要是整数（分）";
  if (
    expect.note !== undefined &&
    expect.note !== null &&
    !NOTES.includes(expect.note)
  )
    return 'expect.note 要是 "cap"、"floor"、"last" 或 null';
  if (expect.message !== undefined && expect.messageIncludes !== undefined)
    return "expect.message 和 expect.messageIncludes 只能写一个";
  if (expect.message !== undefined && typeof expect.message !== "string")
    return "expect.message 要是字符串";
  if (
    expect.messageIncludes !== undefined &&
    (typeof expect.messageIncludes !== "string" || !expect.messageIncludes)
  )
    return "expect.messageIncludes 要是不空的字符串";
  if (expect.state !== undefined && expect.stateIncludes !== undefined)
    return "expect.state 和 expect.stateIncludes 只能写一个";
  if (expect.stateIncludes !== undefined && !isObject(expect.stateIncludes))
    return "expect.stateIncludes 要是一个对象（只比写了的键）";
  // 协议第四版: what everyone sees, the line in 动态, the end.
  if (expect.view !== undefined && expect.viewIncludes !== undefined)
    return "expect.view 和 expect.viewIncludes 只能写一个";
  if (
    expect.view !== undefined &&
    expect.view !== null &&
    (!isObject(expect.view) || !writable(expect.view))
  )
    return "expect.view 要是一个对象（summary、data）或 null";
  if (expect.viewIncludes !== undefined && !isObject(expect.viewIncludes))
    return "expect.viewIncludes 要是一个对象（只比写了的键）";
  if (expect.announce !== undefined && typeof expect.announce !== "string")
    return "expect.announce 要是字符串";
  if (expect.end !== undefined && typeof expect.end !== "boolean")
    return "expect.end 要是 true 或 false";
  return null;
}

function stepProblem(step) {
  if (!isObject(step)) return "要是一个对象";
  const extra = only(
    step,
    ["who", "input", "level", "at", "fetch", "expect"],
    "",
  );
  if (extra) return extra;
  if (typeof step.who !== "string" || !step.who.trim())
    return "要有 who（谁提交的）";
  if (characters(step.who) > 60) return "who 最多 60 个字";
  return (
    inputProblem(step.input) ??
    (step.level !== undefined && !isLevel(step.level)
      ? "level 要是 0–4 或 null"
      : null) ??
    timeProblem(step.at, "at") ??
    fetchProblem(step.fetch) ??
    expectProblem(step.expect)
  );
}

const named = (value, key) =>
  isObject(value) && typeof value[key] === "string" && value[key].trim()
    ? `（${value[key]}）`
    : "";

/** Whether one test is written the way tests.json says: its problem, or null. */
function shapeProblem(test) {
  if (!isObject(test)) return "要是一个对象";
  if (typeof test.name !== "string" || !test.name.trim())
    return "要有 name（测试的名字）";
  if (characters(test.name) > 100) return "name 最多 100 个字";
  if (Object.hasOwn(test, "share")) return "share 由 claims 推出来，不能直接写";
  const multi = Object.hasOwn(test, "steps");
  if (multi && Object.hasOwn(test, "input")) return "input 和 steps 只能写一个";
  if (!multi && !Object.hasOwn(test, "input"))
    return "要有 input（一次提交）或 steps（几个人依次提交）";
  if (multi && Object.hasOwn(test, "user"))
    return "多步场景不写 user：每一步的人写在 who 和 level 上";
  if (multi && Object.hasOwn(test, "expect"))
    return "多步场景不写 expect：写在每一步上";
  if (multi && Object.hasOwn(test, "fetch"))
    return "多步场景不写 fetch：写在每一步上";
  const extra = only(
    test,
    [
      "name",
      "now",
      "hongbao",
      "claims",
      "state",
      "seed",
      "params",
      ...(multi ? ["steps"] : ["input", "user", "fetch", "expect"]),
    ],
    "",
  );
  if (extra) return extra;
  if (test.params !== undefined && !isObject(test.params))
    return "params 要是一个对象（参数的 key 对应填的值）";
  const common =
    timeProblem(test.now, "now") ??
    hongbaoProblem(test.hongbao) ??
    claimsProblem(test.claims) ??
    (test.state !== undefined && !writable(test.state)
      ? "state 要能转成 JSON"
      : null) ??
    (test.seed !== undefined &&
    (typeof test.seed !== "string" || !HEX64.test(test.seed))
      ? "seed 要是 64 位小写十六进制"
      : null);
  if (common) return common;
  if (!multi)
    return (
      inputProblem(test.input) ??
      userProblem(test.user) ??
      fetchProblem(test.fetch) ??
      expectProblem(test.expect)
    );
  if (!Array.isArray(test.steps) || test.steps.length === 0)
    return "steps 要是一个数组，至少一步";
  for (const [index, step] of test.steps.entries()) {
    const problem = stepProblem(step);
    if (problem) return `第 ${index + 1} 步${named(step, "who")}：${problem}`;
  }
  return null;
}

/**
 * tests.json, read: `{ tests }`, or `{ problem }` saying what is wrong
 * with the file or which test. Whether each test could happen on the site
 * is runTest's to say: such a test fails, the others still run.
 */
export function readTests(text) {
  if (typeof text !== "string" || !text.trim())
    return { problem: "至少写一条测试" };
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return { problem: `tests.json 不是有效的 JSON：${error.message}` };
  }
  if (!isObject(file))
    return {
      problem:
        'tests.json 要是一个对象，测试写在它的 tests 里：{ "tests": [ … ] }',
    };
  const extra = only(file, ["$schema", "params", "tests"], "tests.json 里");
  if (extra) return { problem: extra };
  if (file.$schema !== undefined && typeof file.$schema !== "string")
    return { problem: "$schema 要是字符串" };
  if (file.params !== undefined && !isObject(file.params))
    return {
      problem: "顶层的 params 要是一个对象（每条测试默认用这一份参数）",
    };
  if (!Array.isArray(file.tests))
    return { problem: "tests 要是一个数组，每条测试是其中一项" };
  if (file.tests.length === 0) return { problem: "至少写一条测试" };
  const names = new Set();
  let judgments = 0;
  for (const [index, test] of file.tests.entries()) {
    const problem = shapeProblem(test);
    if (problem)
      return {
        problem: `第 ${index + 1} 条测试${named(test, "name")}：${problem}`,
      };
    if (names.has(test.name))
      return { problem: `第 ${index + 1} 条测试：名字“${test.name}”重复了` };
    names.add(test.name);
    judgments += multiStep(test) ? test.steps.length : 1;
  }
  if (judgments > LIMITS.tests)
    return {
      problem: `所有测试加起来最多判定 ${LIMITS.tests} 次（多步的一步算一次），现在是 ${judgments} 次`,
    };
  // A test without its own params takes the file's (协议第三版).
  return {
    tests:
      file.params === undefined
        ? file.tests
        : file.tests.map((test) =>
            test.params === undefined ? { ...test, params: file.params } : test,
          ),
  };
}

const multiStep = (test) => Array.isArray(test.steps);
const stepName = (index, who) => `第 ${index + 1} 步（${who}）`;

/** A number of claims: placeholders, each the even share, up to `until`. */
function placeholders(count, hongbao, until) {
  const each = Math.floor(hongbao.total / hongbao.count);
  // A minute apart, closer when that would start before the opening.
  const gap = Math.min(
    MINUTE,
    Math.floor((until - hongbao.openedAt) / (count + 1)),
  );
  return Array.from({ length: count }, (_, index) => ({
    user: { id: FIRST_PLACEHOLDER + index, username: `claimer${index + 1}` },
    amount: each,
    input: "占位",
    at: until - (count - index) * gap,
  }));
}

const samePerson = (a, b) => a.id === b.id || a.username === b.username;

/** The claims before the first submission, as the site could have them. */
function claimsInconsistency(claims, hongbao, until, multi) {
  for (const [index, claim] of claims.entries()) {
    const where = `已领的第 ${index + 1} 份`;
    if (claim.amount < hongbao.minEach)
      return `${where}少于每份至少（${hongbao.minEach}）`;
    if (claim.at < hongbao.openedAt)
      return `${where}早于开放（hongbao.openedAt）`;
    if (claim.at > until) return `${where}晚于${multi ? "第一步" : " now"}`;
    if (index > 0 && claim.at < claims[index - 1].at)
      return `${where}早于第 ${index} 份，要按先后写`;
    const earlier = claims.findIndex(
      (other, before) => before < index && samePerson(other.user, claim.user),
    );
    if (earlier >= 0)
      return `${where}和第 ${earlier + 1} 份是同一个人（${claim.user.username}）`;
  }
  const paid = claims.reduce((sum, claim) => sum + claim.amount, 0);
  if (hongbao.total - paid < (hongbao.count - claims.length) * hongbao.minEach)
    return "已领的加起来太多，剩下的不够剩下每份都拿到每份至少";
  return null;
}

/**
 * One test, defaults filled in and held to what can happen on the site
 * (§5 只能写线上可能出现的情况): `{ problem }`, or the 红包 before the first
 * submission and each submission with who makes it, when and what is
 * expected.
 */
function planOf(test) {
  const multi = multiStep(test);
  const now = toMs(test.now) ?? TEST_DEFAULTS.now;
  const hongbao = {
    ...TEST_DEFAULTS.hongbao,
    ...test.hongbao,
    openedAt: toMs(test.hongbao?.openedAt) ?? now - HOUR,
    endsAt: toMs(test.hongbao?.endsAt) ?? now + DAY,
  };
  const fail = (problem) => ({ problem });
  if (hongbao.minEach * hongbao.count > hongbao.total)
    return fail("总奖池不够每份都拿到每份至少");
  if (hongbao.endsAt <= hongbao.openedAt)
    return fail("hongbao.endsAt 要晚于 hongbao.openedAt");
  const within = (at) => at >= hongbao.openedAt && at < hongbao.endsAt;
  const window =
    "在开放和截止之间（不早于 hongbao.openedAt，早于 hongbao.endsAt）";
  const times = [];
  if (!multi) {
    if (!within(now)) return fail(`now 要${window}`);
    times.push(now);
  } else
    for (const [index, step] of test.steps.entries()) {
      const at =
        toMs(step.at) ?? (index === 0 ? now : times[index - 1] + MINUTE);
      if (index > 0 && at < times[index - 1])
        return fail(`${stepName(index, step.who)}：时间早于上一步，要按先后写`);
      if (!within(at))
        return fail(`${stepName(index, step.who)}：这一步的时间要${window}`);
      times.push(at);
    }
  const start = times[0];
  // Counted before a number becomes placeholders: "claims": 1e10 is a
  // test that cannot happen, not ten billion records.
  const written =
    typeof test.claims === "number" ? test.claims : (test.claims ?? []).length;
  if (written >= hongbao.count)
    return fail(
      `claims 写了 ${written} 份，红包一共 ${hongbao.count} 份，要留至少一份没领`,
    );
  const claims =
    typeof test.claims === "number"
      ? placeholders(test.claims, hongbao, start)
      : (test.claims ?? []).map((claim) => ({
          user: { id: claim.user.id, username: claim.user.username },
          amount: claim.amount,
          input: claim.input.trim(),
          at: toMs(claim.at),
        }));
  const inconsistent = claimsInconsistency(claims, hongbao, start, multi);
  if (inconsistent) return fail(inconsistent);
  const state = test.state ?? null;
  if (nestsDeeper(state, LIMITS.stateDepth))
    return fail(`state 嵌套超过 ${LIMITS.stateDepth} 层`);
  if (encoder.encode(canonicalJson(state)).length > LIMITS.stateBytes)
    return fail(`state 超过 ${LIMITS.stateBytes / 1024} KB`);
  const plan = {
    hongbao,
    claims,
    state,
    secret: test.seed ?? TEST_SEED,
  };
  if (!multi) {
    const user = { ...TEST_DEFAULTS.user, ...test.user };
    if (claims.some((claim) => samePerson(claim.user, user)))
      return fail(`这个人（${user.username}）已经领过了，线上不会交给代码`);
    return {
      ...plan,
      steps: [
        {
          user,
          input: test.input.trim(),
          at: now,
          fetch: test.fetch ?? [],
          expect: test.expect,
        },
      ],
    };
  }
  // The same who is the same person: someone in claims by that name, or
  // the next number nobody has.
  const taken = new Set(claims.map((claim) => claim.user.id));
  const people = new Map(
    claims.map((claim) => [claim.user.username, claim.user.id]),
  );
  let next = FIRST_PERSON;
  return {
    ...plan,
    steps: test.steps.map((step, index) => {
      let id = people.get(step.who);
      if (id === undefined) {
        while (taken.has(next)) next += 1;
        id = next;
        taken.add(id);
        people.set(step.who, id);
      }
      return {
        who: step.who,
        user: {
          id,
          username: step.who,
          level:
            step.level === undefined ? TEST_DEFAULTS.user.level : step.level,
        },
        input: step.input.trim(),
        at: times[index],
        fetch: step.fetch ?? [],
        expect: step.expect,
      };
    }),
  };
}

/**
 * JSON with every object's keys sorted. Written without recursion: a state
 * nested a few thousand deep is still small enough to be allowed, and a
 * tests.json can nest deeper than the stack goes.
 */
function canonicalJson(value) {
  let text = "";
  // Last first: [true, text] is written as it is, [false, value] is a value.
  const todo = [[false, value ?? null]];
  while (todo.length > 0) {
    const [raw, item] = todo.pop();
    if (raw) text += item;
    else if (Array.isArray(item)) {
      todo.push([true, "]"]);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        todo.push([false, item[index] ?? null]);
        if (index > 0) todo.push([true, ","]);
      }
      todo.push([true, "["]);
    } else if (isObject(item)) {
      const keys = Object.keys(item)
        .filter((key) => item[key] !== undefined)
        .sort();
      todo.push([true, "}"]);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        todo.push([false, item[keys[index]]]);
        todo.push([
          true,
          `${index > 0 ? "," : ""}${JSON.stringify(keys[index])}:`,
        ]);
      }
      todo.push([true, "{"]);
    } else text += JSON.stringify(item);
  }
  return text;
}

/** Equal as JSON, whatever the order of keys. */
export function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Where `actual` differs from the keys `expected` names, as paths ("" for
 * the whole), in the order written: objects only by the keys written,
 * anything else whole. Without recursion, as canonicalJson.
 */
function unmatched(expected, actual) {
  const found = [];
  // Last first, so the paths come out in the order written.
  const todo = [{ path: "", want: expected, got: actual }];
  while (todo.length > 0) {
    const { path, want, got, missing } = todo.pop();
    if (missing || (isObject(want) ? !isObject(got) : !sameJson(want, got)))
      found.push(path);
    else if (isObject(want))
      for (const key of Object.keys(want).reverse()) {
        const at = path ? `${path}.${key}` : key;
        todo.push(
          Object.hasOwn(got, key)
            ? { path: at, want: want[key], got: got[key] }
            : { path: at, missing: true },
        );
      }
  }
  return found;
}

const noteText = (note) =>
  note === null ? "null（没拉进范围）" : `"${note}"（${NOTE_WORDS[note]}）`;

/** Every way a read answer differs from what was expected (§5 expect). */
function differences(expect, reading, state, view) {
  const found = [];
  if (expect.ok !== reading.ok)
    found.push(expect.ok ? "应该发，实际没发" : "不应该发，实际发了");
  else if (reading.ok) {
    if (expect.amount !== undefined && expect.amount !== reading.paid)
      found.push(
        reading.note === null
          ? `应该发 ${expect.amount}，实际发 ${reading.paid}`
          : `应该发 ${expect.amount}，实际发 ${reading.paid}（代码给的是 ${reading.asked}，${NOTE_WORDS[reading.note]}）`,
      );
    if (expect.asked !== undefined && expect.asked !== reading.asked)
      found.push(`代码应该给 ${expect.asked}，实际给 ${reading.asked}`);
    if (expect.note !== undefined && expect.note !== reading.note)
      found.push(
        `note 应该是 ${noteText(expect.note)}，实际是 ${noteText(reading.note)}`,
      );
  }
  const message = reading.message ?? "";
  const said = message ? `实际是“${message}”` : "实际没有回复";
  if (expect.message !== undefined && expect.message !== message)
    found.push(`回复应该是“${expect.message}”，${said}`);
  if (
    expect.messageIncludes !== undefined &&
    !message.includes(expect.messageIncludes)
  )
    found.push(`回复应该含“${expect.messageIncludes}”，${said}`);
  if (expect.state !== undefined && !sameJson(expect.state, state))
    found.push("state 和 expect.state 不一样");
  if (expect.stateIncludes !== undefined) {
    const paths = unmatched(expect.stateIncludes, state);
    if (paths.includes("")) found.push("state 和 expect.stateIncludes 不一样");
    else if (paths.length > 0)
      found.push(
        `state 里的 ${paths.join("、")} 和 expect.stateIncludes 不一样`,
      );
  }
  if (expect.view !== undefined && !sameJson(expect.view, view))
    found.push("view 和 expect.view 不一样");
  if (expect.viewIncludes !== undefined) {
    const paths = unmatched(expect.viewIncludes, view);
    if (paths.includes("")) found.push("view 和 expect.viewIncludes 不一样");
    else if (paths.length > 0)
      found.push(`view 里的 ${paths.join("、")} 和 expect.viewIncludes 不一样`);
  }
  const announce = reading.announce ?? "";
  if (expect.announce !== undefined && expect.announce !== announce)
    found.push(
      `动态应该是“${expect.announce}”，${announce ? `实际是“${announce}”` : "实际没有动态"}`,
    );
  if (expect.end !== undefined && expect.end !== (reading.end === true))
    found.push(
      expect.end ? "应该结束红包，实际没结束" : "不应该结束红包，实际结束了",
    );
  if (reading.unknown.length > 0)
    found.push(`代码返回了协议以外的字段：${reading.unknown.join("、")}`);
  return found;
}

const REFUSALS = {
  ended: "红包已经被判定器结束了，线上不会交给代码",
  claimed: "已经领过了，线上不会交给代码",
  "sold-out": "份已经领完了，线上不会交给代码",
};

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
 * What the code asked of the network against the answers the test wrote:
 * a request with no answer, an answer no request used.
 */
function networkDifferences(answer) {
  const found = [];
  for (const request of answer.requests ?? [])
    if (request.unanswered)
      found.push(`有请求没写返回：${request.method} ${request.url}`);
  for (const unused of answer.unused ?? [])
    found.push(`写了的返回没用上：${unused.method} ${unused.url}`);
  return found;
}

/**
 * One submission of a test, as it went (judgeNext's result); `view` is the
 * 红包's after it.
 */
function stepOutcome(step, judged, view) {
  if ("refused" in judged)
    return {
      passed: false,
      problem: REFUSALS[judged.refused],
      ms: 0,
    };
  const { answer, ms, reading, submission } = judged;
  const logs = answer.logs?.length ? { logs: answer.logs } : {};
  if ("failure" in answer)
    return {
      passed: false,
      problem: `${failureWords[answer.failure] ?? "出错"}：${answer.detail}`,
      ms,
      ...logs,
      failure: { kind: answer.failure, detail: answer.detail },
    };
  if ("error" in reading)
    return {
      passed: false,
      problem: `返回不对：${reading.error.detail}`,
      ms,
      ...logs,
    };
  const state = reading.state.keep ? submission.state : reading.state.value;
  const actual = {
    ok: reading.ok,
    ...(reading.ok
      ? { amount: reading.paid, asked: reading.asked, note: reading.note }
      : {}),
    ...(reading.message !== undefined ? { message: reading.message } : {}),
    state,
    ...(view !== null ? { view } : {}),
    ...(reading.announce !== undefined ? { announce: reading.announce } : {}),
    ...(reading.end ? { end: true } : {}),
  };
  const found = [
    ...differences(step.expect, reading, state, view),
    ...networkDifferences(answer),
  ];
  return {
    passed: found.length === 0,
    ...(found.length > 0 ? { problem: found.join("；") } : {}),
    actual,
    ms,
    ...logs,
  };
}

/**
 * One test, run: `run(submission, seeds, answers)` is the sandbox,
 * answering `{ verdict, logs? }` or `{ failure, detail, logs? }`, with
 * `requests` and `unused` when it answered fetch() from `answers` (the
 * test's or step's `fetch`). A test that could
 * not happen on the site fails before the code runs; steps stop at the
 * first that fails. The result says whether it passed and, if not, why
 * (a step's problem names the step and who), what the code answered and
 * paid (`actual`), the time all its judgments took, each step for a
 * multi-step test, and `failure` when the sandbox failed (so the site can
 * stop on code that will not load). With `twice`, everything the code
 * judged is judged again in the same order: `unstable` when an answer
 * differs, true randomness that no replay can match.
 */
export async function runTest(
  test,
  run,
  { twice = false, params: declared, check } = {},
) {
  const plan = planOf(test);
  if ("problem" in plan) return { passed: false, problem: plan.problem, ms: 0 };
  // 协议第三版: the params it is judged with, as the site would take them
  // from a sender, and as check() would let them through.
  const fail = (problem) => ({ passed: false, problem, ms: 0 });
  let params;
  if (declared !== undefined) {
    const read = paramValues(declared, test.params);
    if ("problems" in read) {
      const [first] = read.problems;
      return fail(
        `params${first.key ? ` 的 ${first.key}` : ""}：${first.message}`,
      );
    }
    params = read.values;
    if (check) {
      const { title, total, count, minEach } = plan.hongbao;
      const checked = await check(params, { title, total, count, minEach });
      if ("failure" in checked)
        return {
          ...fail(`check 出错：${checked.detail}`),
          failure: { kind: checked.failure, detail: checked.detail },
        };
      if ("invalid" in checked) return fail(checked.invalid);
      if (checked.problems.length > 0) {
        const [first] = checked.problems;
        return fail(`params 没通过 check：${first.key}：${first.message}`);
      }
    }
  }
  const scenario = startScenario({
    hongbao: plan.hongbao,
    claims: plan.claims,
    state: plan.state,
    hongbaoId: TEST_HONGBAO_ID,
    secret: plan.secret,
    ...(params !== undefined ? { params } : {}),
  });
  const steps = [];
  const answered = [];
  let ms = 0;
  let failure;
  for (const step of plan.steps) {
    const judged = await judgeNext(scenario, step, run);
    if ("answer" in judged && "verdict" in judged.answer)
      answered.push({
        submission: judged.submission,
        seeds: judged.seeds,
        answers: step.fetch,
        verdict: judged.answer.verdict,
      });
    const { failure: failed, ...outcome } = stepOutcome(
      step,
      judged,
      scenario.view,
    );
    ms += outcome.ms;
    failure = failed;
    steps.push({
      ...(step.who !== undefined ? { who: step.who } : {}),
      input: step.input,
      at: step.at,
      ...outcome,
    });
    if (!outcome.passed) break;
  }
  let unstable = false;
  if (twice && !failure)
    for (const first of answered) {
      const again = await run(first.submission, first.seeds, first.answers);
      if ("failure" in again) break;
      if (!sameJson(first.verdict, again.verdict)) {
        unstable = true;
        break;
      }
    }
  // Steps stop at the first that fails: the last one says how it went.
  const last = steps.at(-1);
  const extra = {
    ...(failure ? { failure } : {}),
    ...(unstable ? { unstable: true } : {}),
  };
  if (!multiStep(test)) {
    const { input: _input, at: _at, ...single } = last;
    return { ...single, ...extra };
  }
  return {
    passed: last.passed,
    ...(last.problem
      ? { problem: `${stepName(steps.length - 1, last.who)}：${last.problem}` }
      : {}),
    ...(last.actual ? { actual: last.actual } : {}),
    ms,
    steps,
    ...extra,
  };
}
