// 判定记录 (docs/judge-records-design.md): a 代码判定红包's judgments for its
// sender only, along a timeline with the failed ones among them, person by
// person (code_judge_people), and one person's whole record. What each
// typed is decrypted here as for 我的提交 (mine.ts); none of it is public.
import {
  formatAmount,
  formatSignedAmount,
  type JudgeNote,
  type JudgeRecordFacts,
  type JudgeRecordFilter,
  type JudgeRecordList,
  type JudgeRecordPeople,
  type JudgeRecordPeopleSort,
  type JudgeRecordRow,
} from "@hb/contracts";
import { attemptAssociatedData } from "../activities/claim-service";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { ownedCode } from "./records";

export const JUDGE_RECORDS_PAGE = 20;

type JudgedRow = {
  rowId: string;
  sequence: number;
  attempt: number;
  at: number;
  userId: string;
  username: string;
  level: number | null;
  displayName: string;
  avatarUrl: string | null;
  ok: number;
  asked: number | null;
  paid: number | null;
  note: JudgeNote | null;
  message: string | null;
  ends: number;
  announce: string | null;
  ciphertext: string;
  /** Protocol 5: the one judged's move (code_judgment_moves, position 0). */
  moveBefore: number | null;
  moveAfter: number | null;
  moveSettles: number | null;
};

type FailedRow = {
  id: string;
  at: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  kind: Extract<JudgeRecordRow, { kind: "failed" }>["failure"];
  detail: string;
};

const JUDGED = `SELECT j.submission_row_id AS rowId, j.sequence, j.attempt, j.judged_at AS at,
    j.user_id AS userId, j.username, j.level, u.display_name AS displayName, u.avatar_url AS avatarUrl,
    j.ok, j.asked_minor AS asked, j.paid_minor AS paid, j.note, j.message, j.ends,
    a.text AS announce, e.ciphertext, m.before_minor AS moveBefore, m.after_minor AS moveAfter,
    m.settles AS moveSettles
  FROM code_judgments j
  JOIN users u ON u.id = j.user_id
  JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
  LEFT JOIN activity_announcements a ON a.submission_row_id = j.submission_row_id
  LEFT JOIN code_judgment_moves m ON m.submission_row_id = j.submission_row_id AND m.position = 0`;

/** A judgment that paid the one judged: a share, or (protocol 5) settling them with money. */
const PAID = `(j.ok = 1 OR EXISTS(SELECT 1 FROM code_judgment_moves paid WHERE paid.submission_row_id = j.submission_row_id
  AND paid.position = 0 AND paid.settles = 1 AND paid.after_minor > 0))`;

const FAILED = `SELECT f.id, f.created_at AS at, f.user_id AS userId, u.username,
    u.display_name AS displayName, u.avatar_url AS avatarUrl, f.kind, f.detail
  FROM code_failures f JOIN users u ON u.id = f.user_id`;

async function judgedRow(
  env: ApiBindings,
  activityId: string,
  row: JudgedRow,
): Promise<JudgeRecordRow> {
  const pulled = row.ok === 1 && row.note !== null;
  // Protocol 5: what it moved, and settled with, when it did.
  const moved =
    row.moveAfter === null || row.moveBefore === null
      ? null
      : {
          // Signed: protocol 5 takes off too (formatAmount refuses it).
          added: formatSignedAmount(row.moveAfter - row.moveBefore),
          pending: formatAmount(row.moveAfter),
          settled: row.moveSettles === 1,
        };
  const paid =
    row.paid ?? (moved?.settled && row.moveAfter ? row.moveAfter : null);
  return {
    kind: "judged",
    at: new Date(row.at).toISOString(),
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      level: row.level,
    },
    attempt: row.attempt + 1,
    input: await decryptString(
      row.ciphertext,
      env,
      attemptAssociatedData(activityId, row.rowId),
    ),
    claimed: paid !== null,
    ...(paid !== null ? { amount: formatAmount(paid) } : {}),
    ...(pulled && row.asked !== null ? { asked: formatAmount(row.asked) } : {}),
    ...(pulled && row.note ? { note: row.note } : {}),
    ...(moved ? { moved } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.announce ? { announce: row.announce } : {}),
    ...(row.ends === 1 ? { ends: true as const } : {}),
  };
}

const failedRow = (row: FailedRow, level: number | null): JudgeRecordRow => ({
  kind: "failed",
  at: new Date(row.at).toISOString(),
  user: {
    id: row.userId,
    username: row.username,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    level,
  },
  failure: row.kind,
  detail: row.detail,
});

/**
 * Where a page ended, each side its own: judgments by sequence (or, for
 * one person, by 第 N 次), failures by time and id. null: not begun;
 * "done": nothing left. Written j<n|*|->.f<at:id|*|->.
 */
type Cursor = {
  judged: number | null | "done";
  failed: { at: number; id: string } | null | "done";
};

function readCursor(value: string | null): Cursor | null {
  if (value === null) return { judged: null, failed: null };
  const match =
    /^j(\d{1,9}|\*|-)\.f(?:(\d{1,15}):([0-9a-f-]{36})|(\*|-))$/.exec(value);
  if (!match) return null;
  return {
    judged:
      match[1] === "-" ? "done" : match[1] === "*" ? null : Number(match[1]),
    failed:
      match[2] && match[3]
        ? { at: Number(match[2]), id: match[3] }
        : match[4] === "-"
          ? "done"
          : null,
  };
}

function writeCursor(cursor: Cursor): string | null {
  if (cursor.judged === "done" && cursor.failed === "done") return null;
  const judged =
    cursor.judged === "done"
      ? "-"
      : cursor.judged === null
        ? "*"
        : String(cursor.judged);
  const failed =
    cursor.failed === "done"
      ? "-"
      : cursor.failed === null
        ? "*"
        : `${cursor.failed.at}:${cursor.failed.id}`;
  return `j${judged}.f${failed}`;
}

/**
 * The two sides merged by time into one page, and where each now stands:
 * a side is done once it gave all it had and all of it was taken.
 */
function mergePage(
  cursor: Cursor,
  judgedRows: JudgedRow[] | null,
  failedRows: FailedRow[] | null,
  order: "newest" | "oldest",
  judgedKey: (row: JudgedRow) => number,
) {
  const page = JUDGE_RECORDS_PAGE;
  const merged = [
    ...(judgedRows ?? []).map((row) => ({ at: row.at, judged: row })),
    ...(failedRows ?? []).map((row) => ({ at: row.at, failed: row })),
  ]
    .sort((a, b) => (order === "newest" ? b.at - a.at : a.at - b.at))
    .slice(0, page);
  const takenJudged = merged.flatMap((item) =>
    "judged" in item ? [item.judged] : [],
  );
  const takenFailed = merged.flatMap((item) =>
    "failed" in item ? [item.failed] : [],
  );
  const lastJudged = takenJudged.at(-1);
  const lastFailed = takenFailed.at(-1);
  const next: Cursor = {
    judged:
      judgedRows === null ||
      (judgedRows.length <= page && takenJudged.length === judgedRows.length)
        ? "done"
        : lastJudged
          ? judgedKey(lastJudged)
          : cursor.judged,
    failed:
      failedRows === null ||
      (failedRows.length <= page && takenFailed.length === failedRows.length)
        ? "done"
        : lastFailed
          ? { at: lastFailed.at, id: lastFailed.id }
          : cursor.failed,
  };
  return { merged, next };
}

/**
 * 时间线 (§1.1): judgments and failures together, the newest first, twenty
 * at a time; `filter` keeps shares, the rest, or failures only.
 */
export async function judgeTimeline(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  filter: JudgeRecordFilter,
  cursorText: string | null,
): Promise<JudgeRecordList | null> {
  await ownedCode(env, activityId, authorId);
  const cursor = readCursor(cursorText);
  if (!cursor) return null;
  const page = JUDGE_RECORDS_PAGE;
  const wantJudged = filter !== "failed" && cursor.judged !== "done";
  const wantFailed =
    (filter === "all" || filter === "failed") && cursor.failed !== "done";
  const okClause =
    filter === "claimed"
      ? ` AND ${PAID}`
      : filter === "unclaimed"
        ? ` AND NOT ${PAID}`
        : "";
  const before =
    cursor.failed && cursor.failed !== "done" ? cursor.failed : null;
  const [judged, failed] = await Promise.all([
    wantJudged
      ? env.DB.prepare(
          `${JUDGED} WHERE j.activity_id = ?1 AND j.sequence < ?2${okClause}
            ORDER BY j.sequence DESC LIMIT ?3`,
        )
          .bind(
            activityId,
            typeof cursor.judged === "number"
              ? cursor.judged
              : Number.MAX_SAFE_INTEGER,
            page + 1,
          )
          .all<JudgedRow>()
      : null,
    wantFailed
      ? env.DB.prepare(
          `${FAILED} WHERE f.activity_id = ?1
            AND (?2 IS NULL OR f.created_at < ?2 OR (f.created_at = ?2 AND f.id < ?3))
            ORDER BY f.created_at DESC, f.id DESC LIMIT ?4`,
        )
          .bind(activityId, before?.at ?? null, before?.id ?? null, page + 1)
          .all<FailedRow>()
      : null,
  ]);
  const { merged, next } = mergePage(
    cursor,
    judged?.results ?? null,
    failed?.results ?? null,
    "newest",
    (row) => row.sequence,
  );
  // A person's 等级 for a failure: as a judgment of theirs here saw it.
  const levels = new Map(
    (judged?.results ?? []).map((row) => [row.userId, row.level]),
  );
  const items = await Promise.all(
    merged.map((item) =>
      "judged" in item
        ? judgedRow(env, activityId, item.judged)
        : failedRow(item.failed, levels.get(item.failed.userId) ?? null),
    ),
  );
  return { items, nextCursor: writeCursor(next) };
}

type PersonCursor = { value: number; at: number; userId: string };

const personCursor = (value: string | null): PersonCursor | null | "bad" => {
  if (value === null) return null;
  const match = /^(\d{1,15}):(\d{1,15}):([0-9a-f-]{36})$/.exec(value);
  return match?.[1] && match[2] && match[3]
    ? { value: Number(match[1]), at: Number(match[2]), userId: match[3] }
    : "bad";
};

/**
 * 按人 (§1.2): a page of people from code_judge_people, the latest judged
 * first, or the most judged, or those with a share first.
 */
export async function judgePeople(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  sort: JudgeRecordPeopleSort,
  cursorText: string | null,
): Promise<JudgeRecordPeople | null> {
  await ownedCode(env, activityId, authorId);
  const cursor = personCursor(cursorText);
  if (cursor === "bad") return null;
  // What orders them before the latest: 次数, or 领到 (1 before 0).
  const key =
    sort === "most" ? "p.judged" : sort === "claimed" ? "p.claimed" : null;
  const after = cursor
    ? key
      ? ` AND (${key} < ?2 OR (${key} = ?2 AND (p.last_at < ?3 OR (p.last_at = ?3 AND p.user_id < ?4))))`
      : " AND (p.last_at < ?3 OR (p.last_at = ?3 AND p.user_id < ?4))"
    : "";
  const found = await env.DB.prepare(
    `SELECT p.user_id AS userId, p.judged, p.claimed, p.paid_minor AS paid, p.last_at AS lastAt,
        p.pending_minor AS pending, p.settled_at AS settledAt,
        u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl
      FROM code_judge_people p JOIN users u ON u.id = p.user_id
      WHERE p.activity_id = ?1${after}
      ORDER BY ${key ? `${key} DESC, ` : ""}p.last_at DESC, p.user_id DESC LIMIT ?5`,
  )
    .bind(
      activityId,
      cursor?.value ?? null,
      cursor?.at ?? null,
      cursor?.userId ?? null,
      JUDGE_RECORDS_PAGE + 1,
    )
    .all<{
      userId: string;
      judged: number;
      claimed: number;
      paid: number | null;
      lastAt: number;
      pending: number;
      settledAt: number | null;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    }>();
  const rows = found.results.slice(0, JUDGE_RECORDS_PAGE);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => ({
      user: {
        id: row.userId,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      },
      judged: row.judged,
      ...(row.paid !== null ? { amount: formatAmount(row.paid) } : {}),
      ...(row.settledAt === null && row.pending > 0
        ? { pending: formatAmount(row.pending) }
        : {}),
      ...(row.settledAt !== null ? { settled: true as const } : {}),
      lastAt: new Date(row.lastAt).toISOString(),
    })),
    nextCursor:
      found.results.length > JUDGE_RECORDS_PAGE && last
        ? `${sort === "most" ? last.judged : sort === "claimed" ? last.claimed : 0}:${last.lastAt}:${last.userId}`
        : null,
  };
}

/**
 * One person's whole record (§1.2), the oldest first — how they got where
 * they did — failures in their place, twenty at a time.
 */
export async function judgePerson(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  userId: string,
  cursorText: string | null,
): Promise<JudgeRecordList | null> {
  await ownedCode(env, activityId, authorId);
  const cursor = readCursor(cursorText);
  if (!cursor) return null;
  const page = JUDGE_RECORDS_PAGE;
  const after =
    cursor.failed && cursor.failed !== "done" ? cursor.failed : null;
  const [judged, failed] = await Promise.all([
    cursor.judged === "done"
      ? null
      : env.DB.prepare(
          `${JUDGED} WHERE j.activity_id = ?1 AND j.user_id = ?2 AND j.attempt > ?3
            ORDER BY j.attempt LIMIT ?4`,
        )
          .bind(activityId, userId, cursor.judged ?? -1, page + 1)
          .all<JudgedRow>(),
    cursor.failed === "done"
      ? null
      : env.DB.prepare(
          `${FAILED} WHERE f.activity_id = ?1 AND f.user_id = ?2
            AND (?3 IS NULL OR f.created_at > ?3 OR (f.created_at = ?3 AND f.id > ?4))
            ORDER BY f.created_at, f.id LIMIT ?5`,
        )
          .bind(
            activityId,
            userId,
            after?.at ?? null,
            after?.id ?? null,
            page + 1,
          )
          .all<FailedRow>(),
  ]);
  const { merged, next } = mergePage(
    cursor,
    judged?.results ?? null,
    failed?.results ?? null,
    "oldest",
    (row) => row.attempt,
  );
  const level = judged?.results.at(-1)?.level ?? null;
  const items = await Promise.all(
    merged.map((item) =>
      "judged" in item
        ? judgedRow(env, activityId, item.judged)
        : failedRow(item.failed, level),
    ),
  );
  return { items, nextCursor: writeCursor(next) };
}

/** The numbers over it all (§1), from code_judge_people and its failures. */
export async function judgeRecordFacts(
  env: ApiBindings,
  activityId: string,
  authorId: string,
): Promise<JudgeRecordFacts> {
  await ownedCode(env, activityId, authorId);
  const [people, failed, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS people, COALESCE(SUM(judged), 0) AS judged,
        COALESCE(SUM(claimed), 0) AS claimedPeople, COALESCE(SUM(paid_minor), 0) AS paid
      FROM code_judge_people WHERE activity_id = ?`,
    )
      .bind(activityId)
      .first<{
        people: number;
        judged: number;
        claimedPeople: number;
        paid: number;
      }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM code_failures WHERE activity_id = ?",
    )
      .bind(activityId)
      .first<number>("count"),
    // Protocol 5: everyone's pending together.
    env.DB.prepare(
      "SELECT pending_minor FROM activity_code WHERE activity_id = ? AND protocol >= 5",
    )
      .bind(activityId)
      .first<number>("pending_minor"),
  ]);
  return {
    judged: people?.judged ?? 0,
    people: people?.people ?? 0,
    claimedPeople: people?.claimedPeople ?? 0,
    paid: formatAmount(people?.paid ?? 0),
    ...(pending !== null ? { pending: formatAmount(pending) } : {}),
    failed: failed ?? 0,
  };
}
