// 我的提交 (docs/redesign/05-hongbao.md §3): a claimant's own judged
// submissions on a 代码判定红包, what they typed and what the code said,
// to look back on. Only theirs, never anyone else's.
import {
  formatSignedAmount,
  type JudgeNote,
  type MyJudgmentList,
} from "@hb/contracts";
import { attemptAssociatedData } from "../activities/claim-service";
import { activityNotFound } from "../activities/errors";
import { findActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";

export const MY_JUDGMENTS_PAGE = 20;

export async function myJudgments(
  env: ApiBindings,
  activityId: string,
  userId: string,
  /** Older than this 第 N 次. */
  before: number | null,
): Promise<MyJudgmentList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    activity.openedAt === null ||
    activity.participationMode !== "code"
  )
    activityNotFound();
  const [found, total] = await Promise.all([
    env.DB.prepare(`SELECT j.submission_row_id AS rowId, j.attempt, j.judged_at AS at,
        j.paid_minor AS paid, j.note, j.message, e.ciphertext
      FROM code_judgments j JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
      WHERE j.activity_id = ? AND j.user_id = ? AND j.attempt < ?
      ORDER BY j.attempt DESC LIMIT ?`)
      .bind(
        activityId,
        userId,
        before === null ? Number.MAX_SAFE_INTEGER : before - 1,
        MY_JUDGMENTS_PAGE + 1,
      )
      .all<{
        rowId: string;
        attempt: number;
        at: number;
        paid: number | null;
        note: JudgeNote | null;
        message: string | null;
        ciphertext: string;
      }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM code_judgments WHERE activity_id = ? AND user_id = ?",
    )
      .bind(activityId, userId)
      .first<{ count: number }>(),
  ]);
  const rows = found.results.slice(0, MY_JUDGMENTS_PAGE);
  const items = await Promise.all(
    rows.map(async (row) => ({
      attempt: row.attempt + 1,
      at: new Date(row.at).toISOString(),
      input: await decryptString(
        row.ciphertext,
        env,
        attemptAssociatedData(activityId, row.rowId),
      ),
      ...(row.message ? { message: row.message } : {}),
      ...(row.paid !== null ? { amount: formatSignedAmount(row.paid) } : {}),
      ...(row.note ? { note: row.note } : {}),
    })),
  );
  const last = items.at(-1);
  return {
    items,
    total: total?.count ?? 0,
    nextCursor:
      found.results.length > MY_JUDGMENTS_PAGE && last
        ? String(last.attempt)
        : null,
  };
}
