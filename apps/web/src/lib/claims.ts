import type {
  AuthorClaimList,
  ClaimActivityInput,
  ClaimDetail,
  ClaimList,
  ClaimResult,
  PublicRecipientList,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "./activities";
import { sessionQueryKey } from "./auth";

export const claimKeys = {
  mine: (userId: string) => ["claim-private", userId] as const,
  current: (userId: string, activityId: string) =>
    ["claim-private", userId, "activity", activityId] as const,
  detail: (userId: string, id: string) =>
    ["claim-private", userId, "detail", id] as const,
};

function claimRefresh(claim?: ClaimDetail | null) {
  return claim?.rewardType === "ldc" && claim.payment.status === "confirmed"
    ? false
    : 15_000;
}

export function useCurrentClaim(userId: string, activityId: string) {
  return useQuery({
    queryKey: claimKeys.current(userId, activityId),
    queryFn: async ({ signal }) =>
      readResponse<{ claim: ClaimDetail | null }>(
        await api.api.activities[":id"].claim.$get(
          { param: { id: activityId } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) => claimRefresh(query.state.data?.claim),
  });
}

export function useMyClaims(userId: string, cursor: string | null) {
  return useQuery({
    queryKey: [...claimKeys.mine(userId), "list", cursor],
    queryFn: async ({ signal }) =>
      readResponse<ClaimList>(
        await api.api.me.claims.$get(
          { query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
  });
}

export function useClaim(userId: string, id: string) {
  return useQuery({
    queryKey: claimKeys.detail(userId, id),
    queryFn: async ({ signal }) =>
      readResponse<{ claim: ClaimDetail }>(
        await api.api.me.claims[":id"].$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: (query) => claimRefresh(query.state.data?.claim),
  });
}

export function useAuthorClaims(
  userId: string,
  id: string,
  cursor: string | null,
) {
  return useQuery({
    queryKey: [...claimKeys.mine(userId), "author", id, cursor],
    queryFn: async ({ signal }) =>
      readResponse<AuthorClaimList>(
        await api.api.me.activities[":id"].claims.$get(
          { param: { id }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function usePublicRecipients(
  id: string,
  cursor: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["activity-recipients", id, cursor],
    queryFn: async ({ signal }) =>
      readResponse<PublicRecipientList>(
        await api.api.activities[":id"].recipients.$get(
          { param: { id }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    enabled,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useClaimReward(userId: string, csrfToken: string, id: string) {
  const queryClient = useQueryClient();
  function sameSession() {
    return (
      queryClient.getQueryState(sessionQueryKey)?.status === "success" &&
      queryClient.getQueryData<{ user: { id: string } | null }>(sessionQueryKey)
        ?.user?.id === userId
    );
  }
  return useMutation({
    mutationFn: async (json: ClaimActivityInput) =>
      readResponse<ClaimResult>(
        await api.api.activities[":id"].claim.$post(
          { param: { id }, json },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async (result) => {
      if (!sameSession()) return;
      if ("claim" in result) {
        queryClient.setQueryData(claimKeys.current(userId, id), {
          claim: result.claim,
        });
        queryClient.setQueryData(claimKeys.detail(userId, result.claim.id), {
          claim: result.claim,
        });
        await queryClient.invalidateQueries({
          queryKey: claimKeys.mine(userId),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: ["activity-public", id],
      });
      await queryClient.invalidateQueries({ queryKey: ["activity-private"] });
      await queryClient.invalidateQueries({
        queryKey: ["activity-recipients", id],
      });
      await queryClient.invalidateQueries({
        queryKey: ["password-private", userId, id],
      });
    },
    onError: (error) => {
      if (!sameSession()) return;
      if (error instanceof ActivityRequestError && error.status === 401) {
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
        queryClient.removeQueries({ queryKey: ["claim-private"] });
        queryClient.removeQueries({ queryKey: ["activity-private"] });
      }
    },
  });
}
