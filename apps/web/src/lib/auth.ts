import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { useEffect } from "react";
import { api } from "../api";
import {
  applySessionAttemptCooldown,
  clearAttemptCooldown,
} from "./attempt-cooldown";

export type SessionResponse = InferResponseType<
  typeof api.api.session.$get,
  200
>;

export const sessionQueryKey = ["auth", "session"] as const;

const anonymousSession = {
  user: null,
  csrfToken: null,
  attemptCooldown: null,
} as SessionResponse;

let sessionGeneration = 0;
let forceAnonymousSession = false;

function isPrivateQueryKey(queryKey: readonly unknown[]) {
  return queryKey[0] !== "api-health";
}

export async function fetchSession({
  signal,
}: {
  signal?: AbortSignal;
}): Promise<SessionResponse> {
  if (forceAnonymousSession) return anonymousSession;
  const generation = sessionGeneration;
  const response = await api.api.session.$get(undefined, {
    init: { signal },
  });

  if (!response.ok) {
    throw new Error(`身份检查失败：HTTP ${response.status}`);
  }

  const session = await response.json();
  return generation === sessionGeneration && !forceAnonymousSession
    ? session
    : anonymousSession;
}

type SessionAttemptCooldownSnapshot = SessionResponse & {
  attemptCooldown?: Parameters<typeof applySessionAttemptCooldown>[1];
};

export function useSession() {
  const query = useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => fetchSession({ signal }),
    // A fresh data cache must not postpone detecting a session changed elsewhere.
    refetchOnWindowFocus: "always",
  });
  const session = query.data as SessionAttemptCooldownSnapshot | undefined;
  const userId = session?.user?.id ?? null;
  const cooldown = session?.attemptCooldown;
  useEffect(() => {
    if (query.status !== "success") return;
    applySessionAttemptCooldown(userId, cooldown ?? null);
  }, [query.status, userId, cooldown]);
  return query;
}

function safeReturnTo(returnTo: string) {
  return returnTo.startsWith("/") &&
    !returnTo.startsWith("//") &&
    !returnTo.includes("\\")
    ? returnTo
    : "/";
}

export function getLoginHref(returnTo: string) {
  return `/api/auth/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export function sessionIdentity(
  user: Pick<NonNullable<SessionResponse["user"]>, "id"> | null,
) {
  return user ? user.id : null;
}

/** Private presentation facts belong to one confirmed login session. */
export function sessionScope(session: SessionResponse | undefined) {
  return JSON.stringify([
    session?.user?.id ?? null,
    session?.csrfToken ?? null,
  ]);
}

export function useAccountSession(
  userId: string,
  identityScope: "account" | "session" = "account",
) {
  // Configuration submissions survive a token refresh for the same account;
  // personal participation facts explicitly require one login session.
  const queryClient = useQueryClient();
  const captureIdentity = () => {
    const session = queryClient.getQueryData<SessionResponse>(sessionQueryKey);
    return session?.user
      ? identityScope === "session"
        ? sessionScope(session)
        : sessionIdentity(session.user)
      : null;
  };
  const renderedIdentity = captureIdentity();
  const isCurrentIdentity = (identity: string | null | undefined) =>
    Boolean(identity) &&
    queryClient.getQueryState(sessionQueryKey)?.status === "success" &&
    queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user?.id ===
      userId &&
    captureIdentity() === identity;
  return {
    captureIdentity,
    isCurrentIdentity,
    isCurrentSession: () => isCurrentIdentity(renderedIdentity),
  };
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
    onMutate: async () => {
      sessionGeneration += 1;
      forceAnonymousSession = true;
      clearAttemptCooldown();
      await queryClient.cancelQueries({
        predicate: (query) => isPrivateQueryKey(query.queryKey),
      });
      queryClient.setQueryData<SessionResponse>(
        sessionQueryKey,
        anonymousSession,
      );
    },
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
      forceAnonymousSession = false;
      queryClient.removeQueries({
        predicate: (query) =>
          isPrivateQueryKey(query.queryKey) && query.queryKey[0] !== "auth",
      });
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
    onError: async () => {
      forceAnonymousSession = false;
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}
