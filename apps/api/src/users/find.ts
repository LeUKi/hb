import type { ApiBindings } from "../env";

/** Someone who has been here, as the by-name searches show them. */
export type SiteUser = {
  id: string;
  external_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

/**
 * Someone who has been here, by LINUX DO username in any case: 转账's
 * recipient, an invitation's invitee or 名义, a 领取范围's 指定的人. A
 * name taken over by another account is the latest to sign in.
 */
export function findUserByUsername(
  env: ApiBindings,
  username: string,
  { activeOnly = true }: { activeOnly?: boolean } = {},
) {
  return env.DB.prepare(
    `SELECT id,external_id,username,display_name,avatar_url FROM users
    WHERE provider='linux_do' AND lower(username)=?${activeOnly ? " AND active=1" : ""}
    ORDER BY last_login_at DESC LIMIT 1`,
  )
    .bind(username.replace(/^@/, "").toLowerCase())
    .first<SiteUser>();
}
