import type { DiscoveryCard, PublicQuantity } from "@hb/contracts";
import type { ReactNode } from "react";
import {
  ActivityReward,
  ActivityRowTitle,
  CompactActivityTable,
  CompactForumLink,
  QuantityCell,
  registrationLabel,
  rewardKindLabel,
  rewardMainText,
  ViewActivityAction,
} from "../presentation/activity-list";
import { UserIdentity } from "../user-identity";

function rewardSummary(activity: DiscoveryCard) {
  return activity.rewardType === "text" || activity.reward?.mode === "text"
    ? undefined
    : rewardMainText(activity.rewardType, activity.reward);
}

function myState(activity: DiscoveryCard) {
  if (activity.myClaim) return "已领取";
  if (activity.myRegistration)
    return registrationLabel(activity.myRegistration.status);
  return null;
}

export function DiscoveryCards({
  items,
  state = "ready",
  emptyText = "暂无可展示的活动。",
  errorContent,
  onRetry,
}: {
  items: DiscoveryCard[];
  state?: "ready" | "empty" | "loading" | "error";
  emptyText?: string;
  errorContent?: ReactNode;
  onRetry?: () => void;
}) {
  const columns = [
    { key: "activity", label: "活动", width: "40%" },
    { key: "author", label: "发布者", width: "17%" },
    { key: "reward", label: "奖励", width: "20%" },
    { key: "quantity", label: "数量", width: "13%" },
    { key: "actions", label: "操作", width: "10%" },
  ];
  return (
    <div className="activity-rows" data-context="public">
      <CompactActivityTable
        label="公开活动"
        variant="public"
        columns={columns}
        state={state}
        emptyText={emptyText}
        errorContent={errorContent}
        onRetry={onRetry}
      >
        {items.map((activity) => (
          <tr
            key={activity.id}
            className="activity-rows-row compact-activity-row"
            data-activity-id={activity.id}
            data-lifecycle={activity.status}
            data-participation={myState(activity) ?? "none"}
            data-draw={activity.draw?.state ?? undefined}
          >
            <td className="activity-table-activity" data-label="活动">
              <ActivityRowTitle
                title={activity.title}
                status={activity.status}
                deadlineAt={activity.deadlineAt}
                draw={activity.draw}
                href={`/activities/${activity.id}`}
                buttonClassName="activity-rows-open"
                titleActions={
                  activity.topicUrl ? (
                    <CompactForumLink href={activity.topicUrl} />
                  ) : undefined
                }
              >
                {myState(activity) ? (
                  <span className="activity-rows-participation">
                    {myState(activity)}
                  </span>
                ) : null}
              </ActivityRowTitle>
            </td>
            <td
              className="activity-table-author activity-rows-author"
              data-label="发布者"
            >
              <UserIdentity profile={activity.author} />
            </td>
            <td
              className="activity-table-reward activity-rows-reward"
              data-label="奖励"
            >
              <ActivityReward
                label={rewardKindLabel(activity.rewardType, activity.reward)}
                summary={rewardSummary(activity)}
              />
            </td>
            <td className="activity-table-quantity" data-label="数量">
              <span className="activity-rows-quantity">
                <QuantityCell
                  quantity={activity.quantity as PublicQuantity}
                  kind={activity.draw ? "draw" : "instant"}
                />
              </span>
            </td>
            <td className="activity-table-actions" data-label="操作">
              <ViewActivityAction id={activity.id} />
            </td>
          </tr>
        ))}
      </CompactActivityTable>
    </div>
  );
}
