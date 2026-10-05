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
import { formatTime, statusLabels } from "../lib/activities";
import { useMyClaims } from "../lib/claims";

export const Route = createFileRoute("/my/claims")({ component: MyClaimsPage });

function MyClaimsPage() {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/my/claims/$id", fuzzy: true })) return <Outlet />;
  return (
    <RequireAccount>
      {({ userId }) => <MyClaims key={userId} userId={userId} />}
    </RequireAccount>
  );
}

function MyClaims({ userId }: { userId: string }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useMyClaims(userId, cursors.at(-1) ?? null);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">我的领取</h1>
      {query.isPending ? (
        <p role="status">正在读取领取记录…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {query.data.items.map((claim) => (
                <article key={claim.id} className="activity-panel space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="min-w-0 break-words font-semibold">
                      {claim.activity.title}
                    </h2>
                    <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs">
                      {statusLabels[claim.activity.status]}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-600">
                    {claim.rewardType === "ldc" ? "LDC" : "文本奖励"} ·{" "}
                    {formatTime(claim.claimedAt)}
                  </p>
                  <Button asChild variant="secondary">
                    <Link to="/my/claims/$id" params={{ id: claim.id }}>
                      查看奖励
                    </Link>
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            <p className="activity-panel text-neutral-600">还没有领取记录。</p>
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
