// 施工中 (docs/roadmap-design.md): what the 站长 is building, what is done,
// what people asked for, and their votes. Anyone reads it; a signed-in
// person asks and votes; the 站长 runs it from 网站管理, each move kept for
// 操作记录 (roadmap_changes).
import type {
  RoadmapAdminAction,
  RoadmapCreateInput,
  RoadmapDetail,
  RoadmapItem,
  RoadmapList,
  RoadmapRequestInput,
  RoadmapStatus,
  RoadmapSummary,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import { isAdministrator } from "../admin/authorization";
import type { ApiBindings } from "../env";

export const ROADMAP_PAGE = 20;

type ItemRow = {
  id: string;
  status: RoadmapStatus | "merged";
  title: string;
  detail: string;
  authorId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  provider: string;
  externalId: string;
  reason: string | null;
  hidden: number;
  votes: number;
  startedAt: number | null;
  doneAt: number | null;
  createdAt: number;
  noteText: string | null;
  noteAt: number | null;
  voted: number;
};

/** Each with its asker, its latest line, and whether `?1` voted for it. */
const ITEM = `SELECT i.id, i.status, i.title, i.detail, i.author_id AS authorId,
    u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
    u.provider, u.external_id AS externalId, i.reason, i.hidden, i.votes,
    i.started_at AS startedAt, i.done_at AS doneAt, i.created_at AS createdAt,
    n.text AS noteText, n.created_at AS noteAt,
    EXISTS (SELECT 1 FROM roadmap_votes v WHERE v.item_id = i.id AND v.user_id = ?1) AS voted
  FROM roadmap_items i JOIN users u ON u.id = i.author_id
  LEFT JOIN roadmap_notes n ON n.id = (SELECT id FROM roadmap_notes
    WHERE item_id = i.id ORDER BY created_at DESC, id DESC LIMIT 1)`;

const iso = (at: number | null) =>
  at === null ? null : new Date(at).toISOString();

function itemOf(
  env: ApiBindings,
  row: ItemRow,
  viewerId: string | null,
  admin = false,
): RoadmapItem {
  return {
    id: row.id,
    status: row.status === "merged" ? "request" : row.status,
    title: row.title,
    detail: row.detail,
    author: {
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
    },
    byOwner: isAdministrator(env, row.provider, row.externalId),
    votes: row.votes,
    voted: row.voted === 1,
    mine: viewerId !== null && row.authorId === viewerId,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt: iso(row.startedAt),
    doneAt: iso(row.doneAt),
    reason: row.reason,
    note:
      row.noteText !== null && row.noteAt !== null
        ? { text: row.noteText, at: new Date(row.noteAt).toISOString() }
        : null,
    ...(admin ? { hidden: row.hidden === 1 } : {}),
  };
}

const notFound = () =>
  new ActivityError(404, "ROADMAP_NOT_FOUND", "没有找到这一件。");

/** The top of the page: all being built, and how many of the rest. */
export async function roadmapSummary(
  env: ApiBindings,
  viewerId: string | null,
): Promise<RoadmapSummary> {
  const [building, counts] = await Promise.all([
    env.DB.prepare(
      `${ITEM} WHERE i.status = 'building' AND i.hidden = 0
        ORDER BY i.started_at DESC, i.id DESC LIMIT 50`,
    )
      .bind(viewerId ?? "")
      .all<ItemRow>(),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS count FROM roadmap_items
        WHERE hidden = 0 AND status IN ('request', 'done', 'declined') GROUP BY status`,
    ).all<{ status: RoadmapStatus; count: number }>(),
  ]);
  const count = (status: RoadmapStatus) =>
    counts.results.find((row) => row.status === status)?.count ?? 0;
  return {
    building: building.results.map((row) => itemOf(env, row, viewerId)),
    counts: {
      request: count("request"),
      done: count("done"),
      declined: count("declined"),
    },
  };
}

type Order = { column: string; key: (row: ItemRow) => number };

/** How a list goes: 最热 (votes, then the newest), 最新, or done's date. */
function orderOf(status: RoadmapStatus, sort: "hot" | "new"): Order[] {
  if (status === "done")
    return [{ column: "i.done_at", key: (row) => row.doneAt ?? 0 }];
  if (status === "request" && sort === "hot")
    return [
      { column: "i.votes", key: (row) => row.votes },
      { column: "i.created_at", key: (row) => row.createdAt },
    ];
  return [{ column: "i.created_at", key: (row) => row.createdAt }];
}

/**
 * A list a page at a time (§2.2, §2.3): 功能请求 最热 or 最新, 已完成 by
 * when, 不做 by when asked; hidden and merged ones only for the 站长.
 */
export async function roadmapList(
  env: ApiBindings,
  viewerId: string | null,
  status: RoadmapStatus,
  sort: "hot" | "new",
  cursorText: string | null,
  admin = false,
): Promise<RoadmapList | null> {
  const order = orderOf(status, sort);
  // Past the last one: its keys, then its id, all descending.
  let cursor: { keys: number[]; id: string } | null = null;
  if (cursorText !== null) {
    const parts = cursorText.split(":");
    const id = parts.pop() ?? "";
    const keys = parts.map(Number);
    if (
      !/^[0-9a-f-]{36}$/.test(id) ||
      keys.length !== order.length ||
      keys.some((key) => !Number.isSafeInteger(key))
    )
      return null;
    cursor = { keys, id };
  }
  const columns = [...order.map((item) => item.column), "i.id"];
  // (a, b, id) < (x, y, z), written out for SQLite.
  const after = cursor
    ? ` AND (${columns
        .map((column, index) =>
          [
            ...columns
              .slice(0, index)
              .map((before, at) => `${before} = ?${at + 3}`),
            `${column} < ?${index + 3}`,
          ].join(" AND "),
        )
        .map((clause) => `(${clause})`)
        .join(" OR ")})`
    : "";
  const found = await env.DB.prepare(
    `${ITEM} WHERE i.status = ?2${admin ? "" : " AND i.hidden = 0"}${after}
      ORDER BY ${columns.map((column) => `${column} DESC`).join(", ")}
      LIMIT ${ROADMAP_PAGE + 1}`,
  )
    .bind(
      viewerId ?? "",
      status,
      ...(cursor ? [...cursor.keys, cursor.id] : []),
    )
    .all<ItemRow>();
  const rows = found.results.slice(0, ROADMAP_PAGE);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => itemOf(env, row, viewerId, admin)),
    nextCursor:
      found.results.length > ROADMAP_PAGE && last
        ? [...order.map((item) => item.key(last)), last.id].join(":")
        : null,
  };
}

async function itemRow(env: ApiBindings, id: string, viewerId: string | null) {
  return env.DB.prepare(`${ITEM} WHERE i.id = ?2`)
    .bind(viewerId ?? "", id)
    .first<ItemRow>();
}

/** One, opened (§2.5): its lines, the newest first. Not hidden, not merged. */
export async function roadmapDetail(
  env: ApiBindings,
  viewerId: string | null,
  id: string,
): Promise<RoadmapDetail> {
  const [row, notes] = await Promise.all([
    itemRow(env, id, viewerId),
    env.DB.prepare(
      "SELECT text, created_at AS at FROM roadmap_notes WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
    )
      .bind(id)
      .all<{ text: string; at: number }>(),
  ]);
  if (!row || row.hidden === 1 || row.status === "merged") throw notFound();
  return {
    item: itemOf(env, row, viewerId),
    notes: notes.results.map((note) => ({
      text: note.text,
      at: new Date(note.at).toISOString(),
    })),
  };
}

/** Bigrams of a title, its own letters run together, to find the like. */
function bigrams(text: string) {
  const letters = Array.from(text.toLowerCase().replace(/[\s\p{P}]/gu, ""));
  const pairs = new Set<string>();
  for (let at = 0; at < letters.length - 1; at += 1)
    pairs.add(`${letters[at]}${letters[at + 1]}`);
  if (letters.length === 1 && letters[0]) pairs.add(letters[0]);
  return pairs;
}

/**
 * 可能已经有人提了 (§3): the three most like `q` of those asked for or
 * being built, by the share of letter pairs they have in common.
 */
export async function roadmapSimilar(
  env: ApiBindings,
  viewerId: string | null,
  q: string,
): Promise<RoadmapList> {
  const wanted = bigrams(q.slice(0, 40));
  if (wanted.size === 0) return { items: [], nextCursor: null };
  const found = await env.DB.prepare(
    `SELECT id, title FROM roadmap_items
      WHERE status IN ('request', 'building') AND hidden = 0
      ORDER BY created_at DESC LIMIT 500`,
  ).all<{ id: string; title: string }>();
  const scored = found.results
    .map((row) => {
      const have = bigrams(row.title);
      let common = 0;
      for (const pair of wanted) if (have.has(pair)) common += 1;
      return { id: row.id, score: common / Math.max(wanted.size, have.size) };
    })
    .filter((row) => row.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const rows = await Promise.all(
    scored.map((row) => itemRow(env, row.id, viewerId)),
  );
  return {
    items: rows.flatMap((row) => (row ? [itemOf(env, row, viewerId)] : [])),
    nextCursor: null,
  };
}

/** 提一个需求 (§3): theirs, with their own vote on it. */
export async function createRequest(
  env: ApiBindings,
  userId: string,
  input: RoadmapRequestInput,
): Promise<RoadmapItem> {
  const silenced = await env.DB.prepare(
    "SELECT silenced FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<number | null>("silenced");
  if (silenced === 1)
    throw new ActivityError(
      403,
      "ROADMAP_SILENCED",
      "你的账号现在不能提需求。",
    );
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roadmap_items (id, status, title, detail, author_id, votes, created_at, updated_at)
        VALUES (?, 'request', ?, ?, ?, 1, ?, ?)`,
    ).bind(id, input.title, input.detail, userId, now, now),
    env.DB.prepare(
      "INSERT INTO roadmap_votes (item_id, user_id, created_at) VALUES (?, ?, ?)",
    ).bind(id, userId, now),
  ]);
  const row = await itemRow(env, id, userId);
  if (!row) throw notFound();
  return itemOf(env, row, userId);
}

/** Theirs, not begun: changed or taken away (§2.5). */
async function ownRequest(env: ApiBindings, userId: string, id: string) {
  const row = await env.DB.prepare(
    "SELECT author_id AS authorId, status, hidden FROM roadmap_items WHERE id = ?",
  )
    .bind(id)
    .first<{ authorId: string; status: string; hidden: number }>();
  if (!row || row.hidden === 1 || row.authorId !== userId) throw notFound();
  if (row.status !== "request")
    throw new ActivityError(
      409,
      "ROADMAP_BEGUN",
      "站长已经处理过这个需求，不能再改。",
    );
}

export async function updateRequest(
  env: ApiBindings,
  userId: string,
  id: string,
  input: RoadmapRequestInput,
): Promise<RoadmapItem> {
  await ownRequest(env, userId, id);
  await env.DB.prepare(
    "UPDATE roadmap_items SET title = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'request'",
  )
    .bind(input.title, input.detail, Date.now(), id)
    .run();
  const row = await itemRow(env, id, userId);
  if (!row) throw notFound();
  return itemOf(env, row, userId);
}

export async function deleteRequest(
  env: ApiBindings,
  userId: string,
  id: string,
) {
  await ownRequest(env, userId, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM roadmap_votes WHERE item_id = ?").bind(id),
    env.DB.prepare(
      "DELETE FROM roadmap_items WHERE id = ? AND status = 'request' AND NOT EXISTS (SELECT 1 FROM roadmap_changes WHERE item_id = ?)",
    ).bind(id, id),
  ]);
}

/**
 * 点赞 or take it back (§2.4), on one asked for or being built; the count
 * kept in the same batch. What it is now comes back.
 */
export async function vote(
  env: ApiBindings,
  userId: string,
  id: string,
  voted: boolean,
): Promise<{ votes: number; voted: boolean }> {
  const row = await env.DB.prepare(
    "SELECT status, hidden FROM roadmap_items WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string; hidden: number }>();
  if (!row || row.hidden === 1 || row.status === "merged") throw notFound();
  if (row.status !== "request" && row.status !== "building")
    throw new ActivityError(409, "ROADMAP_CLOSED", "这一件已经不能点赞了。");
  const now = Date.now();
  await env.DB.batch(
    voted
      ? [
          env.DB.prepare(
            "INSERT OR IGNORE INTO roadmap_votes (item_id, user_id, created_at) VALUES (?, ?, ?)",
          ).bind(id, userId, now),
          env.DB.prepare(
            "UPDATE roadmap_items SET votes = votes + changes() WHERE id = ?",
          ).bind(id),
        ]
      : [
          env.DB.prepare(
            "DELETE FROM roadmap_votes WHERE item_id = ? AND user_id = ?",
          ).bind(id, userId),
          env.DB.prepare(
            "UPDATE roadmap_items SET votes = votes - changes() WHERE id = ?",
          ).bind(id),
        ],
  );
  const now_ = await env.DB.prepare(
    `SELECT votes, EXISTS (SELECT 1 FROM roadmap_votes WHERE item_id = ?1 AND user_id = ?2) AS voted
      FROM roadmap_items WHERE id = ?1`,
  )
    .bind(id, userId)
    .first<{ votes: number; voted: number }>();
  return { votes: now_?.votes ?? 0, voted: now_?.voted === 1 };
}

const change = (
  env: ApiBindings,
  actorId: string,
  itemId: string,
  action: string,
  title: string,
  reason: string | null,
  at: number,
) =>
  env.DB.prepare(
    `INSERT INTO roadmap_changes (id, actor_user_id, item_id, action, title, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), actorId, itemId, action, title, reason, at);

/** 新建 (§4): the 站长's own, into 施工中 or 功能请求. */
export async function createItem(
  env: ApiBindings,
  adminId: string,
  input: RoadmapCreateInput,
): Promise<RoadmapItem> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO roadmap_items (id, status, title, detail, author_id, votes, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(
      id,
      input.status,
      input.title,
      input.detail,
      adminId,
      input.status === "building" ? now : null,
      now,
      now,
    ),
    change(env, adminId, id, "create", input.title, null, now),
  ]);
  const row = await itemRow(env, id, adminId);
  if (!row) throw notFound();
  return itemOf(env, row, adminId, true);
}

/** Which moves each status allows (§4). */
const allowed: Record<string, RoadmapAdminAction["action"][]> = {
  request: ["start", "decline", "merge", "hide", "unhide", "edit"],
  building: ["note", "done", "decline", "back", "hide", "unhide", "edit"],
  done: ["back", "hide", "unhide", "edit"],
  declined: ["back", "hide", "unhide", "edit"],
  merged: [],
};

/**
 * 网站管理 · 施工 (§4): one move on one, as its status allows, written with
 * its 操作记录 in one batch. The item as it is after.
 */
export async function adminAct(
  env: ApiBindings,
  adminId: string,
  id: string,
  input: RoadmapAdminAction,
): Promise<RoadmapItem> {
  const row = await env.DB.prepare(
    "SELECT status, title FROM roadmap_items WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string; title: string }>();
  if (!row) throw notFound();
  if (!allowed[row.status]?.includes(input.action))
    throw new ActivityError(
      409,
      "ROADMAP_STATUS",
      "这一件现在不能这样处理，刷新再看看。",
    );
  const now = Date.now();
  const update = (sql: string, ...values: unknown[]) =>
    env.DB.prepare(
      `UPDATE roadmap_items SET ${sql}, updated_at = ? WHERE id = ?`,
    ).bind(...values, now, id);
  const log = (reason: string | null = null, title = row.title) =>
    change(env, adminId, id, input.action, title, reason, now);
  switch (input.action) {
    case "start":
      await env.DB.batch([
        update("status = 'building', started_at = ?", now),
        log(),
      ]);
      break;
    case "note":
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO roadmap_notes (id, item_id, text, created_at) VALUES (?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), id, input.text, now),
        update("title = title"),
        log(input.text),
      ]);
      break;
    case "done":
      await env.DB.batch([update("status = 'done', done_at = ?", now), log()]);
      break;
    case "decline":
      await env.DB.batch([
        update("status = 'declined', reason = ?", input.reason),
        log(input.reason),
      ]);
      break;
    case "back":
      await env.DB.batch([
        row.status === "done"
          ? update("status = 'building', done_at = NULL")
          : update("status = 'request', started_at = NULL, reason = NULL"),
        log(),
      ]);
      break;
    case "merge": {
      const into = await env.DB.prepare(
        "SELECT status, title FROM roadmap_items WHERE id = ?",
      )
        .bind(input.into)
        .first<{ status: string; title: string }>();
      if (
        !into ||
        input.into === id ||
        (into.status !== "request" && into.status !== "building")
      )
        throw new ActivityError(
          409,
          "ROADMAP_MERGE",
          "只能合并到另一件功能请求或施工中的。",
        );
      // Its votes go over, a person counted once; the count read again.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO roadmap_votes (item_id, user_id, created_at)
            SELECT ?, user_id, created_at FROM roadmap_votes WHERE item_id = ?`,
        ).bind(input.into, id),
        env.DB.prepare("DELETE FROM roadmap_votes WHERE item_id = ?").bind(id),
        env.DB.prepare(
          "UPDATE roadmap_items SET votes = (SELECT COUNT(*) FROM roadmap_votes WHERE item_id = ?1), updated_at = ?2 WHERE id = ?1",
        ).bind(input.into, now),
        update("status = 'merged', merged_into = ?, votes = 0", input.into),
        log(into.title),
      ]);
      break;
    }
    case "hide":
      await env.DB.batch([update("hidden = 1"), log()]);
      break;
    case "unhide":
      await env.DB.batch([update("hidden = 0"), log()]);
      break;
    case "edit":
      await env.DB.batch([
        update("title = ?, detail = ?", input.title, input.detail),
        log(null, input.title),
      ]);
      break;
  }
  const after = await itemRow(env, id, adminId);
  if (!after) throw notFound();
  return itemOf(env, after, adminId, true);
}

/** 网站管理 · 施工's counts a status (hidden ones too). */
export async function adminCounts(env: ApiBindings) {
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM roadmap_items WHERE status != 'merged' GROUP BY status",
  ).all<{ status: RoadmapStatus; count: number }>();
  const count = (status: RoadmapStatus) =>
    counts.results.find((row) => row.status === status)?.count ?? 0;
  return {
    request: count("request"),
    building: count("building"),
    done: count("done"),
    declined: count("declined"),
  };
}
