import {
  type ClaimScope,
  type LdcActivityInput,
  type PublicClaimScope,
  scopeAllows,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { findUserByUsername } from "../users/find";
import { ActivityError } from "./errors";
import type { ActivityRow } from "./storage";

// 领取范围 (docs/claim-scope-design.md): who may claim or sign up, by
// 信任等级 or by name; either part lets someone in.

type Person = {
  external_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
};

async function people(
  env: ApiBindings,
  usernames: string[],
  linuxDoIds: string[],
) {
  if (usernames.length === 0 && linuxDoIds.length === 0) return [];
  return (
    await env.DB.prepare(`SELECT external_id, username, display_name, avatar_url FROM users
      WHERE provider = 'linux_do' AND active = 1 AND (
        lower(username) IN (SELECT lower(value) FROM json_each(?))
        OR external_id IN (SELECT value FROM json_each(?)))`)
      .bind(JSON.stringify(usernames), JSON.stringify(linuxDoIds))
      .all<Person>()
  ).results;
}

/**
 * As saved (and again at opening): each name that has been here is noted
 * by its LINUX DO ID, so a rename later still counts; one noted before
 * keeps its ID and takes its current name. The rest stay names only.
 */
export async function resolveScope(
  env: ApiBindings,
  scope: ClaimScope | undefined,
): Promise<ClaimScope | undefined> {
  if (!scope?.users?.length) return scope;
  const found = await people(
    env,
    scope.users.map((user) => user.username),
    scope.users.flatMap((user) => (user.linuxDoId ? [user.linuxDoId] : [])),
  );
  const byName = new Map(found.map((one) => [one.username.toLowerCase(), one]));
  const byId = new Map(found.map((one) => [one.external_id, one]));
  const users = scope.users.map((user) => {
    const person =
      byName.get(user.username.toLowerCase()) ??
      (user.linuxDoId ? byId.get(user.linuxDoId) : undefined);
    return person
      ? { username: person.username, linuxDoId: person.external_id }
      : { username: user.username, linuxDoId: null };
  });
  // Two names may have turned out to be one person.
  const seen = new Set<string>();
  return {
    ...scope,
    users: users.filter((user) => {
      const key = user.linuxDoId ?? `@${user.username.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export function scopeOf(row: ActivityRow) {
  return (JSON.parse(row.config) as LdcActivityInput).scope;
}

/** Before the 口令, the attempt and its cooldown: someone outside is turned away. */
export async function assertInScope(
  env: ApiBindings,
  row: ActivityRow,
  userId: string,
) {
  const scope = scopeOf(row);
  if (!scope) return;
  const viewer = await env.DB.prepare(
    "SELECT external_id, username, trust_level FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{
      external_id: string;
      username: string;
      trust_level: number | null;
    }>();
  if (
    viewer &&
    scopeAllows(scope, {
      linuxDoId: viewer.external_id,
      username: viewer.username,
      trustLevel: viewer.trust_level,
    })
  )
    return;
  throw new ActivityError(
    403,
    "NOT_IN_SCOPE",
    row.drawState === null
      ? "这个红包只有部分人能领"
      : "这个红包只有部分人能报名",
  );
}

/** On lists (the 红包广场's cards): the range, the people by name only. */
export function publicScope(
  scope: ClaimScope | undefined,
): PublicClaimScope | undefined {
  if (!scope) return undefined;
  return {
    ...(scope.levels ? { levels: scope.levels } : {}),
    ...(scope.users?.length
      ? { users: scope.users.map((user) => ({ username: user.username })) }
      : {}),
  };
}

/** On a 红包's own read: the people with their names and faces, as now. */
export async function publicScopeWithPeople(
  env: ApiBindings,
  scope: ClaimScope | undefined,
): Promise<PublicClaimScope | undefined> {
  const plain = publicScope(scope);
  if (!scope?.users?.length || !plain) return plain;
  const found = await people(
    env,
    scope.users.filter((user) => !user.linuxDoId).map((user) => user.username),
    scope.users.flatMap((user) => (user.linuxDoId ? [user.linuxDoId] : [])),
  );
  const byName = new Map(found.map((one) => [one.username.toLowerCase(), one]));
  const byId = new Map(found.map((one) => [one.external_id, one]));
  return {
    ...plain,
    users: scope.users.map((user) => {
      const person = user.linuxDoId
        ? byId.get(user.linuxDoId)
        : byName.get(user.username.toLowerCase());
      return person
        ? {
            username: person.username,
            displayName: person.display_name,
            avatarUrl: person.avatar_url,
          }
        : { username: user.username };
    }),
  };
}

/** 领取范围's 指定的人: someone by name, as the form adds them. */
export async function findPerson(env: ApiBindings, username: string) {
  const person = await findUserByUsername(env, username);
  return person
    ? {
        linuxDoId: person.external_id,
        username: person.username,
        displayName: person.display_name,
        avatarUrl: person.avatar_url,
      }
    : null;
}

/** The same 领取范围, whatever case the names were typed in. */
export function sameScope(
  left: ClaimScope | undefined,
  right: ClaimScope | undefined,
) {
  const key = (scope: ClaimScope | undefined) =>
    JSON.stringify({
      levels: scope?.levels ?? null,
      users: (scope?.users ?? [])
        .map((user) => user.username.toLowerCase())
        .sort(),
    });
  return key(left) === key(right);
}
