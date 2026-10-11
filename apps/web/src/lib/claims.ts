import type {
  ActivityHistoryFilters,
  ActivityParticipationResponse,
  ClaimActivityInput,
  ClaimDetail,
  ClaimList,
  ClaimResult,
  DrawSummary,
  ParticipationList,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import {
  ActivityRequestError,
  historyListRefreshOptions,
  readResponse,
  useMountedPageFocusRefresh,
} from "./activities";
import { activityToolsEnabled } from "./activity-tools-release";
import {
  applyAttemptCooldown,
  applyRetryAfterCooldown,
} from "./attempt-cooldown";
import { beginAttempt, settleAttempt } from "./attempt-history";
import { passwordMatchResult } from "./attempt-history-result";
import { sessionQueryKey, useAccountSession } from "./auth";
import {
  canSkipDrawRefresh,
  claimDetailKey,
  claimRefresh,
  isCompleteParticipation,
  type ParticipationCache,
  participationKey,
  participationNeedsFullRead,
  participationRefresh,
  syncParticipationResult,
} from "./participation-cache";

export const claimKeys = {
  mine: (userId: string) => ["claim-private", userId] as const,
  participations: (userId: string) =>
    ["participation-private", userId] as const,
  participation: participationKey,
  detail: claimDetailKey,
};

export function useCurrentParticipation(
  userId: string,
  activityId: string,
  enabled = true,
  drawState?: DrawSummary["state"],
) {
  const client = useQueryClient();
  const account = useAccountSession(userId);
  const key = participationKey(userId, activityId);
  const scope = JSON.stringify([userId, activityId, enabled]);
  const cached = client.getQueryState<ParticipationCache>(key);
  const refresh = useRef({
    scope,
    fullReadRequested: participationNeedsFullRead(
      cached?.data,
      cached?.dataUpdatedAt ?? 0,
      cached?.isInvalidated,
    ),
    drawState,
    request: null as { full: boolean } | null,
  });
  if (refresh.current.scope !== scope)
    refresh.current = {
      scope,
      fullReadRequested: participationNeedsFullRead(
        cached?.data,
        cached?.dataUpdatedAt ?? 0,
        cached?.isInvalidated,
      ),
      drawState,
      request: null,
    };
  const query = useQuery<ParticipationCache>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const identity = account.captureIdentity();
      const state = refresh.current;
      const full =
        state.fullReadRequested ||
        !canSkipDrawRefresh(
          client.getQueryData<ParticipationCache>(key),
          drawState,
        );
      state.fullReadRequested = false;
      const request = { full };
      state.request = request;
      try {
        const result = await readResponse<ActivityParticipationResponse>(
          await fetch(
            `/api/activities/${encodeURIComponent(activityId)}/participation${full ? "" : "?refresh=0"}`,
            { signal, cache: "no-store" },
          ),
        );
        if (signal.aborted || !account.isCurrentIdentity(identity))
          throw new DOMException("请求已失效", "AbortError");
        return result;
      } finally {
        if (state.request === request) state.request = null;
      }
    },
    enabled,
    retry: false,
    staleTime: (query) =>
      isCompleteParticipation(query.state.data) ? 15_000 : 0,
    refetchInterval: (query) =>
      participationRefresh(query.state.data, drawState),
  });
  const refetch = useCallback(() => {
    // Join an existing full read; a manual refresh upgrades a snapshot-only read.
    if (refresh.current.request?.full)
      return query.refetch({ cancelRefetch: false });
    refresh.current.fullReadRequested = true;
    return query.refetch();
  }, [query.refetch]);
  useEffect(() => {
    const previous = refresh.current.drawState;
    refresh.current.drawState = drawState;
    // The first public response must not repeat the parallel participation GET.
    if (
      enabled &&
      previous !== undefined &&
      drawState !== undefined &&
      previous !== drawState
    )
      void refetch();
  }, [enabled, drawState, refetch]);
  return { ...query, refetch };
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

export function useMyParticipations(
  userId: string,
  cursor: string | null,
  filters: ActivityHistoryFilters = {},
) {
  const type = filters.type ?? "all";
  const status = filters.status ?? "all";
  const query = new URLSearchParams({ type, status });
  if (cursor) query.set("cursor", cursor);
  const result = useQuery({
    queryKey: [
      ...claimKeys.participations(userId),
      "list",
      type,
      status,
      cursor,
    ],
    queryFn: async ({ signal }) =>
      readResponse<ParticipationList>(
        await fetch(`/api/me/participations?${query.toString()}`, {
          signal,
          cache: "no-store",
        }),
      ),
    retry: false,
    ...historyListRefreshOptions,
  });
  useMountedPageFocusRefresh(result.refetch);
  return result;
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

export function useClaimReward(userId: string, csrfToken: string, id: string) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId);
  return useMutation({
    gcTime: 0,
    onMutate: async (input) => ({
      identity: account.captureIdentity(),
      ticket:
        activityToolsEnabled && input.participationMode !== "direct"
          ? await beginAttempt(
              userId,
              input.password,
              input.submissionId,
              input.discoveryId,
            )
          : null,
    }),
    mutationFn: async (json: ClaimActivityInput) =>
      readResponse<ClaimResult>(
        await api.api.activities[":id"].claim.$post(
          { param: { id }, json },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async (result, _variables, context) => {
      const identity = context?.identity;
      if (!account.isCurrentIdentity(identity)) return;
      const matched = passwordMatchResult(result);
      if (_variables.participationMode !== "direct" && context?.ticket)
        void settleAttempt(context.ticket, matched, matched ? [id] : []);
      applyAttemptCooldown(
        userId,
        (
          result as {
            attemptCooldown?: Parameters<typeof applyAttemptCooldown>[1];
          }
        ).attemptCooldown ?? null,
      );
      if (
        !(await syncParticipationResult(queryClient, userId, id, result, () =>
          account.isCurrentIdentity(identity),
        ))
      )
        return;
      void queryClient.invalidateQueries({
        queryKey: ["activity-public", id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["activity-private", userId],
      });
      void queryClient.invalidateQueries({ queryKey: ["discovery"] });
      void queryClient.invalidateQueries({ queryKey: ["topic-activities"] });
      void queryClient.invalidateQueries({
        queryKey: ["activity-roster", id],
      });
      if (_variables.participationMode !== "direct")
        void queryClient.invalidateQueries({
          queryKey: ["password-private", userId, id],
        });
    },
    onError: (error, _variables, context) => {
      const identity = context?.identity;
      if (!account.isCurrentIdentity(identity)) return;
      if (_variables.participationMode !== "direct" && context?.ticket)
        void settleAttempt(context.ticket, null);
      if (error instanceof ActivityRequestError && error.status === 429) {
        if (error.attemptCooldown)
          applyAttemptCooldown(userId, error.attemptCooldown);
        else applyRetryAfterCooldown(userId, error.retryAfterSeconds);
      }
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
