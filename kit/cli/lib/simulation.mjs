// simulate.json (协议第 5 节): a 红包, the params it was sent with (协议第三
// 版) and the submissions made to it, in
// order, each written like a step of a multi-step test in tests.json (with
// the answers its requests get, `fetch`), only without expect. Unlike a step, someone who already has a share or a
// submission after the last share is no mistake here: npm run simulate
// says 已领过 or 已领完, as the site would turn them away. The 红包 and the
// times follow tests.json's rules and defaults (runtime/testing.mjs).
import {
  fetchProblem,
  LIMITS,
  TEST_DEFAULTS,
  TEST_SEED,
} from "../../runtime/index.mjs";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** People are numbered as they first appear, as in tests.json's steps. */
const FIRST_PERSON = 10001;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME_WORDS =
  "要是毫秒（整数）或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const characters = (text) => [...text].length;
const isTime = (value) =>
  typeof value === "number"
    ? Number.isSafeInteger(value)
    : typeof value === "string" &&
      ISO_WITH_ZONE.test(value) &&
      Number.isFinite(Date.parse(value));
const toMs = (value) =>
  value === undefined
    ? undefined
    : typeof value === "number"
      ? value
      : Date.parse(value);

function extraKey(value, keys, where) {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  return extra.length > 0 ? `${where}没有 ${extra.join("、")} 这一项` : null;
}

function timeProblem(value, label) {
  return value !== undefined && !isTime(value)
    ? `${label} ${TIME_WORDS}`
    : null;
}

function hongbaoProblem(hongbao) {
  if (hongbao === undefined) return null;
  if (!isObject(hongbao)) return "hongbao 要是一个对象";
  const extra = extraKey(
    hongbao,
    ["title", "total", "count", "minEach", "openedAt", "endsAt"],
    "hongbao 里",
  );
  if (extra) return extra;
  const { title } = hongbao;
  if (
    title !== undefined &&
    (typeof title !== "string" || !title.trim() || characters(title) > 100)
  )
    return "hongbao.title 要是 1–100 个字";
  for (const key of ["total", "count", "minEach"])
    if (
      hongbao[key] !== undefined &&
      (!Number.isSafeInteger(hongbao[key]) || hongbao[key] < 1)
    )
      return `hongbao.${key} 要是正整数`;
  if (hongbao.count !== undefined && hongbao.count > 1000)
    return "hongbao.count 最多 1000";
  return (
    timeProblem(hongbao.openedAt, "hongbao.openedAt") ??
    timeProblem(hongbao.endsAt, "hongbao.endsAt")
  );
}

function submissionProblem(item) {
  if (!isObject(item)) return "要是一个对象";
  const extra = extraKey(item, ["who", "input", "level", "at", "fetch"], "");
  if (extra) return extra;
  if (typeof item.who !== "string" || !item.who.trim())
    return "要有 who（谁提交的）";
  if (characters(item.who) > 60) return "who 最多 60 个字";
  if (typeof item.input !== "string") return "input 要是字符串";
  const input = item.input.trim();
  if (/[\r\n]/.test(input)) return "input 只能是一行";
  if (characters(input) < 1 || characters(input) > LIMITS.inputCharacters)
    return `input 要是 1–${LIMITS.inputCharacters} 个字`;
  if (item.level !== undefined && ![0, 1, 2, 3, 4, null].includes(item.level))
    return "level 要是 0–4 或 null";
  return timeProblem(item.at, "at") ?? fetchProblem(item.fetch);
}

const named = (item) =>
  isObject(item) && typeof item.who === "string" && item.who.trim()
    ? `（${item.who}）`
    : "";

/**
 * simulate.json, read: `{ plan }` with the 红包 (defaults filled in), the
 * seed and each submission with who, the user they are and when; or
 * `{ problem }`. `file` names the file in what is said.
 */
export function readSimulation(text, file = "simulate.json") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { problem: `${file} 不是有效的 JSON：${error.message}` };
  }
  if (!isObject(data))
    return {
      problem: `${file} 要是一个对象，提交写在它的 submissions 里：{ "submissions": [ … ] }`,
    };
  const fail = (problem) => ({ problem });
  const extra = extraKey(
    data,
    ["$schema", "now", "hongbao", "seed", "params", "submissions"],
    `${file} 里`,
  );
  if (extra) return fail(extra);
  if (data.$schema !== undefined && typeof data.$schema !== "string")
    return fail("$schema 要是字符串");
  if (data.params !== undefined && !isObject(data.params))
    return fail("params 要是一个对象（参数的 key 对应填的值）");
  const shape =
    timeProblem(data.now, "now") ??
    hongbaoProblem(data.hongbao) ??
    (data.seed !== undefined &&
    (typeof data.seed !== "string" || !HEX64.test(data.seed))
      ? "seed 要是 64 位小写十六进制"
      : null);
  if (shape) return fail(shape);
  if (!Array.isArray(data.submissions) || data.submissions.length === 0)
    return fail("submissions 要是一个数组，至少一次提交");
  for (const [index, item] of data.submissions.entries()) {
    const problem = submissionProblem(item);
    if (problem)
      return fail(`第 ${index + 1} 次提交${named(item)}：${problem}`);
  }

  const now = toMs(data.now) ?? TEST_DEFAULTS.now;
  const hongbao = {
    ...TEST_DEFAULTS.hongbao,
    ...data.hongbao,
    openedAt: toMs(data.hongbao?.openedAt) ?? now - HOUR,
    endsAt: toMs(data.hongbao?.endsAt) ?? now + DAY,
  };
  if (hongbao.minEach * hongbao.count > hongbao.total)
    return fail("总奖池不够每份都拿到每份至少");
  if (hongbao.endsAt <= hongbao.openedAt)
    return fail("hongbao.endsAt 要晚于 hongbao.openedAt");
  const people = new Map();
  const submissions = [];
  for (const [index, item] of data.submissions.entries()) {
    const at =
      toMs(item.at) ?? (index === 0 ? now : submissions[index - 1].at + MINUTE);
    const where = `第 ${index + 1} 次提交${named(item)}`;
    if (index > 0 && at < submissions[index - 1].at)
      return fail(`${where}：时间早于上一次，要按先后写`);
    if (at < hongbao.openedAt || at >= hongbao.endsAt)
      return fail(
        `${where}：时间要在开放和截止之间（不早于 hongbao.openedAt，早于 hongbao.endsAt）`,
      );
    if (!people.has(item.who)) people.set(item.who, FIRST_PERSON + people.size);
    submissions.push({
      who: item.who,
      user: {
        id: people.get(item.who),
        username: item.who,
        level: item.level === undefined ? TEST_DEFAULTS.user.level : item.level,
      },
      input: item.input.trim(),
      at,
      fetch: item.fetch ?? [],
    });
  }
  return {
    plan: {
      now,
      hongbao,
      seed: data.seed ?? TEST_SEED,
      // Checked against judge.js's params once it is loaded.
      params: data.params ?? {},
      submissions,
    },
  };
}
