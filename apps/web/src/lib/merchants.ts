import type {
  ActivityPaymentList,
  ActivityPaymentTargetList,
  CreateMerchantInput,
  Merchant,
  MerchantChangeImpact,
  MerchantChangePreview,
  MerchantList,
  MerchantPaymentDetail,
  MerchantPaymentList,
  RepairPaymentCredentialInput,
  SimulationScenario,
  UpdateMerchantInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ActivityRequestError, activityKeys, readResponse } from "./activities";
import { sessionQueryKey, useAccountSession } from "./auth";
import { duplicateProbeActive } from "./payment-display";

export class MerchantChangeConfirmationError extends ActivityRequestError {
  constructor(
    message: string,
    public readonly change: MerchantChangePreview,
  ) {
    super(message, 409, [], undefined, "MERCHANT_CHANGE_REQUIRES_CONFIRMATION");
  }
}

function isChangeImpactResponse(
  value: unknown,
): value is MerchantChangePreview {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MerchantChangePreview>;
  const keys: Array<keyof MerchantChangeImpact> = [
    "activeActivities",
    "unfinishedDraws",
    "pendingPayments",
    "sendingPayments",
    "reconcilingPayments",
  ];
  return (
    typeof candidate.confirmationToken === "string" &&
    candidate.confirmationToken.length > 0 &&
    typeof candidate.impact === "object" &&
    candidate.impact !== null &&
    keys.every((key) => {
      const count = candidate.impact?.[key];
      return Number.isSafeInteger(count) && (count ?? -1) >= 0;
    })
  );
}

async function readMerchantUpdateResponse(response: Response) {
  if (response.status === 409) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = body.error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "MERCHANT_CHANGE_REQUIRES_CONFIRMATION" &&
        isChangeImpactResponse(error)
      ) {
        throw new MerchantChangeConfirmationError(
          "付款影响范围已变化，请重新确认后保存。",
          error,
        );
      }
    }
  }
  return readResponse<{ merchant: Merchant }>(response);
}

export const merchantKeys = {
  mine: (userId: string) => ["merchant-private", userId] as const,
  detail: (userId: string, id: string) =>
    ["merchant-private", userId, "detail", id] as const,
};

export function useMerchants(userId: string, cursor: string | null = null) {
  return useQuery({
    queryKey: [...merchantKeys.mine(userId), "list", cursor],
    enabled: Boolean(userId),
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
    enabled: Boolean(userId && id),
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

export function usePaymentActivities(
  userId: string,
  status: "all" | "active" | "ended" | "archived",
  cursor: string | null,
) {
  const query = new URLSearchParams({ status });
  if (cursor) query.set("cursor", cursor);
  return useQuery({
    queryKey: [
      ...merchantKeys.mine(userId),
      "payment-activities",
      status,
      cursor,
    ],
    queryFn: async ({ signal }) =>
      readResponse<ActivityPaymentList>(
        await fetch(`/api/me/payment-activities?${query.toString()}`, {
          signal,
          cache: "no-store",
        }),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useActivityPayments(
  userId: string,
  activityId: string | null,
  status: "all" | "pending" | "confirmed",
  cursor: string | null,
) {
  const query = new URLSearchParams({ status });
  if (cursor) query.set("cursor", cursor);
  return useQuery({
    queryKey: [
      ...merchantKeys.mine(userId),
      "activity-payments",
      activityId,
      status,
      cursor,
    ],
    enabled: Boolean(activityId),
    queryFn: async ({ signal }) => {
      if (!activityId) throw new Error("缺少活动标识");
      return readResponse<ActivityPaymentTargetList>(
        await fetch(
          `/api/me/activities/${encodeURIComponent(activityId)}/payments?${query.toString()}`,
          { signal, cache: "no-store" },
        ),
      );
    },
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
  const account = useAccountSession(userId);
  const onSuccess = async (
    { merchant }: { merchant: Merchant },
    _variables: unknown,
    identity: string | null | undefined,
  ) => {
    if (!account.isCurrentIdentity(identity)) return;
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
  const onError = (
    error: Error,
    _variables: unknown,
    identity: string | null | undefined,
  ) => {
    if (
      account.isCurrentIdentity(identity) &&
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
    isCurrentSession: account.isCurrentSession,
    create: useMutation({
      onMutate: account.captureIdentity,
      gcTime: 0,
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
      onMutate: account.captureIdentity,
      gcTime: 0,
      mutationFn: async (json: UpdateMerchantInput) =>
        readMerchantUpdateResponse(
          await api.api.me.merchants[":id"].$patch(
            { param: { id: merchantId() }, json },
            options,
          ),
        ),
      onSuccess,
      onError,
    }),
    changeImpact: useMutation({
      onMutate: account.captureIdentity,
      mutationFn: async () => {
        const result = await readResponse<MerchantChangePreview>(
          await api.api.me.merchants[":id"]["change-impact"].$get(
            { param: { id: merchantId() } },
            { init: { cache: "no-store" } },
          ),
        );
        if (!isChangeImpactResponse(result))
          throw new Error("无法读取配置修改影响，请稍后重试。");
        return result;
      },
      onError,
    }),
    repairPaymentCredentials: useMutation({
      onMutate: account.captureIdentity,
      gcTime: 0,
      mutationFn: async ({
        taskId,
        input,
      }: {
        taskId: string;
        input: RepairPaymentCredentialInput;
      }) =>
        readResponse<{
          merchant: Merchant;
          payment: MerchantPaymentDetail;
        }>(
          await api.api.me.merchants[":id"].payments[
            ":taskId"
          ].credentials.$post(
            { param: { id: merchantId(), taskId }, json: input },
            { ...options, init: { cache: "no-store" } },
          ),
        ),
      onSuccess,
      onError,
    }),
    check: useMutation({
      onMutate: account.captureIdentity,
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
      onMutate: account.captureIdentity,
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
      onMutate: account.captureIdentity,
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
  enabled = true,
) {
  return useQuery({
    enabled,
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
