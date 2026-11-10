import type {
  AttemptCooldown,
  ClaimActivityInput,
  ClaimResult,
  ParticipationMode,
} from "@hb/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { claimStatements } from "../balance/hongbao";
import { createDb } from "../db/client";
import { tableRow } from "../db/rows";
import {
  activities,
  activityPasswords,
  claims,
  redemptionSubmissions,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { judgedResult } from "../judge/ledger";
import type { JudgeHooks } from "../judge/session";
import { paymentBusinessNo } from "../payments/business-no";
import { claimPaymentParameterDigest } from "../payments/policy";
import { assertUint64Decimal } from "../payments/real-protocol";
import {
  claimBlockedBy,
  pointsPaymentId,
  pointsPaymentStatement,
} from "../points/payments";
import { readSystem } from "../points/systems";
import {
  type ActivityAttempt,
  type AttemptRow,
  assertAttemptAllowed,
  attemptStatement,
  attemptWriteStatements,
  bindDiscoveryStatement,
  checkAttempt,
  discoveryBindingGuard,
  readAttemptCooldowns,
} from "../runtime/attempt-cooldown";
import {
  allowsRealClaim,
  controlsOf,
  type PlatformControls,
  platformControlsStatement,
  readPlatformControls,
  simulatesPayments,
  stageBalanceHongbao,
} from "../runtime/controls";
import { encryptString } from "../security/crypto";
import {
  claimDetailsBatch,
  findUserClaim,
  getClaimDetail,
} from "./claim-queries";
import {
  checkInScope,
  type ScopeViewer,
  scopeViewerStatement,
} from "./claim-scope";
import { ActivityError, activityConflict, activityNotFound } from "./errors";
import {
  type ActivityExecutionPolicy,
  permitsRealActivity,
} from "./execution-policy";
import { activityStatusCaseSql } from "./history-query";
import { requireHumanCheck } from "./human-check";
import { databaseNow, refreshActivityLifecycle } from "./lifecycle";
import { assertParticipationMode, participationRequest } from "./participation";
import { activityStatus } from "./service";
import { type ActivityRow, findActivity } from "./storage";

export type SubmissionRow = typeof redemptionSubmissions.$inferSelect;
type ClaimRequest = Awaited<ReturnType<typeof participationRequest>>;

/** A terminal business outcome alone does not prove the input was checked. */
export function submissionPasswordMatched(
  submission: Pick<
    SubmissionRow,
    "matchedPasswordId" | "validatedAt" | "participationMode"
  >,
): boolean | null {
  if (submission.participationMode !== "password") return null;
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
  /** What readClaimContext read of the attempt, if it did. */
  attempt?: AttemptRow,
) {
  if (attempt)
    checkAttempt(attempt, "activity", continuation, { checkCooldown: false });
  else
    await assertAttemptAllowed(env, userId, "activity", continuation, {
      checkCooldown: false,
    });
  const guard = discoveryBindingGuard(userId, continuation);
  let written: SubmissionRow | undefined;
  try {
    const results = await env.DB.batch<Record<string, unknown>>([
      ...(continuation
        ? [bindDiscoveryStatement(env, userId, continuation)]
        : []),
      env.DB.prepare(`INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, claim_id, created_at, finished_at)
        SELECT ?, ?, ?, ?, CASE WHEN ${guard.sql} THEN ? ELSE NULL END, 'claim', ?, ?, ?, ${databaseNow}, ${databaseNow}
        WHERE EXISTS (SELECT 1 FROM activities WHERE id = ? AND participation_mode = ? AND reward_type = 'ldc' AND deleted_at IS NULL)
        RETURNING *`).bind(
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
    written = tableRow(redemptionSubmissions, results.at(-1)?.results[0]);
  } catch (error) {
    const winner = await findSubmission(env, userId, submissionId);
    if (winner) return bindFingerprint(winner, fingerprint);
    await assertAttemptAllowed(env, userId, "activity", continuation, {
      checkCooldown: false,
    });
    throw error;
  }
  if (written) return written;
  const row = await findSubmission(env, userId, submissionId);
  if (!row) {
    if (!(await findActivity(env, activityId))) activityNotFound();
    throw new Error("Submission was not persisted");
  }
  return row;
}

export type Admitted = {
  activity: ActivityRow;
  testPermission: boolean;
  realActivityPermitted: boolean;
};

/**
 * What a claim's checks read (admitClaim), in one D1 batch: the 红包, this
 * submission if it came before, this person's share, the switches, their
 * attempt interval (with a 口令 found from the start page, that find),
 * what 领取范围 knows of them, and the 口令 typed. Read one after another
 * they were a round trip each (docs/claim-capacity-design.md §4).
 */
export type ClaimContext = {
  activity: ActivityRow | undefined;
  previous: SubmissionRow | undefined;
  /** This person's share of this 红包, if they have one. */
  claimId: string | null;
  controls: PlatformControls;
  attempt: AttemptRow | undefined;
  viewer: ScopeViewer | undefined;
  password: typeof activityPasswords.$inferSelect | undefined;
};

export async function readClaimContext(
  env: ApiBindings,
  activityId: string,
  userId: string,
  submissionId: string,
  request: {
    passwordDigest: string | null;
    continuation: ActivityAttempt | undefined;
  },
): Promise<ClaimContext> {
  const [activity, previous, claim, controls, attempt, viewer, password] =
    await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(
        "SELECT * FROM activities WHERE id = ? AND reward_type = 'ldc' AND deleted_at IS NULL",
      ).bind(activityId),
      env.DB.prepare(
        "SELECT * FROM redemption_submissions WHERE user_id = ? AND submission_id = ?",
      ).bind(userId, submissionId),
      env.DB.prepare(
        "SELECT id FROM claims WHERE activity_id = ? AND user_id = ?",
      ).bind(activityId, userId),
      platformControlsStatement(env),
      attemptStatement(env, userId, request.continuation),
      scopeViewerStatement(env, userId),
      // No 口令 (a direct claim): matches none.
      env.DB.prepare(
        "SELECT * FROM activity_passwords WHERE activity_id = ? AND digest = ?",
      ).bind(activityId, request.passwordDigest),
    ]);
  const first = (result: D1Result<Record<string, unknown>> | undefined) =>
    result?.results[0];
  const claimId = first(claim)?.id;
  return {
    activity: tableRow(activities, first(activity)),
    previous: tableRow(redemptionSubmissions, first(previous)),
    claimId: typeof claimId === "string" ? claimId : null,
    controls: controlsOf(first(controls)),
    attempt: first(attempt) as AttemptRow | undefined,
    viewer: first(viewer) as ScopeViewer | undefined,
    password: tableRow(activityPasswords, first(password)),
  };
}

/**
 * Everything a claim is checked for before its 口令 (or its code) is: an
 * earlier answer to this submission, the 红包 and its state, the real-LDC
 * switches, 领取范围 and the attempt interval. `{ row }` when it is
 * decided already. On what readClaimContext read: given, or read here.
 */
export async function admitClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
  submissionId: string,
  fingerprint: string,
  mode: ParticipationMode,
  continuation: ActivityAttempt | undefined,
  executionPolicy?: ActivityExecutionPolicy,
  context?: ClaimContext,
): Promise<{ row: SubmissionRow } | Admitted> {
  const read =
    context ??
    (await readClaimContext(env, activityId, userId, submissionId, {
      passwordDigest: null,
      continuation,
    }));
  const { activity, previous } = read;
  if (previous) {
    bindFingerprint(previous, fingerprint);
    if (!activity) activityNotFound();
    return { row: previous };
  }
  // A draft answers 还没开放 to anyone with its link (05 §5), as to its sender.
  if (!activity) activityNotFound();
  assertParticipationMode(activity, mode);
  if (read.claimId)
    return {
      row: await registerFinished(
        env,
        activityId,
        userId,
        submissionId,
        fingerprint,
        mode,
        "already_claimed",
        read.claimId,
        continuation,
        read.attempt,
      ),
    };
  const status = activityStatus(activity);
  if (status !== "active")
    return {
      row: await registerFinished(
        env,
        activityId,
        userId,
        submissionId,
        fingerprint,
        mode,
        status,
        null,
        continuation,
        read.attempt,
      ),
    };
  if (
    activity.rewardType === "ldc" &&
    activity.paymentMode === "simulation" &&
    !simulatesPayments(env)
  )
    throw new ActivityError(
      400,
      "SIMULATION_NOT_AVAILABLE",
      "此环境不支持新的模拟奖励领取。",
    );
  // Stage's 🐟额红包 are let through as a test's would be (controls.ts).
  const testPermission =
    permitsRealActivity(activity.id, executionPolicy) ||
    stageBalanceHongbao(env, activity.funding);
  // 三方积分 pays through its issuer, not Credit: its own gate below.
  const realActivityPermitted =
    testPermission ||
    activity.funding === "points" ||
    (activity.paymentMode === "real" && allowsRealClaim(env, read.controls));
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
  // 三方积分 paused, resting or retired: stopped before a share is taken
  // (docs/third-party-points-design.md §5).
  if (activity.funding === "points") {
    const blocked = claimBlockedBy(
      activity.pointsSystemId
        ? await readSystem(env, activity.pointsSystemId)
        : null,
    );
    if (blocked) throw new ActivityError(409, "POINTS_UNAVAILABLE", blocked);
  }
  // 领取范围: someone outside never reaches the 口令 or its cooldown.
  checkInScope(activity, read.viewer);
  checkAttempt(read.attempt, "activity", continuation);
  return { activity, testPermission, realActivityPermitted };
}

/**
 * In a submission's batch: the 红包 is still open to this person, as the
 * write sees it (a failed precondition rolls the whole batch back). A
 * 代码判定红包 paused or stopped takes none, nor anyone it settled
 * (protocol 5, docs/multi-prize-design.md §2: settled once, with or
 * without a claim).
 */
export function claimGuardStatement(
  env: ApiBindings,
  activity: ActivityRow,
  mode: ParticipationMode,
  userId: string,
  admitted: Pick<Admitted, "testPermission" | "realActivityPermitted">,
) {
  return env.DB.prepare(`UPDATE activities SET version = CASE WHEN version = ? AND participation_mode = ? AND deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL
    AND archived_at IS NULL AND deadline > ${databaseNow} AND claimed_count < total_count
    AND reward_type = 'ldc' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) AND (funding = 'points' OR (payment_mode = 'simulation' AND ?=1) OR (payment_mode = 'real' AND ? = 1 AND (?=1 OR EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_claim=1))))
    AND NOT EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
    AND NOT EXISTS (SELECT 1 FROM activity_code WHERE activity_id = activities.id AND (paused_at IS NOT NULL OR stopped_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM code_judge_people WHERE activity_id = activities.id AND user_id = ? AND settled_at IS NOT NULL)
    THEN version ELSE NULL END WHERE id = ?`).bind(
    activity.version,
    mode,
    userId,
    Number(simulatesPayments(env)),
    Number(admitted.realActivityPermitted),
    Number(admitted.testPermission),
    activity.id,
    userId,
    userId,
    activity.id,
  );
}

/** Durable validation is separate from allocation, so a process interruption cannot erase an attempt. */
export async function prepareClaimSubmission(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  executionPolicy?: ActivityExecutionPolicy,
  humanVerified = false,
  /** Its request and checks' reads, made already (admitActivityClaim). */
  given?: { request: ClaimRequest; context: ClaimContext | undefined },
): Promise<SubmissionRow> {
  const request =
    given?.request ??
    (await participationRequest(env, activityId, input, "claim"));
  const { mode, fingerprint, passwordDigest, continuation } = request;
  for (let retry = 0; retry < 4; retry += 1) {
    // After a write that lost, read again what it lost to.
    const context =
      (retry === 0 ? given?.context : undefined) ??
      (await readClaimContext(
        env,
        activityId,
        userId,
        input.submissionId,
        request,
      ));
    const admission = await admitClaim(
      env,
      activityId,
      userId,
      input.submissionId,
      fingerprint,
      mode,
      continuation,
      executionPolicy,
      context,
    );
    if ("row" in admission) return admission.row;
    const { activity, testPermission } = admission;
    const { password } = context;
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
      claimGuardStatement(env, activity, mode, userId, admission),
    ];
    // The row as written comes back with it: no read after.
    const inserted = statements.length;
    statements.push(
      env.DB.prepare(`INSERT INTO redemption_submissions
        (id, activity_id, user_id, submission_id, fingerprint, purpose, participation_mode, outcome, matched_password_id, created_at, validated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, 'claim', ?, ?, ?, ${databaseNow}, ${databaseNow}, CASE WHEN ? = 'incorrect' THEN ${databaseNow} ELSE NULL END)
        RETURNING *`).bind(
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
    );
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
      const results = await env.DB.batch<Record<string, unknown>>(statements);
      const row =
        tableRow(redemptionSubmissions, results[inserted]?.results[0]) ??
        (await findSubmission(env, userId, input.submissionId));
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
        current.funding !== "points" &&
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

export async function resultOfSubmission(
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
  // 代码判定 turned it down: its reply, if it gave one. From protocol 5
  // it was judged: what it moved and settled (judge/ledger.ts).
  if (
    submission.participationMode === "code" &&
    submission.outcome === "incorrect"
  ) {
    const judgment = await env.DB.prepare(
      "SELECT message, ledger_ciphertext IS NOT NULL AS ledgered FROM code_judgments WHERE submission_row_id = ?",
    )
      .bind(submission.id)
      .first<{ message: string | null; ledgered: number }>();
    if (judgment?.ledgered)
      return judgedResult(env, submission.id, submission.userId);
    const message = judgment?.message;
    return { result: "rejected", ...(message ? { message } : {}) };
  }
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
  return resultOfSubmission(
    env,
    await finishPending(env, submission, outcome, claimId),
  );
}

/**
 * A pending submission finished with no share (a share already, over): its
 * row as it ends, whatever finished it first.
 */
async function finishPending(
  env: ApiBindings,
  submission: SubmissionRow,
  outcome: FinishedOutcome,
  claimId: string | null = null,
) {
  const finished = await env.DB.prepare(
    `UPDATE redemption_submissions SET outcome = ?, claim_id = ?, finished_at = ${databaseNow}
      WHERE id = ? AND purpose = 'claim' AND outcome = 'pending'
      AND EXISTS (SELECT 1 FROM activities WHERE activities.id = redemption_submissions.activity_id AND reward_type = 'ldc' AND deleted_at IS NULL)
      RETURNING *`,
  )
    .bind(outcome, claimId, submission.id)
    .first<Record<string, unknown>>();
  const current =
    tableRow(redemptionSubmissions, finished) ??
    (await findSubmission(env, submission.userId, submission.submissionId));
  if (!current) throw new Error("Submission was not found");
  return current;
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
  return recipientOf(
    await createDb(env.DB)
      .select({ externalId: users.externalId, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .get(),
    mode,
  );
}

/** paymentRecipient on the account read already. */
function recipientOf(
  user: { externalId: string; username: string } | null | undefined,
  mode: "simulation" | "real",
) {
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

/**
 * A share's way to its claimant, in the batch that makes the claim: a
 * 🐟额红包's moves inside 🐟额; a 商户直发 one's payment and its outbox;
 * nothing for 自领 of a 商户直发 红包. `merchantVersion` is the merchant's
 * as read, so a retry can tell it moved. Shared by a claim and by a
 * protocol 5 settlement (judge/ledger.ts).
 */
export async function shareStatements(
  env: ApiBindings,
  activity: ActivityRow,
  share: {
    claimId: string;
    taskId: string;
    userId: string;
    inventoryId: string;
    amountMinor: number | null;
    /** 三方积分: the payout's id, when the caller wants to know it. */
    pointsPaymentId?: string;
  },
  /** The claimant's account and the merchant, read already (a batch's). */
  known?: {
    user: { externalId: string; username: string } | null;
    merchant: { client_id: string; version: number } | null;
  },
) {
  let merchantVersion: number | null = null;
  const statements: D1PreparedStatement[] = [];
  // A 🐟额红包's share moves inside 🐟额 in this same batch, with no
  // payment (docs/balance-design.md §14).
  if (activity.funding === "balance")
    statements.push(
      ...claimStatements(
        env,
        activity.id,
        share.claimId,
        share.userId,
        share.inventoryId,
      ),
    );
  // 三方积分: a payout through the issuer, sent from the queue
  // (docs/third-party-points-design.md §5); 自领 has none.
  else if (activity.funding === "points") {
    if (activity.authorId !== share.userId) {
      if (!activity.pointsSystemId || share.amountMinor === null)
        throw new Error("Points claim identity is incomplete");
      const recipient = known
        ? recipientOf(known.user, "real")
        : await paymentRecipient(env, share.userId, "real");
      statements.push(
        pointsPaymentStatement(env, {
          id: share.pointsPaymentId ?? pointsPaymentId(),
          claimId: share.claimId,
          activityId: activity.id,
          systemId: activity.pointsSystemId,
          authorId: activity.authorId,
          userId: share.userId,
          recipient: { externalId: recipient.id, username: recipient.username },
          inventoryId: share.inventoryId,
        }),
      );
    }
  }
  // 自领 of a 商户直发 红包: no payment, its share never leaves the
  // merchant (docs/self-claim-design.md; payment_claim_policy_insert
  // refuses one to the sender anyway).
  else if (
    activity.rewardType === "ldc" &&
    activity.authorId !== share.userId
  ) {
    if (!activity.paymentMode)
      throw new Error("LDC activity has no payment mode");
    const recipient = known
      ? recipientOf(known.user, activity.paymentMode)
      : await paymentRecipient(env, share.userId, activity.paymentMode);
    const merchant = known
      ? known.merchant
      : await env.DB.prepare(
          "SELECT client_id,version FROM merchants WHERE id=? AND author_id=? AND mode=?",
        )
          .bind(activity.merchantId, activity.authorId, activity.paymentMode)
          .first<{ client_id: string; version: number }>();
    if (!merchant || share.amountMinor === null || !activity.merchantId)
      throw new Error("LDC claim identity is incomplete");
    merchantVersion = merchant.version;
    const businessNo = paymentBusinessNo(share.claimId);
    const recoveryPolicy =
      activity.paymentMode === "real" ? ("claim_same_order_v1" as const) : null;
    const parameterDigest =
      recoveryPolicy === null
        ? null
        : await claimPaymentParameterDigest({
            id: share.taskId,
            claimId: share.claimId,
            source: "claim",
            acceptanceId: null,
            merchantId: activity.merchantId,
            clientId: merchant.client_id,
            businessNo,
            recipientId: recipient.id,
            recipientUsername: recipient.username,
            amountMinor: share.amountMinor,
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
        share.taskId,
        share.claimId,
        activity.merchantId,
        activity.merchantId,
        activity.authorId,
        activity.paymentMode,
        merchant.version,
        businessNo,
        recipient.id,
        recipient.username,
        activity.id,
        share.inventoryId,
        activity.paymentMode,
        recoveryPolicy,
        parameterDigest,
      ),
      env.DB.prepare(
        `INSERT INTO payment_outbox (id, task_id, created_at) VALUES (?, ?, ${databaseNow})`,
      ).bind(crypto.randomUUID(), share.taskId),
    );
  }
  return { statements, merchantVersion };
}

export async function completeClaimSubmission(
  env: ApiBindings,
  admitted: SubmissionRow,
  executionPolicy?: ActivityExecutionPolicy,
): Promise<ClaimResult> {
  const allocated = await allocateClaimSubmission(
    env,
    admitted,
    executionPolicy,
  );
  return allocated === "allocated" ? claimAnswer(env, admitted) : allocated;
}

/**
 * A claim from the 社区小程序 (mini/routes.ts) to its 红包's DO, which
 * writes its share saying so (claims.via) and answers with
 * VIA_WRITTEN_HEADER when it did; otherwise the route marks it after.
 */
export const VIA_HEADER = "X-Hb-Via";
export const VIA_WRITTEN_HEADER = "X-Hb-Via-Written";

/** At most this many shares are written in one turn of a 红包's line. */
export const CLAIM_BATCH = 20;

/**
 * What a batch made of each: its answer; its share written, with others
 * (`written`, its claim: answered with them, claimAnswers) or alone
 * ("allocated": its answer read after, claimAnswer); or the error.
 */
export type BatchAllocation =
  | ClaimResult
  | "allocated"
  | { written: string }
  | { error: unknown };

/**
 * 一批一起写 for direct and 口令 claims (docs/claim-capacity-design.md §3
 * 第 1 期): the pending submissions waiting in a 红包's line, their shares
 * written in one D1 batch. What they share is read once (the 红包, the
 * switches, the next shares), what is each one's own at the same time (its
 * submission, whether this person has a share, its payment). Each keeps its
 * own guards, as written alone; one that fails rolls the batch back, and
 * then each is written alone (allocateClaimSubmission), in order. One that
 * is decided already (finished, a share already), a second of one person,
 * or one past the shares left goes alone too. Answers in the given order.
 */
export async function allocateClaimBatch(
  env: ApiBindings,
  admitted: SubmissionRow[],
  /** Sent from the 社区小程序: their claims say so (claims.via). */
  mini: ReadonlySet<string> = new Set(),
): Promise<BatchAllocation[]> {
  const viaOf = (submission: SubmissionRow) =>
    mini.has(submission.id) ? ("mini" as const) : undefined;
  const alone = async (submission: SubmissionRow): Promise<BatchAllocation> => {
    try {
      return await allocateClaimSubmission(
        env,
        submission,
        undefined,
        viaOf(submission),
      );
    } catch (error) {
      return { error };
    }
  };
  const answers: (BatchAllocation | undefined)[] = admitted.map(
    () => undefined,
  );
  const each = async (indexes: number[]) => {
    for (const index of indexes)
      answers[index] = await alone(admitted[index] as SubmissionRow);
  };
  const activityId = admitted[0]?.activityId;
  if (
    admitted.length < 2 ||
    !activityId ||
    admitted.some((submission) => submission.activityId !== activityId)
  ) {
    await each(admitted.map((_, index) => index));
    return answers as BatchAllocation[];
  }
  const claimants = [
    ...new Set(admitted.map((submission) => submission.userId)),
  ];
  const marks = (count: number) => Array(count).fill("?").join(",");
  // The turn's reads in one round trip (docs/claim-capacity-design.md §4).
  const [
    activityRead,
    submissionsRead,
    claimedRead,
    controlsRead,
    availableRead,
    usersRead,
    merchantRead,
  ] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      "SELECT * FROM activities WHERE id = ? AND reward_type = 'ldc' AND deleted_at IS NULL",
    ).bind(activityId),
    env.DB.prepare(
      `SELECT * FROM redemption_submissions WHERE id IN (${marks(admitted.length)})`,
    ).bind(...admitted.map((submission) => submission.id)),
    env.DB.prepare(
      `SELECT user_id FROM claims WHERE activity_id = ? AND user_id IN (${marks(claimants.length)})`,
    ).bind(activityId, ...claimants),
    platformControlsStatement(env),
    // The next shares in order; an old 拼手气 (random, no queue) draws
    // among all left.
    env.DB.prepare(`SELECT inventory.id, inventory.amount_minor FROM reward_inventory inventory
      WHERE inventory.activity_id = ? AND inventory.kind = 'ldc' AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.activity_id = inventory.activity_id AND claims.inventory_id = inventory.id)
      ORDER BY inventory.position
      LIMIT CASE WHEN EXISTS (SELECT 1 FROM activities WHERE id = ? AND allocation = 'random' AND random_version IS NULL) THEN -1 ELSE ? END`).bind(
      activityId,
      activityId,
      admitted.length,
    ),
    env.DB.prepare(
      `SELECT id, external_id, username FROM users WHERE id IN (${marks(claimants.length)})`,
    ).bind(...claimants),
    env.DB.prepare(`SELECT m.client_id, m.version FROM activities a
      JOIN merchants m ON m.id = a.merchant_id AND m.author_id = a.author_id AND m.mode = a.payment_mode
      WHERE a.id = ?`).bind(activityId),
  ]);
  const activity = tableRow(activities, activityRead?.results[0]);
  if (
    !activity ||
    activityStatus(activity) !== "active" ||
    activity.participationMode === "code" ||
    (activity.rewardType === "ldc" &&
      activity.paymentMode === "simulation" &&
      !simulatesPayments(env))
  ) {
    await each(admitted.map((_, index) => index));
    return answers as BatchAllocation[];
  }
  const testPermission = stageBalanceHongbao(env, activity.funding);
  const pickedAtRandom =
    activity.allocation === "random" && activity.randomVersion === null;
  const current = (submissionsRead?.results ?? []).flatMap((raw) => {
    const row = tableRow(redemptionSubmissions, raw);
    return row ? [row] : [];
  });
  const claimed = (claimedRead?.results ?? []) as { user_id: string }[];
  const available = (availableRead?.results ?? []) as {
    id: string;
    amount_minor: number | null;
  }[];
  const accounts = new Map(
    (
      (usersRead?.results ?? []) as {
        id: string;
        external_id: string;
        username: string;
      }[]
    ).map((user) => [
      user.id,
      { externalId: user.external_id, username: user.username },
    ]),
  );
  const merchant =
    (merchantRead?.results[0] as
      | { client_id: string; version: number }
      | undefined) ?? null;
  // 三方积分 pays through its issuer, not Credit: its own gate.
  const realActivityPermitted =
    testPermission ||
    activity.funding === "points" ||
    (activity.paymentMode === "real" &&
      allowsRealClaim(env, controlsOf(controlsRead?.results[0])));
  if (activity.paymentMode === "real" && !realActivityPermitted) {
    await each(admitted.map((_, index) => index));
    return answers as BatchAllocation[];
  }
  const byId = new Map(current.map((row) => [row.id, row]));
  const taken = new Set(claimed.map((row) => row.user_id));
  const shares = [...available];
  if (pickedAtRandom)
    // An old 拼手气 draws among all left: shuffle, then take in order.
    for (let index = shares.length - 1; index > 0; index -= 1) {
      const other = randomIndex(index + 1);
      [shares[index], shares[other]] = [
        shares[other] as (typeof shares)[number],
        shares[index] as (typeof shares)[number],
      ];
    }
  const batched: { index: number; submission: SubmissionRow }[] = [];
  const later: number[] = [];
  const people = new Set<string>();
  admitted.forEach((given, index) => {
    const submission = byId.get(given.id);
    if (
      submission?.outcome !== "pending" ||
      submission.purpose !== "claim" ||
      taken.has(submission.userId) ||
      people.has(submission.userId) ||
      batched.length >= shares.length
    )
      later.push(index);
    else {
      people.add(submission.userId);
      batched.push({ index, submission });
    }
  });
  if (batched.length < 2) {
    await each(
      [...batched.map((item) => item.index), ...later].sort((a, b) => a - b),
    );
    return answers as BatchAllocation[];
  }
  // Claims written together may share their claimed_at; the 名单 orders
  // ties by id, so the ids rise in line order, as the shares do.
  const claimIds = batched.map(() => crypto.randomUUID()).sort();
  // Each one's writes; one that cannot be made (its recipient, say) is
  // written alone after, and the rest go on together.
  const prepared = await Promise.allSettled(
    batched.map(async ({ submission }, order) => {
      const reward = shares[order] as (typeof shares)[number];
      const claimId = claimIds[order] as string;
      const way = await shareStatements(
        env,
        activity,
        {
          claimId,
          taskId: crypto.randomUUID(),
          userId: submission.userId,
          inventoryId: reward.id,
          amountMinor: reward.amount_minor,
        },
        { user: accounts.get(submission.userId) ?? null, merchant },
      );
      return [
        ...allocationStatements(env, activity, submission, {
          claimId,
          reward,
          coded: false,
          realActivityPermitted,
          testPermission,
          place: order,
          via: viaOf(submission),
        }),
        ...way.statements,
      ];
    }),
  );
  const together = batched.flatMap((item, order) =>
    prepared[order]?.status === "fulfilled"
      ? [{ ...item, claimId: claimIds[order] as string }]
      : [],
  );
  later.push(
    ...batched
      .filter((_, order) => prepared[order]?.status !== "fulfilled")
      .map((item) => item.index),
  );
  try {
    if (together.length > 0)
      await env.DB.batch(
        prepared.flatMap((one) =>
          one.status === "fulfilled" ? one.value : [],
        ),
      );
    for (const { index, claimId } of together)
      answers[index] = { written: claimId };
  } catch {
    // One of them could not go along: each alone, in order, as before.
    later.push(...together.map((item) => item.index));
  }
  await each(later.sort((a, b) => a - b));
  return answers as BatchAllocation[];
}

/** A person's direct or 口令 claims of this 红包 checked and still pending. */
export async function pendingClaimsOf(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  return createDb(env.DB)
    .select()
    .from(redemptionSubmissions)
    .where(
      and(
        eq(redemptionSubmissions.activityId, activityId),
        eq(redemptionSubmissions.userId, userId),
        eq(redemptionSubmissions.purpose, "claim"),
        eq(redemptionSubmissions.outcome, "pending"),
        inArray(redemptionSubmissions.participationMode, [
          "direct",
          "password",
        ]),
      ),
    )
    .orderBy(redemptionSubmissions.createdAt)
    .all();
}

/**
 * 取消排队: this person's direct or 口令 claims of this 红包 still waiting
 * for their shares (pending) are finished as cancelled, so nothing
 * (resumePendingActivityClaims included) takes one for them later. How
 * many: none when each was finished meanwhile (its share written).
 */
export async function cancelPendingClaims(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const result = await env.DB.prepare(
    `UPDATE redemption_submissions SET outcome = 'cancelled', finished_at = ${databaseNow}
      WHERE activity_id = ? AND user_id = ? AND purpose = 'claim' AND outcome = 'pending'
        AND participation_mode IN ('direct', 'password')`,
  )
    .bind(activityId, userId)
    .run();
  return result.meta.changes;
}

/**
 * A submission's answer once allocateClaimSubmission is through: read only,
 * so it needs no turn in the 红包's line. Still pending (its tries ran out):
 * to be sent again as it was.
 */
export async function claimAnswer(env: ApiBindings, admitted: SubmissionRow) {
  const final = await findSubmission(
    env,
    admitted.userId,
    admitted.submissionId,
  );
  if (final && final.outcome !== "pending")
    return resultOfSubmission(env, final);
  throw new ActivityError(503, "ACTIVITY_BUSY", "领取繁忙，请使用原提交重试");
}

/** A claim's answer, with its person's attempt interval as of then. */
export type ClaimAnswer = {
  result: ClaimResult;
  cooldown: AttemptCooldown | undefined;
};

/**
 * The answers of shares written together (allocateClaimBatch's `written`),
 * read once for all of them, after the turn and outside the line: their
 * claims and payments, and each person's attempt interval. One by one they
 * were five reads each (docs/claim-capacity-design.md §4). By submission.
 */
export async function claimAnswers(
  env: ApiBindings,
  written: { submission: SubmissionRow; claimId: string }[],
) {
  const [rows, cooldowns] = await Promise.all([
    createDb(env.DB)
      .select({ claim: claims, activity: activities })
      .from(claims)
      .innerJoin(activities, eq(activities.id, claims.activityId))
      .where(
        and(
          inArray(
            claims.id,
            written.map((one) => one.claimId),
          ),
          eq(activities.rewardType, "ldc"),
          isNull(activities.deletedAt),
        ),
      ),
    readAttemptCooldowns(
      env,
      written.map((one) => one.submission.userId),
    ),
  ]);
  const details = await claimDetailsBatch(env, rows);
  const answers = new Map<string, ClaimAnswer>();
  for (const { submission, claimId } of written) {
    const claim = details.get(claimId);
    if (claim)
      answers.set(submission.id, {
        result: {
          result: "claimed",
          passwordMatched: submissionPasswordMatched(submission),
          claim,
        },
        cooldown: cooldowns.get(submission.userId),
      });
  }
  return answers;
}

/**
 * Refused at its share while new claims are paused: its submission is kept,
 * checked and pending, and finished when claims reopen
 * (resumePendingActivityClaims), so the answer says so.
 */
const KEPT_WHILE_PAUSED =
  "新领取暂时关闭。你这次领取已经记下，恢复后会自动补完，结果在红包记录里看得到。";

/**
 * One share's writes, with its own guards (the 红包 still takes it, this
 * person has none, the submission is pending and checked): alone
 * (allocateClaimSubmission) or with others in one batch (allocateClaimBatch),
 * the same. Its payment or 🐟额 move is added by shareStatements.
 */
function allocationStatements(
  env: ApiBindings,
  activity: ActivityRow,
  submission: SubmissionRow,
  share: {
    claimId: string;
    reward: { id: string; amount_minor: number | null };
    coded: boolean;
    realActivityPermitted: boolean;
    testPermission: boolean;
    /**
     * Its place in a batch: claimed this many ms after the batch's moment,
     * so claims written together keep line order and one 手速王.
     */
    place?: number;
    /** Taken in the 社区小程序 (claims.via), said by the claim itself. */
    via?: "mini";
  },
) {
  const {
    claimId,
    reward,
    coded,
    realActivityPermitted,
    testPermission,
    place = 0,
    via,
  } = share;
  return [
    env.DB.prepare(`UPDATE activities SET version = CASE WHEN deleted_at IS NULL AND opened_at IS NOT NULL AND ended_at IS NULL AND archived_at IS NULL
          AND deadline > ${databaseNow} AND claimed_count < total_count
          AND reward_type = 'ldc' AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) AND ((funding = 'points' AND EXISTS(SELECT 1 FROM points_systems ps WHERE ps.id=activities.points_system_id AND ps.status='online') AND ?=?)
            OR ((funding = 'balance' OR merchant_id IS NOT NULL) AND ((payment_mode = 'simulation' AND ?=1) OR (payment_mode = 'real' AND ? = 1 AND (?=1 OR EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_claim=1))))))
          AND NOT EXISTS (SELECT 1 FROM claims WHERE activity_id = ? AND user_id = ?)
          AND EXISTS (SELECT 1 FROM redemption_submissions s WHERE s.id = ? AND s.activity_id=activities.id
            AND s.user_id=? AND s.purpose = 'claim' AND s.outcome = 'pending'
            AND s.participation_mode=activities.participation_mode AND s.validated_at IS NOT NULL
            AND ((s.participation_mode='password' AND s.matched_password_id IS NOT NULL)
              OR (s.participation_mode='direct' AND s.matched_password_id IS NULL)
              OR (s.participation_mode='code' AND s.matched_password_id IS NULL
                AND EXISTS (SELECT 1 FROM code_judgments j WHERE j.submission_row_id = s.id AND j.ok = 1))))
          THEN version ELSE NULL END WHERE id = ?`).bind(
      submission.userId,
      // The 三方积分 branch's placeholder pair (keeps the order below).
      1,
      1,
      Number(simulatesPayments(env)),
      Number(realActivityPermitted),
      Number(testPermission),
      activity.id,
      submission.userId,
      submission.id,
      submission.userId,
      activity.id,
    ),
    ...(coded
      ? [
          env.DB.prepare(`INSERT INTO reward_inventory (id, activity_id, position, kind, ciphertext, amount_minor, created_at)
              SELECT ?, id, claimed_count, 'ldc', NULL, ?, ${databaseNow} FROM activities WHERE id = ?`).bind(
            reward.id,
            reward.amount_minor,
            activity.id,
          ),
        ]
      : []),
    env.DB.prepare(
      // After every claim of this 红包 before it, a batch's and one alone
      // alike, even when turns come quicker than a batch's places
      // (claims_activity_time_idx: one row read).
      `INSERT INTO claims (id, activity_id, user_id, inventory_id, password_id, claimed_at, via)
        VALUES (?, ?, ?, ?, ?, MAX(${databaseNow} + ?, COALESCE((SELECT MAX(claimed_at) FROM claims WHERE activity_id = ?), 0) + 1), ?)`,
    ).bind(
      claimId,
      activity.id,
      submission.userId,
      reward.id,
      submission.matchedPasswordId,
      place,
      activity.id,
      via ?? null,
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
}

/**
 * completeClaimSubmission's share, without its answer: "allocated" when its
 * answer is to be read (claimAnswer), outside the 红包's line
 * (durable-objects.ts claimOne); the answer itself when one finished it
 * otherwise (a share already, over, finished before).
 */
export async function allocateClaimSubmission(
  env: ApiBindings,
  admitted: SubmissionRow,
  executionPolicy?: ActivityExecutionPolicy,
  /** Taken in the 社区小程序 (claims.via). */
  via?: "mini",
): Promise<ClaimResult | "allocated"> {
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
      !simulatesPayments(env)
    )
      throw new ActivityError(
        400,
        "SIMULATION_NOT_AVAILABLE",
        "此环境不支持新的模拟奖励领取。",
      );
    // 代码判定: the share is made now, as its judgment paid (judge/claims.ts).
    const coded = activity.participationMode === "code";
    // Only an old 拼手气 draws among all shares left; a v2 queue hands out
    // its shares in order (开奖证明): the k-th claim takes the k-th, so one
    // row is read, not every share left.
    const pickedAtRandom =
      activity.allocation === "random" && activity.randomVersion === null;
    const paid = coded
      ? await env.DB.prepare(
          "SELECT paid_minor FROM code_judgments WHERE submission_row_id = ? AND ok = 1",
        )
          .bind(submission.id)
          .first<number>("paid_minor")
      : null;
    if (coded && paid === null)
      throw new Error("A code-judged claim has no judgment");
    const available = coded
      ? { results: [{ id: crypto.randomUUID(), amount_minor: paid }] }
      : await env.DB.prepare(`SELECT inventory.id, inventory.amount_minor FROM reward_inventory inventory
      WHERE inventory.activity_id = ? AND inventory.kind = 'ldc' AND NOT EXISTS (SELECT 1 FROM claims WHERE claims.activity_id = inventory.activity_id AND claims.inventory_id = inventory.id)
      ORDER BY inventory.position${pickedAtRandom ? "" : " LIMIT 1"}`)
          .bind(activity.id)
          .all<{ id: string; amount_minor: number | null }>();
    const reward =
      available.results.find((item) => item.id === selectedInventoryId) ??
      available.results[
        pickedAtRandom ? randomIndex(available.results.length || 1) : 0
      ];
    if (!reward)
      throw new ActivityError(
        503,
        "INVENTORY_INCONSISTENT",
        "奖励库存暂时不可用，请使用原提交重试",
      );
    selectedInventoryId = reward.id;
    const testPermission =
      permitsRealActivity(activity.id, executionPolicy) ||
      stageBalanceHongbao(env, activity.funding);
    const realActivityPermitted =
      testPermission ||
      activity.funding === "points" ||
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
        KEPT_WHILE_PAUSED,
      );
    const claimId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const statements = allocationStatements(env, activity, submission, {
      claimId,
      reward,
      coded,
      realActivityPermitted,
      testPermission,
      via,
    });
    const way = await shareStatements(env, activity, {
      claimId,
      taskId,
      userId: submission.userId,
      inventoryId: reward.id,
      amountMinor: reward.amount_minor,
    });
    statements.push(...way.statements);
    const paymentMerchantVersion = way.merchantVersion;
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
        latest.funding !== "points" &&
        !testPermission &&
        !allowsRealClaim(env, await readPlatformControls(env))
      )
        throw new ActivityError(
          409,
          "REAL_LDC_CLAIMS_PAUSED",
          KEPT_WHILE_PAUSED,
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
    return "allocated";
  }
  return "allocated";
}

/**
 * A direct or 口令 claim whose answer is decided already: this person has a
 * share, or the 红包 is over (ended, archived, all taken or past its
 * deadline). Neither turns back, so the 红包's DO answers it without a
 * turn in its line (durable-objects.ts claimInLine). One read; never a
 * timed draw, a 代码判定红包 or one not open yet.
 */
export async function claimDecided(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const row = await env.DB.prepare(`SELECT 1 AS decided FROM activities a
    WHERE a.id = ? AND a.reward_type = 'ldc' AND a.deleted_at IS NULL AND a.opened_at IS NOT NULL
      AND a.participation_mode IN ('direct', 'password') AND a.draw_state IS NULL
      AND COALESCE(json_extract(a.config, '$.money.mode'), '') != 'timed_draw'
      AND (EXISTS(SELECT 1 FROM claims c WHERE c.activity_id = a.id AND c.user_id = ?)
        OR ${activityStatusCaseSql(Date.now(), "a")} != 'active')`)
    .bind(activityId, userId)
    .first<{ decided: number }>();
  return row !== null;
}

/**
 * claimActivity's checks, which need not wait in the 红包's line: the
 * submission is checked and kept, pending or (decided there: a share
 * already, over, a wrong 口令, sent before) finished, and only its share
 * is handed out in the line (completeClaimSubmission, as for one an
 * interruption left pending). What it reads is read once, in one batch
 * (readClaimContext). Null for what goes the whole way in the line: a
 * 代码判定 claim, a 红包 not open yet (a timed opening opens there) or a
 * timed draw.
 */
export async function admitActivityClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  humanVerified: boolean,
) {
  if (input.participationMode === "code") return null;
  const request = await participationRequest(env, activityId, input, "claim");
  const context = await readClaimContext(
    env,
    activityId,
    userId,
    input.submissionId,
    request,
  );
  const { activity } = context;
  if (
    !activity ||
    activity.openedAt === null ||
    activity.drawState !== null ||
    context.previous?.purpose === "register" ||
    (activity.rewardType === "ldc" &&
      JSON.parse(activity.config).money?.mode === "timed_draw")
  )
    return null;
  // Only a lifecycle behind its clock (past its deadline and not marked
  // ended, or due to be archived) has anything to write: written first,
  // and then read again. One running, or marked already, has none.
  const status = activityStatus(activity);
  const behind =
    (status === "ended" && activity.endedAt === null) ||
    (status === "archived" && activity.archivedAt === null);
  if (behind) await refreshActivityLifecycle(env, activityId);
  const submission = await prepareClaimSubmission(
    env,
    activityId,
    userId,
    input,
    undefined,
    humanVerified,
    { request, context: behind ? undefined : context },
  );
  // Sent again while still pending, and decided meanwhile (a share by
  // another of theirs, the 红包 over): finished here, as its turn would,
  // without waiting in the line for it.
  const decided = context.claimId
    ? "already_claimed"
    : status !== "active"
      ? status
      : null;
  return decided &&
    submission.outcome === "pending" &&
    submission.id === context.previous?.id
    ? finishPending(env, submission, decided, context.claimId)
    : submission;
}

export async function claimActivity(
  env: ApiBindings,
  activityId: string,
  userId: string,
  input: ClaimActivityInput,
  executionPolicy?: ActivityExecutionPolicy,
  /** The API route checked a Turnstile token for this 红包 (human-check.ts). */
  humanVerified = false,
  /** 代码判定: told when its code's failures pause it; 联网 (session.ts). */
  hooks: JudgeHooks = {},
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
  if (input.participationMode === "code") {
    const { claimByCode } = await import("../judge/claims");
    return claimByCode(
      env,
      activityId,
      userId,
      input,
      executionPolicy,
      humanVerified,
      hooks,
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
  /** Submissions waiting in the 红包's line, whose turn writes them. */
  waiting: ReadonlySet<string> = new Set(),
  /** Told of each person whose claim it finished (their pages read it). */
  finished: (userId: string) => void = () => {},
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
    if (waiting.has(submission.id)) continue;
    try {
      await completeClaimSubmission(env, submission);
      finished(submission.userId);
    } catch (error) {
      console.error("claim_recovery_error", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return pending.length;
}
