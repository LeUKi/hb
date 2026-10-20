import type {
  ActivityPasswords,
  PasswordClaimInput,
  SolveResult,
} from "@hb/contracts";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activityPasswords } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  assertAttemptAllowed,
  attemptWriteStatements,
} from "../runtime/attempt-cooldown";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../security/crypto";
import { findUserClaim } from "./claim-queries";
import {
  attemptAssociatedData,
  bindFingerprint,
  findSubmission,
  type SubmissionRow,
  submissionPasswordMatched,
} from "./claim-service";
import { findRegistration } from "./draw-storage";
import { ActivityError, activityNotFound } from "./errors";
import { databaseNow } from "./lifecycle";
import { assertParticipationMode } from "./participation";
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
        CASE WHEN r.password_id = p.id THEN 1 ELSE 0 END AS isRegistrationPassword,
        CASE WHEN ${solved} THEN 1 ELSE 0 END AS isSolved
      FROM activity_passwords p JOIN activities a ON a.id = p.activity_id
      LEFT JOIN claims c ON c.activity_id = a.id AND c.user_id = ?
      LEFT JOIN activity_registrations r ON r.activity_id = a.id AND r.user_id = ?
      WHERE a.id = ? AND a.reward_type = 'ldc' AND a.deleted_at IS NULL AND (a.opened_at IS NOT NULL OR a.author_id = ?)
      AND (a.author_id = ? OR (a.opened_at IS NOT NULL AND
        (a.ended_at IS NOT NULL OR a.archived_at IS NOT NULL OR a.claimed_count >= a.total_count OR a.deadline <= ${databaseNow}))
        OR ((c.id IS NOT NULL OR r.id IS NOT NULL) AND (c.password_id = p.id OR r.password_id = p.id OR ${solved})))
      ORDER BY p.position`).bind(
      viewer,
      viewer,
      viewer,
      activityId,
      viewer,
      viewer,
      viewer,
    ),
    env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM activity_passwords WHERE activity_id = a.id) AS total,
        CASE WHEN json_extract(a.config,'$.money.mode')='timed_draw' THEN 1 ELSE 0 END AS timed,
        CASE WHEN a.participation_mode='password' AND a.opened_at IS NOT NULL AND a.ended_at IS NULL AND a.archived_at IS NULL
          AND a.claimed_count < a.total_count AND a.deadline > ${databaseNow}
          AND (EXISTS (SELECT 1 FROM claims WHERE activity_id = a.id AND user_id = ?)
            OR EXISTS (SELECT 1 FROM activity_registrations WHERE activity_id=a.id AND user_id=?))
          THEN 1 ELSE 0 END AS canSolve
      FROM activities a WHERE a.id = ? AND a.reward_type = 'ldc' AND a.deleted_at IS NULL
        AND (a.opened_at IS NOT NULL OR a.author_id = ?)`).bind(
      viewer,
      viewer,
      activityId,
      viewer,
    ),
  ]);
  const state = metadata?.results[0] as
    | { total: number; canSolve: number; timed: number }
    | undefined;
  if (!state || !answers) activityNotFound();
  const rows = answers.results as {
    id: string;
    ciphertext: string;
    isClaimPassword: number;
    isRegistrationPassword: number;
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
        ...(state.timed === 1
          ? { isRegistrationPassword: row.isRegistrationPassword === 1 }
          : {}),
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
    passwordMatched: submissionPasswordMatched(submission),
  };
}

async function registerEndedSolve(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: PasswordClaimInput,
  fingerprint: string,
  outcome: "ended" | "archived",
) {
  try {
    await env.DB.prepare(`INSERT INTO redemption_submissions
      (id, activity_id, user_id, submission_id, fingerprint, purpose, outcome, created_at, finished_at)
      SELECT ?, ?, ?, ?, ?, 'solve', ?, ${databaseNow}, ${databaseNow}
      WHERE EXISTS (SELECT 1 FROM activities WHERE id = ? AND reward_type = 'ldc' AND deleted_at IS NULL)`)
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
  input: PasswordClaimInput,
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
    assertParticipationMode(activity, "password");
    const status = activityStatus(activity);
    if (status === "draft")
      throw new ActivityError(400, "ACTIVITY_NOT_OPEN", "红包尚未开放");
    if (
      !(await findUserClaim(env, activityId, userId)) &&
      !(await findRegistration(env, activityId, userId))
    )
      throw new ActivityError(
        403,
        "CLAIM_REQUIRED",
        "领取奖励或成功报名后才可继续验证其他口令",
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
    await assertAttemptAllowed(env, userId, "activity");
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
    // Every 口令红包 counts what is typed on its page (07 §7), encrypted.
    const ciphertext = await encryptString(
      input.password,
      env,
      attemptAssociatedData(activityId, rowId),
    );
    const statements = [
      ...attemptWriteStatements(env, userId, "activity", rowId),
      env.DB.prepare(`UPDATE activities SET version = CASE WHEN version = ? AND reward_type = 'ldc' AND participation_mode='password' AND deleted_at IS NULL
          AND opened_at IS NOT NULL AND ended_at IS NULL AND archived_at IS NULL
          AND claimed_count < total_count AND deadline > ${databaseNow}
          AND (EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
            OR EXISTS (SELECT 1 FROM activity_registrations WHERE activity_id=? AND user_id=?))
          THEN version ELSE NULL END WHERE id = ?`).bind(
        activity.version,
        activityId,
        userId,
        activityId,
        userId,
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
        (!(await findUserClaim(env, activityId, userId)) &&
          !(await findRegistration(env, activityId, userId)))
      )
        continue;
      await assertAttemptAllowed(env, userId, "activity");
      throw error;
    }
  }
  throw new ActivityError(
    503,
    "ACTIVITY_BUSY",
    "红包正在更新，请使用原提交重试",
  );
}
