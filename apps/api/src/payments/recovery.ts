import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { merchants, paymentDuplicateProbes, paymentTasks } from "../db/schema";
import type { ApiBindings } from "../env";
import { allowsRealSending, readPlatformControls } from "../runtime/controls";
import { encryptString } from "../security/crypto";
import {
  type AdapterResult,
  ensureEvidenceMatchesTask,
  ensureQueryEvidenceMatchesTask,
  type PaymentAdapter,
  type PaymentTaskRow,
} from "./adapter";
import {
  credentialRejectionStatement,
  loadMerchantSecret,
} from "./credentials";
import {
  type EffectivePaymentTaskRow,
  effectiveClaimPaymentTask,
  merchantOwnsClientId,
  paymentIdentitySnapshotGuard,
  synchronizeMerchantPaymentIdentities,
} from "./identity";
import {
  claimPaymentIdentitySql,
  claimPaymentParameterDigest,
  effectivePaymentTask,
  loadPaymentUsernameCorrection,
  type PaymentUsernameCorrectionRow,
  paymentParameterDigest,
  realQueryDecision,
  realSendDecision,
  runtimeRealPolicy,
  usablePaymentRetryGrant,
} from "./policy";
import { paymentRemark } from "./remark";
import type { CycleResult } from "./scheduler";

type MerchantRow = typeof merchants.$inferSelect;
type ProbeRow = typeof paymentDuplicateProbes.$inferSelect;
type Operation = "send" | "query";
const LEASE_MS = 30_000;
const PROBE_WINDOW_MS = 10 * 60_000;

function backoff(count: number, operation: Operation = "query") {
  const steps =
    operation === "query"
      ? [2_000, 5_000, 15_000, 30_000, 60_000, 300_000]
      : [10_000, 30_000, 120_000, 300_000, 900_000, 1_800_000];
  const base =
    steps[Math.max(0, Math.min(count - 1, steps.length - 1))] ??
    steps[0] ??
    2_000;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return Math.ceil(base * (0.8 + ((random[0] ?? 0) / 2 ** 32) * 0.4));
}

function queryWait(task: PaymentTaskRow, count: number, now: number) {
  return now - task.createdAt >= 86_400_000 ? 1_800_000 : backoff(count);
}

function queryDue(task: PaymentTaskRow) {
  return Math.max(
    task.nextQueryAt ?? task.nextRunAt,
    task.queryRetryAfterAt ?? 0,
  );
}

function hasOrder(task: PaymentTaskRow) {
  return (
    task.orderObservedAt !== null ||
    task.externalOrderId !== null ||
    task.sendAcknowledgedAt !== null
  );
}

function temporaryQueryFailure(result: AdapterResult) {
  return (
    result.kind === "unknown" &&
    (result.reason === "network" ||
      result.reason === "timeout" ||
      (result.reason === "http" && (result.httpStatus ?? 0) >= 500))
  );
}

async function loadTask(env: ApiBindings, id: string) {
  return createDb(env.DB)
    .select()
    .from(paymentTasks)
    .where(eq(paymentTasks.id, id))
    .get();
}

async function loadProbe(env: ApiBindings, taskId: string) {
  return createDb(env.DB)
    .select()
    .from(paymentDuplicateProbes)
    .where(eq(paymentDuplicateProbes.taskId, taskId))
    .get();
}

async function credentialPassed(
  env: ApiBindings,
  merchantId: string,
  version: number,
  clientId?: string,
) {
  return (
    (
      await env.DB.prepare(
        `SELECT verification_status FROM merchant_credentials WHERE merchant_id=? AND version=? ${clientId === undefined ? "" : "AND client_id=?"}`,
      )
        .bind(
          merchantId,
          version,
          ...(clientId === undefined ? [] : [clientId]),
        )
        .first<{ verification_status: string }>()
    )?.verification_status === "passed"
  );
}

async function attemptCredential(
  env: ApiBindings,
  taskId: string,
  clientId: string,
  operation?: Operation,
) {
  return (
    await env.DB.prepare(
      `SELECT a.credential_version FROM payment_attempts a JOIN merchant_credentials c ON c.merchant_id=(SELECT merchant_id FROM payment_tasks WHERE id=a.task_id) AND c.version=a.credential_version
       WHERE a.task_id=? AND a.purpose='recovery' AND c.client_id=? ${operation ? "AND a.operation=?" : ""} ORDER BY a.started_at DESC,a.id DESC LIMIT 1`,
    )
      .bind(taskId, clientId, ...(operation ? [operation] : []))
      .first<{ credential_version: number }>()
  )?.credential_version;
}

async function context(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
  operation: Operation,
) {
  let credentialVersion =
    task.clientId === merchant.clientId
      ? merchant.credentialVersion
      : (
          await env.DB.prepare(
            "SELECT version FROM merchant_credentials WHERE merchant_id=? AND client_id=? ORDER BY version DESC LIMIT 1",
          )
            .bind(merchant.id, task.clientId)
            .first<{ version: number }>()
        )?.version;
  if (credentialVersion === undefined)
    throw new Error("Payment credential identity missing");
  if (
    operation === "query" &&
    !(await credentialPassed(
      env,
      merchant.id,
      credentialVersion,
      task.clientId,
    ))
  ) {
    credentialVersion =
      (await attemptCredential(env, task.id, task.clientId)) ??
      credentialVersion;
  }
  let clientSecret: string | undefined;
  try {
    clientSecret = await loadMerchantSecret(
      env,
      merchant.id,
      credentialVersion,
      task.clientId,
    );
  } catch {
    clientSecret = undefined;
  }
  return {
    credentialVersion,
    clientSecret,
    clientId: task.clientId,
    remark: operation === "send" ? await paymentRemark(env, task) : undefined,
  };
}

async function diagnostic(
  env: ApiBindings,
  taskId: string,
  attemptId: string,
  result: AdapterResult,
) {
  if (!result.upstreamMessage) return null;
  try {
    return await encryptString(
      result.upstreamMessage.slice(0, 512),
      env,
      `payment-diagnostic:${taskId}:${attemptId}`,
    );
  } catch {
    // A diagnostic must never prevent recording a payment outcome or fall back to plaintext.
    return null;
  }
}

async function selectTask(env: ApiBindings, merchant: MerchantRow) {
  if (merchant.activeTaskId) return loadTask(env, merchant.activeTaskId);
  const policy = runtimeRealPolicy(env);
  const queryClaims =
    env.APP_ENV === "production" &&
    (policy.networkMode === "live" || policy.networkMode === "verify");
  const sendClaims = allowsRealSending(env, await readPlatformControls(env));
  const localAcceptances =
    policy.appEnv === "local" &&
    (policy.networkMode === "verify" || policy.networkMode === "acceptance");
  const row = await env.DB.prepare(
    `SELECT p.id FROM payment_tasks p LEFT JOIN payment_acceptances a ON a.id=p.acceptance_id
     WHERE p.merchant_id=? AND p.mode='real'
       AND ((p.source='claim' AND p.recovery_policy='claim_same_order_v1' AND p.status IN ('pending','waiting','reconciling','sending') AND ((?=1 AND p.first_send_at IS NOT NULL) OR ?=1))
         OR (?=1 AND p.source='acceptance' AND ((p.status IN ('pending','waiting','reconciling','sending') AND (a.send_consumed_at IS NOT NULL OR a.id=?))
           OR (p.status='confirmed' AND EXISTS(SELECT 1 FROM payment_duplicate_probes d WHERE d.task_id=p.id AND d.status IN ('pending','sending','reconciling','awaiting_evidence'))))))
     ORDER BY p.created_at,p.id LIMIT 1`,
  )
    .bind(
      merchant.id,
      Number(queryClaims),
      Number(sendClaims),
      Number(localAcceptances),
      policy.networkMode === "acceptance" ? (policy.acceptanceId ?? "") : "",
    )
    .first<{ id: string }>();
  if (row) return loadTask(env, row.id);
  // Keep the existing fail-closed behavior for a directly invoked initial send.
  const fallback = await env.DB.prepare(
    "SELECT id FROM payment_tasks WHERE merchant_id=? AND status IN ('pending','waiting','reconciling','sending') ORDER BY created_at,id LIMIT 1",
  )
    .bind(merchant.id)
    .first<{ id: string }>();
  return fallback ? loadTask(env, fallback.id) : undefined;
}

async function permitsRecoverySend(
  env: ApiBindings,
  task: PaymentTaskRow,
  now: number,
) {
  if (task.source === "claim") {
    const effective = await effectiveClaimPaymentTask(env, task);
    const current = await env.DB.prepare(
      "SELECT client_id FROM merchants WHERE id=?",
    )
      .bind(task.merchantId)
      .first<{ client_id: string }>();
    return (
      task.recoveryPolicy === "claim_same_order_v1" &&
      task.firstSendAt !== null &&
      current?.client_id === effective.clientId &&
      (await realQueryDecision(env, task)).allowed &&
      allowsRealSending(env, await readPlatformControls(env))
    );
  }
  const retry = await usablePaymentRetryGrant(env, task, now);
  const policy = runtimeRealPolicy(env);
  return (
    retry.allowed &&
    policy.appEnv === "local" &&
    policy.networkMode === "acceptance" &&
    policy.acceptanceId === task.acceptanceId &&
    env.LDC_STOP_SENDS !== "true"
  );
}

async function operationForTask(
  env: ApiBindings,
  task: PaymentTaskRow,
  now: number,
) {
  if (task.status === "confirmed" || task.status === "attention") return null;
  if (task.attemptCount === 0 && !task.unknownOutcome && !hasOrder(task)) {
    return { operation: "send" as const, due: task.nextRunAt };
  }
  const currentCredential =
    task.nextAction === "send"
      ? await env.DB.prepare(
          "SELECT credential_version FROM merchants WHERE id=?",
        )
          .bind(task.merchantId)
          .first<{ credential_version: number }>()
      : null;
  if (
    task.nextAction === "send" &&
    task.nextSendAt !== null &&
    currentCredential &&
    (await credentialPassed(
      env,
      task.merchantId,
      currentCredential.credential_version,
    ))
  ) {
    const decision = await realSendDecision(env, task);
    if (decision.allowed)
      return { operation: "send" as const, due: task.nextSendAt };
    if (decision.reason === "not_due") {
      if (
        (await permitsRecoverySend(env, task, now)) &&
        !hasOrder(task) &&
        task.sendBlockReason === null &&
        task.queriedSendCount === task.attemptCount &&
        task.queriedRecoveryVersion === task.recoveryVersion
      ) {
        return { operation: "send" as const, due: task.nextSendAt };
      }
    }
  }
  return { operation: "query" as const, due: queryDue(task) };
}

async function probeDue(
  env: ApiBindings,
  task: PaymentTaskRow,
  probe: ProbeRow,
) {
  if (task.source !== "acceptance") return null;
  if (
    probe.status === "passed" ||
    probe.status === "conflict" ||
    probe.status === "inconclusive"
  )
    return null;
  if (probe.status === "awaiting_evidence" && probe.protocolVerifiedAt !== null)
    return null;
  if (probe.permitConsumedAt !== null) {
    return (await realQueryDecision(env, task)).allowed
      ? Math.min(
          probe.permitConsumedAt + PROBE_WINDOW_MS,
          Math.max(probe.nextRunAt, task.queryRetryAfterAt ?? 0),
        )
      : null;
  }
  const correction = await loadPaymentUsernameCorrection(env, task.id);
  if (
    correction &&
    (task.sendAcknowledgedAt === null ||
      !(await env.DB.prepare(
        "SELECT id FROM payment_attempts WHERE task_id=? AND operation='send' AND purpose='recovery' AND outcome='succeeded' AND finished_at=? AND recipient_username=? AND parameter_digest=? LIMIT 1",
      )
        .bind(
          task.id,
          task.sendAcknowledgedAt,
          correction.correctedUsername,
          correction.correctedParameterDigest,
        )
        .first()))
  )
    return null;
  const policy = runtimeRealPolicy(env);
  const grant = await usablePaymentRetryGrant(env, task, Date.now(), true);
  if (
    policy.appEnv !== "local" ||
    policy.networkMode !== "acceptance" ||
    env.LDC_STOP_SENDS === "true" ||
    policy.acceptanceId !== task.acceptanceId ||
    !grant.allowed
  )
    return null;
  return probe.nextRunAt;
}

export async function realMerchantNextDue(
  env: ApiBindings,
  merchantId: string,
): Promise<number | null> {
  const merchant = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .get();
  if (!merchant) return null;
  if (merchant.leaseUntil && merchant.leaseUntil > Date.now())
    return merchant.leaseUntil;
  const task = await selectTask(env, merchant);
  if (!task) return null;
  if (task.status === "confirmed") {
    const probe = await loadProbe(env, task.id);
    return probe ? probeDue(env, task, probe) : null;
  }
  const selection = await operationForTask(env, task, Date.now());
  if (!selection) return null;
  if (
    selection.operation === "query" &&
    !(await realQueryDecision(env, task)).allowed
  )
    return null;
  if (
    selection.operation === "send" &&
    task.attemptCount === 0 &&
    !(await realSendDecision(env, task)).allowed
  )
    return null;
  return selection.due;
}

async function recoverExpiredLease(
  env: ApiBindings,
  merchant: MerchantRow,
  now: number,
) {
  if (
    !merchant.activeTaskId ||
    !merchant.leaseToken ||
    (merchant.leaseUntil ?? Infinity) > now
  )
    return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE payment_tasks SET status='reconciling',unknown_outcome=MAX(unknown_outcome,EXISTS(SELECT 1 FROM payment_attempts x WHERE x.task_id=payment_tasks.id AND x.token=? AND x.operation='send' AND x.outcome='started')),reason='interrupted',next_action='query',next_query_at=MAX(?,COALESCE(next_query_at,0),COALESCE(query_retry_after_at,0)),next_run_at=MAX(?,COALESCE(next_query_at,0),COALESCE(query_retry_after_at,0)),queried_recovery_version=NULL,recovery_version=recovery_version+1,updated_at=?
      WHERE id=? AND status IN ('sending','reconciling') AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=? AND lease_until<=?)`).bind(
      merchant.leaseToken,
      now,
      now,
      now,
      merchant.activeTaskId,
      merchant.id,
      merchant.leaseToken,
      now,
    ),
    env.DB.prepare(
      `UPDATE payment_duplicate_probes SET status='reconciling',reason='interrupted',next_run_at=?,updated_at=? WHERE task_id=? AND permit_consumed_at IS NOT NULL AND status IN ('sending','reconciling','awaiting_evidence') AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=? AND lease_until<=?)`,
    ).bind(
      now,
      now,
      merchant.activeTaskId,
      merchant.id,
      merchant.leaseToken,
      now,
    ),
    env.DB.prepare(
      `UPDATE payment_attempts SET outcome='unknown',reason='interrupted',finished_at=? WHERE task_id=? AND token=? AND outcome='started' AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=? AND lease_until<=?)`,
    ).bind(
      now,
      merchant.activeTaskId,
      merchant.leaseToken,
      merchant.id,
      merchant.leaseToken,
      now,
    ),
    env.DB.prepare(
      "UPDATE merchants SET lease_token=NULL,lease_until=NULL,paused_reason='unknown' WHERE id=? AND lease_token=? AND lease_until<=?",
    ).bind(merchant.id, merchant.leaseToken, now),
  ]);
  console.info(
    JSON.stringify({
      event: "ldc_payment_interrupted",
      taskId: merchant.activeTaskId,
      merchantId: merchant.id,
      reason: "interrupted",
    }),
  );
}

function leaseStatement(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
  token: string,
  now: number,
) {
  return env.DB.prepare(`UPDATE merchants SET version=CASE WHEN (lease_until IS NULL OR lease_until<=?) AND (active_task_id IS NULL OR active_task_id=?) THEN version ELSE NULL END,
    active_task_id=?,lease_token=?,lease_until=?,updated_at=? WHERE id=?`).bind(
    now,
    task.id,
    task.id,
    token,
    now + LEASE_MS,
    now,
    merchant.id,
  );
}

function correctionSnapshotGuard(
  taskId: string,
  correction: PaymentUsernameCorrectionRow | null,
) {
  if (!correction)
    return {
      sql: "AND NOT EXISTS(SELECT 1 FROM payment_username_corrections WHERE task_id=?)",
      values: [taskId] as (string | number)[],
    };
  return {
    sql: "AND EXISTS(SELECT 1 FROM payment_username_corrections WHERE task_id=? AND original_username=? AND corrected_username=? AND original_parameter_digest=? AND corrected_parameter_digest=? AND created_at=?)",
    values: [
      taskId,
      correction.originalUsername,
      correction.correctedUsername,
      correction.originalParameterDigest,
      correction.correctedParameterDigest,
      correction.createdAt,
    ],
  };
}

async function beginAttempt(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
  operation: Operation,
  token: string,
  attemptId: string,
  credentialVersion: number,
  now: number,
  correction: PaymentUsernameCorrectionRow | null,
  sendTask: EffectivePaymentTaskRow,
) {
  const decision =
    operation === "send"
      ? await realSendDecision(env, task)
      : await realQueryDecision(env, task);
  if (!decision.allowed) {
    if (task.source === "claim") return false;
    throw new Error("REAL_LDC_NOT_ENABLED");
  }
  if (
    operation === "send" &&
    !(await credentialPassed(
      env,
      merchant.id,
      credentialVersion,
      sendTask.clientId,
    ))
  ) {
    if (task.source === "claim") return false;
    throw new Error("REAL_LDC_CREDENTIALS_NOT_VERIFIED");
  }
  const statements = [leaseStatement(env, merchant, task, token, now)];
  let sendGuard = "";
  const guardValues: (number | string)[] = [];
  if (operation === "send" && decision.source === "claim") {
    const isFirstSend = task.firstSendAt === null;
    sendGuard = `AND parameter_digest=? AND ${claimPaymentIdentitySql("payment_tasks")}
      AND EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND version=? AND allow_real_send=1)
      AND ${isFirstSend ? "first_send_at IS NULL AND attempt_count=0 AND unknown_outcome=0 AND order_observed_at IS NULL AND external_order_id IS NULL AND send_acknowledged_at IS NULL" : "first_send_at IS NOT NULL AND order_observed_at IS NULL AND external_order_id IS NULL AND send_acknowledged_at IS NULL AND send_block_reason IS NULL AND next_action='send' AND next_send_at<=? AND queried_send_count=attempt_count AND queried_recovery_version=recovery_version"}`;
    guardValues.push(
      task.parameterDigest ?? "",
      decision.controlsVersion ?? -1,
    );
    if (!isFirstSend) guardValues.push(now);
  } else if (
    operation === "send" &&
    decision.source === "acceptance" &&
    decision.grant
  ) {
    const grant = decision.grant;
    statements.push(
      env.DB.prepare(
        `UPDATE payment_retry_grants SET used_additional_sends=CASE WHEN used_additional_sends=? AND revoked_at IS NULL AND expires_at>? AND used_additional_sends<max_additional_sends AND parameter_digest=? THEN used_additional_sends+1 ELSE NULL END WHERE task_id=?`,
      ).bind(grant.usedAdditionalSends, now, grant.parameterDigest, task.id),
    );
    sendGuard = `AND order_observed_at IS NULL AND external_order_id IS NULL AND send_acknowledged_at IS NULL AND send_block_reason IS NULL AND next_action='send' AND next_send_at<=?
      AND queried_send_count=attempt_count AND queried_recovery_version=recovery_version
      AND EXISTS(SELECT 1 FROM payment_retry_grants g WHERE g.task_id=payment_tasks.id AND g.used_additional_sends=? AND g.revoked_at IS NULL AND g.expires_at>? AND g.parameter_digest=?)`;
    guardValues.push(
      now,
      grant.usedAdditionalSends + 1,
      now,
      grant.parameterDigest,
    );
  } else if (operation === "send" && decision.source === "acceptance") {
    statements.push(
      env.DB.prepare(
        `UPDATE payment_acceptances SET amount_minor=CASE WHEN send_consumed_at IS NULL THEN amount_minor ELSE NULL END,send_consumed_at=? WHERE id=?`,
      ).bind(now, task.acceptanceId),
    );
    sendGuard =
      "AND attempt_count=0 AND unknown_outcome=0 AND EXISTS(SELECT 1 FROM payment_acceptances a WHERE a.id=payment_tasks.acceptance_id AND a.send_consumed_at=?)";
    guardValues.push(now);
  }
  if (operation === "send") {
    sendGuard += ` AND EXISTS(SELECT 1 FROM merchants m JOIN merchant_credentials c ON c.merchant_id=m.id
        WHERE m.id=payment_tasks.merchant_id AND c.version=? AND c.client_id=? AND c.verification_status='passed'
        ${task.source === "claim" ? "AND m.client_id=c.client_id AND m.credential_version=c.version" : ""})`;
    guardValues.push(credentialVersion, sendTask.clientId);
    const snapshot = correctionSnapshotGuard(task.id, correction);
    sendGuard += ` ${snapshot.sql}`;
    guardValues.push(...snapshot.values);
  }
  const identitySnapshot = paymentIdentitySnapshotGuard(task.id, sendTask);
  sendGuard += ` ${identitySnapshot.sql}`;
  guardValues.push(...identitySnapshot.values);
  statements.push(
    env.DB.prepare(`UPDATE payment_tasks SET amount_minor=CASE WHEN status=? AND recovery_version=? AND attempt_count=? AND reconciliation_count=? ${sendGuard} THEN amount_minor ELSE NULL END,
      status=?,first_send_at=CASE WHEN source='claim' AND ?=1 THEN COALESCE(first_send_at,?) ELSE first_send_at END,next_action='query',recovery_version=recovery_version+1,attempt_count=attempt_count+?,reconciliation_count=reconciliation_count+?,send_backoff_count=send_backoff_count+?,next_send_at=CASE WHEN ?=1 THEN ? ELSE next_send_at END,query_backoff_count=query_backoff_count+?,next_query_at=MAX(?,COALESCE(query_retry_after_at,0)),updated_at=? WHERE id=?`).bind(
      task.status,
      task.recoveryVersion,
      task.attemptCount,
      task.reconciliationCount,
      ...guardValues,
      operation === "send" ? "sending" : "reconciling",
      Number(operation === "send"),
      now,
      Number(operation === "send"),
      Number(operation === "query"),
      Number(operation === "send"),
      Number(operation === "send"),
      now + backoff(task.sendBackoffCount + 1, "send"),
      Number(operation === "query"),
      now + queryWait(task, task.queryBackoffCount + 1, now),
      now,
      task.id,
    ),
    env.DB.prepare(
      "INSERT INTO payment_attempts(id,task_id,token,operation,purpose,outcome,credential_version,started_at,recipient_username,parameter_digest,client_id,identity_correction_version) VALUES(?,?,?,?,'recovery','started',?,?,?,?,?,?)",
    ).bind(
      attemptId,
      task.id,
      token,
      operation,
      credentialVersion,
      now,
      operation === "send" ? sendTask.recipientUsername : null,
      task.source === "claim"
        ? await claimPaymentParameterDigest(sendTask)
        : await paymentParameterDigest(sendTask),
      sendTask.clientId,
      sendTask.identityCorrectionVersion ?? 0,
    ),
  );
  try {
    await env.DB.batch(statements);
    return true;
  } catch (error) {
    const currentTask = await loadTask(env, task.id);
    const currentMerchant = await createDb(env.DB)
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchant.id))
      .get();
    if (
      currentTask?.recoveryVersion !== task.recoveryVersion ||
      (currentMerchant?.leaseToken && currentMerchant.leaseToken !== token) ||
      (currentMerchant?.activeTaskId &&
        currentMerchant.activeTaskId !== task.id)
    )
      return false;
    if (task.source === "claim" && operation === "send") {
      const currentDecision = await realSendDecision(env, task);
      if (
        !currentDecision.allowed ||
        currentDecision.source !== "claim" ||
        (decision.source === "claim" &&
          currentDecision.controlsVersion !== decision.controlsVersion) ||
        currentMerchant?.credentialVersion !== credentialVersion ||
        currentMerchant?.clientId !== sendTask.clientId ||
        !(await credentialPassed(
          env,
          merchant.id,
          credentialVersion,
          sendTask.clientId,
        ))
      )
        return false;
    }
    throw error;
  }
}

async function finishAttempt(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
  operation: Operation,
  token: string,
  attemptId: string,
  credentialVersion: number,
  attemptStartedAt: number,
  result: AdapterResult,
  requestTask: PaymentTaskRow,
) {
  const now = Date.now();
  let status: PaymentTaskRow["status"] = "reconciling";
  let reason: string =
    "reason" in result ? (result.reason ?? "unknown") : "unknown";
  let unknown = operation === "send" ? true : task.unknownOutcome;
  let externalOrderId = task.externalOrderId;
  let observedAt = task.orderObservedAt;
  let orderEvidence = task.orderEvidence;
  let acknowledgedAt = task.sendAcknowledgedAt;
  let sendBlock = task.sendBlockReason;
  let nextSend = task.nextSendAt;
  let nextQuery = now + queryWait(task, task.queryBackoffCount + 1, now);
  let queryRetryAfter = task.queryRetryAfterAt;
  let nextAction: PaymentTaskRow["nextAction"] = "query";
  let outcome = "unknown";
  let sendBackoff = task.sendBackoffCount;
  let queryBackoff = task.queryBackoffCount;
  const noOrderEvidence =
    operation === "send" &&
    result.noOrderEvidence === "protocol_rejection_v1" &&
    (result.kind === "waiting" || result.kind === "rejected")
      ? result.noOrderEvidence
      : null;
  if (operation === "send") {
    sendBackoff++;
    nextSend = now + backoff(sendBackoff, "send");
    if (
      result.kind === "sent" &&
      ensureEvidenceMatchesTask(requestTask, result.evidence, "send")
    ) {
      observedAt ??= now;
      orderEvidence ??= "receipt";
      externalOrderId ??= result.evidence.externalOrderId ?? null;
      acknowledgedAt ??= now;
      sendBlock = "order_observed";
      reason = "unknown";
      outcome = "succeeded";
      nextSend = null;
    } else if (result.kind === "duplicate") {
      observedAt ??= now;
      orderEvidence ??= "duplicate";
      sendBlock = "order_observed";
      nextSend = null;
    } else if (result.kind === "waiting") {
      unknown = task.unknownOutcome;
      status = unknown ? "reconciling" : "waiting";
      sendBlock = result.reason;
      if (noOrderEvidence) outcome = "rejected";
      nextSend =
        result.reason === "funds"
          ? now + Math.max(300_000, backoff(sendBackoff, "send"))
          : result.reason === "quota"
            ? now + Math.max(3_600_000, backoff(sendBackoff, "send"))
            : null;
    } else if (result.kind === "throttled") {
      sendBlock = "throttled";
      nextSend =
        now +
        Math.max(result.retryAfterMs ?? 30_000, backoff(sendBackoff, "send"));
    } else if (result.kind === "rejected") {
      unknown = task.unknownOutcome;
      status = unknown ? "reconciling" : "attention";
      sendBlock = result.reason;
      nextSend = null;
      outcome = "rejected";
    } else if (
      result.kind === "conflict" ||
      result.kind === "confirmed" ||
      result.kind === "sent"
    ) {
      status = "attention";
      reason = "conflict";
      sendBlock = "conflict";
      observedAt ??= now;
      orderEvidence ??= "receipt";
      nextSend = null;
      outcome = "rejected";
    } else if (!temporaryQueryFailure(result)) {
      // Unknown 400, invalid responses and redirects are not automatic retry authority.
      sendBlock = result.reason ?? "unknown";
      nextSend = null;
    }
  } else {
    queryBackoff++;
    if (
      result.kind === "confirmed" &&
      ensureEvidenceMatchesTask(requestTask, result.evidence, "query")
    ) {
      status = "confirmed";
      reason = "";
      unknown = false;
      externalOrderId ??= result.evidence.externalOrderId ?? null;
      observedAt ??= now;
      orderEvidence ??= "query";
      nextAction = "none";
      sendBlock = null;
      nextSend = null;
      nextQuery = now;
      queryRetryAfter = null;
      queryBackoff = 0;
      outcome = "succeeded";
    } else if (
      result.kind === "unconfirmed" &&
      ensureQueryEvidenceMatchesTask(requestTask, result.evidence)
    ) {
      unknown = true;
      observedAt ??= now;
      orderEvidence ??= "query";
      externalOrderId ??= result.evidence.externalOrderId ?? null;
      sendBlock = "order_observed";
      nextSend = null;
    } else if (
      result.kind === "conflict" ||
      result.kind === "confirmed" ||
      result.kind === "unconfirmed"
    ) {
      unknown = true;
      observedAt ??= now;
      orderEvidence ??= "query";
      status = "attention";
      reason = "conflict";
      sendBlock = "conflict";
      nextSend = null;
      outcome = "rejected";
    } else if (result.kind === "throttled") {
      queryRetryAfter = now + (result.retryAfterMs ?? 30_000);
      nextQuery = Math.max(nextQuery, queryRetryAfter);
    } else if (result.kind === "not_found" || temporaryQueryFailure(result)) {
      if (
        sendBlock === "funds" ||
        sendBlock === "quota" ||
        sendBlock === "throttled"
      ) {
        if (nextSend !== null && nextSend <= now) sendBlock = null;
      } else if (sendBlock === "credentials") {
        const previous = await env.DB.prepare(
          "SELECT credential_version,finished_at FROM payment_attempts WHERE task_id=? AND purpose='recovery' AND operation='send' ORDER BY started_at DESC,id DESC LIMIT 1",
        )
          .bind(task.id)
          .first<{ credential_version: number; finished_at: number | null }>();
        const current = await env.DB.prepare(
          "SELECT verification_status,verification_checked_at FROM merchant_credentials WHERE merchant_id=? AND version=?",
        )
          .bind(merchant.id, credentialVersion)
          .first<{
            verification_status: string;
            verification_checked_at: number | null;
          }>();
        if (
          previous &&
          current?.verification_status === "passed" &&
          (credentialVersion > previous.credential_version ||
            (task.source === "claim" &&
              credentialVersion === previous.credential_version &&
              current.verification_checked_at !== null &&
              previous.finished_at !== null &&
              current.verification_checked_at >= previous.finished_at))
        ) {
          sendBlock = null;
          nextSend = now + backoff(sendBackoff, "send");
        }
      }
      if (
        (await permitsRecoverySend(env, task, now)) &&
        !hasOrder(task) &&
        observedAt === null &&
        sendBlock === null &&
        (await credentialPassed(env, merchant.id, merchant.credentialVersion))
      ) {
        nextAction = "send";
        nextSend = Math.max(
          nextSend ?? now + backoff(sendBackoff, "send"),
          now,
        );
      }
    }
  }
  const retryAfterAt =
    result.retryAfterMs !== undefined
      ? now + result.retryAfterMs
      : result.kind === "throttled"
        ? now + 30_000
        : null;
  if (status !== "confirmed" && retryAfterAt !== null) {
    queryRetryAfter = Math.max(task.queryRetryAfterAt ?? 0, retryAfterAt);
    nextQuery = Math.max(nextQuery, queryRetryAfter);
    if (nextSend !== null) nextSend = Math.max(nextSend, queryRetryAfter);
  }
  const nextRunAt =
    nextAction === "send"
      ? (nextSend ?? nextQuery)
      : Math.max(nextQuery, queryRetryAfter ?? 0);
  const cipher = await diagnostic(env, task.id, attemptId, result);
  const retain = status !== "confirmed" && (unknown || status !== "attention");
  const rejectedCredentials =
    (result.kind === "waiting" && result.reason === "credentials") ||
    (result.kind === "unknown" &&
      result.reason === "credentials" &&
      result.httpStatus !== undefined);
  const saved = await env.DB.batch([
    env.DB.prepare(`UPDATE payment_tasks SET amount_minor=CASE WHEN recovery_version=? THEN amount_minor ELSE NULL END,status=?,reason=?,unknown_outcome=?,external_order_id=?,send_acknowledged_at=?,order_observed_at=?,order_evidence=?,send_block_reason=?,next_action=?,next_send_at=?,next_query_at=?,query_retry_after_at=?,send_backoff_count=?,query_backoff_count=?,queried_send_count=?,queried_recovery_version=?,next_run_at=?,updated_at=?,confirmed_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)`).bind(
      task.recoveryVersion + 1,
      status,
      reason || null,
      Number(unknown),
      externalOrderId,
      acknowledgedAt,
      observedAt,
      orderEvidence,
      sendBlock,
      nextAction,
      nextSend,
      status === "confirmed" ? null : nextQuery,
      queryRetryAfter,
      sendBackoff,
      queryBackoff,
      operation === "query" ? task.attemptCount : null,
      operation === "query" ? task.recoveryVersion + 1 : null,
      nextRunAt,
      now,
      status === "confirmed" ? now : null,
      task.id,
      merchant.id,
      token,
    ),
    ...(rejectedCredentials
      ? [
          credentialRejectionStatement(
            env,
            merchant.id,
            credentialVersion,
            attemptStartedAt,
            token,
            now,
            result.httpStatus,
          ),
        ]
      : []),
    env.DB.prepare(
      "UPDATE payment_attempts SET outcome=?,reason=?,http_status=?,diagnostic_ciphertext=?,no_order_evidence=?,finished_at=? WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)",
    ).bind(
      outcome,
      reason || null,
      result.httpStatus ?? null,
      cipher,
      noOrderEvidence,
      now,
      attemptId,
      merchant.id,
      token,
    ),
    env.DB.prepare(
      "UPDATE merchants SET active_task_id=?,lease_token=NULL,lease_until=NULL,paused_reason=?,updated_at=? WHERE id=? AND lease_token=?",
    ).bind(
      retain ? task.id : null,
      retain ? reason || "unknown" : null,
      now,
      merchant.id,
      token,
    ),
  ]);
  if (saved[0]?.meta.changes)
    console.info(
      JSON.stringify({
        event: "ldc_payment_attempt",
        taskId: task.id,
        merchantId: merchant.id,
        mode: "real",
        operation,
        purpose: "recovery",
        credentialVersion,
        outcome,
        status,
        reason: reason || null,
        httpStatus: result.httpStatus ?? null,
      }),
    );
}

async function runProbe(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
  probe: ProbeRow,
  adapter: PaymentAdapter,
): Promise<CycleResult> {
  const now = Date.now();
  const due = await probeDue(env, task, probe);
  if (due === null || due > now) return { processed: false, nextRunAt: due };
  const correction = await loadPaymentUsernameCorrection(env, task.id);
  const sendTask = await effectivePaymentTask(env, task, correction);
  if (
    task.externalOrderId !== probe.baselineExternalOrderId ||
    probe.parameterDigest !== (await paymentParameterDigest(sendTask))
  )
    throw new Error("Payment probe identity mismatch");
  if (
    probe.permitConsumedAt !== null &&
    now >= probe.permitConsumedAt + PROBE_WINDOW_MS
  ) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE payment_duplicate_probes SET status='inconclusive',reason='probe_inconclusive',updated_at=? WHERE task_id=? AND status NOT IN ('passed','conflict','inconclusive') AND permit_consumed_at=?",
      ).bind(now, task.id, probe.permitConsumedAt),
      env.DB.prepare(
        "UPDATE merchants SET active_task_id=?,paused_reason=?,updated_at=? WHERE id=? AND lease_token IS NULL AND (active_task_id IS NULL OR active_task_id=?)",
      ).bind(
        probe.backendVerifiedAt === null ? task.id : null,
        probe.backendVerifiedAt === null ? "probe_inconclusive" : null,
        now,
        merchant.id,
        task.id,
      ),
    ]);
    return { processed: true, nextRunAt: null };
  }
  const operation: Operation =
    probe.permitConsumedAt === null ? "send" : "query";
  const ctx = await context(env, merchant, task, operation);
  if (
    operation === "send" &&
    !(await credentialPassed(env, merchant.id, ctx.credentialVersion))
  )
    throw new Error("REAL_LDC_CREDENTIALS_NOT_VERIFIED");
  const token = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const grant = await usablePaymentRetryGrant(env, task, now, true);
  if (operation === "send" && !grant.allowed)
    return { processed: false, nextRunAt: null };
  const snapshot = correctionSnapshotGuard(task.id, correction);
  const correctedReceiptGuard = correction
    ? "AND EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=payment_duplicate_probes.task_id AND a.operation='send' AND a.purpose='recovery' AND a.outcome='succeeded' AND a.finished_at=? AND a.recipient_username=? AND a.parameter_digest=?)"
    : "";
  try {
    await env.DB.batch([
      leaseStatement(env, merchant, task, token, now),
      env.DB.prepare(`UPDATE payment_duplicate_probes SET parameter_digest=CASE WHEN status=? AND query_count=? AND permit_consumed_at IS ? AND parameter_digest=?
        ${operation === "send" ? `AND EXISTS(SELECT 1 FROM payment_retry_grants g WHERE g.task_id=payment_duplicate_probes.task_id AND g.revoked_at IS NULL AND g.expires_at>? AND COALESCE((SELECT corrected_parameter_digest FROM payment_username_corrections WHERE task_id=g.task_id),g.parameter_digest)=payment_duplicate_probes.parameter_digest) AND EXISTS(SELECT 1 FROM merchants m JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version WHERE m.id=? AND m.credential_version=? AND c.verification_status='passed') ${snapshot.sql} ${correctedReceiptGuard}` : ""}
        THEN parameter_digest ELSE NULL END,status=?,permit_consumed_at=COALESCE(permit_consumed_at,?),query_count=query_count+?,updated_at=? WHERE task_id=?`).bind(
        probe.status,
        probe.queryCount,
        probe.permitConsumedAt,
        probe.parameterDigest,
        ...(operation === "send"
          ? [now, merchant.id, ctx.credentialVersion, ...snapshot.values]
          : []),
        ...(operation === "send" && correction
          ? [
              task.sendAcknowledgedAt,
              correction.correctedUsername,
              correction.correctedParameterDigest,
            ]
          : []),
        operation === "send" ? "sending" : "reconciling",
        now,
        Number(operation === "query"),
        now,
        task.id,
      ),
      env.DB.prepare(
        "INSERT INTO payment_attempts(id,task_id,token,operation,purpose,outcome,credential_version,started_at,recipient_username,parameter_digest,client_id,identity_correction_version) VALUES(?,?,?,?,'probe','started',?,?,?,?,?,0)",
      ).bind(
        attemptId,
        task.id,
        token,
        operation,
        ctx.credentialVersion,
        now,
        operation === "send" ? sendTask.recipientUsername : null,
        operation === "send" ? probe.parameterDigest : null,
        task.clientId,
      ),
    ]);
  } catch (error) {
    const current = await loadProbe(env, task.id);
    if (
      current?.status !== probe.status ||
      current?.queryCount !== probe.queryCount ||
      current?.permitConsumedAt !== probe.permitConsumedAt
    )
      return {
        processed: false,
        nextRunAt: await realMerchantNextDue(env, merchant.id),
      };
    const currentMerchant = await createDb(env.DB)
      .select()
      .from(merchants)
      .where(eq(merchants.id, merchant.id))
      .get();
    if (currentMerchant?.leaseToken && currentMerchant.leaseToken !== token)
      return { processed: false, nextRunAt: currentMerchant.leaseUntil };
    throw error;
  }
  let result: AdapterResult;
  try {
    result = await adapter[operation](
      operation === "send" ? sendTask : task,
      ctx,
    );
  } catch {
    result = { kind: "unknown", reason: "network" };
  }
  const finishedAt = Date.now();
  let protocol = probe.protocolVerifiedAt;
  const backend = probe.backendVerifiedAt;
  let status: ProbeRow["status"] = "reconciling";
  let reason: string =
    "reason" in result ? (result.reason ?? "unknown") : "unknown";
  let outcome = "unknown";
  if (
    operation === "send" &&
    (result.kind === "duplicate" ||
      (result.kind === "sent" &&
        ensureEvidenceMatchesTask(task, result.evidence, "send")))
  ) {
    reason = result.kind === "duplicate" ? "probe_duplicate" : "probe_receipt";
    outcome = "succeeded";
  } else if (
    operation === "query" &&
    result.kind === "confirmed" &&
    ensureEvidenceMatchesTask(task, result.evidence, "query")
  ) {
    const sendEvidence = await env.DB.prepare(
      "SELECT id FROM payment_attempts WHERE task_id=? AND purpose='probe' AND operation='send' AND outcome='succeeded' AND reason IN ('probe_duplicate','probe_receipt') AND finished_at IS NOT NULL LIMIT 1",
    )
      .bind(task.id)
      .first();
    if (sendEvidence) protocol ??= finishedAt;
    reason =
      protocol === null
        ? "probe_protocol_unverified"
        : "probe_backend_evidence_required";
    status = "awaiting_evidence";
    outcome = "succeeded";
  } else if (
    result.kind === "conflict" ||
    (result.kind === "sent" &&
      !ensureEvidenceMatchesTask(task, result.evidence, "send")) ||
    (result.kind === "confirmed" &&
      !ensureEvidenceMatchesTask(task, result.evidence, "query")) ||
    (result.kind === "unconfirmed" &&
      !ensureQueryEvidenceMatchesTask(task, result.evidence))
  ) {
    status = "conflict";
    reason = "conflict";
    outcome = "rejected";
  }
  const deadline = (probe.permitConsumedAt ?? now) + PROBE_WINDOW_MS;
  const retryAfterAt =
    result.retryAfterMs !== undefined
      ? finishedAt + result.retryAfterMs
      : result.kind === "throttled"
        ? finishedAt + 30_000
        : null;
  const nextRunAt =
    status === "awaiting_evidence"
      ? deadline
      : Math.min(
          deadline,
          Math.max(
            finishedAt + backoff(probe.queryCount + 1),
            task.queryRetryAfterAt ?? 0,
            retryAfterAt ?? 0,
          ),
        );
  const retain = true;
  const cipher = await diagnostic(env, task.id, attemptId, result);
  const saved = await env.DB.batch([
    env.DB.prepare(
      "UPDATE payment_duplicate_probes SET status=?,reason=?,http_status=?,protocol_verified_at=?,backend_verified_at=?,next_run_at=?,updated_at=? WHERE task_id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)",
    ).bind(
      status,
      reason || null,
      result.httpStatus ?? null,
      protocol,
      backend,
      nextRunAt,
      finishedAt,
      task.id,
      merchant.id,
      token,
    ),
    env.DB.prepare(
      "UPDATE payment_tasks SET query_retry_after_at=CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(query_retry_after_at,0),?) ELSE query_retry_after_at END WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)",
    ).bind(retryAfterAt, retryAfterAt, task.id, merchant.id, token),
    env.DB.prepare(
      "UPDATE payment_attempts SET outcome=?,reason=?,http_status=?,diagnostic_ciphertext=?,finished_at=? WHERE id=? AND EXISTS(SELECT 1 FROM merchants WHERE id=? AND lease_token=?)",
    ).bind(
      outcome,
      reason || null,
      result.httpStatus ?? null,
      cipher,
      finishedAt,
      attemptId,
      merchant.id,
      token,
    ),
    env.DB.prepare(
      "UPDATE merchants SET active_task_id=?,lease_token=NULL,lease_until=NULL,paused_reason=?,updated_at=? WHERE id=? AND lease_token=?",
    ).bind(
      retain ? task.id : null,
      retain ? reason : null,
      finishedAt,
      merchant.id,
      token,
    ),
  ]);
  if (saved[0]?.meta.changes)
    console.info(
      JSON.stringify({
        event: "ldc_payment_probe",
        taskId: task.id,
        merchantId: merchant.id,
        operation,
        purpose: "probe",
        credentialVersion: ctx.credentialVersion,
        outcome,
        status,
        reason: reason || null,
        httpStatus: result.httpStatus ?? null,
      }),
    );
  return {
    processed: true,
    nextRunAt: await realMerchantNextDue(env, merchant.id),
  };
}

export async function runRealMerchantCycle(
  env: ApiBindings,
  merchantId: string,
  adapter: PaymentAdapter,
): Promise<CycleResult> {
  const now = Date.now();
  let merchant = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .get();
  if (merchant?.mode !== "real" || adapter.mode !== "real")
    throw new Error("Payment mode mismatch");
  if (merchant.leaseUntil && merchant.leaseUntil > now)
    return { processed: false, nextRunAt: merchant.leaseUntil };
  await recoverExpiredLease(env, merchant, now);
  merchant = await createDb(env.DB)
    .select()
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .get();
  if (!merchant) return { processed: false, nextRunAt: null };
  await synchronizeMerchantPaymentIdentities(env, merchant);
  const task = await selectTask(env, merchant);
  if (!task) return { processed: false, nextRunAt: null };
  if (
    task.merchantId !== merchantId ||
    !(await merchantOwnsClientId(env, merchantId, task.clientId)) ||
    task.mode !== "real"
  )
    throw new Error("Payment identity mismatch");
  if (task.status === "confirmed") {
    const probe = await loadProbe(env, task.id);
    if (probe?.status === "passed" && merchant.activeTaskId === task.id) {
      await env.DB.prepare(
        "UPDATE merchants SET active_task_id=NULL,paused_reason=NULL WHERE id=? AND active_task_id=? AND lease_token IS NULL",
      )
        .bind(merchant.id, task.id)
        .run();
      return { processed: false, nextRunAt: null };
    }
    return probe
      ? runProbe(env, merchant, task, probe, adapter)
      : { processed: false, nextRunAt: null };
  }
  const selected = await operationForTask(env, task, now);
  if (!selected || selected.due > now)
    return {
      processed: false,
      nextRunAt: await realMerchantNextDue(env, merchantId),
    };
  if (task.source === "claim") {
    const decision =
      selected.operation === "send"
        ? await realSendDecision(env, task)
        : await realQueryDecision(env, task);
    if (!decision.allowed) return { processed: false, nextRunAt: null };
    if (
      selected.operation === "send" &&
      task.firstSendAt === null &&
      !(await credentialPassed(env, merchant.id, merchant.credentialVersion))
    ) {
      const waited = await env.DB.prepare(
        `UPDATE payment_tasks SET status='waiting',reason='credentials',next_run_at=?,updated_at=?
         WHERE id=? AND first_send_at IS NULL AND attempt_count=0 AND recovery_version=?
         AND status IN ('pending','waiting') AND NOT EXISTS(SELECT 1 FROM merchants m JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version WHERE m.id=payment_tasks.merchant_id AND c.verification_status='passed')`,
      )
        .bind(now + 300_000, now, task.id, task.recoveryVersion)
        .run();
      return {
        processed: false,
        nextRunAt: await realMerchantNextDue(env, merchantId),
        ...(waited.meta.changes &&
        (task.status !== "waiting" || task.reason !== "credentials")
          ? { moved: task.id }
          : {}),
      };
    }
  }
  const effective = await effectiveClaimPaymentTask(env, task);
  const correction =
    selected.operation === "send"
      ? await loadPaymentUsernameCorrection(env, task.id)
      : null;
  const sendTask =
    selected.operation === "send"
      ? await effectivePaymentTask(env, task, correction)
      : effective;
  const ctx = await context(env, merchant, sendTask, selected.operation);
  const token = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  if (
    !(await beginAttempt(
      env,
      merchant,
      task,
      selected.operation,
      token,
      attemptId,
      ctx.credentialVersion,
      now,
      correction,
      sendTask,
    ))
  )
    return {
      processed: false,
      nextRunAt: await realMerchantNextDue(env, merchantId),
    };
  let result: AdapterResult;
  try {
    result = await adapter[selected.operation](sendTask, ctx);
  } catch {
    result = { kind: "unknown", reason: "network" };
  }
  await finishAttempt(
    env,
    merchant,
    task,
    selected.operation,
    token,
    attemptId,
    ctx.credentialVersion,
    now,
    result,
    sendTask,
  );
  const after = await env.DB.prepare(
    "SELECT status,reason FROM payment_tasks WHERE id=?",
  )
    .bind(task.id)
    .first<{ status: string; reason: string | null }>();
  return {
    processed: true,
    nextRunAt: await realMerchantNextDue(env, merchantId),
    ...(after && (after.status !== task.status || after.reason !== task.reason)
      ? { moved: task.id }
      : {}),
  };
}
