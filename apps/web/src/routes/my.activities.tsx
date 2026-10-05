import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router";
import { useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { RequireAccount } from "../components/activities/require-account";
import { Button } from "../components/ui/button";
import { formatTime, statusLabels, useMyActivities } from "../lib/activities";

export const Route = createFileRoute("/my/activities")({
  component: MyActivitiesPage,
});

function MyActivitiesPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/activities/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount>
      {({ userId }) => <ActivityList key={userId} userId={userId} />}
    </RequireAccount>
  );
}

function ActivityList({ userId }: { userId: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useMyActivities(userId, cursors.at(-1) ?? null);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">我的活动</h1>
        <Button asChild>
          <Link to="/activities/new">创建活动</Link>
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">正在读取活动…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length === 0 ? (
            <p className="activity-panel text-neutral-600">还没有创建活动。</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {query.data.items.map((activity) => (
                <article key={activity.id} className="activity-panel space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="break-words font-semibold">
                      {activity.title}
                    </h2>
                    <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs">
                      {statusLabels[activity.status]}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-600">
                    {activity.rewardType === "ldc"
                      ? activity.paymentMode === "real"
                        ? "LDC（真实）"
                        : "LDC（本地模拟）"
                      : "文本奖励"}{" "}
                    · {activity.totalCount} 份 · 已领取 {activity.claimedCount}{" "}
                    份
                  </p>
                  <p className="text-xs text-neutral-500">
                    截止：{formatTime(activity.deadlineAt)}
                  </p>
                  <Button asChild variant="secondary">
                    <Link to="/my/activities/$id" params={{ id: activity.id }}>
                      管理活动
                    </Link>
                  </Button>
                </article>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={cursors.length === 1}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              上一页
            </Button>
            <span className="text-sm text-neutral-500">
              第 {cursors.length} 页
            </span>
            <Button
              type="button"
              variant="secondary"
              disabled={!query.data.nextCursor}
              onClick={() => {
                if (query.data.nextCursor)
                  setCursors((current) => [...current, query.data.nextCursor]);
              }}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
