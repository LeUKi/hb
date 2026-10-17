import type {
  AccountHistorySummary,
  ActivityError,
  ActivityIssue,
  AttemptCooldown,
  CreateActivityInput,
  DeleteActivityInput,
  EndActivityInput,
  HumanCheckChallenge,
  ManagedActivity,
  OpenActivityInput,
  PublicActivity,
  UpdateActivityInput,
} from "@hb/contracts";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { api } from "../api";
import { sessionQueryKey, useAccountSession } from "./auth";
import { MAINTENANCE, noteMaintenance } from "./maintenance";

export class ActivityRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues: ActivityIssue[] = [],
    public readonly retryAfterSeconds?: number,
    public readonly code?: string,
    public readonly attemptCooldown?: AttemptCooldown | null,
    /** HUMAN_CHECK_REQUIRED: what the Turnstile widget needs. */
    public readonly humanCheck?: HumanCheckChallenge,
  ) {
    super(message);
  }
}

/**
 * The server turned the request down and did nothing; its message says why.
 * From 500 up (or with no answer at all) the outcome is unknown, except in
 * 维护模式, which turns every request away before it does anything.
 */
export function refused(error: unknown): error is ActivityRequestError {
  return (
    error instanceof ActivityRequestError &&
    (error.status < 500 || error.code === MAINTENANCE)
  );
}

export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ActivityError | undefined;
    try {
      body = (await response.json()) as ActivityError;
    } catch {
      // The gateway may fail before a JSON response can be produced.
    }
    noteMaintenance(
      response.status === 503 && body?.error?.code === MAINTENANCE,
    );
    throw new ActivityRequestError(
      response.status === 409 &&
        body?.error?.code === "ACTIVITY_VERSION_CONFLICT"
        ? "红包内容已发生变化，请刷新后再试。"
        : (body?.error?.message ?? `请求失败：HTTP ${response.status}`),
      response.status,
      body?.error?.issues,
      retryAfter(response.headers.get("Retry-After")),
      body?.error?.code,
      (body as { attemptCooldown?: AttemptCooldown | null } | undefined)
        ?.attemptCooldown ?? null,
      body?.humanCheck,
    );
  }
  noteMaintenance(false);
  return (await response.json()) as T;
}

function retryAfter(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const until = Date.parse(value);
  return Number.isFinite(until)
    ? Math.max(0, Math.ceil((until - Date.now()) / 1000))
    : undefined;
}

export const historyListRefreshOptions = {
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: false,
} as const;

type PageFocusRefetch = () => unknown;

const mountedPageFocusRefreshes = new Set<PageFocusRefetch>();
let pageFocusRefreshTimer: number | undefined;
let pageFocusRefreshListening = false;

function flushPageFocusRefreshes() {
  pageFocusRefreshTimer = undefined;
  if (document.visibilityState === "hidden") return;
  for (const refresh of Array.from(mountedPageFocusRefreshes)) void refresh();
}

function schedulePageFocusRefresh() {
  if (document.visibilityState === "hidden") return;
  if (pageFocusRefreshTimer !== undefined) return;
  pageFocusRefreshTimer = window.setTimeout(flushPageFocusRefreshes, 100);
}

function ensurePageFocusRefreshListeners() {
  if (pageFocusRefreshListening) return;
  window.addEventListener("focus", schedulePageFocusRefresh);
  document.addEventListener("visibilitychange", schedulePageFocusRefresh);
  pageFocusRefreshListening = true;
}

function cleanupPageFocusRefreshListeners() {
  if (!pageFocusRefreshListening || mountedPageFocusRefreshes.size > 0) return;
  window.removeEventListener("focus", schedulePageFocusRefresh);
  document.removeEventListener("visibilitychange", schedulePageFocusRefresh);
  if (pageFocusRefreshTimer !== undefined) {
    window.clearTimeout(pageFocusRefreshTimer);
    pageFocusRefreshTimer = undefined;
  }
  pageFocusRefreshListening = false;
}

export function useMountedPageFocusRefresh(
  refetch: (options?: { cancelRefetch?: boolean }) => unknown,
) {
  useEffect(() => {
    const refresh = () => refetch({ cancelRefetch: false });
    mountedPageFocusRefreshes.add(refresh);
    ensurePageFocusRefreshListeners();
    return () => {
      mountedPageFocusRefreshes.delete(refresh);
      cleanupPageFocusRefreshListeners();
    };
  }, [refetch]);
}

export const activityKeys = {
  mine: (userId: string) => ["activity-private", userId] as const,
  detail: (userId: string, id: string) =>
    ["activity-private", userId, "detail", id] as const,
  public: (id: string, userId: string | null) =>
    ["activity-public", id, userId] as const,
};

export function useHistorySummary(userId: string) {
  const query = useQuery({
    queryKey: ["history-private", userId, "summary"],
    queryFn: async ({ signal }) =>
      readResponse<AccountHistorySummary>(
        await fetch("/api/me/history-summary", { signal, cache: "no-store" }),
      ),
    retry: false,
    ...historyListRefreshOptions,
  });
  useMountedPageFocusRefresh(query.refetch);
  return query;
}

export function useManagedActivity(
  userId: string,
  id: string,
  enabled = true,
  /** How often to read it again (the 红包 page: only a 草稿's). */
  poll: number | false = 15_000,
) {
  return useQuery({
    queryKey: activityKeys.detail(userId, id),
    enabled,
    queryFn: async ({ signal }) =>
      readResponse<{ activity: ManagedActivity }>(
        await api.api.me.activities[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: enabled ? poll : false,
  });
}

export type PublicActivityDetail = {
  activity: PublicActivity;
  readGeneration: number;
  /** Actual successful activity read, preserved across cache projections. */
  readAt?: number;
};

let publicActivityReadGeneration = 0;

/** Cache writes retain this source marker; only actual detail reads advance it. */
export function nextPublicActivityReadGeneration(previous = 0) {
  publicActivityReadGeneration =
    Math.max(publicActivityReadGeneration, previous) + 1;
  return publicActivityReadGeneration;
}

export function usePublicActivity(
  id: string,
  userId: string | null,
  enabled: boolean,
  /**
   * How often to read it again, from what was read last; false: not at all
   * (pushed instead, or nothing left to change). Coming back to the page
   * reads it again only while it polls.
   */
  poll: (activity: PublicActivity | undefined) => number | false = () => 5_000,
) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: activityKeys.public(id, userId),
    queryFn: async ({ signal }): Promise<PublicActivityDetail> => {
      const result = await readResponse<{ activity: PublicActivity }>(
        await api.api.activities[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      );
      signal.throwIfAborted();
      return {
        ...result,
        readAt: Date.now(),
        readGeneration: nextPublicActivityReadGeneration(
          client.getQueryData<PublicActivityDetail>(
            activityKeys.public(id, userId),
          )?.readGeneration ?? 0,
        ),
      };
    },
    enabled,
    retry: false,
    refetchInterval: (query) =>
      enabled ? poll(query.state.data?.activity) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const refetch = useCallback(
    () => query.refetch({ cancelRefetch: false }),
    [query.refetch],
  );
  const polling = enabled && poll(query.data?.activity) !== false;
  useMountedPageFocusRefresh(
    useCallback(() => (polling ? refetch() : undefined), [polling, refetch]),
  );
  useEffect(() => {
    if (!enabled)
      void client.cancelQueries({
        queryKey: activityKeys.public(id, userId),
        exact: true,
      });
  }, [client, id, userId, enabled]);
  return { ...query, refetch };
}

/** A deleted draft leaves every cache (its page, its 口令, the lists). */
export function forgetDeletedActivity(
  queryClient: QueryClient,
  userId: string,
  id: string,
) {
  queryClient.removeQueries({ queryKey: activityKeys.detail(userId, id) });
  queryClient.removeQueries({ queryKey: ["activity-public", id] });
  queryClient.removeQueries({ queryKey: ["password-private", userId, id] });
  void queryClient.invalidateQueries({ queryKey: activityKeys.mine(userId) });
  void queryClient.invalidateQueries({
    queryKey: ["history-private", userId],
  });
}

export function useActivityWrites(
  userId: string,
  csrfToken: string,
  id?: string,
) {
  const queryClient = useQueryClient();
  const options = { headers: { "X-CSRF-Token": csrfToken } };
  const account = useAccountSession(userId);
  const onError = (
    error: Error,
    _variables: unknown,
    identity: string | null | undefined,
  ) => {
    if (!account.isCurrentIdentity(identity)) return;
    if (error instanceof ActivityRequestError && error.status === 401) {
      queryClient.setQueryData(sessionQueryKey, {
        user: null,
        csrfToken: null,
      });
      queryClient.removeQueries({ queryKey: activityKeys.mine(userId) });
    }
  };
  const onSuccess = async (
    { activity }: { activity: ManagedActivity },
    _variables: unknown,
    identity: string | null | undefined,
  ) => {
    if (!account.isCurrentIdentity(identity)) return;
    const detailKey = activityKeys.detail(userId, activity.id);
    // An older poll must not replace the configuration just confirmed by PATCH.
    await queryClient.cancelQueries({ queryKey: detailKey });
    if (!account.isCurrentIdentity(identity)) return;
    queryClient.setQueryData(detailKey, {
      activity,
    });
    void queryClient.invalidateQueries({
      queryKey: [...detailKey, "records"],
    });
    // Saving is complete. Refresh dependent projections without holding the form.
    void queryClient.invalidateQueries({
      queryKey: activityKeys.mine(userId),
      predicate: (query) =>
        query.queryKey[2] !== "detail" || query.queryKey[3] !== activity.id,
    });
    void queryClient.invalidateQueries({
      queryKey: ["history-private", userId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["activity-public", activity.id],
    });
    void queryClient.invalidateQueries({ queryKey: ["discovery"] });
    void queryClient.invalidateQueries({ queryKey: ["topic-activities"] });
    void queryClient.invalidateQueries({
      queryKey: ["password-private", userId, activity.id],
    });
    void queryClient.invalidateQueries({
      queryKey: ["activity-roster", activity.id],
    });
  };
  return {
    isCurrentSession: account.isCurrentSession,
    create: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async (json: CreateActivityInput) =>
        readResponse<{ activity: ManagedActivity }>(
          await api.api.activities.$post({ json: json as never }, options),
        ),
      onSuccess,
      onError,
    }),
    update: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async (json: UpdateActivityInput) => {
        if (!id) throw new Error("缺少红包标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].$patch(
            { param: { id }, json: json as never },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    open: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async (json: OpenActivityInput) => {
        if (!id) throw new Error("缺少红包标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].open.$post(
            { param: { id }, json: json as never },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    end: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async (json: EndActivityInput) => {
        if (!id) throw new Error("缺少红包标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].end.$post(
            { param: { id }, json: json as never },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    remove: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async (json: DeleteActivityInput) => {
        if (!id) throw new Error("缺少红包标识");
        return readResponse<{
          id: string;
          deleted: true;
          deletedAt: string;
          version: number;
        }>(
          await api.api.me.activities[":id"].$delete(
            { param: { id }, json: json as never },
            options,
          ),
        );
      },
      onSuccess: (result, _variables, identity) => {
        if (!account.isCurrentIdentity(identity)) return;
        forgetDeletedActivity(queryClient, userId, result.id);
      },
      onError,
    }),
  };
}
