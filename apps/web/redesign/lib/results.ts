// The two result pages. /🔑/<result>: a 口令 matching several 红包 keeps only
// the activity ids in sessionStorage, so a reload still works without the
// 口令 ever being persisted. /💬/<topic>/<post>: the 红包 linked to a post.

const prefix = "hb-redesign:result:";

/** A result is its owner's only (as on the server): kept with their id. */
export function saveResult(activityIds: string[], owner: string) {
  const id = Math.random().toString(36).slice(2, 10);
  try {
    sessionStorage.setItem(
      prefix + id,
      JSON.stringify({ owner, ids: activityIds }),
    );
  } catch {
    // Storage may be unavailable; the in-memory navigation still works once.
  }
  return id;
}

/** The result's 红包, for its owner; anyone else gets nothing. */
export function readResult(id: string, owner: string | undefined) {
  try {
    const raw = sessionStorage.getItem(prefix + id);
    const parsed = raw
      ? (JSON.parse(raw) as { owner?: unknown; ids?: unknown })
      : null;
    if (!parsed || !owner || parsed.owner !== owner) return null;
    const ids = parsed.ids;
    return Array.isArray(ids) && ids.every((item) => typeof item === "string")
      ? (ids as string[])
      : null;
  } catch {
    return null;
  }
}

/**
 * /💬/<topic>/<post> as production validates a post: a topic id of up to 19
 * digits and a positive floor number. Anything else is "not found".
 */
export function topicAddress(topicId: string, postNumber: string) {
  if (!/^[1-9]\d{0,18}$/u.test(topicId) || !/^[1-9]\d*$/u.test(postNumber))
    return null;
  const post = Number(postNumber);
  return Number.isSafeInteger(post) ? { topicId, postNumber: post } : null;
}
