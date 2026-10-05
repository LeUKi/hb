import type {
  CreateMerchantInput,
  Merchant,
  MerchantList,
  MerchantPaymentDetail,
  MerchantPaymentList,
  SimulationScenario,
  UpdateMerchantInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ActivityRequestError, activityKeys, readResponse } from "./activities";
import { sessionQueryKey } from "./auth";
import { duplicateProbeActive } from "./payment-display";

export const merchantKeys = {
  mine: (userId: string) => ["merchant-private", userId] as const,
  detail: (userId: string, id: string) =>
    ["merchant-private", userId, "detail", id] as const,
};

export function useMerchants(userId: string, cursor: string | null = null) {
  return useQuery({
    queryKey: [...merchantKeys.mine(userId), "list", cursor],
    queryFn: async ({ signal }) =>
      readResponse<MerchantList>(
        await api.api.me.merchants.$get(
          { query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (merchant) => merchant.credentialVerification.status === "checking",
      )
        ? 2_000
        : 15_000,
  });
}

export function useMerchant(userId: string, id: string) {
  return useQuery({
    queryKey: merchantKeys.detail(userId, id),
    enabled: Boolean(id),
    queryFn: async ({ signal }) =>
      readResponse<{ merchant: Merchant }>(
        await api.api.me.merchants[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.merchant.credentialVerification.status === "checking"
        ? 2_000
        : 15_000,
  });
}

export function useMerchantPayments(
  userId: string,
  id: string,
  cursor: string | null,
) {
  return useQuery({
    queryKey: [...merchantKeys.mine(userId), "payments", id, cursor],
    queryFn: async ({ signal }) =>
      readResponse<MerchantPaymentList>(
        await api.api.me.merchants[":id"].payments.$get(
          { param: { id }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useMerchantWrites(
  userId: string,
  csrfToken: string,
  id?: string,
) {
  const queryClient = useQueryClient();
  const options = { headers: { "X-CSRF-Token": csrfToken } };
  function sameSession() {
    return (
      queryClient.getQueryState(sessionQueryKey)?.status === "success" &&
      queryClient.getQueryData<{ user: { id: string } | null }>(sessionQueryKey)
        ?.user?.id === userId
    );
  }
  const onSuccess = async ({ merchant }: { merchant: Merchant }) => {
    if (!sameSession()) return;
    queryClient.setQueryData(merchantKeys.detail(userId, merchant.id), {
      merchant,
    });
    await queryClient.invalidateQueries({
      queryKey: merchantKeys.mine(userId),
    });
    await queryClient.invalidateQueries({
      queryKey: activityKeys.mine(userId),
    });
  };
  const onError = (error: Error) => {
    if (
      sameSession() &&
      error instanceof ActivityRequestError &&
      error.status === 401
    )
      queryClient.setQueryData(sessionQueryKey, {
        user: null,
        csrfToken: null,
      });
  };
  function merchantId() {
    if (!id) throw new Error("缺少商户标识");
    return id;
  }
  return {
    create: useMutation({
      mutationFn: async (json: CreateMerchantInput) =>
        readResponse<{ merchant: Merchant }>(
          await api.api.me.merchants.$post(
            { json: { ...json, mode: json.mode ?? "simulation" } },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
    update: useMutation({
      mutationFn: async (json: UpdateMerchantInput) =>
        readResponse<{ merchant: Merchant }>(
          await api.api.me.merchants[":id"].$patch(
            { param: { id: merchantId() }, json },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
    check: useMutation({
      mutationFn: async () =>
        readResponse<{
          merchant: Merchant;
          accepted?: boolean;
          retryAfterSeconds?: number | null;
        }>(
          await api.api.me.merchants[":id"].check.$post(
            { param: { id: merchantId() } },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
    verify: useMutation({
      mutationFn: async () =>
        readResponse<{ merchant: Merchant }>(
          await api.api.me.merchants[":id"].verify.$post(
            { param: { id: merchantId() } },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
    simulate: useMutation({
      mutationFn: async (scenario: SimulationScenario) =>
        readResponse<{ merchant: Merchant }>(
          await api.api.me.merchants[":id"].simulation.$post(
            { param: { id: merchantId() }, json: { scenario } },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
  };
}

export function useMerchantPayment(
  userId: string,
  id: string,
  taskId: string,
  cursor: string | null,
) {
  return useQuery({
    queryKey: [...merchantKeys.mine(userId), "payment", id, taskId, cursor],
    queryFn: async ({ signal }) =>
      readResponse<{ payment: MerchantPaymentDetail }>(
        await api.api.me.merchants[":id"].payments[":taskId"].$get(
          { param: { id, taskId }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) => {
      const payment = query.state.data?.payment;
      return payment?.status === "confirmed" &&
        !duplicateProbeActive(payment.duplicateProbe)
        ? false
        : 15_000;
    },
  });
}
