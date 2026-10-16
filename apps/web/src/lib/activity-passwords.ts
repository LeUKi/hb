import type {
  ActivityPasswords,
  ParticipationMode,
  PasswordClaimInput,
  SolveResult,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
  sessionIdentity,
  sessionQueryKey,
  useAccountSession,
} from "./auth";

export const passwordKey = (userId: string | null, id: string) =>
  ["password-private", userId ?? "guest", id] as const;

export function useActivityPasswords(
  userId: string | null,
  id: string,
  enabled = true,
  participationMode?: ParticipationMode,
  /** How often to read them again: only while the 红包 runs unpushed. */
  poll: number | false = 15_000,
) {
  const queryClient = useQueryClient();
  const scope = useRef({ userId, id, participationMode });
  scope.current = { userId, id, participationMode };
  useEffect(() => {
    if (participationMode !== "direct") return;
    const key = passwordKey(userId, id);
    void queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.setQueryData<ActivityPasswords>(key, {
      passwords: [],
      hiddenCount: 0,
      canSolve: false,
    });
  }, [queryClient, userId, id, participationMode]);
  return useQuery({
    queryKey: passwordKey(userId, id),
    enabled: enabled && Boolean(id) && participationMode !== "direct",
    queryFn: async ({ signal }) => {
      const identity = sessionIdentity(
        queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user ??
          null,
      );
      const result = await readResponse<ActivityPasswords>(
        await api.api.activities[":id"].passwords.$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      );
      const currentUser =
        queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user ??
        null;
      if (
        signal.aborted ||
        (scope.current.userId === userId &&
          scope.current.id === id &&
          scope.current.participationMode === "direct") ||
        (currentUser?.id ?? null) !== userId ||
        sessionIdentity(currentUser) !== identity
      )
        throw new DOMException("请求已失效", "AbortError");
      return result;
    },
    retry: false,
    refetchInterval: participationMode === "direct" ? false : poll,
  });
}

/** 验证其他口令 in one 红包 (the id travels with it). */
export function useSolvePassword(userId: string, csrfToken: string) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId);
  return useMutation({
    gcTime: 0,
    onMutate: async ({ input }: { id: string; input: PasswordClaimInput }) => ({
      identity: account.captureIdentity(),
      ticket: activityToolsEnabled
        ? await beginAttempt(userId, input.password, input.submissionId)
        : null,
    }),
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: PasswordClaimInput;
    }) =>
      readResponse<SolveResult>(
        await api.api.activities[":id"]["password-solves"].$post(
          { param: { id }, json: input },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: (result, { id }, context) => {
      const identity = context?.identity;
      if (account.isCurrentIdentity(identity)) {
        const matched = passwordMatchResult(result);
        if (context?.ticket)
          void settleAttempt(context.ticket, matched, matched ? [id] : []);
        applyAttemptCooldown(
          userId,
          (
            result as {
              attemptCooldown?: Parameters<typeof applyAttemptCooldown>[1];
            }
          ).attemptCooldown ?? null,
        );
        void queryClient.invalidateQueries({
          queryKey: passwordKey(userId, id),
        });
      }
    },
    onError: (error, _variables, context) => {
      const identity = context?.identity;
      if (!account.isCurrentIdentity(identity)) return;
      if (context?.ticket) void settleAttempt(context.ticket, null);
      if (error instanceof ActivityRequestError && error.status === 429) {
        if (error.attemptCooldown)
          applyAttemptCooldown(userId, error.attemptCooldown);
        else applyRetryAfterCooldown(userId, error.retryAfterSeconds);
      }
      if (error instanceof ActivityRequestError && error.status === 401)
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
    },
  });
}
