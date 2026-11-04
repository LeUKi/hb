import type { MyStanding } from "@hb/contracts";
import { publicScopeAllows } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { scopeNoticeAtom } from "../../lib/claim-scope";
import { leaveClaimQueue } from "../../lib/claims";
import { haptic } from "../../lib/haptics";
import type {
  HongbaoActivity,
  Mine,
  PasswordView,
  PublicView,
  Roster,
} from "../../lib/hongbao";
import { liveQueuedAtom } from "../../lib/live-state";
import { useReducedMotionPref } from "../../lib/motion";
import { switchOverlay } from "../../lib/overlay";
import { participationKey } from "../../lib/participation-cache";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";
import { useIdentity, useSessionUser } from "../../lib/session";
import { loadTurnstile } from "../../lib/turnstile";
import {
  messageAtom,
  pendingAtom,
  scopeAtom,
  unconfirmedAtom,
  useOmniboxMode,
} from "../omnibox/state";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { useDrawStep } from "./clock";
import { sealOf, useDrawMoments } from "./seal-state";

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
  /**
   * A claim of theirs checked and waiting for its share, known from their
   * participation (a page reloaded meanwhile): 领取中, 取消排队.
   */
  waiting?: { submissionId: string } | null;
};

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

  // The opening plays only for a claim made while this page is on screen;
  // coming back to a claimed 红包 shows it already open.
  const animationAtMount = useRef(animation?.token ?? null);
  const fresh =
    Boolean(mine) &&
    animation?.activityId === activity.id &&
    animation.token !== animationAtMount.current;
  // A claim from the command box waits for the box to fly back first.
  const openDelay = mode === "expanded" ? 0.5 : 0.15;
  // 排队 (docs/claim-capacity-design.md §3 第 1 期): where their direct or
  // 口令 claim waits, pushed (queued), or known from their participation.
  const pushedQueue = useAtomValue(liveQueuedAtom);
  const setQueued = useSetAtom(liveQueuedAtom);
  const queue =
    activity.participation !== "code" && pushedQueue?.id === activity.id
      ? pushedQueue
      : null;
  // Over, or theirs already: nothing waits any more.
  const waiting = !mine && !view.ended ? (data.waiting ?? null) : null;
  // Only a claim spins the seal; verifying another 口令 does not.
  const spinning =
    claiming ||
    Boolean(waiting) ||
    Boolean(queue) ||
    (pending &&
      mode === "expanded" &&
      scope?.id === activity.id &&
      scope.purpose !== "verify");

  const gate = user ? null : "login";
  const author = data.author;
  // A claim or sign-up whose answer was lost: the seal sends it again, as
  // it was (the submission is kept), 口令 and all.
  const unconfirmed = useAtomValue(unconfirmedAtom);
  const pendingRetry = unconfirmed.claims[activity.id] ?? null;
  const retry = Boolean(pendingRetry);
  const drawStep = useDrawStep(view);
  const {
    phase,
    isDraw,
    draft,
    drawing,
    glyph,
    cooldown,
    code,
    paused,
    sealState,
    sealLabel,
    hint,
    announcement,
  } = sealOf({
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
    queue: spinning && queue ? queue : null,
    waiting: Boolean(waiting),
  });
  const reveal = useDrawMoments(mine, drawStep);

  // A 口令 claim that has to wait: the box steps aside, so its place in
  // line and 取消排队 show on the page.
  const waitingAhead = queue ? queue.ahead : 0;
  useEffect(() => {
    if (
      waitingAhead > 0 &&
      mode === "expanded" &&
      scope?.id === activity.id &&
      scope.purpose === "claim"
    )
      controller.collapse();
  }, [waitingAhead, mode, scope?.id, scope?.purpose, activity.id, controller]);

  // 取消排队: their waiting claim leaves the line; nothing is taken.
  const identity = useIdentity();
  const queryClient = useQueryClient();
  // Only while someone is before it, or a reloaded page waits: a claim
  // written in its next turn is not worth leaving.
  const leavingId =
    spinning && !mine && !view.ended
      ? ((queue && queue.ahead > 0 ? queue.submissionId : undefined) ??
        waiting?.submissionId ??
        null)
      : null;
  const [leaveState, setLeaveState] = useState<{
    busy: boolean;
    error: string | null;
    for: string | null;
  }>({ busy: false, error: null, for: null });
  const leaveQueue =
    leavingId && identity.csrfToken
      ? async () => {
          if (leaveState.busy || !identity.csrfToken) return;
          setLeaveState({ busy: true, error: null, for: leavingId });
          const error = await leaveClaimQueue(
            activity.id,
            leavingId,
            identity.csrfToken,
          );
          setLeaveState({ busy: false, error, for: leavingId });
          if (error) return;
          setQueued((current) =>
            current?.id === activity.id ? null : current,
          );
          if (user)
            void queryClient.invalidateQueries({
              queryKey: participationKey(user.id, activity.id),
              exact: true,
            });
        }
      : null;

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
    /** 取消排队, while their claim waits for its share; null otherwise. */
    leaveQueue,
    leaving: leaveState.busy,
    // An error is about the claim it was for, not a later one.
    leaveError:
      leavingId && leaveState.for === leavingId ? leaveState.error : null,
    /** Results of a direct claim are shown on the page, not in the box. */
    // Another 红包's answer stays there (Back, a link: still docked).
    message:
      mode === "docked" && message?.activityId === activity.id ? message : null,
  } as const;
}

export type Hongbao = ReturnType<typeof useHongbao>;
