// 🐟额 (docs/balance-design.md): LDC kept on this site, 1 🐟 to 1 LDC.
// Amounts are whole cents (minor units) everywhere here, as in payments.ts.
import { z } from "zod";
import type { CredentialVerification } from "./payments";
import { moneySchema } from "./payments";

export const BALANCE_LIMITS = {
  /** What Credit takes for one 转入: 1.00–2000.00 LDC. */
  topupMinMinor: 100,
  topupMaxMinor: 200_000,
  /** Above this, Credit's daily limit may refuse it (800–2000 by level). */
  topupDailyHintMinor: 80_000,
  /** New 转入 a person may start in an hour (against scripts, nothing else). */
  topupsPerHour: 30,
  /** Fee rates are whole percentages. */
  feePercentMax: 50,
  /** A 转出 is at least 1 🐟; its cap is a setting. */
  withdrawMinMinor: 100,
  withdrawMaxDefaultMinor: 100_000,
  /** One 站长补加 or 扣回 of one's own (balance-design §15): 2000 🐟. */
  ownerAdjustMaxMinor: 200_000,
  /** New 转出 a person may ask for in an hour, like 转入. */
  withdrawalsPerHour: 30,
  /** An invitation's link lasts a day. */
  inviteLifetimeMs: 86_400_000,
  /** An admin's 通用链接: up to this many people, for 1 or 7 days. */
  inviteLinkMaxUses: 1000,
  inviteLinkDays: [1, 7],
} as const;

/**
 * Credit's fee on an amount: amount × rate, rounded half up to the cent
 * (service/payment.go CalculateFee, decimal.Round(2)).
 */
export function feeOf(amountMinor: number, percent: number) {
  return Math.floor((amountMinor * percent + 50) / 100);
}

export type TopupQuote = {
  /** What Credit takes from the payer (LDC). */
  debitMinor: number;
  /** Credit's 流转费. */
  feeMinor: number;
  /** What arrives in 🐟额 (🐟). */
  creditMinor: number;
};

/**
 * A 转入 from either side: what Credit takes, or what should arrive. From
 * what arrives, the least Credit can take that still brings at least that
 * much (the fee is rounded, so a few amounts cannot arrive exactly).
 */
export function quoteTopup(
  percent: number,
  input: { debitMinor: number } | { creditMinor: number },
): TopupQuote {
  const of = (debitMinor: number) => {
    const feeMinor = feeOf(debitMinor, percent);
    return { debitMinor, feeMinor, creditMinor: debitMinor - feeMinor };
  };
  if ("debitMinor" in input) return of(input.debitMinor);
  const target = input.creditMinor;
  let debit = Math.max(1, Math.ceil((target * 100) / (100 - percent)));
  while (debit > 1 && of(debit - 1).creditMinor >= target) debit -= 1;
  while (of(debit).creditMinor < target) debit += 1;
  return of(debit);
}

export type WithdrawQuote = {
  /** Taken from 🐟额 (🐟). */
  debitMinor: number;
  /** Credit's 分发费, at the platform account's level. */
  feeMinor: number;
  /** What should arrive in Credit (LDC). */
  creditMinor: number;
};

/** A 转出: Credit takes its 分发费 from what is sent. */
export function quoteWithdraw(
  percent: number,
  input: { debitMinor: number } | { creditMinor: number },
): WithdrawQuote {
  return quoteTopup(percent, input);
}

/** Signed cents as "12.34" or "-12.34" (formatAmount takes no negatives). */
export function formatSignedAmount(minor: number) {
  if (!Number.isSafeInteger(minor)) throw new Error("Invalid amount");
  const sign = minor < 0 ? "-" : "";
  const value = Math.abs(minor);
  return `${sign}${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

const feePercentSchema = z
  .number()
  .int()
  .min(0)
  .max(BALANCE_LIMITS.feePercentMax);
export const balanceSettingsSchema = z.strictObject({
  topupEnabled: z.boolean(),
  withdrawEnabled: z.boolean(),
  topupFeePercent: feePercentSchema,
  withdrawFeePercent: feePercentSchema,
  withdrawMaxMinor: z
    .number()
    .int()
    .min(BALANCE_LIMITS.withdrawMinMinor)
    .max(BALANCE_LIMITS.topupMaxMinor),
  /** 🐟额红包 (docs/balance-design.md §14); left as it is when absent. */
  hongbaoEnabled: z.boolean().optional(),
});
export type BalanceSettingsInput = z.infer<typeof balanceSettingsSchema>;

export const updateBalanceSettingsSchema = balanceSettingsSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export type UpdateBalanceSettingsInput = z.infer<
  typeof updateBalanceSettingsSchema
>;

export type BalanceSettings = Required<BalanceSettingsInput> & {
  version: number;
  updatedAt: number;
};

export const savePlatformAppSchema = z.strictObject({
  requestId: z.uuid(),
  /** The platform app's version when it exists; absent to create it. */
  version: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(100),
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Required to create it, or with a new Client ID. */
  secret: z.string().min(1).max(4096).optional(),
});
export type SavePlatformAppInput = z.infer<typeof savePlatformAppSchema>;

export type PlatformApp = {
  id: string;
  label: string;
  clientId: string;
  version: number;
  credentialVersion: number;
  credentialVerification: CredentialVerification;
  updatedAt: string;
};

export const createTopupSchema = z.strictObject({
  requestId: z.uuid(),
  settingsVersion: z.number().int().positive(),
  /** Which box was filled: what Credit takes, or what should arrive. */
  by: z.enum(["debit", "credit"]),
  amount: moneySchema,
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

export const createWithdrawalSchema = z.strictObject({
  requestId: z.uuid(),
  settingsVersion: z.number().int().positive(),
  /** Which box was filled: what leaves 🐟额, or what should arrive. */
  by: z.enum(["debit", "credit"]),
  amount: moneySchema,
});
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;

export const balanceAdjustmentSchema = z.strictObject({
  requestId: z.uuid(),
  direction: z.enum(["add", "deduct"]),
  amount: moneySchema,
  reason: z.string().trim().min(1).max(200),
});
export type BalanceAdjustmentInput = z.infer<typeof balanceAdjustmentSchema>;

/** The 站长's own 补加 or 扣回 (balance-design §15): no reason to give. */
export const ownerAdjustmentSchema = z.strictObject({
  requestId: z.uuid(),
  direction: z.enum(["add", "deduct"]),
  amount: moneySchema,
});
export type OwnerAdjustmentInput = z.infer<typeof ownerAdjustmentSchema>;

export const confirmTopupSchema = z.strictObject({
  reason: z.string().trim().min(1).max(200),
});

/** 待确认 / 未完成 / 已到账. */
export type TopupStatus = "pending" | "unpaid" | "credited";
/** 订单信息不符 / 查单不再成功: noted beside the status, never instead of it. */
export type TopupFlag = "mismatch" | "reversed";

export type BalanceTopup = {
  id: string;
  businessNo: string;
  externalOrderId: string | null;
  status: TopupStatus;
  flag: TopupFlag | null;
  debitMinor: number;
  feeMinor: number;
  creditMinor: number;
  feePercent: number;
  createdAt: number;
  /** Until when “去 Credit 确认” can open the same order again. */
  payableUntil: number;
  creditedAt: number | null;
  creditedBy: "auto" | "admin" | null;
  lastCheckedAt: number | null;
};

/** 发放中 / 已发放 / 未发出. */
export type WithdrawalStatus = "sending" | "sent" | "failed";
/**
 * What a 发放中 one waits on, from its payment: its turn, Credit's daily
 * limit, the platform account's LDC, the platform app's credentials, a
 * check at Credit, or an admin (Credit's answer did not match).
 */
export type WithdrawalWait =
  | "queued"
  | "quota"
  | "funds"
  | "credentials"
  | "checking"
  | "attention";
/** Why Credit turned one down for good (no order made): 未发出. */
export type WithdrawalFailure =
  | "recipient"
  | "self_payment"
  | "configuration"
  | "validation";

export type BalanceWithdrawal = {
  id: string;
  businessNo: string;
  externalOrderId: string | null;
  status: WithdrawalStatus;
  /** Taken from 🐟额. */
  debitMinor: number;
  /** Credit's 分发费, as worked out at the time. */
  feeMinor: number;
  /** What should arrive in Credit. */
  creditMinor: number;
  feePercent: number;
  /** The Credit account it goes to. */
  recipientUsername: string;
  createdAt: number;
  sentAt: number | null;
  failedAt: number | null;
  failure: WithdrawalFailure | null;
  /** While 发放中. */
  wait: WithdrawalWait | null;
  /** When a wait for the daily limit ends. */
  resumeAt: number | null;
};

export type BalanceEntryKind =
  | "topup"
  | "adjustment"
  | "lock"
  | "unlock"
  | "deduct";

export type BalanceEntry = {
  id: string;
  kind: BalanceEntryKind;
  availableDeltaMinor: number;
  lockedDeltaMinor: number;
  topupId: string | null;
  /** An adjustment's reason, as the person sees it. */
  reason: string | null;
  createdAt: number;
};

/**
 * What someone may do with 🐟额 (docs/balance-design.md §13): 转入 once
 * invited, invite once invited (admins always). 转出 needs neither.
 */
export type BalanceAccess = { topup: boolean; invite: boolean };

/** A LINUX DO username, as typed (a leading @ is fine). */
export const inviteUsernameSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, ""))
  .pipe(
    z
      .string()
      .min(1, "请填对方的用户名")
      .max(60, "用户名太长了")
      .regex(/^[A-Za-z0-9_.-]+$/, "用户名只有字母、数字和 _ . -"),
  );

export const createInviteSchema = z.strictObject({
  username: inviteUsernameSchema,
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/** An admin's 通用链接: how many people may use it, and for how long. */
export const createInviteLinkSchema = z.strictObject({
  maxUses: z
    .number({ error: "请填最多几个人用" })
    .int("人数是整数")
    .min(1, "至少 1 个人")
    .max(
      BALANCE_LIMITS.inviteLinkMaxUses,
      `最多 ${BALANCE_LIMITS.inviteLinkMaxUses} 个人`,
    ),
  days: z.union([z.literal(1), z.literal(7)], {
    error: "有效期是 1 天或 7 天",
  }),
});
export type CreateInviteLinkInput = z.infer<typeof createInviteLinkSchema>;

/** 有效 / 已用完 / 已过期 / 已停用. */
export type BalanceInviteLinkStatus =
  | "active"
  | "used_up"
  | "expired"
  | "stopped";

/** 待接受 / 已接受 / 已过期 (a day after it was made). */
export type BalanceInviteStatus = "pending" | "accepted" | "expired";

export type BalanceInviteUser = {
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type BalanceInvite = {
  id: string;
  /** The username it is for: the account's own spelling once it has been here. */
  username: string;
  status: BalanceInviteStatus;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  /** Who accepted it, as they are now. */
  acceptedBy: BalanceInviteUser | null;
};

/** A 通用链接 as admins see it (the link itself is shown once, when made). */
export type BalanceInviteLink = {
  id: string;
  status: BalanceInviteLinkStatus;
  maxUses: number;
  useCount: number;
  createdAt: number;
  expiresAt: number;
  stoppedAt: number | null;
  createdBy: BalanceInviteUser | null;
  stoppedBy: BalanceInviteUser | null;
};
