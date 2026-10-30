import type { MyStanding } from "@hb/contracts";
import { publicScopeAllows } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { scopeNoticeAtom } from "../../lib/claim-scope";
import { haptic } from "../../lib/haptics";
import {
  endHint,
  type HongbaoActivity,
  type Mine,
  type PasswordView,
  type PublicView,
  type Roster,
} from "../../lib/hongbao";
import { useReducedMotionPref } from "../../lib/motion";
import { switchOverlay } from "../../lib/overlay";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";
import { openingLabel } from "../../lib/roster-time";
import { sealGlyphs } from "../../lib/seal";
import { useSessionUser } from "../../lib/session";
import { loadTurnstile } from "../../lib/turnstile";
import {
  messageAtom,
  pendingAtom,
  scopeAtom,
  unconfirmedAtom,
  useOmniboxMode,
} from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { roundText } from "./draw-proof";

/**
 * closed: can be opened. ended: over before the viewer took part.
 * open: the viewer claimed or signed up, so the cover can turn small.
 */
export type HongbaoPhase = "closed" | "ended" | "open";

/** Everything a 红包 page draws, by data tier (lib/hongbao.ts). */
export type HongbaoData = {
  activity: HongbaoActivity;
  view: PublicView;
  roster: Roster;
  passwords: PasswordView;
  mine: Mine | null;
  /**
   * 代码判定, protocol 5 (docs/multi-prize-design.md §4.1): their own part
   * once judged — 待结算, settled or not, what only they see.
   */
  standing?: MyStanding | null;
  /** The viewer sent it: they see every 口令 and cannot take part. */
  author: boolean;
};

/** The time, every `interval` ms; null: not ticking. */
export function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (interval === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/**
 * A v2 draw between closing and its result, step by step (开奖证明, docs/
 * draw-proof-design.md §5): the roster frozen, the drand round counted
 * down by its own time, the round fetched. `hint` goes under the seal,
 * `note` on the ticket of whoever signed up. Null otherwise.
 */
export function useDrawStep(view: PublicView) {
  const proof = view.drawProof;
  const frozen =
    view.draw?.state === "settling" &&
    proof?.kind === "draw" &&
    proof.rosterHash
      ? proof
      : null;
  const counting = frozen !== null && !frozen.randomness;
  const now = useNow(counting ? 250 : null);
  if (!frozen) return null;
  if (frozen.randomness)
    return {
      hint: "已取到随机数，正在创建付款…",
      note: "已取到随机数，正在算中奖名单并创建付款，结果出来后显示在这里。",
      beat: "random",
    };
  const roster =
    view.draw?.registered == null
      ? "名单已冻结"
      : `名单已冻结（${view.draw.registered} 人）`;
  const round = roundText(frozen.round);
  const left = Math.ceil((Date.parse(frozen.roundAt) - now) / 1000);
  return left > 0
    ? {
        hint: `名单已冻结，${left} 秒后出随机数…`,
        note: `${roster}，等 ${round}随机数，${left} 秒后产生。`,
        // 震动反馈: the last three seconds each a beat.
        beat: left <= 3 ? `frozen-${left}` : "frozen",
      }
    : {
        hint: "正在取随机数…",
        note: `${roster}，正在取 ${round}随机数。`,
        beat: "fetching",
      };
}

/** "02:17:53"; a day or more drops the seconds ("1天 01:32") to stay short. */
export function countdown(ms: number) {
  if (ms <= 0) return "已截止";
  const total = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = Math.floor(total / 86400);
  const hours = pad(Math.floor((total % 86400) / 3600));
  const minutes = pad(Math.floor((total % 3600) / 60));
  return days > 0
    ? `${days}天 ${hours}:${minutes}`
    : `${hours}:${minutes}:${pad(total % 60)}`;
}

/**
 * What the seal says and does, and whether the opening should play, on top
 * of the 红包's data. Values that tick every second live in leaf components.
 */
export function useHongbao(data: HongbaoData) {
  const { activity, view, roster, passwords, mine } = data;
  const standing = data.standing ?? null;
  const user = useSessionUser();
  const pending = useAtomValue(pendingAtom);
  const scope = useAtomValue(scopeAtom);
  const message = useAtomValue(messageAtom);
  const mode = useOmniboxMode();
  const controller = useOmniboxController();
  const router = useRouter();
  const reduced = useReducedMotionPref();
  const [intent, setIntent] = useAtom(redemptionIntentAtom);
  const animation = useAtomValue(rewardAnimationAtom);
  const [claiming, setClaiming] = useState(false);
  const showScope = useSetAtom(scopeNoticeAtom);
  const cooling = useAttemptCooldown(user?.id ?? null).active;

  const phase: HongbaoPhase = mine ? "open" : view.ended ? "ended" : "closed";

  // The opening plays only for a claim made while this page is on screen;
  // coming back to a claimed 红包 shows it already open.
  const animationAtMount = useRef(animation?.token ?? null);
  const fresh =
    Boolean(mine) &&
    animation?.activityId === activity.id &&
    animation.token !== animationAtMount.current;
  // A claim from the command box waits for the box to fly back first.
  const openDelay = mode === "expanded" ? 0.5 : 0.15;
  // Only a claim spins the seal; verifying another 口令 does not.
  const spinning =
    claiming ||
    (pending &&
      mode === "expanded" &&
      scope?.id === activity.id &&
      scope.purpose !== "verify");

  // A draw result arriving while the page is open plays its own reveal.
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
  const reveal = revealed !== null && revealed.outcome === outcome;

  const isDraw = activity.mode === "timed_draw";
  const gate = user ? null : "login";
  // The sender sees their own 红包 as it is, and may take part too (自领,
  // asked first: docs/self-claim-design.md); a draft is a preview, nobody
  // can yet. Anyone else with its link sees it 未开放: its 开 there, faded.
  const author = data.author;
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
  // A claim or sign-up whose answer was lost: the seal sends it again, as
  // it was (the submission is kept), 口令 and all.
  const unconfirmed = useAtomValue(unconfirmedAtom);
  const pendingRetry = unconfirmed.claims[activity.id] ?? null;
  const retry = Boolean(pendingRetry);
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
  const drawStep = useDrawStep(view);
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

  // 领取前人机验证: its script is fetched ahead, so the dialog opens ready.
  const humanCheckAhead =
    activity.humanCheck && phase === "closed" && !draft && !gate;
  useEffect(() => {
    if (humanCheckAhead) loadTurnstile().catch(() => {});
  }, [humanCheckAhead]);

  const press = () => {
    if (phase !== "closed" || spinning || draft || paused) return;
    if (gate) {
      haptic("light");
      controller.openAccount();
      return;
    }
    // 领取范围: someone outside is told who may, nothing is sent.
    if (
      user &&
      !publicScopeAllows(activity.scope, {
        username: user.username,
        trustLevel: user.trustLevel,
      })
    ) {
      showScope({ activityId: activity.id });
      return;
    }
    if (pendingRetry) {
      haptic("light");
      setClaiming(true);
      void controller
        .redeemIn(activity.id, pendingRetry.password || null, { code })
        .finally(() => setClaiming(false));
      return;
    }
    if (activity.participation === "password" || code) {
      haptic("light");
      controller.expand({ id: activity.id, purpose: code ? "code" : "claim" });
      return;
    }
    if (cooldown) return;
    haptic("light");
    setClaiming(true);
    void controller
      .redeemIn(activity.id, null)
      .finally(() => setClaiming(false));
  };

  // A single lookup match lands here with its submission in memory: claim
  // it once the page is on screen (StrictMode re-runs must not claim twice).
  const handled = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !intent ||
      !user ||
      intent.userId !== user.id ||
      intent.activityId !== activity.id
    )
      return;
    const { operation } = intent;
    if (handled.current === operation.submissionId) return;
    handled.current = operation.submissionId;
    setIntent(null);
    window.setTimeout(
      () => {
        if (!mounted.current) return;
        setClaiming(true);
        void controller
          .redeemIn(activity.id, operation.password, { operation })
          .finally(() => setClaiming(false));
      },
      reduced ? 0 : 420,
    );
  }, [activity.id, controller, intent, reduced, setIntent, user]);

  /** 验证其他口令: the box, scoped to verifying this 红包's 口令. */
  const openVerify = () =>
    controller.expand({ id: activity.id, purpose: "verify" });
  /** The 名单弹窗, as its own history entry. */
  const openRoster = () => switchOverlay(router, { panel: "roster" });
  /** The 说明弹窗: a 说明 too long for the cover, in full. */
  const openNote = () => switchOverlay(router, { panel: "note" });

  return {
    view,
    roster,
    passwords,
    openVerify,
    openRoster,
    openNote,
    mine,
    standing,
    phase,
    fresh,
    reveal,
    openDelay,
    reduced,
    gate,
    author,
    draft,
    isDraw,
    glyph,
    sealState,
    sealLabel,
    hint,
    /** Past its deadline, its result to come: shown as running, not over. */
    drawing,
    /** A v2 draw being drawn: where it is at, for the hint and the ticket. */
    drawStep,
    cooldown,
    announcement,
    press,
    /** Results of a direct claim are shown on the page, not in the box. */
    // Another 红包's answer stays there (Back, a link: still docked).
    message:
      mode === "docked" && message?.activityId === activity.id ? message : null,
  } as const;
}

export type Hongbao = ReturnType<typeof useHongbao>;
