import { passwordSchema } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { activityCode } from "../../lib/activity-route";
import {
  attemptCooldownRemainingMs,
  useAttemptCooldown,
} from "../../lib/attempt-cooldown";
import {
  type SessionResponse,
  sessionQueryKey,
  sessionScope,
} from "../../lib/auth";
import {
  type Command,
  type CommandPath,
  gateFor,
  matchCommands,
  roleOf,
} from "../../lib/commands";
import {
  exchangeContextAtom,
  topicActivitiesQuery,
  useGlobalRedemptionDiscovery,
} from "../../lib/discovery";
import { closeOverlay, openOverlay, switchOverlay } from "../../lib/overlay";
import { inspectPassword } from "../../lib/password-rules";
import { redemptionIntentAtom } from "../../lib/redemption-intent";
import { detectScheme, type EntryScheme } from "../../lib/scheme";
import { sessionUserOf, useSessionUser } from "../../lib/session";
import { phoneLikeNow } from "../shell/window-info";
import {
  editDraftAtom,
  messageAtom,
  mismatchAtom,
  pendingAtom,
  type Scope,
  type ScopeOffer,
  scopeAtom,
  startDraftAtom,
  unconfirmedAtom,
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

export function focusOmniboxInput(select = false) {
  const input = omniboxElements.input;
  if (!input) return;
  input.focus({ preventScroll: true });
  if (select) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Whole seconds left of the account's attempt cooldown (shared by the start
 * page and every 红包, set by the server). It changes exactly on the second.
 */
export function useCooldownSeconds() {
  const user = useSessionUser();
  return useAttemptCooldown(user?.id ?? null).seconds;
}

/**
 * What the viewer could do with a 口令 inside this 红包 right now: claim
 * into it (not taken part, still running), or verify more of its 口令
 * (took part, some still hidden; the 口令区's 验证其他口令 rule). Never on
 * the sender's own 红包, or on a draft that is not the viewer's.
 *
 * The 红包 page comes with migration phase 2; until then there is nothing
 * to offer.
 */
export function useScopeOffer(_activityId: string | null): ScopeOffer {
  return null;
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
  const queryClient = useQueryClient();
  const user = useSessionUser();
  const csrfToken =
    queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.csrfToken ?? "";
  const discovery = useGlobalRedemptionDiscovery(user?.id ?? "", csrfToken);
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
      const role = roleOf(sessionUserOf(queryClient));
      store.set(messageAtom, null);
      if (!command.path || gateFor(command, role)) {
        openAccount();
        return;
      }
      const fromStart = router.state.location.pathname === "/";
      await leaveTo({ to: command.path });
      if (fromStart) store.set(startDraftAtom, "");
    },
    [leaveTo, openAccount, queryClient, router, store],
  );

  const guard = useCallback(() => {
    if (!sessionUserOf(queryClient)) {
      store.set(messageAtom, {
        tone: "warning",
        text: "请先登录。",
        action: "login",
      });
      return false;
    }
    return true;
  }, [queryClient, store]);

  /**
   * A 口令 looked up across every 红包 (the start page, or the box without
   * a scope). One match opens it and claims there with the same submission;
   * several go to /🔑/<result>; none says so. An answer that was lost keeps
   * the submission, and 再次确认 sends exactly it again (no new attempt).
   */
  const runDiscover = useCallback(
    async (password: string, fromExpanded: boolean) => {
      if (!inspectPassword(password).valid) return;
      const checked = passwordSchema.safeParse(password);
      if (!checked.success || store.get(pendingAtom)) return;
      if (!guard()) return;
      const account = sessionUserOf(queryClient);
      if (!account) return;
      const lookup = store.get(unconfirmedAtom).lookup;
      const retrying = lookup?.password === password;
      if (!retrying && attemptCooldownRemainingMs(account.id) > 0) return;
      const submission = {
        submissionId:
          retrying && lookup ? lookup.submissionId : crypto.randomUUID(),
        password: checked.data,
      };
      const href = router.history.location.href;
      const round = startedOver;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      store.set(redemptionIntentAtom, null);
      store.set(exchangeContextAtom, null);
      const stale = () =>
        router.history.location.href !== href ||
        round !== startedOver ||
        sessionUserOf(queryClient)?.id !== account.id;
      try {
        const result = await discovery.mutateAsync(submission);
        store.set(pendingAtom, false);
        store.set(unconfirmedAtom, {
          ...store.get(unconfirmedAtom),
          lookup: null,
        });
        // Drop late results once the user has navigated elsewhere, started
        // over on the start page, or changed account.
        if (stale()) return;
        const selected =
          result.selectedActivityId ??
          (result.result === "single" ? (result.items[0]?.id ?? null) : null);
        store.set(exchangeContextAtom, {
          userId: account.id,
          sessionScope: sessionScope(
            queryClient.getQueryData<SessionResponse>(sessionQueryKey),
          ),
          password: submission.password,
          submission,
          claimSubmissionId: result.claimSubmissionId,
          resultId: result.id,
          state: "resolved",
          selectedActivityId: selected,
        });
        if (selected) {
          // The claim continues the same attempt on the 红包 page, unless the
          // lookup already finished it.
          if (!result.claimResult)
            store.set(redemptionIntentAtom, {
              userId: account.id,
              activityId: selected,
              operation: {
                submissionId: result.claimSubmissionId,
                discoveryId: result.id,
                password: submission.password,
              },
            });
          await leaveTo(
            { to: "activity", id: selected },
            fromExpanded || undefined,
          );
          return;
        }
        if (result.result === "multiple" && result.items.length > 0) {
          await leaveTo(
            { to: "/🔑/$resultId", resultId: result.id },
            fromExpanded || undefined,
          );
          return;
        }
        store.set(messageAtom, { tone: "neutral", text: "未匹配到红包。" });
        store.set(mismatchAtom, (count) => count + 1);
      } catch (error) {
        store.set(pendingAtom, false);
        if (stale()) return;
        if (error instanceof ActivityRequestError && error.status === 429) {
          store.set(unconfirmedAtom, {
            ...store.get(unconfirmedAtom),
            lookup: null,
          });
          store.set(messageAtom, {
            tone: "warning",
            text: "尝试过于频繁，请稍后重试。",
          });
          return;
        }
        if (error instanceof ActivityRequestError && error.status === 401) {
          store.set(unconfirmedAtom, {
            ...store.get(unconfirmedAtom),
            lookup: null,
          });
          store.set(messageAtom, {
            tone: "warning",
            text: "登录已失效，请重新登录。",
            action: "login",
          });
          return;
        }
        // No answer, or the server failed: the lookup may have happened.
        // Keep it, so 再次确认 asks about the same submission.
        if (!(error instanceof ActivityRequestError) || error.status >= 500) {
          store.set(unconfirmedAtom, {
            ...store.get(unconfirmedAtom),
            lookup: {
              password: submission.password,
              submissionId: submission.submissionId,
            },
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
        store.set(messageAtom, { tone: "warning", text: error.message });
      }
    },
    [discovery, guard, leaveTo, queryClient, router, store],
  );

  /** A post link: its one 红包 opens; several go to /💬/<topic>/<post>. */
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
      try {
        const list = await queryClient.fetchQuery(
          topicActivitiesQuery(
            scheme.topicId,
            scheme.postNumber,
            sessionUserOf(queryClient)?.id ?? null,
          ),
        );
        store.set(pendingAtom, false);
        if (router.history.location.href !== href || round !== startedOver)
          return;
        const [only] = list.items;
        if (!only) {
          store.set(messageAtom, {
            tone: "neutral",
            text: "这个帖子里还没有红包。",
          });
          return;
        }
        if (list.items.length === 1 && !list.nextCursor) {
          await leaveTo(
            { to: "activity", id: only.id },
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
      } catch {
        store.set(pendingAtom, false);
        if (router.history.location.href !== href || round !== startedOver)
          return;
        store.set(messageAtom, {
          tone: "warning",
          text: "没能读取这个帖子里的红包，请稍后再试。",
        });
      }
    },
    [leaveTo, queryClient, router, store],
  );

  /** Enter / action button on the start page or for a global lookup. */
  const submit = useCallback(
    async (raw: string, fromExpanded: boolean) => {
      const scheme = detectScheme(raw, window.location.origin);
      if (scheme.kind === "empty") return;
      if (scheme.kind === "command") {
        const [top] = matchCommands(
          scheme.query,
          roleOf(sessionUserOf(queryClient)),
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
    [leaveTo, queryClient, runCommand, runDiscover, runTopic, store],
  );

  /**
   * Claiming or signing up inside one 红包, and 验证其他口令: both run on the
   * 红包 page, which comes with migration phase 2.
   */
  const redeemIn = useCallback(
    async (activityId: string, _password: string | null) => {
      await leaveTo({ to: "activity", id: activityId });
    },
    [leaveTo],
  );
  const verifyIn = useCallback(
    async (activityId: string, _password: string) => {
      await leaveTo({ to: "activity", id: activityId });
    },
    [leaveTo],
  );

  const runMessageAction = useCallback(
    (action: "login" | "global" | undefined) => {
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
