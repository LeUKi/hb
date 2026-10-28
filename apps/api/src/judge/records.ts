// A 代码判定红包's records, for its sender only (docs/programmable-hongbao-
// design.md §6, redesign/07 §6): the judgments the code failed, and the
// full records to replay with the kit. What each claim typed and both
// amounts are in the roster (claim-queries.ts).
import {
  type CodeFailureList,
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
import { declarationsFor, judgedParams } from "./params";
import { publicJudge } from "./public";
import { fetchesOf, findJudgeRow, judgeData } from "./storage";

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
  fetchesCiphertext: string | null;
  at: number;
  externalId: string;
  displayName: string;
  avatarUrl: string | null;
  ciphertext: string;
  claimedAt: number | null;
};

const JUDGMENTS = `SELECT j.submission_row_id AS rowId, j.sequence, j.attempt, j.title, j.username, j.level,
    j.ok, j.asked_minor AS asked, j.paid_minor AS paid, j.note, j.message, j.state_ciphertext AS stateCiphertext,
    j.fetches_ciphertext AS fetchesCiphertext,
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
      const fetches = await fetchesOf(
        env,
        activity.id,
        row.rowId,
        row.fetchesCiphertext,
      );
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
        ...(fetches.length > 0 ? { fetches } : {}),
      };
    }),
  );
  // 协议第三版: what it was sent with, and the secret ones' seal (§3).
  const params = judge.protocol >= 3 ? await judgedParams(env, judge) : null;
  return {
    // The protocol it opened with: what a replay runs (§4.7).
    protocol: judge.protocol,
    ...(params ? { params } : {}),
    ...(judge.paramsCommitment && open?.sealedParams
      ? {
          paramsSealed: {
            keys: (
              (await declarationsFor(env, activity.authorId, judge))?.params ??
              []
            )
              .filter((param) => param.secret)
              .map((param) => param.key),
            commitment: judge.paramsCommitment,
            salt: open.sealedParams.salt ?? null,
          },
        }
      : {}),
    ...(judge.network !== null
      ? { network: JSON.parse(judge.network) as string[] }
      : {}),
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
