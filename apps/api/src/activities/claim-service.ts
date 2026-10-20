import type {
  ClaimActivityInput,
  ClaimResult,
  ParticipationMode,
} from "@hb/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { claimStatements } from "../balance/hongbao";
import { createDb } from "../db/client";
import {
  activities,
  activityPasswords,
  redemptionSubmissions,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { paymentBusinessNo } from "../payments/business-no";
import { claimPaymentParameterDigest } from "../payments/policy";
import { assertUint64Decimal } from "../payments/real-protocol";
import {
  type ActivityAttempt,
  assertAttemptAllowed,
  attemptWriteStatements,
  bindDiscoveryStatement,
  discoveryBindingGuard,
} from "../runtime/attempt-cooldown";
import {
  allowsRealClaim,
  isLocalSimulation,
  readPlatformControls,
} from "../runtime/controls";
import { encryptString } from "../security/crypto";
import { findUserClaim, getClaimDetail } from "./claim-queries";
import { ActivityError, activityConflict, activityNotFound } from "./errors";
import {
  type ActivityExecutionPolicy,
  permitsRealActivity,
} from "./execution-policy";
import { requireHumanCheck } from "./human-check";
import { databaseNow, refreshActivityLifecycle } from "./lifecycle";
import { assertParticipationMode, participationRequest } from "./participation";
import { activityStatus } from "./service";
import { findActivity } from "./storage";

export type SubmissionRow = typeof redemptionSubmissions.$inferSelect;

/** A terminal business outcome alone does not prove the input was checked. */
export function submissionPasswordMatched(
  submission: Pick<
    SubmissionRow,
    "matchedPasswordId" | "validatedAt" | "participationMode"
  >,
): boolean | null {
  if (submission.participationMode === "direct") return null;
  if (submission.matchedPasswordId !== null) return true;
  return submission.validatedAt !== null ? false : null;
}
type FinishedOutcome = Exclude<
  SubmissionRow["outcome"],
  "pending" | "solved" | "registered" | "already_registered"
>;

export function attemptAssociatedData(
  activityId: string,
  submissionRowId: string,
) {
  return `activity:${activityId}:attempt:${submissionRowId}`;
}

export async function findSubmission(
  env: ApiBindings,
  userId: string,
  submissionId: string,
) {
  return createDb(env.DB)
    .select()
    .from(redemptionSubmissions)
    .where(
      and(
        eq(redemptionSubmissions.userId, userId),
        eq(redemptionSubmissions.submissionId, submissionId),
      ),
    )
    .get();
}

export function bindFingerprint(
  row: SubmissionRow,
  fingerprint: string,
  purpose: "claim" | "solve" | "register" = "claim",
) {
  if (row.purpose !== purpose || row.fingerprint !== fingerprint)
    activityConflict("同一提交标识不能更换操作、红包或口令");
  return row;
}

async function registerFinished(
  env: ApiBindings,
  activityId: string,
  userId: string,
  submissionId: string,
  fingerprint: string,
  mode: ParticipationMode,
  outcome: FinishedOutcome,
  claimId: string | null = null,
  continuation?: ActivityAttempt,
) {
  await assertAttemptAllowed(env, userId, "activity", continuation, {
    checkCooldown: false,
  });
  const guard = discoveryBindingGuard(userId, continuation);
  try {
    await env.DB.batch([
      ...(continuation
        ? [bindDiscoveryStatement(env, userId, continuation)]
        : []),
      env.DB.prepare(`INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, claim_id, created_at, finished_at)
        SELECT ?, ?, ?, ?, CASE WHEN ${guard.sql} THEN ? ELSE NULL END, 'claim', ?, ?, ?, ${databaseNow}, ${databaseNow}
        WHERE EXISTS (SELECT 1 FROM activities WHERE id = ? AND participation_mode = ? AND reward_type = 'ldc' AND deleted_at IS NULL)`).bind(
        crypto.randomUUID(),
        activityId,
        userId,
        submissionId,
        ...guard.bindings,
        fingerprint,
        mode,
        outcome,
        claimId,
        activityId,
        mode,
      ),
    ]);
  } catch (error) {
    const winner = await findSubmission(env, userId, submissionId);
    if (winner) return bindFingerprint(winner, fingerprint);
    await assertAttemptAllowed(env, userId, "activity", continuation, {
      checkCooldown: false,
    });
    throw error;
  }
  const row = await findSubmission(env, userId, submissionId);
  if (!row) {
    if (!(await findActivity(env, activityId))) activityNotFound();
    throw new Error("Submission was not persisted");
  }
  return row;
}

/** Durable validation is separate from allocation, so a process interruption cannot erase an attempt. */
export async function prepareClaimSubmission(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  executionPolicy?: ActivityExecutionPolicy,
  humanVerified = false,
): Promise<SubmissionRow> {
  const { mode, fingerprint, passwordDigest, continuation } =
    await participationRequest(env, activityId, input, "claim");
  for (let retry = 0; retry < 4; retry += 1) {
    const previous = await findSubmission(env, userId, input.submissionId);
    if (previous) {
      bindFingerprint(previous, fingerprint);
      if (!(await findActivity(env, activityId))) activityNotFound();
      return previous;
    }
    const activity = await findActivity(env, activityId);
    if (
      !activity ||
      (activity.openedAt === null && activity.authorId !== userId)
    )
      activityNotFound();
    assertParticipationMode(activity, mode);
    if (activity.rewardType === "ldc" && activity.authorId === userId)
      throw new ActivityError(
        403,
        "SELF_CLAIM_FORBIDDEN",
        "不能领取自己发的红包",
      );
    const existingClaim = await findUserClaim(env, activityId, userId);
    if (existingClaim)
      return registerFinished(
        env,
        activityId,
        userId,
        input.submissionId,
        fingerprint,
        mode,
        "already_claimed",
        existingClaim.id,
        continuation,
      );
    const status = activityStatus(activity);
    if (status !== "active")
      return registerFinished(
        env,
        activityId,
        userId,
        input.submissionId,
        fingerprint,
        mode,
        status,
        null,
        continuation,
      );
    if (
      activity.rewardType === "ldc" &&
      activity.paymentMode === "simulation" &&
      !isLocalSimulation(env)
    )
      throw new ActivityError(
        400,
        "SIMULATION_NOT_AVAILABLE",
        "此环境不支持新的模拟奖励领取。",
      );
    const testPermission = permitsRealActivity(activity.id, executionPolicy);
    const realActivityPermitted =
      testPermission ||
      (activity.paymentMode === "real" &&
        allowsRealClaim(env, await readPlatformControls(env)));
    if (
      activity.rewardType === "ldc" &&
      activity.paymentMode === "real" &&
      !realActivityPermitted
    )
      throw new ActivityError(
        400,
        env.APP_ENV === "production" && env.LDC_NETWORK_MODE === "live"
          ? "REAL_LDC_CLAIMS_PAUSED"
          : "REAL_LDC_NOT_ENABLED",
        "真实 LDC 新领取暂时关闭，已领取奖励仍可从记录查看。",
      );
    await assertAttemptAllowed(env, userId, "activity", continuation);
    const password =
      passwordDigest === null
        ? undefined
        : await createDb(env.DB)
            .select()
            .from(activityPasswords)
            .where(
              and(
                eq(activityPasswords.activityId, activityId),
                eq(activityPasswords.digest, passwordDigest),
              ),
            )
            .get();
    const rowId = crypto.randomUUID();
    // Every 口令红包 counts what is typed on its page (07 §7), encrypted.
    const ciphertext =
      "password" in input
        ? await encryptString(
            input.password,
            env,
            attemptAssociatedData(activityId, rowId),
          )
        : null;
    const outcome = mode === "direct" || password ? "pending" : "incorrect";
    // Only a claim that would go ahead asks: nothing is written (no attempt,
    // no cooldown) until it comes back with a token.
    if (outcome === "pending") requireHumanCheck(env, activity, humanVerified);
    const statements = [
      ...attemptWriteStatements(env, userId, "activity", rowId, continuation),
      // A failed precondition must roll back the submission AND the event together.
      env.DB.prepare(`UPDATE activities SET version = CASE WHEN version = ? AND participation_mode = ? AND deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL
        AND archived_at IS NULL AND deadline > ${databaseNow} AND claimed_count < total_count
        AND reward_type = 'ldc' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) AND author_id != ? AND ((payment_mode = 'simulation' AND ?=1) OR (payment_mode = 'real' AND ? = 1 AND (?=1 OR EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_claim=1))))
        AND NOT EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
        THEN version ELSE NULL END WHERE id = ?`).bind(
        activity.version,
        mode,
        userId,
        userId,
        Number(isLocalSimulation(env)),
        Number(realActivityPermitted),
        Number(testPermission),
        activityId,
        userId,
        activityId,
      ),
      env.DB.prepare(`INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, matched_password_id, created_at, validated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, 'claim', ?, ?, ?, ${databaseNow}, ${databaseNow}, CASE WHEN ? = 'incorrect' THEN ${databaseNow} ELSE NULL END)`).bind(
        rowId,
        activityId,
        userId,
        input.submissionId,
        fingerprint,
        mode,
        outcome,
        password?.id ?? null,
        outcome,
      ),
    ];
    if (ciphertext !== null)
      statements.push(
        env.DB.prepare(`INSERT INTO attempt_events
      (id, submission_row_id, activity_id, user_id, ciphertext, digest, matched, matched_password_id, validated_at)
      SELECT ?, id, activity_id, user_id, ?, ?, ?, matched_password_id, validated_at FROM redemption_submissions WHERE id = ?`).bind(
          crypto.randomUUID(),
          ciphertext,
          passwordDigest,
          Number(Boolean(password)),
          rowId,
        ),
      );
    try {
      await env.DB.batch(statements);
      const row = await findSubmission(env, userId, input.submissionId);
      if (!row) throw new Error("Validation was not persisted");
      return row;
    } catch (error) {
      const winner = await findSubmission(env, userId, input.submissionId);
      if (winner) return bindFingerprint(winner, fingerprint);
      const current = await findActivity(env, activityId);
      if (!current) activityNotFound();
      if (
        current.version !== activity.version ||
        activityStatus(current) !== "active" ||
        (await findUserClaim(env, activityId, userId))
      )
        continue;
      if (
        current.paymentMode === "real" &&
        !testPermission &&
        !allowsRealClaim(env, await readPlatformControls(env))
      )
        throw new ActivityError(
          409,
          "REAL_LDC_CLAIMS_PAUSED",
          "新领取暂时关闭，请保留原提交稍后重试。",
        );
      await assertAttemptAllowed(env, userId, "activity", continuation);
      throw error;
    }
  }
  throw new ActivityError(
    503,
    "ACTIVITY_BUSY",
    "红包正在更新，请使用原提交重试",
  );
}

async function resultOfSubmission(
  env: ApiBindings,
  submission: SubmissionRow,
): Promise<ClaimResult> {
  if (submission.purpose !== "claim" || submission.outcome === "solved")
    activityConflict("解出口令的提交不能用来领取");
  if (
    submission.outcome === "registered" ||
    submission.outcome === "already_registered"
  )
    activityConflict("报名的提交不能用来领取");
  if (
    submission.outcome === "claimed" ||
    submission.outcome === "already_claimed"
  ) {
    if (!submission.claimId)
      throw new Error("Completed submission has no claim");
    return {
      result: submission.outcome,
      passwordMatched: submissionPasswordMatched(submission),
      claim: await getClaimDetail(env, submission.claimId, submission.userId),
    };
  }
  if (submission.outcome === "pending")
    throw new Error("Submission still requires allocation");
  return {
    result: submission.outcome,
    passwordMatched: submissionPasswordMatched(submission),
  };
}

async function finishWithoutAllocation(
  env: ApiBindings,
  submission: SubmissionRow,
  outcome: FinishedOutcome,
  claimId: string | null = null,
) {
  await env.DB.prepare(
    `UPDATE redemption_submissions SET outcome = ?, claim_id = ?, finished_at = ${databaseNow}
      WHERE id = ? AND purpose = 'claim' AND outcome = 'pending'
      AND EXISTS (SELECT 1 FROM activities WHERE activities.id = redemption_submissions.activity_id AND reward_type = 'ldc' AND deleted_at IS NULL)`,
  )
    .bind(outcome, claimId, submission.id)
    .run();
  const current = await findSubmission(
    env,
    submission.userId,
    submission.submissionId,
  );
  if (!current) throw new Error("Submission was not found");
  return resultOfSubmission(env, current);
}

function randomIndex(length: number) {
  const range = 2 ** 32;
  const ceiling = range - (range % length);
  const bytes = new Uint32Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while ((bytes[0] ?? range) >= ceiling);
  return (bytes[0] ?? 0) % length;
}

export async function paymentRecipient(
  env: ApiBindings,
  userId: string,
  mode: "simulation" | "real",
) {
  const user = await createDb(env.DB)
    .select({ externalId: users.externalId, username: users.username })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) activityNotFound();
  if (mode === "simulation")
    return { id: `simulation:${user.externalId}`, username: user.username };
  try {
    assertUint64Decimal(user.externalId);
    if (
      !user.username ||
      Array.from(user.username).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Invalid recipient username");
  } catch {
    throw new ActivityError(
      400,
      "RECIPIENT_IDENTITY_UNVERIFIED",
      "收款账号的稳定身份尚未确认，暂不能分配 LDC 奖励。",
    );
  }
  return { id: user.externalId, username: user.username };
}

export async function completeClaimSubmission(
  env: ApiBindings,
  admitted: SubmissionRow,
  executionPolicy?: ActivityExecutionPolicy,
): Promise<ClaimResult> {
  let selectedInventoryId: string | null = null;
  for (let retry = 0; retry < 5; retry += 1) {
    const submission = await findSubmission(
      env,
      admitted.userId,
      admitted.submissionId,
    );
    if (!submission) throw new Error("Submission was not found");
    if (submission.purpose !== "claim")
      activityConflict("解出口令的提交不能用来领取");
    const activity = await findActivity(env, submission.activityId);
    if (!activity) activityNotFound();
    if (submission.outcome !== "pending")
      return resultOfSubmission(env, submission);
    const existingClaim = await findUserClaim(
      env,
      submission.activityId,
      submission.userId,
    );
    if (existingClaim)
      return finishWithoutAllocation(
        env,
        submission,
        "already_claimed",
        existingClaim.id,
      );
    const status = activityStatus(activity);
    if (status !== "active")
      return finishWithoutAllocation(env, submission, status);
    if (
      activity.rewardType === "ldc" &&
      activity.paymentMode === "simulation" &&
      !isLocalSimulation(env)
    )
      throw new ActivityError(
        400,
        "SIMULATION_NOT_AVAILABLE",
        "此环境不支持新的模拟奖励领取。",
      );
    const available =
      await env.DB.prepare(`SELECT inventory.id, inventory.amount_minor FROM reward_inventory inventory
      WHERE inventory.activity_id = ? AND inventory.kind = 'ldc' AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.activity_id = inventory.activity_id AND claims.inventory_id = inventory.id)
      ORDER BY inventory.position`)
        .bind(activity.id)
        .all<{ id: string; amount_minor: number | null }>();
    const reward =
      available.results.find((item) => item.id === selectedInventoryId) ??
      available.results[
        activity.allocation === "random"
          ? randomIndex(available.results.length || 1)
          : 0
      ];
    if (!reward)
      throw new ActivityError(
        503,
        "INVENTORY_INCONSISTENT",
        "奖励库存暂时不可用，请使用原提交重试",
      );
    selectedInventoryId = reward.id;
    if (
      activity.rewardType === "ldc" &&
      activity.authorId === submission.userId
    )
      throw new ActivityError(
        403,
        "SELF_CLAIM_FORBIDDEN",
        "不能领取自己发的红包",
      );
    const testPermission = permitsRealActivity(activity.id, executionPolicy);
    const realActivityPermitted =
      testPermission ||
      (activity.paymentMode === "real" &&
        allowsRealClaim(env, await readPlatformControls(env)));
    if (
      activity.rewardType === "ldc" &&
      activity.paymentMode === "real" &&
      !realActivityPermitted
    )
      throw new ActivityError(
        400,
        env.APP_ENV === "production" && env.LDC_NETWORK_MODE === "live"
          ? "REAL_LDC_CLAIMS_PAUSED"
          : "REAL_LDC_NOT_ENABLED",
        "真实 LDC 新领取暂时关闭，已领取奖励仍可从记录查看。",
      );
    const claimId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const statements = [
      env.DB.prepare(`UPDATE activities SET version = CASE WHEN deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL AND archived_at IS NULL
          AND deadline > ${databaseNow} AND claimed_count < total_count
          AND reward_type = 'ldc' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) AND author_id != ? AND (funding = 'balance' OR merchant_id IS NOT NULL) AND ((payment_mode = 'simulation' AND ?=1) OR (payment_mode = 'real' AND ? = 1 AND (?=1 OR EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_claim=1))))
          AND NOT EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
          AND EXISTS (SELECT 1 FROM redemption_submissions s WHERE s.id = ? AND s.activity_id=activities.id
            AND s.user_id=? AND s.purpose = 'claim' AND s.outcome = 'pending'
            AND s.participation_mode=activities.participation_mode AND s.validated_at IS NOT NULL
            AND ((s.participation_mode='password' AND s.matched_password_id IS NOT NULL)
              OR (s.participation_mode='direct' AND s.matched_password_id IS NULL)))
          THEN version ELSE NULL END WHERE id = ?`).bind(
        submission.userId,
        submission.userId,
        Number(isLocalSimulation(env)),
        Number(realActivityPermitted),
        Number(testPermission),
        activity.id,
        submission.userId,
        submission.id,
        submission.userId,
        activity.id,
      ),
      env.DB.prepare(
        `INSERT INTO claims (id, activity_id, user_id, inventory_id, password_id, claimed_at) VALUES (?, ?, ?, ?, ?, ${databaseNow})`,
      ).bind(
        claimId,
        activity.id,
        submission.userId,
        reward.id,
        submission.matchedPasswordId,
      ),
      env.DB.prepare(`UPDATE activities SET
          ended_at = CASE WHEN claimed_count + 1 = total_count THEN (SELECT claimed_at FROM claims WHERE id = ?) ELSE ended_at END,
          end_reason = CASE WHEN claimed_count + 1 = total_count THEN 'exhausted' ELSE end_reason END,
          version = version + CASE WHEN claimed_count + 1 = total_count THEN 1 ELSE 0 END,
          claimed_count = claimed_count + 1, updated_at = ${databaseNow} WHERE id = ?`).bind(
        claimId,
        activity.id,
      ),
      env.DB.prepare(
        `UPDATE redemption_submissions SET outcome = 'claimed', claim_id = ?, finished_at = ${databaseNow} WHERE id = ? AND purpose = 'claim' AND outcome = 'pending'`,
      ).bind(claimId, submission.id),
      env.DB.prepare(
        "UPDATE attempt_events SET claim_id = ? WHERE submission_row_id = ? AND matched = 1",
      ).bind(claimId, submission.id),
    ];
    let paymentMerchantVersion: number | null = null;
    // A 🐟额红包's share moves inside 🐟额 in this same batch, with no
    // payment (docs/balance-design.md §14).
    if (activity.funding === "balance")
      statements.push(
        ...claimStatements(
          env,
          activity.id,
          claimId,
          submission.userId,
          reward.id,
        ),
      );
    else if (activity.rewardType === "ldc") {
      if (!activity.paymentMode)
        throw new Error("LDC activity has no payment mode");
      const recipient = await paymentRecipient(
        env,
        submission.userId,
        activity.paymentMode,
      );
      const merchant = await env.DB.prepare(
        "SELECT client_id,version FROM merchants WHERE id=? AND author_id=? AND mode=?",
      )
        .bind(activity.merchantId, activity.authorId, activity.paymentMode)
        .first<{ client_id: string; version: number }>();
      if (!merchant || reward.amount_minor === null || !activity.merchantId)
        throw new Error("LDC claim identity is incomplete");
      paymentMerchantVersion = merchant.version;
      const businessNo = paymentBusinessNo(claimId);
      const recoveryPolicy =
        activity.paymentMode === "real"
          ? ("claim_same_order_v1" as const)
          : null;
      const parameterDigest =
        recoveryPolicy === null
          ? null
          : await claimPaymentParameterDigest({
              id: taskId,
              claimId,
              source: "claim",
              acceptanceId: null,
              merchantId: activity.merchantId,
              clientId: merchant.client_id,
              businessNo,
              recipientId: recipient.id,
              recipientUsername: recipient.username,
              amountMinor: reward.amount_minor,
              mode: "real",
              recoveryPolicy,
            });
      // Missing merchant, user, or amount fails NOT NULL constraints, rolling back
      // the reward allocation rather than leaving an unfunded claim behind.
      statements.push(
        env.DB.prepare(`INSERT INTO payment_tasks
          (id, claim_id, source, acceptance_id, merchant_id, client_id, business_no, recipient_id, recipient_username, amount_minor, mode, status, next_run_at, created_at, updated_at, recovery_policy, parameter_digest)
          VALUES (?, ?, 'claim', NULL, ?,
            (SELECT client_id FROM merchants WHERE id = ? AND author_id = ? AND mode = ? AND version = ?), ?, ?, ?,
            (SELECT amount_minor FROM reward_inventory WHERE activity_id = ? AND id = ? AND kind = 'ldc'),
            ?, 'pending', ${databaseNow}, ${databaseNow}, ${databaseNow}, ?, ?)`).bind(
          taskId,
          claimId,
          activity.merchantId,
          activity.merchantId,
          activity.authorId,
          activity.paymentMode,
          merchant.version,
          businessNo,
          recipient.id,
          recipient.username,
          activity.id,
          reward.id,
          activity.paymentMode,
          recoveryPolicy,
          parameterDigest,
        ),
        env.DB.prepare(
          `INSERT INTO payment_outbox (id, task_id, created_at) VALUES (?, ?, ${databaseNow})`,
        ).bind(crypto.randomUUID(), taskId),
      );
    }
    try {
      await env.DB.batch(statements);
    } catch (error) {
      const current = await findSubmission(
        env,
        submission.userId,
        submission.submissionId,
      );
      if (current && current.outcome !== "pending")
        return resultOfSubmission(env, current);
      const latest = await findActivity(env, activity.id);
      if (!latest) activityNotFound();
      if (
        latest.paymentMode === "real" &&
        !testPermission &&
        !allowsRealClaim(env, await readPlatformControls(env))
      )
        throw new ActivityError(
          409,
          "REAL_LDC_CLAIMS_PAUSED",
          "新领取暂时关闭，请保留原提交稍后重试。",
        );
      if (
        activityStatus(latest) !== "active" ||
        (await findUserClaim(env, activity.id, submission.userId))
      )
        continue;
      if (paymentMerchantVersion !== null) {
        const latestMerchant = await env.DB.prepare(
          "SELECT version FROM merchants WHERE id=?",
        )
          .bind(activity.merchantId)
          .first<{ version: number }>();
        if (latestMerchant && latestMerchant.version !== paymentMerchantVersion)
          continue;
      }
      const taken = await env.DB.prepare(
        "SELECT 1 FROM claims WHERE activity_id = ? AND inventory_id = ?",
      )
        .bind(activity.id, reward.id)
        .first();
      if (taken) continue;
      throw error;
    }
  }
  const final = await findSubmission(
    env,
    admitted.userId,
    admitted.submissionId,
  );
  if (final && final.outcome !== "pending")
    return resultOfSubmission(env, final);
  throw new ActivityError(503, "ACTIVITY_BUSY", "领取繁忙，请使用原提交重试");
}

export async function claimActivity(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  executionPolicy?: ActivityExecutionPolicy,
  /** The API route checked a Turnstile token for this 红包 (human-check.ts). */
  humanVerified = false,
) {
  await refreshActivityLifecycle(env, activityId);
  const activity = await findActivity(env, activityId);
  const previous = await findSubmission(env, userId, input.submissionId);
  if (
    previous?.purpose === "register" ||
    (!previous &&
      activity?.rewardType === "ldc" &&
      JSON.parse(activity.config).money?.mode === "timed_draw")
  ) {
    const { registerForDraw } = await import("./registration-service");
    return registerForDraw(
      env,
      activityId,
      userId,
      input,
      executionPolicy,
      humanVerified,
    );
  }
  const submission = await prepareClaimSubmission(
    env,
    activityId,
    userId,
    input,
    executionPolicy,
    humanVerified,
  );
  return completeClaimSubmission(env, submission, executionPolicy);
}

export async function resumePendingActivityClaims(
  env: ApiBindings,
  activityId: string,
) {
  const pending = await createDb(env.DB)
    .select({ submission: redemptionSubmissions })
    .from(redemptionSubmissions)
    .innerJoin(activities, eq(activities.id, redemptionSubmissions.activityId))
    .where(
      and(
        eq(redemptionSubmissions.activityId, activityId),
        eq(redemptionSubmissions.outcome, "pending"),
        eq(redemptionSubmissions.purpose, "claim"),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
      ),
    )
    .orderBy(redemptionSubmissions.createdAt, redemptionSubmissions.id)
    .limit(50);
  for (const { submission } of pending) {
    try {
      await completeClaimSubmission(env, submission);
    } catch (error) {
      console.error("claim_recovery_error", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return pending.length;
}
