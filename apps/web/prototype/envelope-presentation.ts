import type { ActivityImagePresentation } from "@hb/contracts";
import type { EnvelopeReward } from "./components/envelope";
import type { Activity, ActivityViewState, Identity } from "./types";

/** UI projection only. Open paper never creates a participation or reward. */
export function envelopePresentation({
  activity,
  state,
  identity,
  amount,
}: {
  activity: Activity;
  state: ActivityViewState;
  identity: Identity;
  amount?: string;
}): EnvelopeReward | undefined {
  if (state.participation === "claimed" || state.participation === "won")
    return { kind: "ldc", amount: amount ?? "—" };
  if (
    activity.type === "draw" &&
    state.drawProgress !== "completed" &&
    state.drawProgress !== "empty"
  )
    return undefined;
  if (state.participation === "not-won") return { kind: "not-won" };
  if (state.lifecycle !== "ended" && state.lifecycle !== "archived")
    return undefined;
  return {
    kind:
      identity === "guest" || activity.username === "linjian"
        ? "ended"
        : "missed",
  };
}

/** Local sample facts use the same factual SVG contract as the live page. */
export function envelopeImagePresentation({
  activity,
  state,
  identity,
  amount,
  claimedAt,
  updatedAt,
  quantityText,
}: {
  activity: Activity;
  state: ActivityViewState;
  identity: Identity;
  amount?: string;
  claimedAt?: string | null;
  updatedAt: Date;
  quantityText?: string | null;
}): ActivityImagePresentation {
  const privateResult = identity === "standard";
  const claimed =
    privateResult &&
    (state.participation === "claimed" || state.participation === "won");
  const ended = state.lifecycle === "ended" || state.lifecycle === "archived";
  const drawing = state.drawProgress === "settling";
  const notWon = privateResult && state.participation === "not-won";
  const registered = privateResult && state.participation === "registered";
  const imageState = claimed
    ? "claimed"
    : notWon
      ? "not_won"
      : drawing
        ? "drawing"
        : registered
          ? "registered"
          : ended
            ? "ended"
            : state.lifecycle === "draft"
              ? "unavailable"
              : "active";
  const payment = state.paymentProgress;
  return {
    id: activity.id,
    title: activity.title,
    sender: activity.author,
    state: imageState,
    sealLabel: claimed
      ? "开"
      : notWon
        ? "未中奖"
        : drawing
          ? "开奖中"
          : registered
            ? "已报名"
            : ended
              ? "已结束"
              : state.lifecycle === "draft"
                ? "预览"
                : identity === "standard" && activity.username !== "linjian"
                  ? activity.type === "draw"
                    ? "报名"
                    : "开"
                  : "查看",
    quantityText,
    amount: claimed && amount ? `${amount} LDC` : null,
    claimedAt: claimed ? claimedAt : null,
    statusText: claimed
      ? payment === "confirmed"
        ? "已发放"
        : payment === "waiting"
          ? "正在核对原订单"
          : payment === "attention"
            ? "需要关注"
            : payment
              ? "付款处理中"
              : "已领取"
      : registered
        ? "已报名，等待开奖"
        : undefined,
    updatedAt,
  };
}
