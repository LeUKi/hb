import type { Activity, ActivityLifecycle } from "./types";

export const TEXT_REWARD_LABEL = "文本 / CDK";

// One clock anchor per local experience; projections and navigation reuse it.
export const prototypeStartedAt = Date.now();

function integerCents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function formatCents(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function fixedPoolAmount(amount: string, count: number): string | null {
  const cents = integerCents(amount);
  const total = cents === null ? null : cents * count;
  return Number.isSafeInteger(count) &&
    count > 0 &&
    total !== null &&
    Number.isSafeInteger(total)
    ? formatCents(total)
    : null;
}

export function prototypeDeadlineAt(
  type: Activity["type"],
  lifecycle: ActivityLifecycle = "active",
): string | null {
  if (lifecycle === "draft") return null;
  const seconds =
    lifecycle === "archived"
      ? -172800
      : lifecycle === "ended"
        ? -3600
        : type === "draw"
          ? 600
          : 8315;
  return new Date(prototypeStartedAt + seconds * 1000).toISOString();
}

export type PublicActivityMetadata = {
  rewardLabel: string;
  poolAmount: string | null;
  poolLabel: string | null;
  countLabel: string;
  deadlineAt: string | null;
};

export function getActivityPublicMetadata(
  activity: Activity,
  { fuzzy = false }: { fuzzy?: boolean } = {},
): PublicActivityMetadata {
  const text = activity.type === "text";
  const draw = activity.type === "draw" || activity.rewardMode === "timed_draw";
  const random = activity.rewardMode === "instant_random";
  const custom = activity.rewardMode === "custom";
  const fixed = !text && !draw && !random && !custom;
  const configuredPool = activity.poolAmount
    ? integerCents(activity.poolAmount)
    : null;
  const poolAmount =
    text || (fuzzy && fixed)
      ? null
      : fixed
        ? fixedPoolAmount(activity.amount, activity.count)
        : configuredPool === null
          ? null
          : formatCents(configuredPool);
  return {
    rewardLabel: text
      ? TEXT_REWARD_LABEL
      : draw
        ? "LDC · 限时开奖"
        : random
          ? "LDC · 即时随机（拼手气）"
          : custom
            ? "LDC · 自定义金额"
            : "LDC · 固定均分",
    poolAmount,
    poolLabel: poolAmount === null ? null : `${poolAmount} LDC`,
    countLabel: fuzzy
      ? draw
        ? "获奖名额不公开"
        : "份数不公开"
      : `${activity.count} ${draw ? "个获奖名额" : "份"}`,
    deadlineAt: activity.deadlineAt ?? null,
  };
}

export function isActivityDeadlineReached(
  activity: Pick<Activity, "deadlineAt">,
  nowMs: number,
) {
  if (!activity.deadlineAt || !Number.isFinite(nowMs)) return false;
  const deadlineMs = Date.parse(activity.deadlineAt);
  return Number.isFinite(deadlineMs) && nowMs >= deadlineMs;
}
