import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/my/activities/$id/statistics")({
  component: LegacyStatisticsRedirect,
});

function LegacyStatisticsRedirect() {
  const { id } = Route.useParams();
  return (
    <Navigate
      to="/my/activities"
      search={{ type: "all", statistics: id }}
      replace
    />
  );
}
