// 个人令牌 (docs/personal-token-design.md): one's own tokens, made, listed
// and stopped from 我的 only. These routes are outside the typed client
// (api/src/app.ts, TS2589): plain fetch, read the same way as the rest.
import type {
  CreatedPersonalToken,
  CreatePersonalTokenInput,
  PersonalToken,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readResponse } from "./activities";
import { useIdentity } from "./session";

export const personalTokenKeys = {
  list: (userId: string) => ["personal-tokens", userId] as const,
};

/** One's tokens, in use first. */
export function usePersonalTokens(userId: string) {
  return useQuery({
    queryKey: personalTokenKeys.list(userId),
    queryFn: async ({ signal }) =>
      readResponse<{ items: PersonalToken[]; max: number }>(
        await fetch("/api/me/personal-tokens", {
          signal,
          cache: "no-store",
          credentials: "same-origin",
        }),
      ),
    retry: false,
  });
}

/** 新建 and 停用, each followed by the list read again. */
export function usePersonalTokenActions(userId: string) {
  const { csrfToken } = useIdentity();
  const queryClient = useQueryClient();
  const send = async <T>(path: string, body?: unknown) => {
    const result = await readResponse<T>(
      await fetch(`/api/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "X-CSRF-Token": csrfToken ?? "",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    await queryClient.invalidateQueries({
      queryKey: personalTokenKeys.list(userId),
    });
    return result;
  };
  const create = useMutation({
    mutationFn: (input: CreatePersonalTokenInput) =>
      send<CreatedPersonalToken>("me/personal-tokens", input),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      send<{ personalToken: PersonalToken }>(
        `me/personal-tokens/${encodeURIComponent(id)}/revoke`,
      ),
  });
  return { create, revoke };
}
