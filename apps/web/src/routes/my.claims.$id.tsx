import { createFileRoute, Link } from "@tanstack/react-router";
import { ActivityErrorView } from "../components/activities/activity-error";
import { ClaimContent } from "../components/activities/claim-content";
import { RequireAccount } from "../components/activities/require-account";
import { statusLabels } from "../lib/activities";
import { useClaim } from "../lib/claims";

export const Route = createFileRoute("/my/claims/$id")({
  component: ClaimDetailPage,
});

function ClaimDetailPage() {
  const { id } = Route.useParams();
  return (
    <RequireAccount>
      {({ userId }) => (
        <ClaimDetail key={`${userId}-${id}`} userId={userId} id={id} />
      )}
    </RequireAccount>
  );
}

function ClaimDetail({ userId, id }: { userId: string; id: string }) {
  const query = useClaim(userId, id);
  if (query.isPending) return <p role="status">正在读取奖励…</p>;
  if (query.isError)
    return (
      <ActivityErrorView
        error={query.error}
        retry={() => query.refetch()}
        notFoundMessage="未找到领取记录，或你无权查看此奖励。"
      />
    );
  const { claim } = query.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">领取详情</h1>
        <Link to="/my/claims" className="text-sm underline underline-offset-4">
          我的领取
        </Link>
      </div>
      <article className="activity-panel space-y-6">
        <header className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 break-words text-xl font-semibold">
              {claim.activity.title}
            </h2>
            <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-sm">
              {statusLabels[claim.activity.status]}
            </span>
          </div>
          <Link
            to="/activities/$id"
            params={{ id: claim.activity.id }}
            className="inline-block text-sm underline underline-offset-4"
          >
            查看活动专属页
          </Link>
        </header>
        <ClaimContent claim={claim} />
      </article>
    </div>
  );
}
