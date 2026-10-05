import {
  type ClaimActivityInput,
  type PublicActivity,
  passwordSchema,
} from "@hb/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  useClaimReward,
  useCurrentClaim,
  useCurrentRegistration,
} from "../../lib/claims";
import { Button } from "../ui/button";
import { ActivityErrorView } from "./activity-error";
import { ClaimContent } from "./claim-content";
import { PasswordField } from "./password-field";
import { RegistrationContent } from "./registration-content";

export function ClaimEntry({
  activity,
  userId,
  csrfToken,
  initialPassword = "",
}: {
  activity: PublicActivity;
  userId: string;
  csrfToken: string;
  initialPassword?: string;
}) {
  const timedDraw = Boolean(activity.draw);
  const registrationShouldPoll =
    activity.draw?.state === "waiting" || activity.draw?.state === "settling";
  const current = useCurrentClaim(userId, activity.id);
  const registration = useCurrentRegistration(
    userId,
    activity.id,
    timedDraw,
    registrationShouldPoll,
  );
  if (current.isPending || (timedDraw && registration.isPending))
    return <p role="status">正在查询你的参与记录…</p>;
  if (current.isError)
    return (
      <ActivityErrorView
        error={current.error}
        retry={() => current.refetch()}
      />
    );
  if (timedDraw && registration.isError)
    return (
      <ActivityErrorView
        error={registration.error}
        retry={() => registration.refetch()}
      />
    );
  if (current.data.claim)
    return (
      <ClaimContent key={current.data.claim.id} claim={current.data.claim} />
    );
  if (timedDraw && registration.data?.registration)
    return (
      <RegistrationContent
        key={registration.data.registration.id}
        registration={registration.data.registration}
      />
    );
  if (activity.status !== "active") return null;
  if (activity.rewardType === "ldc" && activity.author.id === userId)
    return (
      <p className="text-sm text-neutral-600">
        {timedDraw
          ? "作者不能报名或领取自己创建的 LDC 活动。"
          : "作者不能领取自己创建的 LDC 活动。"}
      </p>
    );
  return (
    <ClaimForm
      key={`${userId}-${activity.id}`}
      activity={activity}
      userId={userId}
      csrfToken={csrfToken}
      initialPassword={initialPassword}
    />
  );
}

function ClaimForm({
  activity,
  userId,
  csrfToken,
  initialPassword,
}: {
  activity: PublicActivity;
  userId: string;
  csrfToken: string;
  initialPassword: string;
}) {
  const [password, setPassword] = useState(initialPassword);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingSubmission, setPendingSubmission] =
    useState<ClaimActivityInput | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const mutation = useClaimReward(userId, csrfToken, activity.id);
  const remainingSeconds =
    retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit() {
    if (inFlight.current || remainingSeconds > 0) return;
    const parsed = passwordSchema.safeParse(password);
    if (!pendingSubmission && !parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "请检查兑换口令。");
      return;
    }
    const submission = pendingSubmission ?? {
      submissionId: crypto.randomUUID(),
      password: parsed.success ? parsed.data : password,
    };
    setMessage(null);
    inFlight.current = true;
    try {
      const result = await mutation.mutateAsync(submission);
      if (!alive.current) return;
      setPendingSubmission(null);
      setRetryAt(null);
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
      if (!alive.current) return;
      if (error instanceof ActivityRequestError && error.status === 429) {
        const until = Date.now() + (error.retryAfterSeconds ?? 60) * 1000;
        setRetryAt(until);
        setNow(Date.now());
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
        setMessage(error.message);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-lg font-semibold">
        {activity.draw ? "口令报名" : "口令兑奖"}
      </h2>
      <PasswordField
        value={password}
        onChange={setPassword}
        disabled={mutation.isPending || Boolean(pendingSubmission)}
        dedicatedStatistics={activity.forceDedicated}
      />
      {message ? (
        <p role="status" className="text-sm text-amber-800">
          {message}
        </p>
      ) : null}
      {remainingSeconds > 0 ? (
        <p role="timer" className="text-sm text-neutral-600">
          {remainingSeconds} 秒后可重试
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={mutation.isPending || remainingSeconds > 0}
      >
        {mutation.isPending
          ? "正在确认…"
          : pendingSubmission
            ? "重试原提交"
            : activity.draw
              ? "报名"
              : "领取"}
      </Button>
    </form>
  );
}
