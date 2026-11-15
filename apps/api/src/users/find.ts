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

/**
 * Many by name in one read (领取范围's 批量添加), each name by its own
 * index; as findUserByUsername, a name taken over by another account is
 * the latest to sign in. Those not here are left out.
 */
export async function findUsersByUsernames(
  env: ApiBindings,
  usernames: string[],
) {
  if (usernames.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT id,external_id,username,display_name,avatar_url,last_login_at FROM users
    WHERE provider='linux_do' AND active=1
      AND lower(username) IN (SELECT value FROM json_each(?))`,
  )
    .bind(
      JSON.stringify(
        usernames.map((name) => name.replace(/^@/, "").toLowerCase()),
      ),
    )
    .all<SiteUser & { last_login_at: number | null }>();
  const latest = new Map<string, (typeof results)[number]>();
  for (const row of results) {
    const key = row.username.toLowerCase();
    const kept = latest.get(key);
    if (!kept || (row.last_login_at ?? 0) > (kept.last_login_at ?? 0))
      latest.set(key, row);
  }
  return [...latest.values()].map(
    ({ last_login_at: _, ...user }): SiteUser => user,
  );
}
