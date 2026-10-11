import {
  formatCountdownDuration,
  getClockSnapshot,
  useClockSelector,
  usePrototypeNow,
} from "../time";
import "./activity-countdown.css";

export type ActivityCountdownOptions = {
  deadlineAt: string | null;
  active: boolean;
};

export type ActivityCountdownValue = {
  /** Milliseconds until the fixed deadline; null means no valid deadline. */
  remaining: number | null;
  expired: boolean;
};

export function useActivityCountdown({
  deadlineAt,
  active,
}: ActivityCountdownOptions): ActivityCountdownValue {
  const parsed = deadlineAt === null ? Number.NaN : Date.parse(deadlineAt);
  const deadline = Number.isFinite(parsed) ? parsed : null;
  const ticking = active && deadline !== null && getClockSnapshot() < deadline;
  const now = usePrototypeNow(ticking);
  const remaining =
    !active || deadline === null ? null : Math.max(0, deadline - now);
  return { remaining, expired: remaining === 0 };
}

export function useDeadlineExpired({
  deadlineAt,
  active,
}: ActivityCountdownOptions) {
  const parsed = deadlineAt === null ? Number.NaN : Date.parse(deadlineAt);
  const deadline = Number.isFinite(parsed) ? parsed : null;
  return useClockSelector(
    (now) => (deadline === null ? false : now >= deadline),
    active && deadline !== null && getClockSnapshot() < deadline,
  );
}

export type ActivityCountdownProps = ActivityCountdownOptions & {
  kind: "instant" | "draw";
  className?: string;
  /** Supply the hook value to reuse a timer owned by the surrounding form. */
  remaining?: number | null;
};

export function ActivityCountdown({
  deadlineAt,
  active,
  kind,
  className,
  remaining: suppliedRemaining,
}: ActivityCountdownProps) {
  const countdown = useActivityCountdown({
    deadlineAt,
    active: active && suppliedRemaining === undefined,
  });
  const remaining =
    suppliedRemaining === undefined ? countdown.remaining : suppliedRemaining;
  if (!active || remaining === null) return null;
  const expired = remaining <= 0;
  return (
    <span
      className={`activity-countdown${className ? ` ${className}` : ""}`}
      role="timer"
      aria-label={kind === "draw" ? "开奖倒计时" : "活动结束倒计时"}
      aria-live="off"
    >
      {expired ? (
        <span>{kind === "draw" ? "报名已截止" : "已截止"}</span>
      ) : (
        <>
          <span>{kind === "draw" ? "距开奖" : "距结束"}</span>
          <span className="activity-countdown__value">
            {formatCountdownDuration(remaining)}
          </span>
        </>
      )}
    </span>
  );
}
