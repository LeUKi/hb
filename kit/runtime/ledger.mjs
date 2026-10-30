// Protocol 5's money (docs/multi-prize-design.md §2, §3): each person in a
// 红包 has pending, added to and taken from by judgments and settled once.
// The site and the kit (scenario.mjs) move it alike through here.

/**
 * Whom a judgment's `others` may name (§3.3): people judged in this 红包,
 * not settled, within its claim scope, never the one judged now (`self`).
 * `standing(id)` says of each "unknown" (never judged here), "settled",
 * "out" (outside the scope; the site's to know) or null when they may be
 * named. The first problem, in words, or null.
 */
export function othersProblem(others, self, standing) {
  for (const [index, other] of others.entries()) {
    const where = `others 第 ${index + 1} 项（${other.id}）`;
    if (other.id === self)
      return `${where}是这次提交的人自己：给他的写在 add、settle、player 里`;
    const why = standing(other.id);
    if (why === "unknown") return `${where}没有在这个红包里被判定过`;
    if (why === "settled") return `${where}已经结算了`;
    if (why === "out") return `${where}不在这个红包的领取范围以内`;
  }
  return null;
}

/**
 * One judgment's adds, moved (§2): the one judged first, then others in
 * the order written. Each is pulled so that pending stays at least 0 and
 * takes no more than is unclaimed; what is taken off goes back to it.
 * `moves` are `{ id, pending, add }`; the answer has each one's pending
 * after and what is unclaimed after. Nothing is paid here: settling moves
 * pending to paid, and leaves what is unclaimed as it is.
 */
export function moveMoney(unclaimed, moves) {
  let left = unclaimed;
  const after = moves.map(({ id, pending, add }) => {
    const next = Math.min(pending + left, Math.max(0, pending + add));
    left -= next - pending;
    return { id, before: pending, after: next };
  });
  return { moves: after, unclaimed: left };
}
