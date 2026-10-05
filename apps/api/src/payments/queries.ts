import {
  formatAmount,
  type MerchantPayment,
  type MerchantPaymentDetail,
  type MerchantPaymentList,
  type PaymentAttemptView,
  type PaymentState,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { decodeTimeCursor, encodeTimeCursor } from "./merchants";
import { sanitizeUpstreamMessage } from "./real-protocol";

type PaymentSqlRow = {
  id: string;
  source: "claim" | "acceptance";
  claim_id: string | null;
  activity_id: string | null;
  acceptance_id: string | null;
  mode: "simulation" | "real";
  amount_minor: number;
  business_no: string;
  external_order_id: string | null;
  status: PaymentState;
  reason: string | null;
  created_at: number;
  next_run_at: number;
  confirmed_at: number | null;
  recipient_id: string;
  recipient_username: string | null;
  attempt_count: number;
  reconciliation_count: number;
  unknown_outcome: number;
  send_acknowledged_at: number | null;
  next_action: MerchantPaymentDetail["nextAction"];
  next_send_at: number | null;
  next_query_at: number | null;
  send_block_reason: string | null;
  order_observed_at: number | null;
  order_evidence: MerchantPaymentDetail["orderEvidence"];
  recovery_policy: MerchantPaymentDetail["recoveryPolicy"];
  first_send_at: number | null;
  recipient_username_current: string | null;
  recipient_display_name_current: string | null;
  recipient_avatar_url: string | null;
};
type AttemptSqlRow = {
  id: string;
  operation: PaymentAttemptView["operation"];
  purpose: PaymentAttemptView["purpose"];
  diagnostic_ciphertext: string | null;
  recipient_username: string | null;
  outcome: string;
  reason: string | null;
  credential_version: number;
  http_status: number | null;
  started_at: number;
  finished_at: number | null;
};
type RetryGrantSqlRow = {
  policy: "same_order_v1";
  max_additional_sends: number;
  used_additional_sends: number;
  expires_at: number;
  revoked_at: number | null;
};
type DuplicateProbeSqlRow = {
  status: NonNullable<MerchantPaymentDetail["duplicateProbe"]>["status"];
  baseline_external_order_id: string;
  permit_consumed_at: number | null;
  next_run_at: number;
  query_count: number;
  reason: string | null;
  protocol_verified_at: number | null;
  backend_verified_at: number | null;
};
type UsernameCorrectionSqlRow = {
  original_username: string;
  corrected_username: string;
  created_at: number;
};
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();
function paymentView(row: PaymentSqlRow): MerchantPayment {
  const base = {
    id: row.id,
    mode: row.mode,
    amount: formatAmount(row.amount_minor),
    businessNo: row.business_no,
    externalOrderId: row.external_order_id,
    status: row.status,
    reason: row.reason,
    createdAt: new Date(row.created_at).toISOString(),
    nextRunAt: new Date(row.next_run_at).toISOString(),
    confirmedAt: iso(row.confirmed_at),
  };
  if (row.source === "acceptance" && row.acceptance_id)
    return {
      ...base,
      source: "acceptance",
      claimId: null,
      activityId: null,
      acceptanceId: row.acceptance_id,
    };
  if (row.source === "claim" && row.claim_id && row.activity_id)
    return {
      ...base,
      source: "claim",
      claimId: row.claim_id,
      activityId: row.activity_id,
      acceptanceId: null,
    };
  throw new Error("Inconsistent payment source");
}
export async function listMerchantPayments(
  env: ApiBindings,
  merchantId: string,
  cursor?: string,
): Promise<MerchantPaymentList> {
  const before = decodeTimeCursor(cursor);
  const rows = await env.DB.prepare(
    `SELECT p.*,c.activity_id FROM payment_tasks p LEFT JOIN claims c ON c.id=p.claim_id WHERE p.merchant_id=? ${before ? "AND (p.created_at<? OR (p.created_at=? AND p.id<?))" : ""} ORDER BY p.created_at DESC,p.id DESC LIMIT 21`,
  )
    .bind(merchantId, ...(before ? [before.time, before.time, before.id] : []))
    .all<PaymentSqlRow>();
  const items = rows.results.slice(0, 20),
    last = items.at(-1);
  return {
    items: items.map(paymentView),
    nextCursor:
      rows.results.length > 20 && last
        ? encodeTimeCursor({ id: last.id, createdAt: last.created_at })
        : null,
  };
}
export async function merchantPaymentDetail(
  env: ApiBindings,
  merchantId: string,
  taskId: string,
  cursor?: string,
): Promise<MerchantPaymentDetail> {
  const row = await env.DB.prepare(
    `SELECT p.*,c.activity_id,
      u.username AS recipient_username_current,
      u.display_name AS recipient_display_name_current,
      u.avatar_url AS recipient_avatar_url
      FROM payment_tasks p
      LEFT JOIN claims c ON c.id=p.claim_id
      LEFT JOIN users u ON u.id=c.user_id
      WHERE p.id=? AND p.merchant_id=?`,
  )
    .bind(taskId, merchantId)
    .first<PaymentSqlRow>();
  if (!row) throw new ActivityError(404, "NOT_FOUND", "未找到付款记录");
  const before = decodeTimeCursor(cursor);
  const [rows, grant, probe, correction] = await Promise.all([
    env.DB.prepare(
      `SELECT id,operation,purpose,diagnostic_ciphertext,recipient_username,outcome,reason,credential_version,started_at,finished_at,http_status FROM payment_attempts WHERE task_id=? ${before ? "AND (started_at<? OR (started_at=? AND id<?))" : ""} ORDER BY started_at DESC,id DESC LIMIT 21`,
    )
      .bind(taskId, ...(before ? [before.time, before.time, before.id] : []))
      .all<AttemptSqlRow>(),
    env.DB.prepare(
      "SELECT policy,max_additional_sends,used_additional_sends,expires_at,revoked_at FROM payment_retry_grants WHERE task_id=?",
    )
      .bind(taskId)
      .first<RetryGrantSqlRow>(),
    env.DB.prepare(
      "SELECT status,baseline_external_order_id,permit_consumed_at,next_run_at,query_count,reason,protocol_verified_at,backend_verified_at FROM payment_duplicate_probes WHERE task_id=?",
    )
      .bind(taskId)
      .first<DuplicateProbeSqlRow>(),
    env.DB.prepare(
      "SELECT original_username,corrected_username,created_at FROM payment_username_corrections WHERE task_id=?",
    )
      .bind(taskId)
      .first<UsernameCorrectionSqlRow>(),
  ]);
  const page = rows.results.slice(0, 20),
    last = page.at(-1);
  const attempts: PaymentAttemptView[] = await Promise.all(
    page.map(async (a) => ({
      id: a.id,
      httpStatus: a.http_status,
      operation: a.operation,
      recipientUsername: a.recipient_username,
      purpose: a.purpose,
      diagnosticSummary: await diagnosticSummary(env, taskId, a),
      outcome: a.outcome,
      reason: a.reason,
      credentialVersion: a.credential_version,
      startedAt: new Date(a.started_at).toISOString(),
      finishedAt: iso(a.finished_at),
    })),
  );
  return {
    ...paymentView(row),
    recipientProfile:
      row.recipient_username_current && row.recipient_display_name_current
        ? {
            username: row.recipient_username_current,
            displayName: row.recipient_display_name_current,
            avatarUrl: row.recipient_avatar_url,
          }
        : null,
    usernameCorrection: correction
      ? {
          originalUsername: correction.original_username,
          correctedUsername: correction.corrected_username,
          createdAt: new Date(correction.created_at).toISOString(),
        }
      : null,
    nextAction:
      row.status === "confirmed" || row.status === "attention"
        ? "none"
        : row.mode === "simulation"
          ? row.status === "pending" || row.status === "waiting"
            ? "send"
            : "query"
          : row.next_action,
    nextSendAt: iso(row.next_send_at),
    nextQueryAt: iso(row.next_query_at),
    sendBlockReason: row.send_block_reason,
    orderObservedAt: iso(row.order_observed_at),
    orderEvidence: row.order_evidence,
    recoveryPolicy: row.recovery_policy,
    firstSendAt: iso(row.first_send_at),
    retryAuthorization:
      row.source === "acceptance" && grant
        ? {
            policy: grant.policy,
            maxAdditionalSends: grant.max_additional_sends,
            usedAdditionalSends: grant.used_additional_sends,
            expiresAt: new Date(grant.expires_at).toISOString(),
            revokedAt: iso(grant.revoked_at),
          }
        : null,
    duplicateProbe:
      row.source === "acceptance" && probe
        ? {
            status: probe.status,
            baselineExternalOrderId: probe.baseline_external_order_id,
            permitConsumedAt: iso(probe.permit_consumed_at),
            nextRunAt: new Date(probe.next_run_at).toISOString(),
            queryCount: probe.query_count,
            reason: probe.reason,
            protocolVerifiedAt: iso(probe.protocol_verified_at),
            backendVerifiedAt: iso(probe.backend_verified_at),
          }
        : null,
    recipientId: row.recipient_id,
    recipientUsername: row.recipient_username,
    attemptCount: row.attempt_count,
    reconciliationCount: row.reconciliation_count,
    unknownOutcome: !!row.unknown_outcome,
    sendAcknowledgedAt: iso(row.send_acknowledged_at),
    attempts,
    nextAttemptsCursor:
      rows.results.length > 20 && last
        ? encodeTimeCursor({ id: last.id, createdAt: last.started_at })
        : null,
  };
}

async function diagnosticSummary(
  env: ApiBindings,
  taskId: string,
  attempt: AttemptSqlRow,
): Promise<string | null> {
  if (!attempt.diagnostic_ciphertext) return null;
  try {
    const value = await decryptString(
      attempt.diagnostic_ciphertext,
      env,
      `payment-diagnostic:${taskId}:${attempt.id}`,
    );
    return sanitizeUpstreamMessage(value) || null;
  } catch {
    return null;
  }
}
