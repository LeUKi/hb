import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { api } from "../api";

type SessionResponse = InferResponseType<typeof api.api.me.$get, 200>;

export const sessionQueryKey = ["auth", "session"] as const;

const anonymousSession = {
  user: null,
  csrfToken: null,
} satisfies SessionResponse;

function isPrivateQueryKey(queryKey: readonly unknown[]) {
  return queryKey[0] !== "api-health";
}

export async function fetchSession({
  signal,
}: {
  signal?: AbortSignal;
}): Promise<SessionResponse> {
  const response = await api.api.me.$get(undefined, {
    init: { signal },
  });

  if (!response.ok) {
    throw new Error(`身份检查失败：HTTP ${response.status}`);
  }

  return response.json();
}

export function useSession() {
  return useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => fetchSession({ signal }),
    refetchOnWindowFocus: true,
  });
}

export function getLoginHref(returnTo: string) {
  const safeReturnTo = returnTo.startsWith("/") ? returnTo : "/";
  return `/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function getAuthErrorMessage(authError: string | null) {
  if (!authError) {
    return null;
  }

  if (authError === "access_denied" || authError === "cancelled") {
    return "登录已取消，可以重新尝试。";
  }

  if (
    authError === "auth_not_configured" ||
    authError === "provider_unavailable" ||
    authError === "oauth_not_configured" ||
    authError === "service_unavailable"
  ) {
    return "登录服务暂时不可用，请稍后再试。";
  }

  if (authError === "invalid_state") {
    return "登录会话已失效，请重新登录。";
  }

  if (authError === "auth_failed") {
    return "登录没有完成，请重新尝试。";
  }

  return "登录没有完成，请重新尝试。";
}

export function isAuthUnavailable(authError: string | null) {
  return authError === "auth_not_configured";
}

export function useLogout(csrfToken: string | null | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await api.api.auth.logout.$post(undefined, {
        headers: csrfToken ? { "X-CSRF-Token": csrfToken } : undefined,
      });

      if (!response.ok) {
        throw new Error(`退出登录失败：HTTP ${response.status}`);
      }

      return response.json();
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({
        predicate: (query) => isPrivateQueryKey(query.queryKey),
      });
      queryClient.setQueryData<SessionResponse>(
        sessionQueryKey,
        anonymousSession,
      );
      queryClient.removeQueries({
        predicate: (query) =>
          isPrivateQueryKey(query.queryKey) && query.queryKey[0] !== "auth",
      });
    },
  });
}
