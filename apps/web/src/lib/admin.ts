import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminAuditEntry,
  AdminCursorList,
  AdminOverview,
  AdminPaymentDetailResponse,
  AdminPaymentListItem,
  AdminUserDetail,
  AdminUserListItem,
  AttemptRateLimitsResponse,
  UpdateAttemptRateLimitsInput,
} from "@hb/contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { readResponse } from "./activities";
import { adminIdentity } from "./admin-identity";
import { useSession } from "./auth";

// 网站管理 (/admin): production's read-only admin API, and the one setting
// an admin can change. Every read is kept under the session that made it
// (query-cache.ts drops them when the session changes, and turns a 401 or
// 403 into the account it now is).

/** The admin session reads belong to. */
export function useAdminIdentity() {
  const session = useSession();
  return session.data ? adminIdentity(session.data) : "anonymous";
}

export const adminKey = (identity: string, ...rest: unknown[]) =>
  ["admin-private", identity, ...rest] as const;

async function readAdmin<T>(
  path: string,
  params: Record<string, string | undefined>,
  signal: AbortSignal,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) query.set(key, value);
  const search = query.toString();
  return readResponse<T>(
    await fetch(`/api/admin/${path}${search ? `?${search}` : ""}`, {
      signal,
      cache: "no-store",
    }),
  );
}

/** 概览: read every 30 s, and again when the window comes back. */
export function useAdminOverview() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, "overview"),
    queryFn: ({ signal }) => readAdmin<AdminOverview>("overview", {}, signal),
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

type ListItems = {
  activities: AdminActivityListItem;
  users: AdminUserListItem;
  payments: AdminPaymentListItem;
  audit: AdminAuditEntry;
};

/**
 * One of the lists, 20 at a time, newest first. A new filter keeps the rows
 * on screen until its own first page is in (`isPlaceholderData`).
 */
export function useAdminList<K extends keyof ListItems>(
  kind: K,
  params: Record<string, string | undefined>,
) {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: adminKey(identity, kind, params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      readAdmin<AdminCursorList<ListItems[K]>>(
        kind,
        { ...params, cursor: pageParam ?? undefined },
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * One row's detail. `read: false` only uses what is cached (a filter's
 * name that the list rows already give).
 */
function useAdminDetail<T>(
  kind: "activities" | "users" | "payments",
  id: string | null,
  read = true,
) {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, kind, "detail", id),
    queryFn: ({ signal }) =>
      readAdmin<T>(`${kind}/${encodeURIComponent(id ?? "")}`, {}, signal),
    enabled: id !== null && read,
    retry: false,
  });
}

export const useAdminActivity = (id: string | null, read?: boolean) =>
  useAdminDetail<{ activity: AdminActivityDetail }>("activities", id, read);
export const useAdminUser = (id: string | null, read?: boolean) =>
  useAdminDetail<{ user: AdminUserDetail }>("users", id, read);
export const useAdminPayment = (id: string | null) =>
  useAdminDetail<AdminPaymentDetailResponse>("payments", id);

/**
 * 网站设置: the 口令 attempt intervals, with the latest changes; read
 * again whenever the window comes back (another admin may have saved).
 */
export function useRateLimits() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, "rate-limits"),
    queryFn: ({ signal }) =>
      readAdmin<AttemptRateLimitsResponse>("rate-limits", {}, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Saving the intervals, against the version read (a 409 when someone saved
 * first). `check` reads what is saved now, outside the page's data (a lost
 * answer, a conflict); `adopt` makes an answer the page's data and has
 * 操作记录 read again.
 */
export function useSaveRateLimits(csrfToken: string) {
  const identity = useAdminIdentity();
  const queryClient = useQueryClient();
  const adopt = async (saved: AttemptRateLimitsResponse) => {
    const queryKey = adminKey(identity, "rate-limits");
    // A read already on its way must not put the older version back.
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, saved);
    void queryClient.invalidateQueries({
      queryKey: adminKey(identity, "audit"),
    });
  };
  return {
    run: async (input: UpdateAttemptRateLimitsInput) => {
      const saved = await readResponse<AttemptRateLimitsResponse>(
        await fetch("/api/admin/rate-limits", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify(input),
          cache: "no-store",
        }),
      );
      await adopt(saved);
      return saved;
    },
    check: () =>
      readAdmin<AttemptRateLimitsResponse>(
        "rate-limits",
        {},
        new AbortController().signal,
      ).catch(() => null),
    adopt,
  };
}
