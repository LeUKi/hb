import type {
  ActivityStatistics,
  DiscoveryList,
  GlobalRedemptionInput,
  GlobalRedemptionResult,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atom } from "jotai";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "./activities";
import { sessionQueryKey } from "./auth";

export type ExchangeContext = {
  userId: string;
  password: string;
  submission: GlobalRedemptionInput;
  resultId: string | null;
  state: "unconfirmed" | "resolved";
  selectedActivityId: string | null;
};

export const exchangeContextAtom = atom<ExchangeContext | null>(null);
export const redemptionKey = (userId: string, id: string) =>
  ["redemption-private", userId, id] as const;

export function useGlobalRedemption(userId: string, csrfToken: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: GlobalRedemptionInput) =>
      readResponse<GlobalRedemptionResult>(
        await api.api.redemptions.$post(
          { json },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async (result) => {
      if (
        queryClient.getQueryState(sessionQueryKey)?.status !== "success" ||
        queryClient.getQueryData<{ user: { id: string } | null }>(
          sessionQueryKey,
        )?.user?.id !== userId
      )
        return;
      queryClient.setQueryData(
        [...redemptionKey(userId, result.id), null],
        result,
      );
      if (result.claimResult && "claim" in result.claimResult) {
        await queryClient.invalidateQueries({
          queryKey: ["claim-private", userId],
        });
        await queryClient.invalidateQueries({ queryKey: ["activity-public"] });
        await queryClient.invalidateQueries({
          queryKey: ["activity-private", userId],
        });
      }
    },
    onError: (error) => {
      if (
        queryClient.getQueryData<{ user: { id: string } | null }>(
          sessionQueryKey,
        )?.user?.id !== userId
      )
        return;
      if (error instanceof ActivityRequestError && error.status === 401) {
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
      }
    },
  });
}

export function useRedemptionResult(
  userId: string,
  id: string | null,
  cursor: string | null,
) {
  return useQuery({
    queryKey: [...redemptionKey(userId, id ?? ""), cursor],
    queryFn: async ({ signal }) =>
      readResponse<GlobalRedemptionResult>(
        await api.api.redemptions[":id"].$get(
          { param: { id: id ?? "" }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    enabled: id !== null,
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useDiscovery(
  status: "all" | "active" | "ended",
  cursor: string | null,
  userId: string | null,
) {
  return useQuery({
    queryKey: ["discovery", userId, status, cursor],
    queryFn: async ({ signal }) =>
      readResponse<DiscoveryList>(
        await api.api.discovery.activities.$get(
          { query: { status, ...(cursor ? { cursor } : {}) } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useTopicActivities(
  topicId: string,
  postNumber: number,
  cursor: string | null,
  userId: string | null,
) {
  return useQuery({
    queryKey: ["topic-activities", topicId, postNumber, userId, cursor],
    queryFn: async ({ signal }) =>
      readResponse<DiscoveryList>(
        await api.api.topics[":topicId"].activities.$get(
          {
            param: { topicId },
            query: {
              postNumber: String(postNumber),
              ...(cursor ? { cursor } : {}),
            },
          },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useActivityStatistics(
  userId: string,
  id: string,
  cursor: string | null,
) {
  return useQuery({
    queryKey: ["activity-private", userId, "statistics", id, cursor],
    queryFn: async ({ signal }) =>
      readResponse<ActivityStatistics>(
        await api.api.me.activities[":id"].statistics.$get(
          { param: { id }, query: cursor ? { cursor } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    retry: false,
    refetchInterval: 15_000,
  });
}
