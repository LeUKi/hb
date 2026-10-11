import { ArrowUpRight, Clock3 } from "lucide-react";
import { ShortTime } from "../time";
import type { Activity, ActivityViewState, Participation } from "../types";
import {
  activityRewardLabel,
  activityRewardSummary,
  fuzzyQuantityLabel,
} from "../view-state";
import { UserIdentity } from "./identity";

export function publicQuantityLabel(activity: Activity) {
  const claimed = activity.count - activity.remaining;
  return activity.type === "draw"
    ? `最多 ${activity.count} 人获奖`
    : `已领取 ${claimed} / ${activity.count} 份`;
}

export function ActivityCard({
  activity,
  onOpen,
  participation = "none",
  fuzzy = false,
  viewState,
}: {
  activity: Activity;
  onOpen: () => void;
  participation?: Participation;
  fuzzy?: boolean;
  viewState?: ActivityViewState;
}) {
  const mine = viewState?.participation ?? participation;
  const ended = viewState
    ? viewState.lifecycle === "ended" || viewState.lifecycle === "archived"
    : activity.ended;
  const payoutWaiting =
    activity.type !== "text" &&
    (mine === "claimed" || mine === "won") &&
    viewState?.paymentProgress &&
    viewState.paymentProgress !== "confirmed";
  const rewardLabel = activityRewardLabel(activity);
  const rewardSummary = activityRewardSummary(activity);
  const status = payoutWaiting
    ? "奖励发放中"
    : mine === "claimed"
      ? "已领取"
      : mine === "won"
        ? "已中奖"
        : mine === "registered"
          ? "已报名 · 等待开奖"
          : mine === "drawing"
            ? "开奖中"
            : mine === "not-won"
              ? "未中奖"
              : ended
                ? "已结束"
                : activity.type === "draw"
                  ? "限时开奖"
                  : "进行中";
  return (
    <article className={`activity-card card-${activity.type}`}>
      <div className="card-top">
        <span className={`badge ${ended ? "neutral" : ""}`}>{status}</span>
        {activity.type !== "text" && (
          <span className="muted">{rewardLabel}</span>
        )}
      </div>
      <button type="button" className="card-title" onClick={onOpen}>
        {activity.title}
        <ArrowUpRight size={19} />
      </button>
      <p>{activity.description}</p>
      <div className="card-bottom">
        <UserIdentity
          name={activity.author}
          username={activity.username}
          color={activity.color}
        />
        <span className="card-reward">{rewardSummary ?? rewardLabel}</span>
      </div>
      <div className="card-meta">
        <span>
          <Clock3 size={13} />
          {ended ? "已结束" : activity.type === "draw" ? "开奖 " : "截止 "}
          {!ended && <ShortTime value={activity.deadlineAt} />}
        </span>
        <span>
          {fuzzy
            ? ended
              ? "参与已截止"
              : fuzzyQuantityLabel(activity)
            : publicQuantityLabel(activity)}
        </span>
      </div>
    </article>
  );
}
