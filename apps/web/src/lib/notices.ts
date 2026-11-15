// 私信通知 (docs/notification-design.md §4): someone's switches and what
// was sent to them, 开放时提醒我 on a timed 红包, and 红包广场's 下一个红包
// 开放时提醒我. Each flips at once and goes back if it was not saved.
import type {
  NoticeAdminStats,
  NoticeCategory,
  NoticePace,
  NoticeSettingsView,
  OpeningWatchView,
  SquareWatchView,
  UpdateNoticePaceInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readResponse } from "./activities";
import { useIdentity } from "./session";

/**
 * The 提醒我 words, kept in one place: 设提醒, the user's pick
 * (docs/notification-design.md §3.1).
 */
export const watchWords = {
  square: "下一个红包开放时提醒我",
  squareOn: "已设提醒，下一个红包开放时私信你",
  opening: "开放时提醒我",
  openingOn: "已设提醒，开放时私信你",
  cancel: "取消",
  /** After the number: “12 人设了提醒”. */
  waiting: "人设了提醒",
  squareJoin: (count: number) =>
    `现在有 ${count} 人设了下一个红包的提醒，开放后能领的人会收到私信。`,
  failed: "没有保存，请稍后再试。",
};

export const noticeKeys = {
  settings: (userId: string) => ["notices", userId, "settings"] as const,
  opening: (activityId: string, userId: string | null) =>
    ["notices", userId ?? "guest", "opening", activityId] as const,
  square: (userId: string | null) =>
    ["notices", userId ?? "guest", "square"] as const,
  admin: ["notices", "admin"] as const,
  pace: ["notices", "admin", "pace"] as const,
};

async function get<T>(path: string, signal?: AbortSignal) {
  return readResponse<T>(
    await fetch(`/api/${path}`, {
      signal,
      cache: "no-store",
      credentials: "same-origin",
    }),
  );
}

function usePut(method: "PUT" | "PATCH" = "PUT") {
  const { csrfToken } = useIdentity();
  return async <T>(path: string, body: unknown) =>
    readResponse<T>(
      await fetch(`/api/${path}`, {
        method,
        credentials: "same-origin",
        headers: {
          "X-CSRF-Token": csrfToken ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
}

export function useNoticeSettings() {
  const { user } = useIdentity();
  return useQuery({
    queryKey: noticeKeys.settings(user?.id ?? ""),
    enabled: Boolean(user),
    queryFn: ({ signal }) =>
      get<NoticeSettingsView>("me/notifications", signal),
  });
}

export function useSetNoticeSwitch() {
  const { user } = useIdentity();
  const put = usePut();
  const queryClient = useQueryClient();
  const key = noticeKeys.settings(user?.id ?? "");
  return useMutation({
    mutationFn: (input: { category: NoticeCategory; enabled: boolean }) =>
      put<NoticeSettingsView>(
        `me/notifications/${encodeURIComponent(input.category)}`,
        { enabled: input.enabled },
      ),
    onMutate: ({ category, enabled }) => {
      const before = queryClient.getQueryData<NoticeSettingsView>(key);
      if (before)
        queryClient.setQueryData<NoticeSettingsView>(key, {
          ...before,
          switches: { ...before.switches, [category]: enabled },
        });
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
}

/** 开放时提醒我 on a timed 红包: null when this viewer cannot use it. */
export function useOpeningWatch(activityId: string, enabled: boolean) {
  const { user } = useIdentity();
  return useQuery({
    queryKey: noticeKeys.opening(activityId, user?.id ?? null),
    enabled: enabled && Boolean(user),
    queryFn: ({ signal }) =>
      get<OpeningWatchView>(
        `activities/${encodeURIComponent(activityId)}/opening-watch`,
        signal,
      ),
  });
}

export function useSetOpeningWatch(activityId: string) {
  const { user } = useIdentity();
  const put = usePut();
  const queryClient = useQueryClient();
  const key = noticeKeys.opening(activityId, user?.id ?? null);
  return useMutation({
    mutationFn: (watching: boolean) =>
      put<OpeningWatchView>(
        `activities/${encodeURIComponent(activityId)}/opening-watch`,
        { watching },
      ),
    onMutate: (watching) => {
      const before = queryClient.getQueryData<OpeningWatchView>(key);
      queryClient.setQueryData<OpeningWatchView>(key, {
        openingWatch: { watching },
      });
      return { before };
    },
    onError: (_error, _watching, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
}

/** 红包广场's 下一个红包开放时提醒我: null when this viewer cannot use it. */
export function useSquareWatch(enabled = true) {
  const { user, ready } = useIdentity();
  return useQuery({
    queryKey: noticeKeys.square(user?.id ?? null),
    // Guests see how many, too.
    enabled: enabled && ready,
    queryFn: ({ signal }) => get<SquareWatchView>("square/watch", signal),
  });
}

export function useSetSquareWatch() {
  const { user } = useIdentity();
  const put = usePut();
  const queryClient = useQueryClient();
  const key = noticeKeys.square(user?.id ?? null);
  return useMutation({
    mutationFn: (watching: boolean) =>
      put<SquareWatchView>("square/watch", { watching }),
    onMutate: (watching) => {
      const before = queryClient.getQueryData<SquareWatchView>(key);
      const was = before?.squareWatch?.watching ?? false;
      queryClient.setQueryData<SquareWatchView>(key, {
        squareWatch: { watching },
        waiting: Math.max(
          0,
          (before?.waiting ?? 0) + (watching === was ? 0 : watching ? 1 : -1),
        ),
      });
      return { before };
    },
    onError: (_error, _watching, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSuccess: (view) => queryClient.setQueryData(key, view),
  });
}

export function useNoticeAdmin(enabled: boolean) {
  return useQuery({
    queryKey: noticeKeys.admin,
    enabled,
    queryFn: ({ signal }) =>
      get<NoticeAdminStats>("admin/notifications", signal),
  });
}

/** 私信通知's pace (网站管理 → 设置): how far apart mails go. */
export function useNoticePace() {
  return useQuery({
    queryKey: noticeKeys.pace,
    queryFn: ({ signal }) =>
      get<{ pace: NoticePace }>("admin/notifications/pace", signal),
  });
}

export function useSaveNoticePace() {
  const patch = usePut("PATCH");
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateNoticePaceInput) =>
      patch<{ pace: NoticePace }>("admin/notifications/pace", input),
    onSuccess: (view) => queryClient.setQueryData(noticeKeys.pace, view),
    // Someone saved first: read what is saved now.
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: noticeKeys.pace }),
  });
}
