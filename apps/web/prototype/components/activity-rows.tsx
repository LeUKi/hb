import { ArrowUpRight } from "lucide-react";
import { useId } from "react";
import { isActivityDeadlineReached } from "../activity-metadata";
import { getSampleResult } from "../fixtures";
import { ShortTime, useClockSelector } from "../time";
import { normalizePrototypeTopicLink } from "../topic-link";
import type {
  Activity,
  ActivityViewState,
  ActivityViewStateOverrides,
  Participation,
  ParticipationResult,
} from "../types";
import {
  activityRewardLabel,
  activityRewardSummary,
  fuzzyQuantityLabel,
  projectActivityViewState,
} from "../view-state";
import { publicQuantityLabel } from "./activity-card";
import {
  ActivityReward,
  ActivityRowTitle,
  CompactActivityTable,
  projectActivityTableState,
} from "./compact-activity-table";
import { UserIdentity } from "./identity";
import { ViewActivityAction } from "./view-activity-action";
import "./activity-rows.css";

const participationLabels: Record<Exclude<Participation, "none">, string> = {
  registered: "已报名",
  drawing: "已报名",
  won: "已中奖",
  "not-won": "未中奖",
  claimed: "已领取",
};

function rewardStatus(state: ActivityViewState) {
  if (state.participation === "not-won") return "未中奖";
  if (state.participation === "drawing") return "正在开奖";
  if (state.participation === "registered") return "等待开奖";
  return undefined;
}

function LinuxDoMark({ size = 14 }: { size?: number }) {
  const clipId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      aria-hidden="true"
      focusable="false"
      className="activity-rows-linuxdo-mark"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="60" cy="60" r="47" />
        </clipPath>
      </defs>
      <circle fill="#f0f0f0" cx="60" cy="60" r="50" />
      <g clipPath={`url(#${clipId})`}>
        <rect fill="#1c1c1e" x="10" y="10" width="100" height="30" />
        <rect fill="#f0f0f0" x="10" y="40" width="100" height="40" />
        <rect fill="#ffb003" x="10" y="80" width="100" height="30" />
      </g>
    </svg>
  );
}

export function ActivityRows({
  activities,
  onOpen,
  records = {},
  states = {},
  fuzzy = false,
  results = {},
  history = false,
  showTopicLinks = true,
}: {
  activities: Activity[];
  onOpen: (activity: Activity) => void;
  records?: Record<string, Participation>;
  states?: Record<string, ActivityViewStateOverrides>;
  fuzzy?: boolean;
  results?: Record<string, ParticipationResult>;
  history?: boolean;
  showTopicLinks?: boolean;
}) {
  useClockSelector((now) =>
    activities
      .map((activity) => (isActivityDeadlineReached(activity, now) ? "1" : "0"))
      .join(""),
  );

  if (history)
    return (
      <div className="activity-rows" data-context="history">
        <CompactActivityTable
          label="我参与的活动"
          variant="participation"
          columns={[
            { key: "activity", label: "活动", width: "36%" },
            { key: "author", label: "发布者", width: "15%" },
            { key: "reward", label: "我的奖励", width: "20%" },
            { key: "time", label: "参与时间", width: "17%" },
            { key: "actions", label: "操作", width: "12%" },
          ]}
        >
          {activities.map((activity) => {
            const result = results[activity.id] ?? getSampleResult(activity.id);
            const viewState = projectActivityTableState(
              activity,
              projectActivityViewState(
                activity,
                records[activity.id] ?? result?.participation ?? "none",
                {
                  ...result?.viewState,
                  ...(records[activity.id] === undefined
                    ? {}
                    : { participation: records[activity.id] }),
                  ...states[activity.id],
                },
              ),
            );
            const hasReward =
              viewState.participation === "claimed" ||
              viewState.participation === "won";
            const registration = activity.type === "draw";
            const status = rewardStatus(viewState);
            return (
              <tr
                key={activity.id}
                className="activity-rows-row compact-activity-row"
                data-activity-id={activity.id}
                data-lifecycle={viewState.lifecycle}
                data-participation={viewState.participation}
                data-draw={viewState.drawProgress ?? undefined}
                data-payment={viewState.paymentProgress ?? undefined}
              >
                <td className="activity-table-activity">
                  <ActivityRowTitle
                    activity={activity}
                    state={viewState}
                    onOpen={() => onOpen(activity)}
                    buttonClassName="activity-rows-open"
                  >
                    <div className="activity-rows-source">
                      {result?.password ? (
                        <span>
                          {"通过口令 "}
                          <b>{result.password}</b>{" "}
                          {registration ? "报名" : "兑换"}
                        </span>
                      ) : (
                        <span>
                          {registration ? "报名口令未记录" : "兑换口令未记录"}
                        </span>
                      )}
                    </div>
                  </ActivityRowTitle>
                </td>
                <td className="activity-table-author activity-rows-author">
                  <UserIdentity
                    name={activity.author}
                    username={activity.username}
                    color={activity.color}
                  />
                </td>
                <td className="activity-table-reward activity-rows-reward">
                  <ActivityReward
                    label={activityRewardLabel(activity)}
                    amount={hasReward ? result?.rewardAmount : undefined}
                    status={
                      hasReward && !result?.rewardAmount ? "金额待确认" : status
                    }
                    paymentStatus={hasReward ? viewState.paymentProgress : null}
                    confirmedAt={result?.confirmedAt}
                  />
                </td>
                <td className="activity-table-date">
                  <ShortTime
                    className="activity-rows-quantity activity-rows-time"
                    value={result?.participatedAt}
                  />
                </td>
                <td className="activity-table-actions">
                  <ViewActivityAction activityId={activity.id} />
                </td>
              </tr>
            );
          })}
        </CompactActivityTable>
      </div>
    );

  return (
    <div className="activity-rows" data-context="public">
      {activities.length === 0 ? (
        <p className="activity-rows-empty">暂无活动</p>
      ) : (
        <CompactActivityTable
          label="公开活动"
          variant="public"
          columns={[
            { key: "activity", label: "活动", width: "40%" },
            { key: "author", label: "发布者", width: "17%" },
            { key: "reward", label: "奖励", width: "20%" },
            { key: "quantity", label: "数量", width: "13%" },
            { key: "actions", label: "操作", width: "10%" },
          ]}
        >
          {activities.map((activity) => {
            const viewState = projectActivityTableState(
              activity,
              projectActivityViewState(
                activity,
                records[activity.id] ?? "none",
                states[activity.id],
              ),
            );
            const quantity = fuzzy
              ? fuzzyQuantityLabel(activity)
              : publicQuantityLabel(activity);
            const topicUrl = activity.topicUrl
              ? normalizePrototypeTopicLink(activity.topicUrl)?.topicUrl
              : null;

            return (
              <tr
                className="activity-rows-row compact-activity-row"
                key={activity.id}
                data-activity-id={activity.id}
                data-lifecycle={viewState.lifecycle}
                data-participation={viewState.participation}
                data-draw={viewState.drawProgress ?? undefined}
              >
                <td className="activity-table-activity">
                  <ActivityRowTitle
                    activity={activity}
                    state={viewState}
                    onOpen={() => onOpen(activity)}
                    buttonClassName="activity-rows-open"
                    titleActions={
                      showTopicLinks && topicUrl ? (
                        <a
                          className="activity-rows-topic-link"
                          href={topicUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="打开关联论坛帖子"
                          title="打开关联论坛帖子"
                        >
                          <LinuxDoMark size={14} />
                          <ArrowUpRight size={11} aria-hidden="true" />
                        </a>
                      ) : undefined
                    }
                  >
                    {viewState.participation !== "none" && (
                      <span className="activity-rows-participation">
                        {participationLabels[viewState.participation]}
                      </span>
                    )}
                  </ActivityRowTitle>
                </td>
                <td className="activity-table-author activity-rows-author">
                  <UserIdentity
                    name={activity.author}
                    username={activity.username}
                    color={activity.color}
                  />
                </td>
                <td className="activity-table-reward activity-rows-reward">
                  <ActivityReward
                    label={activityRewardLabel(activity)}
                    summary={activityRewardSummary(activity) ?? undefined}
                  />
                </td>
                <td className="activity-table-quantity">
                  <span className="activity-rows-quantity">{quantity}</span>
                </td>
                <td className="activity-table-actions">
                  <ViewActivityAction activityId={activity.id} />
                </td>
              </tr>
            );
          })}
        </CompactActivityTable>
      )}
    </div>
  );
}
