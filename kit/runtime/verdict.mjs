// What the platform makes of judge()'s answer (协议第 4.2 节). The site runs
// this after every judgment and the kit runs it in tests, so both read an
// answer alike; the sandbox's entry (main.mjs) holds state to the same depth.
// From protocol 4 (docs/judge-page-design.md §2) an answer may also carry
// `view` (what everyone sees), `announce` (a line in 动态) and `end`; and
// setup()'s answer, at opening, its first `state` and `view`. From
// protocol 5 (docs/multi-prize-design.md §3) a judgment adds to or takes
// from each person's pending and settles them: `add`, `settle`, the
// person's own `player: { state, view }` and `others` at the same table;
// `{ ok, amount }` is short for an add settled at once.
import { settle } from "./money.mjs";

export const LIMITS = Object.freeze({
  codeBytes: 256 * 1024,
  stateBytes: 64 * 1024,
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
  /** player.state, each person's own (protocol 5). */
  playerStateBytes: 4 * 1024,
  /** player.view.data, for that person's 附带网页 (protocol 5). */
  playerViewBytes: 4 * 1024,
  /** People one judgment writes to besides the one judged (protocol 5). */
  others: 10,
  inputCharacters: 200,
  promptCharacters: 40,
  tests: 200,
});

/** The protocol whose answers have view, announce and end. */
export const VIEW_PROTOCOL = 4;
/** The protocol where each person has pending, settled once (multi-prize). */
export const LEDGER_PROTOCOL = 5;
const KNOWN = new Set(["ok", "amount", "message", "state"]);
const KNOWN_V4 = new Set([...KNOWN, "view", "announce", "end"]);
const KNOWN_V5 = new Set([...KNOWN_V4, "add", "settle", "player", "others"]);
const OTHER_KEYS = ["id", "add", "settle", "state", "view", "message"];
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
function readState(raw, name = "state", bytes = LIMITS.stateBytes) {
  if (raw === undefined) return { keep: true };
  const read = json(raw, name, bytes);
  return "error" in read ? read : { keep: false, value: read.value };
}

/**
 * `view` as answered (protocol 4): `{ keep: true }`, `{ keep: false, value }`
 * — `value` null clears it, else `{ summary?, data? }` — or `{ error }`.
 * Protocol 5's own views are read the same, named and sized as theirs.
 */
function readView(raw, name = "view", bytes = LIMITS.viewBytes) {
  if (raw === undefined) return { keep: true };
  if (raw === null) return { keep: false, value: null };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { error: `${name} 要是一个对象，比如 { summary, data }，或者 null` };
  const extra = Object.keys(raw).filter(
    (key) => key !== "summary" && key !== "data",
  );
  if (extra.length > 0)
    return {
      error: `${name} 只能有 summary 和 data，多了 ${extra.join("、")}`,
    };
  const value = {};
  if (raw.summary !== undefined) {
    const summary = line(
      raw.summary,
      `${name}.summary`,
      LIMITS.summaryCharacters,
    );
    if ("error" in summary) return summary;
    if (summary.value !== undefined) value.summary = summary.value;
  }
  if (raw.data !== undefined) {
    const data = json(raw.data, `${name}.data`, bytes);
    if ("error" in data) return data;
    value.data = data.value;
  }
  return { keep: false, value };
}

/** An add (protocol 5): whole 分, either way; none is 0. */
function readAdd(raw, name) {
  if (raw === undefined) return { value: 0 };
  if (!Number.isSafeInteger(raw))
    return { error: `${name} 要是整数，单位是分，可以是负数` };
  return { value: raw };
}

function readSettle(raw, name) {
  if (raw === undefined) return { value: false };
  if (typeof raw !== "boolean") return { error: `${name} 要是 true 或 false` };
  return { value: raw };
}

/**
 * A person's own state and view as answered (protocol 5): each
 * `{ keep: true }` or `{ keep: false, value }`, or `{ error }`. `where`
 * comes before their names ("player.", "others 第 1 项的 ").
 */
function readOwn(raw, where) {
  const state = readState(raw.state, `${where}state`, LIMITS.playerStateBytes);
  if ("error" in state) return state;
  const view = readView(raw.view, `${where}view`, LIMITS.playerViewBytes);
  if ("error" in view) return view;
  return { state, view };
}

/**
 * A person's own state and view as a test writes them before it starts
 * (protocol 5): what is wrong, in words, or null. `where` as readOwn's.
 */
export function ownProblem(raw, where) {
  const read = readOwn(raw, where);
  return "error" in read ? read.error : null;
}

/** `player` as answered (protocol 5): `{ state, view }` or `{ error }`. */
function readPlayer(raw) {
  if (raw === undefined) return { state: { keep: true }, view: { keep: true } };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { error: "player 要是一个对象，比如 { state, view }" };
  const extra = Object.keys(raw).filter(
    (key) => key !== "state" && key !== "view",
  );
  if (extra.length > 0)
    return { error: `player 只能有 state 和 view，多了 ${extra.join("、")}` };
  return readOwn(raw, "player.");
}

/**
 * `others` as answered (protocol 5, §3.3): each `{ id, add, settle, state,
 * view, message }`, or `{ error }`. Whether each may be named is the
 * ledger's to say (ledger.mjs othersProblem): this reads the shape.
 */
function readOthers(raw) {
  if (raw === undefined) return { value: [] };
  if (!Array.isArray(raw))
    return { error: "others 要是一个数组，每一项是一个人，比如 [{ id, add }]" };
  if (raw.length > LIMITS.others)
    return { error: `others 最多 ${LIMITS.others} 个人` };
  const seen = new Set();
  const value = [];
  for (const [index, item] of raw.entries()) {
    const where = `others 第 ${index + 1} 项`;
    if (item === null || typeof item !== "object" || Array.isArray(item))
      return { error: `${where}要是一个对象，比如 { id, add }` };
    const extra = Object.keys(item).filter((key) => !OTHER_KEYS.includes(key));
    if (extra.length > 0)
      return {
        error: `${where}只能有 ${OTHER_KEYS.join("、")}，多了 ${extra.join("、")}`,
      };
    if (!Number.isSafeInteger(item.id) || item.id < 1)
      return {
        error: `${where}的 id 要是 LINUX DO 数字 ID（同 submission.user.id）`,
      };
    if (seen.has(item.id)) return { error: `others 里 ${item.id} 写了两次` };
    seen.add(item.id);
    const add = readAdd(item.add, `${where}的 add`);
    if ("error" in add) return add;
    const settled = readSettle(item.settle, `${where}的 settle`);
    if ("error" in settled) return settled;
    const own = readOwn(item, `${where}的 `);
    if ("error" in own) return own;
    let message;
    if (item.message !== undefined) {
      const read = line(
        item.message,
        `${where}的 message`,
        LIMITS.messageCharacters,
      );
      if ("error" in read) return read;
      message = read.value;
    }
    value.push({
      id: item.id,
      add: add.value,
      settle: settled.value,
      ...own,
      message,
    });
  }
  return { value };
}

/**
 * judge()'s answer, read. `{ error }` when it does not follow the protocol;
 * otherwise `ok`, the `paid` amount (pulled into the share's range) with a
 * `note` saying why it differs from `asked` ("floor" 每份至少, "cap" 封顶 or
 * "last"), the `message`, and `state`: `{ keep: true }` or
 * `{ keep: false, value }`. From protocol 4 also `view` (as state), the
 * `announce` line and `end`. `unknown` lists fields the protocol does not
 * have, for a warning. From protocol 5 there is no share: see readLedger.
 */
export function readVerdict(raw, share, protocol = LEDGER_PROTOCOL) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return invalid(
      protocol >= LEDGER_PROTOCOL
        ? "返回的要是一个对象，比如 { add: 50 } 或 {}"
        : "返回的要是一个对象，比如 { ok: false }",
    );
  if (protocol >= LEDGER_PROTOCOL) return readLedger(raw);
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
 * Protocol 5's answer (docs/multi-prize-design.md §3.2): `add` (0 when not
 * written) and `settle` for the one judged, their own `player` state and
 * view, `others` as written (each read as the one judged's are), and the
 * rest as protocol 4's. `{ ok: true, amount }` is read as `{ add: amount,
 * settle: true }` and `{ ok: false }` as nothing added (`shorthand`); `ok`
 * beside `add` or `settle` is an error. How much each add moves is the
 * ledger's to work out (ledger.mjs).
 */
function readLedger(raw) {
  const unknown = Object.keys(raw).filter((key) => !KNOWN_V5.has(key));
  const shorthand = raw.ok !== undefined;
  let add;
  let settled;
  if (shorthand) {
    if (typeof raw.ok !== "boolean") return invalid("ok 要是 true 或 false");
    const both = ["add", "settle"].filter((key) => raw[key] !== undefined);
    if (both.length > 0)
      return invalid(
        `ok 和 ${both.join("、")} 不能一起写：{ ok: true, amount } 是 { add: amount, settle: true } 的简写`,
      );
    if (raw.ok && !Number.isSafeInteger(raw.amount))
      return invalid("ok 为 true 时 amount 要是整数，单位是分");
    add = raw.ok ? raw.amount : 0;
    settled = raw.ok;
  } else {
    if (raw.amount !== undefined)
      return invalid("amount 只和 ok: true 一起写；给这个人加钱写 add");
    const read = readAdd(raw.add, "add");
    if ("error" in read) return invalid(read.error);
    add = read.value;
    const settling = readSettle(raw.settle, "settle");
    if ("error" in settling) return invalid(settling.error);
    settled = settling.value;
  }
  let message;
  if (raw.message !== undefined) {
    const read = line(raw.message, "message", LIMITS.messageCharacters);
    if ("error" in read) return invalid(read.error);
    message = read.value;
  }
  const state = readState(raw.state);
  if ("error" in state) return invalid(state.error);
  const view = readView(raw.view);
  if ("error" in view) return invalid(view.error);
  let announce;
  if (raw.announce !== undefined) {
    const read = line(raw.announce, "announce", LIMITS.announceCharacters);
    if ("error" in read) return invalid(read.error);
    announce = read.value;
  }
  let end = false;
  if (raw.end !== undefined) {
    if (typeof raw.end !== "boolean") return invalid("end 要是 true 或 false");
    end = raw.end;
  }
  const player = readPlayer(raw.player);
  if ("error" in player) return invalid(player.error);
  const others = readOthers(raw.others);
  if ("error" in others) return invalid(others.error);
  return {
    add,
    settle: settled,
    shorthand,
    player,
    others: others.value,
    message,
    state,
    view,
    announce,
    end,
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
