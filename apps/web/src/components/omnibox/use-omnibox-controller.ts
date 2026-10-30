import {
  type ActivityPasswords,
  type ClaimActivityInput,
  judgeAnswerSchema,
  passwordSchema,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import {
  ActivityRequestError,
  activityKeys,
  type PublicActivityDetail,
  refused,
} from "../../lib/activities";
import { passwordKey, useSolvePassword } from "../../lib/activity-passwords";
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
import { useCachedQueryData } from "../../lib/cached-query";
import { noteOutOfScope } from "../../lib/claim-scope";
import { useClaimReward } from "../../lib/claims";
import {
  type Command,
  type CommandPath,
  featuresOf,
  gateFor,
  matchCommands,
  roleOf,
} from "../../lib/commands";
import {
  exchangeContextAtom,
  topicActivitiesQuery,
  useGlobalRedemptionDiscovery,
} from "../../lib/discovery";
import { haptic, hapticForTone } from "../../lib/haptics";
import { askHumanCheck, endHumanCheck } from "../../lib/human-check";
import { myJudgmentsKey } from "../../lib/judge";
import { maintenanceAtom } from "../../lib/maintenance";
import { closeOverlay, openOverlay, switchOverlay } from "../../lib/overlay";
import { pageStanding } from "../../lib/page-standing";
import {
  askPageSubmit,
  notFilled,
  notJudged,
  type PageFillResult,
  type PageSubmitResult,
} from "../../lib/page-submit";
import {
  type ParticipationCache,
  participationKey,
} from "../../lib/participation-cache";
import { inspectPassword } from "../../lib/password-rules";
import {
  type RedemptionIntentOperation,
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";
import { openingLabel } from "../../lib/roster-time";
import { detectScheme, type EntryScheme } from "../../lib/scheme";
import { askSelfClaim } from "../../lib/self-claim";
import { sessionUserOf, useSessionUser } from "../../lib/session";
import { verifyNoticeAtom } from "../../lib/store";
import { useBefore } from "../../lib/use-before";
import { phoneLikeNow } from "../shell/window-info";
import {
  editDraftAtom,
  judgingAtom,
  messageAtom,
  mismatchAtom,
  type OmniMessage,
  pastedPasswordAtom,
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
 * the sender's own 红包, or on a draft that is not the viewer's. Read from
 * what the 红包 page has already loaded.
 */
export function useScopeOffer(activityId: string | null): ScopeOffer {
  const user = useSessionUser();
  const id = activityId ?? "";
  const userId = user?.id ?? null;
  const detail = useCachedQueryData<PublicActivityDetail>(
    activityId ? activityKeys.public(id, userId) : null,
  );
  const participation = useCachedQueryData<ParticipationCache>(
    activityId && userId ? participationKey(userId, id) : null,
  );
  const passwords = useCachedQueryData<ActivityPasswords>(
    activityId && userId ? passwordKey(userId, id) : null,
  );
  const activity = detail?.activity;
  const deadline = activity?.draw?.deadlineAt ?? activity?.deadlineAt;
  // One re-render when it closes, which takes the offer away.
  useBefore(deadline ? Date.parse(deadline) : 0);
  if (!user || !activity || activity.status !== "active") return null;
  if (activity.author.id === user.id) return null;
  // 代码判定: submit to its code until taken part; nothing to verify after.
  if (activity.participationMode === "code")
    return participation?.claim ||
      activity.judge?.paused ||
      (deadline && Date.parse(deadline) <= Date.now())
      ? null
      : { id: activity.id, purpose: "code" };
  if ((activity.participationMode ?? "password") !== "password") return null;
  const taken = Boolean(participation?.claim || participation?.registration);
  if (!taken)
    return deadline && Date.parse(deadline) <= Date.now()
      ? null
      : { id: activity.id, purpose: "claim" };
  return passwords?.canSolve && passwords.hiddenCount > 0
    ? { id: activity.id, purpose: "verify", hidden: passwords.hiddenCount }
    : null;
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
  const claim = useClaimReward(user?.id ?? "", csrfToken);
  const solve = useSolvePassword(user?.id ?? "", csrfToken);
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
      // In 维护模式 nobody can sign in: say why instead.
      store.set(
        messageAtom,
        store.get(maintenanceAtom)
          ? { tone: "warning", text: "系统维护中，请稍后再试。" }
          : { tone: "warning", text: "请先登录。", action: "login" },
      );
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
        // Lookups skip 红包 whose 首页领取 is off: say so as the one who
        // wants to claim would ask it, and where they all are (02 §6).
        store.set(messageAtom, {
          tone: "neutral",
          text: "未匹配到红包，可能是关闭了首页领取。去红包广场找到它，在红包页输入口令。",
          terms: [
            { words: "关闭了首页领取", term: "首页领取" },
            { words: "红包广场", action: "square" },
          ],
        });
        haptic("error");
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
            text: "尝试过于频繁，请稍后再试。",
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
        if (!refused(error)) {
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
        const user = sessionUserOf(queryClient);
        const [top] = matchCommands(
          scheme.query,
          roleOf(user),
          featuresOf(user),
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
        // A 口令 that came with the pasted address (02 §6): the 红包 page
        // takes it as soon as it opens, as after a single match.
        const pasted = store.get(pastedPasswordAtom);
        store.set(pastedPasswordAtom, null);
        const account = sessionUserOf(queryClient);
        if (pasted?.activityId === scheme.activityId && account)
          store.set(redemptionIntentAtom, {
            userId: account.id,
            activityId: scheme.activityId,
            operation: {
              submissionId: crypto.randomUUID(),
              password: pasted.password,
            },
          });
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

  /** A timed draw is signed up for; anything else is claimed. */
  const verbOf = useCallback(
    (activityId: string) =>
      queryClient.getQueryData<PublicActivityDetail>(
        activityKeys.public(activityId, sessionUserOf(queryClient)?.id ?? null),
      )?.activity.reward?.mode === "timed_draw"
        ? "报名"
        : "领取",
    [queryClient],
  );
  /** 自领: the 红包 is the one asking's own (docs/self-claim-design.md). */
  const ownOf = useCallback(
    (activityId: string, userId: string) =>
      queryClient.getQueryData<PublicActivityDetail>(
        activityKeys.public(activityId, userId),
      )?.activity.author.id === userId,
    [queryClient],
  );

  /**
   * Sends a claim; a 红包 whose sender asks for a human check answers
   * HUMAN_CHECK_REQUIRED first (and once more if a token fails), so the
   * same submission goes again with a Turnstile token from the dialog.
   * Null: the dialog was closed, or the page moved on meanwhile.
   */
  const claimWithHumanCheck = useCallback(
    async (
      activityId: string,
      input: ClaimActivityInput,
      stale: () => boolean,
    ) => {
      try {
        for (let round = 0; ; round += 1) {
          try {
            return await claim.mutateAsync({ id: activityId, input });
          } catch (error) {
            if (
              !(error instanceof ActivityRequestError) ||
              error.code !== "HUMAN_CHECK_REQUIRED" ||
              !error.humanCheck ||
              round >= 2 ||
              stale()
            )
              throw error;
            const account = sessionUserOf(queryClient);
            const read = account
              ? queryClient.getQueryData<PublicActivityDetail>(
                  activityKeys.public(activityId, account.id),
                )
              : undefined;
            const token = await askHumanCheck(store, {
              challenge: error.humanCheck,
              author: read?.activity.author.username || null,
              again: round > 0,
            });
            if (!token || stale()) return null;
            input = { ...input, humanToken: token };
          }
        }
      } finally {
        // Passed, the dialog waited for this answer.
        endHumanCheck(store);
      }
    },
    [claim, queryClient, store],
  );

  /**
   * 领取 or 报名 inside one 红包: with a 口令, or none for a 红包 that needs
   * none, or (`code`) what is typed for a 代码判定红包's code to judge, sent
   * as it is. A submission whose answer was lost is sent again as it was
   * (重试原提交); a lookup's single match continues with the lookup's own
   * submission. Only a new attempt waits for the cooldown.
   */
  const redeemIn = useCallback(
    async (
      activityId: string,
      password: string | null,
      options: { operation?: RedemptionIntentOperation; code?: boolean } = {},
    ) => {
      if (store.get(pendingAtom)) return;
      const code = options.code === true;
      if (password !== null && !code && !inspectPassword(password).valid)
        return;
      if (!guard()) return;
      const account = sessionUserOf(queryClient);
      if (!account) return;
      const verb = verbOf(activityId);
      const previous = store.get(unconfirmedAtom).claims[activityId];
      const retrying = previous?.password === (password ?? "");
      let input: ClaimActivityInput;
      if (options.operation) input = options.operation;
      else if (retrying && previous)
        input = code
          ? {
              participationMode: "code",
              submissionId: previous.submissionId,
              input: password ?? "",
            }
          : password === null
            ? {
                participationMode: "direct",
                submissionId: previous.submissionId,
              }
            : { submissionId: previous.submissionId, password };
      else {
        if (attemptCooldownRemainingMs(account.id) > 0) return;
        if (code) {
          // One line, 1–200 字, ends trimmed (02 §4): said in the box.
          const checked = judgeAnswerSchema.safeParse(password ?? "");
          if (!checked.success) {
            store.set(messageAtom, {
              activityId,
              tone: "warning",
              text: checked.error.issues[0]?.message ?? "请检查输入",
            });
            return;
          }
          input = {
            participationMode: "code",
            submissionId: crypto.randomUUID(),
            input: checked.data,
          };
        } else if (password === null)
          input = {
            participationMode: "direct",
            submissionId: crypto.randomUUID(),
          };
        else {
          const checked = passwordSchema.safeParse(password);
          if (!checked.success) return;
          input = { submissionId: crypto.randomUUID(), password: checked.data };
        }
      }
      // 自领: asked once before it is sent (not again for a retry of it);
      // 返回 sends nothing and leaves the box as it was.
      if (
        !retrying &&
        ownOf(activityId, account.id) &&
        !(await askSelfClaim(store, verb === "报名"))
      )
        return;
      const href = router.history.location.href;
      const stale = () =>
        router.history.location.href !== href ||
        sessionUserOf(queryClient)?.id !== account.id;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      store.set(rewardAnimationAtom, {
        activityId,
        token: input.submissionId,
      });
      // 代码判定 (02 §4 判定中): what was typed leaves the box for its card
      // at once, and comes back if the code never judges it.
      const typed = password ?? "";
      let judged = false;
      if (code && "input" in input) {
        store.set(judgingAtom, {
          activityId,
          input: input.input,
          at: Date.now(),
        });
        if (store.get(editDraftAtom) === typed) store.set(editDraftAtom, "");
      }
      const say = (message: OmniMessage) => {
        hapticForTone(message.tone);
        store.set(messageAtom, { activityId, ...message });
      };
      try {
        const result = await claimWithHumanCheck(activityId, input, stale);
        if (!result) {
          if (!stale())
            say({
              tone: "neutral",
              text: `没有完成人机验证，这次没有${verb}。`,
            });
          return;
        }
        store.set(
          unconfirmedAtom,
          withClaim(store.get(unconfirmedAtom), activityId, null),
        );
        if (stale()) return;
        // 代码判定: this one joins 我的提交 (05 §3), read before its card
        // turns into it.
        judged =
          code && (result.result === "claimed" || result.result === "rejected");
        if (judged)
          await queryClient.invalidateQueries({
            queryKey: myJudgmentsKey(account.id, activityId),
          });
        switch (result.result) {
          case "claimed":
          case "registered":
            // A 🐟额红包's share opens 🐟额 to a first-timer: its entry
            // comes with the session (balance-design §14).
            if (
              result.result === "claimed" &&
              result.claim.activity.funding === "balance"
            )
              void queryClient.invalidateQueries({
                queryKey: sessionQueryKey,
              });
            if (router.history.location.state.omnibox) collapse();
            return;
          case "already_claimed":
            say({ tone: "neutral", text: "你已领过这个红包。" });
            return;
          case "already_registered":
            say({
              tone: "neutral",
              text: "你已报名过这个红包，再次报名不会增加中奖机会。",
            });
            return;
          case "incorrect":
            say({ tone: "danger", text: "口令不正确。", action: "global" });
            store.set(mismatchAtom, (count) => count + 1);
            return;
          // 代码判定 said no: its reply heads the record under the box (02
          // §4), which says it aloud too; the box empties for the next try.
          case "rejected":
            hapticForTone("danger");
            if (store.get(editDraftAtom) === (password ?? ""))
              store.set(editDraftAtom, "");
            return;
          case "draft": {
            // 定时开放: when it opens (scheduled-opening §6).
            const at = queryClient.getQueryData<PublicActivityDetail>(
              activityKeys.public(activityId, account.id),
            )?.activity.scheduledOpenAt;
            say({
              tone: "neutral",
              text: at
                ? `红包 ${openingLabel(Date.parse(at))} 开放，暂时不能${verb}。`
                : `红包还没开放，暂时不能${verb}。`,
            });
            return;
          }
          default:
            say({ tone: "neutral", text: "红包已结束。" });
        }
      } catch (error) {
        if (stale()) return;
        // 代码判定: its code failed or waits; nothing was written or counted.
        if (
          error instanceof ActivityRequestError &&
          (error.code === "JUDGE_FAILED" ||
            error.code === "JUDGE_UNAVAILABLE" ||
            error.code === "CODE_PAUSED" ||
            error.code === "CODE_BUSY")
        ) {
          store.set(
            unconfirmedAtom,
            withClaim(store.get(unconfirmedAtom), activityId, null),
          );
          say({ tone: "warning", text: error.message });
          if (error.code === "CODE_PAUSED")
            void queryClient.invalidateQueries({
              queryKey: activityKeys.public(activityId, account.id),
            });
          return;
        }
        if (error instanceof ActivityRequestError && error.status === 429) {
          store.set(
            unconfirmedAtom,
            withClaim(store.get(unconfirmedAtom), activityId, null),
          );
          say({ tone: "warning", text: "尝试过于频繁，请稍后再试。" });
          return;
        }
        if (error instanceof ActivityRequestError && error.status === 401) {
          say({
            tone: "warning",
            text: "登录已失效，请重新登录。",
            action: "login",
          });
          return;
        }
        // 领取范围: outside it, nothing was written; the 红包 says who may.
        if (
          error instanceof ActivityRequestError &&
          error.code === "NOT_IN_SCOPE"
        ) {
          store.set(
            unconfirmedAtom,
            withClaim(store.get(unconfirmedAtom), activityId, null),
          );
          noteOutOfScope(store, activityId);
          return;
        }
        // Tokens kept failing: nothing was written, so nothing to retry.
        if (
          error instanceof ActivityRequestError &&
          error.code === "HUMAN_CHECK_REQUIRED"
        ) {
          say({ tone: "warning", text: "人机验证没有通过，请稍后再试。" });
          return;
        }
        // No answer, or the server failed: it may have gone through. Keep
        // the submission, so 重试原提交 asks about exactly it.
        if (!refused(error)) {
          store.set(
            unconfirmedAtom,
            withClaim(store.get(unconfirmedAtom), activityId, {
              password: password ?? "",
              submissionId: input.submissionId,
            }),
          );
          say({
            tone: "warning",
            text: `尚未确认${verb}结果，请重试原提交以确认结果。`,
          });
          return;
        }
        store.set(
          unconfirmedAtom,
          withClaim(store.get(unconfirmedAtom), activityId, null),
        );
        say({ tone: "warning", text: error.message });
      } finally {
        store.set(pendingAtom, false);
        if (code) {
          store.set(judgingAtom, null);
          if (!judged && !stale() && store.get(editDraftAtom) === "")
            store.set(editDraftAtom, typed);
        }
      }
    },
    [
      claimWithHumanCheck,
      collapse,
      guard,
      ownOf,
      queryClient,
      router,
      store,
      verbOf,
    ],
  );

  /**
   * 网页替你提交 (docs/judge-page-design.md §3.3, §11.8): `hb.submit()` from
   * a 代码判定红包's 附带网页, asked once per 红包 and site, then sent as
   * the box sends it — cooldown, human check, 自领 — its card on top of 我的
   * 提交. The page gets the outcome to word itself; the box's text and
   * message stay as they were, and a lost answer is not kept to retry (the
   * page reads hb.mine()).
   */
  const submitForPage = useCallback(
    async (
      activityId: string,
      typed: string,
      origin: string,
    ): Promise<PageSubmitResult> => {
      const account = sessionUserOf(queryClient);
      if (!account) {
        if (!store.get(maintenanceAtom)) openAccount();
        return notJudged("login");
      }
      const activity = queryClient.getQueryData<PublicActivityDetail>(
        activityKeys.public(activityId, account.id),
      )?.activity;
      if (activity?.participationMode !== "code") return notJudged("not_code");
      const checked = judgeAnswerSchema.safeParse(typed);
      if (!checked.success)
        return notJudged("invalid_input", {
          message: checked.error.issues[0]?.message ?? "请检查输入",
        });
      const waiting = () => {
        const left = attemptCooldownRemainingMs(account.id);
        return left > 0
          ? notJudged("cooldown", { seconds: Math.ceil(left / 1000) })
          : store.get(pendingAtom)
            ? notJudged("busy")
            : null;
      };
      const before = waiting();
      if (before) return before;
      if (
        !(await askPageSubmit(store, {
          userId: account.id,
          activityId,
          origin,
        })) ||
        (ownOf(activityId, account.id) && !(await askSelfClaim(store, false)))
      )
        return notJudged("denied");
      // Asked meanwhile: the box may have sent one, or the account changed.
      if (sessionUserOf(queryClient)?.id !== account.id)
        return notJudged("login");
      const after = waiting();
      if (after) return after;
      const input: ClaimActivityInput = {
        participationMode: "code",
        submissionId: crypto.randomUUID(),
        input: checked.data,
      };
      const href = router.history.location.href;
      const stale = () =>
        router.history.location.href !== href ||
        sessionUserOf(queryClient)?.id !== account.id;
      store.set(pendingAtom, true);
      store.set(rewardAnimationAtom, {
        activityId,
        token: input.submissionId,
      });
      store.set(judgingAtom, {
        activityId,
        input: checked.data,
        at: Date.now(),
      });
      try {
        const result = await claimWithHumanCheck(activityId, input, stale);
        if (!result) return notJudged("human_check");
        if (result.result === "claimed" || result.result === "rejected")
          await queryClient.invalidateQueries({
            queryKey: myJudgmentsKey(account.id, activityId),
          });
        switch (result.result) {
          case "claimed": {
            const balance = result.claim.activity.funding === "balance";
            if (balance)
              void queryClient.invalidateQueries({
                queryKey: sessionQueryKey,
              });
            const reply = result.claim.judge?.message;
            return {
              judged: true,
              claimed: true,
              amount: result.claim.amount,
              unit: balance ? "🐟" : "LDC",
              ...(reply ? { reply } : {}),
            };
          }
          case "rejected":
            return {
              judged: true,
              claimed: false,
              ...(result.message ? { reply: result.message } : {}),
            };
          case "already_claimed":
            return notJudged("already_claimed");
          case "draft":
            return notJudged("not_open");
          default:
            return notJudged("ended");
        }
      } catch (error) {
        if (!(error instanceof ActivityRequestError))
          return notJudged("unconfirmed");
        switch (error.code) {
          case "JUDGE_FAILED":
            return notJudged("judge_failed");
          case "CODE_PAUSED":
            void queryClient.invalidateQueries({
              queryKey: activityKeys.public(activityId, account.id),
            });
            return notJudged("paused");
          case "JUDGE_UNAVAILABLE":
          case "CODE_BUSY":
            return notJudged("try_later");
          case "NOT_IN_SCOPE":
            noteOutOfScope(store, activityId);
            return notJudged("not_in_scope");
          case "HUMAN_CHECK_REQUIRED":
            return notJudged("human_check");
        }
        if (error.status === 429) return notJudged("try_later");
        if (error.status === 401) return notJudged("login");
        if (!refused(error)) return notJudged("unconfirmed");
        return notJudged("error", { message: error.message });
      } finally {
        store.set(pendingAtom, false);
        store.set(judgingAtom, null);
      }
    },
    [claimWithHumanCheck, openAccount, ownOf, queryClient, router, store],
  );

  /**
   * 只填不交 (docs/judge-page-design.md §11.11): `hb.fill()` from any
   * 红包's 附带网页 puts its text in the box as the seal opens it, the
   * viewer sending it themselves. Nothing is asked of the server: what the
   * 红包 page can tell says why not, the rest waits for the send.
   */
  const fillForPage = useCallback(
    (activityId: string, text: string): PageFillResult => {
      if ([...text].length > 200)
        return notFilled("invalid_input", "最多 200 个字");
      if (/[\r\n]/.test(text)) return notFilled("invalid_input", "不能有换行");
      const account = sessionUserOf(queryClient);
      const activity = queryClient.getQueryData<PublicActivityDetail>(
        activityKeys.public(activityId, account?.id ?? null),
      )?.activity;
      if (activity?.participationMode === "direct")
        return notFilled("no_input");
      if (!account) {
        if (!store.get(maintenanceAtom)) openAccount();
        return notFilled("login");
      }
      if (!activity) return notFilled("away");
      const standing = pageStanding(
        activity,
        account,
        queryClient.getQueryData<ParticipationCache>(
          participationKey(account.id, activityId),
        ),
      );
      if (standing) return notFilled(standing);
      const code = activity.participationMode === "code";
      if (store.get(pendingAtom)) return notFilled("busy");
      expand({ id: activityId, purpose: code ? "code" : "claim" }, text);
      return { filled: true };
    },
    [expand, openAccount, queryClient, store],
  );

  /**
   * 验证其他口令: for someone who already took part. A correct 口令 is only
   * revealed to them (已解出); it never claims again. Shares the cooldown
   * with claiming, except for answers that need no check (06 §4).
   */
  const verifyIn = useCallback(
    async (activityId: string, password: string) => {
      if (store.get(pendingAtom)) return;
      if (!inspectPassword(password).valid) return;
      if (!guard()) return;
      const account = sessionUserOf(queryClient);
      if (!account) return;
      const known = queryClient.getQueryData<ActivityPasswords>(
        passwordKey(account.id, activityId),
      );
      if (known?.passwords.some((item) => item.text === password)) {
        store.set(messageAtom, {
          activityId,
          tone: "neutral",
          text: "你已经知道这个口令。",
        });
        return;
      }
      if (attemptCooldownRemainingMs(account.id) > 0) return;
      const href = router.history.location.href;
      store.set(pendingAtom, true);
      store.set(messageAtom, null);
      const say = (message: OmniMessage) => {
        hapticForTone(message.tone);
        store.set(messageAtom, { activityId, ...message });
      };
      try {
        const result = await solve.mutateAsync({
          id: activityId,
          input: { submissionId: crypto.randomUUID(), password },
        });
        if (
          router.history.location.href !== href ||
          sessionUserOf(queryClient)?.id !== account.id
        )
          return;
        if (result.outcome === "solved") {
          store.set(verifyNoticeAtom, {
            activityId,
            password,
            token: Date.now(),
          });
          if (router.history.location.state.omnibox) collapse();
          return;
        }
        if (result.outcome === "incorrect") {
          say({ tone: "danger", text: "口令不正确，请重新尝试。" });
          store.set(mismatchAtom, (count) => count + 1);
          return;
        }
        say({ tone: "neutral", text: "红包已结束，口令已公开。" });
      } catch (error) {
        if (error instanceof ActivityRequestError && error.status === 429)
          say({ tone: "warning", text: "尝试过于频繁，请稍后再试。" });
        else if (refused(error)) say({ tone: "warning", text: error.message });
        // Verifying changes nothing: a lost answer is simply tried again.
        else say({ tone: "warning", text: "没有收到验证结果，请再试一次。" });
      } finally {
        store.set(pendingAtom, false);
      }
    },
    [collapse, guard, queryClient, router, solve, store],
  );

  const runMessageAction = useCallback(
    (action: "login" | "global" | "square" | undefined) => {
      if (action === "login") {
        openAccount();
        return;
      }
      if (action === "square") {
        store.set(messageAtom, null);
        void leaveTo({ to: "/square" });
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
    [leaveTo, openAccount, router, runDiscover, store],
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
    submitForPage,
    fillForPage,
    verifyIn,
    openAccount,
    goHome,
    runMessageAction,
    setMessage,
  };
}
