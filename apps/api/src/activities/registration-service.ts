import type { ClaimActivityInput, ClaimResult } from "@hb/contracts";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { activityPasswords } from "../db/schema";
import type { ApiBindings } from "../env";
import {
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
import {
  attemptAssociatedData,
  bindFingerprint,
  findSubmission,
  paymentRecipient,
  type SubmissionRow,
  submissionPasswordMatched,
} from "./claim-service";
import { findRegistration, timedDrawMoney } from "./draw-storage";
import { ActivityError, activityNotFound } from "./errors";
import {
  type ActivityExecutionPolicy,
  permitsRealActivity,
} from "./execution-policy";
import { requireHumanCheck } from "./human-check";
import { databaseNow } from "./lifecycle";
import { assertParticipationMode, participationRequest } from "./participation";
import { getRegistrationDetail } from "./registration-queries";
import { activityStatus } from "./service";
import { findActivity } from "./storage";

async function result(
  env: ApiBindings,
  row: SubmissionRow,
): Promise<ClaimResult> {
  if (row.purpose !== "register")
    throw new Error("Not a registration submission");
  if (row.outcome === "registered" || row.outcome === "already_registered") {
    if (!row.registrationId)
      throw new Error("Registration submission has no entry");
    return {
      result: row.outcome,
      passwordMatched: submissionPasswordMatched(row),
      registration: await getRegistrationDetail(
        env,
        row.registrationId,
        row.userId,
      ),
    };
  }
  if (["incorrect", "draft", "ended", "archived"].includes(row.outcome))
    return {
      result: row.outcome as "incorrect" | "draft" | "ended" | "archived",
      passwordMatched: submissionPasswordMatched(row),
    };
  throw new Error("Invalid terminal registration submission");
}

/** Registration, its terminal submission, count and early close commit together. */
export async function registerForDraw(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  executionPolicy?: ActivityExecutionPolicy,
  humanVerified = false,
): Promise<ClaimResult> {
  const { mode, fingerprint, passwordDigest, continuation } =
    await participationRequest(env, activityId, input, "register");
  for (let retry = 0; retry < 5; retry++) {
    const previous = await findSubmission(env, userId, input.submissionId);
    if (previous)
      return result(env, bindFingerprint(previous, fingerprint, "register"));
    const activity = await findActivity(env, activityId);
    if (
      !activity ||
      (activity.openedAt === null && activity.authorId !== userId)
    )
      activityNotFound();
    assertParticipationMode(activity, mode);
    const money = timedDrawMoney(activity);
    if (!money) throw new Error("Activity is not a timed draw");
    if (activity.authorId === userId)
      throw new ActivityError(
        403,
        "SELF_CLAIM_FORBIDDEN",
        "不能报名自己发的红包",
      );
    const existing = await findRegistration(env, activityId, userId);
    const status = activityStatus(activity);
    if (existing || status !== "active") {
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
            (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,registration_id,created_at,finished_at)
            VALUES (?,?,?,?,CASE WHEN ${guard.sql} THEN ? ELSE NULL END,'register',?,?,?,${databaseNow},${databaseNow})`).bind(
            crypto.randomUUID(),
            activityId,
            userId,
            input.submissionId,
            ...guard.bindings,
            fingerprint,
            mode,
            existing ? "already_registered" : status,
            existing?.id ?? null,
          ),
        ]);
      } catch (error) {
        const winner = await findSubmission(env, userId, input.submissionId);
        if (winner)
          return result(env, bindFingerprint(winner, fingerprint, "register"));
        await assertAttemptAllowed(env, userId, "activity", continuation, {
          checkCooldown: false,
        });
        throw error;
      }
      const saved = await findSubmission(env, userId, input.submissionId);
      if (!saved) throw new Error("Registration outcome was not saved");
      return result(env, saved);
    }
    if (activity.paymentMode === "simulation" && !isLocalSimulation(env))
      throw new ActivityError(
        400,
        "SIMULATION_NOT_AVAILABLE",
        "此环境不支持新的模拟奖励报名。",
      );
    const testPermission = permitsRealActivity(activityId, executionPolicy);
    const realPermitted =
      testPermission ||
      (activity.paymentMode === "real" &&
        allowsRealClaim(env, await readPlatformControls(env)));
    if (activity.paymentMode === "real" && !realPermitted)
      throw new ActivityError(
        409,
        "REAL_LDC_CLAIMS_PAUSED",
        "真实 LDC 新报名暂时关闭，已有报名仍会正常开奖。",
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
    const registrationId =
      mode === "direct" || password ? crypto.randomUUID() : null;
    // As for claims: asked only when the sign-up would go ahead.
    if (registrationId) requireHumanCheck(env, activity, humanVerified);
    const recipient =
      registrationId && activity.paymentMode
        ? await paymentRecipient(env, userId, activity.paymentMode)
        : null;
    // Every 口令红包 counts what is typed on its page (07 §7), encrypted.
    const ciphertext =
      "password" in input
        ? await encryptString(
            input.password,
            env,
            attemptAssociatedData(activityId, rowId),
          )
        : null;
    const statements = [
      ...attemptWriteStatements(env, userId, "activity", rowId, continuation),
      env.DB.prepare(`UPDATE activities SET version = CASE WHEN version=? AND reward_type='ldc' AND participation_mode=? AND deleted_at IS NULL
      AND opened_at IS NOT NULL AND ended_at IS NULL AND archived_at IS NULL AND draw_state='waiting'
      AND deadline>${databaseNow} AND registered_count<9007199254740991
      AND (json_extract(config,'$.money.participantLimit') IS NULL OR registered_count<json_extract(config,'$.money.participantLimit'))
      AND author_id!=? AND ((payment_mode='simulation' AND ?=1) OR (payment_mode='real' AND ?=1 AND (?=1 OR EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_claim=1))))
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1)
      AND NOT EXISTS(SELECT 1 FROM activity_registrations WHERE activity_id=? AND user_id=?)
      THEN version ELSE NULL END WHERE id=?`).bind(
        activity.version,
        mode,
        userId,
        Number(isLocalSimulation(env)),
        Number(realPermitted),
        Number(testPermission),
        userId,
        activityId,
        userId,
        activityId,
      ),
    ];
    if (mode === "direct")
      statements.push(
        env.DB.prepare(`INSERT INTO redemption_submissions
          (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,created_at,validated_at)
          VALUES (?,?,?,?,?,'register','direct','pending',${databaseNow},${databaseNow})`).bind(
          rowId,
          activityId,
          userId,
          input.submissionId,
          fingerprint,
        ),
      );
    if (registrationId && recipient) {
      statements.push(
        env.DB.prepare(`INSERT INTO activity_registrations
        (id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at)
        SELECT ?,id,?,?,registered_count+1,?,${databaseNow} FROM activities WHERE id=? AND reward_type='ldc'`).bind(
          registrationId,
          userId,
          password?.id ?? null,
          recipient.id,
          activityId,
        ),
      );
    }
    if (mode === "direct")
      statements.push(
        env.DB.prepare(`UPDATE redemption_submissions SET outcome='registered',
          registration_id=?,finished_at=${databaseNow}
          WHERE id=? AND purpose='register' AND participation_mode='direct' AND outcome='pending'`).bind(
          registrationId,
          rowId,
        ),
      );
    else
      statements.push(
        env.DB.prepare(`INSERT INTO redemption_submissions
      (id,activity_id,user_id,submission_id,fingerprint,purpose,participation_mode,outcome,matched_password_id,registration_id,created_at,validated_at,finished_at)
      VALUES (?,?,?,?,?,'register',?,?,?,?,${databaseNow},${databaseNow},${databaseNow})`).bind(
          rowId,
          activityId,
          userId,
          input.submissionId,
          fingerprint,
          mode,
          registrationId ? "registered" : "incorrect",
          password?.id ?? null,
          registrationId,
        ),
      );
    if (ciphertext !== null)
      statements.push(
        env.DB.prepare(`INSERT INTO attempt_events
      (id,submission_row_id,activity_id,user_id,ciphertext,digest,matched,matched_password_id,validated_at)
      SELECT ?,id,activity_id,user_id,?,?,?,matched_password_id,validated_at FROM redemption_submissions WHERE id=?`).bind(
          crypto.randomUUID(),
          ciphertext,
          passwordDigest,
          Number(Boolean(password)),
          rowId,
        ),
      );
    if (registrationId)
      statements.push(
        env.DB.prepare(`UPDATE activities SET registered_count=registered_count+1,
      draw_state=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'settling' ELSE draw_state END,
      draw_closed_at=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN ${databaseNow} ELSE draw_closed_at END,
      draw_reason=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'full' ELSE draw_reason END,
      ended_at=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN ${databaseNow} ELSE ended_at END,
      end_reason=CASE WHEN registered_count+1=json_extract(config,'$.money.participantLimit') THEN 'exhausted' ELSE end_reason END,
      version=version+1,updated_at=${databaseNow} WHERE id=?`).bind(activityId),
      );
    try {
      await env.DB.batch(statements);
      const saved = await findSubmission(env, userId, input.submissionId);
      if (!saved) throw new Error("Registration was not persisted");
      return result(env, saved);
    } catch (error) {
      const winner = await findSubmission(env, userId, input.submissionId);
      if (winner)
        return result(env, bindFingerprint(winner, fingerprint, "register"));
      const current = await findActivity(env, activityId);
      if (!current) activityNotFound();
      if (
        current.version !== activity.version ||
        activityStatus(current) !== "active" ||
        (await findRegistration(env, activityId, userId))
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
          "新报名暂时关闭，请保留原提交稍后重试。",
        );
      await assertAttemptAllowed(env, userId, "activity", continuation);
      throw error;
    }
  }
  throw new ActivityError(503, "ACTIVITY_BUSY", "报名繁忙，请使用原提交重试");
}
