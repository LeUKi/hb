// What the platform makes of judge()'s answer (协议第 4.2 节). The site runs
// this after every judgment and the kit runs it in tests, so both read an
// answer alike.
import { settle } from "./money.mjs";

export const LIMITS = Object.freeze({
  codeBytes: 64 * 1024,
  stateBytes: 16 * 1024,
  messageCharacters: 100,
  inputCharacters: 200,
  promptCharacters: 40,
  tests: 200,
});

const KNOWN = new Set(["ok", "amount", "message", "state"]);
const encoder = new TextEncoder();

/**
 * judge()'s answer, read. `{ error }` when it does not follow the protocol;
 * otherwise `ok`, the `paid` amount (pulled into the share's range) with a
 * `note` saying why it differs from `asked` ("floor" 每份至少, "cap" 封顶 or
 * "last"), the `message`, and `state`: `{ keep: true }` or
 * `{ keep: false, value }`. `unknown` lists fields the protocol does not
 * have, for a warning.
 */
export function readVerdict(raw, share) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return invalid("返回的要是一个对象，比如 { ok: false }");
  if (typeof raw.ok !== "boolean") return invalid("ok 要是 true 或 false");
  const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key));
  let message;
  if (raw.message !== undefined) {
    if (typeof raw.message !== "string") return invalid("message 要是字符串");
    message = raw.message.replace(/\s+/g, " ").trim();
    if ([...message].length > LIMITS.messageCharacters)
      return invalid(`message 超过 ${LIMITS.messageCharacters} 个字`);
    if (message === "") message = undefined;
  }
  let state = { keep: true };
  if (raw.state !== undefined) {
    let text;
    try {
      text = JSON.stringify(raw.state);
    } catch {
      return invalid("state 转不成 JSON");
    }
    if (text === undefined) return invalid("state 转不成 JSON");
    if (encoder.encode(text).length > LIMITS.stateBytes)
      return invalid(`state 超过 ${LIMITS.stateBytes / 1024} KB`);
    state = { keep: false, value: JSON.parse(text) };
  }
  if (!raw.ok) return { ok: false, message, state, unknown };
  if (!Number.isSafeInteger(raw.amount))
    return invalid("ok 为 true 时 amount 要是整数，单位是分");
  const paid = settle(raw.amount, share);
  let note = null;
  if (paid !== raw.amount)
    note = share.last ? "last" : paid > raw.amount ? "floor" : "cap";
  return { ok: true, asked: raw.amount, paid, note, message, state, unknown };
}

function invalid(detail) {
  return { error: { kind: "invalid", detail } };
}
