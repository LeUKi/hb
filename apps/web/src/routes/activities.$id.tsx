import type {
  ActivityImageViewerState,
  ActivityRewardSummary,
  ClaimDetail,
  ManagedActivity,
  PublicActivity,
  RegistrationDetail,
} from "@hb/contracts";
import { activityImagePresentation, paymentLabel } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ActivityShare } from "../components/activities/activity-share";
import { AttemptStatisticsDialog } from "../components/activities/attempt-statistics-dialog";
import { ClaimEntry } from "../components/activities/claim-entry";
import { PasswordPanel } from "../components/activities/password-panel";
import { PublicRoster } from "../components/activities/public-roster";
import { ActionMenu } from "../components/presentation/action-menu";
import {
  ActivityHeadingSkeleton,
  ActivityRegion,
} from "../components/presentation/activity-layout";
import {
  ActivityNoteSection,
  ActivityNotes,
} from "../components/presentation/activity-notes";
import { Help } from "../components/presentation/context-help";
import {
  Envelope,
  type EnvelopeReward,
} from "../components/presentation/envelope";
import {
  RefreshNotice,
  SkeletonRows,
} from "../components/presentation/loading";
import { useActivityEntryToken } from "../components/presentation/redemption-transition";
import { useActionFeedback } from "../components/ui/action-feedback";
import { UserIdentity } from "../components/user-identity";
import {
  ActivityRequestError,
  activityKeys,
  quantityText,
  statusLabels,
  useActivityWrites,
  useManagedActivity,
  usePublicActivity,
} from "../lib/activities";
import { useActivityPasswords } from "../lib/activity-passwords";
import { activityToolsEnabled } from "../lib/activity-tools-release";
import {
  type SessionResponse,
  sessionIdentity,
  sessionScope,
  useSession,
} from "../lib/auth";
import { useCurrentParticipation } from "../lib/claims";
import {
  formatCountdownDuration,
  formatFullDateTime,
  useNow,
} from "../lib/clock";
import { isDirectParticipation } from "../lib/direct-participation";
import { exchangeContextAtom } from "../lib/discovery";
import { useHistoryOverlay, useViewState } from "../lib/navigation-state";
import {
  hasParticipation,
  isCompleteParticipation,
} from "../lib/participation-cache";
import { paymentReason } from "../lib/payment-display";
import {
  type PublicRosterQuery,
  type PublicRosterTab,
  usePublicRoster,
} from "../lib/public-roster";
import { isBlockingQueryError } from "../lib/query-view";
import {
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../lib/redemption-intent";

export const Route = createFileRoute("/activities/$id")({
  component: PublicActivityPage,
});
type Member = NonNullable<SessionResponse["user"]>;
function PublicActivityPage() {
  const { id } = Route.useParams();
  const client = useQueryClient();
  const session = useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const user = session.isError ? undefined : (session.data?.user ?? undefined);
  // Begin identity-bound reads after commit, so StrictMode's initial discarded
  // mount does not cancel and repeat a request when session data arrives first.
  const identityReady = mounted && !session.isPending && !session.isError;
  const presentationIdentity = identityReady
    ? sessionScope(session.data)
    : "unconfirmed";
  const presentationSession = useRef<{
    confirmed?: string;
    generation: number;
  }>({ generation: 0 });
  if (identityReady) {
    // The initial confirmation fills the existing loading shell. Only a later
    // login-session change replaces private page state and pending callbacks.
    if (
      presentationSession.current.confirmed !== undefined &&
      presentationSession.current.confirmed !== presentationIdentity
    )
      presentationSession.current.generation += 1;
    presentationSession.current.confirmed = presentationIdentity;
  }
  const authenticated =
    identityReady && Boolean(user && session.data?.csrfToken);
  const rosterOverlay = useHistoryOverlay("roster");
  const setExchangeContext = useSetAtom(exchangeContextAtom);
  const setRedemptionIntent = useSetAtom(redemptionIntentAtom);
  const roster = rosterOverlay.overlay?.id === id;
  const cachedDetail = client.getQueryData<{ activity: PublicActivity }>(
    activityKeys.public(id, user?.id ?? null),
  );
  // A cold overlay first reads detail to select the draw's default tab.
  const detail = usePublicActivity(
    id,
    user?.id ?? null,
    identityReady && (!roster || !cachedDetail?.activity),
  );
  const baseActivity =
    !session.isError && !isBlockingQueryError(detail)
      ? detail.data?.activity
      : undefined;
  const identity = sessionIdentity(user ?? null);
  const cachedManagedActivity = user
    ? client.getQueryData<{ activity: ManagedActivity }>(
        activityKeys.detail(user.id, id),
      )?.activity
    : undefined;
  const cachedAuthorAccess = cachedManagedActivity?.author.id === user?.id;
  const managed = useManagedActivity(
    user?.id ?? "",
    id,
    authenticated &&
      baseActivity?.author.id === user?.id &&
      !(roster && cachedAuthorAccess),
  );
  const managedActivity = managed.data?.activity;
  const authorActivity =
    managedActivity?.author.id === user?.id ? managedActivity : undefined;
  const rosterView = authorActivity ? "author" : "public";
  const complete =
    baseActivity?.draw?.state === "completed" ||
    baseActivity?.draw?.state === "empty";
  const [storedTab, setRosterTab] = useViewState<PublicRosterTab>(
    "roster-tab",
    baseActivity?.draw && !complete ? "registrations" : "recipients",
    `${id}:${identity ?? "guest"}:${rosterView}:${baseActivity ? "ready" : "pending"}`,
  );
  const rosterTab =
    baseActivity?.draw && storedTab === "registrations"
      ? "registrations"
      : "recipients";
  const [cursors, setCursors] = useViewState<Array<string | null>>(
    "roster-pages",
    [null],
    `${id}:${identity ?? "guest"}:${rosterView}:${rosterTab}`,
  );
  const rosterQuery = usePublicRoster({
    activity: baseActivity,
    detailGeneration: detail.data?.readGeneration ?? 0,
    activityId: id,
    userId: user?.id ?? null,
    identity,
    view: rosterView,
    tab: rosterTab,
    enabled: identityReady && roster && Boolean(baseActivity),
    restoredPageCount: cursors.length,
  });
  useLayoutEffect(() => {
    if (!roster || !rosterQuery.data) return;
    const next = rosterQuery.data.pageParams;
    setCursors((current) =>
      current.length === next.length &&
      current.every((cursor, index) => cursor === next[index])
        ? current
        : next,
    );
  }, [roster, rosterQuery.data, setCursors]);
  const query = roster && baseActivity ? rosterQuery : detail;
  const activity =
    !session.isError && !isBlockingQueryError(query)
      ? roster
        ? (rosterQuery.data?.activity ?? baseActivity)
        : detail.data?.activity
      : undefined;
  const current = useCurrentParticipation(
    user?.id ?? "",
    id,
    authenticated && Boolean(baseActivity),
    activity?.draw?.state,
  );
  const passwords = useActivityPasswords(
    user?.id ?? null,
    id,
    identityReady,
    (activity ?? cachedDetail?.activity)?.participationMode,
  );
  const participationError = authenticated && isBlockingQueryError(current);
  const participationPending =
    authenticated &&
    !participationError &&
    !isCompleteParticipation(current.data) &&
    !hasParticipation(current.data);
  const claim =
    !authenticated || participationPending || participationError
      ? undefined
      : (current.data?.claim ?? current.data?.registration?.claim ?? null);
  const error =
    session.error ?? (isBlockingQueryError(query) ? query.error : null);
  useEffect(() => {
    if (!(error instanceof ActivityRequestError) || error.status !== 404)
      return;
    setExchangeContext((context) =>
      context?.selectedActivityId === id ? null : context,
    );
    setRedemptionIntent((intent) =>
      intent?.activityId === id ? null : intent,
    );
    if (rosterOverlay.overlay?.id === id) rosterOverlay.discard();
  }, [
    error,
    id,
    rosterOverlay.overlay,
    rosterOverlay.discard,
    setExchangeContext,
    setRedemptionIntent,
  ]);
  return (
    <ActivityPageBody
      key={`${id}:${presentationSession.current.generation}`}
      id={id}
      activity={activity}
      snapshotAt={
        query.data?.readAt ?? detail.data?.readAt ?? query.dataUpdatedAt
      }
      participationReadAt={current.data?.readAt}
      presentationIdentity={presentationIdentity}
      loading={!error && (session.isPending || (query.isPending && !activity))}
      pageNotice={
        error ? (
          <ActivityErrorView
            error={error}
            retry={() => {
              void (session.error ? session.refetch() : query.refetch());
            }}
          />
        ) : (
          <RefreshNotice query={query} />
        )
      }
      user={user}
      csrfToken={
        authenticated ? (session.data?.csrfToken ?? undefined) : undefined
      }
      claim={activity ? claim : undefined}
      passwords={passwords}
      registration={
        authenticated &&
        activity?.draw &&
        !participationPending &&
        !participationError
          ? (current.data?.registration ?? null)
          : undefined
      }
      participationPending={participationPending}
      participationError={participationError ? current.error : null}
      participationNotice={
        authenticated ? <RefreshNotice query={current} /> : null
      }
      onParticipationRetry={() => {
        void current.refetch();
      }}
      rosterOverlay={rosterOverlay}
      rosterQuery={rosterQuery}
      rosterTab={rosterTab}
      setRosterTab={setRosterTab}
      authorActivity={authorActivity}
      authorAccessPending={
        authenticated &&
        baseActivity?.author.id === user?.id &&
        managed.isPending
      }
      onAuthorActivityRefresh={() => {
        void managed.refetch();
      }}
    />
  );
}
function ActivityPageBody({
  id,
  activity,
  snapshotAt,
  participationReadAt,
  presentationIdentity,
  loading,
  pageNotice,
  user,
  csrfToken,
  claim,
  passwords,
  registration,
  participationPending = false,
  participationError = null,
  participationNotice,
  onParticipationRetry,
  rosterOverlay,
  rosterQuery,
  rosterTab,
  setRosterTab,
  authorActivity,
  authorAccessPending = false,
  onAuthorActivityRefresh,
}: {
  id: string;
  activity?: PublicActivity;
  snapshotAt: number;
  participationReadAt?: number;
  presentationIdentity: string;
  loading: boolean;
  pageNotice: ReactNode;
  user?: Member;
  csrfToken?: string;
  claim?: ClaimDetail | null;
  passwords: ReturnType<typeof useActivityPasswords>;
  registration?: RegistrationDetail | null;
  participationPending?: boolean;
  participationError?: Error | null;
  participationNotice?: ReactNode;
  onParticipationRetry?: () => void;
  rosterOverlay: ReturnType<typeof useHistoryOverlay>;
  rosterQuery: PublicRosterQuery;
  rosterTab: PublicRosterTab;
  setRosterTab: Dispatch<SetStateAction<PublicRosterTab>>;
  authorActivity?: ManagedActivity;
  authorAccessPending?: boolean;
  onAuthorActivityRefresh: () => void;
}) {
  const router = useRouter();
  const roster = rosterOverlay.overlay?.id === id;
  const rosterReturnFocus = useRef<Element | null>(null);
  const exchange = useAtomValue(exchangeContextAtom);
  const intent = useAtomValue(redemptionIntentAtom);
  const animation = useAtomValue(rewardAnimationAtom);
  const entryToken = useActivityEntryToken(id);
  const reducedMotion = useReducedMotion();
  const now = useNow();
  const main = useRef<HTMLElement>(null);
  const expired = Boolean(
    activity?.deadlineAt && Date.parse(activity.deadlineAt) <= now,
  );
  const drawing =
    activity?.draw?.state === "settling" || registration?.status === "drawing";
  const ended = activity?.status === "ended" || activity?.status === "archived";
  const direct = isDirectParticipation(activity);
  let sentence = activity?.draw
    ? direct
      ? "无需口令，报名参与开奖。"
      : "输入口令，报名参与开奖。"
    : direct
      ? "无需口令，领取本次奖励。"
      : "输入口令，兑换本次奖励。";
  const participationUnavailable =
    participationPending || Boolean(participationError);
  if (participationError) sentence = "参与记录读取失败。";
  else if (claim)
    sentence = registration?.status === "won" ? "已中奖。" : "兑换成功。";
  else if (drawing) sentence = "报名已截止，正在开奖。";
  else if (registration?.status === "not_won") sentence = "本次未中奖。";
  else if (ended)
    sentence =
      activity?.status === "archived" ? "本次活动已归档。" : "本次活动已结束。";
  else if (registration) sentence = "报名已确认，等待开奖。";
  else if (activity?.status === "draft") sentence = "活动尚未开放。";
  else if (expired)
    sentence = activity?.draw
      ? "报名已截止，等待开奖。"
      : "活动已截止，不能继续兑换。";
  const reward: EnvelopeReward | undefined = !activity
    ? undefined
    : claim
      ? { kind: "ldc", amount: claim.amount }
      : registration?.status === "not_won"
        ? { kind: "not-won" }
        : ended && !participationUnavailable
          ? { kind: activity?.draw ? "missed" : "ended" }
          : undefined;
  const noteContext = `${id}:${user?.id ?? "guest"}:${activity?.status}:${Boolean(claim)}:${registration?.status ?? ""}`;
  const fromMatching =
    !direct &&
    exchange?.sessionScope === presentationIdentity &&
    exchange?.userId === user?.id &&
    exchange?.accountTier === user?.accountTier &&
    exchange?.selectedActivityId === id;
  const awaiting =
    (!direct && intent?.activityId === id) ||
    Boolean(fromMatching && !claim && !registration);
  const imageViewer: ActivityImageViewerState = participationError
    ? { kind: "error" }
    : participationPending
      ? { kind: "loading" }
      : claim
        ? {
            kind: "claimed",
            amount: claim.amount,
            claimedAt: claim.claimedAt,
            paymentStatus: claim.payment?.status,
          }
        : registration?.status === "not_won"
          ? { kind: "not_won" }
          : drawing
            ? { kind: "drawing" }
            : registration
              ? { kind: "registered", registeredAt: registration.registeredAt }
              : ended || expired
                ? { kind: "ended" }
                : activity?.status === "draft"
                  ? { kind: "unavailable" }
                  : awaiting
                    ? { kind: "pending" }
                    : user?.accountTier === "standard" &&
                        user.canUseLdc &&
                        user.id !== activity?.author.id &&
                        csrfToken
                      ? {
                          kind: "eligible",
                          action: activity?.draw ? "register" : "claim",
                        }
                      : { kind: "public" };
  const privateImageState =
    imageViewer.kind === "claimed" ||
    imageViewer.kind === "registered" ||
    imageViewer.kind === "not_won" ||
    (imageViewer.kind === "drawing" && registration?.status === "drawing");
  const imageReadAt = privateImageState
    ? (participationReadAt ?? snapshotAt)
    : snapshotAt;
  const image = activity
    ? {
        ...activityImagePresentation({
          activity,
          viewer: imageViewer,
          updatedAt: new Date(imageReadAt),
        }),
        ...(activity.status === "draft" ? { sealLabel: "预览" } : {}),
      }
    : undefined;
  const rosterLabel = activity?.draw
    ? activity?.draw.state === "completed" || activity?.draw.state === "empty"
      ? "查看中奖名单"
      : "查看报名名单"
    : "查看领取名单";
  const canOpenRoster = Boolean(activity?.showRecipientList || authorActivity);
  const countdown =
    activity?.status === "active" && !expired && activity?.deadlineAt
      ? formatCountdownDuration(Date.parse(activity?.deadlineAt) - now)
      : null;
  const layoutAnimation = reducedMotion ? undefined : ("position" as const);
  const layoutTransition = reducedMotion
    ? undefined
    : { layout: { duration: 0.22, ease: "easeOut" as const } };
  function openRoster() {
    rosterReturnFocus.current = document.activeElement;
    rosterOverlay.open(id);
  }
  function closeRoster() {
    rosterOverlay.close();
    const restore = () => {
      const fallback =
        document.querySelector<HTMLButtonElement>(".envelope-roster-link") ??
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            'button[aria-haspopup="dialog"]',
          ),
        ).find((button) => button.textContent?.trim() === rosterLabel);
      const target =
        rosterReturnFocus.current instanceof HTMLElement &&
        rosterReturnFocus.current.isConnected
          ? rosterReturnFocus.current
          : fallback;
      target?.focus({ preventScroll: true });
    };
    window.setTimeout(restore, 0);
    window.setTimeout(restore, 80);
  }
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, []);
  return (
    <LayoutGroup id={`activity:${id}`}>
      <article
        className="activity-page"
        ref={main}
        tabIndex={-1}
        aria-busy={loading || participationPending}
        data-entry-ready={!loading && !participationPending}
      >
        <ActivityRegion as="header" className="activity-heading">
          {activity ? (
            <>
              <div className="activity-title-row">
                <button
                  type="button"
                  className="compact-icon-button activity-back-button"
                  onClick={() => router.history.back()}
                  aria-label="返回上一页"
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                </button>
                <h1>{activity.title || "未命名活动"}</h1>
                {(activityToolsEnabled ||
                  (user &&
                    activity.author.id === user.id &&
                    activity.status !== "draft")) && (
                  <div className="activity-title-actions">
                    <ActivityShare
                      key={`${sessionIdentity(user ?? null) ?? "guest"}:${id}`}
                      activity={activity}
                      identity={sessionIdentity(user ?? null)}
                      userId={user?.id ?? null}
                      passwords={passwords}
                    />
                    {user && activity.author.id === user.id && csrfToken && (
                      <AuthorActions
                        activity={activity}
                        managedActivity={authorActivity}
                        userId={user.id}
                        csrfToken={csrfToken}
                        pending={authorAccessPending}
                        onRefresh={onAuthorActivityRefresh}
                      />
                    )}
                  </div>
                )}
              </div>
              <div className="activity-meta">
                <UserIdentity
                  profile={activity.author}
                  className="user-identity"
                />
                <span className="activity-reward-kind">
                  {activity.draw ? "限时开奖" : "LDC"}
                </span>
                {rewardSummaryText(activity.reward) && (
                  <span>{rewardSummaryText(activity.reward)}</span>
                )}
                <span className="activity-quantity">
                  {quantityText(
                    activity.quantity,
                    activity.draw ? "draw" : "instant",
                  ) ?? "数量不公开"}
                </span>
                {!countdown && (
                  <span>
                    {drawing
                      ? "正在开奖"
                      : expired && !ended
                        ? "已截止"
                        : statusLabels[activity.status]}
                  </span>
                )}
                {countdown && activity.deadlineAt && (
                  <div className="activity-deadline">
                    <span
                      className="activity-countdown"
                      role="timer"
                      aria-label={
                        activity.draw ? "开奖倒计时" : "活动结束倒计时"
                      }
                      aria-live="off"
                    >
                      <span>{activity.draw ? "距开奖" : "距结束"}</span>
                      <span className="activity-countdown__value">
                        {countdown}
                      </span>
                    </span>
                    <Help label="截止时间说明">
                      {activity.draw ? "最晚开奖" : "截止时间"}：
                      {formatFullDateTime(activity.deadlineAt)}
                    </Help>
                  </div>
                )}
                {activity.topicUrl && (
                  <a
                    href={activity.topicUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    关联论坛帖子
                  </a>
                )}
              </div>
            </>
          ) : loading ? (
            <ActivityHeadingSkeleton />
          ) : (
            <div className="activity-title-row">
              <button
                type="button"
                className="compact-icon-button activity-back-button"
                onClick={() => router.history.back()}
                aria-label="返回上一页"
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <h1>活动页</h1>
            </div>
          )}
        </ActivityRegion>
        <ActivityRegion>
          {activity?.status === "draft" && (
            <p className="form-message">准备中预览，仅作者可见。</p>
          )}
          {pageNotice}
        </ActivityRegion>
        <motion.section
          className={`claim-layout ${claim ? "has-reward" : ""}`}
          layout={layoutAnimation}
          transition={layoutTransition}
        >
          <motion.div
            className="claim-art"
            layout={layoutAnimation}
            transition={layoutTransition}
          >
            <Envelope
              open={Boolean(reward)}
              reward={reward}
              presentation={image}
              presentationIdentity={presentationIdentity}
              author={activity?.author}
              waiting={Boolean(registration) && !reward}
              reserveResultSpace={
                !activity ||
                participationUnavailable ||
                (awaiting && !activity.draw)
              }
              entryToken={entryToken}
              animationToken={
                animation?.activityId === id ? animation.token : null
              }
              payment={claim?.payment}
              onOpenRoster={canOpenRoster ? openRoster : undefined}
              rosterLabel={rosterLabel}
            />
          </motion.div>
          <ActivityRegion className="claim-copy">
            {activity && !participationPending ? (
              <>
                <p className="activity-status-copy">{sentence}</p>
                {participationNotice}
                {canOpenRoster && !reward && (
                  <button
                    className="text-button roster-entry"
                    type="button"
                    aria-haspopup="dialog"
                    onClick={openRoster}
                  >
                    {rosterLabel}
                  </button>
                )}
                {!claim && (
                  <ActivityNotes
                    key={noteContext}
                    before={activity.beforeInfo}
                    author={activity.author}
                  />
                )}
                {claim ? (
                  ["waiting", "attention"].includes(claim.payment.status) ? (
                    <p className="eligibility-note">
                      {claim.payment.reason
                        ? paymentReason(claim.payment.reason)
                        : paymentLabel(
                            claim.payment.mode,
                            claim.payment.status,
                          )}
                    </p>
                  ) : null
                ) : registration ? (
                  <div className="draw-ticket">
                    <span>
                      报名时间
                      <b>{formatFullDateTime(registration.registeredAt)}</b>
                    </span>
                    <span>
                      最晚开奖
                      <b>{formatFullDateTime(registration.drawAt)}</b>
                    </span>
                  </div>
                ) : null}
                {user && csrfToken ? (
                  <ClaimEntry
                    key={`${user.id}:${id}`}
                    activity={activity}
                    userId={user.id}
                    accountTier={user.accountTier}
                    csrfToken={csrfToken}
                    canUseLdc={user.canUseLdc}
                    initialPassword={
                      fromMatching ? exchange?.password : undefined
                    }
                    hideResult
                    knownClaim={claim ?? null}
                    knownRegistration={registration ?? null}
                    participationPending={participationPending}
                    participationError={participationError}
                    onParticipationRetry={onParticipationRetry}
                  />
                ) : activity.status === "active" ? (
                  <div className="eligibility-note">
                    <p>请先登录。</p>
                    <Link
                      className="button"
                      to="/account"
                      search={{ returnTo: `/activities/${id}` }}
                    >
                      登录领取 <ArrowRight size={17} />
                    </Link>
                  </div>
                ) : null}
                {claim && (
                  <ActivityNotes
                    key={noteContext}
                    before={activity.beforeInfo}
                    after={claim.afterClaimInfo}
                    author={activity.author}
                  />
                )}
                {registration && !claim && (
                  <Link className="button secondary" to="/my/claims">
                    查看我的参与
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                )}
              </>
            ) : (
              <div aria-busy={loading || participationPending}>
                {(loading || participationPending) && (
                  <>
                    <span role="status" className="sr-only">
                      {participationPending
                        ? "正在读取你的参与记录…"
                        : "正在读取活动…"}
                    </span>
                    <SkeletonRows />
                  </>
                )}
              </div>
            )}
          </ActivityRegion>
        </motion.section>
        {!direct && (
          <motion.div
            data-layout-region="password-panel"
            layout={layoutAnimation}
            transition={layoutTransition}
          >
            <ActivityRegion>
              <PasswordPanel
                activity={activity}
                activityId={id}
                placeholderPending={loading}
                query={passwords}
                userId={user?.id ?? null}
                csrfToken={csrfToken ?? null}
              />
            </ActivityRegion>
          </motion.div>
        )}
        {activity && roster && (
          <PublicRoster
            activity={activity}
            query={rosterQuery}
            tab={rosterTab}
            setTab={setRosterTab}
            onClose={closeRoster}
            restoreFocus={rosterReturnFocus.current}
            restoreFocusLabel={rosterLabel}
          />
        )}
        <ActivityRegion className="activity-ended-region">
          {activity?.afterEndInfo && (
            <ActivityNoteSection
              key={`${noteContext}:end`}
              stage="ended"
              content={activity.afterEndInfo}
              author={activity.author}
            />
          )}
        </ActivityRegion>
      </article>
    </LayoutGroup>
  );
}

function rewardSummaryText(reward: ActivityRewardSummary | undefined) {
  if (!reward) return null;
  if (reward.unitAmount) return `${reward.unitAmount} LDC / 份`;
  if (reward.totalAmount) return `${reward.totalAmount} LDC 奖池`;
  return null;
}

function AuthorActions({
  activity,
  managedActivity,
  userId,
  csrfToken,
  pending,
  onRefresh,
}: {
  activity: PublicActivity;
  managedActivity?: ManagedActivity;
  userId: string;
  csrfToken: string;
  pending: boolean;
  onRefresh: () => void;
}) {
  const writes = useActivityWrites(userId, csrfToken, activity.id);
  const statisticsOverlay = useHistoryOverlay("statistics");
  const statisticsOpen = statisticsOverlay.overlay?.id === activity.id;
  const statisticsOpener = useRef<Element | null>(null);
  const mounted = useRef(true);
  const endFeedback = useActionFeedback(
    `${userId}:${csrfToken}:${activity.id}`,
  );
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  if (pending)
    return <span className="activity-action-skeleton" aria-hidden="true" />;
  if (!managedActivity || managedActivity.author.id !== userId) return null;
  const saved = managedActivity;
  const canEnd =
    saved.status === "active" &&
    saved.claimedCount === 0 &&
    (!saved.draw || saved.draw.registeredCount === 0);
  async function endActivity() {
    if (writes.end.isPending) return;
    if (!window.confirm("提前结束活动后不能继续领取或报名，是否继续？")) return;
    endFeedback.clear();
    try {
      await writes.end.mutateAsync({ version: saved.version });
      if (!mounted.current) return;
      endFeedback.show("已结束");
    } catch (error) {
      if (!mounted.current) return;
      const message =
        error instanceof Error ? error.message : "提前结束失败，请重试。";
      endFeedback.show("结束失败", message);
      onRefresh();
    }
  }
  if (saved.status === "draft") return null;
  return (
    <>
      <ActionMenu
        label="管理活动"
        disabled={writes.end.isPending}
        items={[
          {
            label: "编辑配置",
            href: `/my/activities/${encodeURIComponent(activity.id)}`,
          },
          ...(activity.rewardType === "ldc"
            ? [
                {
                  label: "付款记录",
                  href: `/my/payments?activityId=${encodeURIComponent(activity.id)}`,
                },
              ]
            : []),
          ...(saved.config.forceDedicated
            ? [
                {
                  label: "兑换尝试统计",
                  onSelect: () => {
                    statisticsOpener.current = document.activeElement;
                    statisticsOverlay.open(activity.id);
                  },
                },
              ]
            : []),
          ...(canEnd || endFeedback.feedback || writes.end.isPending
            ? [
                {
                  label: "提前结束",
                  feedback: writes.end.isPending
                    ? { label: "正在结束…" }
                    : endFeedback.feedback,
                  reserve: ["正在结束…", "结束失败"],
                  keepOpen: true,
                  disabled: writes.end.isPending || !canEnd,
                  onSelect: () => {
                    void endActivity();
                  },
                },
              ]
            : []),
        ]}
      />
      {statisticsOpen && saved.config.forceDedicated && (
        <AttemptStatisticsDialog
          key={`${userId}:${activity.id}`}
          userId={userId}
          activityId={activity.id}
          title={activity.title}
          restoreFocus={statisticsOpener.current}
          onClose={statisticsOverlay.close}
        />
      )}
    </>
  );
}
