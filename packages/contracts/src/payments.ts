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
  /**
   * 未发出, final, with no order made: a 🐟额 转出 turned down for good, or
   * a claim's payment whose recipient had no Credit account and was not
   * sent again in time (payments/resend.ts).
   */
  "failed",
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
/** What a merchant pays for: its 红包 and their payments (商户页). */
export type MerchantUsage = {
  activities: number;
  /** Still running, or a draw still to settle. */
  activeActivities: number;
  payments: number;
  openPayments: number;
  openAmount: string;
  confirmedAmount: string;
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
  /** Stopped by Credit's daily limit: when it sends again (ISO). */
  quotaResumeAt?: string;
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
  /** 🐟额红包 (docs/balance-design.md §14): its switch is off. */
  | "BALANCE_HONGBAO_PAUSED"
  /** 🐟额红包: 可用 does not cover the total. */
  | "BALANCE_INSUFFICIENT"
  /** 代码判定红包 (docs/programmable-hongbao-design.md §1): its switch is off. */
  | "CODE_HONGBAO_PAUSED"
  /** 代码判定红包: only 🐟额 PLUS (and the 站长) send it. */
  | "CODE_HONGBAO_NOT_ALLOWED"
  /** 代码判定红包: no 判定器 of this code passed these tests (部署, §5). */
  | "JUDGE_CHECK_REQUIRED"
  /** 代码判定红包: this code is deployed, but tests.json changed since: rerun it. */
  | "JUDGE_RERUN_REQUIRED"
  /** 代码判定红包: today's openings are used up. */
  | "CODE_HONGBAO_DAILY_LIMIT"
  /** 代码判定红包: its code goes online, and 联网 is off (§9.7). */
  | "CODE_NETWORK_PAUSED"
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
/**
 * A claim's payment turned down for want of the recipient's LINUX DO Credit
 * account can be sent again by its claimant, once they have one: within
 * this long of the first such answer, this many times (once). Nothing
 * retries it by itself, and past that it is not paid (user's rule).
 */
export const PAYMENT_RESEND_WINDOW_MS = 5 * 60_000;
export const PAYMENT_RESEND_LIMIT = 1;

export type PaymentView = {
  id: string;
  mode: PaymentMode;
  status: PaymentState;
  reason: string | null;
  confirmedAt: string | null;
  /** Its claimant may send it again until then (ISO); absent otherwise. */
  resendUntil?: string;
  /**
   * Its merchant is stopped by Credit's daily limit (reason "quota"): when
   * it sends again (ISO). The payments queued behind wait for it too.
   */
  quotaResumeAt?: string;
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
  failed: "未发出",
};

export function paymentLabel(mode: PaymentMode, status: PaymentState): string {
  if (status === "confirmed") {
    return mode === "simulation" ? "模拟发放已确认" : "已发放";
  }
  return PAYMENT_LABELS[status];
}
