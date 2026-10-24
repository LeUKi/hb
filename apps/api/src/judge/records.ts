// A 代码判定红包's records, for its sender only (docs/programmable-hongbao-
// design.md §6): every judgment with what was typed and both amounts, the
// judgments the code failed, and the full records to replay with the kit.
import {
  type CodeFailureList,
  type CodeJudgment,
  type CodeJudgmentList,
  formatAmount,
  formatSignedAmount,
  type JudgeNote,
  type LdcActivityInput,
  ldcTotalMinor,
} from "@hb/contracts";
import type { Json, JudgeRecords } from "../../../../kit/judge";
import { attemptAssociatedData } from "../activities/claim-service";
import { ActivityError } from "../activities/errors";
import { type ActivityRow, ownedActivity } from "../activities/storage";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { publicJudge } from "./public";
import { JUDGE_PROTOCOL } from "./sandbox";
import { findJudgeRow, judgeData } from "./storage";

async function ownedCode(
  env: ApiBindings,
  activityId: string,
  authorId: string,
) {
  const activity = await ownedActivity(env, activityId, authorId);
  if (activity.participationMode !== "code")
    throw new ActivityError(
      404,
      "NOT_CODE_HONGBAO",
      "这个红包不是代码判定红包。",
    );
  return activity;
}

type JudgmentRow = {
  rowId: string;
  sequence: number;
  attempt: number;
  title: string;
  username: string;
  level: number | null;
  ok: number;
  asked: number | null;
  paid: number | null;
  note: JudgeNote | null;
  message: string | null;
  stateCiphertext: string | null;
  at: number;
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  ciphertext: string;
  claimedAt: number | null;
};

const JUDGMENTS = `SELECT j.submission_row_id AS rowId, j.sequence, j.attempt, j.title, j.username, j.level,
    j.ok, j.asked_minor AS asked, j.paid_minor AS paid, j.note, j.message, j.state_ciphertext AS stateCiphertext,
    j.judged_at AS at, u.external_id AS externalId, u.display_name AS displayName, u.avatar_url AS avatarUrl,
    e.ciphertext, c.claimed_at AS claimedAt
  FROM code_judgments j JOIN users u ON u.id = j.user_id
  JOIN attempt_events e ON e.submission_row_id = j.submission_row_id
  JOIN redemption_submissions s ON s.id = j.submission_row_id
  LEFT JOIN claims c ON c.id = s.claim_id AND s.outcome = 'claimed'`;

const inputOf = (env: ApiBindings, activityId: string, row: JudgmentRow) =>
  decryptString(
    row.ciphertext,
    env,
    attemptAssociatedData(activityId, row.rowId),
  );

/** 判定记录: newest first, twenty a page. */
export async function listJudgments(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursor?: string,
): Promise<CodeJudgmentList> {
  await ownedCode(env, activityId, authorId);
  const before = cursor === undefined ? null : Number(cursor);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0))
    throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
  const rows = await env.DB.prepare(
    `${JUDGMENTS} WHERE j.activity_id = ? AND (? IS NULL OR j.sequence < ?) ORDER BY j.sequence DESC LIMIT 21`,
  )
    .bind(activityId, before, before)
    .all<JudgmentRow>();
  const page = rows.results.slice(0, 20);
  const items = await Promise.all(
    page.map(
      async (row): Promise<CodeJudgment> => ({
        sequence: row.sequence,
        at: new Date(row.at).toISOString(),
        user: {
          username: row.username,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
        },
        attempt: row.attempt,
        input: await inputOf(env, activityId, row),
        ok: row.ok === 1,
        ...(row.asked !== null ? { asked: formatSignedAmount(row.asked) } : {}),
        ...(row.paid !== null ? { paid: formatAmount(row.paid) } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.message ? { message: row.message } : {}),
        ...(row.claimedAt !== null ? { claimed: true as const } : {}),
      }),
    ),
  );
  return {
    items,
    nextCursor:
      rows.results.length > 20 && page.at(-1)
        ? String(page.at(-1)?.sequence)
        : null,
  };
}

/** 出错记录: the latest fifty, and where the count to a pause stands. */
export async function listFailures(
  env: ApiBindings,
  activityId: string,
  authorId: string,
): Promise<CodeFailureList> {
  await ownedCode(env, activityId, authorId);
  const [failures, judge] = await Promise.all([
    env.DB.prepare(`SELECT f.kind, f.detail, f.created_at AS at, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl
      FROM code_failures f JOIN users u ON u.id = f.user_id
      WHERE f.activity_id = ? ORDER BY f.created_at DESC, f.id DESC LIMIT 50`)
      .bind(activityId)
      .all<{
        kind: CodeFailureList["items"][number]["kind"];
        detail: string;
        at: number;
        username: string;
        displayName: string;
        avatarUrl: string | null;
      }>(),
    findJudgeRow(env, activityId),
  ]);
  return {
    items: failures.results.map((row) => ({
      at: new Date(row.at).toISOString(),
      kind: row.kind,
      detail: row.detail,
      user: {
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
      },
    })),
    failuresInRow: judge?.failuresInRow ?? 0,
    pausedAt:
      judge?.pausedAt == null ? null : new Date(judge.pausedAt).toISOString(),
  };
}

async function recordsOf(
  env: ApiBindings,
  activity: ActivityRow,
): Promise<JudgeRecords> {
  const [judge, open, rows] = await Promise.all([
    findJudgeRow(env, activity.id),
    publicJudge(env, activity),
    env.DB.prepare(`${JUDGMENTS} WHERE j.activity_id = ? ORDER BY j.sequence`)
      .bind(activity.id)
      .all<JudgmentRow>(),
  ]);
  if (!judge?.seedCommitment || activity.openedAt === null)
    throw new ActivityError(404, "NOT_OPENED", "红包开放之后才有领取记录。");
  const config = JSON.parse(activity.config) as LdcActivityInput;
  const judgments = await Promise.all(
    rows.results.map(async (row) => {
      const state =
        row.stateCiphertext === null
          ? undefined
          : (JSON.parse(
              await decryptString(
                row.stateCiphertext,
                env,
                `${judgeData(activity.id, "state")}:${row.rowId}`,
              ),
            ) as Json);
      return {
        at: row.at,
        input: await inputOf(env, activity.id, row),
        user: {
          id: Number(row.externalId),
          username: row.username,
          level: row.level as 0 | 1 | 2 | 3 | 4 | null,
          attempts: row.attempt,
        },
        title: row.title,
        verdict: {
          ok: row.ok === 1,
          ...(row.asked !== null ? { amount: row.asked } : {}),
          ...(row.message ? { message: row.message } : {}),
          ...(state !== undefined ? { state } : {}),
        },
        ...(row.paid !== null ? { paid: row.paid } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.claimedAt !== null ? { claimedAt: row.claimedAt } : {}),
      };
    }),
  );
  return {
    protocol: JUDGE_PROTOCOL,
    hongbao: {
      id: activity.id,
      total: ldcTotalMinor(config),
      count: activity.totalCount,
      minEach: judge.minEachMinor,
      openedAt: activity.openedAt,
      endsAt: activity.deadline ?? 0,
      fingerprint: judge.fingerprint,
      seedCommitment: judge.seedCommitment,
      seed: open?.seed ?? null,
    },
    judgments,
  };
}

/** 下载完整记录: every judgment as the code was given it. */
export async function judgeRecords(
  env: ApiBindings,
  activityId: string,
  authorId: string,
) {
  return recordsOf(env, await ownedCode(env, activityId, authorId));
}
