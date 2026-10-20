import { useClockCycle } from "../../lib/clock-cycle";
import { useReducedMotionPref } from "../../lib/motion";
import type { SchemeKind } from "../../lib/scheme";
import { RollingWord } from "../ui/morph-label";

/**
 * What an empty box takes and what it does with it, one at a time, with
 * the protocol chip's icon (02 §6). 命令 stays in the sentence's tail.
 */
const idleHints = [
  { kind: "password", word: "口令", purpose: "领取红包" },
  { kind: "link", word: "红包链接", purpose: "打开红包" },
  {
    kind: "topic",
    word: "帖子链接",
    purpose: "查看帖子里的红包",
    short: "查看红包",
  },
] satisfies {
  kind: SchemeKind;
  word: string;
  purpose: string;
  short?: string;
}[];

export type IdleHint = (typeof idleHints)[number];

/** Each hint stays this long, the same for every window (by the clock). */
const HINT_PERIOD = 2000;

/**
 * The hint to show now while the box is empty and free (`active`), or null
 * when it stays still: typing, scoped, or the system asking for less motion.
 */
export function useIdleHint(active: boolean): IdleHint | null {
  const reduced = useReducedMotionPref();
  const running = active && !reduced;
  const index = useClockCycle(idleHints.length, HINT_PERIOD, running);
  return running ? (idleHints[index] ?? null) : null;
}

/** The placeholder sentence; only what changes rolls (口令领取红包 → 红包链接打开红包). */
export function IdleHintText({
  hint,
  compact,
}: {
  hint: IdleHint;
  compact: boolean;
}) {
  const purpose = (compact && hint.short) || hint.purpose;
  return (
    <>
      输入
      <RollingWord text={hint.word} />
      <RollingWord text={purpose} />
      {compact ? "或 / 命令" : "，或输入 / 使用命令"}
    </>
  );
}
