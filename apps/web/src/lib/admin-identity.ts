import type { SessionResponse } from "./auth";

/** CSRF tokens distinguish sessions even when the account is unchanged. */
export function adminIdentity(session: SessionResponse) {
  const user = session.user;
  return user
    ? JSON.stringify([user.id, user.isAdmin, session.csrfToken])
    : "anonymous";
}
