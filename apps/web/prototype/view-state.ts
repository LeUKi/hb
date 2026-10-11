import {
  isActivityDeadlineReached,
  TEXT_REWARD_LABEL,
} from "./activity-metadata";
import type {
  Activity,
  ActivityLifecycle,
  ActivityViewState,
  ActivityViewStateOverrides,
  DrawProgress,
  Participation,
  PaymentProgress,
  Scenario,
} from "./types";

export const activityLifecycleLabels: Record<ActivityLifecycle, string> = {
  draft: "准备中",
  active: "进行中",
  ended: "已结束",
  archived: "已归档",
};

export const drawProgressLabels: Record<DrawProgress, string> = {
  waiting: "等待开奖",
  settling: "正在开奖",
  completed: "开奖结果已公布",
  empty: "零报名结束",
};

export const paymentProgressLabels: Record<PaymentProgress, string> = {
  pending: "待发放",
  sending: "发送中",
  reconciling: "核对中",
  waiting: "等待恢复",
  confirmed: "已发放",
  attention: "异常待处理",
};

/** System copy reflects existing facts; it never grants access to author text. */
export function activityStatusSentence(
  activity: Pick<Activity, "type">,
  state: ActivityViewState,
  deadlineReached = false,
): string {
  if (state.participation === "won") return "已中奖。";
  if (state.participation === "claimed") return "兑换成功。";
  if (activity.type === "draw" && state.drawProgress === "settling")
    return "报名已截止，正在开奖。";
  if (state.participation === "not-won") return "本次未中奖。";
  if (state.lifecycle === "archived") return "本次活动已归档。";
  if (state.lifecycle === "ended") return "本次活动已结束。";
  if (state.lifecycle === "draft") return "活动尚未开放。";
  if (state.participation === "registered") return "报名已确认，等待开奖。";
  if (activity.type !== "draw" && deadlineReached)
    return "活动已截止，不能继续兑换。";
  return activity.type === "draw"
    ? "输入口令，报名参与开奖。"
    : "输入口令，兑换本次奖励。";
}

export function activityRewardLabel(activity: Activity): string {
  if (activity.type === "text") return TEXT_REWARD_LABEL;
  if (activity.type === "draw") return "限时开奖";
  if (activity.rewardMode === "instant_random") return "即时随机";
  if (activity.rewardMode === "custom") return "自定义金额";
  return "固定均分";
}

/** Public reward configuration, never a participant's allocated amount. */
export function activityRewardSummary(activity: Activity): string | null {
  if (activity.type === "text") return null;
  if (activity.type === "draw" || activity.rewardMode === "instant_random") {
    const pool =
      activity.poolAmount ?? (activity.type === "draw" ? activity.amount : "");
    return pool ? `${pool} LDC 奖池` : null;
  }
  if (activity.rewardMode === "custom") {
    return activity.poolAmount ? `${activity.poolAmount} LDC 总额` : null;
  }
  return activity.amount ? `${activity.amount} LDC / 份` : null;
}

export function fuzzyQuantityLabel(activity: Activity): string {
  if (activity.type === "draw") return "名额不公开";
  if (activity.remaining <= 0) return "奖励已领完";
  const ratio = activity.remaining / activity.count;
  return ratio > 0.5 ? "奖励充足" : ratio > 0.2 ? "奖励有限" : "剩余少量奖励";
}

// Each axis can be supplied independently when real records replace the fixtures.
export function projectActivityViewState(
  activity: Activity,
  participation: Participation = "none",
  overrides: ActivityViewStateOverrides = {},
): ActivityViewState {
  return {
    lifecycle:
      overrides.lifecycle ??
      activity.lifecycle ??
      (activity.ended ? "ended" : "active"),
    participation: overrides.participation ?? participation,
    drawProgress:
      overrides.drawProgress === undefined
        ? activity.type === "draw"
          ? (activity.drawProgress ?? "waiting")
          : null
        : overrides.drawProgress,
    paymentProgress: overrides.paymentProgress ?? null,
  };
}

/** Admission closure changes the presentation, never publishes draw results. */
export function effectiveDrawProgress(
  activity: Activity,
  state: Pick<ActivityViewState, "lifecycle" | "drawProgress">,
  nowMs = Date.now(),
): DrawProgress | null {
  if (activity.type !== "draw") return null;
  const progress = state.drawProgress ?? activity.drawProgress ?? "waiting";
  if (
    progress === "waiting" &&
    (state.lifecycle === "ended" ||
      state.lifecycle === "archived" ||
      (state.lifecycle !== "draft" &&
        isActivityDeadlineReached(activity, nowMs)))
  )
    return "settling";
  return progress;
}

const readyState: ActivityViewState = {
  lifecycle: "active",
  participation: "none",
  drawProgress: null,
  paymentProgress: null,
};

const scenarioStates: Record<Scenario, ActivityViewState> = {
  ready: readyState,
  "notes-drawing-ended": {
    ...readyState,
    lifecycle: "ended",
    drawProgress: "settling",
  },
  random: readyState,
  "random-ended": {
    lifecycle: "ended",
    participation: "claimed",
    drawProgress: null,
    paymentProgress: "confirmed",
  },
  text: readyState,
  pending: {
    ...readyState,
    participation: "claimed",
    paymentProgress: "pending",
  },
  registered: {
    ...readyState,
    participation: "registered",
    drawProgress: "waiting",
  },
  drawing: {
    lifecycle: "ended",
    participation: "drawing",
    drawProgress: "settling",
    paymentProgress: null,
  },
  won: {
    lifecycle: "ended",
    participation: "won",
    drawProgress: "completed",
    paymentProgress: "confirmed",
  },
  "not-won": {
    lifecycle: "ended",
    participation: "not-won",
    drawProgress: "completed",
    paymentProgress: null,
  },
  "draw-empty": {
    lifecycle: "ended",
    participation: "none",
    drawProgress: "empty",
    paymentProgress: null,
  },
  "draw-no-winners": {
    lifecycle: "ended",
    participation: "not-won",
    drawProgress: "completed",
    paymentProgress: null,
  },
  ended: { ...readyState, lifecycle: "ended" },
  long: readyState,
  multiple: {
    ...readyState,
    participation: "claimed",
    paymentProgress: "confirmed",
  },
  slow: readyState,
  failure: readyState,
};

// Apply a selected scenario only to its fixture activity, then retain its axes.
export function scenarioViewState(
  scenario: Scenario,
): ActivityViewStateOverrides {
  return { ...scenarioStates[scenario] };
}
