// How the commands say things: amounts, failures, console output.
import { formatAmount } from "../../runtime/index.mjs";
import { SLOW_MS } from "./sandbox.mjs";

/** 2000 → "20.00", as the site shows amounts. */
export const yuan = (amount) => formatAmount(amount);

/** Why a share was pulled into its range (the site's 我的提交 says the same). */
export const NOTE_WORDS = {
  cap: "按上限发",
  floor: "按每份至少发",
  last: "最后一份，发完剩下的",
};

const FAILURE_WORDS = {
  load: "代码加载不了",
  threw: "代码抛错",
  invalid: "返回不对",
  timeout: "超时",
  memory: "内存超了",
  unavailable: "本地的沙箱停了",
};

/** A sandbox failure in words: "代码抛错：TypeError: …". */
export function failureText(kind, detail) {
  // no-judge's detail already says it all.
  if (kind === "no-judge") return detail;
  return `${FAILURE_WORDS[kind] ?? "出错"}：${detail}`;
}

/** Code that does not load fails every judgment alike: stop at the first. */
export const unloadable = (failure) =>
  failure === "load" || failure === "no-judge";

export const isSlow = (ms) => ms > SLOW_MS;

export const SLOW_NOTE = `标“慢”的判定超过 ${SLOW_MS} 毫秒：线上每次判定只有 ${SLOW_MS} 毫秒 CPU，可能超时`;

/**
 * judge.js's top level, when it is slow: the site imports judge.js inside
 * a sandbox's first judgment (runtime/main.mjs), so its time counts there.
 */
export const slowLoadNote = (ms) =>
  ms !== null && isSlow(ms)
    ? `提醒：judge.js 顶层的代码跑了 ${ms} 毫秒，超过 ${SLOW_MS} 毫秒：线上算在每个沙箱的第一次判定里，可能超时`
    : null;

/** Short JSON for a line: long values are cut, with "…". */
export function shortJson(value, max = 1000) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A line that may run on (an error message, say): what follows is indented. */
export function say(print, text, indent = "  ") {
  const [first, ...rest] = text.split("\n");
  print(first);
  for (const line of rest) print(`${indent}${line}`);
}

/** console output, indented under the line it belongs to. */
export function printLogs(print, logs, indent = "  ") {
  for (const line of logs ?? [])
    for (const part of line.split("\n")) print(`${indent}${part}`);
}
