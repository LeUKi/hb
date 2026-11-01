// 协议第三版 (docs/judge-square-design.md §3, §4): what judge.js may export
// besides judge — `meta` (its name, to fill in once), `params` (the form a
// sender fills, handed to the code as submission.params), `hongbao` (the
// defaults and ranges of the 红包 sent with it) and `check` (what the
// params must be together). The rules are here once: the site's deploy and
// form, and the kit's commands, all read them from this file. Nothing here
// runs in the sandbox.
import { sha256Text } from "./hash.mjs";
import { formatAmount } from "./money.mjs";
import {
  allowedBy,
  fixedAddresses,
  isParamEntry,
  readAddress,
  readEntry,
} from "./network.mjs";

export const PARAM_TYPES = Object.freeze([
  "text",
  "textarea",
  "integer",
  "money",
  "switch",
  "choice",
  "list",
  "table",
  "key",
  "url",
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
  /** 密钥 (docs/judge-key-design.md): how many, how long, a prefix. */
  keys: 3,
  keyValueCharacters: 500,
  keyPrefixCharacters: 20,
  /** 地址参数 (docs/judge-address-design.md §3). */
  urls: 3,
  /** meta.page's path after an 地址参数. */
  pagePathCharacters: 200,
});

export const META_LIMITS = Object.freeze({
  name: 20,
  description: 60,
  page: 500,
});

/** The 红包's own limits, which `hongbao` can only narrow. */
export const HONGBAO_LIMITS = Object.freeze({
  count: 1000,
  promptCharacters: 40,
  /** The 红包's own title limit. */
  titleCharacters: 100,
  /** A start on its 说明 (the 红包's own allows 10000). */
  noteCharacters: 2000,
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
  key: "密钥",
  url: "地址",
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
  "revealAtEnd",
  // revealAtEnd as it was first written.
  "secret",
  // 怎么填 ↗ (docs/judge-address-design.md §3).
  "guide",
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
  key: ["to", "header", "prefix"],
  url: [],
};

/** A header a key may go out in: a token, none the gateway sets itself. */
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const GATEWAY_HEADERS = [
  "host",
  "user-agent",
  "content-length",
  "content-type",
  "cookie",
  "connection",
  "transfer-encoding",
  "upgrade",
];

/**
 * A 密钥 (docs/judge-key-design.md): where it goes (`to`, one address
 * prefix), in which header, after what; never shown, so no default and no
 * revealAtEnd. Its problem, or null.
 */
function keyProblem(item) {
  if (item.revealAtEnd !== undefined || item.secret !== undefined)
    return "密钥本来就不公开，不用写 revealAtEnd";
  if (item.default !== undefined)
    return "密钥不能写 default，由发红包的人自己填";
  // { param }: the 地址参数 it names, checked against the list (readParams).
  if (!isParamEntry(item.to)) {
    if (typeof item.to !== "string")
      return 'to 要写密钥发给哪个地址，比如 "https://api.openai.com/v1/"，或者 { param: "地址参数的 key" }';
    const to = readEntry(item.to);
    if ("problem" in to) return `to ${to.problem}`;
  }
  if (item.header !== undefined) {
    if (typeof item.header !== "string" || !HEADER.test(item.header))
      return "header 要是请求头的名字，比如 Authorization";
    const lower = item.header.toLowerCase();
    if (GATEWAY_HEADERS.includes(lower) || lower.startsWith("x-hb-"))
      return `header 不能是 ${item.header}`;
  }
  if (
    item.prefix !== undefined &&
    (typeof item.prefix !== "string" ||
      /[\r\n]/.test(item.prefix) ||
      characters(item.prefix) > PARAM_LIMITS.keyPrefixCharacters)
  )
    return `prefix 要是一行文字，最多 ${PARAM_LIMITS.keyPrefixCharacters} 个字，比如 "Bearer "`;
  return null;
}

/**
 * An 地址参数 (docs/judge-address-design.md §3): shown from opening and
 * filled by the sender, so no revealAtEnd and no default.
 */
function urlProblem(item) {
  if (item.revealAtEnd !== undefined || item.secret !== undefined)
    return "地址要公开，领的人要看得到判定器会请求哪里，不能写 revealAtEnd";
  if (item.default !== undefined)
    return "地址不能写 default，由发红包的人自己填";
  return null;
}

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
    const extra = unknownField(
      option,
      ["value", "label", "hint", "set"],
      `${where}`,
    );
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
      ) ??
      // 选项联动 (judge-square §3): the hint it shows, the params it sets.
      (option.hint !== undefined
        ? textProblem(
            option.hint,
            PARAM_LIMITS.hintCharacters,
            `${where}的 hint`,
          )
        : null) ??
      (option.set !== undefined &&
      (!isObject(option.set) || Object.keys(option.set).length === 0)
        ? `${where}的 set 要是 { 参数的 key: 值 }`
        : null);
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
    (item.guide !== undefined
      ? ((problem) => (problem ? `guide ${problem}` : null))(
          pageProblem(item.guide),
        )
      : null) ??
    (item.type === "key" ? keyProblem(item) : null) ??
    (item.type === "url" ? urlProblem(item) : null) ??
    (item.revealAtEnd !== undefined && typeof item.revealAtEnd !== "boolean"
      ? "revealAtEnd 要是 true 或 false"
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
  if (item.guide !== undefined) kept.guide = new URL(item.guide.trim()).href;
  if (item.type === "key")
    kept.to = isParamEntry(item.to)
      ? { param: item.to.param }
      : readEntry(item.to).prefix;
  if (item.type === "table")
    kept.columns = item.columns.map((column) => ({
      ...column,
      label: column.label.trim(),
    }));
  if (item.type === "choice")
    kept.options = item.options.map((option) => ({
      value: option.value,
      label: option.label.trim(),
      ...(option.hint !== undefined ? { hint: option.hint.trim() } : {}),
      ...(option.set !== undefined ? { set: option.set } : {}),
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
  if (keyParams(list).length > PARAM_LIMITS.keys)
    problems.push(`params 里的密钥最多 ${PARAM_LIMITS.keys} 项`);
  if (list.filter((item) => item.type === "url").length > PARAM_LIMITS.urls)
    problems.push(`params 里的地址最多 ${PARAM_LIMITS.urls} 项`);
  // A 密钥 to an 地址参数: that one is declared, as an address.
  for (const item of keyParams(list)) {
    if (typeof item.to === "string") continue;
    const problem = addressParamProblem(list, item.to.param);
    if (problem) problems.push(`params（${item.key}）的 to：${problem}`);
  }
  // 选项联动: what an option sets is another param, as that one takes it.
  for (const item of list) {
    if (item.type !== "choice") continue;
    for (const [index, option] of item.options.entries())
      for (const [key, value] of Object.entries(option.set ?? {})) {
        const where = `params（${item.key}）的 options 第 ${index + 1} 个的 set`;
        const target = list.find((other) => other.key === key);
        if (key === item.key) problems.push(`${where}：不能改自己`);
        else if (!target) problems.push(`${where}：没有参数 ${key}`);
        else if (target.type === "key")
          problems.push(`${where}：不能改密钥 ${key}`);
        else {
          const checked = readValue(target, value, target.label);
          if ("problem" in checked)
            problems.push(`${where}：${checked.problem}`);
          // The option chosen to start with: the two starting values agree.
          else if (
            item.default === option.value &&
            target.default !== undefined &&
            sortedJson(target.default) !== sortedJson(checked.value)
          )
            problems.push(
              `${where}：默认选“${option.label}”，它把${target.label}改成 ${setText(target, checked.value)}，和${target.label}的 default 不一样，改成一样的`,
            );
        }
      }
  }
  return problems.length > 0 ? { problems } : { list };
}

/** A value an option sets, as the form would show it. */
function setText(item, value) {
  if (item.type === "money") return `${formatAmount(value)} LDC`;
  if (item.type === "switch") return value ? "开" : "关";
  if (item.type === "choice")
    return (
      item.options.find((option) => option.value === value)?.label ?? value
    );
  if (item.type === "list") return value.join("、");
  if (item.type === "table") return `${value.length} 行`;
  return String(value);
}

/**
 * 选项联动 in the params preview (judge-square §3): a line for each option
 * of a choice that sets others or says more — “选简单：炸弹 3、最大 50。炸弹
 * 少、范围小，适合新手”.
 */
export function optionLines(item, list) {
  if (item.type !== "choice") return [];
  return item.options
    .filter((option) => option.set || option.hint)
    .map((option) => {
      const sets = Object.entries(option.set ?? {})
        .map(([key, value]) => {
          const target = list.find((other) => other.key === key);
          return target ? `${target.label} ${setText(target, value)}` : null;
        })
        .filter(Boolean)
        .join("、");
      return `选${option.label}：${[sets, option.hint].filter(Boolean).join("。")}`;
    });
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

/**
 * One item's value: `{ value }` (as the code gets it) or `{ problem }`.
 * `local`: an 地址参数 may be the kit's http://localhost (readAddress).
 */
function readValue(item, given, name, { local = false } = {}) {
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
  if (item.type === "url") {
    if (typeof given !== "string") return { problem: `${name}要是地址` };
    const read = readAddress(given, { local });
    return "problem" in read
      ? { problem: `${name}${read.problem}` }
      : { value: read.address };
  }
  return scalarOf(item, given, name);
}

/**
 * The params a sender filled (or a test wrote) against the declared list:
 * `{ values }`, as submission.params gets them — every declared key, an
 * item left out taking its default, then its empty value — or
 * `{ problems }`, `[{ key, message }]`, the first one of each item; a key
 * of "" is about all of them. `local`: the kit's `--live` (readValue).
 */
export function paramValues(list, given, { local = false } = {}) {
  if (given !== undefined && given !== null && !isObject(given))
    return { problems: [{ key: "", message: "params 要是一个对象" }] };
  const input = given ?? {};
  const problems = [];
  for (const key of Object.keys(input)) {
    const item = list.find((each) => each.key === key);
    if (!item)
      problems.push({ key, message: `这个判定器没有 ${key} 这个参数` });
    // 密钥 (docs/judge-key-design.md): never among the params the code gets.
    else if (item.type === "key")
      problems.push({ key, message: `${item.label}是密钥，不放在参数里` });
  }
  const values = {};
  for (const item of list) {
    if (item.type === "key") continue;
    const read = readValue(
      item,
      input[item.key] === undefined ? item.default : input[item.key],
      item.label,
      { local },
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

/**
 * 结束后公开 (§3; docs/judge-key-design.md §0): revealAtEnd, or secret as
 * it was first written.
 */
export const revealsAtEnd = (item) =>
  item.revealAtEnd === true || item.secret === true;

/** The keys kept back until the 红包 is over (结束后公开). */
export const secretKeys = (list) =>
  list.filter(revealsAtEnd).map((item) => item.key);

/** The 密钥 among the params (docs/judge-key-design.md). */
export const keyParams = (list) => list.filter((item) => item.type === "key");

/** A 密钥 as a sender typed it: `{ value }`, trimmed, or `{ problem }`. */
export function readKeyValue(item, given) {
  if (typeof given !== "string" || given.trim() === "")
    return { problem: `请填写${item.label}` };
  const value = given.trim();
  if (/[\r\n]/.test(value)) return { problem: `${item.label}只能是一行` };
  if (characters(value) > PARAM_LIMITS.keyValueCharacters)
    return {
      problem: `${item.label}最多 ${PARAM_LIMITS.keyValueCharacters} 个字`,
    };
  return { value };
}

/**
 * What `{ param: key }` must name (docs/judge-address-design.md §3): a
 * declared 地址参数. Its problem, or null.
 */
function addressParamProblem(list, key) {
  const target = list.find((item) => item.key === key);
  if (!target) return `没有参数 ${key}`;
  if (target.type !== "url") return `${key} 要是地址参数（type: "url"）`;
  return null;
}

/** The 地址参数 among the params (docs/judge-address-design.md). */
export const addressParams = (list) =>
  list.filter((item) => item.type === "url");

/** Whether `network` has `{ param: key }`. */
const inNetwork = (network, key) =>
  (network ?? []).some(
    (entry) => typeof entry !== "string" && entry.param === key,
  );

/**
 * Each `{ param }` in `network` an 地址参数 (docs/judge-address-design.md
 * §3): problems, one line each.
 */
export function networkParamProblems(list, network) {
  return (network ?? []).flatMap((entry, index) => {
    if (typeof entry?.param !== "string") return [];
    const problem = addressParamProblem(list, entry.param);
    return problem ? [`network 第 ${index + 1} 个：${problem}`] : [];
  });
}

/**
 * Each 密钥's `to` within one of `network`'s addresses (it goes out only
 * there) — or, an 地址参数, that one in `network` too: problems, one line
 * each, as the deploy and npm run check write them.
 */
export function keyNetworkProblems(list, network) {
  const fixed = fixedAddresses(network);
  return keyParams(list).flatMap((item) => {
    if (typeof item.to !== "string") {
      const named = `{ param: "${item.to.param}" }`;
      if (inNetwork(network, item.to.param)) return [];
      return [
        network?.length
          ? `params（${item.key}）的 to：network 里没有 ${named}`
          : `params（${item.key}）是密钥，要导出 network，并把 ${named} 写进去`,
      ];
    }
    if (allowedBy(fixed, item.to)) return [];
    return [
      network?.length
        ? `params（${item.key}）的 to：${item.to} 不在 network 里`
        : `params（${item.key}）是密钥，要导出 network，并把 ${item.to} 写进去`,
    ];
  });
}

/**
 * Reminders about 地址参数 (docs/judge-address-design.md §3), not
 * problems: one used nowhere. One asked needs no 密钥 to know its 红包:
 * the site's token goes with each request to it (§12).
 */
export function addressReminders(declarations, network) {
  const list = declarations.params;
  const page = declarations.meta?.page;
  return addressParams(list)
    .filter(
      (item) =>
        !inNetwork(network, item.key) &&
        !keyParams(list).some(
          (key) => typeof key.to !== "string" && key.to.param === item.key,
        ) &&
        !(typeof page === "object" && page?.param === item.key),
    )
    .map(
      (item) =>
        `地址参数 ${item.key} 没用上：判定器请求它会被拦下（附带网页从 hongbao.params 读它的，不用管这条）`,
    );
}

const KEY_LIKE = /api[_-]?key|apikey|token|secret|密钥|令牌|口令牌/i;

/**
 * Text params that look like a 密钥 in a 判定器 that goes online — the
 * code reads them, and they are shown: their keys, for a reminder to use
 * type "key" instead.
 */
export function keyLikeParams(list, network) {
  if (!network?.length) return [];
  return list
    .filter(
      (item) =>
        (item.type === "text" || item.type === "textarea") &&
        (KEY_LIKE.test(item.key) || KEY_LIKE.test(item.label)),
    )
    .map((item) => item.key);
}

/**
 * Where a 密钥 goes (docs/judge-address-design.md §2): its `to`, or the
 * 地址参数 it names as this 红包's params have it; null when not filled.
 */
export function keyTarget(item, params) {
  if (typeof item.to === "string") return item.to;
  const address = params?.[item.to.param];
  return typeof address === "string" && address !== "" ? address : null;
}

/**
 * The headers 密钥 add to a request to `address` (both gateways): those
 * whose `to` it is under, with a value given. `[name, value]` pairs.
 * `params`: the 红包's, for a `to` that is an 地址参数.
 */
export function keyHeaders(list, values, address, params) {
  return keyParams(list)
    .filter((item) => {
      const to = keyTarget(item, params);
      return (
        to !== null &&
        typeof values?.[item.key] === "string" &&
        values[item.key] !== "" &&
        allowedBy([to], address)
      );
    })
    .map((item) => [
      item.header ?? "Authorization",
      `${item.prefix ?? "Bearer "}${values[item.key]}`,
    ]);
}

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
    "pageAutoOpen",
    "title",
    "note",
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
  // 打开红包页时自动打开 (attached-page §2.7), suggested.
  if (
    value.pageAutoOpen !== undefined &&
    typeof value.pageAutoOpen !== "boolean"
  )
    add("hongbao.pageAutoOpen 要是 true 或 false");
  // The 红包's title and 说明 to start with (judge-square §4.1).
  if (value.title !== undefined)
    add(
      textProblem(value.title, HONGBAO_LIMITS.titleCharacters, "hongbao.title"),
    );
  if (value.note !== undefined)
    add(textProblem(value.note, HONGBAO_LIMITS.noteCharacters, "hongbao.note"));
  if (problems.length > 0) return { problems };
  return {
    rules: {
      ...value,
      ...(value.prompt !== undefined ? { prompt: value.prompt.trim() } : {}),
      ...(value.title !== undefined ? { title: value.title.trim() } : {}),
      ...(value.note !== undefined
        ? { note: value.note.replace(/\r\n?/g, "\n").trim() }
        : {}),
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

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Why `meta.page` is not a page a 红包 may carry (docs/judge-page-design.md
 * §4): the 附带网页's rules, as packages/contracts/src/page-url.ts has them
 * for the form and the API (a test holds the two together).
 */
export function pageProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "要是不空的字符串";
  const text = value.trim();
  if (characters(text) > META_LIMITS.page)
    return `最多 ${META_LIMITS.page} 个字`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return "不是有效的地址";
  }
  if (url.protocol !== "https:") return "只能用 https:// 开头的地址";
  if (url.username || url.password) return "不能带用户名和密码";
  if (url.port) return "不能带端口";
  const host = url.hostname;
  if (host.startsWith("[") || IPV4.test(host)) return "不能写 IP 地址";
  if (host === "localhost" || host.endsWith(".localhost"))
    return "不能写 localhost";
  if (!host.includes(".") || host.endsWith("."))
    return "要写完整的域名（比如 example.com）";
  if (host === "linux.do" || host.endsWith(".linux.do"))
    return "不能用 linux.do 和它的子域名";
  if (host === "hb.lafi.sh" || host.endsWith(".hb.lafi.sh"))
    return "不能用本站的地址";
  return null;
}

/**
 * `meta.page` as `{ param, path }` (docs/judge-address-design.md §3): the
 * 附带网页 under an 地址参数, `path` after it. Its problem, or null; that
 * `param` is an 地址参数 is checked with the params (readDeclarations).
 */
function pagePathProblem(page) {
  const extra = unknownField(page, ["param", "path"], "");
  if (extra) return `${extra}：只能写 param 和 path`;
  if (typeof page.param !== "string" || !KEY.test(page.param))
    return 'param 要写地址参数的 key，比如 { param: "server" }';
  if (page.path === undefined) return null;
  if (typeof page.path !== "string") return 'path 要是字符串，比如 "play/"';
  if (characters(page.path) > PARAM_LIMITS.pagePathCharacters)
    return `path 最多 ${PARAM_LIMITS.pagePathCharacters} 个字`;
  if (page.path.startsWith("/")) return "path 不以 / 开头，接在地址后面";
  if (/[?#\\\s]/.test(page.path)) return "path 不能带 ?、#、\\ 和空白";
  if (page.path.split("/").some((part) => part === "." || part === ".."))
    return "path 不能带 . 和 ..";
  return null;
}

/**
 * The 附带网页 a 判定器 carries for one 红包 (judge-page §4;
 * docs/judge-address-design.md §2): `meta.page`, or the 地址参数 it names
 * with `path` after it; null without one, or while that is not filled.
 * `local`: the kit's own http://localhost, taken as it is.
 */
export function pageOf(meta, values, { local = false } = {}) {
  const page = meta?.page;
  if (page === undefined || page === null) return null;
  if (typeof page === "string") return page;
  const address = values?.[page.param];
  if (typeof address !== "string" || address === "") return null;
  const joined = `${address}${page.path ?? ""}`;
  if (local && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(joined))
    return joined;
  return pageProblem(joined) ? null : new URL(joined).href;
}

/**
 * judge.js's `meta` export (§1): `{ meta }` (null when none) or `{ problems }`.
 * `page` (judge-page §4) is kept as the URL standard writes it back.
 */
export function readMeta(value) {
  if (value === undefined || value === null) return { meta: null };
  if (!isObject(value))
    return { problems: ["meta 要是 { name, description, page }"] };
  const extra = unknownField(value, ["name", "description", "page"], "meta 里");
  if (extra)
    return { problems: [`${extra}：只能写 name、description 和 page`] };
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
  if (value.page !== undefined) {
    const page = isObject(value.page)
      ? pagePathProblem(value.page)
      : pageProblem(value.page);
    if (page) problems.push(`meta.page：${page}`);
  }
  if (problems.length > 0) return { problems };
  return {
    meta: {
      name: value.name.trim(),
      ...(value.description !== undefined
        ? { description: value.description.trim() }
        : {}),
      ...(value.page === undefined
        ? {}
        : isObject(value.page)
          ? {
              page: {
                param: value.page.param,
                ...(value.page.path ? { path: value.page.path } : {}),
              },
            }
          : { page: new URL(value.page.trim()).href }),
    },
  };
}

/**
 * “范围（整数，1–100，默认 100）”: one line of npm run check's preview.
 * `params` and `network`, for what an 地址参数 is used for and where a 密钥
 * to one goes.
 */
export function paramLine(item, { params = [], network = null } = {}) {
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
  if (item.type === "key")
    parts.push(
      "发红包的人自己填",
      "不公开",
      typeof item.to === "string"
        ? `只发给 ${item.to}`
        : `只发给${params.find((other) => other.key === item.to.param)?.label ?? item.to.param}`,
    );
  if (item.type === "url") {
    parts.push("发红包的人自己填");
    if (inNetwork(network, item.key)) parts.push("判定器会请求它");
  }
  if (item.required === false && item.type !== "switch") parts.push("选填");
  if (revealsAtEnd(item)) parts.push("结束后公开");
  return `${item.label}（${parts.join("，")}）`;
}

/**
 * What main.mjs answered to { describe: true }, beside `network` (read by
 * readNetwork): `meta`, `params`, `hongbao`, `check` and, from protocol 4,
 * `setup`, each by its rules — `{ meta, params, hongbao, check, setup,
 * problems }`, problems one line each. An answer from an earlier protocol
 * has none of them.
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
  if (typeof meta?.page === "object" && !unreadable.has("params")) {
    const problem = addressParamProblem(params, meta.page.param);
    if (problem) problems.push(`meta.page：${problem}`);
  }
  const hongbao = read("hongbao", readHongbaoRules)?.rules ?? null;
  if (answer?.check === false) problems.push("check 要是一个函数");
  if (answer?.setup === false) problems.push("setup 要是一个函数");
  return {
    meta,
    params,
    hongbao,
    check: answer?.check === true,
    setup: answer?.setup === true,
    problems,
  };
}

/** Every string in a value, however deep (written without recursion). */
function textsOf(value) {
  const found = [];
  const todo = [value];
  while (todo.length > 0) {
    const item = todo.pop();
    if (typeof item === "string") found.push(item);
    else if (item !== null && typeof item === "object")
      todo.push(...(Array.isArray(item) ? item : Object.values(item)));
  }
  return found;
}

/**
 * The params shown only at the end (§3 结束后公开) whose value shows in a view (judge-page
 * §2): a text of two characters or more found in its summary or any text
 * in its data. Numbers are left out: a guess shown is not a leak.
 */
export function secretsInView(list, values, view) {
  if (view === null || view === undefined) return [];
  const shown = textsOf(view);
  return list
    .filter((item) => revealsAtEnd(item) && Object.hasOwn(values, item.key))
    .filter((item) =>
      textsOf(values[item.key])
        .map((text) => text.trim())
        .some(
          (text) =>
            [...text].length >= 2 && shown.some((line) => line.includes(text)),
        ),
    )
    .map((item) => item.key);
}

/** JSON with every object's keys sorted: what a commitment is taken over. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * A 红包's params at opening (§3): those everyone sees from then on, and
 * the secret ones, kept back until it is over.
 */
export function splitParams(list, values) {
  const shown = {};
  const secret = {};
  for (const item of list)
    if (Object.hasOwn(values, item.key))
      (revealsAtEnd(item) ? secret : shown)[item.key] = values[item.key];
  return { shown, secret };
}

/**
 * 参数封存值 (§3 结束后公开): SHA-256 of those params as JSON with sorted
 * keys, a newline and the salt, in hex — published at opening, checked by
 * anyone once the params and the salt are out.
 */
export function paramsCommitment(secret, salt) {
  return sha256Text(`${sortedJson(secret)}\n${salt}`);
}
