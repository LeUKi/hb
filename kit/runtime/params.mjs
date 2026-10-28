// 协议第三版 (docs/judge-square-design.md §3, §4): what judge.js may export
// besides judge — `meta` (its name, to fill in once), `params` (the form a
// sender fills, handed to the code as submission.params), `hongbao` (the
// defaults and ranges of the 红包 sent with it) and `check` (what the
// params must be together). The rules are here once: the site's deploy and
// form, and the kit's commands, all read them from this file. Nothing here
// runs in the sandbox.
import { formatAmount } from "./money.mjs";

export const PARAM_TYPES = Object.freeze([
  "text",
  "textarea",
  "integer",
  "money",
  "switch",
  "choice",
  "list",
  "table",
]);

/** What a table's columns may be. */
export const COLUMN_TYPES = Object.freeze(["text", "integer", "money"]);

export const PARAM_LIMITS = Object.freeze({
  params: 20,
  keyCharacters: 32,
  labelCharacters: 20,
  hintCharacters: 60,
  textCharacters: 200,
  textareaCharacters: 2000,
  minOptions: 2,
  maxOptions: 20,
  optionValueCharacters: 50,
  items: 100,
  rows: 100,
  columns: 6,
  /** All of submission.params as JSON, as a state. */
  bytes: 16 * 1024,
  /** What check() may say at once. */
  checkProblems: 20,
  checkMessageCharacters: 100,
});

export const META_LIMITS = Object.freeze({ name: 20, description: 60 });

/** The 红包's own limits, which `hongbao` can only narrow. */
export const HONGBAO_LIMITS = Object.freeze({
  count: 1000,
  promptCharacters: 40,
});

const KEY = /^[A-Za-z0-9_]+$/;
const DEADLINE_UNITS = ["minutes", "hours", "days"];
const TYPE_WORDS = {
  text: "文字",
  textarea: "多行文字",
  integer: "整数",
  money: "金额",
  switch: "开关",
  choice: "选项",
  list: "列表",
  table: "表格",
};

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isWhole = (value) => Number.isSafeInteger(value);
const characters = (text) => [...text].length;
const ldc = (minor) => `${formatAmount(minor)} LDC`;
const encoder = new TextEncoder();

/** The first field not among `keys`, as a problem; null when none. */
function unknownField(value, keys, where) {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  return extra === undefined ? null : `${where}不认识 ${extra}`;
}

function textProblem(value, max, what) {
  if (typeof value !== "string" || !value.trim())
    return `${what} 要是不空的字符串`;
  if (characters(value.trim()) > max) return `${what} 最多 ${max} 个字`;
  return null;
}

/** A whole number field (min, max, …): its problem, or null. */
function wholeProblem(value, name, { least = -Infinity, most = Infinity }) {
  if (value === undefined) return null;
  if (!isWhole(value) || value < least || value > most)
    return least > -Infinity && most < Infinity
      ? `${name} 要是 ${least}–${most} 的整数`
      : least > -Infinity
        ? `${name} 要是不小于 ${least} 的整数`
        : `${name} 要是整数`;
  return null;
}

const SHARED = [
  "key",
  "label",
  "hint",
  "type",
  "default",
  "required",
  "secret",
];
const OWN = {
  text: ["minLength", "maxLength"],
  textarea: ["maxLength"],
  integer: ["min", "max", "step"],
  money: ["min", "max"],
  switch: [],
  choice: ["options"],
  list: ["minItems", "maxItems", "maxLength"],
  table: ["columns", "minRows", "maxRows"],
};

/** A value's own limits (text, integer or money): problem, or null. */
function limitsProblem(item, type) {
  if (type === "text")
    return (
      wholeProblem(item.minLength, "minLength", {
        least: 0,
        most: PARAM_LIMITS.textCharacters,
      }) ??
      wholeProblem(item.maxLength, "maxLength", {
        least: 1,
        most: PARAM_LIMITS.textCharacters,
      }) ??
      ((item.minLength ?? 0) > (item.maxLength ?? PARAM_LIMITS.textCharacters)
        ? "minLength 不能大于 maxLength"
        : null)
    );
  if (type === "textarea")
    return wholeProblem(item.maxLength, "maxLength", {
      least: 1,
      most: PARAM_LIMITS.textareaCharacters,
    });
  if (type === "integer")
    return (
      wholeProblem(item.min, "min", {}) ??
      wholeProblem(item.max, "max", {}) ??
      wholeProblem(item.step, "step", { least: 1 }) ??
      (item.min !== undefined && item.max !== undefined && item.min > item.max
        ? "min 不能大于 max"
        : null)
    );
  if (type === "money")
    return (
      wholeProblem(item.min, "min", { least: 1 }) ??
      wholeProblem(item.max, "max", { least: 1 }) ??
      (item.min !== undefined && item.max !== undefined && item.min > item.max
        ? "min 不能大于 max"
        : null)
    );
  return null;
}

function optionsProblem(options) {
  if (
    !Array.isArray(options) ||
    options.length < PARAM_LIMITS.minOptions ||
    options.length > PARAM_LIMITS.maxOptions
  )
    return `options 要 ${PARAM_LIMITS.minOptions}–${PARAM_LIMITS.maxOptions} 个`;
  const values = new Set();
  for (const [index, option] of options.entries()) {
    const where = `options 第 ${index + 1} 个`;
    if (!isObject(option)) return `${where}要是 { value, label }`;
    const extra = unknownField(option, ["value", "label"], `${where}`);
    if (extra) return extra;
    const problem =
      textProblem(
        option.value,
        PARAM_LIMITS.optionValueCharacters,
        `${where}的 value`,
      ) ??
      textProblem(
        option.label,
        PARAM_LIMITS.labelCharacters,
        `${where}的 label`,
      );
    if (problem) return problem;
    if (values.has(option.value)) return `${where}的 value 重复了`;
    values.add(option.value);
  }
  return null;
}

function columnsProblem(columns) {
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > PARAM_LIMITS.columns
  )
    return `columns 要 1–${PARAM_LIMITS.columns} 列`;
  const keys = new Set();
  for (const [index, column] of columns.entries()) {
    const where = `columns 第 ${index + 1} 列`;
    if (!isObject(column)) return `${where}要是一个对象`;
    if (!COLUMN_TYPES.includes(column.type))
      return `${where}的 type 只能是 ${COLUMN_TYPES.join("、")}`;
    const extra = unknownField(
      column,
      ["key", "label", "type", "required", ...OWN[column.type]],
      where,
    );
    if (extra) return extra;
    if (typeof column.key !== "string" || !KEY.test(column.key))
      return `${where}的 key 只能用字母、数字和下划线`;
    if (characters(column.key) > PARAM_LIMITS.keyCharacters)
      return `${where}的 key 最多 ${PARAM_LIMITS.keyCharacters} 个字`;
    if (keys.has(column.key)) return `${where}的 key 重复了`;
    keys.add(column.key);
    const problem =
      textProblem(
        column.label,
        PARAM_LIMITS.labelCharacters,
        `${where}的 label`,
      ) ??
      (column.required !== undefined && typeof column.required !== "boolean"
        ? `${where}的 required 要是 true 或 false`
        : null) ??
      limitsProblem(column, column.type);
    if (problem) return `${where}：${problem}`;
  }
  return null;
}

/** One declared item: its problem, or null. */
function itemProblem(item) {
  if (!isObject(item)) return "要是一个对象";
  if (!PARAM_TYPES.includes(item.type))
    return `type 只能是 ${PARAM_TYPES.join("、")}`;
  const extra = unknownField(item, [...SHARED, ...OWN[item.type]], "");
  if (extra) return extra;
  if (typeof item.key !== "string" || !KEY.test(item.key))
    return "key 只能用字母、数字和下划线";
  if (characters(item.key) > PARAM_LIMITS.keyCharacters)
    return `key 最多 ${PARAM_LIMITS.keyCharacters} 个字`;
  return (
    textProblem(item.label, PARAM_LIMITS.labelCharacters, "label") ??
    (item.hint !== undefined
      ? textProblem(item.hint, PARAM_LIMITS.hintCharacters, "hint")
      : null) ??
    (item.required !== undefined && typeof item.required !== "boolean"
      ? "required 要是 true 或 false"
      : null) ??
    (item.secret !== undefined && typeof item.secret !== "boolean"
      ? "secret 要是 true 或 false"
      : null) ??
    limitsProblem(item, item.type) ??
    (item.type === "choice" ? optionsProblem(item.options) : null) ??
    (item.type === "list"
      ? (wholeProblem(item.minItems, "minItems", {
          least: 0,
          most: PARAM_LIMITS.items,
        }) ??
        wholeProblem(item.maxItems, "maxItems", {
          least: 1,
          most: PARAM_LIMITS.items,
        }) ??
        wholeProblem(item.maxLength, "maxLength", {
          least: 1,
          most: PARAM_LIMITS.textCharacters,
        }) ??
        ((item.minItems ?? 0) > (item.maxItems ?? PARAM_LIMITS.items)
          ? "minItems 不能大于 maxItems"
          : null))
      : null) ??
    (item.type === "table"
      ? (columnsProblem(item.columns) ??
        wholeProblem(item.minRows, "minRows", {
          least: 0,
          most: PARAM_LIMITS.rows,
        }) ??
        wholeProblem(item.maxRows, "maxRows", {
          least: 1,
          most: PARAM_LIMITS.rows,
        }) ??
        ((item.minRows ?? 0) > (item.maxRows ?? PARAM_LIMITS.rows)
          ? "minRows 不能大于 maxRows"
          : null))
      : null)
  );
}

/** A declared item as the site keeps it: what was written, trimmed. */
function tidy(item) {
  const kept = { ...item, label: item.label.trim() };
  if (item.hint !== undefined) kept.hint = item.hint.trim();
  if (item.type === "table")
    kept.columns = item.columns.map((column) => ({
      ...column,
      label: column.label.trim(),
    }));
  if (item.type === "choice")
    kept.options = item.options.map((option) => ({
      value: option.value,
      label: option.label.trim(),
    }));
  return kept;
}

/**
 * judge.js's `params` export: `{ list }` (empty when it has none) or
 * `{ problems }`, one line each, as the deploy and npm run check write them.
 */
export function readParams(value) {
  if (value === undefined || value === null) return { list: [] };
  if (!Array.isArray(value))
    return { problems: ["params 要是一个数组，每项是一个参数"] };
  if (value.length > PARAM_LIMITS.params)
    return { problems: [`params 最多 ${PARAM_LIMITS.params} 项`] };
  const problems = [];
  const list = [];
  const keys = new Set();
  for (const [index, item] of value.entries()) {
    const where = `params 第 ${index + 1} 项${isObject(item) && typeof item.key === "string" ? `（${item.key}）` : ""}`;
    const problem = itemProblem(item);
    if (problem) {
      problems.push(`${where}：${problem}`);
      continue;
    }
    if (keys.has(item.key)) {
      problems.push(`${where}：key 重复了`);
      continue;
    }
    keys.add(item.key);
    const kept = tidy(item);
    if (kept.default !== undefined) {
      const checked = readValue(kept, kept.default, kept.label);
      if ("problem" in checked) {
        problems.push(`${where}：default 不在范围里`);
        continue;
      }
    }
    list.push(kept);
  }
  return problems.length > 0 ? { problems } : { list };
}

const isEmpty = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "");

/** A text, integer or money value (an item's or a column's), checked. */
function scalarOf(item, value, name) {
  if (item.type === "text" || item.type === "textarea") {
    if (typeof value !== "string") return { problem: `${name}要是文字` };
    const text = value.trim();
    const max =
      item.maxLength ??
      (item.type === "text"
        ? PARAM_LIMITS.textCharacters
        : PARAM_LIMITS.textareaCharacters);
    if (item.minLength !== undefined && characters(text) < item.minLength)
      return { problem: `${name}最少 ${item.minLength} 个字` };
    if (characters(text) > max) return { problem: `${name}最多 ${max} 个字` };
    return { value: text };
  }
  if (item.type === "integer") {
    if (!isWhole(value)) return { problem: `${name}要是整数` };
    if (item.min !== undefined && value < item.min)
      return { problem: `${name}最小是 ${item.min}` };
    if (item.max !== undefined && value > item.max)
      return { problem: `${name}最大是 ${item.max}` };
    if (item.step !== undefined && (value - (item.min ?? 0)) % item.step !== 0)
      return { problem: `${name}要是 ${item.step} 的倍数` };
    return { value };
  }
  // money, in 分.
  if (!isWhole(value) || value <= 0)
    return { problem: `${name}要大于 0，最多两位小数` };
  if (item.min !== undefined && value < item.min)
    return { problem: `${name}最少 ${ldc(item.min)}` };
  if (item.max !== undefined && value > item.max)
    return { problem: `${name}最多 ${ldc(item.max)}` };
  return { value };
}

/** What an item takes when nothing was given and it may be left out. */
function emptyOf(item) {
  if (item.type === "switch") return false;
  if (item.type === "list" || item.type === "table") return [];
  return null;
}

/** One item's value: `{ value }` (as the code gets it) or `{ problem }`. */
function readValue(item, given, name) {
  const required = item.required !== false;
  if (item.type === "switch") {
    if (given === undefined || given === null) return { value: false };
    return typeof given === "boolean"
      ? { value: given }
      : { problem: `${name}要是 true 或 false` };
  }
  if (item.type === "list" || item.type === "table") {
    if (given === undefined || given === null) given = [];
    if (!Array.isArray(given))
      return {
        problem: `${name}要是一个数组`,
      };
    const many = item.type === "list" ? "项" : "行";
    const least =
      (item.type === "list" ? item.minItems : item.minRows) ??
      (required ? 1 : 0);
    const most =
      (item.type === "list" ? item.maxItems : item.maxRows) ??
      (item.type === "list" ? PARAM_LIMITS.items : PARAM_LIMITS.rows);
    if (given.length === 0 && least > 0 && required)
      return { problem: `请填写${name}` };
    if (given.length < least)
      return { problem: `${name}至少 ${least} ${many}` };
    if (given.length > most) return { problem: `${name}最多 ${most} ${many}` };
    if (item.type === "list") {
      const items = [];
      for (const [index, entry] of given.entries()) {
        if (isEmpty(entry)) return { problem: `第 ${index + 1} 项是空的` };
        const read = scalarOf(
          {
            type: "text",
            maxLength: item.maxLength ?? PARAM_LIMITS.textCharacters,
          },
          entry,
          `第 ${index + 1} 项`,
        );
        if ("problem" in read) return read;
        items.push(read.value);
      }
      return { value: items };
    }
    const rows = [];
    for (const [index, row] of given.entries()) {
      if (!isObject(row)) return { problem: `第 ${index + 1} 行要是一个对象` };
      const extra = Object.keys(row).find(
        (key) => !item.columns.some((column) => column.key === key),
      );
      if (extra !== undefined)
        return { problem: `第 ${index + 1} 行没有 ${extra} 这一列` };
      const kept = {};
      for (const column of item.columns) {
        const cell = `第 ${index + 1} 行的${column.label}`;
        if (isEmpty(row[column.key])) {
          if (column.required === false) {
            kept[column.key] = null;
            continue;
          }
          return { problem: `请填写${cell}` };
        }
        const read = scalarOf(column, row[column.key], cell);
        if ("problem" in read) return read;
        kept[column.key] = read.value;
      }
      rows.push(kept);
    }
    return { value: rows };
  }
  if (isEmpty(given)) {
    if (!required) return { value: emptyOf(item) };
    return {
      problem: item.type === "choice" ? `请选择${name}` : `请填写${name}`,
    };
  }
  if (item.type === "choice")
    return item.options.some((option) => option.value === given)
      ? { value: given }
      : { problem: `请选择${name}` };
  return scalarOf(item, given, name);
}

/**
 * The params a sender filled (or a test wrote) against the declared list:
 * `{ values }`, as submission.params gets them — every declared key, an
 * item left out taking its default, then its empty value — or
 * `{ problems }`, `[{ key, message }]`, the first one of each item; a key
 * of "" is about all of them.
 */
export function paramValues(list, given) {
  if (given !== undefined && given !== null && !isObject(given))
    return { problems: [{ key: "", message: "params 要是一个对象" }] };
  const input = given ?? {};
  const problems = [];
  for (const key of Object.keys(input))
    if (!list.some((item) => item.key === key))
      problems.push({ key, message: `这个判定器没有 ${key} 这个参数` });
  const values = {};
  for (const item of list) {
    const read = readValue(
      item,
      input[item.key] === undefined ? item.default : input[item.key],
      item.label,
    );
    if ("problem" in read)
      problems.push({ key: item.key, message: read.problem });
    else values[item.key] = read.value;
  }
  if (problems.length > 0) return { problems };
  if (encoder.encode(JSON.stringify(values)).length > PARAM_LIMITS.bytes)
    return {
      problems: [
        { key: "", message: `参数一共最多 ${PARAM_LIMITS.bytes / 1024} KB` },
      ],
    };
  return { values };
}

/** The keys kept secret until the 红包 is over (§3 保密参数). */
export const secretKeys = (list) =>
  list.filter((item) => item.secret === true).map((item) => item.key);

/**
 * What check(params, hongbao) answered: `{ problems }` — `[{ key,
 * message }]`, each key a declared one, at most 20 — or `{ invalid }`
 * saying why it is not that.
 */
export function readCheckAnswer(value, list) {
  if (value === undefined || value === null) return { problems: [] };
  const shape = "check 要返回 [{ key, message }] 这样的数组，没问题就返回 []";
  if (!Array.isArray(value)) return { invalid: shape };
  if (value.length > PARAM_LIMITS.checkProblems)
    return { invalid: `check 最多返回 ${PARAM_LIMITS.checkProblems} 个问题` };
  const problems = [];
  for (const entry of value) {
    if (
      !isObject(entry) ||
      typeof entry.key !== "string" ||
      typeof entry.message !== "string"
    )
      return { invalid: shape };
    if (!list.some((item) => item.key === entry.key))
      return { invalid: `check 返回的 key（${entry.key}）不是声明过的参数` };
    const message = entry.message.trim();
    if (!message || characters(message) > PARAM_LIMITS.checkMessageCharacters)
      return {
        invalid: `check 返回的 message 要是 1–${PARAM_LIMITS.checkMessageCharacters} 个字`,
      };
    problems.push({ key: entry.key, message });
  }
  return { problems };
}

function rangeProblem(
  value,
  name,
  { least = 1, most = Number.MAX_SAFE_INTEGER, keys },
) {
  if (!isObject(value)) return `${name} 要是一个对象`;
  const extra = unknownField(value, keys, `${name} `);
  if (extra) return extra;
  for (const key of keys) {
    const problem = wholeProblem(value[key], `${name}.${key}`, { least, most });
    if (problem) return problem;
  }
  const low = value.min ?? least;
  const high = value.max ?? most;
  if (low > high) return `${name}.min 不能大于 ${name}.max`;
  if (
    value.default !== undefined &&
    (value.default < low || value.default > high)
  )
    return `${name}.default 不在范围里`;
  return null;
}

/**
 * judge.js's `hongbao` export (§4): `{ rules }` (null when it has none) or
 * `{ problems }`. Amounts are in 分, as the code gets them.
 */
export function readHongbaoRules(value) {
  if (value === undefined || value === null) return { rules: null };
  if (!isObject(value)) return { problems: ["hongbao 要是一个对象"] };
  const keys = [
    "count",
    "total",
    "minEach",
    "deadline",
    "prompt",
    "humanCheck",
  ];
  const extra = unknownField(value, keys, "hongbao 里");
  if (extra) return { problems: [`${extra}：只能写 ${keys.join("、")}`] };
  const problems = [];
  const add = (problem) => {
    if (problem) problems.push(problem);
  };
  if (value.count !== undefined)
    add(
      rangeProblem(value.count, "hongbao.count", {
        most: HONGBAO_LIMITS.count,
        keys: ["min", "max", "default"],
      }),
    );
  if (value.total !== undefined)
    add(
      rangeProblem(value.total, "hongbao.total", {
        keys: ["min", "max", "default"],
      }),
    );
  if (value.minEach !== undefined)
    add(
      rangeProblem(value.minEach, "hongbao.minEach", {
        keys: ["min", "default"],
      }),
    );
  if (value.deadline !== undefined) {
    const deadline = value.deadline;
    if (
      !isObject(deadline) ||
      unknownField(deadline, ["value", "unit"], "") ||
      !isWhole(deadline.value) ||
      deadline.value <= 0 ||
      !DEADLINE_UNITS.includes(deadline.unit)
    )
      add(
        'hongbao.deadline 要写成 { value: 正整数, unit: "minutes" | "hours" | "days" }',
      );
  }
  if (value.prompt !== undefined)
    add(
      textProblem(
        value.prompt,
        HONGBAO_LIMITS.promptCharacters,
        "hongbao.prompt",
      ),
    );
  if (value.humanCheck !== undefined && typeof value.humanCheck !== "boolean")
    add("hongbao.humanCheck 要是 true 或 false");
  if (problems.length > 0) return { problems };
  return {
    rules: {
      ...value,
      ...(value.prompt !== undefined ? { prompt: value.prompt.trim() } : {}),
    },
  };
}

/** “1–10 份”, “至少 3 份”, “最多 10 份” (or in LDC): a rule's range. */
function spanOf({ min, max }, show) {
  if (min !== undefined && max !== undefined)
    return show === "份"
      ? `${min}–${max} 份`
      : `${formatAmount(min)}–${formatAmount(max)} LDC`;
  const one = (n) => (show === "份" ? `${n} 份` : ldc(n));
  return min !== undefined ? `至少 ${one(min)}` : `最多 ${one(max)}`;
}

const outside = (rule, value) =>
  rule !== undefined &&
  value !== undefined &&
  value !== null &&
  ((rule.min !== undefined && value < rule.min) ||
    (rule.max !== undefined && value > rule.max));

/**
 * Where the 红包's numbers fall outside what the judge asks (§4, 发多少):
 * `[{ field, message }]`, field one of count, total, minEach. Amounts are
 * in 分.
 */
export function hongbaoRuleProblems(rules, { count, total, minEach }) {
  if (!rules) return [];
  const problems = [];
  if (outside(rules.count, count))
    problems.push({
      field: "count",
      message: `这个判定器要求 ${spanOf(rules.count, "份")}`,
    });
  if (outside(rules.total, total))
    problems.push({
      field: "total",
      message: `这个判定器要求总奖池 ${spanOf(rules.total, "LDC")}`,
    });
  if (outside(rules.minEach, minEach))
    problems.push({
      field: "minEach",
      message: `这个判定器要求每份至少 ${ldc(rules.minEach.min)}`,
    });
  return problems;
}

/** judge.js's `meta` export (§1): `{ meta }` (null when none) or `{ problems }`. */
export function readMeta(value) {
  if (value === undefined || value === null) return { meta: null };
  if (!isObject(value))
    return { problems: ["meta 要是 { name, description }"] };
  const extra = unknownField(value, ["name", "description"], "meta 里");
  if (extra) return { problems: [`${extra}：只能写 name 和 description`] };
  const problems = [];
  const name = textProblem(value.name, META_LIMITS.name, "meta.name");
  if (name) problems.push(name);
  if (value.description !== undefined) {
    const description = textProblem(
      value.description,
      META_LIMITS.description,
      "meta.description",
    );
    if (description) problems.push(description);
  }
  if (problems.length > 0) return { problems };
  return {
    meta: {
      name: value.name.trim(),
      ...(value.description !== undefined
        ? { description: value.description.trim() }
        : {}),
    },
  };
}

/** “范围（整数，1–100，默认 100）”: one line of npm run check's preview. */
export function paramLine(item) {
  const parts = [TYPE_WORDS[item.type]];
  const span = (low, high, show = String) =>
    low !== undefined && high !== undefined
      ? `${show(low)}–${show(high)}`
      : low !== undefined
        ? `至少 ${show(low)}`
        : high !== undefined
          ? `最多 ${show(high)}`
          : null;
  if (item.type === "text" || item.type === "textarea") {
    if (item.maxLength !== undefined) parts.push(`最多 ${item.maxLength} 个字`);
  } else if (item.type === "integer") {
    const range = span(item.min, item.max);
    if (range) parts.push(range);
    if (item.step !== undefined) parts.push(`${item.step} 的倍数`);
  } else if (item.type === "money") {
    const range = span(item.min, item.max, formatAmount);
    if (range) parts.push(`${range} LDC`);
  } else if (item.type === "choice")
    parts.push(item.options.map((option) => option.label).join(" / "));
  else if (item.type === "list") {
    const range = span(item.minItems, item.maxItems);
    if (range) parts.push(`${range} 项`);
  } else if (item.type === "table") {
    parts.push(`列：${item.columns.map((column) => column.label).join("、")}`);
    const range = span(item.minRows, item.maxRows);
    if (range) parts.push(`${range} 行`);
  }
  if (
    item.default !== undefined &&
    item.type !== "list" &&
    item.type !== "table"
  )
    parts.push(
      `默认 ${
        item.type === "money"
          ? formatAmount(item.default)
          : item.type === "switch"
            ? item.default
              ? "开"
              : "关"
            : item.type === "choice"
              ? (item.options.find((option) => option.value === item.default)
                  ?.label ?? item.default)
              : item.default
      }`,
    );
  if (item.required === false && item.type !== "switch") parts.push("选填");
  if (item.secret) parts.push("保密");
  return `${item.label}（${parts.join("，")}）`;
}

/**
 * What main.mjs answered to { describe: true }, beside `network` (read by
 * readNetwork): `meta`, `params`, `hongbao` and `check`, each by its rules —
 * `{ meta, params, hongbao, check, problems }`, problems one line each.
 * An answer from an earlier protocol has none of them.
 */
export function readDeclarations(answer) {
  const unreadable = new Set(answer?.unreadable ?? []);
  const problems = [];
  const read = (name, reader) => {
    if (unreadable.has(name)) {
      problems.push(`${name} 转不成 JSON`);
      return null;
    }
    const result = reader(answer?.[name] ?? null);
    if ("problems" in result) {
      problems.push(...result.problems);
      return null;
    }
    return result;
  };
  const meta = read("meta", readMeta)?.meta ?? null;
  const params = read("params", readParams)?.list ?? [];
  const hongbao = read("hongbao", readHongbaoRules)?.rules ?? null;
  if (answer?.check === false) problems.push("check 要是一个函数");
  return { meta, params, hongbao, check: answer?.check === true, problems };
}
