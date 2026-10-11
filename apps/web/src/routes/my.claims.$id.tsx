import { createFileRoute, Navigate } from "@tanstack/react-router";
import { ActivityErrorView } from "../components/activities/activity-error";
import { RequireAccount } from "../components/activities/require-account";
import { SkeletonRows } from "../components/presentation/loading";
import { useClaim } from "../lib/claims";
import { isBlockingQueryError } from "../lib/query-view";

export const Route = createFileRoute("/my/claims/$id")({
  component: LegacyClaimRedirect,
});

function LegacyClaimRedirect() {
  const { id } = Route.useParams();
  return (
    <RequireAccount>
      {({ userId }) => (
        <ClaimActivityRedirect
          key={`${userId}-${id}`}
          userId={userId}
          id={id}
        />
      )}
    </RequireAccount>
  );
}

function ClaimActivityRedirect({ userId, id }: { userId: string; id: string }) {
  const query = useClaim(userId, id);
  const claim = !isBlockingQueryError(query) ? query.data?.claim : undefined;
  if (query.isPending)
    return (
      <div role="status" aria-busy="true" aria-label="正在打开活动">
        <SkeletonRows />
      </div>
    );
  if (!claim)
    return (
      <ActivityErrorView
        error={query.error ?? new Error("读取失败，请重试。")}
        retry={() => query.refetch()}
        notFoundMessage="未找到参与记录，或你无权查看此奖励。"
      />
    );
  return (
    <Navigate to="/activities/$id" params={{ id: claim.activity.id }} replace />
  );
}
