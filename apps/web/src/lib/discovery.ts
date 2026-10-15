import type {
  ActivityStatistics,
  DiscoveryList,
  GlobalRedemptionInput,
  GlobalRedemptionResult,
} from "@hb/contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { atom } from "jotai";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "./activities";
import { activityToolsEnabled } from "./activity-tools-release";
import {
  applyAttemptCooldown,
  applyRetryAfterCooldown,
} from "./attempt-cooldown";
import {
  beginAttempt,
  bindAttemptOperation,
  getAttemptTicket,
  settleAttempt,
} from "./attempt-history";
import { sessionQueryKey, useAccountSession } from "./auth";
import { syncParticipationResult } from "./participation-cache";

export type ExchangeContext = {
  userId: string;
  sessionScope: string;
  password: string;
  submission: GlobalRedemptionInput;
  claimSubmissionId: string | null;
  resultId: string | null;
  state: "unconfirmed" | "resolved";
  selectedActivityId: string | null;
};

export const exchangeContextAtom = atom<ExchangeContext | null>(null);
export const redemptionKey = (userId: string, id: string) =>
  ["redemption-private", userId, id] as const;

export function useGlobalRedemptionDiscovery(
  userId: string,
  csrfToken: string,
) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId, "session");
  return useMutation({
    gcTime: 0,
    onMutate: async (input) => ({
      identity: account.captureIdentity(),
      ticket: activityToolsEnabled
        ? await beginAttempt(userId, input.password, input.submissionId)
        : null,
    }),
    mutationFn: async (json: GlobalRedemptionInput) =>
      readResponse<GlobalRedemptionResult>(
        await fetch("/api/redemptions/discover", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify(json),
        }),
      ),
    onSuccess: async (result, _variables, context) => {
      const identity = context?.identity;
      if (!account.isCurrentIdentity(identity)) return;
      if (context?.ticket) {
        bindAttemptOperation(context.ticket, result.id);
        bindAttemptOperation(context.ticket, result.claimSubmissionId);
        void settleAttempt(context.ticket, result.result !== "none", [
          ...result.items.map((item) => item.id),
          ...(result.selectedActivityId ? [result.selectedActivityId] : []),
        ]);
      }
      const resultKey = [
        ...redemptionKey(userId, result.id),
        identity,
        null,
      ] as const;
      await queryClient.cancelQueries({ queryKey: resultKey, exact: true });
      if (!account.isCurrentIdentity(identity)) return;
      queryClient.setQueryData(resultKey, result);
      applyAttemptCooldown(userId, result.attemptCooldown ?? null);
      if (result.claimResult) {
        const completed = result.claimResult;
        const id = result.selectedActivityId ?? result.items[0]?.id;
        if (
          id &&
          !(await syncParticipationResult(
            queryClient,
            userId,
            id,
            completed,
            () => account.isCurrentIdentity(identity),
          ))
        )
          return;
        void queryClient.invalidateQueries({ queryKey: ["activity-public"] });
        void queryClient.invalidateQueries({
          queryKey: ["activity-private", userId],
        });
        void queryClient.invalidateQueries({ queryKey: ["discovery"] });
        void queryClient.invalidateQueries({ queryKey: ["topic-activities"] });
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
      if (error instanceof ActivityRequestError && error.status === 401) {
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
      }
    },
  });
}

/**
 * A 口令's matches as pages (/🔑/<result>): the lookup's own first page from
 * the cache when it is there, then 20 more at a time.
 */
export function useRedemptionResultPages(userId: string, id: string) {
  const queryClient = useQueryClient();
  const account = useAccountSession(userId, "session");
  const identity = account.captureIdentity();
  return useInfiniteQuery({
    queryKey: [...redemptionKey(userId, id), identity, "pages"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const requestIdentity = account.captureIdentity();
      const result = await readResponse<GlobalRedemptionResult>(
        await api.api.redemptions[":id"].$get(
          { param: { id }, query: pageParam ? { cursor: pageParam } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      );
      if (
        signal.aborted ||
        requestIdentity !== identity ||
        !account.isCurrentIdentity(requestIdentity)
      )
        throw new DOMException("请求已失效", "AbortError");
      const ticket = pageParam === null ? getAttemptTicket(userId, id) : null;
      if (ticket)
        void settleAttempt(ticket, result.result !== "none", [
          ...result.items.map((item) => item.id),
          ...(result.selectedActivityId ? [result.selectedActivityId] : []),
        ]);
      return result;
    },
    getNextPageParam: (last) => last.nextCursor,
    initialData: () => {
      const first = queryClient.getQueryData<GlobalRedemptionResult>([
        ...redemptionKey(userId, id),
        identity,
        null,
      ]);
      return first ? { pages: [first], pageParams: [null] } : undefined;
    },
    enabled: Boolean(userId) && Boolean(identity),
    retry: false,
    refetchInterval: 15_000,
  });
}

/** A post's 红包 as pages (/💬/<topic>/<post>), 20 at a time. */
export function useTopicActivityPages(
  topicId: string,
  postNumber: number,
  userId: string | null,
) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: ["topic-activities", topicId, postNumber, userId, "pages"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      topicActivitiesQuery(topicId, postNumber, userId, pageParam).queryFn({
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    initialData: () => {
      const first = queryClient.getQueryData<DiscoveryList>(
        topicActivitiesQuery(topicId, postNumber, userId).queryKey,
      );
      return first ? { pages: [first], pageParams: [null] } : undefined;
    },
    retry: false,
    refetchInterval: 15_000,
  });
}

/** A post's 红包: one key and read for the 指令框 and the /💬/ page. */
export function topicActivitiesQuery(
  topicId: string,
  postNumber: number,
  userId: string | null,
  cursor: string | null = null,
) {
  return {
    queryKey: ["topic-activities", topicId, postNumber, userId, cursor],
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
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
  } as const;
}

/** A 红包's 尝试统计 (its sender's), the most frequent text first, 20 at a time. */
export function useStatisticsPages(
  userId: string,
  id: string,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ["activity-private", userId, "statistics", id, "pages"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      readResponse<ActivityStatistics>(
        await api.api.me.activities[":id"].statistics.$get(
          { param: { id }, query: pageParam ? { cursor: pageParam } : {} },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    retry: false,
    refetchInterval: enabled ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
}
