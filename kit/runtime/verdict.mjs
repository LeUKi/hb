// What the platform makes of judge()'s answer (协议第 4.2 节). The site runs
// this after every judgment and the kit runs it in tests, so both read an
// answer alike; the sandbox's entry (main.mjs) holds state to the same depth.
// From protocol 4 (docs/judge-page-design.md §2) an answer may also carry
// `view` (what everyone sees), `announce` (a line in 动态) and `end`; and
// setup()'s answer, at opening, its first `state` and `view`.
import { settle } from "./money.mjs";

export const LIMITS = Object.freeze({
  codeBytes: 64 * 1024,
  stateBytes: 16 * 1024,
  /**
   * How deep state may nest. JSON.stringify recurses, and how deep it gets
   * depends on the machine's stack: past this, every machine refuses it.
   */
  stateDepth: 100,
  messageCharacters: 100,
  /** view.summary, said by the site itself (protocol 4). */
  summaryCharacters: 200,
  /** view.data, for the 附带网页 (protocol 4). */
  viewBytes: 16 * 1024,
  /** One line in 动态 (protocol 4). */
  announceCharacters: 100,
  inputCharacters: 200,
  promptCharacters: 40,
  tests: 200,
});

/** The protocol whose answers have view, announce and end. */
export const VIEW_PROTOCOL = 4;
const KNOWN = new Set(["ok", "amount", "message", "state"]);
const KNOWN_V4 = new Set([...KNOWN, "view", "announce", "end"]);
const encoder = new TextEncoder();

/**
 * Whether a value nests arrays and objects more than `limit` deep (a bare
 * value is 0 deep, `[]` and `{}` 1), found without recursion; a value that
 * refers to itself is too deep.
 */
export function nestsDeeper(value, limit) {
  const stack = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop();
    if (item === null || typeof item !== "object") continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item))
      stack.push([child, depth + 1]);
  }
  return false;
}

/** One line of text: whitespace runs made one space, ends trimmed, "" none. */
function line(raw, name, limit) {
  if (typeof raw !== "string") return { error: `${name} 要是字符串` };
  const text = raw.replace(/\s+/g, " ").trim();
  if ([...text].length > limit) return { error: `${name} 超过 ${limit} 个字` };
  return { value: text === "" ? undefined : text };
}

/** A JSON value within `bytes` and the depth state has: `{ value }` or `{ error }`. */
function json(raw, name, bytes) {
  if (nestsDeeper(raw, LIMITS.stateDepth))
    return { error: `${name} 嵌套超过 ${LIMITS.stateDepth} 层` };
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    return { error: `${name} 转不成 JSON` };
  }
  if (text === undefined) return { error: `${name} 转不成 JSON` };
  if (encoder.encode(text).length > bytes)
    return { error: `${name} 超过 ${bytes / 1024} KB` };
  return { value: JSON.parse(text) };
}

/** `state` as answered: `{ keep: true }`, `{ keep: false, value }` or `{ error }`. */
function readState(raw) {
  if (raw === undefined) return { keep: true };
  const read = json(raw, "state", LIMITS.stateBytes);
  return "error" in read ? read : { keep: false, value: read.value };
}

/**
 * `view` as answered (protocol 4): `{ keep: true }`, `{ keep: false, value }`
 * — `value` null clears it, else `{ summary?, data? }` — or `{ error }`.
 */
function readView(raw) {
  if (raw === undefined) return { keep: true };
  if (raw === null) return { keep: false, value: null };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { error: "view 要是一个对象，比如 { summary, data }，或者 null" };
  const extra = Object.keys(raw).filter(
    (key) => key !== "summary" && key !== "data",
  );
  if (extra.length > 0)
    return { error: `view 只能有 summary 和 data，多了 ${extra.join("、")}` };
  const value = {};
  if (raw.summary !== undefined) {
    const summary = line(raw.summary, "view.summary", LIMITS.summaryCharacters);
    if ("error" in summary) return summary;
    if (summary.value !== undefined) value.summary = summary.value;
  }
  if (raw.data !== undefined) {
    const data = json(raw.data, "view.data", LIMITS.viewBytes);
    if ("error" in data) return data;
    value.data = data.value;
  }
  return { keep: false, value };
}

/**
 * judge()'s answer, read. `{ error }` when it does not follow the protocol;
 * otherwise `ok`, the `paid` amount (pulled into the share's range) with a
 * `note` saying why it differs from `asked` ("floor" 每份至少, "cap" 封顶 or
 * "last"), the `message`, and `state`: `{ keep: true }` or
 * `{ keep: false, value }`. From protocol 4 also `view` (as state), the
 * `announce` line and `end`. `unknown` lists fields the protocol does not
 * have, for a warning.
 */
export function readVerdict(raw, share, protocol = VIEW_PROTOCOL) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return invalid("返回的要是一个对象，比如 { ok: false }");
  if (typeof raw.ok !== "boolean") return invalid("ok 要是 true 或 false");
  const v4 = protocol >= VIEW_PROTOCOL;
  const known = v4 ? KNOWN_V4 : KNOWN;
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  let message;
  if (raw.message !== undefined) {
    const read = line(raw.message, "message", LIMITS.messageCharacters);
    if ("error" in read) return invalid(read.error);
    message = read.value;
  }
  const state = readState(raw.state);
  if ("error" in state) return invalid(state.error);
  let view = { keep: true };
  let announce;
  let end = false;
  if (v4) {
    view = readView(raw.view);
    if ("error" in view) return invalid(view.error);
    if (raw.announce !== undefined) {
      const read = line(raw.announce, "announce", LIMITS.announceCharacters);
      if ("error" in read) return invalid(read.error);
      announce = read.value;
    }
    if (raw.end !== undefined) {
      if (typeof raw.end !== "boolean")
        return invalid("end 要是 true 或 false");
      end = raw.end;
    }
  }
  const more = v4 ? { view, announce, end } : {};
  if (!raw.ok) return { ok: false, message, state, ...more, unknown };
  if (!Number.isSafeInteger(raw.amount))
    return invalid("ok 为 true 时 amount 要是整数，单位是分");
  const paid = settle(raw.amount, share);
  let note = null;
  if (paid !== raw.amount)
    note = share.last ? "last" : paid > raw.amount ? "floor" : "cap";
  return {
    ok: true,
    asked: raw.amount,
    paid,
    note,
    message,
    state,
    ...more,
    unknown,
  };
}

/**
 * setup()'s answer at opening (protocol 4): `{ state, view }` as a verdict's
 * (`{ keep: true }` for what it leaves out), or `{ error }`. No setup, or
 * one answering nothing: both kept, so state starts null and view empty.
 */
export function readSetup(raw) {
  if (raw === undefined || raw === null)
    return { state: { keep: true }, view: { keep: true }, unknown: [] };
  if (typeof raw !== "object" || Array.isArray(raw))
    return invalid("setup 返回的要是一个对象，比如 { state, view }");
  const unknown = Object.keys(raw).filter(
    (key) => key !== "state" && key !== "view",
  );
  const state = readState(raw.state);
  if ("error" in state) return invalid(`setup 的 ${state.error}`);
  const view = readView(raw.view);
  if ("error" in view) return invalid(`setup 的 ${view.error}`);
  return { state, view, unknown };
}

function invalid(detail) {
  return { error: { kind: "invalid", detail } };
}
