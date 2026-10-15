import { z } from "zod";
import type { PublicUserProfile } from "./profile";

export const paymentModeSchema = z.enum(["simulation", "real"]);
export type PaymentMode = z.infer<typeof paymentModeSchema>;
export const paymentStateSchema = z.enum([
  "pending",
  "sending",
  "reconciling",
  "waiting",
  "confirmed",
  "attention",
]);
export type PaymentState = z.infer<typeof paymentStateSchema>;
export const simulationScenarioSchema = z.enum([
  "normal",
  "response_lost",
  "query_delayed",
  "query_unavailable",
  "insufficient_funds",
  "daily_limit",
  "invalid_credentials",
  "conflict",
]);
export type SimulationScenario = z.infer<typeof simulationScenarioSchema>;
export const moneySchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/, "金额须为正数，最多两位小数")
  .refine((value) => {
    if (!/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(value)) return false;
    const [whole, decimal = ""] = value.split(".");
    const cents = BigInt(whole ?? "0") * 100n + BigInt(decimal.padEnd(2, "0"));
    return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER);
  }, "金额须大于零且不超过安全整数范围");
export function amountToMinor(value: string): number {
  const parsed = moneySchema.parse(value);
  const [whole, decimal = ""] = parsed.split(".");
  return Number(BigInt(whole ?? "0") * 100n + BigInt(decimal.padEnd(2, "0")));
}
export function formatAmount(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error("Invalid amount");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
export const createMerchantSchema = z.strictObject({
  requestId: z.uuid(),
  mode: paymentModeSchema.default("simulation"),
  label: z.string().trim().min(1).max(100),
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  secret: z.string().min(1).max(4096),
});
export const updateMerchantSchema = z.strictObject({
  requestId: z.uuid().optional(),
  clientId: createMerchantSchema.shape.clientId.optional(),
  confirmationToken: z.string().max(512).optional(),
  version: z.number().int().positive(),
  label: z.string().trim().min(1).max(100),
  secret: z.string().min(1).max(4096).optional(),
});
export const repairPaymentCredentialSchema = z.strictObject({
  requestId: z.uuid(),
  version: z.number().int().positive(),
  secret: z.string().min(1).max(4096),
});
export type RepairPaymentCredentialInput = z.infer<
  typeof repairPaymentCredentialSchema
>;
export type MerchantChangeImpact = {
  activeActivities: number;
  unfinishedDraws: number;
  pendingPayments: number;
  sendingPayments: number;
  reconcilingPayments: number;
};
export type MerchantChangePreview = {
  impact: MerchantChangeImpact;
  confirmationToken: string;
};
export type CreateMerchantInput = z.input<typeof createMerchantSchema>;
export type UpdateMerchantInput = z.infer<typeof updateMerchantSchema>;
export type CredentialVerificationStatus =
  | "unverified"
  | "checking"
  | "passed"
  | "rejected"
  | "unavailable";
export type CredentialVerification = {
  status: CredentialVerificationStatus;
  credentialVersion: number;
  checkedAt: string | null;
  nextCheckAt: string | null;
  reason: string | null;
};
export type Merchant = {
  appliedChange?: {
    requestId: string;
    resultVersion: number;
    clientId: string;
    credentialVersion: number;
  };
  id: string;
  label: string;
  usageStatus: "current" | "legacy";
  publicationEligibility: {
    allowed: boolean;
    reason: LdcOpeningBlockedReason | null;
    credentialVersion: number;
  };
  clientId: string;
  version: number;
  credentialVersion: number;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
  credentialVerification: CredentialVerification;
  capabilities: {
    canExecutePayments: boolean;
    canSimulate: boolean;
  };
} & ({ mode: "simulation"; scenario: SimulationScenario } | { mode: "real" });
export type LdcOpeningBlockedReason =
  | "REAL_LDC_NOT_ENABLED"
  | "TIMED_DRAW_NOT_ENABLED"
  | "MERCHANT_LEGACY"
  | "MERCHANT_CREDENTIALS_UNVERIFIED"
  | "MERCHANT_CREDENTIALS_CHECKING"
  | "MERCHANT_CREDENTIALS_REJECTED"
  | "MERCHANT_CREDENTIALS_UNAVAILABLE";
export type MerchantList = {
  items: Merchant[];
  nextCursor: string | null;
  currentMerchantId: string | null;
  canCreate: boolean;
  canSimulate: boolean;
};
export type PaymentView = {
  id: string;
  mode: PaymentMode;
  status: PaymentState;
  reason: string | null;
  confirmedAt: string | null;
};
export type MerchantPayment = PaymentView & {
  amount: string;
  businessNo: string;
  externalOrderId: string | null;
  createdAt: string;
  nextRunAt: string;
} & (
    | {
        source: "claim";
        claimId: string;
        activityId: string;
        acceptanceId: null;
      }
    | {
        source: "acceptance";
        claimId: null;
        activityId: null;
        acceptanceId: string;
      }
  );
export type PaymentAttemptView = {
  clientId?: string | null;
  identityCorrectionVersion?: number;
  noOrderEvidence?: string | null;
  recipientUsername: string | null;
  purpose: "recovery" | "probe";
  diagnosticSummary: string | null;
  httpStatus: number | null;
  id: string;
  operation: "send" | "query";
  outcome: string;
  reason: string | null;
  credentialVersion: number;
  startedAt: string;
  finishedAt: string | null;
};
export type MerchantPaymentDetail = MerchantPayment & {
  config?: {
    originalClientId: string;
    effectiveClientId: string;
    credentialVersion: number;
    identityCorrectionVersion: number;
    canRepairCredentials: boolean;
  };
  identityCorrections?: {
    version: number;
    originalClientId: string;
    correctedClientId: string;
    evidence: "never_sent" | "rejected_no_order";
    createdAt: string;
  }[];
  recipientProfile: PublicUserProfile | null;
  recoveryPolicy: "claim_same_order_v1" | null;
  firstSendAt: string | null;
  usernameCorrection: {
    originalUsername: string;
    correctedUsername: string;
    createdAt: string;
  } | null;
  nextAction: "query" | "send" | "none";
  nextSendAt: string | null;
  nextQueryAt: string | null;
  sendBlockReason: string | null;
  orderObservedAt: string | null;
  orderEvidence: "receipt" | "query" | "duplicate" | null;
  retryAuthorization: {
    policy: "same_order_v1";
    maxAdditionalSends: number;
    usedAdditionalSends: number;
    expiresAt: string;
    revokedAt: string | null;
  } | null;
  duplicateProbe: {
    status:
      | "pending"
      | "sending"
      | "reconciling"
      | "awaiting_evidence"
      | "passed"
      | "inconclusive"
      | "conflict";
    baselineExternalOrderId: string;
    permitConsumedAt: string | null;
    nextRunAt: string;
    queryCount: number;
    reason: string | null;
    protocolVerifiedAt: string | null;
    backendVerifiedAt: string | null;
  } | null;
  recipientId: string;
  recipientUsername: string | null;
  attemptCount: number;
  reconciliationCount: number;
  unknownOutcome: boolean;
  sendAcknowledgedAt: string | null;
  attempts: PaymentAttemptView[];
  nextAttemptsCursor: string | null;
};
export type MerchantPaymentList = {
  items: MerchantPayment[];
  nextCursor: string | null;
};
export const PAYMENT_LABELS: Record<PaymentState, string> = {
  pending: "待发放",
  sending: "发送中",
  reconciling: "核对中",
  waiting: "等待恢复",
  confirmed: "已发放",
  attention: "异常待处理",
};

export function paymentLabel(mode: PaymentMode, status: PaymentState): string {
  if (status === "confirmed") {
    return mode === "simulation" ? "模拟发放已确认" : "已发放";
  }
  return PAYMENT_LABELS[status];
}
