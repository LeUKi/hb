import {
  type ClaimScope,
  type PublicClaimScope,
  readClaimScope,
  type StoredClaimScope,
  scopeAllows,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import {
  findUserByUsername,
  findUsersByUsernames,
  type SiteUser,
  VOUCHED,
} from "../users/find";
import { ActivityError } from "./errors";
import type { ActivityRow } from "./storage";

// 领取范围 (docs/claim-scope-design.md): who may claim or sign up, by
// 信任等级 or by name; either part lets someone in.

type Person = {
  external_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  /** 1 when LINUX DO has vouched for the name (VOUCHED). */
  vouched: number;
  last_login_at: number | null;
};

async function people(
  env: ApiBindings,
  usernames: string[],
  linuxDoIds: string[],
) {
  if (usernames.length === 0 && linuxDoIds.length === 0) return [];
  // Two halves, each by its own index: as one OR, SQLite read every user.
  // Someone found both ways comes back twice, which the callers' maps take.
  // By name only a vouched name (find.ts VOUCHED); by id anyone, as a
  // 领取范围 knows a 社区 mini app's account by id (mini-app-design.md §7).
  return (
    await env.DB.prepare(`SELECT external_id, username, display_name, avatar_url,
        ${VOUCHED} AS vouched, last_login_at FROM users
      WHERE provider = 'linux_do' AND active = 1 AND ${VOUCHED}
        AND lower(username) IN (SELECT lower(value) FROM json_each(?))
      UNION ALL
      SELECT external_id, username, display_name, avatar_url,
        ${VOUCHED} AS vouched, last_login_at FROM users
      WHERE provider = 'linux_do' AND active = 1
        AND external_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(usernames), JSON.stringify(linuxDoIds))
      .all<Person>()
  ).results;
}

/**
 * Who each name stands for: only vouched rows, since the by-id half also
 * brings back a mini app's account under the name it claimed, and coming
 * last it would stand for that name over the real one, keeping a scope
 * pinned to it on every save (sweep 2026-11-21). A name two accounts have
 * had is the latest to sign in, as findUserByUsername has it.
 */
function vouchedByName(found: Person[]) {
  const byName = new Map<string, Person>();
  for (const one of found) {
    if (!one.vouched) continue;
    const key = one.username.toLowerCase();
    const kept = byName.get(key);
    if (!kept || (one.last_login_at ?? 0) > (kept.last_login_at ?? 0))
      byName.set(key, one);
  }
  return byName;
}

/**
 * As saved (and again at opening): each name that has been here is noted
 * by its LINUX DO ID, so a rename later still counts; one noted before
 * keeps its ID and takes its current name. The rest stay names only, a
 * name LINUX DO has not vouched for among them.
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
  const byName = vouchedByName(found);
  const byId = new Map(found.map((one) => [one.external_id, one]));
  const users = scope.users.map((user) => {
    const person =
      byName.get(user.username.toLowerCase()) ??
      (user.linuxDoId ? byId.get(user.linuxDoId) : undefined);
    if (!person) return { username: user.username, linuxDoId: null };
    // An unvouched account (only ever by id) keeps the name it was noted
    // by: its own is the one it claimed, and taken here it could repeat a
    // name the scope keeps apart, which the stored scope refuses.
    return {
      username: person.vouched ? person.username : user.username,
      linuxDoId: person.external_id,
    };
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
  return readClaimScope(
    (JSON.parse(row.config) as { scope?: StoredClaimScope }).scope,
  );
}

/** What 领取范围 knows of someone (scopeViewerStatement). */
export type ScopeViewer = {
  external_id: string;
  username: string;
  trust_level: number | null;
  profile_seen_at: number | null;
};

/** The read behind assertInScope, to be made alone or in a batch. */
export function scopeViewerStatement(env: ApiBindings, userId: string) {
  return env.DB.prepare(
    "SELECT external_id, username, trust_level, profile_seen_at FROM users WHERE id = ?",
  ).bind(userId);
}

/** Before the 口令, the attempt and its cooldown: someone outside is turned away. */
export async function assertInScope(
  env: ApiBindings,
  row: ActivityRow,
  userId: string,
) {
  if (!scopeOf(row)) return;
  checkInScope(
    row,
    await scopeViewerStatement(env, userId).first<ScopeViewer>(),
  );
}

/** assertInScope on what scopeViewerStatement read. */
export function checkInScope(
  row: ActivityRow,
  viewer: ScopeViewer | null | undefined,
) {
  const scope = scopeOf(row);
  if (!scope) return;
  if (
    viewer &&
    scopeAllows(scope, {
      linuxDoId: viewer.external_id,
      // A name LINUX DO has not vouched for (an account the forum's mini
      // app made, docs/mini-app-design.md §7) is not matched: by id only.
      username: viewer.profile_seen_at === null ? "" : viewer.username,
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
  const byName = vouchedByName(found);
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

/** Someone who has been here, as the form shows them. */
function formPerson(person: SiteUser) {
  return {
    linuxDoId: person.external_id,
    username: person.username,
    displayName: person.display_name,
    avatarUrl: person.avatar_url,
  };
}

/** 领取范围's 指定的人: someone by name, as the form adds them. */
export async function findPerson(env: ApiBindings, username: string) {
  const person = await findUserByUsername(env, username);
  return person ? formPerson(person) : null;
}

/** 批量添加: those of the names pasted who have been here, in one read. */
export async function findPeople(env: ApiBindings, usernames: string[]) {
  return (await findUsersByUsernames(env, usernames)).map(formPerson);
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
