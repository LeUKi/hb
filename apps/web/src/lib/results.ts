// The two result pages. /🔑/<result> lists a 口令's matches, read from the
// server's redemption record (only its owner can open it; the 口令 itself is
// never in the address or in storage). /💬/<topic>/<post>: the 红包 linked
// to a post.

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
