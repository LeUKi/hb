import type { ActivitySummary } from "@hb/contracts";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useRouterState,
} from "@tanstack/react-router";
import { type SetStateAction, useCallback, useEffect, useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { AttemptStatisticsDialog } from "../components/activities/attempt-statistics-dialog";
import { RequireAccount } from "../components/activities/require-account";
import {
  ActivityReward,
  ActivityRowTitle,
  CompactActivityTable,
  HistoryStats,
  HistoryTabs,
  type RowAction,
  RowActions,
  rewardMainText,
} from "../components/presentation/activity-list";
import {
  ListPanel,
  ListRefreshButton,
  Pagination,
} from "../components/presentation/list-controls";
import { RefreshNotice } from "../components/presentation/loading";
import {
  formatTime,
  useHistorySummary,
  useMyActivities,
} from "../lib/activities";
import {
  useCursorRecovery,
  useEntryNavigate,
  useHistoryOverlay,
  useViewState,
} from "../lib/navigation-state";
import { listQueryState } from "../lib/query-view";

type Search = {
  statistics?: string;
};
type ScopedCursors = { scope: string; cursors: Array<string | null> };

const managedColumns = [
  { key: "activity", label: "活动", width: "25%" },
  { key: "reward", label: "奖励配置", width: "16%" },
  { key: "progress", label: "参与情况", width: "17%" },
  { key: "created", label: "创建时间", width: "12%" },
  { key: "actions", label: "操作", width: "30%" },
];

export const Route = createFileRoute("/my/activities")({
  validateSearch: (search): Search => ({
    statistics:
      typeof search.statistics === "string" && search.statistics
        ? search.statistics
        : undefined,
  }),
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
  const { statistics } = Route.useSearch();
  const legacyRewardFilter = useRouterState({
    select: (state) =>
      new URL(state.location.href, "http://local").searchParams.has("type"),
  });
  const navigate = useEntryNavigate();
  const statisticsOverlay = useHistoryOverlay("statistics");
  const [statisticsTarget, setStatisticsTarget] = useState<{
    activityId: string;
    title: string;
    restoreFocus: Element | null;
  } | null>(null);
  const statisticsId = statisticsOverlay.overlay?.id ?? statistics;
  const summary = useHistorySummary(userId);
  useEffect(() => {
    if (!legacyRewardFilter) return;
    void navigate({
      to: "/my/activities",
      search: statistics ? { statistics } : {},
      replace: true,
      resetScroll: false,
    });
  }, [legacyRewardFilter, navigate, statistics]);
  const cursorScope = userId;
  const [pager, setPager] = useViewState<ScopedCursors>("authored-pager", {
    scope: cursorScope,
    cursors: [null],
  });
  const cursors = pager.scope === cursorScope ? pager.cursors : [null];
  const setCursors = useCallback(
    (value: SetStateAction<Array<string | null>>) => {
      setPager((current) => {
        const currentCursors =
          current.scope === cursorScope ? current.cursors : [null];
        const cursors =
          typeof value === "function" ? value(currentCursors) : value;
        return { scope: cursorScope, cursors };
      });
    },
    [cursorScope, setPager],
  );
  const cursor = legacyRewardFilter ? null : (cursors.at(-1) ?? null);
  const query = useMyActivities(userId, cursor);
  useEffect(() => {
    setPager((current) =>
      current.scope === cursorScope && !legacyRewardFilter
        ? current
        : { scope: cursorScope, cursors: [null] },
    );
  }, [cursorScope, legacyRewardFilter, setPager]);
  const cursorNotice = useCursorRecovery(query.error, cursors, setCursors);
  const listState = listQueryState(query);
  return (
    <div className="route-frame">
      <div className="history-heading">
        <div className="history-heading-main">
          <h1>活动历史</h1>
          <HistoryTabs active="activities" />
        </div>
        <HistoryStats
          summary={{
            started: summary.data?.initiatedCount ?? null,
            participated: summary.data?.participatedCount ?? null,
          }}
        />
      </div>
      <div className="work-page work-list-page list-page">
        <div className="activity-list-toolbar">
          <ListRefreshButton
            busy={query.isFetching || summary.isFetching}
            onRefresh={() => {
              void query.refetch();
              void summary.refetch();
            }}
          />
        </div>
        {cursorNotice}
        <ListPanel
          restorationId="authored"
          keepContent
          state={listState}
          emptyText="还没有符合条件的活动。"
          onRetry={query.isError ? () => query.refetch() : undefined}
          refreshNotice={<RefreshNotice query={query} />}
          resetKey={`${cursorScope}:${cursors.length}`}
          footer={
            <Pagination
              label="作者活动分页"
              page={cursors.length}
              hasNext={Boolean(query.data?.nextCursor)}
              onPageChange={(page) => {
                if (page < cursors.length) setCursors(cursors.slice(0, -1));
                else if (query.data?.nextCursor)
                  setCursors([...cursors, query.data.nextCursor]);
              }}
              busy={query.isPending}
            />
          }
        >
          <div className="activity-rows" data-context="history">
            <CompactActivityTable
              label="我发起的活动"
              variant="managed"
              className="work-managed-list"
              columns={managedColumns}
              state={listState}
              emptyText="还没有符合条件的活动。"
              errorContent={
                query.isError ? (
                  <ActivityErrorView
                    error={query.error}
                    retry={() => query.refetch()}
                  />
                ) : undefined
              }
              onRetry={query.isError ? () => query.refetch() : undefined}
            >
              {query.data?.items.map((activity) => (
                <ActivityRow
                  key={activity.id}
                  activity={activity}
                  onStatistics={() => {
                    setStatisticsTarget({
                      activityId: activity.id,
                      title: activity.title,
                      restoreFocus: document.activeElement,
                    });
                    statisticsOverlay.open(activity.id);
                  }}
                />
              ))}
            </CompactActivityTable>
          </div>
        </ListPanel>
      </div>
      {statisticsId && (
        <AttemptStatisticsDialog
          key={`${userId}:${statisticsId}`}
          userId={userId}
          activityId={statisticsId}
          title={statisticsTarget?.title}
          restoreFocus={statisticsTarget?.restoreFocus}
          onClose={() => {
            setStatisticsTarget(null);
            if (statisticsOverlay.overlay) statisticsOverlay.close();
            if (statistics)
              void navigate({
                to: "/my/activities",
                search: {},
                replace: true,
              });
          }}
        />
      )}
    </div>
  );
}

function authorRewardMain(activity: ActivitySummary) {
  if (activity.reward?.totalAmount)
    return `${activity.reward.totalAmount} LDC 总额`;
  return rewardMainText(activity.reward);
}

function participationText(activity: ActivitySummary) {
  if (activity.draw) {
    const registered = activity.draw.registeredCount;
    const winner = activity.draw.winnerCount;
    if (registered === null) return "报名数已隐藏";
    if (winner === null) return `报名 ${registered} 人`;
    return `报名 ${registered} 人 / 获奖 ${winner} 人`;
  }
  return `已领取 ${activity.claimedCount} / ${activity.totalCount} 份`;
}

function ActivityRow({
  activity,
  onStatistics,
}: {
  activity: ActivitySummary;
  onStatistics: () => void;
}) {
  const forceDedicated = activity.forceDedicated;
  const actions: RowAction[] = [];
  if (activity.status !== "draft")
    actions.push({ label: "查看活动", activityId: activity.id });
  actions.push({
    label: activity.status === "draft" ? "编辑草稿" : "编辑配置",
    href: `/my/activities/${activity.id}`,
  });
  if (activity.status !== "draft")
    actions.push({
      label: "付款记录",
      href: `/my/payments?activityId=${encodeURIComponent(activity.id)}`,
    });
  if (activity.status !== "draft" && forceDedicated)
    actions.push({
      label: "尝试统计",
      onSelect: onStatistics,
    });
  return (
    <tr
      className="work-managed-row compact-activity-row"
      data-testid="managed-activity"
      data-activity-id={activity.id}
      data-lifecycle={activity.status}
    >
      <td className="activity-table-activity" data-label="活动">
        <ActivityRowTitle
          title={activity.title}
          status={activity.status}
          href={
            activity.status === "draft"
              ? `/my/activities/${activity.id}`
              : `/activities/${activity.id}`
          }
          deadlineAt={activity.deadlineAt}
          draw={activity.draw}
          buttonClassName="work-row-title"
        />
      </td>
      <td className="activity-table-reward" data-label="奖励配置">
        <ActivityReward label="LDC" summary={authorRewardMain(activity)} />
      </td>
      <td className="activity-table-progress" data-label="参与情况">
        <div className="work-managed-progress">
          <strong>{participationText(activity)}</strong>
        </div>
      </td>
      <td className="activity-table-date" data-label="创建时间">
        <span className="activity-table-created">
          {formatTime(activity.createdAt)}
        </span>
      </td>
      <td className="activity-table-actions" data-label="操作">
        <RowActions label={activity.title || "未命名活动"} actions={actions} />
      </td>
    </tr>
  );
}
