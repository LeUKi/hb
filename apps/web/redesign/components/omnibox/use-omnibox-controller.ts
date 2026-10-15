import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useState } from "react";
import {
  deadlineOf,
  findActivity,
  visibleActivity,
} from "../../fixtures/activities";
import { isEnded, passwordsOf } from "../../fixtures/hongbao";
import {
  claim,
  discover,
  lookupTopic,
  networkLatency,
  wait,
} from "../../fixtures/redemption";
import { activityCode } from "../../lib/activity-route";
import {
  type Command,
  type CommandPath,
  gateFor,
  matchCommands,
  roleOf,
} from "../../lib/commands";
import { closeOverlay, openOverlay, switchOverlay } from "../../lib/overlay";
import { inspectPassword } from "../../lib/password-rules";
import { saveResult } from "../../lib/results";
import { detectScheme, type EntryScheme } from "../../lib/scheme";
import { failsOnce } from "../../lib/sim";
import {
  claimsAtom,
  cooldownUntilAtom,
  drawSimAtom,
  intentAtom,
  recentAtom,
  resultPasswords,
  sessionAtom,
  solvedAtom,
  submitSimAtom,
  verifyNoticeAtom,
} from "../../lib/store";
import { useBefore } from "../../lib/use-before";
import { phoneLikeNow } from "../shell/window-info";
import {
  editDraftAtom,
  messageAtom,
  mismatchAtom,
  type OmniMessage,
  pendingAtom,
  type Scope,
  type ScopeOffer,
  scopeAtom,
  startDraftAtom,
  unconfirmedAtom,
  withClaim,
} from "./state";

/** DOM handles shared by the single omnibox instance. */
export const omniboxElements = {
  input: null as HTMLTextAreaElement | null,
  address: null as HTMLButtonElement | null,
};

export type Destination =
  | { to: "/" }
  | { to: "activity"; id: string }
  | { to: "/🔑/$resultId"; resultId: string }
  | { to: "/💬/$topicId/$postNumber"; topicId: string; postNumber: number }
  | { to: CommandPath };

const HOME_COOLDOWN = 5_000;
const ACTIVITY_COOLDOWN = 2_000;

export function focusOmniboxInput(select = false) {
  const input = omniboxElements.input;
  if (!input) return;
  input.focus({ preventScroll: true });
  if (select) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Whole seconds left of the cooldown. It wakes exactly when the shown
 * number changes, so each second lasts a second (no polling, no drift).
 */
export function useCooldownSeconds() {
  const until = useAtomValue(cooldownUntilAtom);
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const left = until - Date.now();
      if (left <= 0) return;
      timer = window.setTimeout(
        () => {
          setTick((tick) => tick + 1);
          schedule();
        },
        (left % 1000 || 1000) + 2,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [until]);
  const remaining = until - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * What the viewer could do with a 口令 inside this 红包 right now: claim
 * into it (not taken part, still running), or verify more of its 口令
 * (took part, some still hidden; the 口令区's 验证其他口令 rule). Never on
 * the sender's own 红包, or on a draft that is not the viewer's.
 */
export function useScopeOffer(activityId: string | null): ScopeOffer {
  const user = useAtomValue(sessionAtom);
  const claims = useAtomValue(claimsAtom);
  const solved = useAtomValue(solvedAtom);
  const drawSim = useAtomValue(drawSimAtom);
  const activity = activityId
    ? visibleActivity(activityId, user?.username)
    : null;
  // One re-render when it closes, which takes the offer away.
  useBefore(activity ? deadlineOf(activity) : 0);
  if (!user || !activity || activity.participation !== "password") return null;
  if (activity.author.username === user.username) return null;
  const record = claims[activity.id];
  if (!record)
    return isEnded(activity, drawSim)
      ? null
      : { id: activity.id, purpose: "claim" };
  const { canVerify, hidden } = passwordsOf(activity, {
    record,
    solved: solved[activity.id] ?? [],
    drawSim,
    now: Date.now(),
  });
  return canVerify ? { id: activity.id, purpose: "verify", hidden } : null;
}

/**
 * Bumped by 回到起始页: on the start page it navigates nowhere, so a lookup
 * still on its way learns from this that it was abandoned.
 */
let startedOver = 0;

export function useOmniboxController() {
  const store = useStore();
  const router = useRouter();
  const navigate = useNavigate();
  const overlayOpen = useLocation({
    select: (location) =>
      Boolean(location.state.omnibox || location.state.panel),
  });
  const setMessage = useSetAtom(messageAtom);

  const leaveTo = useCallback(
    (destination: Destination, forceReplace?: boolean) => {
      // Never leave an overlay entry behind: back must not reopen it.
      const { state } = router.history.location;
      const replace = forceReplace ?? Boolean(state.omnibox || state.panel);
      switch (destination.to) {
        case "/":
          return navigate({ to: "/", replace });
        case "activity":
          return navigate({
            to: "/🧧/$code",
            params: { code: activityCode(destination.id) },
            replace,
          });
        case "/🔑/$resultId":
          return navigate({
            to: "/🔑/$resultId",
            params: { resultId: destination.resultId },
            replace,
          });
        case "/💬/$topicId/$postNumber":
          return navigate({
            to: "/💬/$topicId/$postNumber",
            params: {
              topicId: destination.topicId,
              postNumber: String(destination.postNumber),
            },
            replace,
          });
        default:
          return navigate({ to: destination.to, replace });
      }
    },
    [navigate, router],
  );

  const openAccount = useCallback(() => {
    // From the expanded box, swap its entry for the card instead of stacking.
    switchOverlay(router, { panel: "account" });
  }, [router]);

  const expand = useCallback(
    (scope: Scope, initial = "") => {
      store.set(editDraftAtom, initial);
      store.set(messageAtom, null);
      store.set(scopeAtom, scope);
      // Focus synchronously inside the user gesture so phones open the keyboard.
      omniboxElements.input?.focus({ preventScroll: true });
      if (!router.history.location.state.omnibox)
        openOverlay(router, { omnibox: "expanded" });
    },
    [router, store],
  );

  const collapse = useCallback(() => closeOverlay(router), [router]);

  /** Run a "/" command: navigate, or open the card when it needs an account. */
  const runCommand = useCallback(
    async (command: Command) => {
      const role = roleOf(store.get(sessionAtom));
      store.set(messageAtom, null);
      if (!command.path || gateFor(command, role)) {
        openAccount();
        return;
      }
      const fromStart = router.state.location.pathname === "/";
      await leaveTo({ to: command.path });
      if (fromStart) store.set(startDraftAtom, "");
    },
    [leaveTo, openAccount, router, store],
  );

  const guard = useCallback(() => {
    const user = store.get(sessionAtom);
    if (!user) {
      store.set(messageAtom, {
        tone: "warning",
        text: "请先登录。",
        action: "login",
      });
      return false;
    }
    return true;
  }, [store]);

  const runDiscover = useCallback(
    async (password: string, fromExpanded: boolean) => {
      const inspection = inspectPassword(password);
      if (!inspection.valid || store.get(pendingAtom)) return;
      if (!guard()) return;
      const lookup = store.get(unconfirmedAtom).lookup;
      // Re-confirming the original request is not a new attempt: no cooldown.
      const retrying = lookup?.password === password;
      if (!retrying && store.get(cooldownUntilAtom) > Date.now()) return;
      const attempt = retrying && lookup ? lookup.attempt + 1 : 0;
      const href = router.history.location.href;
      const round = startedOver;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      await wait(networkLatency);
      store.set(pendingAtom, false);
      // Drop late results once the user has navigated elsewhere, or
      // started over on the start page.
      if (router.history.location.href !== href || round !== startedOver)
        return;
      const result = discover(password, attempt);
      store.set(cooldownUntilAtom, Date.now() + HOME_COOLDOWN);
      if (result.kind === "unknown") {
        store.set(unconfirmedAtom, {
          ...store.get(unconfirmedAtom),
          lookup: { password, attempt },
        });
        store.set(recentAtom, {
          password,
          status: "unconfirmed",
          activityIds: [],
          at: Date.now(),
        });
        store.set(messageAtom, {
          tone: "warning",
          text: "查找结果未确认，请再次确认。",
        });
        return;
      }
      store.set(unconfirmedAtom, {
        ...store.get(unconfirmedAtom),
        lookup: null,
      });
      const activityIds =
        result.kind === "single"
          ? [result.activityId]
          : result.kind === "multiple"
            ? result.activityIds
            : [];
      store.set(recentAtom, {
        password,
        status: result.kind === "none" ? "unmatched" : "matched",
        activityIds,
        at: Date.now(),
      });
      if (result.kind === "none") {
        store.set(messageAtom, { tone: "neutral", text: "未匹配到红包。" });
        store.set(mismatchAtom, (count) => count + 1);
        return;
      }
      if (result.kind === "single") {
        store.set(intentAtom, {
          activityId: result.activityId,
          password,
          token: Date.now(),
        });
        await leaveTo(
          { to: "activity", id: result.activityId },
          fromExpanded || undefined,
        );
        return;
      }
      const resultId = saveResult(
        result.activityIds,
        store.get(sessionAtom)?.id ?? "",
      );
      resultPasswords.set(resultId, password);
      await leaveTo(
        { to: "/🔑/$resultId", resultId },
        fromExpanded || undefined,
      );
    },
    [guard, leaveTo, router, store],
  );

  const runTopic = useCallback(
    async (
      scheme: Extract<EntryScheme, { kind: "topic" }>,
      fromExpanded: boolean,
    ) => {
      if (store.get(pendingAtom)) return;
      const href = router.history.location.href;
      const round = startedOver;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      await wait(networkLatency);
      store.set(pendingAtom, false);
      if (router.history.location.href !== href || round !== startedOver)
        return;
      const ids = lookupTopic(scheme.topicId, scheme.postNumber);
      if (ids.length === 0) {
        store.set(messageAtom, { tone: "neutral", text: "未匹配到红包。" });
        return;
      }
      if (ids.length === 1 && ids[0]) {
        await leaveTo(
          { to: "activity", id: ids[0] },
          fromExpanded || undefined,
        );
        return;
      }
      await leaveTo(
        {
          to: "/💬/$topicId/$postNumber",
          topicId: scheme.topicId,
          postNumber: scheme.postNumber,
        },
        fromExpanded || undefined,
      );
    },
    [leaveTo, router, store],
  );

  /** Enter / action button on the start page or for a global lookup. */
  const submit = useCallback(
    async (raw: string, fromExpanded: boolean) => {
      const scheme = detectScheme(raw, window.location.origin);
      if (scheme.kind === "empty") return;
      if (scheme.kind === "command") {
        const [top] = matchCommands(
          scheme.query,
          roleOf(store.get(sessionAtom)),
        );
        if (top) await runCommand(top);
        return;
      }
      if (
        scheme.kind === "uuid" ||
        scheme.kind === "emoji" ||
        scheme.kind === "link"
      ) {
        store.set(messageAtom, null);
        await leaveTo(
          { to: "activity", id: scheme.activityId },
          fromExpanded || undefined,
        );
        return;
      }
      if (scheme.kind === "topic") {
        await runTopic(scheme, fromExpanded);
        return;
      }
      await runDiscover(raw, fromExpanded);
    },
    [leaveTo, runCommand, runDiscover, runTopic, store],
  );

  const redeemIn = useCallback(
    async (
      activityId: string,
      password: string | null,
      options: { fromDiscovery?: boolean } = {},
    ) => {
      const activity = findActivity(activityId);
      if (!activity || store.get(pendingAtom)) return;
      if (password !== null && !inspectPassword(password).valid) return;
      if (!guard()) return;
      // 重试原提交: the same submission again, after its answer was lost.
      // It is not a new attempt, so it skips the cooldown (production).
      const previous = store.get(unconfirmedAtom).claims[activityId];
      const retrying = previous?.password === (password ?? "");
      // The auto-submit after discovery continues that attempt; no new cooldown.
      if (
        !options.fromDiscovery &&
        !retrying &&
        store.get(cooldownUntilAtom) > Date.now()
      )
        return;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      await wait(networkLatency);
      store.set(pendingAtom, false);
      const verb = activity.mode === "timed_draw" ? "报名" : "领取";
      // Dev toolbar 提交结果. A lost answer or a 5xx keeps the submission
      // for 重试原提交 (the prototype's retry then goes through); a 429
      // drops it. Production cannot tell a 5xx from a lost answer here.
      const sim = store.get(submitSimAtom);
      if (
        sim === "throttled" &&
        failsOnce(`claim429:${activityId}:${password ?? ""}`)
      ) {
        store.set(
          unconfirmedAtom,
          withClaim(store.get(unconfirmedAtom), activityId, null),
        );
        store.set(cooldownUntilAtom, Date.now() + ACTIVITY_COOLDOWN);
        store.set(messageAtom, {
          activityId,
          tone: "warning",
          text: "尝试过于频繁，请稍后重试。",
        });
        return;
      }
      if (
        (sim === "failed" || sim === "unknown" || sim === "conflict") &&
        !retrying
      ) {
        store.set(
          unconfirmedAtom,
          withClaim(store.get(unconfirmedAtom), activityId, {
            password: password ?? "",
            attempt: 0,
          }),
        );
        if (password)
          store.set(recentAtom, {
            password,
            status: "unconfirmed",
            activityIds: [activityId],
            at: Date.now(),
          });
        store.set(messageAtom, {
          activityId,
          tone: "warning",
          text: `尚未确认${verb}结果，请重试原提交以确认结果。`,
        });
        return;
      }
      store.set(
        unconfirmedAtom,
        withClaim(store.get(unconfirmedAtom), activityId, null),
      );
      if (!options.fromDiscovery && !retrying)
        store.set(cooldownUntilAtom, Date.now() + ACTIVITY_COOLDOWN);
      const already = Boolean(store.get(claimsAtom)[activityId]);
      // Deadline, sold out and a finished draw all count as ended.
      const ended = isEnded(activity, store.get(drawSimAtom));
      const own = store.get(sessionAtom)?.username === activity.author.username;
      const result = claim(
        { ...activity, status: ended ? "ended" : "active" },
        password,
        already,
        own,
      );
      if (result.kind === "claimed" || result.kind === "registered") {
        store.set(claimsAtom, activityId, {
          kind: result.kind,
          amount: result.kind === "claimed" ? result.amount : undefined,
          password,
          at: Date.now(),
        });
        if (password)
          store.set(recentAtom, {
            password,
            status: "matched",
            activityIds: [activityId],
            at: Date.now(),
          });
        if (router.history.location.state.omnibox) collapse();
        return;
      }
      store.set(messageAtom, {
        activityId,
        tone: result.kind === "incorrect" ? "danger" : "neutral",
        text:
          result.kind === "incorrect"
            ? "口令不正确。"
            : result.kind === "ended"
              ? "红包已结束。"
              : result.kind === "already"
                ? activity.mode === "timed_draw"
                  ? "你已报名过这个红包。"
                  : "你已领过这个红包。"
                : result.kind === "own"
                  ? `这是你发的红包，你不能${activity.mode === "timed_draw" ? "报名" : "领取"}。`
                  : "未找到红包。",
        action: result.kind === "incorrect" ? "global" : undefined,
      });
      if (result.kind === "incorrect")
        store.set(mismatchAtom, (count) => count + 1);
    },
    [collapse, guard, router, store],
  );

  /**
   * 验证其他口令: for someone who already took part. A correct 口令 is only
   * revealed to them ("已解出"); it never claims again. Shares the cooldown
   * with claiming, except for answers that need no check.
   */
  const verifyIn = useCallback(
    async (activityId: string, password: string) => {
      const activity = findActivity(activityId);
      if (!activity || store.get(pendingAtom)) return;
      if (!inspectPassword(password).valid) return;
      if (!guard()) return;
      const record = store.get(claimsAtom)[activityId];
      const known = store.get(solvedAtom)[activityId] ?? [];
      // Production has no such answer; the page already knows these.
      if (password === record?.password || known.includes(password)) {
        store.set(messageAtom, {
          activityId,
          tone: "neutral",
          text: "你已经知道这个口令。",
        });
        return;
      }
      if (store.get(cooldownUntilAtom) > Date.now()) return;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      await wait(networkLatency);
      store.set(pendingAtom, false);
      // Dev toolbar 提交结果: verifying changes nothing, so a lost answer
      // is simply tried again.
      const sim = store.get(submitSimAtom);
      if (sim !== "ok" && failsOnce(`verify:${activityId}:${password}`)) {
        if (sim === "throttled")
          store.set(cooldownUntilAtom, Date.now() + ACTIVITY_COOLDOWN);
        store.set(messageAtom, {
          activityId,
          tone: "warning",
          text:
            sim === "throttled"
              ? "尝试过于频繁，请稍后重试。"
              : "没有收到验证结果，请再试一次。",
        });
        return;
      }
      const taken = activity.entries.length + (record ? 1 : 0);
      if (isEnded(activity, store.get(drawSimAtom), Date.now(), taken)) {
        store.set(messageAtom, {
          activityId,
          tone: "neutral",
          text: "红包已结束，口令已公开。",
        });
        return;
      }
      store.set(cooldownUntilAtom, Date.now() + ACTIVITY_COOLDOWN);
      if (activity.passwords.includes(password)) {
        store.set(solvedAtom, activityId, password);
        store.set(verifyNoticeAtom, {
          activityId,
          password,
          token: Date.now(),
        });
        if (router.history.location.state.omnibox) collapse();
        return;
      }
      store.set(messageAtom, {
        activityId,
        tone: "danger",
        text: "口令不正确，请重新尝试。",
      });
      store.set(mismatchAtom, (count) => count + 1);
    },
    [collapse, guard, router, store],
  );

  const runMessageAction = useCallback(
    (action: OmniMessage["action"]) => {
      if (action === "login") {
        openAccount();
        return;
      }
      const expanded = Boolean(router.history.location.state.omnibox);
      const draftAtom = expanded ? editDraftAtom : startDraftAtom;
      if (action === "global") {
        store.set(scopeAtom, null);
        store.set(messageAtom, null);
        void runDiscover(store.get(draftAtom), true);
      }
    },
    [openAccount, router, runDiscover, store],
  );

  const goHome = useCallback(() => {
    startedOver += 1;
    store.set(startDraftAtom, "");
    store.set(messageAtom, null);
    store.set(unconfirmedAtom, { ...store.get(unconfirmedAtom), lookup: null });
    const atStart = router.state.location.pathname === "/";
    if (atStart && !overlayOpen) {
      // On a phone, focus would open the search mode: wait for a tap.
      if (matchMedia("(pointer: fine)").matches && !phoneLikeNow())
        focusOmniboxInput();
      return;
    }
    void leaveTo({ to: "/" }, atStart || undefined);
  }, [leaveTo, overlayOpen, router, store]);

  return {
    leaveTo,
    expand,
    collapse,
    submit,
    runCommand,
    redeemIn,
    verifyIn,
    openAccount,
    goHome,
    runMessageAction,
    setMessage,
  };
}
