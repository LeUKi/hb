import type {
  BalanceApiKey,
  BalanceApiKeyTotals,
  BalanceCheckout,
  BalanceInvite,
  BalanceInviteUser,
  BalanceTopup,
  BalanceTransfer,
  BalanceWithdrawal,
  CheckoutBlock,
  CreateApiKeyInput,
  CreateCheckoutInput,
  CreateTopupInput,
  CreateTransferInput,
  CreateWithdrawalInput,
  OwnerAdjustmentInput,
} from "@hb/contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { readResponse } from "./activities";
import { sessionQueryKey } from "./auth";
import { useMerchantIdentity } from "./merchants";
import { useIdentity } from "./session";

// 🐟额 (/balance) and one 转入 (/balance/<编号>), docs/balance-design.md.
// Keyed by the sign-in, like 付款记录: another account never sees these.

export type BalancePage = InferResponseType<
  typeof api.api.me.balance.$get,
  200
>;
export type BalanceRecord = BalancePage["items"][number];
export type BalanceFilter =
  | "all"
  | "topup"
  | "withdrawal"
  | "adjustment"
  | "hongbao"
  | "transfer";

export const balanceKeys = {
  all: (identity: string) => ["merchant-private", identity, "balance"] as const,
  list: (identity: string, filter: BalanceFilter) =>
    [...balanceKeys.all(identity), "list", filter] as const,
  topup: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "topup", id] as const,
  withdrawal: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "withdrawal", id] as const,
  invites: (identity: string) =>
    [...balanceKeys.all(identity), "invites"] as const,
  invitee: (identity: string, username: string) =>
    [...balanceKeys.all(identity), "invitee", username] as const,
  hongbao: (identity: string) =>
    [...balanceKeys.all(identity), "hongbao"] as const,
  recipient: (identity: string, username: string) =>
    [...balanceKeys.all(identity), "recipient", username] as const,
  transfer: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "transfer", id] as const,
  checkout: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "checkout", id] as const,
  received: (identity: string) =>
    [...balanceKeys.all(identity), "received"] as const,
  apiKeys: (identity: string) =>
    [...balanceKeys.all(identity), "api-keys"] as const,
  apiKey: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "api-keys", id] as const,
};

export function useBalancePages(userId: string, filter: BalanceFilter) {
  const session = useMerchantIdentity(userId);
  return useInfiniteQuery({
    queryKey: balanceKeys.list(session.identity, filter),
    enabled: session.enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      session.read<BalancePage>(
        await api.api.me.balance.$get(
          { query: { filter, ...(pageParam ? { cursor: pageParam } : {}) } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
    // Another filter's records stay, dimmed, until this one's are in.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === session.identity ? previous : undefined,
  });
}

function useCsrf() {
  const { csrfToken } = useIdentity();
  return { headers: { "X-CSRF-Token": csrfToken ?? "" } };
}

/**
 * The 🐟额 page, opened: its 转入 not yet arrived, and its 转账 to 对方的收银台
 * not yet paid, are checked once (a write, so not part of the read); the
 * page reads again if one moved.
 */
export function useCheckOpenTopups(userId: string, enabled: boolean) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || !session.enabled || done.current) return;
    done.current = true;
    const identity = session.identity;
    void (async () => {
      try {
        const { credited, paid } = await readResponse<{
          credited: number;
          paid: number;
        }>(
          await api.api.me.balance.topups["check-open"].$post(
            undefined,
            options,
          ),
        );
        if (credited + paid > 0 && session.isCurrentIdentity(identity))
          await queryClient.invalidateQueries({
            queryKey: balanceKeys.all(identity),
          });
      } catch {
        // The list says what it knows; the next visit checks again.
      }
    })();
  }, [enabled, session, queryClient, options]);
}

/**
 * One 转入. Reading it is a check at Credit (the server limits how often):
 * once as the page opens, then every 3 s while it waits to be confirmed.
 */
export function useTopup(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  const options = useCsrf();
  return useQuery({
    queryKey: balanceKeys.topup(session.identity, id),
    enabled: session.enabled,
    queryFn: async () =>
      session.read<{ topup: BalanceTopup }>(
        await api.api.me.balance.topups[":id"].check.$post(
          { param: { id } },
          options,
        ),
      ),
    retry: false,
    refetchInterval: (query) => {
      const topup = query.state.data?.topup;
      return topup?.status === "pending" && Date.now() < topup.payableUntil
        ? 3000
        : false;
    },
  });
}

/** 去 Credit 站确认: a new 转入, or the same order again. */
export function useTopupActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const settle = async (identity: string, topup: BalanceTopup) => {
    if (!session.isCurrentIdentity(identity)) return;
    queryClient.setQueryData(balanceKeys.topup(identity, topup.id), {
      topup,
    });
    await queryClient.invalidateQueries({
      queryKey: [...balanceKeys.all(identity), "list"],
    });
  };
  const create = useMutation({
    mutationFn: async (input: CreateTopupInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{
        topup: BalanceTopup;
        cashierUrl: string | null;
      }>(await api.api.me.balance.topups.$post({ json: input }, options));
      await settle(identity, result.topup);
      return result;
    },
  });
  const pay = useMutation({
    mutationFn: async (id: string) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{
        topup: BalanceTopup;
        cashierUrl: string | null;
      }>(
        await api.api.me.balance.topups[":id"].pay.$post(
          { param: { id } },
          options,
        ),
      );
      await settle(identity, result.topup);
      return result;
    },
  });
  return { create, pay };
}

/** Where Credit's cashier opens: this tab, and Credit brings it back. */
export function goToCashier(url: string) {
  window.location.assign(url);
}

/**
 * One 转出, read again every 3 s while 发放中: the payment queue moves it,
 * and the page follows.
 */
export function useWithdrawal(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: balanceKeys.withdrawal(session.identity, id),
    enabled: session.enabled,
    queryFn: async ({ signal }) =>
      session.read<{ withdrawal: BalanceWithdrawal }>(
        await api.api.me.balance.withdrawals[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.withdrawal.status === "sending" ? 3000 : false,
  });
}

/** 转出: asked for once; the queue does the rest. */
export function useWithdrawalActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const create = useMutation({
    mutationFn: async (input: CreateWithdrawalInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ withdrawal: BalanceWithdrawal }>(
        await api.api.me.balance.withdrawals.$post({ json: input }, options),
      );
      if (session.isCurrentIdentity(identity)) {
        queryClient.setQueryData(
          balanceKeys.withdrawal(identity, result.withdrawal.id),
          result,
        );
        await queryClient.invalidateQueries({
          queryKey: [...balanceKeys.all(identity), "list"],
        });
      }
      return result;
    },
  });
  return { create };
}

/**
 * The 站长's own 补加 and 扣回 (docs/balance-design.md §15); the page, its
 * 明细 and the form's “从哪发” read again after.
 */
export function useOwnerAdjustment(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  return useMutation({
    mutationFn: async (input: OwnerAdjustmentInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ adjustment: unknown }>(
        await api.api.me.balance["owner-adjustments"].$post(
          { json: input },
          options,
        ),
      );
      if (session.isCurrentIdentity(identity))
        await queryClient.invalidateQueries({
          queryKey: balanceKeys.all(identity),
        });
      return result;
    },
  });
}

/** The invite dialog's last few invitations, and what became of them. */
export type BalanceFunding = {
  /** 🐟额红包 are on at all. */
  enabled: boolean;
  /** On, and something to send. */
  available: boolean;
  availableMinor: number;
  /**
   * 代码判定红包 may be sent (🐟额 PLUS, its switch on): new versions left
   * to deploy today, of 每人每天部署几次.
   */
  code?: { deploysLeft: number; deployLimit: number };
  /** 附带网页 may be set: anyone, its switch on (docs/attached-page-design.md). */
  page?: true;
  /** The same switch (kept for forms from before it was everyone's). */
  pageEnabled?: true;
};

/**
 * 🐟额红包 (docs/balance-design.md §14): may this person send one now (the
 * form's “从哪发”), and what is 可用.
 */
export function useBalanceFunding(userId: string, enabled = true) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: balanceKeys.hongbao(session.identity),
    enabled: session.enabled && enabled,
    queryFn: async ({ signal }) =>
      session.read<BalanceFunding>(
        await api.api.me.balance.hongbao.$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      ),
    retry: false,
    staleTime: 0,
  });
}

export function useMyInvites(userId: string, enabled: boolean) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: balanceKeys.invites(session.identity),
    enabled: session.enabled && enabled,
    queryFn: async ({ signal }) =>
      session.read<{ items: BalanceInvite[] }>(
        await api.api.me.balance.invites.$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      ),
    retry: false,
  });
}

export type InviteePreview = {
  user: BalanceInviteUser | null;
  self: boolean;
  member: boolean;
};

/** Who a typed username is here (if they have been), while it is typed. */
export function useInviteePreview(userId: string, username: string) {
  const session = useMerchantIdentity(userId);
  const name = username.trim().replace(/^@/, "").toLowerCase();
  return useQuery({
    queryKey: balanceKeys.invitee(session.identity, name),
    enabled: session.enabled && /^[a-z0-9_.-]{1,60}$/.test(name),
    queryFn: async ({ signal }) =>
      session.read<InviteePreview>(
        await api.api.me.balance.invites.preview.$get(
          { query: { username: name } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

/** 生成链接: one invitation, then the dialog's list reads again. */
export function useInviteActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const create = useMutation({
    mutationFn: async (username: string) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ invite: BalanceInvite; url: string }>(
        await api.api.me.balance.invites.$post({ json: { username } }, options),
      );
      if (session.isCurrentIdentity(identity))
        await queryClient.invalidateQueries({
          queryKey: balanceKeys.invites(identity),
        });
      return result;
    },
  });
  return { create };
}

export type InvitePage = InferResponseType<
  (typeof api.api.invites)[":token"]["$get"],
  200
>;

/** The accept page: open to anyone with the link, read for whoever it is. */
export function useInvite(token: string) {
  const { user, ready } = useIdentity();
  return useQuery({
    queryKey: ["invite", token, user?.id ?? "guest"] as const,
    enabled: ready,
    queryFn: async ({ signal }) =>
      readResponse<InvitePage>(
        await api.api.invites[":token"].$get(
          { param: { token } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
  });
}

/** 接受邀请, then the session reads again: 🐟额 shows from now on. */
export function useAcceptInvite(token: string) {
  const queryClient = useQueryClient();
  const options = useCsrf();
  return useMutation({
    mutationFn: async () => {
      const result = await readResponse<{ accepted: boolean }>(
        await api.api.invites[":token"].accept.$post(
          { param: { token } },
          options,
        ),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["invite", token] }),
      ]);
      return result;
    },
  });
}

/** Who a typed username is here, for the 转账 dialog (balance-design §16). */
export type TransferRecipient = {
  user: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  self: boolean;
  /** The 站长: their Credit account cannot take the platform app's. */
  owner: boolean;
  /** Why 对方的收银台 cannot be chosen; null when it can. */
  checkoutBlock: CheckoutBlock | null;
};

export function useRecipient(userId: string, username: string) {
  const session = useMerchantIdentity(userId);
  const name = username.trim().replace(/^@/, "").toLowerCase();
  return useQuery({
    queryKey: balanceKeys.recipient(session.identity, name),
    enabled: session.enabled && /^[a-z0-9_.-]{1,60}$/.test(name),
    queryFn: async ({ signal }) =>
      session.read<TransferRecipient>(
        await api.api.me.balance.recipients.$get(
          { query: { username: name } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

/** 转账: once; the page's figures and 明细 read again after. */
export function useTransferActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const create = useMutation({
    mutationFn: async (input: CreateTransferInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ transfer: BalanceTransfer }>(
        await api.api.me.balance.transfers.$post({ json: input }, options),
      );
      if (session.isCurrentIdentity(identity)) {
        queryClient.setQueryData(
          balanceKeys.transfer(identity, result.transfer.id),
          result,
        );
        await queryClient.invalidateQueries({
          queryKey: [...balanceKeys.all(identity), "list"],
        });
      }
      return result;
    },
  });
  return { create };
}

/** One 转账, read again every 3 s while one to a Credit account is 发放中. */
export function useTransfer(userId: string, id: string | null) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: balanceKeys.transfer(session.identity, id ?? ""),
    enabled: session.enabled && id !== null,
    queryFn: async ({ signal }) =>
      session.read<{ transfer: BalanceTransfer }>(
        await api.api.me.balance.transfers[":id"].$get(
          { param: { id: id ?? "" } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.transfer.status === "sending" ? 3000 : false,
  });
}

/**
 * One 转账 to 对方的收银台 (/balance/pay/<编号>). Reading it is a check at
 * Credit 站, as a 转入's is: once as the page opens, then every 3 s while
 * it waits to be confirmed.
 */
export function useCheckout(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  const options = useCsrf();
  return useQuery({
    queryKey: balanceKeys.checkout(session.identity, id),
    enabled: session.enabled,
    queryFn: async () =>
      session.read<{ checkout: BalanceCheckout }>(
        await api.api.me.balance.checkouts[":id"].check.$post(
          { param: { id } },
          options,
        ),
      ),
    retry: false,
    refetchInterval: (query) => {
      const checkout = query.state.data?.checkout;
      return checkout?.status === "pending" &&
        Date.now() < checkout.payableUntil
        ? 3000
        : false;
    },
  });
}

/** 去 Credit 站确认: a new 转账 to 对方的收银台, or the same order again. */
export function useCheckoutActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const settle = async (identity: string, checkout: BalanceCheckout) => {
    if (!session.isCurrentIdentity(identity)) return;
    queryClient.setQueryData(balanceKeys.checkout(identity, checkout.id), {
      checkout,
    });
    await queryClient.invalidateQueries({
      queryKey: [...balanceKeys.all(identity), "list"],
    });
  };
  type Made = { checkout: BalanceCheckout; cashierUrl: string | null };
  const create = useMutation({
    mutationFn: async (input: CreateCheckoutInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<Made>(
        await api.api.me.balance.checkouts.$post({ json: input }, options),
      );
      await settle(identity, result.checkout);
      return result;
    },
  });
  const pay = useMutation({
    mutationFn: async (id: string) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<Made>(
        await api.api.me.balance.checkouts[":id"].pay.$post(
          { param: { id } },
          options,
        ),
      );
      await settle(identity, result.checkout);
      return result;
    },
  });
  return { create, pay };
}

/**
 * 收到的付款 on the LDC 商户 page: paid ones only. As the page opens, the
 * recent ones not yet paid are checked once, and the list reads again if
 * one was.
 */
export function useReceivedCheckouts(userId: string, enabled: boolean) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const checked = useRef(false);
  useEffect(() => {
    if (!enabled || !session.enabled || checked.current) return;
    checked.current = true;
    const identity = session.identity;
    void (async () => {
      try {
        const { paid } = await readResponse<{ paid: number }>(
          await api.api.me.balance.checkouts.received["check-open"].$post(
            undefined,
            options,
          ),
        );
        if (paid > 0 && session.isCurrentIdentity(identity))
          await queryClient.invalidateQueries({
            queryKey: balanceKeys.received(identity),
          });
      } catch {
        // The list says what it knows; the next visit checks again.
      }
    })();
  }, [enabled, session, queryClient, options]);
  return useInfiniteQuery({
    queryKey: balanceKeys.received(session.identity),
    enabled: enabled && session.enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      session.read<{ items: BalanceCheckout[]; nextCursor: string | null }>(
        await api.api.me.balance.checkouts.received.$get(
          { query: pageParam ? { cursor: pageParam } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/** 开放接口密钥 (balance-design §16): the owner's list. */
export function useApiKeys(userId: string, enabled: boolean) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: balanceKeys.apiKeys(session.identity),
    enabled: session.enabled && enabled,
    queryFn: async ({ signal }) =>
      session.read<{ items: BalanceApiKey[]; max: number }>(
        await api.api.me.balance["api-keys"].$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      ),
    retry: false,
  });
}

export type ApiKeyPage = {
  key: BalanceApiKey;
  totals: BalanceApiKeyTotals;
  transfers: BalanceTransfer[];
  nextCursor: string | null;
};

/** One key: what it sent, 20 at a time. */
export function useApiKey(userId: string, id: string | null) {
  const session = useMerchantIdentity(userId);
  return useInfiniteQuery({
    queryKey: balanceKeys.apiKey(session.identity, id ?? ""),
    enabled: session.enabled && id !== null,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      session.read<ApiKeyPage>(
        await api.api.me.balance["api-keys"][":id"].$get(
          {
            param: { id: id ?? "" },
            query: pageParam ? { cursor: pageParam } : {},
          },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/** 新建 (shown once) and 停用; the list reads again after either. */
export function useApiKeyActions(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const options = useCsrf();
  const refresh = async (identity: string) => {
    if (session.isCurrentIdentity(identity))
      await queryClient.invalidateQueries({
        queryKey: balanceKeys.apiKeys(identity),
      });
  };
  const create = useMutation({
    mutationFn: async (input: CreateApiKeyInput) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ key: BalanceApiKey; token: string }>(
        await api.api.me.balance["api-keys"].$post({ json: input }, options),
      );
      await refresh(identity);
      return result;
    },
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const identity = session.captureIdentity() ?? "";
      const result = await readResponse<{ key: BalanceApiKey }>(
        await api.api.me.balance["api-keys"][":id"].revoke.$post(
          { param: { id } },
          options,
        ),
      );
      await refresh(identity);
      return result;
    },
  });
  return { create, revoke };
}
