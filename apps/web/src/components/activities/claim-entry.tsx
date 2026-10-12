import {
  type ClaimActivityInput,
  type ClaimDetail,
  type PublicActivity,
  passwordSchema,
  type RegistrationDetail,
} from "@hb/contracts";
import { useAtom, useSetAtom } from "jotai";
import { ArrowRight, Gift, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { useAttemptCooldown } from "../../lib/attempt-cooldown";
import { useAccountSession } from "../../lib/auth";
import { useClaimReward } from "../../lib/claims";
import { isDirectParticipation } from "../../lib/direct-participation";
import {
  type RedemptionIntentOperation,
  redemptionIntentAtom,
  rewardAnimationAtom,
} from "../../lib/redemption-intent";
import { OfficialConnectRequired } from "../auth/official-connect-required";
import { SkeletonRows } from "../presentation/loading";
import { RedemptionAction } from "../presentation/redemption-transition";
import { ActivityErrorView } from "./activity-error";
import { ClaimContent } from "./claim-content";
import { PasswordField } from "./password-field";
import { RegistrationContent } from "./registration-content";

export function ClaimEntry({
  activity,
  userId,
  accountTier,
  csrfToken,
  canUseLdc,
  initialPassword = "",
  hideResult = false,
  knownClaim: claim,
  knownRegistration: registrationRecord,
  participationPending = false,
  participationError = null,
  onParticipationRetry,
}: {
  activity: PublicActivity;
  userId: string;
  accountTier: string;
  csrfToken: string;
  canUseLdc: boolean;
  initialPassword?: string;
  hideResult?: boolean;
  knownClaim: ClaimDetail | null | undefined;
  knownRegistration: RegistrationDetail | null;
  participationPending?: boolean;
  participationError?: Error | null;
  onParticipationRetry?: () => void;
}) {
  const timedDraw = Boolean(activity.draw);
  const direct = isDirectParticipation(activity);
  const setIntent = useSetAtom(redemptionIntentAtom);
  const alreadyParticipated = Boolean(claim || registrationRecord);
  useEffect(() => {
    if (!alreadyParticipated && !direct) return;
    setIntent((intent) =>
      intent?.userId === userId && intent.activityId === activity.id
        ? null
        : intent,
    );
  }, [alreadyParticipated, direct, userId, activity.id, setIntent]);
  if (participationPending)
    return (
      <div aria-busy="true">
        <SkeletonRows rows={2} />
      </div>
    );
  if (participationError)
    return (
      <ActivityErrorView
        error={participationError}
        retry={onParticipationRetry ?? (() => {})}
      />
    );
  if (claim)
    return hideResult ? null : <ClaimContent key={claim.id} claim={claim} />;
  if (timedDraw && registrationRecord)
    return hideResult ? null : (
      <RegistrationContent
        key={registrationRecord.id}
        registration={registrationRecord}
      />
    );
  if (activity.status !== "active") return null;
  if (activity.deadlineAt && Date.parse(activity.deadlineAt) <= Date.now())
    return (
      <p className="eligibility-note">
        {activity.draw ? "报名已截止。" : "活动已截止，不能继续兑换。"}
      </p>
    );
  if (activity.rewardType === "ldc" && !canUseLdc)
    return (
      <OfficialConnectRequired
        returnTo={`/activities/${activity.id}`}
        message={
          timedDraw
            ? direct
              ? "青春版可以浏览这个LDC活动，报名需要使用官方Connect升级。升级后请主动点击报名。"
              : "青春版可以浏览这个LDC活动，报名需要使用官方Connect升级。升级后请主动提交口令报名。"
            : direct
              ? "青春版可以浏览这个LDC活动，领取需要使用官方Connect升级。升级后请主动点击领取奖励。"
              : "青春版可以浏览这个LDC活动，领取需要使用官方Connect升级。升级后请主动提交口令领取。"
        }
      />
    );
  if (activity.rewardType === "ldc" && activity.author.id === userId)
    return (
      <p className="eligibility-note">
        {timedDraw
          ? "作者不能报名或领取自己创建的 LDC 活动。"
          : "作者不能领取自己创建的 LDC 活动。"}
      </p>
    );
  return (
    <ClaimForm
      key={`${userId}-${accountTier}-${activity.id}-${activity.participationMode ?? "password"}`}
      activity={activity}
      userId={userId}
      accountTier={accountTier}
      csrfToken={csrfToken}
      initialPassword={initialPassword}
    />
  );
}

function ClaimForm({
  activity,
  userId,
  accountTier,
  csrfToken,
  initialPassword,
}: {
  activity: PublicActivity;
  userId: string;
  accountTier: string;
  csrfToken: string;
  initialPassword: string;
}) {
  const [password, setPassword] = useState(initialPassword);
  const direct = isDirectParticipation(activity);
  const [intent, setIntent] = useAtom(redemptionIntentAtom);
  const setAnimation = useSetAtom(rewardAnimationAtom);
  const automaticSubmit = useRef<
    (operation: RedemptionIntentOperation) => Promise<void>
  >(async () => {});
  useEffect(() => {
    if (
      direct ||
      !intent ||
      intent.userId !== userId ||
      intent.accountTier !== accountTier ||
      intent.activityId !== activity.id
    )
      return;
    setIntent(null);
    setPassword(intent.operation.password);
    void automaticSubmit.current(intent.operation);
  }, [intent, direct, userId, accountTier, activity.id, setIntent]);
  const [message, setMessage] = useState<string | null>(null);
  const [officialRequired, setOfficialRequired] = useState(false);
  const [pendingSubmission, setPendingSubmission] =
    useState<ClaimActivityInput | null>(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const mutation = useClaimReward(userId, csrfToken, activity.id);
  const account = useAccountSession(userId);
  const cooldown = useAttemptCooldown(userId);
  const blockedByCooldown = !pendingSubmission && cooldown.active;
  const remainingSeconds = blockedByCooldown ? cooldown.seconds : 0;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(automatic?: RedemptionIntentOperation) {
    if (
      inFlight.current ||
      (direct && Boolean(automatic)) ||
      (!automatic && !pendingSubmission && blockedByCooldown)
    )
      return;
    const parsed = passwordSchema.safeParse(automatic?.password ?? password);
    if (!pendingSubmission && !direct && !parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "请检查兑换口令。");
      return;
    }
    const submission: ClaimActivityInput =
      automatic ??
      pendingSubmission ??
      (direct
        ? { participationMode: "direct", submissionId: crypto.randomUUID() }
        : {
            submissionId: crypto.randomUUID(),
            password: parsed.success ? parsed.data : password,
          });
    setMessage(null);
    setOfficialRequired(false);
    const identity = account.captureIdentity();
    inFlight.current = true;
    setAnimation({ activityId: activity.id, token: submission.submissionId });
    try {
      const result = await mutation.mutateAsync(submission);
      if (!alive.current || !account.isCurrentIdentity(identity)) return;
      setPendingSubmission(null);
      if (result.result === "incorrect") setMessage("口令不正确，请重新尝试。");
      else if (result.result === "draft")
        setMessage(activity.draw ? "活动尚未开放报名。" : "活动尚未开放领取。");
      else if (result.result === "ended" || result.result === "archived")
        setMessage(
          activity.draw ? "活动已结束，无法报名。" : "活动已结束，无法领取。",
        );
      else if (result.result === "registered")
        setMessage("报名成功，等待开奖。");
      else if (result.result === "already_registered")
        setMessage("你已经报名过本活动。再次提交不会增加中奖机会。");
      else
        setMessage(
          result.result === "claimed" ? "领取成功。" : "你已经领取过本活动。",
        );
    } catch (error) {
      if (!alive.current || !account.isCurrentIdentity(identity)) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        setPendingSubmission(null);
        setMessage("尝试过于频繁，请稍后重试。");
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        setPendingSubmission(submission);
        setMessage(
          activity.draw
            ? "尚未确认报名结果，请重试原提交以确认结果。"
            : "尚未确认领取结果，请重试原提交以确认结果。",
        );
      } else {
        setPendingSubmission(null);
        if (error.code === "OFFICIAL_CONNECT_REQUIRED")
          setOfficialRequired(true);
        else setMessage(error.message);
      }
    } finally {
      inFlight.current = false;
    }
  }

  automaticSubmit.current = submit;

  return (
    <form
      className="claim-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!direct && (
        <PasswordField
          value={password}
          onChange={setPassword}
          disabled={mutation.isPending || Boolean(pendingSubmission)}
          dedicatedStatistics={activity.forceDedicated}
          onSubmit={() => void submit()}
        />
      )}
      {message ? (
        <p role="status" className="form-message">
          {message}
        </p>
      ) : null}
      {officialRequired ? (
        <OfficialConnectRequired returnTo={`/activities/${activity.id}`} />
      ) : null}
      {remainingSeconds > 0 ? (
        <p role="timer" className="form-message">
          {remainingSeconds} 秒后可重试
        </p>
      ) : null}
      <RedemptionAction
        className="button claim-button"
        type="submit"
        disabled={mutation.isPending || remainingSeconds > 0}
      >
        {mutation.isPending ? (
          <LoaderCircle size={18} className="spin" aria-hidden="true" />
        ) : (
          <Gift size={18} aria-hidden="true" />
        )}
        {mutation.isPending
          ? "正在确认…"
          : pendingSubmission
            ? "重试原提交"
            : remainingSeconds > 0
              ? `还需等待 ${remainingSeconds} 秒`
              : direct
                ? activity.draw
                  ? "立即报名"
                  : "领取奖励"
                : activity.draw
                  ? "报名"
                  : "领取红包"}
        <ArrowRight size={17} aria-hidden="true" />
      </RedemptionAction>
    </form>
  );
}
