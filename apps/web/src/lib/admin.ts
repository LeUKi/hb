import type {
  AdminActivityDetail,
  AdminActivityListItem,
  AdminAuditEntry,
  AdminCursorList,
  AdminJudgeCuration,
  AdminJudgeUsage,
  AdminOverview,
  AdminPaymentDetailResponse,
  AdminPaymentListItem,
  AdminUserDetail,
  AdminUserListItem,
  AttemptRateLimitsResponse,
  JudgeSettingChange,
  JudgeSettings,
  UpdateAttemptRateLimitsInput,
  UpdateJudgeSettingsInput,
} from "@hb/contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { readResponse } from "./activities";
import { adminIdentity } from "./admin-identity";
import { useSession } from "./auth";
import { haptic } from "./haptics";
import { useIdentity } from "./session";

// 网站管理 (/admin): production's read-only admin API, and the settings
// an admin can change (尝试间隔, 判定器设置; 🐟额's are in admin-balance.ts).
// Every read is kept under the session that made it (query-cache.ts drops
// them when the session changes, and turns a 401 or 403 into the account it
// now is).

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
      // 震动反馈: felt as it answers.
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
      ).catch((error: unknown) => {
        haptic("error");
        throw error;
      });
      haptic("success");
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

/**
 * 停用 a 代码判定红包 (07 §10): the one change an admin makes to someone
 * else's 红包. Its detail, the lists and 操作记录 read again after.
 */
export function useStopCode(csrfToken: string) {
  const identity = useAdminIdentity();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (activityId: string) => {
      await readResponse<{ status: "stopped" }>(
        await fetch(
          `/api/admin/activities/${encodeURIComponent(activityId)}/stop-code`,
          {
            method: "POST",
            headers: { "X-CSRF-Token": csrfToken },
            cache: "no-store",
          },
        ),
      );
      // 判定器's 用量 lists the 红包 as 进行中 until read again.
      for (const rest of [
        ["activities"],
        ["audit"],
        ["overview"],
        ["judge", "usage"],
      ])
        void queryClient.invalidateQueries({
          queryKey: adminKey(identity, ...rest),
        });
    },
  });
}

/** 停用附带网页 (docs/attached-page-design.md §1): for good. */
export function useStopPage(csrfToken: string) {
  const identity = useAdminIdentity();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (activityId: string) => {
      await readResponse<{ stopped: true }>(
        await fetch(
          `/api/admin/activities/${encodeURIComponent(activityId)}/stop-page`,
          {
            method: "POST",
            headers: { "X-CSRF-Token": csrfToken },
            cache: "no-store",
          },
        ),
      );
      for (const rest of [["activities"], ["audit"]])
        void queryClient.invalidateQueries({
          queryKey: adminKey(identity, ...rest),
        });
    },
  });
}

/**
 * 判定器's 用量 (07 §10): today and this month (UTC days, as billed), the
 * last 30 days, and this month's top people and 红包.
 */
export function useJudgeUsage() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, "judge", "usage"),
    queryFn: ({ signal }) =>
      readAdmin<AdminJudgeUsage>("judge/usage", {}, signal),
    retry: false,
  });
}

export type JudgeSettingsResponse = {
  settings: JudgeSettings;
  recentChanges: JudgeSettingChange[];
};

/** 判定器设置, read again whenever the window comes back, as 网站设置's. */
export function useJudgeSettings() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, "judge", "settings"),
    queryFn: ({ signal }) =>
      readAdmin<JudgeSettingsResponse>("judge/settings", {}, signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Saving 判定器设置 against the version read (a 409 when someone saved
 * first), as the intervals are saved: `check` reads what is saved now, and
 * `adopt` makes it the page's data. A save also has 用量 (its 上限) and
 * 操作记录 read again.
 */
export function useSaveJudgeSettings(csrfToken: string) {
  const identity = useAdminIdentity();
  const queryClient = useQueryClient();
  const queryKey = adminKey(identity, "judge", "settings");
  const adopt = async (fresh: JudgeSettingsResponse) => {
    // A read already on its way must not put the older version back.
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, fresh);
  };
  const others = () => {
    for (const rest of [["judge", "usage"], ["audit"]])
      void queryClient.invalidateQueries({
        queryKey: adminKey(identity, ...rest),
      });
  };
  return {
    run: async (input: UpdateJudgeSettingsInput) => {
      const { settings } = await readResponse<{ settings: JudgeSettings }>(
        await fetch("/api/admin/judge/settings", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify(input),
          cache: "no-store",
        }),
      );
      // The new version now; who saved it comes with the next read.
      const current = queryClient.getQueryData<JudgeSettingsResponse>(queryKey);
      await adopt({ settings, recentChanges: current?.recentChanges ?? [] });
      void queryClient.invalidateQueries({ queryKey });
      others();
      return settings;
    },
    check: () =>
      readAdmin<JudgeSettingsResponse>(
        "judge/settings",
        {},
        new AbortController().signal,
      ).catch(() => null),
    adopt: async (fresh: JudgeSettingsResponse) => {
      await adopt(fresh);
      others();
    },
  };
}

/** 判定器广场's 精选 and 已撤下 (docs/judge-square-design.md §15.4). */
export function useJudgeCuration() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: adminKey(identity, "judge", "curation"),
    queryFn: ({ signal }) =>
      readAdmin<AdminJudgeCuration>("judge/curation", {}, signal),
    retry: false,
  });
}

export type JudgeCurationAction =
  | { kind: "feature"; judgeId: string; n: number }
  | { kind: "move"; judgeId: string; move: "up" | "down" }
  | { kind: "version"; judgeId: string; n: number }
  | { kind: "unfeature"; judgeId: string }
  | { kind: "takeDown"; judgeId: string; reason: string }
  | { kind: "restore"; judgeId: string };

/**
 * 精选's changes, 撤下 and 恢复: the list read again (an answer carries it
 * for 精选), 操作记录 and the 广场's own reads with it.
 */
export function useJudgeCurationWrites() {
  const identity = useAdminIdentity();
  const { csrfToken } = useIdentity();
  const queryClient = useQueryClient();
  const queryKey = adminKey(identity, "judge", "curation");
  return useMutation({
    mutationFn: async (action: JudgeCurationAction) => {
      const id = encodeURIComponent(action.judgeId);
      const [method, path, body] =
        action.kind === "feature"
          ? ["POST", "judge/features", { judgeId: action.judgeId, n: action.n }]
          : action.kind === "move"
            ? ["PUT", `judge/features/${id}`, { move: action.move }]
            : action.kind === "version"
              ? ["PUT", `judge/features/${id}`, { n: action.n }]
              : action.kind === "unfeature"
                ? ["DELETE", `judge/features/${id}`, undefined]
                : action.kind === "takeDown"
                  ? [
                      "POST",
                      `judges/${id}/take-down`,
                      { reason: action.reason },
                    ]
                  : ["POST", `judges/${id}/restore`, undefined];
      return readResponse<AdminJudgeCuration | { ok: true }>(
        await fetch(`/api/admin/${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken ?? "",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
        }),
      );
    },
    // Done once what shows it is read again: a dialog closes on the page
    // as it now is, a row moves when the list has.
    onSuccess: async (answer) => {
      if ("features" in answer) queryClient.setQueryData(queryKey, answer);
      void queryClient.invalidateQueries({
        queryKey: adminKey(identity, "audit"),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ["judge-square"] }),
      ]);
    },
  });
}
