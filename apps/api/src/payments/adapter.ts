import type { PaymentMode } from "@hb/contracts";
import type { paymentTasks } from "../db/schema";

export type PaymentTaskRow = typeof paymentTasks.$inferSelect;

export type PaymentReason =
  | "funds"
  | "quota"
  | "credentials"
  | "unknown"
  | "checking_not_found"
  | "conflict"
  | "disabled"
  | "network"
  | "timeout"
  | "http"
  | "redirect"
  | "invalid_response"
  | "interrupted"
  | "recipient"
  | "self_payment"
  | "configuration"
  | "validation"
  | "duplicate_order"
  | "upstream_pending"
  | "throttled";

export type SendPaymentEvidence = {
  source: "send";
  businessNo?: string;
  externalOrderId?: string;
};
export type QueryPaymentEvidence = {
  source: "query";
  clientId?: string;
  businessNo?: string;
  amountMinor?: number;
  externalOrderId?: string;
  status?: 0 | 1;
};
export type SimulationPaymentEvidence = {
  source: "send" | "query";
  clientId?: string;
  businessNo?: string;
  amountMinor?: number;
  recipientId?: string;
  externalOrderId?: string;
  status?: 0 | 1;
};
export type PaymentEvidence =
  | SendPaymentEvidence
  | QueryPaymentEvidence
  | SimulationPaymentEvidence;

export type AdapterResult = (
  | { kind: "confirmed"; evidence: PaymentEvidence }
  | { kind: "sent"; evidence: SendPaymentEvidence }
  | {
      kind: "waiting";
      reason: Extract<PaymentReason, "funds" | "quota" | "credentials">;
    }
  | {
      kind: "rejected";
      reason: Extract<
        PaymentReason,
        "recipient" | "self_payment" | "configuration" | "validation"
      >;
    }
  | { kind: "duplicate"; reason: "duplicate_order" }
  | {
      kind: "unconfirmed";
      reason: "upstream_pending";
      evidence: QueryPaymentEvidence & { status: 0 };
    }
  | { kind: "throttled"; reason: "throttled" }
  | { kind: "not_found"; reason?: PaymentReason }
  | { kind: "unknown"; reason?: PaymentReason }
  | {
      kind: "conflict";
      reason?: PaymentReason;
      evidence?: QueryPaymentEvidence;
    }
) & {
  httpStatus?: number;
  retryAfterMs?: number;
  /** Already sanitized and limited to 512 characters. Persist only after encryption. */
  upstreamMessage?: string;
  /** Exact documented pre-creation or rolled-back business rejection; never inferred from HTTP alone. */
  noOrderEvidence?: "protocol_rejection_v1";
};

export type PaymentAttemptContext = {
  credentialVersion: number;
  clientSecret?: string;
  clientId?: string;
};

export type PaymentAdapter = {
  mode: PaymentMode;
  send(
    task: PaymentTaskRow,
    context: PaymentAttemptContext,
  ): Promise<AdapterResult>;
  query(
    task: PaymentTaskRow,
    context: PaymentAttemptContext,
  ): Promise<AdapterResult>;
};

export type PaymentAdapterFactory = (
  mode: PaymentMode,
) => PaymentAdapter | null | undefined;

/** A complete status=0 order still proves an order exists, but never proves payment. */
export function ensureQueryEvidenceMatchesTask(
  task: PaymentTaskRow,
  evidence: QueryPaymentEvidence,
) {
  return (
    evidence.source === "query" &&
    Boolean(evidence.clientId) &&
    evidence.clientId === task.clientId &&
    Boolean(evidence.businessNo) &&
    evidence.businessNo === task.businessNo &&
    evidence.amountMinor === task.amountMinor &&
    Boolean(evidence.externalOrderId) &&
    (!task.externalOrderId ||
      evidence.externalOrderId === task.externalOrderId) &&
    (evidence.status === 0 || evidence.status === 1)
  );
}

export function ensureEvidenceMatchesTask(
  task: PaymentTaskRow,
  evidence: PaymentEvidence,
  operation: "send" | "query",
) {
  if (evidence.source !== operation) return false;
  if (operation === "send") {
    if (!evidence.businessNo || !evidence.externalOrderId) return false;
  } else {
    if (
      !("clientId" in evidence) ||
      !evidence.clientId ||
      !evidence.businessNo ||
      !("amountMinor" in evidence) ||
      evidence.amountMinor === undefined ||
      !evidence.externalOrderId ||
      !("status" in evidence) ||
      evidence.status !== 1
    )
      return false;
  }
  if (
    "clientId" in evidence &&
    evidence.clientId !== undefined &&
    evidence.clientId !== task.clientId
  )
    return false;
  if (
    evidence.businessNo !== undefined &&
    evidence.businessNo !== task.businessNo
  )
    return false;
  if (
    "amountMinor" in evidence &&
    evidence.amountMinor !== undefined &&
    evidence.amountMinor !== task.amountMinor
  )
    return false;
  if (
    "recipientId" in evidence &&
    evidence.recipientId !== undefined &&
    evidence.recipientId !== task.recipientId
  )
    return false;
  if (
    task.externalOrderId &&
    evidence.externalOrderId &&
    evidence.externalOrderId !== task.externalOrderId
  )
    return false;
  return true;
}
