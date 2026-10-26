import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { type merchants, paymentTasks } from "../db/schema";
import type { ApiBindings } from "../env";
import type { PaymentTaskRow } from "./adapter";

type MerchantRow = typeof merchants.$inferSelect;

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

/** Keep the original canonical shape so existing payment digests remain valid. */
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

export type PaymentIdentityCorrectionRow = {
  id: string;
  taskId: string;
  version: number;
  originalClientId: string;
  correctedClientId: string;
  originalParameterDigest: string;
  correctedParameterDigest: string;
  merchantVersion: number;
  credentialVersion: number;
  evidence: "never_sent" | "rejected_no_order";
  createdAt: number;
};

export type EffectivePaymentTaskRow = PaymentTaskRow & {
  identityCorrectionVersion?: number;
};

export async function merchantOwnsClientId(
  env: ApiBindings,
  merchantId: string,
  clientId: string,
) {
  return Boolean(
    await env.DB.prepare(
      "SELECT client_id FROM merchant_client_ids WHERE merchant_id=? AND client_id=?",
    )
      .bind(merchantId, clientId)
      .first(),
  );
}

export async function loadPaymentIdentityCorrections(
  env: ApiBindings,
  taskId: string,
): Promise<PaymentIdentityCorrectionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id,task_id AS taskId,version,original_client_id AS originalClientId,
      corrected_client_id AS correctedClientId,original_parameter_digest AS originalParameterDigest,
      corrected_parameter_digest AS correctedParameterDigest,merchant_version AS merchantVersion,
      credential_version AS credentialVersion,evidence,created_at AS createdAt
      FROM payment_identity_corrections WHERE task_id=? ORDER BY version`,
  )
    .bind(taskId)
    .all<PaymentIdentityCorrectionRow>();
  return rows.results;
}

/** A correction changes only the request snapshot; the original debt remains immutable. */
export async function effectiveClaimPaymentTask(
  env: ApiBindings,
  task: PaymentTaskRow,
): Promise<EffectivePaymentTaskRow> {
  const corrections = await loadPaymentIdentityCorrections(env, task.id);
  if (!corrections.length) return { ...task, identityCorrectionVersion: 0 };
  if (
    task.source !== "claim" ||
    task.mode !== "real" ||
    task.recoveryPolicy !== "claim_same_order_v1" ||
    task.parameterDigest !== (await claimPaymentParameterDigest(task))
  )
    throw new Error("Payment identity correction source mismatch");
  let effective: EffectivePaymentTaskRow = {
    ...task,
    identityCorrectionVersion: 0,
  };
  for (const correction of corrections) {
    const next: EffectivePaymentTaskRow = {
      ...effective,
      clientId: correction.correctedClientId,
      parameterDigest: correction.correctedParameterDigest,
      identityCorrectionVersion: correction.version,
    };
    if (
      correction.taskId !== task.id ||
      correction.version !== (effective.identityCorrectionVersion ?? 0) + 1 ||
      correction.originalClientId !== effective.clientId ||
      correction.originalParameterDigest !== effective.parameterDigest ||
      correction.correctedClientId === effective.clientId ||
      correction.correctedParameterDigest !==
        (await claimPaymentParameterDigest(next)) ||
      !(await merchantOwnsClientId(
        env,
        task.merchantId,
        correction.correctedClientId,
      ))
    )
      throw new Error("Payment identity correction chain mismatch");
    effective = next;
  }
  return effective;
}

export function paymentIdentitySnapshotGuard(
  taskId: string,
  snapshot: EffectivePaymentTaskRow,
) {
  const version = snapshot.identityCorrectionVersion ?? 0;
  if (!version)
    return {
      sql: "AND NOT EXISTS(SELECT 1 FROM payment_identity_corrections WHERE task_id=?)",
      values: [taskId] as (string | number)[],
    };
  return {
    sql: `AND EXISTS(SELECT 1 FROM payment_identity_corrections i WHERE i.task_id=?
      AND i.version=? AND i.corrected_client_id=? AND i.corrected_parameter_digest=?
      AND NOT EXISTS(SELECT 1 FROM payment_identity_corrections n WHERE n.task_id=i.task_id AND n.version>i.version))`,
    values: [
      taskId,
      version,
      snapshot.clientId,
      snapshot.parameterDigest ?? "",
    ],
  };
}

export async function synchronizeClaimPaymentIdentity(
  env: ApiBindings,
  merchant: MerchantRow,
  task: PaymentTaskRow,
) {
  if (
    task.source !== "claim" ||
    task.mode !== "real" ||
    task.recoveryPolicy !== "claim_same_order_v1" ||
    task.status === "confirmed" ||
    task.unknownOutcome ||
    task.externalOrderId !== null ||
    task.orderObservedAt !== null ||
    task.sendAcknowledgedAt !== null ||
    task.merchantId !== merchant.id ||
    merchant.leaseToken !== null ||
    task.parameterDigest !== (await claimPaymentParameterDigest(task))
  )
    return false;
  const effective = await effectiveClaimPaymentTask(env, task);
  if (effective.clientId === merchant.clientId) return false;
  const credential = await env.DB.prepare(
    "SELECT client_id,verification_status FROM merchant_credentials WHERE merchant_id=? AND version=?",
  )
    .bind(merchant.id, merchant.credentialVersion)
    .first<{ client_id: string; verification_status: string }>();
  if (
    credential?.client_id !== merchant.clientId ||
    credential.verification_status !== "passed"
  )
    return false;
  const attempts = await env.DB.prepare(
    `SELECT COUNT(CASE WHEN operation='send' AND purpose='recovery' THEN 1 END) AS sends,
      COUNT(CASE WHEN outcome='started' OR finished_at IS NULL THEN 1 END) AS unfinished,
      COUNT(CASE WHEN operation='send' AND purpose='recovery' AND
        (no_order_evidence IS NOT 'protocol_rejection_v1' OR outcome!='rejected' OR finished_at IS NULL) THEN 1 END) AS unsafe
      FROM payment_attempts WHERE task_id=?`,
  )
    .bind(task.id)
    .first<{ sends: number; unfinished: number; unsafe: number }>();
  if (
    !attempts ||
    attempts.unfinished > 0 ||
    attempts.unsafe > 0 ||
    attempts.sends !== task.attemptCount
  )
    return false;
  const id = crypto.randomUUID();
  const now = Date.now();
  const correctedDigest = await claimPaymentParameterDigest({
    ...effective,
    clientId: merchant.clientId,
  });
  const version = (effective.identityCorrectionVersion ?? 0) + 1;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payment_identity_corrections(id,task_id,version,original_client_id,corrected_client_id,
          original_parameter_digest,corrected_parameter_digest,merchant_version,credential_version,evidence,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        task.id,
        version,
        effective.clientId,
        merchant.clientId,
        effective.parameterDigest ?? "",
        correctedDigest,
        merchant.version,
        merchant.credentialVersion,
        task.attemptCount === 0 ? "never_sent" : "rejected_no_order",
        now,
      ),
      env.DB.prepare(
        `UPDATE payment_tasks SET next_action='query',next_query_at=MAX(?,COALESCE(query_retry_after_at,0)),
          next_run_at=MAX(?,COALESCE(query_retry_after_at,0)),
          status=CASE WHEN status='attention' AND send_block_reason='configuration' THEN 'waiting' ELSE status END,
          reason=CASE WHEN send_block_reason IN ('credentials','configuration') THEN NULL ELSE reason END,
          send_block_reason=CASE WHEN send_block_reason IN ('credentials','configuration') THEN NULL ELSE send_block_reason END
          WHERE id=? AND recovery_version=? AND EXISTS(SELECT 1 FROM payment_identity_corrections WHERE id=?)`,
      ).bind(now, now, task.id, task.recoveryVersion + 1, id),
    ]);
    return true;
  } catch (error) {
    const changed = await env.DB.prepare(
      `SELECT p.recovery_version,m.version,m.lease_token,c.verification_status FROM payment_tasks p
        JOIN merchants m ON m.id=p.merchant_id JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version WHERE p.id=?`,
    )
      .bind(task.id)
      .first<{
        recovery_version: number;
        version: number;
        lease_token: string | null;
        verification_status: string;
      }>();
    if (
      changed?.recovery_version !== task.recoveryVersion ||
      changed.version !== merchant.version ||
      changed.lease_token !== null ||
      changed.verification_status !== "passed"
    )
      return false;
    throw error;
  }
}

/** Bounded so credential recovery can also revive a definitely rejected configuration. */
export async function synchronizeMerchantPaymentIdentities(
  env: ApiBindings,
  merchant: MerchantRow,
) {
  if (merchant.mode !== "real" || merchant.leaseToken !== null) return;
  const credential = await env.DB.prepare(
    "SELECT verification_status,client_id FROM merchant_credentials WHERE merchant_id=? AND version=?",
  )
    .bind(merchant.id, merchant.credentialVersion)
    .first<{ verification_status: string; client_id: string }>();
  if (
    credential?.verification_status !== "passed" ||
    credential.client_id !== merchant.clientId
  )
    return;
  const candidates = await env.DB.prepare(
    `SELECT p.id FROM payment_tasks p WHERE p.merchant_id=? AND p.source='claim' AND p.mode='real'
      AND p.recovery_policy='claim_same_order_v1' AND p.status NOT IN ('confirmed','failed') AND p.unknown_outcome=0
      AND p.confirmed_at IS NULL AND p.parameter_digest IS NOT NULL
      AND p.order_observed_at IS NULL AND p.external_order_id IS NULL AND p.send_acknowledged_at IS NULL
      AND COALESCE(p.send_block_reason,'')!='conflict'
      AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND (a.outcome='started' OR a.finished_at IS NULL))
      AND ((p.attempt_count=0 AND p.first_send_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send'))
        OR (p.attempt_count>0 AND p.first_send_at IS NOT NULL
          AND p.attempt_count=(SELECT COUNT(*) FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send' AND a.purpose='recovery')
          AND NOT EXISTS(SELECT 1 FROM payment_attempts a WHERE a.task_id=p.id AND a.operation='send'
            AND (a.no_order_evidence IS NOT 'protocol_rejection_v1' OR a.outcome!='rejected' OR a.finished_at IS NULL))))
      AND COALESCE((SELECT corrected_client_id FROM payment_identity_corrections WHERE task_id=p.id ORDER BY version DESC LIMIT 1),p.client_id)!=?
      ORDER BY p.created_at,p.id LIMIT 20`,
  )
    .bind(merchant.id, merchant.clientId)
    .all<{ id: string }>();
  for (const candidate of candidates.results) {
    const decoded = await createDb(env.DB)
      .select()
      .from(paymentTasks)
      .where(eq(paymentTasks.id, candidate.id))
      .get();
    if (decoded) await synchronizeClaimPaymentIdentity(env, merchant, decoded);
  }
}
