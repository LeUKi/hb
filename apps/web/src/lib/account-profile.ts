import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "../api";
import { readResponse } from "./activities";
import { type SessionResponse, sessionIdentity, sessionQueryKey } from "./auth";

type AccountProfile = InferResponseType<typeof api.api.me.$get, 200>;

export function useAccountProfile(user: SessionResponse["user"]) {
  const queryClient = useQueryClient();
  const identity = sessionIdentity(user);
  return useQuery({
    queryKey: ["profile-private", user?.id, user?.accountTier],
    enabled: Boolean(user),
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await readResponse<AccountProfile>(
        await api.api.me.$get(undefined, {
          init: { signal, cache: "no-store" },
        }),
      );
      const current =
        queryClient.getQueryData<SessionResponse>(sessionQueryKey);
      if (
        signal.aborted ||
        queryClient.getQueryState(sessionQueryKey)?.status !== "success" ||
        sessionIdentity(current?.user ?? null) !== identity
      )
        throw new DOMException("身份已改变", "AbortError");
      if (sessionIdentity(result.user) !== identity) {
        void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
        throw new DOMException("身份已改变", "AbortError");
      }
      return result;
    },
  });
}
