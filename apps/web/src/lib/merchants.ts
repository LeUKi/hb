import type {
  CreateMerchantInput,
  Merchant,
  MerchantChangeImpact,
  MerchantChangePreview,
  MerchantList,
  MerchantPaymentDetail,
  MerchantUsage,
  RepairPaymentCredentialInput,
  UpdateMerchantInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ActivityRequestError, activityKeys, readResponse } from "./activities";
import { type SessionResponse, sessionQueryKey, useSession } from "./auth";

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

export function merchantSessionIdentity(session: SessionResponse | undefined) {
  return session?.user && session.csrfToken
    ? JSON.stringify([session.user.id, session.csrfToken])
    : null;
}

/**
 * Who the "merchant-private" queries belong to: the account and this
 * sign-in. The query cache drops every one keyed otherwise whenever the
 * session is read, so keys must use this, not the bare user id.
 */
export function useMerchantIdentity(userId: string) {
  const session = useSession();
  const queryClient = useQueryClient();
  const captureIdentity = () =>
    merchantSessionIdentity(
      queryClient.getQueryData<SessionResponse>(sessionQueryKey),
    );
  const identity =
    session.isSuccess && session.data.user?.id === userId
      ? merchantSessionIdentity(session.data)
      : null;
  const isCurrentIdentity = (candidate: string | null | undefined) =>
    Boolean(candidate) &&
    queryClient.getQueryState(sessionQueryKey)?.status === "success" &&
    queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user?.id ===
      userId &&
    captureIdentity() === candidate;
  return {
    identity: identity ?? "",
    enabled: Boolean(identity),
    captureIdentity,
    isCurrentIdentity,
    isCurrentSession: () => isCurrentIdentity(identity),
    async read<T>(response: Response) {
      const result = await readResponse<T>(response);
      if (!isCurrentIdentity(identity))
        throw new DOMException("身份已变化", "AbortError");
      return result;
    },
  };
}

export function useMerchants(userId: string, cursor: string | null = null) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: [...merchantKeys.mine(session.identity), "list", cursor],
    enabled: session.enabled,
    queryFn: async ({ signal }) =>
      session.read<MerchantList>(
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

/** The account's current merchant (it pays what opens now), once known. */
export function useCurrentMerchant(userId: string) {
  const query = useMerchants(userId);
  const data = query.data;
  return {
    merchant:
      data?.items.find((item) => item.id === data.currentMerchantId) ?? null,
    loaded: data !== undefined,
  };
}

export function useMerchant(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: merchantKeys.detail(session.identity, id),
    enabled: session.enabled && Boolean(id),
    queryFn: async ({ signal }) =>
      session.read<{ merchant: Merchant }>(
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

/** What a merchant pays for: its 红包 and their payments. */
export function useMerchantUsage(userId: string, id: string) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: [...merchantKeys.mine(session.identity), "usage", id],
    enabled: session.enabled && Boolean(id),
    queryFn: async ({ signal }) =>
      session.read<MerchantUsage>(
        await fetch(`/api/me/merchants/${encodeURIComponent(id)}/usage`, {
          signal,
          cache: "no-store",
        }),
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
  const account = useMerchantIdentity(userId);
  const onSuccess = async (
    { merchant }: { merchant: Merchant },
    _variables: unknown,
    identity: string | null | undefined,
  ) => {
    if (!account.isCurrentIdentity(identity)) return;
    queryClient.setQueryData(merchantKeys.detail(identity ?? "", merchant.id), {
      merchant,
    });
    await queryClient.invalidateQueries({
      queryKey: merchantKeys.mine(identity ?? ""),
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
      !account.isCurrentIdentity(identity) ||
      !(error instanceof ActivityRequestError)
    )
      return;
    if (error.status === 401)
      queryClient.setQueryData(sessionQueryKey, {
        user: null,
        csrfToken: null,
      });
    if (id && [401, 403, 404].includes(error.status)) {
      const related = queryClient.getQueryCache().findAll({
        queryKey: merchantKeys.mine(identity ?? ""),
        predicate: (query) => query.queryKey[3] === id,
      });
      for (const query of related) {
        void query.cancel({ revert: false, silent: true });
        query.setState({
          data: undefined,
          dataUpdatedAt: 0,
          status: "error",
          fetchStatus: "idle",
          error,
        });
      }
    }
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
      // 震动反馈: a look before saving, not a result.
      meta: { haptics: false },
      onMutate: account.captureIdentity,
      mutationFn: async () => {
        const result = await readResponse<MerchantChangePreview>(
          await api.api.me.merchants[":id"]["change-impact"].$get(
            { param: { id: merchantId() } },
            { init: { cache: "no-store" } },
          ),
        );
        if (!isChangeImpactResponse(result))
          throw new Error("无法读取配置修改影响，请稍后再试。");
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
  };
}
