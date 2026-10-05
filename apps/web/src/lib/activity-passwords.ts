import type {
  ActivityPasswords,
  ClaimActivityInput,
  SolveResult,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "./activities";
import { sessionQueryKey } from "./auth";

export const passwordKey = (userId: string | null, id: string) =>
  ["password-private", userId ?? "guest", id] as const;

export function useActivityPasswords(userId: string | null, id: string) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: passwordKey(userId, id),
    queryFn: async ({ signal }) => {
      const result = await readResponse<ActivityPasswords>(
        await api.api.activities[":id"].passwords.$get(
          { param: { id } },
          { init: { signal, cache: "no-store" } },
        ),
      );
      const currentId =
        queryClient.getQueryData<{ user: { id: string } | null }>(
          sessionQueryKey,
        )?.user?.id ?? null;
      if (currentId !== userId)
        throw new DOMException("身份已改变", "AbortError");
      return result;
    },
    retry: false,
    refetchInterval: 15_000,
  });
}

export function useSolvePassword(
  userId: string,
  csrfToken: string,
  id: string,
) {
  const queryClient = useQueryClient();
  const sameSession = () =>
    queryClient.getQueryData<{ user: { id: string } | null }>(sessionQueryKey)
      ?.user?.id === userId;
  return useMutation({
    mutationFn: async (json: ClaimActivityInput) =>
      readResponse<SolveResult>(
        await api.api.activities[":id"]["password-solves"].$post(
          { param: { id }, json },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    onSuccess: async () => {
      if (sameSession())
        await queryClient.invalidateQueries({
          queryKey: passwordKey(userId, id),
        });
    },
    onError: (error) => {
      if (
        sameSession() &&
        error instanceof ActivityRequestError &&
        error.status === 401
      )
        queryClient.setQueryData(sessionQueryKey, {
          user: null,
          csrfToken: null,
        });
    },
  });
}
