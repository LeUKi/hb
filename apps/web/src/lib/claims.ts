import type {
  ActivityParticipationResponse,
  ClaimActivityInput,
  ClaimDetail,
  ClaimResult,
  DrawSummary,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "./activities";
import { activityToolsEnabled } from "./activity-tools-release";
import {
  applyAttemptCooldown,
  applyRetryAfterCooldown,
} from "./attempt-cooldown";
import { beginAttempt, settleAttempt } from "./attempt-history";
import { passwordMatchResult } from "./attempt-history-result";
import {
  type SessionResponse,
  sessionQueryKey,
  sessionScope,
  useAccountSession,
} from "./auth";
import {
  canSkipDrawRefresh,
  claimDetailKey,
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
  /** Its changes arrive over the live channel (lib/live.ts): no polling. */
  live = false,
) {
  const client = useQueryClient();
  const account = useAccountSession(userId, "session");
  const key = participationKey(userId, activityId);
  const identity = sessionScope(
    client.getQueryData<SessionResponse>(sessionQueryKey),
  );
  const scope = JSON.stringify([userId, activityId, enabled, identity]);
  const cached = client.getQueryState<ParticipationCache>(key);
  const refresh = useRef({
    scope,
    fullReadRequested: participationNeedsFullRead(
      cached?.data,
      cached?.dataUpdatedAt ?? 0,
      cached?.isInvalidated,
    ),
    drawState,
    request: null as { full: boolean; scope: string } | null,
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
      const accountIdentity = account.captureIdentity();
      const requestScope = sessionScope(
        client.getQueryData<SessionResponse>(sessionQueryKey),
      );
      const state = refresh.current;
      const full =
        state.fullReadRequested ||
        client.getQueryData<ParticipationCache>(key)?.readSessionScope !==
          requestScope ||
        !canSkipDrawRefresh(
          client.getQueryData<ParticipationCache>(key),
          drawState,
        );
      state.fullReadRequested = false;
      const request = { full, scope: requestScope };
      state.request = request;
      try {
        const result = await readResponse<ActivityParticipationResponse>(
          await fetch(
            `/api/activities/${encodeURIComponent(activityId)}/participation${full ? "" : "?refresh=0"}`,
            { signal, cache: "no-store" },
          ),
        );
        if (
          signal.aborted ||
          !account.isCurrentIdentity(accountIdentity) ||
          requestScope !==
            sessionScope(client.getQueryData<SessionResponse>(sessionQueryKey))
        )
          throw new DOMException("请求已失效", "AbortError");
        return {
          ...result,
          readSessionScope: requestScope,
          readAt: Date.now(),
        };
      } finally {
        if (state.request === request) state.request = null;
      }
    },
    enabled,
    retry: false,
    staleTime: (query) =>
      isCompleteParticipation(query.state.data) ? 15_000 : 0,
    refetchInterval: (query) =>
      live ? false : participationRefresh(query.state.data, drawState),
  });
  const refetch = useCallback(() => {
    // Join an existing full read; a manual refresh upgrades a snapshot-only read.
    if (refresh.current.request?.full)
      return query.refetch({ cancelRefetch: false });
    refresh.current.fullReadRequested = true;
    return query.refetch();
  }, [query.refetch]);
  const checkedSession = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || query.data?.readSessionScope === identity) return;
    if (query.isFetching && refresh.current.request?.scope === identity) {
      checkedSession.current = scope;
      return;
    }
    const cancelled =
      query.error instanceof DOMException && query.error.name === "AbortError";
    if (checkedSession.current === scope && query.error && !cancelled) return;
    checkedSession.current = scope;
    let active = true;
    void client
      .cancelQueries({
        queryKey: participationKey(userId, activityId),
        exact: true,
      })
      .then(() => {
        if (
          !active ||
          identity !==
            sessionScope(client.getQueryData<SessionResponse>(sessionQueryKey))
        )
          return;
        refresh.current.fullReadRequested = true;
        void query.refetch();
      });
    return () => {
      active = false;
    };
  }, [
    client,
    enabled,
    identity,
    scope,
    query.data?.readSessionScope,
    query.isFetching,
    query.error,
    query.refetch,
    userId,
    activityId,
  ]);
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
  return {
    ...query,
    data: query.data?.readSessionScope === identity ? query.data : undefined,
    refetch,
  };
}

/**
 * Sends the viewer's payment again after the upstream found no LINUX DO
 * Credit account for them (api: payments/resend.ts): only while its
 * `resendUntil` lasts. The page reads where it went from the answer, and
 * hears the rest over the live channel.
 */
export function useResendPayment(
  userId: string,
  csrfToken: string,
  activityId: string,
) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId, "session");
  const key = participationKey(userId, activityId);
  return useMutation({
    gcTime: 0,
    onMutate: () => ({ identity: account.captureIdentity() }),
    mutationFn: async (claimId: string) =>
      readResponse<{ claim: ClaimDetail }>(
        await api.api.me.claims[":id"].resend.$post(
          { param: { id: claimId } },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async ({ claim }, _claimId, context) => {
      if (!account.isCurrentIdentity(context?.identity)) return;
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.setQueryData<ParticipationCache>(key, (previous) =>
        previous?.claim?.id === claim.id
          ? { ...previous, claim }
          : previous?.registration?.claim?.id === claim.id
            ? {
                ...previous,
                registration: { ...previous.registration, claim },
              }
            : previous,
      );
      void queryClient.invalidateQueries({
        queryKey: ["claim-private", userId],
        predicate: (query) => query.queryKey[2] !== "participation",
      });
    },
    onError: (_error, _claimId, context) => {
      // Refused (too late, or it moved): show where it stands now.
      if (account.isCurrentIdentity(context?.identity))
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

/** Claim, or sign up for a timed draw, in one 红包 (the id travels with it). */
export function useClaimReward(userId: string, csrfToken: string) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId, "session");
  return useMutation({
    gcTime: 0,
    onMutate: async ({ input }: { id: string; input: ClaimActivityInput }) => ({
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
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: ClaimActivityInput;
    }) =>
      readResponse<ClaimResult>(
        await api.api.activities[":id"].claim.$post(
          { param: { id }, json: input },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async (result, { id, input: _variables }, context) => {
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
    onError: (error, { input: _variables }, context) => {
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
