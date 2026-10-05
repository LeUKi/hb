import type { Participation } from "@hb/contracts";
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
import { useMyParticipations } from "../lib/claims";

export const Route = createFileRoute("/my/claims")({ component: MyClaimsPage });

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
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const query = useMyParticipations(userId, cursors.at(-1) ?? null);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">我的参与</h1>
      {query.isPending ? (
        <p role="status">正在读取参与记录…</p>
      ) : query.isError ? (
        <ActivityErrorView error={query.error} retry={() => query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {query.data.items.map((item) => (
                <ParticipationCard key={participationKey(item)} item={item} />
              ))}
            </div>
          ) : (
            <p className="activity-panel text-neutral-600">还没有参与记录。</p>
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

function participationKey(item: Participation) {
  return item.kind === "claim"
    ? `claim-${item.claim.id}`
    : `registration-${item.registration.id}`;
}

function ParticipationCard({ item }: { item: Participation }) {
  if (item.kind === "claim") {
    const claim = item.claim;
    return (
      <article className="activity-panel space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 break-words font-semibold">
            {claim.activity.title}
          </h2>
          <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs">
            {statusLabels[claim.activity.status]}
          </span>
        </div>
        <p className="text-sm text-neutral-600">
          已领取 · {claim.rewardType === "ldc" ? "LDC" : "文本奖励"} ·{" "}
          {formatTime(claim.claimedAt)}
        </p>
        <Button asChild variant="secondary">
          <Link to="/my/claims/$id" params={{ id: claim.id }}>
            查看奖励
          </Link>
        </Button>
      </article>
    );
  }
  const registration = item.registration;
  const label = {
    registered: "已报名",
    drawing: "开奖处理中",
    won: "已中奖",
    not_won: "未中奖",
  }[registration.status];
  return (
    <article className="activity-panel space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-semibold">
          {registration.activity.title}
        </h2>
        <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs">
          {statusLabels[registration.activity.status]}
        </span>
      </div>
      <p className="text-sm text-neutral-600">
        限时开奖 · {label} · {formatTime(registration.registeredAt)}
      </p>
      <p className="text-sm text-neutral-600">
        开奖时间：{formatTime(registration.drawAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary">
          <Link to="/activities/$id" params={{ id: registration.activity.id }}>
            查看活动
          </Link>
        </Button>
        {registration.claim ? (
          <Button asChild variant="secondary">
            <Link to="/my/claims/$id" params={{ id: registration.claim.id }}>
              查看奖励
            </Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
