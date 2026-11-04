import type { MyStanding } from "@hb/contracts";
import { useEffect, useRef, useState } from "react";
import { haptic } from "../../lib/haptics";
import {
  endHint,
  type HongbaoActivity,
  type Mine,
  type PublicView,
} from "../../lib/hongbao";
import { openingLabel } from "../../lib/roster-time";
import { sealGlyphs } from "../../lib/seal";
import type { useDrawStep } from "./clock";

// What the seal says and shows and the line under it, worked out from the
// 红包 and the viewer's part in it: the page's useHongbao and the forum's
// mini app (docs/mini-app-design.md §7) the same, each with its own way to
// claim.

/**
 * closed: can be opened. ended: over before the viewer took part.
 * open: the viewer claimed or signed up, so the cover can turn small.
 */
export type HongbaoPhase = "closed" | "ended" | "open";

export type DrawStep = ReturnType<typeof useDrawStep>;

export function sealOf({
  activity,
  view,
  mine,
  standing,
  author,
  spinning,
  gate,
  retry,
  cooling,
  drawStep,
  queue = null,
  waiting = false,
}: {
  activity: HongbaoActivity;
  view: PublicView;
  mine: Mine | null;
  standing: MyStanding | null;
  /** The viewer sent it: they see every 口令 and cannot take part. */
  author: boolean;
  /** A claim or sign-up of theirs is on its way. */
  spinning: boolean;
  /** Signed out: the seal signs in first. */
  gate: "login" | null;
  /** A claim whose answer was lost: the seal sends it again. */
  retry: boolean;
  /** 冷却 after an attempt (a 红包 without 口令 waits it out on the seal). */
  cooling: boolean;
  drawStep: DrawStep;
  /**
   * 排队 (docs/claim-capacity-design.md §3 第 1 期): how many are before
   * their direct or 口令 claim, and about how many seconds, as pushed.
   */
  queue?: { ahead: number; seconds?: number } | null;
  /** Their claim waits for its share, known from a reloaded page. */
  waiting?: boolean;
}) {
  const phase: HongbaoPhase = mine ? "open" : view.ended ? "ended" : "closed";
  const isDraw = activity.mode === "timed_draw";
  // The sender sees their own 红包 as it is, and may take part too (自领,
  // asked first: docs/self-claim-design.md); a draft is a preview, nobody
  // can yet. Anyone else with its link sees it 未开放: its 开 there, faded.
  const draft = activity.draft;
  const preview = draft && author;
  const seal = sealGlyphs;
  // 开奖中 is the draw's last step, not its end: the cover stays red and
  // its seal turns until the result comes (开奖证明, 05 §7).
  const drawing = view.endReason === "settling";
  const glyph = drawing
    ? seal.drawing
    : phase === "ended"
      ? seal.ended
      : preview
        ? seal.draft
        : isDraw
          ? seal.draw
          : seal.open;
  const verb = isDraw ? "报名" : "领取";
  const cooldown =
    activity.participation === "direct" && !gate && cooling && !retry;
  // 代码判定: its code failed five times running, claims wait (05 §13).
  const code = activity.participation === "code";
  const paused = code && activity.judge?.paused === true;
  // Protocol 5: settled with nothing (no claim), they are done here.
  const settledEmpty = Boolean(standing?.settled) && !mine;
  const sealState = drawing
    ? "pending"
    : phase === "ended"
      ? "muted"
      : spinning
        ? "pending"
        : cooldown || draft || paused || settledEmpty
          ? "disabled"
          : "idle";
  const hint =
    phase === "ended"
      ? (drawStep?.hint ?? endHint(view))
      : draft
        ? preview
          ? `草稿预览，开放后才能${verb}`
          : activity.scheduledOpenAt !== undefined
            ? `${openingLabel(activity.scheduledOpenAt)} 开放`
            : `还没开放，开放后才能${verb}`
        : paused
          ? "判定器连续出错，暂停领取"
          : settledEmpty
            ? "已经结算了，没有领到"
            : spinning
              ? code
                ? "正在判定…"
                : queue && queue.ahead > 0
                  ? `排队中，前面还有 ${queue.ahead} 人${
                      queue.seconds ? `，大约 ${queue.seconds} 秒` : ""
                    }`
                  : waiting
                    ? "领取中，马上就好"
                    : "正在确认…"
              : gate === "login"
                ? `登录后${verb}`
                : retry
                  ? `点「${glyph}」重试原提交`
                  : code && standing
                    ? `点「${glyph}」接着玩`
                    : code
                      ? `点「${glyph}」，输入后提交，由判定器判定`
                      : activity.participation === "password"
                        ? `点「${glyph}」，输入口令${verb}`
                        : `点「${glyph}」${verb}`;
  const sealLabel =
    phase === "ended" || draft || paused || settledEmpty
      ? hint
      : gate === "login"
        ? "登录"
        : retry
          ? "重试原提交"
          : code
            ? "输入后提交"
            : activity.participation === "password"
              ? `输入口令${verb}`
              : isDraw
                ? "报名"
                : "领取红包";
  const announcement = !mine
    ? ""
    : mine.kind === "claimed"
      ? `已领取 ${mine.amount} LDC${activity.fish ? "，存进了🐟额" : ""}。`
      : mine.outcome === "won"
        ? `已中奖，${mine.amount} LDC${activity.fish ? "，存进了🐟额" : ""}。`
        : mine.outcome === "lost"
          ? "本次未中奖。"
          : "已报名，等待开奖。";
  return {
    phase,
    isDraw,
    draft,
    drawing,
    glyph,
    cooldown,
    code,
    paused,
    settledEmpty,
    sealState,
    hint,
    sealLabel,
    announcement,
  } as const;
}

/**
 * A draw result arriving while the page is open plays its own reveal (and
 * is felt); someone in the draw feels each step it takes while they watch.
 */
export function useDrawMoments(mine: Mine | null, drawStep: DrawStep) {
  const outcome = mine?.kind === "registered" ? mine.outcome : null;
  const previousOutcome = useRef(outcome);
  const [revealed, setRevealed] = useState<{
    outcome: typeof outcome;
    at: number;
  } | null>(null);
  useEffect(() => {
    const before = previousOutcome.current;
    previousOutcome.current = outcome;
    if (
      (before === "waiting" || before === "settling") &&
      (outcome === "won" || outcome === "lost")
    ) {
      setRevealed({ outcome, at: Date.now() });
      // Felt as the result shows (it plays 0.2 s in).
      window.setTimeout(
        () => haptic(outcome === "won" ? "success" : "warning"),
        200,
      );
    }
  }, [outcome]);
  // 震动反馈: someone in this draw, watching, feels each step it takes
  // (not the step it was at when the page opened).
  const beat = drawStep?.beat ?? null;
  const lastBeat = useRef(beat);
  const inDraw = mine?.kind === "registered";
  useEffect(() => {
    if (beat === lastBeat.current) return;
    lastBeat.current = beat;
    if (beat && inDraw) haptic("selection");
  }, [beat, inDraw]);
  return revealed !== null && revealed.outcome === outcome;
}
