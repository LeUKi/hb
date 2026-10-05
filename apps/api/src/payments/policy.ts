import type { ApiBindings } from "../env";
import { allowsRealSending, readPlatformControls } from "../runtime/controls";
import type { PaymentTaskRow } from "./adapter";

export type LdcNetworkMode = "disabled" | "verify" | "acceptance" | "live";
export type AppEnvironment = "local" | "staging" | "production";

export type PaymentAcceptanceRow = {
  id: string;
  merchantId: string;
  clientId: string;
  businessNo: string;
  recipientId: string;
  recipientUsername: string;
  amountMinor: number;
  sendConsumedAt: number | null;
  createdAt: number;
};

export type RealPaymentRuntimePolicy = {
  appEnv: AppEnvironment;
  networkMode: LdcNetworkMode;
  acceptanceId: string | null;
};

export type RealPaymentPolicyDecision =
  | {
      allowed: true;
      source: "acceptance";
      acceptance: PaymentAcceptanceRow;
      grant?: PaymentRetryGrantRow;
    }
  | {
      allowed: true;
      source: "claim";
      controlsVersion?: number;
    }
  | {
      allowed: false;
      reason:
        | "disabled"
        | "acceptance_mismatch"
        | "claim_mismatch"
        | "already_consumed"
        | "retry_not_authorized"
        | "retry_expired"
        | "retry_revoked"
        | "retry_exhausted"
        | "order_observed"
        | "query_required"
        | "send_blocked"
        | "not_due"
        | "unsupported";
    };

export type PaymentRetryGrantRow = {
  taskId: string;
  policy: "same_order_v1";
  parameterDigest: string;
  maxAdditionalSends: number;
  usedAdditionalSends: number;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
};

export type PaymentUsernameCorrectionRow = {
  taskId: string;
  originalUsername: string;
  correctedUsername: string;
  originalParameterDigest: string;
  correctedParameterDigest: string;
  createdAt: number;
};

/** Keep this key order identical to the local authorization command. */
export async function paymentParameterDigest(
  task: Pick<
    PaymentTaskRow,
    | "id"
    | "source"
    | "acceptanceId"
    | "merchantId"
    | "clientId"
    | "businessNo"
    | "recipientId"
    | "recipientUsername"
    | "amountMinor"
    | "mode"
  >,
) {
  const canonical = JSON.stringify({
    taskId: task.id,
    source: task.source,
    acceptanceId: task.acceptanceId,
    merchantId: task.merchantId,
    clientId: task.clientId,
    businessNo: task.businessNo,
    recipientId: task.recipientId,
    recipientUsername: task.recipientUsername,
    amountMinor: task.amountMinor,
    mode: task.mode,
  });
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type ClaimPaymentDigestInput = Pick<
  PaymentTaskRow,
  | "id"
  | "source"
  | "claimId"
  | "acceptanceId"
  | "merchantId"
  | "clientId"
  | "businessNo"
  | "recipientId"
  | "recipientUsername"
  | "amountMinor"
  | "mode"
  | "recoveryPolicy"
>;

/** Normal claim authorization is separate from the historical local acceptance grants. */
export async function claimPaymentParameterDigest(
  task: ClaimPaymentDigestInput,
): Promise<string> {
  const canonical = JSON.stringify({
    policy: task.recoveryPolicy,
    taskId: task.id,
    source: task.source,
    claimId: task.claimId,
    acceptanceId: task.acceptanceId,
    merchantId: task.merchantId,
    clientId: task.clientId,
    businessNo: task.businessNo,
    recipientId: task.recipientId,
    recipientUsername: task.recipientUsername,
    amountMinor: task.amountMinor,
    mode: task.mode,
  });
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Rechecked in the send-intent batch; ending an activity never cancels its debts. */
export function claimPaymentIdentitySql(alias: "p" | "payment_tasks") {
  return `${alias}.source='claim' AND ${alias}.mode='real'
    AND ${alias}.claim_id IS NOT NULL AND ${alias}.acceptance_id IS NULL
    AND ${alias}.recovery_policy='claim_same_order_v1'
    AND ${alias}.business_no='hb_' || REPLACE(${alias}.claim_id,'-','')
    AND EXISTS(SELECT 1 FROM claims c
      JOIN activities a ON a.id=c.activity_id
      JOIN reward_inventory r ON r.id=c.inventory_id AND r.activity_id=a.id
      JOIN users u ON u.id=c.user_id
      JOIN merchants m ON m.id=a.merchant_id
      WHERE c.id=${alias}.claim_id AND a.reward_type='ldc' AND a.payment_mode='real'
        AND a.opened_at IS NOT NULL AND a.author_id!=c.user_id
        AND a.merchant_id=${alias}.merchant_id AND m.author_id=a.author_id
        AND m.mode='real' AND m.client_id=${alias}.client_id
        AND r.kind='ldc' AND r.amount_minor=${alias}.amount_minor
        AND u.provider='linux_do' AND u.external_id=${alias}.recipient_id
        AND (json_extract(a.config,'$.money.mode') IS NOT 'timed_draw' OR (
          a.draw_state='completed' AND a.draw_published_at IS NOT NULL
          AND EXISTS(SELECT 1 FROM activity_draw_plans d JOIN json_each(d.payload,'$.winners') w
            WHERE d.activity_id=a.id AND json_extract(w.value,'$.claimId')=c.id
            AND json_extract(w.value,'$.userId')=c.user_id AND json_extract(w.value,'$.recipientId')=${alias}.recipient_id
            AND json_extract(w.value,'$.amountMinor')=${alias}.amount_minor))))`;
}

async function claimMatchesTask(env: ApiBindings, task: PaymentTaskRow) {
  if (
    task.source !== "claim" ||
    task.mode !== "real" ||
    task.recoveryPolicy !== "claim_same_order_v1" ||
    !task.claimId ||
    task.acceptanceId !== null ||
    !task.parameterDigest ||
    task.parameterDigest !== (await claimPaymentParameterDigest(task))
  )
    return false;
  return Boolean(
    await env.DB.prepare(
      `SELECT p.id FROM payment_tasks p WHERE p.id=? AND p.parameter_digest=? AND ${claimPaymentIdentitySql("p")}`,
    )
      .bind(task.id, task.parameterDigest)
      .first(),
  );
}

export async function loadPaymentRetryGrant(env: ApiBindings, taskId: string) {
  const row = await env.DB.prepare(
    `SELECT task_id,policy,parameter_digest,max_additional_sends,used_additional_sends,expires_at,revoked_at,created_at
     FROM payment_retry_grants WHERE task_id=?`,
  )
    .bind(taskId)
    .first<{
      task_id: string;
      policy: "same_order_v1";
      parameter_digest: string;
      max_additional_sends: number;
      used_additional_sends: number;
      expires_at: number;
      revoked_at: number | null;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    taskId: row.task_id,
    policy: row.policy,
    parameterDigest: row.parameter_digest,
    maxAdditionalSends: row.max_additional_sends,
    usedAdditionalSends: row.used_additional_sends,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  } satisfies PaymentRetryGrantRow;
}

export async function loadPaymentUsernameCorrection(
  env: ApiBindings,
  taskId: string,
) {
  const row = await env.DB.prepare(
    "SELECT task_id,original_username,corrected_username,original_parameter_digest,corrected_parameter_digest,created_at FROM payment_username_corrections WHERE task_id=?",
  )
    .bind(taskId)
    .first<{
      task_id: string;
      original_username: string;
      corrected_username: string;
      original_parameter_digest: string;
      corrected_parameter_digest: string;
      created_at: number;
    }>();
  return row
    ? ({
        taskId: row.task_id,
        originalUsername: row.original_username,
        correctedUsername: row.corrected_username,
        originalParameterDigest: row.original_parameter_digest,
        correctedParameterDigest: row.corrected_parameter_digest,
        createdAt: row.created_at,
      } satisfies PaymentUsernameCorrectionRow)
    : null;
}

/** Original rows and grants stay immutable; only this audited request snapshot changes. */
export async function effectivePaymentTask(
  env: ApiBindings,
  task: PaymentTaskRow,
  snapshot?: PaymentUsernameCorrectionRow | null,
): Promise<PaymentTaskRow> {
  const correction =
    snapshot === undefined
      ? await loadPaymentUsernameCorrection(env, task.id)
      : snapshot;
  if (!correction) return task;
  const grant = await loadPaymentRetryGrant(env, task.id);
  const effective = {
    ...task,
    recipientUsername: correction.correctedUsername,
  };
  if (
    task.mode !== "real" ||
    task.source !== "acceptance" ||
    correction.taskId !== task.id ||
    correction.originalUsername !== task.recipientUsername ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(correction.originalUsername) ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(correction.correctedUsername) ||
    correction.originalUsername === correction.correctedUsername ||
    correction.originalUsername.toLowerCase() !==
      correction.correctedUsername.toLowerCase() ||
    correction.originalParameterDigest !==
      (await paymentParameterDigest(task)) ||
    grant?.parameterDigest !== correction.originalParameterDigest ||
    correction.correctedParameterDigest !==
      (await paymentParameterDigest(effective))
  )
    throw new Error("Payment username correction identity mismatch");
  return effective;
}

export async function usablePaymentRetryGrant(
  env: ApiBindings,
  task: PaymentTaskRow,
  now = Date.now(),
  allowExhausted = false,
) {
  const grant = await loadPaymentRetryGrant(env, task.id);
  if (
    grant?.policy !== "same_order_v1" ||
    grant.parameterDigest !== (await paymentParameterDigest(task))
  )
    return { allowed: false, reason: "retry_not_authorized" } as const;
  if (grant.revokedAt !== null)
    return { allowed: false, reason: "retry_revoked" } as const;
  if (grant.expiresAt <= now)
    return { allowed: false, reason: "retry_expired" } as const;
  if (!allowExhausted && grant.usedAdditionalSends >= grant.maxAdditionalSends)
    return { allowed: false, reason: "retry_exhausted" } as const;
  return { allowed: true, grant } as const;
}

type RuntimeEnv = ApiBindings & {
  APP_ENV?: string;
  LDC_NETWORK_MODE?: string;
  LDC_ACCEPTANCE_ID?: string;
};

function appEnv(value: string | undefined): AppEnvironment {
  // A missing or malformed environment must never enable a local send grant.
  return value === "local" || value === "staging" ? value : "production";
}

function networkMode(value: string | undefined): LdcNetworkMode {
  if (value === "verify" || value === "acceptance" || value === "live")
    return value;
  return "disabled";
}

export function runtimeRealPolicy(env: ApiBindings): RealPaymentRuntimePolicy {
  const runtime = env as RuntimeEnv;
  return {
    appEnv: appEnv(runtime.APP_ENV),
    networkMode: networkMode(runtime.LDC_NETWORK_MODE),
    acceptanceId: runtime.LDC_ACCEPTANCE_ID || null,
  };
}

export function canVerifyRealCredentials(env: ApiBindings) {
  const policy = runtimeRealPolicy(env);
  return (
    policy.networkMode === "verify" ||
    policy.networkMode === "acceptance" ||
    policy.networkMode === "live"
  );
}

export async function loadPaymentAcceptance(
  env: ApiBindings,
  acceptanceId: string | null | undefined,
) {
  if (!acceptanceId) return null;
  const row = await env.DB.prepare(
    `SELECT id, merchant_id, client_id, business_no, recipient_id, recipient_username, amount_minor, send_consumed_at, created_at
        FROM payment_acceptances WHERE id = ?`,
  )
    .bind(acceptanceId)
    .first<{
      id: string;
      merchant_id: string;
      client_id: string;
      business_no: string;
      recipient_id: string;
      recipient_username: string;
      amount_minor: number;
      send_consumed_at: number | null;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchant_id,
    clientId: row.client_id,
    businessNo: row.business_no,
    recipientId: row.recipient_id,
    recipientUsername: row.recipient_username,
    amountMinor: row.amount_minor,
    sendConsumedAt: row.send_consumed_at,
    createdAt: row.created_at,
  } satisfies PaymentAcceptanceRow;
}

export function acceptanceMatchesTask(
  task: PaymentTaskRow,
  acceptance: PaymentAcceptanceRow,
) {
  return (
    task.mode === "real" &&
    task.source === "acceptance" &&
    task.claimId === null &&
    task.acceptanceId === acceptance.id &&
    task.merchantId === acceptance.merchantId &&
    task.clientId === acceptance.clientId &&
    task.businessNo === acceptance.businessNo &&
    task.recipientId === acceptance.recipientId &&
    task.recipientUsername === acceptance.recipientUsername &&
    task.amountMinor === acceptance.amountMinor
  );
}

export async function realSendDecision(
  env: ApiBindings,
  task: PaymentTaskRow,
): Promise<RealPaymentPolicyDecision> {
  const policy = runtimeRealPolicy(env);
  if (task.source === "claim") {
    const controls = await readPlatformControls(env);
    if (!allowsRealSending(env, controls))
      return { allowed: false, reason: "disabled" };
    if (!(await claimMatchesTask(env, task)))
      return { allowed: false, reason: "claim_mismatch" };
    if (task.firstSendAt === null) {
      if (
        task.attemptCount > 0 ||
        task.unknownOutcome ||
        hasOrderEvidence(task)
      )
        return { allowed: false, reason: "already_consumed" };
      return {
        allowed: true,
        source: "claim",
        controlsVersion: controls.version,
      };
    }
    if (hasOrderEvidence(task))
      return { allowed: false, reason: "order_observed" };
    if (
      task.nextAction !== "send" ||
      task.queriedSendCount !== task.attemptCount ||
      task.queriedRecoveryVersion !== task.recoveryVersion
    )
      return { allowed: false, reason: "query_required" };
    if (task.sendBlockReason !== null)
      return { allowed: false, reason: "send_blocked" };
    if (task.nextSendAt === null || task.nextSendAt > Date.now())
      return { allowed: false, reason: "not_due" };
    return {
      allowed: true,
      source: "claim",
      controlsVersion: controls.version,
    };
  }
  const acceptanceId = acceptanceIdForTask(task);
  const acceptance = await loadPaymentAcceptance(env, acceptanceId);
  if (
    policy.appEnv !== "local" ||
    policy.networkMode !== "acceptance" ||
    !policy.acceptanceId ||
    env.LDC_STOP_SENDS === "true"
  )
    return { allowed: false, reason: "disabled" };
  if (!acceptance || acceptance.id !== policy.acceptanceId)
    return { allowed: false, reason: "acceptance_mismatch" };
  if (!acceptanceMatchesTask(task, acceptance))
    return { allowed: false, reason: "acceptance_mismatch" };
  if (acceptance.sendConsumedAt !== null) {
    if (
      task.orderObservedAt !== null ||
      task.sendAcknowledgedAt !== null ||
      task.externalOrderId !== null
    )
      return { allowed: false, reason: "order_observed" };
    const retry = await usablePaymentRetryGrant(env, task);
    if (!retry.allowed) return retry;
    await effectivePaymentTask(env, task);
    if (
      task.nextAction !== "send" ||
      task.queriedSendCount !== task.attemptCount ||
      task.queriedRecoveryVersion !== task.recoveryVersion
    )
      return { allowed: false, reason: "query_required" };
    if (task.sendBlockReason !== null)
      return { allowed: false, reason: "send_blocked" };
    if (task.nextSendAt === null || task.nextSendAt > Date.now())
      return { allowed: false, reason: "not_due" };
    return {
      allowed: true,
      source: "acceptance",
      acceptance,
      grant: retry.grant,
    };
  }
  if (task.attemptCount > 0 || task.unknownOutcome)
    return { allowed: false, reason: "already_consumed" };
  return { allowed: true, source: "acceptance", acceptance };
}

export async function realQueryDecision(
  env: ApiBindings,
  task: PaymentTaskRow,
): Promise<RealPaymentPolicyDecision> {
  const policy = runtimeRealPolicy(env);
  if (task.source === "claim") {
    if (
      env.APP_ENV !== "production" ||
      (policy.networkMode !== "verify" && policy.networkMode !== "live")
    )
      return { allowed: false, reason: "disabled" };
    if (!(await claimMatchesTask(env, task)))
      return { allowed: false, reason: "claim_mismatch" };
    if (task.firstSendAt === null)
      return { allowed: false, reason: "already_consumed" };
    return { allowed: true, source: "claim" };
  }
  const acceptance = await loadPaymentAcceptance(
    env,
    acceptanceIdForTask(task),
  );
  if (
    policy.appEnv !== "local" ||
    (policy.networkMode !== "verify" && policy.networkMode !== "acceptance")
  )
    return { allowed: false, reason: "disabled" };
  if (!acceptance || !acceptanceMatchesTask(task, acceptance))
    return { allowed: false, reason: "acceptance_mismatch" };
  if (acceptance.sendConsumedAt === null)
    return { allowed: false, reason: "already_consumed" };
  return { allowed: true, source: "acceptance", acceptance };
}

function hasOrderEvidence(task: PaymentTaskRow) {
  return (
    task.orderObservedAt !== null ||
    task.sendAcknowledgedAt !== null ||
    task.externalOrderId !== null
  );
}

export function acceptanceIdForTask(task: PaymentTaskRow) {
  return task.source === "acceptance" ? task.acceptanceId : null;
}
