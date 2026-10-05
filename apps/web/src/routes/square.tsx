import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ActivityErrorView } from "../components/activities/activity-error";
import { DiscoveryCards } from "../components/activities/discovery-cards";
import { ListPagination } from "../components/activities/list-pagination";
import { useSession } from "../lib/auth";
import { useDiscovery } from "../lib/discovery";

type SquareSearch = { status?: "all" | "active" | "ended" };
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
  const navigate = useNavigate();
  if (session.isPending) return <p role="status">正在读取活动…</p>;
  if (session.isError)
    return (
      <ActivityErrorView
        error={session.error}
        retry={() => session.refetch()}
      />
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">活动广场</h1>
        <label
          className="flex items-center gap-2 text-sm"
          htmlFor="square-status"
        >
          活动状态
          <select
            id="square-status"
            className="activity-input"
            value={status}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "all" || value === "active" || value === "ended")
                void navigate({ to: "/square", search: { status: value } });
            }}
          >
            <option value="all">全部活动</option>
            <option value="active">进行中</option>
            <option value="ended">已结束</option>
          </select>
        </label>
      </div>
      <SquareResults
        key={`${status}-${session.data.user?.id ?? "guest"}`}
        status={status}
        userId={session.data.user?.id ?? null}
      />
    </div>
  );
}

function SquareResults({
  status,
  userId,
}: {
  status: "all" | "active" | "ended";
  userId: string | null;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useDiscovery(status, cursors.at(-1) ?? null, userId);
  if (query.isPending) return <p role="status">正在读取活动…</p>;
  if (query.isError)
    return (
      <ActivityErrorView error={query.error} retry={() => query.refetch()} />
    );
  return (
    <>
      {query.data.items.length ? (
        <DiscoveryCards items={query.data.items} />
      ) : (
        <p className="activity-panel text-sm text-neutral-600">
          暂无符合条件的活动。
        </p>
      )}
      {query.data.nextCursor || cursors.length > 1 ? (
        <ListPagination
          cursors={cursors}
          setCursors={setCursors}
          nextCursor={query.data.nextCursor}
        />
      ) : null}
    </>
  );
}
