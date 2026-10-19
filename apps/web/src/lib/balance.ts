import type { BalanceTopup, CreateTopupInput } from "@hb/contracts";
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
import { useMerchantIdentity } from "./merchants";
import { useIdentity } from "./session";

// 站内🐟额 (/balance) and one 转入 (/balance/<编号>), docs/balance-design.md.
// Keyed by the sign-in, like 付款记录: another account never sees these.

export type BalancePage = InferResponseType<
  typeof api.api.me.balance.$get,
  200
>;
export type BalanceRecord = BalancePage["items"][number];
export type BalanceFilter = "all" | "topup" | "adjustment";

export const balanceKeys = {
  all: (identity: string) => ["merchant-private", identity, "balance"] as const,
  list: (identity: string, filter: BalanceFilter) =>
    [...balanceKeys.all(identity), "list", filter] as const,
  topup: (identity: string, id: string) =>
    [...balanceKeys.all(identity), "topup", id] as const,
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
 * The 🐟额 page, opened: its 转入 not yet arrived are checked once (a write,
 * so not part of the read), and the page reads again if one did.
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
        const { credited } = await readResponse<{ credited: number }>(
          await api.api.me.balance.topups["check-open"].$post(
            undefined,
            options,
          ),
        );
        if (credited > 0 && session.isCurrentIdentity(identity))
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

/** 去 Credit 确认: a new 转入, or the same order again. */
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
