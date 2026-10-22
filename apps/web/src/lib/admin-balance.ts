import type {
  BalanceAdjustmentInput,
  BalanceInviteLink,
  BalanceTopup,
  CreateInviteLinkInput,
  PlatformApp,
  SavePlatformAppInput,
  UpdateBalanceSettingsInput,
} from "@hb/contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import type { api } from "../api";
import { readResponse } from "./activities";
import { adminKey, useAdminIdentity } from "./admin";
import { haptic } from "./haptics";

// 网站管理 · 🐟额 (docs/balance-design.md §7): its own reads, and the few
// writes an admin makes (查单, 确认到账, 调整, settings, the platform app).

type AdminBalance = (typeof api)["api"]["admin"]["balance"];
export type BalanceOverview = InferResponseType<
  AdminBalance["overview"]["$get"],
  200
>;
export type AdminTopupList = InferResponseType<
  AdminBalance["topups"]["$get"],
  200
>;
export type AdminTopupItem = AdminTopupList["items"][number];
export type AdminTopupDetail = InferResponseType<
  AdminBalance["topups"][":id"]["$get"],
  200
>;
export type AdminWithdrawalList = InferResponseType<
  AdminBalance["withdrawals"]["$get"],
  200
>;
export type AdminWithdrawalItem = AdminWithdrawalList["items"][number];
export type AdminWithdrawalDetail = InferResponseType<
  AdminBalance["withdrawals"][":id"]["$get"],
  200
>;
export type AdminAttentionList = InferResponseType<
  AdminBalance["attention"]["$get"],
  200
>;
export type AdminAttentionItem = AdminAttentionList["items"][number];
export type AdminInviteList = InferResponseType<
  AdminBalance["invites"]["$get"],
  200
>;
export type AdminInviteLinkList = InferResponseType<
  AdminBalance["invite-links"]["$get"],
  200
>;
export type AdminTransferList = InferResponseType<
  AdminBalance["transfers"]["$get"],
  200
>;
export type AdminMemberList = InferResponseType<
  AdminBalance["members"]["$get"],
  200
>;
export type AdminAdjustmentList = InferResponseType<
  AdminBalance["adjustments"]["$get"],
  200
>;
export type AdminUserBalance = InferResponseType<
  AdminBalance["users"][":id"]["$get"],
  200
>;
export type BalanceSettingsResponse = InferResponseType<
  AdminBalance["settings"]["$get"],
  200
>;

async function read<T>(path: string, signal: AbortSignal) {
  return readResponse<T>(
    await fetch(`/api/admin/balance/${path}`, { signal, cache: "no-store" }),
  );
}

async function write<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  csrfToken: string,
  body?: unknown,
) {
  // 震动反馈: a change asked for, felt as it answers.
  try {
    const saved = await readResponse<T>(
      await fetch(`/api/admin/balance/${path}`, {
        method,
        headers: {
          "X-CSRF-Token": csrfToken,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      }),
    );
    haptic("success");
    return saved;
  } catch (error) {
    haptic("error");
    throw error;
  }
}

const key = (identity: string, ...rest: unknown[]) =>
  adminKey(identity, "balance", ...rest);

export function useBalanceOverview() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: key(identity, "overview"),
    queryFn: ({ signal }) => read<BalanceOverview>("overview", signal),
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useAdminTopups(view: "attention" | "all") {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "topups", view),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminTopupList>(
        `topups?view=${view}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useAdminTopup(id: string | null) {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: key(identity, "topup", id),
    enabled: id !== null,
    queryFn: ({ signal }) =>
      read<AdminTopupDetail>(`topups/${id ?? ""}`, signal),
    retry: false,
  });
}

/** 待处理: the 转入 and 转出 that need a look, one list. */
export function useAdminAttention() {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "attention"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminAttentionList>(
        `attention${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useAdminWithdrawals() {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "withdrawals"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminWithdrawalList>(
        `withdrawals?view=all${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** One 转出: read again every 10 s while 发放中. */
export function useAdminWithdrawal(id: string) {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: key(identity, "withdrawal", id),
    queryFn: ({ signal }) =>
      read<AdminWithdrawalDetail>(`withdrawals/${id}`, signal),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.withdrawal.status === "sending" ? 10_000 : false,
  });
}

/** 受邀的人: everyone who may 转入, read when the modal shows them. */
export function useAdminMembers(enabled: boolean) {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "members"),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminMemberList>(
        `members${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/** 邀请记录: every invitation, read when its modal opens. */
export function useAdminInvites(enabled: boolean) {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "invites"),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminInviteList>(
        `invites${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/** 通用链接: every one made, read when that page of the modal shows. */
export function useAdminInviteLinks(enabled: boolean) {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "invite-links"),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminInviteLinkList>(
        `invite-links${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

export function useAdminAdjustments() {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "adjustments"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminAdjustmentList>(
        `adjustments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/** 转账 (balance-design §16), newest first. */
export function useAdminTransfers() {
  const identity = useAdminIdentity();
  return useInfiniteQuery({
    queryKey: key(identity, "transfers"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      read<AdminTransferList>(
        `transfers${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

export function useAdminUserBalance(userId: string) {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: key(identity, "user", userId),
    queryFn: ({ signal }) => read<AdminUserBalance>(`users/${userId}`, signal),
    retry: false,
  });
}

export function useBalanceSettings() {
  const identity = useAdminIdentity();
  return useQuery({
    queryKey: key(identity, "settings"),
    queryFn: ({ signal }) => read<BalanceSettingsResponse>("settings", signal),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** The writes: each reads again what it changed (and 操作记录). */
export function useBalanceAdmin(csrfToken: string) {
  const identity = useAdminIdentity();
  const queryClient = useQueryClient();
  const refresh = (...rest: unknown[]) =>
    queryClient.invalidateQueries({ queryKey: key(identity, ...rest) });
  return {
    check: async (id: string) => {
      const result = await write<{ topup: BalanceTopup }>(
        "POST",
        `topups/${id}/check`,
        csrfToken,
      );
      await Promise.all([
        refresh("topup", id),
        refresh("topups"),
        refresh("attention"),
        refresh("overview"),
      ]);
      return result;
    },
    confirm: async (id: string, reason: string) => {
      const result = await write<{ topup: BalanceTopup }>(
        "POST",
        `topups/${id}/confirm`,
        csrfToken,
        { reason },
      );
      await Promise.all([
        refresh("topup", id),
        refresh("topups"),
        refresh("attention"),
        refresh("overview"),
      ]);
      return result;
    },
    adjust: async (userId: string, input: BalanceAdjustmentInput) => {
      const result = await write<{ adjustment: unknown }>(
        "POST",
        `users/${userId}/adjustments`,
        csrfToken,
        input,
      );
      await Promise.all([
        refresh("user", userId),
        refresh("adjustments"),
        refresh("overview"),
      ]);
      return result;
    },
    createInviteLink: async (input: CreateInviteLinkInput) => {
      const result = await write<{ link: BalanceInviteLink; url: string }>(
        "POST",
        "invite-links",
        csrfToken,
        input,
      );
      await refresh("invite-links");
      return result;
    },
    stopInviteLink: async (id: string) => {
      const result = await write<{ link: BalanceInviteLink }>(
        "POST",
        `invite-links/${id}/stop`,
        csrfToken,
      );
      await refresh("invite-links");
      return result;
    },
    saveSettings: async (input: UpdateBalanceSettingsInput) => {
      const result = await write<{ settings: unknown }>(
        "PATCH",
        "settings",
        csrfToken,
        input,
      );
      await refresh("settings");
      return result;
    },
    savePlatformApp: async (input: SavePlatformAppInput) => {
      const result = await write<{ platformApp: PlatformApp }>(
        "PUT",
        "platform-app",
        csrfToken,
        input,
      );
      await Promise.all([refresh("settings"), refresh("overview")]);
      return result;
    },
    /** Someone's 开放接口密钥, stopped with a reason they will read. */
    revokeApiKey: async (userId: string, keyId: string, reason: string) => {
      const result = await write<{ key: unknown }>(
        "POST",
        `api-keys/${keyId}/revoke`,
        csrfToken,
        { reason },
      );
      await refresh("user", userId);
      return result;
    },
    checkPlatformApp: async () => {
      const result = await write<{ platformApp: PlatformApp }>(
        "POST",
        "platform-app/check",
        csrfToken,
      );
      await refresh("settings");
      return result;
    },
  };
}
