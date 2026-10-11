import { QueryCache, QueryClient } from "@tanstack/react-query";
import { accessQueryScope, isAccessQueryError } from "./query-view";

function privateActivityAccess(
  key: readonly unknown[],
): { userId: string; activityId: string } | null {
  if (
    key[0] === "activity-private" &&
    typeof key[1] === "string" &&
    typeof key[3] === "string" &&
    ["detail", "statistics", "author", "author-registrations"].includes(
      String(key[2]),
    )
  )
    return { userId: key[1], activityId: key[3] };
  if (
    key[0] === "activity-roster" &&
    typeof key[1] === "string" &&
    typeof key[2] === "string" &&
    key[3] === "author"
  )
    return { userId: key[2].split(":", 1)[0] ?? "", activityId: key[1] };
  return null;
}

function samePrivateActivity(
  key: readonly unknown[],
  access: { userId: string; activityId: string },
) {
  const privateAccess = privateActivityAccess(key);
  return (
    privateAccess?.userId === access.userId &&
    privateAccess.activityId === access.activityId
  );
}

export function createAppQueryClient() {
  const queryCache = new QueryCache({
    onError: (error, query) => {
      // A later transport failure must never resurrect data denied by the server.
      if (!isAccessQueryError(error)) return;
      const privateAccess = privateActivityAccess(query.queryKey);
      const relatedQueries = privateAccess
        ? queryCache.findAll({
            predicate: (candidate) =>
              samePrivateActivity(candidate.queryKey, privateAccess),
          })
        : queryCache.findAll({ queryKey: accessQueryScope(query.queryKey) });
      for (const related of relatedQueries) {
        // Cancel before clearing so an older response cannot refill the scope.
        void related.cancel({ revert: false, silent: true });
        related.setState({
          data: undefined,
          dataUpdatedAt: 0,
          status: "error",
          fetchStatus: "idle",
          error,
        });
      }
    },
  });
  return new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        // Reuse recent data across observers, filters and route revisits.
        // Polling and explicit invalidation still refresh live business state.
        staleTime: 15_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}
