import type {
  ActivityPasswords,
  ClaimActivityInput,
  SolveResult,
} from "@hb/contracts";
import { CLAIM_WINDOW_MS } from "@hb/contracts";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activityPasswords } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import { findUserClaim } from "./claim-queries";
import {
  assertClaimRateLimit,
  attemptAssociatedData,
  bindFingerprint,
  claimAttemptLimit,
  findSubmission,
  type SubmissionRow,
} from "./claim-service";
import { ActivityError, activityNotFound } from "./errors";
import { databaseNow } from "./lifecycle";
import { activityStatus } from "./service";
import { findActivity, passwordAssociatedData } from "./storage";

/** Visibility is decided in the database snapshot, before any answer is decrypted. */
export async function getActivityPasswords(
  env: ApiBindings,
  activityId: string,
  viewerId?: string,
): Promise<ActivityPasswords> {
  const viewer = viewerId ?? "";
  const solved = `EXISTS (SELECT 1 FROM redemption_submissions s
    WHERE s.activity_id = p.activity_id AND s.user_id = ?
    AND s.purpose = 'solve' AND s.outcome = 'solved' AND s.matched_password_id = p.id)`;
  const [answers, metadata] = await env.DB.batch([
    env.DB.prepare(`SELECT p.id, p.ciphertext,
        CASE WHEN c.password_id = p.id THEN 1 ELSE 0 END AS isClaimPassword,
        CASE WHEN ${solved} THEN 1 ELSE 0 END AS isSolved
      FROM activity_passwords p JOIN activities a ON a.id = p.activity_id
      LEFT JOIN claims c ON c.activity_id = a.id AND c.user_id = ?
      WHERE a.id = ? AND a.deleted_at IS NULL AND (a.opened_at IS NOT NULL OR a.author_id = ?)
      AND (a.author_id = ? OR (a.opened_at IS NOT NULL AND
        (a.ended_at IS NOT NULL OR a.archived_at IS NOT NULL OR a.claimed_count >= a.total_count OR a.deadline <= ${databaseNow}))
        OR (c.id IS NOT NULL AND (c.password_id = p.id OR ${solved})))
      ORDER BY p.position`).bind(
      viewer,
      viewer,
      activityId,
      viewer,
      viewer,
      viewer,
    ),
    env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM activity_passwords WHERE activity_id = a.id) AS total,
        CASE WHEN a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.archived_at IS NULL
          AND a.claimed_count < a.total_count AND a.deadline > ${databaseNow}
          AND EXISTS (SELECT 1 FROM claims WHERE activity_id = a.id AND user_id = ?)
          THEN 1 ELSE 0 END AS canSolve
      FROM activities a WHERE a.id = ? AND a.deleted_at IS NULL
        AND (a.opened_at IS NOT NULL OR a.author_id = ?)`).bind(
      viewer,
      activityId,
      viewer,
    ),
  ]);
  const state = metadata?.results[0] as
    | { total: number; canSolve: number }
    | undefined;
  if (!state || !answers) activityNotFound();
  const rows = answers.results as {
    id: string;
    ciphertext: string;
    isClaimPassword: number;
    isSolved: number;
  }[];
  return {
    passwords: await Promise.all(
      rows.map(async (row) => ({
        text: await decryptString(
          row.ciphertext,
          env,
          passwordAssociatedData(activityId, row.id),
        ),
        isClaimPassword: row.isClaimPassword === 1,
        isSolved: row.isSolved === 1,
      })),
    ),
    hiddenCount: Math.max(0, state.total - rows.length),
    canSolve: state.canSolve === 1,
  };
}

function solveResult(submission: SubmissionRow): SolveResult {
  if (
    submission.purpose !== "solve" ||
    !["solved", "incorrect", "ended", "archived"].includes(submission.outcome)
  )
    throw new Error("Invalid completed password solve");
  return {
    outcome: submission.outcome as SolveResult["outcome"],
  };
}

async function registerEndedSolve(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  fingerprint: string,
  outcome: "ended" | "archived",
) {
  try {
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id, activity_id, user_id, submission_id, fingerprint, purpose, outcome, created_at, finished_at)
      SELECT ?, ?, ?, ?, ?, 'solve', ?, ${databaseNow}, ${databaseNow}
      WHERE EXISTS (SELECT 1 FROM activities WHERE id = ? AND deleted_at IS NULL)`)
      .bind(
        crypto.randomUUID(),
        activityId,
        userId,
        input.submissionId,
        fingerprint,
        outcome,
        activityId,
      )
      .run();
  } catch (error) {
    const winner = await findSubmission(env, userId, input.submissionId);
    if (!winner) throw error;
    return solveResult(bindFingerprint(winner, fingerprint, "solve"));
  }
  const row = await findSubmission(env, userId, input.submissionId);
  if (!row) {
    if (!(await findActivity(env, activityId))) activityNotFound();
    throw new Error("Ended password solve was not persisted");
  }
  return solveResult(bindFingerprint(row, fingerprint, "solve"));
}

/** A solve is always terminal; it never enters reward allocation or payment recovery. */
export async function solveActivityPassword(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
): Promise<SolveResult> {
  const fingerprint = await digestPassword(
    `solve-request:${activityId}:${input.password}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const passwordDigest = await digestPassword(
    input.password,
    env.PASSWORD_DIGEST_KEY,
  );
  for (let retry = 0; retry < 4; retry++) {
    const previous = await findSubmission(env, userId, input.submissionId);
    if (previous) {
      bindFingerprint(previous, fingerprint, "solve");
      if (!(await findActivity(env, activityId))) activityNotFound();
      return solveResult(previous);
    }
    const activity = await findActivity(env, activityId);
    if (
      !activity ||
      (activity.openedAt === null && activity.authorId !== userId)
    )
      activityNotFound();
    const status = activityStatus(activity);
    if (status === "draft")
      throw new ActivityError(400, "ACTIVITY_NOT_OPEN", "活动尚未开放");
    if (!(await findUserClaim(env, activityId, userId)))
      throw new ActivityError(
        403,
        "CLAIM_REQUIRED",
        "领取本活动奖励后才可继续验证其他口令",
      );
    if (status === "ended" || status === "archived")
      return registerEndedSolve(
        env,
        activityId,
        userId,
        input,
        fingerprint,
        status,
      );
    await assertClaimRateLimit(env, activityId, userId);
    const password = await createDb(env.DB)
      .select({ id: activityPasswords.id })
      .from(activityPasswords)
      .where(
        and(
          eq(activityPasswords.activityId, activityId),
          eq(activityPasswords.digest, passwordDigest),
        ),
      )
      .get();
    const rowId = crypto.randomUUID();
    const outcome = password ? "solved" : "incorrect";
    const ciphertext = activity.forceDedicated
      ? await encryptString(
          input.password,
          env,
          attemptAssociatedData(activityId, rowId),
        )
      : null;
    const statements = [
      env.DB.prepare(`UPDATE activities SET version = CASE WHEN version = ? AND deleted_at IS NULL
          AND opened_at IS NOT NULL AND ended_at IS NULL AND archived_at IS NULL
          AND claimed_count < total_count AND deadline > ${databaseNow}
          AND EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
          AND (SELECT COUNT(*) FROM redemption_submissions WHERE activity_id = ? AND user_id = ?
            AND validated_at > ${databaseNow} - ?) < ?
          THEN version ELSE NULL END WHERE id = ?`).bind(
        activity.version,
        activityId,
        userId,
        activityId,
        userId,
        CLAIM_WINDOW_MS,
        claimAttemptLimit(env),
        activityId,
      ),
      env.DB.prepare(`INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, outcome, matched_password_id,
          created_at, validated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, 'solve', ?, ?, ${databaseNow}, ${databaseNow}, ${databaseNow})`).bind(
        rowId,
        activityId,
        userId,
        input.submissionId,
        fingerprint,
        outcome,
        password?.id ?? null,
      ),
    ];
    if (ciphertext !== null)
      statements.push(
        env.DB.prepare(`INSERT INTO attempt_events
          (id, submission_row_id, activity_id, user_id, ciphertext, digest, matched, matched_password_id, validated_at)
          SELECT ?, id, activity_id, user_id, ?, ?, ?, matched_password_id, validated_at
          FROM redemption_submissions WHERE id = ? AND purpose = 'solve'`).bind(
          crypto.randomUUID(),
          ciphertext,
          passwordDigest,
          Number(Boolean(password)),
          rowId,
        ),
      );
    try {
      await env.DB.batch(statements);
      const saved = await findSubmission(env, userId, input.submissionId);
      if (!saved) throw new Error("Password solve was not persisted");
      return solveResult(bindFingerprint(saved, fingerprint, "solve"));
    } catch (error) {
      const winner = await findSubmission(env, userId, input.submissionId);
      if (winner)
        return solveResult(bindFingerprint(winner, fingerprint, "solve"));
      const current = await findActivity(env, activityId);
      if (!current) activityNotFound();
      if (
        current.version !== activity.version ||
        activityStatus(current) !== "active" ||
        !(await findUserClaim(env, activityId, userId))
      )
        continue;
      await assertClaimRateLimit(env, activityId, userId);
      throw error;
    }
  }
  throw new ActivityError(
    503,
    "ACTIVITY_BUSY",
    "活动正在更新，请使用原提交重试",
  );
}
