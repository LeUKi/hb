import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type SessionResponse, sessionQueryKey, useSession } from "./auth";

export type SessionUser = NonNullable<SessionResponse["user"]>;

/**
 * Who is signed in. A guest, the identity check still on its way, or a
 * failed check all read as no account: the site works on as a guest, and
 * the 顶栏 offers to check again (02 §9).
 */
export function useSessionUser(): SessionUser | null {
  return useIdentity().user;
}

/**
 * The identity check itself: for the 顶栏, the 用户卡片 and gated pages.
 * A check read again after a failure stays "failed" (and "checking") until
 * it answers: the query itself goes back to pending while it reads.
 */
export function useIdentity() {
  const session = useSession();
  const lastFailed = session.errorUpdatedAt > session.dataUpdatedAt;
  const failed = session.isError || lastFailed;
  return {
    /** The first answer has arrived (or failed). */
    ready: !session.isPending || lastFailed,
    failed,
    checking: session.isFetching,
    user: failed ? null : (session.data?.user ?? null),
    csrfToken: failed ? null : (session.data?.csrfToken ?? null),
    retry: () => session.refetch(),
  };
}

/** The account at the time of an event, outside rendering. */
export function sessionUserOf(queryClient: QueryClient): SessionUser | null {
  if (queryClient.getQueryState(sessionQueryKey)?.status === "error")
    return null;
  return (
    queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user ?? null
  );
}

/** The CSRF token of the current session, outside rendering. */
export function csrfTokenOf(queryClient: QueryClient) {
  return (
    queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.csrfToken ??
    null
  );
}

export function useSessionReader() {
  const queryClient = useQueryClient();
  return {
    user: () => sessionUserOf(queryClient),
    csrfToken: () => csrfTokenOf(queryClient),
  };
}
