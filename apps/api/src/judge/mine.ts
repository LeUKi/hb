// 我的记录 (docs/redesign/05-hongbao.md §3; multi-prize §4.1): a claimant's
// own judged submissions on a 代码判定红包, what they typed and what the code
// said, to look back on, and once it is over what its requests got back
// (联网, §9.4); on protocol 5 also others' judgments that moved them, whose
// and what it told them. Never what anyone else typed.
import {
  formatSignedAmount,
  type JudgeNote,
  type MyJudgment,
  type MyJudgmentList,
} from "@hb/contracts";
import { attemptAssociatedData } from "../activities/claim-service";
import { activityNotFound } from "../activities/errors";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { isOver } from "./public";
import { fetchesOf } from "./storage";

export const MY_JUDGMENTS_PAGE = 20;

/** Where a page ended: its time, place in the judgment and the row. */
export type MyJudgmentCursor = { at: number; position: number; rowId: string };

export function myJudgmentCursor(cursor: string): MyJudgmentCursor | null {
  const found = /^(\d{1,15})-(\d{1,2})-([\w-]{1,64})$/.exec(cursor);
  return found
    ? {
        at: Number(found[1]),
        position: Number(found[2]),
        rowId: found[3] ?? "",
      }
    : null;
}

export async function myJudgments(
  env: ApiBindings,
  activityId: string,
  userId: string,
  /** Older than this one (the cursor). */
  before: MyJudgmentCursor | null,
): Promise<MyJudgmentList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    activity.openedAt === null ||
    activity.participationMode !== "code"
  )
    activityNotFound();
  // Their own judgments and others' moves on them (protocol 5), by time.
  const [found, total] = await Promise.all([
    env.DB.prepare(`SELECT * FROM (
        SELECT j.submission_row_id AS rowId, 0 AS position, j.judged_at AS at, j.attempt,
          NULL AS byName, j.paid_minor AS paid, j.note, j.message, e.ciphertext,
          j.fetches_ciphertext AS fetchesCiphertext,
          m.before_minor AS moveBefore, m.after_minor AS moveAfter, m.settles AS moveSettles
        FROM code_judgments j JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
        LEFT JOIN code_judgment_moves m ON m.submission_row_id = j.submission_row_id AND m.position = 0
        WHERE j.activity_id = ? AND j.user_id = ?
        UNION ALL
        SELECT m.submission_row_id, m.position, m.created_at, j.attempt,
          COALESCE(NULLIF(u.display_name, ''), j.username), NULL, NULL, m.message, NULL, NULL,
          m.before_minor, m.after_minor, m.settles
        FROM code_judgment_moves m JOIN code_judgments j ON j.submission_row_id = m.submission_row_id
        LEFT JOIN users u ON u.id = j.user_id
        WHERE m.activity_id = ? AND m.user_id = ? AND m.position > 0
      ) WHERE (at, position, rowId) < (?, ?, ?)
      ORDER BY at DESC, position DESC, rowId DESC LIMIT ?`)
      .bind(
        activityId,
        userId,
        activityId,
        userId,
        before?.at ?? Number.MAX_SAFE_INTEGER,
        before?.position ?? 0,
        before?.rowId ?? "",
        MY_JUDGMENTS_PAGE + 1,
      )
      .all<{
        rowId: string;
        position: number;
        at: number;
        attempt: number;
        byName: string | null;
        paid: number | null;
        note: JudgeNote | null;
        message: string | null;
        ciphertext: string | null;
        fetchesCiphertext: string | null;
        moveBefore: number | null;
        moveAfter: number | null;
        moveSettles: number | null;
      }>(),
    env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM code_judgments WHERE activity_id = ? AND user_id = ?) AS attempts,
        (SELECT COUNT(*) FROM code_judgment_moves WHERE activity_id = ? AND user_id = ? AND position > 0) AS moves`,
    )
      .bind(activityId, userId, activityId, userId)
      .first<{ attempts: number; moves: number }>(),
  ]);
  const rows = found.results.slice(0, MY_JUDGMENTS_PAGE);
  // What came back, not what was asked (it may hold the sender's token).
  const over = isOver(activity);
  const answersOf = async (row: (typeof rows)[number]) =>
    (await fetchesOf(env, activityId, row.rowId, row.fetchesCiphertext)).map(
      (fetched) => ({
        host: new URL(fetched.url).hostname,
        ...(fetched.status !== undefined ? { status: fetched.status } : {}),
        ...(fetched.response !== undefined
          ? { response: fetched.response }
          : {}),
        ...(fetched.error ? { error: fetched.error } : {}),
      }),
    );
  // Protocol 5: what it moved, and how much when it settled them with money.
  const movedOf = (before: number, after: number, settles: boolean) => ({
    moved: {
      added: formatSignedAmount(after - before),
      pending: formatSignedAmount(after),
      settled: settles,
    },
    ...(settles && after > 0 ? { amount: formatSignedAmount(after) } : {}),
  });
  const items = await Promise.all(
    rows.map(async (row): Promise<MyJudgment> => {
      const at = new Date(row.at).toISOString();
      const moved =
        row.moveBefore !== null && row.moveAfter !== null
          ? movedOf(row.moveBefore, row.moveAfter, row.moveSettles === 1)
          : null;
      if (row.byName !== null && moved)
        return {
          attempt: row.attempt + 1,
          at,
          by: { name: row.byName },
          ...(row.message ? { message: row.message } : {}),
          ...moved,
        };
      return {
        attempt: row.attempt + 1,
        at,
        input: await decryptString(
          row.ciphertext ?? "",
          env,
          attemptAssociatedData(activityId, row.rowId),
        ),
        ...(row.message ? { message: row.message } : {}),
        ...(row.paid !== null ? { amount: formatSignedAmount(row.paid) } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...moved,
        ...(over && row.fetchesCiphertext !== null
          ? { fetches: await answersOf(row) }
          : {}),
      };
    }),
  );
  const last = rows.at(-1);
  return {
    items,
    total: (total?.attempts ?? 0) + (total?.moves ?? 0),
    attempts: total?.attempts ?? 0,
    nextCursor:
      found.results.length > MY_JUDGMENTS_PAGE && last
        ? `${last.at}-${last.position}-${last.rowId}`
        : null,
  };
}
