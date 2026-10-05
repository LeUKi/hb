import type {
  ActivityError,
  ActivityIssue,
  ActivityList,
  ActivityStatus,
  CreateActivityInput,
  DeleteActivityInput,
  EndActivityInput,
  ManagedActivity,
  OpenActivityInput,
  PublicActivity,
  PublicQuantity,
  UpdateActivityInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { sessionQueryKey } from "./auth";

export class ActivityRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issues: ActivityIssue[] = [],
    public readonly retryAfterSeconds?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ActivityError | undefined;
    try {
      body = (await response.json()) as ActivityError;
    } catch {
      // The gateway may fail before a JSON response can be produced.
    }
    throw new ActivityRequestError(
      response.status === 409 &&
        body?.error?.code === "ACTIVITY_VERSION_CONFLICT"
        ? "活动已在其他页面修改。当前输入已保留，请先刷新最新版本。"
        : (body?.error?.message ?? `请求失败：HTTP ${response.status}`),
      response.status,
      body?.error?.issues,
      retryAfter(response.headers.get("Retry-After")),
      body?.error?.code,
    );
  }
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

export const activityKeys = {
  mine: (userId: string) => ["activity-private", userId] as const,
  detail: (userId: string, id: string) =>
    ["activity-private", userId, "detail", id] as const,
  public: (id: string, userId: string | null) =>
    ["activity-public", id, userId] as const,
};

export function useMyActivities(userId: string, cursor: string | null) {
  return useQuery({
    queryKey: [...activityKeys.mine(userId), "list", cursor],
    queryFn: async ({ signal }) =>
      readResponse<ActivityList>(
        await api.api.me.activities.$get(
          { query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
  });
}

export function useManagedActivity(userId: string, id: string) {
  return useQuery({
    queryKey: activityKeys.detail(userId, id),
    queryFn: async ({ signal }) =>
      readResponse<{ activity: ManagedActivity }>(
        await api.api.me.activities[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function usePublicActivity(
  id: string,
  userId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: activityKeys.public(id, userId),
    queryFn: async ({ signal }) =>
      readResponse<{ activity: PublicActivity }>(
        await api.api.activities[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    enabled,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useActivityWrites(
  userId: string,
  csrfToken: string,
  id?: string,
) {
  const queryClient = useQueryClient();
  const options = { headers: { "X-CSRF-Token": csrfToken } };
  const onError = (error: Error) => {
    if (
      queryClient.getQueryData<{ user: { id: string } | null }>(sessionQueryKey)
        ?.user?.id !== userId
    )
      return;
    if (error instanceof ActivityRequestError && error.status === 401) {
      queryClient.setQueryData(sessionQueryKey, {
        user: null,
        csrfToken: null,
      });
      queryClient.removeQueries({ queryKey: activityKeys.mine(userId) });
    }
  };
  const onSuccess = async ({ activity }: { activity: ManagedActivity }) => {
    if (
      queryClient.getQueryState(sessionQueryKey)?.status !== "success" ||
      queryClient.getQueryData<{ user: { id: string } | null }>(sessionQueryKey)
        ?.user?.id !== userId
    )
      return;
    queryClient.setQueryData(activityKeys.detail(userId, activity.id), {
      activity,
    });
    await queryClient.invalidateQueries({
      queryKey: activityKeys.mine(userId),
    });
    await queryClient.invalidateQueries({
      queryKey: ["activity-public", activity.id],
    });
  };
  return {
    create: useMutation({
      mutationFn: async (json: CreateActivityInput) =>
        readResponse<{ activity: ManagedActivity }>(
          await api.api.activities.$post({ json }, options),
        ),
      onSuccess,
      onError,
    }),
    update: useMutation({
      mutationFn: async (json: UpdateActivityInput) => {
        if (!id) throw new Error("缺少活动标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].$patch(
            { param: { id }, json },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    open: useMutation({
      mutationFn: async (json: OpenActivityInput) => {
        if (!id) throw new Error("缺少活动标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].open.$post(
            { param: { id }, json },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    end: useMutation({
      mutationFn: async (json: EndActivityInput) => {
        if (!id) throw new Error("缺少活动标识");
        return readResponse<{ activity: ManagedActivity }>(
          await api.api.me.activities[":id"].end.$post(
            { param: { id }, json },
            options,
          ),
        );
      },
      onSuccess,
      onError,
    }),
    remove: useMutation({
      mutationFn: async (json: DeleteActivityInput) => {
        if (!id) throw new Error("缺少活动标识");
        return readResponse<{
          id: string;
          deleted: true;
          deletedAt: string;
          version: number;
        }>(
          await api.api.me.activities[":id"].$delete(
            { param: { id }, json },
            options,
          ),
        );
      },
      onSuccess: async (result) => {
        if (
          queryClient.getQueryData<{ user: { id: string } | null }>(
            sessionQueryKey,
          )?.user?.id !== userId
        )
          return;
        queryClient.removeQueries({
          queryKey: activityKeys.detail(userId, result.id),
        });
        queryClient.removeQueries({ queryKey: ["activity-public", result.id] });
        queryClient.removeQueries({
          queryKey: ["password-private", userId, result.id],
        });
        await queryClient.invalidateQueries({
          queryKey: activityKeys.mine(userId),
        });
      },
      onError,
    }),
  };
}

export const statusLabels: Record<ActivityStatus, string> = {
  draft: "准备中",
  active: "进行中",
  ended: "已结束",
  archived: "已归档",
};

export function formatTime(time: string | null) {
  return time
    ? new Date(time).toLocaleString("zh-CN", { hour12: false })
    : "开放后确定";
}

export function quantityText(quantity: PublicQuantity) {
  switch (quantity.mode) {
    case "hidden":
      return null;
    case "exact":
      return `共 ${quantity.total} 份 · 已领取 ${quantity.claimed} 份 · 剩余 ${quantity.remaining} 份`;
    case "availability":
      return quantity.available ? "还有奖励" : "没有剩余奖励";
    case "fuzzy":
      return {
        plenty: "奖励充足",
        limited: "奖励有限",
        low: "剩余少量奖励",
        empty: "奖励已领完",
      }[quantity.level];
  }
}
