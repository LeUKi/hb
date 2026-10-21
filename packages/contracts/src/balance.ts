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
  /** An admin's 通用链接: up to this many people (or any), 1 or 7 days or for good. */
  inviteLinkMaxUses: 1000,
  /** Its 附言, under the accept page's title. */
  inviteLinkNoteMax: 100,
  /** 转账 (balance-design §16): its remark, and its open API keys. */
  transferRemarkMax: 64,
  apiKeyNameMax: 20,
  apiKeysMax: 10,
  /** One key's 转账 in any 60 seconds, and its reads in a minute. */
  apiTransfersPerMinute: 600,
  apiReadsPerMinute: 600,
  transferBatchMax: 100,
  outTransferNoMax: 64,
  /** A list page of the open API's 流水. */
  transferPageMax: 100,
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
  /** 转账 (§16); left as it is when absent. */
  transferEnabled: z.boolean().optional(),
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

/**
 * What someone may do with 🐟额 (docs/balance-design.md §13): 转入 once
 * invited, invite once invited (admins always). 转出 needs neither.
 */
export type BalanceAccess = { topup: boolean; invite: boolean };

/** 对方的🐟额 or 对方的 Credit 账户 (balance-design §16). */
export const transferDestinationSchema = z.enum(["balance", "credit"]);
export type TransferDestination = z.infer<typeof transferDestinationSchema>;

/** A LINUX DO account's numeric ID, as a decimal string. */
export const linuxDoUserIdSchema = z
  .string({ error: "请填对方的数字 ID" })
  .regex(/^[1-9][0-9]{0,18}$/, "数字 ID 是一串数字");

const characters = (value: string) => Array.from(value).length;

/** What the other side reads with a 转账, on this site only. */
export const transferRemarkSchema = z
  .string()
  .trim()
  .refine(
    (value) => characters(value) <= BALANCE_LIMITS.transferRemarkMax,
    `备注最多 ${BALANCE_LIMITS.transferRemarkMax} 个字`,
  )
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose.
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "备注不能有换行或控制字符",
  )
  .transform((value) => (value === "" ? undefined : value))
  .optional();

/** A 转账 from the page: to someone found here, by a random request. */
export const createTransferSchema = z.strictObject({
  requestId: z.uuid(),
  toUserId: linuxDoUserIdSchema,
  toUsername: inviteUsernameSchema,
  destination: transferDestinationSchema,
  amount: moneySchema,
  remark: transferRemarkSchema,
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/** The caller's own number for a 转账, unique within its key. */
export const outTransferNoSchema = z
  .string({ error: "请填转账单号" })
  .regex(/^[\x21-\x7e]{1,64}$/, "转账单号是 1–64 个可打印 ASCII 字符");

/** One 转账 through the open API (balance-design §16). */
export const openTransferItemSchema = z.strictObject({
  outTransferNo: outTransferNoSchema,
  toUserId: linuxDoUserIdSchema,
  toUsername: inviteUsernameSchema,
  destination: transferDestinationSchema.default("balance"),
  amount: moneySchema,
  remark: transferRemarkSchema,
});
export type OpenTransferItem = z.infer<typeof openTransferItemSchema>;

export const openTransferSchema = openTransferItemSchema.extend({
  /** 试转: checked as it would be, nothing moved. */
  dryRun: z.boolean().optional(),
});

export const openTransferBatchSchema = z.strictObject({
  transfers: z
    .array(openTransferItemSchema)
    .min(1, "至少一笔")
    .max(
      BALANCE_LIMITS.transferBatchMax,
      `一次最多 ${BALANCE_LIMITS.transferBatchMax} 笔`,
    ),
  dryRun: z.boolean().optional(),
});

/** A new 开放接口密钥: a name, and a daily limit if any. */
export const createApiKeySchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "请填名称")
    .refine(
      (value) => characters(value) <= BALANCE_LIMITS.apiKeyNameMax,
      `名称最多 ${BALANCE_LIMITS.apiKeyNameMax} 个字`,
    ),
  dailyLimit: moneySchema.nullable(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** An admin's stop of someone's key: the reason they will read. */
export const adminRevokeApiKeySchema = z.strictObject({
  reason: z.string().trim().min(1, "请填原因").max(200),
});

/** 已存入🐟额 at once; to a Credit account 发放中, then 已发放 or 未发出. */
export type TransferStatus = "sent" | "sending" | "not_sent";

/** The other side of a 转账, as the page shows them. */
export type BalanceTransferParty = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

/** A 转账 in 明细, from its sender's side (out) or its recipient's (in). */
export type BalanceTransfer = {
  id: string;
  direction: "out" | "in";
  destination: TransferDestination;
  amountMinor: number;
  remark: string | null;
  counterpart: BalanceTransferParty;
  /** The sender's key it was made with (the sender's side only). */
  apiKeyName: string | null;
  outTransferNo: string | null;
  status: TransferStatus;
  /** To a Credit account: its 转出, with what it waits on. */
  withdrawal: BalanceWithdrawal | null;
  createdAt: number;
};

/** 有效 / 已停用 / 管理员停用. */
export type BalanceApiKeyStatus = "active" | "revoked" | "admin_revoked";

export type BalanceApiKey = {
  id: string;
  name: string;
  lastFour: string;
  status: BalanceApiKeyStatus;
  dailyLimitMinor: number | null;
  /** What it has sent today (北京时间). */
  usedTodayMinor: number;
  createdAt: number;
  lastTransferAt: number | null;
  lastTransferIp: string | null;
  transferCount: number;
  transferTotalMinor: number;
  revokedAt: number | null;
  /** An admin's stop: why. */
  revokeReason: string | null;
};

/** What a key sent: today, the last 7 days, and ever. */
export type BalanceApiKeyTotals = Record<
  "today" | "week" | "all",
  { count: number; totalMinor: number }
>;

/**
 * 🐟额 PLUS (balance-design §13): opened by invitation, or the 站长's own.
 * Who invited them and since when, for the bubble on the tag.
 */
export type BalancePlus = {
  plus: boolean;
  owner: boolean;
  invitedBy: BalanceInviteUser | null;
  since: number | null;
};

export const createInviteSchema = z.strictObject({
  username: inviteUsernameSchema,
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

/** A 通用链接's 附言: a few lines, as written; empty is none. */
export const inviteLinkNoteSchema = z
  .string()
  .transform((value) => value.replaceAll("\r\n", "\n").trim())
  .refine(
    (value) => characters(value) <= BALANCE_LIMITS.inviteLinkNoteMax,
    `附言最多 ${BALANCE_LIMITS.inviteLinkNoteMax} 个字`,
  )
  .refine(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose.
    (value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value),
    "附言不能有控制字符",
  )
  .transform((value) => value || null);

/**
 * An admin's 通用链接: how many people may use it (null: any), for how
 * long (null: for good), in whose name (null: the admin's) and its 附言.
 */
export const createInviteLinkSchema = z.strictObject({
  maxUses: z
    .number({ error: "请填最多几个人用" })
    .int("人数是整数")
    .min(1, "至少 1 个人")
    .max(
      BALANCE_LIMITS.inviteLinkMaxUses,
      `最多 ${BALANCE_LIMITS.inviteLinkMaxUses} 个人`,
    )
    .nullable(),
  days: z.union([z.literal(1), z.literal(7), z.null()], {
    error: "有效期是 1 天、7 天或永久",
  }),
  inviterUsername: inviteUsernameSchema.nullable().optional(),
  note: inviteLinkNoteSchema.nullable().optional(),
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
  /** Null: any number of people. */
  maxUses: number | null;
  useCount: number;
  createdAt: number;
  /** Null: for good. */
  expiresAt: number | null;
  stoppedAt: number | null;
  /** In whose name it invites. */
  inviter: BalanceInviteUser | null;
  note: string | null;
  stoppedBy: BalanceInviteUser | null;
};
