import type {
  ActivityAuthor,
  ActivityStatus,
  Participation,
} from "@hb/contracts";
import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useRouterState,
} from "@tanstack/react-router";
import { type SetStateAction, useCallback, useEffect } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { RequireAccount } from "../components/activities/require-account";
import {
  ActivityReward,
  ActivityRowTitle,
  CompactActivityTable,
  HistoryStats,
  HistoryTabs,
  type RowAction,
  RowActions,
  registrationLabel,
  rewardKindLabel,
  rewardMainText,
} from "../components/presentation/activity-list";
import {
  ListPanel,
  ListRefreshButton,
  Pagination,
} from "../components/presentation/list-controls";
import { RefreshNotice } from "../components/presentation/loading";
import { UserIdentity } from "../components/user-identity";
import { formatTime, useHistorySummary } from "../lib/activities";
import { useMyParticipations } from "../lib/claims";
import {
  useCursorRecovery,
  useEntryNavigate,
  useViewState,
} from "../lib/navigation-state";
import { listQueryState } from "../lib/query-view";

type Search = Record<string, never>;
type ScopedCursors = { scope: string; cursors: Array<string | null> };

const participationColumns = [
  { key: "activity", label: "活动", width: "36%" },
  { key: "author", label: "发布者", width: "15%" },
  { key: "reward", label: "我的奖励", width: "20%" },
  { key: "time", label: "参与时间", width: "17%" },
  { key: "actions", label: "操作", width: "12%" },
];

export const Route = createFileRoute("/my/claims")({
  validateSearch: (): Search => ({}),
  component: MyClaimsPage,
});

function MyClaimsPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/claims/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount>
      {({ userId }) => <MyParticipations key={userId} userId={userId} />}
    </RequireAccount>
  );
}

function MyParticipations({ userId }: { userId: string }) {
  const navigate = useEntryNavigate();
  const legacyRewardFilter = useRouterState({
    select: (state) =>
      new URL(state.location.href, "http://local").searchParams.has("type"),
  });
  const summary = useHistorySummary(userId);
  useEffect(() => {
    if (!legacyRewardFilter) return;
    void navigate({
      to: "/my/claims",
      search: {},
      replace: true,
      resetScroll: false,
    });
  }, [legacyRewardFilter, navigate]);
  const cursorScope = userId;
  const [pager, setPager] = useViewState<ScopedCursors>("participated-pager", {
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
  const query = useMyParticipations(userId, cursor);
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
          <HistoryTabs active="claims" />
        </div>
        <HistoryStats
          summary={{
            started: summary.data?.initiatedCount ?? null,
            participated: summary.data?.participatedCount ?? null,
          }}
        />
      </div>
      <section className="participations-page work-page work-list-page list-page">
        <div className="activity-list-toolbar">
          <ListRefreshButton
            label="刷新参与记录"
            busy={query.isFetching || summary.isFetching}
            onRefresh={() => {
              void query.refetch();
              void summary.refetch();
            }}
          />
        </div>
        {cursorNotice}
        <ListPanel
          restorationId="participated"
          keepContent
          state={listState}
          emptyText="还没有符合条件的参与记录。"
          onRetry={query.isError ? () => query.refetch() : undefined}
          refreshNotice={<RefreshNotice query={query} />}
          resetKey={`${cursorScope}:${cursors.length}`}
          footer={
            <Pagination
              label="参与记录分页"
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
              label="我参与的活动"
              variant="participation"
              columns={participationColumns}
              state={listState}
              emptyText="还没有符合条件的参与记录。"
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
              {query.data?.items.map((item) => (
                <ParticipationRow key={participationKey(item)} item={item} />
              ))}
            </CompactActivityTable>
          </div>
        </ListPanel>
      </section>
    </div>
  );
}

function participationKey(item: Participation) {
  return item.kind === "claim"
    ? `claim-${item.claim.id}`
    : `registration-${item.registration.id}`;
}

type ParticipationActivityWithExtras = {
  participationMode?: "password" | "direct";
  id: string;
  title: string;
  status: ActivityStatus;
  deadlineAt?: string | null;
  reward?: Parameters<typeof rewardMainText>[0];
  author?: ActivityAuthor;
  createdAt?: string;
  draw?: { state?: string } | null;
};

function ParticipationRow({ item }: { item: Participation }) {
  const activity = (
    item.kind === "claim" ? item.claim.activity : item.registration.activity
  ) as ParticipationActivityWithExtras;
  const source =
    item.kind === "claim"
      ? item.claim.sourcePassword
      : item.registration.sourcePassword;
  const action = item.kind === "claim" ? "兑换" : "报名";
  const meta =
    activity.participationMode === "direct" ? (
      <span>
        {item.kind === "registration" || activity.draw
          ? "直接报名"
          : "直接领取"}
      </span>
    ) : (
      <span>
        通过口令{" "}
        <span className="activity-inline-code">{source || "未记录"}</span>{" "}
        {action}
      </span>
    );
  const claim = item.kind === "claim" ? item.claim : item.registration.claim;
  const result =
    item.kind === "claim"
      ? "已领取"
      : registrationLabel(item.registration.status);
  const time =
    item.kind === "claim"
      ? item.claim.claimedAt
      : item.registration.registeredAt;
  const actions: RowAction[] = [{ label: "查看活动", activityId: activity.id }];
  return (
    <tr
      className="activity-rows-row compact-activity-row"
      data-activity-id={activity.id}
      data-lifecycle={activity.status}
      data-participation={result}
      data-draw={activity.draw?.state ?? undefined}
    >
      <td className="activity-table-activity" data-label="活动">
        <ActivityRowTitle
          title={activity.title}
          status={activity.status}
          href={`/activities/${activity.id}`}
          deadlineAt={activity.deadlineAt}
          draw={activity.draw}
          buttonClassName="activity-rows-open"
        >
          <div className="activity-rows-source">{meta}</div>
        </ActivityRowTitle>
      </td>
      <td
        className="activity-table-author activity-rows-author"
        data-label="发布者"
      >
        {activity.author ? (
          <UserIdentity profile={activity.author} />
        ) : (
          <span className="activity-subtle">未记录</span>
        )}
      </td>
      <td
        className="activity-table-reward activity-rows-reward"
        data-label="我的奖励"
      >
        <ActivityReward
          label={rewardKindLabel(activity.reward)}
          amount={claim?.amount}
          summary={
            !claim?.amount && item.kind === "claim"
              ? rewardMainText(activity.reward)
              : undefined
          }
          status={item.kind === "registration" ? result : undefined}
          paymentStatus={claim?.payment?.status}
          confirmedAt={claim?.payment?.confirmedAt}
        />
      </td>
      <td className="activity-table-date" data-label="参与时间">
        <span className="activity-rows-quantity activity-rows-time">
          {formatTime(time)}
        </span>
      </td>
      <td className="activity-table-actions" data-label="操作">
        <RowActions label={activity.title || "未命名活动"} actions={actions} />
      </td>
    </tr>
  );
}
