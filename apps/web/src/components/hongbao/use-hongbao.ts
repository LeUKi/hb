import { useRouter } from "@tanstack/react-router";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
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
import { sealGlyphs } from "../../lib/seal";
import { useSessionUser } from "../../lib/session";
import { useBefore } from "../../lib/use-before";
import {
  messageAtom,
  pendingAtom,
  scopeAtom,
  unconfirmedAtom,
  useOmniboxMode,
} from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";

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
  /** The viewer sent it: they see every 口令 and cannot take part. */
  author: boolean;
};

export function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
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
  const cooling = useAttemptCooldown(user?.id ?? null).active;
  // The deadline re-renders the page once, as the 红包 closes.
  useBefore(view.ended ? 0 : view.deadlineAt);

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
      scope.purpose === "claim");

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
    )
      setRevealed({ outcome, at: Date.now() });
  }, [outcome]);
  const reveal = revealed !== null && revealed.outcome === outcome;

  const isDraw = activity.mode === "timed_draw";
  const gate = user ? null : "login";
  // The sender sees their own 红包 as it is, but cannot take part (a draft
  // is a preview: nobody can yet).
  const author = data.author;
  const draft = activity.draft;
  const seal = sealGlyphs;
  const glyph =
    phase === "ended"
      ? seal.ended
      : draft
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
  const sealState =
    phase === "ended"
      ? "muted"
      : spinning
        ? "pending"
        : cooldown || author || draft
          ? "disabled"
          : "idle";
  const hint =
    phase === "ended"
      ? endHint(view)
      : draft
        ? `草稿预览，开放后才能${verb}`
        : author
          ? `这是你发的红包，你不能${verb}`
          : spinning
            ? "正在确认…"
            : gate === "login"
              ? `登录后${verb}`
              : retry
                ? `点「${glyph}」重试原提交`
                : activity.participation === "password"
                  ? `点「${glyph}」，输入口令${verb}`
                  : `点「${glyph}」${verb}`;
  const sealLabel =
    phase === "ended" || author || draft
      ? hint
      : gate === "login"
        ? "登录"
        : retry
          ? "重试原提交"
          : activity.participation === "password"
            ? `输入口令${verb}`
            : isDraw
              ? "报名"
              : "领取红包";
  const announcement = !mine
    ? ""
    : mine.kind === "claimed"
      ? `已领取 ${mine.amount} LDC。`
      : mine.outcome === "won"
        ? `已中奖，${mine.amount} LDC。`
        : mine.outcome === "lost"
          ? "本次未中奖。"
          : "已报名，等待开奖。";

  const press = () => {
    if (phase !== "closed" || spinning || author || draft) return;
    if (gate) {
      controller.openAccount();
      return;
    }
    if (pendingRetry) {
      setClaiming(true);
      void controller
        .redeemIn(activity.id, pendingRetry.password || null)
        .finally(() => setClaiming(false));
      return;
    }
    if (activity.participation === "password") {
      controller.expand({ id: activity.id, purpose: "claim" });
      return;
    }
    if (cooldown) return;
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
