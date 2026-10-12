import { passwordSchema } from "@hb/contracts";
import { useAtom, useSetAtom } from "jotai";
import { ArrowRight, LoaderCircle } from "lucide-react";
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ActivityRequestError } from "../../lib/activities";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { getAttemptTicket, settleAttempt } from "../../lib/attempt-history";
import { useAccountSession, useSession } from "../../lib/auth";
import {
  exchangeContextAtom,
  useGlobalRedemptionDiscovery,
  useRedemptionResult,
} from "../../lib/discovery";
import {
  classifyHomeEntry,
  HOME_ENTRY_HELP,
  HOME_ENTRY_LABEL,
  type HomeEntry,
} from "../../lib/home-entry";
import {
  useEntryNavigate,
  useHistoryOverlay,
  useViewState,
} from "../../lib/navigation-state";
import { isBlockingQueryError } from "../../lib/query-view";
import { redemptionIntentAtom } from "../../lib/redemption-intent";
import { OfficialConnectRequired } from "../auth/official-connect-required";
import { Help } from "../presentation/context-help";
import { RefreshNotice } from "../presentation/loading";
import { PasswordInput } from "../presentation/password-input";
import { RedemptionAction } from "../presentation/redemption-transition";
import { ActivityErrorView } from "./activity-error";
import { TopicMatches } from "./activity-locator";
import { ActivitySelection } from "./activity-selection";

export type GlobalExchangeHandle = { fillPassword: (password: string) => void };

export function GlobalExchange({ ref }: { ref?: Ref<GlobalExchangeHandle> }) {
  const session = useSession();
  const user = session.isSuccess ? session.data.user : null;
  const userId = user?.id ?? "";
  const accountTier = user?.accountTier ?? "standard";
  const csrfToken = session.data?.csrfToken ?? "";
  const identity = session.isSuccess ? `${userId}:${accountTier}` : null;
  const previousIdentity = useRef<string | null>(null);
  const selectionOverlay = useHistoryOverlay("redemption-selection");
  const locatorOverlay = useHistoryOverlay("locator-selection");
  const selectionOpen = Boolean(selectionOverlay.overlay);
  const setIntent = useSetAtom(redemptionIntentAtom);
  const [context, setContext] = useAtom(exchangeContextAtom);
  const ownContext =
    user && context?.userId === userId && context.accountTier === accountTier
      ? context
      : null;
  const suppressLocatorOverlay = useRef(false);
  const restoredEntry = locatorOverlay.overlay?.id
    ? classifyHomeEntry(locatorOverlay.overlay.id, window.location.origin)
    : null;
  const restoredTopic = restoredEntry?.kind === "topic" ? restoredEntry : null;
  const restoredTopicUrl = restoredTopic?.topicUrl ?? null;
  const [password, setPassword] = useState(
    ownContext?.password ?? restoredTopic?.topicUrl ?? "",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [officialRequired, setOfficialRequired] = useState(false);
  const [composing, setComposing] = useState(false);
  const [topic, setTopic] = useState<
    (Extract<HomeEntry, { kind: "topic" }> & { request: number }) | null
  >(null);
  const locationRequest = useRef(0);
  const previousLocatorOverlay = useRef(Boolean(locatorOverlay.overlay));

  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "redemption-selection-cursors",
    [null],
  );
  const trigger = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const mutation = useGlobalRedemptionDiscovery(userId, csrfToken);
  const account = useAccountSession(userId);
  const cooldown = useAttemptCooldown(userId);
  const resultQuery = useRedemptionResult(
    userId,
    ownContext?.resultId ?? null,
    cursors.at(-1) ?? null,
  );
  const navigate = useEntryNavigate();
  const uncertain = ownContext?.state === "unconfirmed";
  const entry = classifyHomeEntry(password, window.location.origin);
  const locating = !uncertain && !composing && entry.kind !== "password";
  const hasInput = password.length > 0;
  const blockedByCooldown =
    hasInput && !uncertain && !locating && cooldown.active;
  const seconds = blockedByCooldown ? cooldown.seconds : 0;
  const redemptionItems =
    resultQuery.data?.items.filter((item) => item.rewardType === "ldc") ?? [];
  const activeTopic =
    topic ??
    (!suppressLocatorOverlay.current && restoredTopic
      ? { ...restoredTopic, request: locationRequest.current }
      : null);

  function invalidateLocation() {
    locationRequest.current += 1;
    setTopic(null);
    if (locatorOverlay.overlay) {
      suppressLocatorOverlay.current = true;
      locatorOverlay.discard();
    }
  }
  function changeInput(value: string) {
    invalidateLocation();
    setPassword(value);
    setMessage(null);
    setOfficialRequired(false);
  }
  function browse(id: string) {
    setIntent(null);
    setContext(null);
    locationRequest.current += 1;
    void navigate({
      to: "/activities/$id",
      params: { id },
      replace: Boolean(locatorOverlay.overlay),
    });
  }
  useImperativeHandle(ref, () => ({
    fillPassword(value) {
      if (!account.isCurrentSession()) return;
      if (inFlight.current) {
        setMessage("当前尝试尚未完成，请稍后填入。");
        return;
      }
      if (
        ownContext?.state === "unconfirmed" &&
        !window.confirm(
          "上一笔尝试结果尚未确认。改填口令不会撤销它，是否继续？取消可保留原提交继续确认。",
        )
      )
        return;
      flushSync(() => {
        invalidateLocation();
        setContext(null);
        setIntent(null);
        setPassword(value);
        setMessage(null);
        setOfficialRequired(false);
      });
      document.getElementById("claim-password")?.focus();
    },
  }));
  useEffect(() => {
    if (selectionOpen && !ownContext?.resultId) selectionOverlay.discard();
  }, [selectionOpen, ownContext?.resultId, selectionOverlay.discard]);
  useEffect(() => {
    if (!identity) return;
    if (previousIdentity.current && previousIdentity.current !== identity) {
      locationRequest.current += 1;
      setTopic(null);
      setPassword("");
      setMessage(null);
      setOfficialRequired(false);
      setContext(null);
      setIntent(null);
      if (locatorOverlay.overlay) {
        suppressLocatorOverlay.current = true;
        locatorOverlay.discard();
      }
    }
    previousIdentity.current = identity;
  }, [
    identity,
    locatorOverlay.overlay,
    locatorOverlay.discard,
    setContext,
    setIntent,
  ]);
  useEffect(() => {
    const open = Boolean(locatorOverlay.overlay);
    if (previousLocatorOverlay.current && !open) {
      locationRequest.current += 1;
      setTopic(null);
    }
    if (!open) suppressLocatorOverlay.current = false;
    previousLocatorOverlay.current = open;
    if (restoredTopicUrl && !topic && !suppressLocatorOverlay.current)
      setPassword(restoredTopicUrl);
  }, [locatorOverlay.overlay, restoredTopicUrl, topic]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      !selectionOpen ||
      resultQuery.isPending ||
      isBlockingQueryError(resultQuery) ||
      !resultQuery.data ||
      redemptionItems.length > 0
    )
      return;
    selectionOverlay.discard();
    setContext(null);
    setIntent(null);
    setMessage("未匹配到活动。");
  }, [
    redemptionItems.length,
    resultQuery,
    resultQuery.data,
    resultQuery.isPending,
    selectionOpen,
    selectionOverlay.discard,
    setContext,
    setIntent,
  ]);
  async function submit() {
    if (inFlight.current || composing) return;
    if (!hasInput && !uncertain) return;
    if (locating) {
      invalidateLocation();
      setMessage(null);
      setOfficialRequired(false);
      if (entry.kind === "activity") browse(entry.id);
      else if (entry.kind === "topic")
        setTopic({ ...entry, request: locationRequest.current });
      return;
    }
    if (blockedByCooldown || !session.isSuccess) return;
    const checked = passwordSchema.safeParse(password);
    if (!uncertain && !checked.success) {
      setMessage(checked.error.issues[0]?.message ?? "请检查兑换口令。");
      return;
    }
    if (!user || !csrfToken) {
      setMessage("请先登录。");
      return;
    }
    if (!account.isCurrentSession()) return;
    if (!user.canUseLdc) {
      setOfficialRequired(true);
      return;
    }
    invalidateLocation();
    const submission = uncertain
      ? ownContext.submission
      : {
          submissionId: crypto.randomUUID(),
          password: checked.success ? checked.data : password,
        };
    setMessage(null);
    setIntent(null);
    if (selectionOverlay.overlay) selectionOverlay.close();
    setOfficialRequired(false);
    const identity = account.captureIdentity();
    setContext({
      userId,
      accountTier,
      password: submission.password,
      submission,
      claimSubmissionId: uncertain ? ownContext.claimSubmissionId : null,
      resultId: null,
      state: "unconfirmed",
      selectedActivityId: null,
    });
    setCursors([null]);
    inFlight.current = true;
    try {
      const result = await mutation.mutateAsync(submission);
      if (!alive.current || !account.isCurrentIdentity(identity)) return;
      const selected =
        result.selectedActivityId ??
        (result.result === "single" ? (result.items[0]?.id ?? null) : null);
      setContext({
        userId,
        accountTier,
        password: submission.password,
        submission,
        claimSubmissionId: result.claimSubmissionId,
        resultId: result.id,
        state: "resolved",
        selectedActivityId: selected,
      });
      if (selected) {
        setContext({
          userId,
          accountTier,
          password: submission.password,
          submission,
          claimSubmissionId: result.claimSubmissionId,
          resultId: result.id,
          state: "resolved",
          selectedActivityId: selected,
        });
        if (!result.claimResult)
          setIntent({
            userId,
            accountTier,
            activityId: selected,
            operation: {
              submissionId: result.claimSubmissionId,
              discoveryId: result.id,
              password: submission.password,
            },
          });
        void navigate({ to: "/activities/$id", params: { id: selected } });
      } else if (result.result === "multiple" && result.items.length)
        selectionOverlay.open(result.id);
      else setMessage("未匹配到活动。");
    } catch (error) {
      if (!alive.current || !account.isCurrentIdentity(identity)) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        setContext(null);
        setMessage("尝试过于频繁，请稍后再试。");
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        setMessage("尚未确认兑换结果，请重试原提交，不会重新选择其他活动。");
      } else {
        setContext(null);
        if (error.code === "OFFICIAL_CONNECT_REQUIRED")
          setOfficialRequired(true);
        else setMessage(error.message);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          trigger.current =
            event.currentTarget.querySelector<HTMLButtonElement>(
              'button[type="submit"]',
            );
          void submit();
        }}
      >
        <PasswordInput
          id="claim-password"
          label={HOME_ENTRY_LABEL}
          hideLabel
          placeholder=""
          hintMode="invalid"
          help={<Help label="口令输入">{HOME_ENTRY_HELP}</Help>}
          mode={locating ? "locator" : "password"}
          sharedFrame
          value={password}
          onChange={changeInput}
          onCompositionChange={setComposing}
          disabled={mutation.isPending || uncertain}
          onSubmit={() => {
            trigger.current = document.querySelector<HTMLButtonElement>(
              '[data-redemption-action="true"]',
            );
            void submit();
          }}
        />
        {message ? (
          <p role="status" className="form-message">
            {message}
          </p>
        ) : null}
        {officialRequired ? (
          <OfficialConnectRequired
            returnTo="/"
            message="青春版可以跳转查看活动；兑奖需要使用官方 Connect 升级后重新提交口令。"
          />
        ) : null}
        {uncertain && !mutation.isPending && !message ? (
          <p role="status" className="form-message">
            上次提交结果尚未确认，请重试原提交。
          </p>
        ) : null}
        {seconds > 0 ? (
          <p role="timer" className="form-message">
            {seconds} 秒后可重试
          </p>
        ) : null}
        {(hasInput || uncertain || mutation.isPending) && (
          <RedemptionAction
            className="button claim-button"
            type="submit"
            disabled={
              mutation.isPending ||
              composing ||
              blockedByCooldown ||
              (!locating && !session.isSuccess)
            }
          >
            {mutation.isPending && (
              <LoaderCircle size={18} className="spin" aria-hidden="true" />
            )}
            {mutation.isPending
              ? "正在确认…"
              : uncertain
                ? "再次确认"
                : locating
                  ? "跳转活动"
                  : "兑奖"}
            <ArrowRight size={17} aria-hidden="true" />
          </RedemptionAction>
        )}
      </form>
      {session.isPending && (
        <p role="status" className="form-message">
          正在确认登录状态…
        </p>
      )}
      {session.isError && (
        <ActivityErrorView
          error={session.error}
          retry={() => session.refetch()}
        />
      )}
      {activeTopic && session.isSuccess && (
        <TopicMatches
          key={`${userId}:${activeTopic.request}`}
          topic={activeTopic}
          userId={user?.id ?? null}
          restoring={Boolean(locatorOverlay.overlay)}
          restoreFocus={trigger.current}
          isCurrent={() =>
            alive.current && activeTopic.request === locationRequest.current
          }
          onMultiple={() => {
            if (activeTopic.request === locationRequest.current)
              locatorOverlay.open(activeTopic.topicUrl);
          }}
          onClose={(selected) => {
            if (!selected) {
              suppressLocatorOverlay.current = true;
              locationRequest.current += 1;
              setTopic(null);
              locatorOverlay.close();
            }
          }}
          onSelect={(id) => {
            if (activeTopic.request === locationRequest.current) browse(id);
          }}
        />
      )}
      {selectionOpen && ownContext?.resultId && (
        <ActivitySelection
          total={resultQuery.data?.total}
          title="选择要兑奖的活动"
          refreshNotice={<RefreshNotice query={resultQuery} />}
          restoreFocus={trigger.current}
          items={redemptionItems}
          pending={resultQuery.isPending}
          error={isBlockingQueryError(resultQuery) ? resultQuery.error : null}
          retry={() => {
            void resultQuery.refetch();
          }}
          cursors={cursors}
          setCursors={setCursors}
          nextCursor={resultQuery.data?.nextCursor ?? null}
          onClose={(selected) => {
            if (!selected) selectionOverlay.close();
          }}
          onSelect={(id) => {
            const activitySubmissionId = ownContext.claimSubmissionId;
            if (!activitySubmissionId) {
              setMessage("兑换状态已过期，请重新提交口令。");
              selectionOverlay.close();
              return;
            }
            const ticket = ownContext.resultId
              ? getAttemptTicket(userId, ownContext.resultId)
              : undefined;
            if (ticket) void settleAttempt(ticket, true, [id]);
            setContext((current) =>
              current?.userId === userId
                ? { ...current, selectedActivityId: id }
                : current,
            );
            setIntent({
              userId,
              accountTier,
              activityId: id,
              operation: {
                submissionId: activitySubmissionId,
                discoveryId: ownContext.resultId ?? undefined,
                password: ownContext.password,
              },
            });
            void navigate({
              to: "/activities/$id",
              params: { id },
              replace: true,
            });
          }}
        />
      )}
    </>
  );
}
