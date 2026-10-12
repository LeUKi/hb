import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ActivityRequestError } from "./activities";
import { adminIdentity } from "./admin-identity";
import { type SessionResponse, sessionQueryKey } from "./auth";
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

function cachedActivityId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as {
    activity?: { id?: unknown };
    claim?: { activityId?: unknown; activity?: { id?: unknown } };
    registration?: { activityId?: unknown; activity?: { id?: unknown } };
  };
  if (typeof record.activity?.id === "string") return record.activity.id;
  if (typeof record.claim?.activityId === "string")
    return record.claim.activityId;
  if (typeof record.claim?.activity?.id === "string")
    return record.claim.activity.id;
  if (typeof record.registration?.activityId === "string")
    return record.registration.activityId;
  if (typeof record.registration?.activity?.id === "string")
    return record.registration.activity.id;
  return null;
}

function activityAccess(
  key: readonly unknown[],
): { activityId: string } | null {
  if (key[0] === "activity-public" && typeof key[1] === "string")
    return { activityId: key[1] };
  if (
    key[0] === "activity-private" &&
    typeof key[3] === "string" &&
    ["detail", "statistics", "author", "author-registrations"].includes(
      String(key[2]),
    )
  )
    return { activityId: key[3] };
  if (key[0] === "activity-roster" && typeof key[1] === "string")
    return { activityId: key[1] };
  if (key[0] === "password-private" && typeof key[2] === "string")
    return { activityId: key[2] };
  if (
    key[0] === "claim-private" &&
    key[2] === "participation" &&
    typeof key[3] === "string"
  )
    return { activityId: key[3] };
  return null;
}

function isActivityListQuery(key: readonly unknown[]) {
  return key[0] === "discovery" || key[0] === "topic-activities";
}

function removeActivityFromListData(
  data: unknown,
  activityId: string,
): unknown {
  if (!data || typeof data !== "object" || !("items" in data)) return data;
  const list = data as { items?: unknown[]; total?: unknown };
  if (!Array.isArray(list.items)) return data;
  const items = list.items.filter(
    (item) =>
      !item ||
      typeof item !== "object" ||
      !("id" in item) ||
      (item as { id?: unknown }).id !== activityId,
  );
  if (items.length === list.items.length) return data;
  return {
    ...data,
    items,
    total:
      typeof list.total === "number"
        ? Math.max(0, list.total - (list.items.length - items.length))
        : list.total,
  };
}

export function createAppQueryClient() {
  const queryCache = new QueryCache({
    onError: (error, query) => {
      // A later transport failure must never resurrect data denied by the server.
      if (!isAccessQueryError(error)) return;
      if (
        query.queryKey[0] === "admin-private" &&
        error instanceof ActivityRequestError &&
        [401, 403].includes(error.status)
      ) {
        const status = error.status;
        const session = queryCache.find({ queryKey: sessionQueryKey });
        const data = session?.state.data as SessionResponse | undefined;
        if (session && data) {
          session.setState({
            data: {
              ...data,
              user:
                status === 401
                  ? null
                  : data.user
                    ? { ...data.user, isAdmin: false }
                    : null,
              csrfToken: status === 401 ? null : data.csrfToken,
            },
          });
        }
        for (const related of queryCache.findAll({
          queryKey: ["admin-private"],
        })) {
          void related.cancel({ revert: false, silent: true });
          related.setState({
            data: undefined,
            dataUpdatedAt: 0,
            status: "error",
            fetchStatus: "idle",
            error,
          });
        }
        return;
      }
      const access = activityAccess(query.queryKey);
      if (
        access &&
        error instanceof ActivityRequestError &&
        error.status === 404
      ) {
        for (const related of queryCache.findAll({
          predicate: (candidate) => {
            const candidateAccess = activityAccess(candidate.queryKey);
            if (candidateAccess?.activityId === access.activityId) return true;
            const cached = cachedActivityId(candidate.state.data);
            if (cached === access.activityId) return true;
            if (!isActivityListQuery(candidate.queryKey)) return false;
            return (
              removeActivityFromListData(
                candidate.state.data,
                access.activityId,
              ) !== candidate.state.data
            );
          },
        })) {
          void related.cancel({ revert: false, silent: true });
          if (isActivityListQuery(related.queryKey)) {
            related.setState({
              data: removeActivityFromListData(
                related.state.data,
                access.activityId,
              ),
              fetchStatus: "idle",
              status: "success",
              error: null,
            });
            continue;
          }
          related.setState({
            data: undefined,
            dataUpdatedAt: 0,
            status: "error",
            fetchStatus: "idle",
            error,
          });
        }
        return;
      }
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
  const queryClient = new QueryClient({
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
  queryCache.subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.query.queryKey[0] !== sessionQueryKey[0] ||
      event.query.queryKey[1] !== sessionQueryKey[1]
    )
      return;
    const session = event.query.state.data as SessionResponse | undefined;
    const identity =
      event.query.state.status === "success" && session?.user?.isAdmin
        ? adminIdentity(session)
        : null;
    for (const query of queryCache.findAll({ queryKey: ["admin-private"] })) {
      if (query.queryKey[1] === identity) continue;
      void query.cancel({ revert: false, silent: true });
      queryCache.remove(query);
    }
  });
  return queryClient;
}
