import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type SetStateAction, useCallback, useEffect } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { DiscoveryCards } from "../components/activities/discovery-cards";
import { ActionMenu } from "../components/presentation/action-menu";
import { CompactIconButton } from "../components/presentation/compact-icon-button";
import {
  ListPanel,
  ListRefreshButton,
  Pagination,
} from "../components/presentation/list-controls";
import { RefreshNotice } from "../components/presentation/loading";
import { useSession } from "../lib/auth";
import { useDiscovery } from "../lib/discovery";
import {
  useCursorRecovery,
  useEntryNavigate,
  useViewState,
} from "../lib/navigation-state";
import { listQueryState } from "../lib/query-view";

type SquareStatus = "all" | "active" | "ended";
type SquareSearch = { status?: SquareStatus };
type ScopedCursors = { scope: string; cursors: Array<string | null> };

export const Route = createFileRoute("/square")({
  validateSearch: (search): SquareSearch => ({
    status:
      search.status === "active" || search.status === "ended"
        ? search.status
        : "all",
  }),
  component: SquarePage,
});

function SquarePage() {
  const session = useSession();
  const { status = "all" } = Route.useSearch();
  const legacyRewardFilter = useRouterState({
    select: (state) =>
      new URL(state.location.href, "http://local").searchParams.has("type"),
  });
  const navigate = useEntryNavigate();
  useEffect(() => {
    if (!legacyRewardFilter) return;
    void navigate({
      to: "/square",
      replace: true,
      resetScroll: false,
      search: { status },
    });
  }, [legacyRewardFilter, navigate, status]);
  if (session.isError)
    return (
      <ActivityErrorView
        error={session.error}
        retry={() => session.refetch()}
      />
    );
  return (
    <SquareResults
      status={status}
      userId={session.data?.user?.id ?? null}
      identityKey={
        session.isPending ? "pending" : (session.data.user?.id ?? "guest")
      }
      sessionPending={session.isPending}
      resetLegacyPager={legacyRewardFilter}
      onStatusChange={(value) =>
        void navigate({
          to: "/square",
          replace: true,
          resetScroll: false,
          search: { status: value },
        })
      }
    />
  );
}

function SquareResults({
  status,
  userId,
  identityKey,
  sessionPending,
  resetLegacyPager,
  onStatusChange,
}: {
  status: SquareStatus;
  userId: string | null;
  identityKey: string;
  sessionPending: boolean;
  resetLegacyPager: boolean;
  onStatusChange: (value: SquareStatus) => void;
}) {
  const cursorScope = `${identityKey}:${status}`;
  const [pager, setPager] = useViewState<ScopedCursors>("square-pager", {
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
  useEffect(() => {
    setPager((current) =>
      current.scope === cursorScope && !resetLegacyPager
        ? current
        : { scope: cursorScope, cursors: [null] },
    );
  }, [cursorScope, resetLegacyPager, setPager]);
  const query = useDiscovery(
    status,
    resetLegacyPager ? null : (cursors.at(-1) ?? null),
    userId,
    "all",
    !sessionPending,
  );
  const cursorNotice = useCursorRecovery(query.error, cursors, setCursors);
  const state = sessionPending ? "loading" : listQueryState(query);
  const total = query.data
    ? (query.data.total ?? query.data.items.length)
    : null;
  return (
    <div className="route-frame">
      <section className="gallery-page list-page">
        <div className="page-title">
          <h1>活动广场</h1>
          <section className="history-statistics" aria-label="活动广场统计">
            <div data-statistic="public">
              <span>公开活动</span>
              <span className="history-statistics-value">
                {total ?? "—"}
                <small>场</small>
              </span>
            </div>
          </section>
        </div>
        <div className="gallery-toolbar">
          <div className="gallery-status-filter">
            <ActionMenu
              label={`状态：${status === "all" ? "全部" : status === "active" ? "进行中" : "已结束"}`}
              ariaLabel="活动状态筛选"
              items={[
                {
                  label: "全部",
                  selected: status === "all",
                  onSelect: () => onStatusChange("all"),
                },
                {
                  label: "进行中",
                  selected: status === "active",
                  onSelect: () => onStatusChange("active"),
                },
                {
                  label: "已结束",
                  selected: status === "ended",
                  onSelect: () => onStatusChange("ended"),
                },
              ]}
            />
            {status !== "all" ? (
              <CompactIconButton
                aria-label="清空状态筛选"
                onClick={() => onStatusChange("all")}
              >
                <X size={16} />
              </CompactIconButton>
            ) : null}
          </div>
          <ListRefreshButton
            busy={sessionPending || query.isFetching}
            onRefresh={() => void query.refetch()}
          />
        </div>
        {cursorNotice}
        <ListPanel
          restorationId="square"
          keepContent
          state={state}
          emptyText="暂无符合条件的活动。"
          onRetry={query.isError ? () => query.refetch() : undefined}
          refreshNotice={<RefreshNotice query={query} />}
          resetKey={`${status}:${cursors.length}`}
          footer={
            <Pagination
              label="活动广场分页"
              page={cursors.length}
              hasNext={Boolean(query.data?.nextCursor)}
              onPageChange={(page) => {
                if (page < cursors.length) setCursors(cursors.slice(0, -1));
                else if (query.data?.nextCursor)
                  setCursors([...cursors, query.data.nextCursor]);
              }}
              busy={state === "loading"}
            />
          }
        >
          <DiscoveryCards
            items={query.data?.items ?? []}
            state={state}
            emptyText="暂无符合条件的活动。"
            errorContent={
              query.isError ? (
                <ActivityErrorView
                  error={query.error}
                  retry={() => query.refetch()}
                />
              ) : undefined
            }
            onRetry={query.isError ? () => query.refetch() : undefined}
          />
        </ListPanel>
      </section>
    </div>
  );
}
