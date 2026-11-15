// 个人令牌 (docs/personal-token-design.md): one's own tokens, made, listed
// and stopped from 我的 only. These routes are outside the typed client
// (api/src/app.ts, TS2589): plain fetch, read the same way as the rest.
import type {
  CreatedPersonalToken,
  CreatePersonalTokenInput,
  MyPersonalTokenUsage,
  PERSONAL_TOKEN_RATE_LIMITS,
  PersonalToken,
  PersonalTokenAdminView,
  UpdatePersonalTokenSettingsInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readResponse } from "./activities";
import { useIdentity } from "./session";

export const personalTokenKeys = {
  list: (userId: string) => ["personal-tokens", userId] as const,
  usage: (userId: string) => ["personal-tokens", userId, "usage"] as const,
  admin: ["personal-tokens", "admin"] as const,
};

async function get<T>(path: string, signal?: AbortSignal) {
  return readResponse<T>(
    await fetch(`/api/${path}`, {
      signal,
      cache: "no-store",
      credentials: "same-origin",
    }),
  );
}

/** One's tokens, in use first. */
export function usePersonalTokens(userId: string) {
  return useQuery({
    queryKey: personalTokenKeys.list(userId),
    queryFn: ({ signal }) =>
      get<{ items: PersonalToken[]; max: number }>(
        "me/personal-tokens",
        signal,
      ),
    retry: false,
  });
}

/**
 * One's own calls (docs/personal-token-design.md §8), read only while there
 * are tokens to count; the server keeps each answer a minute.
 */
export function usePersonalTokenUsage(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: personalTokenKeys.usage(userId),
    queryFn: ({ signal }) =>
      get<{
        usage: MyPersonalTokenUsage;
        limits: typeof PERSONAL_TOKEN_RATE_LIMITS;
      }>("me/personal-tokens/usage", signal),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** 网站管理: the switch, everyone's calls, the busiest accounts. */
export function usePersonalTokenAdmin() {
  return useQuery({
    queryKey: personalTokenKeys.admin,
    queryFn: ({ signal }) =>
      get<PersonalTokenAdminView>("admin/personal-tokens", signal),
    staleTime: 60_000,
  });
}

/** 个人令牌's master switch, saved against the version read. */
export function useSavePersonalTokenSettings() {
  const { csrfToken } = useIdentity();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePersonalTokenSettingsInput) =>
      readResponse<{ settings: PersonalTokenAdminView["settings"] }>(
        await fetch("/api/admin/personal-tokens/settings", {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            "X-CSRF-Token": csrfToken ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        }),
      ),
    onSuccess: ({ settings }) =>
      queryClient.setQueryData<PersonalTokenAdminView>(
        personalTokenKeys.admin,
        (view) => (view ? { ...view, settings } : view),
      ),
    // Someone saved first: read what is saved now.
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: personalTokenKeys.admin }),
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
