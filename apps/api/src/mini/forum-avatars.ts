import { forumAvatar } from "@hb/contracts";
import type { ApiBindings } from "../env";

// 社区小程序 (docs/mini-app-design.md §7): the people in what 红包站 answers
// the mini app — the sender, the 名单, a 领取范围's names — with the 社区's
// picture for each in place of 红包站's. The 社区's frame loads no pictures
// from elsewhere, and someone who has only claimed in the 社区 has none
// here; the app asks the 社区 for it by their LINUX DO id.

type Person = { username: string; avatarUrl: string | null };

const isPerson = (value: object): value is Person =>
  typeof (value as { username?: unknown }).username === "string" &&
  "avatarUrl" in value;

function collect(value: unknown, names: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, names);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isPerson(value)) names.add(value.username);
  for (const item of Object.values(value)) collect(item, names);
}

function rewrite(value: unknown, ids: Map<string, string | null>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, ids));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    next[key] = rewrite(item, ids);
  if (isPerson(value)) {
    const id = ids.get(value.username);
    next.avatarUrl = id ? forumAvatar(id) : null;
  }
  return next;
}

/** D1 binds at most 100 values a statement. */
const CHUNK = 90;

/**
 * `value` with each person's picture the 社区's (forumAvatar), found by
 * their name here; a name two accounts share, or none has, keeps none.
 */
export async function withForumAvatars<T>(
  env: ApiBindings,
  value: T,
): Promise<T> {
  const names = new Set<string>();
  collect(value, names);
  if (!names.size) return value;
  const ids = new Map<string, string | null>();
  const list = [...names];
  for (let start = 0; start < list.length; start += CHUNK) {
    const chunk = list.slice(start, start + CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT username, external_id FROM users
        WHERE provider='linux_do' AND username IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ username: string; external_id: string }>();
    for (const row of results)
      ids.set(row.username, ids.has(row.username) ? null : row.external_id);
  }
  return rewrite(value, ids) as T;
}
