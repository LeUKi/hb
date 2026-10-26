import {
  formatAmount,
  RANK_LIST_LIMIT,
  RANK_PAGE_SIZE,
  RANK_SNAPSHOT_MS,
  RANK_VISIBLE_BY_DEFAULT,
  RANK_WEEK_MS,
  type RankBoard,
  type RankEntry,
  type RankPage,
  type RankRange,
  type RankVisibility,
} from "@hb/contracts";
import {
  claimAmount,
  claimJoins,
  othersOnly,
} from "../activities/registration-queries";
import type { ApiBindings } from "../env";

// 排行榜 (docs/leaderboard-design.md §1–§3): each board's order is a
// snapshot kept for 5 minutes; who is shown is decided at each read, so a
// changed switch counts at once.

/** userId, amount in cents, 红包, times: best first. */
type Entry = [string, number, number, number];
type Snapshot = { computedAt: number; entries: Entry[] };

/** 发出 adds up by the sender, 领到 by the one who took it. */
const byWhom: Record<RankBoard, string> = {
  sent: "a.author_id",
  received: "c.user_id",
};

const visibleColumn: Record<RankBoard, string> = {
  sent: "rank_sent_visible",
  received: "rank_received_visible",
};

async function compute(
  env: ApiBindings,
  board: RankBoard,
  range: RankRange,
  now: number,
): Promise<Entry[]> {
  const who = byWhom[board];
  const rows = await env.DB.prepare(`SELECT ${who} AS user_id,
      SUM(${claimAmount}) AS amount,
      COUNT(DISTINCT c.activity_id) AS activities,
      COUNT(*) AS claims
    ${claimJoins}
    WHERE a.reward_type='ldc' AND a.deleted_at IS NULL AND ${othersOnly} AND c.claimed_at>=?
    GROUP BY ${who} HAVING amount>0
    ORDER BY amount DESC, claims DESC, user_id`)
    .bind(range === "week" ? now - RANK_WEEK_MS : 0)
    .all<{
      user_id: string;
      amount: number;
      activities: number;
      claims: number;
    }>();
  return rows.results.map((row) => [
    row.user_id,
    row.amount,
    row.activities,
    row.claims,
  ]);
}

/** The board as of at most 5 minutes ago, worked out again if older. */
async function snapshot(
  env: ApiBindings,
  board: RankBoard,
  range: RankRange,
  now: number,
): Promise<Snapshot> {
  const kept = await env.DB.prepare(
    "SELECT computed_at,entries FROM rank_snapshots WHERE board=? AND range=?",
  )
    .bind(board, range)
    .first<{ computed_at: number; entries: string }>();
  if (kept && now - kept.computed_at < RANK_SNAPSHOT_MS)
    return {
      computedAt: kept.computed_at,
      entries: JSON.parse(kept.entries) as Entry[],
    };
  const entries = await compute(env, board, range, now);
  // Two readers at once both work it out; the later one is kept.
  await env.DB.prepare(
    `INSERT INTO rank_snapshots (board,range,computed_at,entries) VALUES (?,?,?,?)
    ON CONFLICT(board,range) DO UPDATE SET computed_at=excluded.computed_at,entries=excluded.entries
    WHERE excluded.computed_at>rank_snapshots.computed_at`,
  )
    .bind(board, range, now, JSON.stringify(entries))
    .run();
  return { computedAt: now, entries };
}

/** 第 N 名 for each place: the same amount, the same rank (1, 2, 2, 4). */
function ranksOf(entries: Entry[]) {
  const ranks: number[] = [];
  for (const [index, entry] of entries.entries()) {
    const before = entries[index - 1];
    ranks.push(
      before && before[1] === entry[1] ? (ranks[index - 1] ?? 1) : index + 1,
    );
  }
  return ranks;
}

const shown = (value: number | null | undefined, board: RankBoard) =>
  value === null || value === undefined
    ? RANK_VISIBLE_BY_DEFAULT[board]
    : value === 1;

export async function rankPage(
  env: ApiBindings,
  query: { board: RankBoard; range: RankRange; cursor?: string },
  viewerId: string | null,
  now = Date.now(),
): Promise<RankPage> {
  const { board, range } = query;
  const { computedAt, entries } = await snapshot(env, board, range, now);
  const ranks = ranksOf(entries);
  // The first 100 are listed; the rest still count for `total` and `me`.
  const listed = Math.min(entries.length, RANK_LIST_LIMIT);
  const start = Math.min(Number(query.cursor ?? 0), listed);
  const end = Math.min(start + RANK_PAGE_SIZE, listed);
  const slice = entries.slice(start, end);
  const ids = [...new Set([...slice.map(([id]) => id), viewerId ?? ""])];
  const people = new Map(
    (
      await env.DB.prepare(
        `SELECT id,username,display_name,avatar_url,${visibleColumn[board]} AS visible
        FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<{
          id: string;
          username: string;
          display_name: string;
          avatar_url: string | null;
          visible: number | null;
        }>()
    ).results.map((row) => [row.id, row]),
  );
  const items: RankEntry[] = slice.map(
    ([id, amount, activities, claims], index) => {
      const person = people.get(id);
      return {
        position: start + index,
        rank: ranks[start + index] ?? start + index + 1,
        // 匿名: nothing that says who, not even the id.
        person:
          person && shown(person.visible, board)
            ? {
                username: person.username,
                displayName: person.display_name,
                avatarUrl: person.avatar_url,
              }
            : null,
        me: id === viewerId,
        amount: formatAmount(amount),
        activities,
        claims,
      };
    },
  );
  const viewer = viewerId ? people.get(viewerId) : undefined;
  const position = viewerId ? entries.findIndex(([id]) => id === viewerId) : -1;
  const mine = entries[position];
  return {
    board,
    range,
    computedAt,
    total: entries.length,
    items,
    nextCursor: end < listed ? String(end) : null,
    me: viewerId
      ? {
          rank: mine ? (ranks[position] ?? position + 1) : null,
          position: mine ? position : null,
          amount: formatAmount(mine?.[1] ?? 0),
          activities: mine?.[2] ?? 0,
          claims: mine?.[3] ?? 0,
          visible: shown(viewer?.visible, board),
        }
      : null,
  };
}

export async function rankVisibility(
  env: ApiBindings,
  userId: string,
): Promise<RankVisibility> {
  const row = await env.DB.prepare(
    "SELECT rank_sent_visible,rank_received_visible FROM users WHERE id=?",
  )
    .bind(userId)
    .first<{
      rank_sent_visible: number | null;
      rank_received_visible: number | null;
    }>();
  return {
    sent: shown(row?.rank_sent_visible, "sent"),
    received: shown(row?.rank_received_visible, "received"),
  };
}

export async function setRankVisibility(
  env: ApiBindings,
  userId: string,
  board: RankBoard,
  visible: boolean,
) {
  await env.DB.prepare(`UPDATE users SET ${visibleColumn[board]}=? WHERE id=?`)
    .bind(visible ? 1 : 0, userId)
    .run();
  return rankVisibility(env, userId);
}
