import { z } from "zod";
import {
  amountToMinor,
  type LdcOpeningBlockedReason,
  type MerchantPayment,
  moneySchema,
  type PaymentMode,
  type PaymentView,
} from "./payments";
import type { PublicUserProfile } from "./profile";
import type { AttemptCooldown } from "./rate-limits";

export * from "./admin";
export * from "./ecoji-v2";
export * from "./login-settings";
export * from "./payments";
export * from "./profile";
export * from "./rate-limits";

export const ACTIVITY_LIMITS = {
  titleCharacters: 100,
  passwords: 5,
  historicalPasswords: 100,
  rewards: 1000,
  infoCharacters: 10000,
  requestBytes: 1024 * 1024,
} as const;

export const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DRAW_COUNTDOWN_SECONDS = 600;
// Keep countdown arithmetic within the JavaScript Date range. Opening checks
// the sum against the actual database opening time as well.
export const MAX_DRAW_COUNTDOWN_SECONDS = 8_000_000_000_000;
export const ARCHIVE_DELAY_MS = 72 * 60 * 60 * 1000;

export function characterCount(value: string) {
  return Array.from(value).length;
}

export function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeTopicLink(value: string): {
  topicId: string;
  postNumber: number;
  topicUrl: string;
} | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname !== "linux.do" ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
    if (parts[0] !== "t") return null;
    const numeric = /^\d+$/.test(parts[1] ?? "");
    const idPosition = numeric ? 1 : 2;
    if (!numeric && (!parts[1] || parts[1] === "." || parts[1] === ".."))
      return null;
    if (parts.length !== idPosition + 1 && parts.length !== idPosition + 2)
      return null;
    const rawId = parts[idPosition];
    if (!rawId || !/^[0-9]{1,19}$/.test(rawId) || BigInt(rawId) <= 0n)
      return null;
    const rawPost = parts[idPosition + 1] ?? "1";
    if (!/^[0-9]{1,16}$/.test(rawPost)) return null;
    const postNumber = Number(rawPost);
    if (!Number.isSafeInteger(postNumber) || postNumber <= 0) return null;
    const topicId = BigInt(rawId).toString();
    return {
      topicId,
      postNumber,
      topicUrl: `https://linux.do/t/${topicId}/${postNumber}`,
    };
  } catch {
    return null;
  }
}

export const passwordSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      characterCount(value) >= 6 &&
      characterCount(value) <= 18 &&
      /^[\p{Script=Han}A-Za-z0-9]+$/u.test(value),
    "口令须为 6–18 个字符，仅限汉字、英文字母和数字",
  );

export const deadlineSchema = z.union([
  z.strictObject({ mode: z.literal("duration") }),
  z.strictObject({
    mode: z.literal("duration"),
    value: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    unit: z.enum(["minutes", "hours", "days"]),
  }),
  z.strictObject({
    mode: z.literal("at"),
    at: z.iso.datetime({ offset: true }),
  }),
]);

const infoSchema = z
  .string()
  .refine(
    (value) => characterCount(value) <= ACTIVITY_LIMITS.infoCharacters,
    "说明不能超过 10,000 个字符",
  );

const topicUrlSchema = z.string().trim().max(2048, "帖子链接过长");

// Historical creation digests include the original link, even when the old
// parser ignored a /last suffix or extra path segments. New writes stay strict.
function acceptsHistoricalTopicLink(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.hostname !== "linux.do" ||
      url.port ||
      url.username ||
      url.password
    )
      return false;
    const parts = url.pathname.split("/").filter(Boolean);
    const rawId = /^\d+$/.test(parts[1] ?? "") ? parts[1] : parts[2];
    return (
      parts[0] === "t" &&
      rawId !== undefined &&
      /^[0-9]{1,19}$/.test(rawId) &&
      BigInt(rawId) > 0n
    );
  } catch {
    return false;
  }
}

export const participationModeSchema = z.enum(["password", "direct"]);
export type ParticipationMode = z.infer<typeof participationModeSchema>;

const baseActivitySchema = z.strictObject({
  title: z
    .string()
    .trim()
    .min(1, "请填写活动标题")
    .refine(
      (value) => characterCount(value) <= ACTIVITY_LIMITS.titleCharacters,
      "标题不能超过 100 个字符",
    ),
  topicUrl: topicUrlSchema.refine(
    (value) => !value || normalizeTopicLink(value) !== null,
    "请填写有效的 Linux DO 帖子链接",
  ),
  forceDedicated: z.boolean(),
  joinSquare: z.boolean().default(false),
  deadline: deadlineSchema,
  allocation: z.enum(["sequential", "random"]),
  passwords: z
    .array(passwordSchema)
    .max(ACTIVITY_LIMITS.historicalPasswords, "历史活动最多 100 个口令"),
  quantityVisibility: z.enum(["exact", "fuzzy", "availability", "hidden"]),
  showRecipientList: z.boolean(),
  showRecipientUsername: z.boolean(),
  showRecipientTime: z.boolean(),
  showRecipientAmount: z.boolean().default(false),
  beforeInfo: infoSchema,
  afterClaimInfo: infoSchema,
  afterEndInfo: infoSchema,
  // Preserve the parsed shape of legacy creation requests for idempotency.
  participationMode: participationModeSchema.optional(),
});

export const ldcMoneySchema = z.discriminatedUnion("mode", [
  z
    .strictObject({
      mode: z.literal("fixed"),
      totalAmount: moneySchema,
      count: z.number().int().min(1).max(ACTIVITY_LIMITS.rewards),
    })
    .superRefine((value, ctx) => {
      if (!moneySchema.safeParse(value.totalAmount).success) return;
      if (
        amountToMinor(value.totalAmount) % value.count !== 0 ||
        amountToMinor(value.totalAmount) < value.count
      )
        ctx.addIssue({
          code: "custom",
          path: ["totalAmount"],
          message: "总金额必须能精确均分，每份至少 0.01 LDC",
        });
    }),
  z
    .strictObject({
      mode: z.literal("custom"),
      amounts: z.array(moneySchema).min(1).max(ACTIVITY_LIMITS.rewards),
    })
    .superRefine((value, ctx) => {
      if (
        value.amounts.some((amount) => !moneySchema.safeParse(amount).success)
      )
        return;
      const sum = value.amounts.reduce(
        (total, amount) => total + BigInt(amountToMinor(amount)),
        0n,
      );
      if (sum > BigInt(Number.MAX_SAFE_INTEGER))
        ctx.addIssue({
          code: "custom",
          path: ["amounts"],
          message: "总金额超出安全整数范围",
        });
    }),
  z
    .strictObject({
      mode: z.literal("random"),
      algorithm: z.enum(["double_mean_v1", "bounded_mean_v1"]),
      totalAmount: moneySchema,
      count: z.number().int().min(1).max(ACTIVITY_LIMITS.rewards),
    })
    .superRefine((value, ctx) => {
      if (!moneySchema.safeParse(value.totalAmount).success) return;
      if (amountToMinor(value.totalAmount) < value.count)
        ctx.addIssue({
          code: "custom",
          path: ["totalAmount"],
          message: "总金额不足，每份至少需要 0.01 LDC",
        });
    }),
  z
    .strictObject({
      mode: z.literal("timed_draw"),
      algorithm: z.enum(["double_mean_v1", "bounded_mean_v1"]),
      totalAmount: moneySchema,
      count: z.number().int().min(1).max(ACTIVITY_LIMITS.rewards),
      participantLimit: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .nullable(),
      countdownSeconds: z
        .number()
        .int()
        .positive()
        .max(MAX_DRAW_COUNTDOWN_SECONDS)
        .optional(),
      distributeFullPool: z.boolean(),
    })
    .superRefine((value, ctx) => {
      if (!moneySchema.safeParse(value.totalAmount).success) return;
      if (amountToMinor(value.totalAmount) < value.count)
        ctx.addIssue({
          code: "custom",
          path: ["totalAmount"],
          message: "总奖池不足，每个获奖名额至少需要 0.01 LDC",
        });
    }),
]);
export type LdcMoney = z.infer<typeof ldcMoneySchema>;
export type RandomLdcMoney = Extract<LdcMoney, { mode: "random" }>;
export type TimedDrawMoney = Extract<LdcMoney, { mode: "timed_draw" }>;
const ldcActivitySchema = baseActivitySchema.extend({
  rewardType: z.literal("ldc"),
  merchantId: z.uuid(),
  money: ldcMoneySchema,
});

function validateActivity(
  activity: z.infer<typeof ldcActivitySchema>,
  context: z.RefinementCtx,
) {
  if (activity.participationMode === "direct") {
    if (activity.passwords.length > 0)
      context.addIssue({
        code: "custom",
        path: ["passwords"],
        message: "直接参与活动不能设置口令",
      });
    if (activity.forceDedicated)
      context.addIssue({
        code: "custom",
        path: ["forceDedicated"],
        message: "直接参与活动不能开启口令尝试统计",
      });
  } else if (activity.passwords.length === 0)
    context.addIssue({
      code: "custom",
      path: ["passwords"],
      message: "至少填写一个口令",
    });
  if (
    (activity.money.mode === "random" ||
      activity.money.mode === "timed_draw") &&
    activity.allocation !== "random"
  )
    context.addIssue({
      code: "custom",
      path: ["allocation"],
      message: "随机金额模式须采用不放回随机领取",
    });
  if (activity.money.mode === "timed_draw") {
    if (
      activity.deadline.mode === "duration" &&
      activity.money.countdownSeconds === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["money", "countdownSeconds"],
        message: "请填写最晚开奖倒计时（秒）",
      });
    if (
      activity.deadline.mode === "at" &&
      activity.money.countdownSeconds !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["money", "countdownSeconds"],
        message: "指定开奖时间不能同时设置倒计时",
      });
  }
  const passwords = new Set<string>();
  activity.passwords.forEach((password, index) => {
    if (passwords.has(password))
      context.addIssue({
        code: "custom",
        path: ["passwords", index],
        message: "口令重复，请移除重复项",
      });
    passwords.add(password);
  });
}

export const activityInputSchema =
  ldcActivitySchema.superRefine(validateActivity);
/** Only the creation envelope accepts old links before the idempotency lookup. */
export const historicalActivityInputSchema = ldcActivitySchema
  .extend({
    topicUrl: topicUrlSchema.refine(
      acceptsHistoricalTopicLink,
      "请填写有效的 Linux DO 帖子链接",
    ),
  })
  .superRefine(validateActivity);
/** Apply only after resolving a new create request's idempotency key. */
export const newActivityInputSchema = activityInputSchema.superRefine(
  (value, context) => {
    if (value.passwords.length > ACTIVITY_LIMITS.passwords)
      context.addIssue({
        code: "custom",
        path: ["passwords"],
        message: "最多 5 条有效口令",
      });
    if (
      value.quantityVisibility !== "exact" &&
      value.quantityVisibility !== "fuzzy"
    )
      context.addIssue({
        code: "custom",
        path: ["quantityVisibility"],
        message: "数量展示仅支持精确或模糊",
      });
  },
);
export type ActivityInput = z.infer<typeof activityInputSchema>;
export type LdcActivityInput = ActivityInput;
export function ldcAmounts(input: LdcActivityInput): number[] {
  if (input.money.mode === "random" || input.money.mode === "timed_draw")
    throw new Error("Random amounts must come from saved server inventory");
  return input.money.mode === "fixed"
    ? Array<number>(input.money.count).fill(
        amountToMinor(input.money.totalAmount) / input.money.count,
      )
    : input.money.amounts.map(amountToMinor);
}

export function ldcRewardCount(input: LdcActivityInput): number {
  return input.money.mode === "custom"
    ? input.money.amounts.length
    : input.money.count;
}

export function ldcTotalMinor(input: LdcActivityInput): number {
  if (input.money.mode !== "custom")
    return amountToMinor(input.money.totalAmount);
  const total = input.money.amounts.reduce(
    (sum, value) => sum + BigInt(amountToMinor(value)),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Total amount exceeds safe integer range");
  return Number(total);
}

/** Compares reward configuration rather than decimal spelling or object order. */
export function sameLdcMoney(left: LdcMoney, right: LdcMoney): boolean {
  if (left.mode === "custom" && right.mode === "custom")
    return (
      left.amounts.length === right.amounts.length &&
      left.amounts.every(
        (amount, index) =>
          amountToMinor(amount) === amountToMinor(right.amounts[index] ?? "0"),
      )
    );
  if (left.mode === "custom" || right.mode === "custom") return false;
  return (
    left.mode === right.mode &&
    left.count === right.count &&
    amountToMinor(left.totalAmount) === amountToMinor(right.totalAmount) &&
    (left.mode !== "random" ||
      (right.mode === "random" && left.algorithm === right.algorithm)) &&
    (left.mode !== "timed_draw" ||
      (right.mode === "timed_draw" &&
        left.algorithm === right.algorithm &&
        left.participantLimit === right.participantLimit &&
        left.countdownSeconds === right.countdownSeconds &&
        left.distributeFullPool === right.distributeFullPool))
  );
}

/** Integer bounds, tightened only where total conservation makes a bound unreachable. */
export function boundedMeanLimits(totalMinor: number, count: number) {
  if (
    !Number.isSafeInteger(totalMinor) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > ACTIVITY_LIMITS.rewards ||
    totalMinor < count
  )
    throw new Error("Invalid random reward total or count");
  const total = BigInt(totalMinor);
  const n = BigInt(count);
  const lower = total / (2n * n) > 1n ? total / (2n * n) : 1n;
  const upper = (3n * total + 2n * n - 1n) / (2n * n);
  const feasibleMin = total - (n - 1n) * upper;
  const feasibleMax = total - (n - 1n) * lower;
  return {
    min: Number(lower > feasibleMin ? lower : feasibleMin),
    max: Number(upper < feasibleMax ? upper : feasibleMax),
  };
}

export function emptyActivityInput(): LdcActivityInput {
  return {
    title: "",
    topicUrl: "",
    forceDedicated: false,
    joinSquare: false,
    deadline: { mode: "duration" },
    allocation: "sequential",
    passwords: [],
    quantityVisibility: "exact",
    showRecipientList: true,
    showRecipientUsername: true,
    showRecipientTime: true,
    showRecipientAmount: true,
    beforeInfo: "",
    afterClaimInfo: "",
    afterEndInfo: "",
    rewardType: "ldc",
    merchantId: "",
    money: { mode: "fixed", totalAmount: "1.00", count: 1 },
  };
}

export const createActivitySchema = z.strictObject({
  requestId: z.uuid(),
  activity: historicalActivityInputSchema,
});
export const updateActivitySchema = z.strictObject({
  version: z.number().int().positive(),
  activity: activityInputSchema,
});
export const openActivitySchema = z.strictObject({
  version: z.number().int().positive(),
  merchantId: z.uuid().optional(),
  credentialVersion: z.number().int().positive().optional(),
});
export const deleteActivitySchema = z.strictObject({
  version: z.number().int().positive(),
});
export type DeleteActivityInput = z.infer<typeof deleteActivitySchema>;

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type OpenActivityInput = z.infer<typeof openActivitySchema>;
export type ActivityStatus = "draft" | "active" | "ended" | "archived";
export const activityRewardFilterSchema = z.enum([
  "all",
  "ldc",
  "fixed",
  "custom",
  "random",
  "timed_draw",
]);
export type ActivityRewardFilter = z.infer<typeof activityRewardFilterSchema>;
export type ActivityStatusCounts = Record<ActivityStatus | "all", number>;
export type ActivityHistoryFilters = {
  type?: ActivityRewardFilter;
  status?: ActivityStatus | "all";
};
/** A public projection summarizes LDC amounts without exposing custom amount arrays. */
export type ActivityRewardSummary = {
  mode: LdcMoney["mode"];
  totalAmount?: string;
  unitAmount?: string;
  count?: number;
  algorithm?: RandomLdcMoney["algorithm"];
  participantLimit?: number | null;
  distributeFullPool?: boolean;
};
export type AccountHistorySummary = {
  initiatedCount: number;
  participatedCount: number;
};

export type ActivityAuthor = PublicUserProfile & {
  id: string;
};

/** Counts are null (and the limit omitted) in public fuzzy projections. */
export type DrawSummary = {
  state: "waiting" | "settling" | "completed" | "empty";
  deadlineAt: string | null;
  closedAt: string | null;
  reason: "full" | "deadline" | "manual" | null;
  registeredCount: number | null;
  winnerCount: number | null;
  participantLimit?: number | null;
};

export type ActivitySummary = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  rewardType: "ldc";
  forceDedicated: boolean;
  status: ActivityStatus;
  version: number;
  createdAt: string;
  openedAt: string | null;
  deadlineAt: string | null;
  topicUrl: string | null;
  totalCount: number;
  claimedCount: number;
  reward?: ActivityRewardSummary;
  paymentMode?: PaymentMode;
  draw?: DrawSummary;
};

export type ManagedActivity = ActivitySummary & {
  author: ActivityAuthor;
  config: ActivityInput;
  openingBlockedReason?: LdcOpeningBlockedReason;
};

export type PublicQuantity =
  | { mode: "hidden" }
  | { mode: "exact"; total: number; claimed: number; remaining: number }
  | { mode: "availability"; available: boolean }
  | { mode: "fuzzy"; level: "plenty" | "limited" | "low" | "empty" };

export type PublicActivity = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  rewardType: "ldc";
  status: ActivityStatus;
  author: ActivityAuthor;
  forceDedicated: boolean;
  topicUrl: string | null;
  openedAt: string | null;
  deadlineAt: string | null;
  quantity: PublicQuantity;
  reward?: ActivityRewardSummary;
  showRecipientList: boolean;
  showRecipientUsername: boolean;
  showRecipientTime: boolean;
  beforeInfo: string;
  afterEndInfo?: string;
  paymentMode?: PaymentMode;
  openingBlockedReason?: LdcOpeningBlockedReason;
  showRecipientAmount?: boolean;
  draw?: DrawSummary;
};

export type ActivityList = {
  items: ActivitySummary[];
  nextCursor: string | null;
  total?: number;
  statusCounts?: ActivityStatusCounts;
};
export type ActivityPaymentSummary = {
  pendingAmount: string;
  confirmedAmount: string;
  totalAmount: string;
  pendingCount: number;
  confirmedCount: number;
  totalCount: number;
};
export type ActivityPaymentActivity = ActivitySummary & {
  merchantId: string;
};
export type ActivityPaymentList = {
  items: ActivityPaymentActivity[];
  total: number;
  nextCursor: string | null;
};
export type ActivityPaymentTarget = Extract<
  MerchantPayment,
  { source: "claim" }
> & {
  recipientProfile: PublicUserProfile;
};
export type ActivityPaymentTargetList = {
  activityId: string;
  merchantId: string;
  items: ActivityPaymentTarget[];
  total: number;
  summary: ActivityPaymentSummary;
  nextCursor: string | null;
};
export type ActivityIssue = { path: string; message: string };
export type ActivityError = {
  error: { code: string; message: string; issues?: ActivityIssue[] };
  attemptCooldown?: AttemptCooldown;
};

export const DEFAULT_CLAIM_LIMIT = 10;
export const CLAIM_WINDOW_MS = 60_000;

export const passwordSolveSchema = z.strictObject({
  submissionId: z.uuid(),
  password: passwordSchema,
  discoveryId: z.uuid().optional(),
  participationMode: z.literal("password").optional(),
});
export type PasswordClaimInput = z.infer<typeof passwordSolveSchema>;
export const claimActivitySchema = z.union([
  passwordSolveSchema,
  z.strictObject({
    submissionId: z.uuid(),
    participationMode: z.literal("direct"),
  }),
]);
export const endActivitySchema = z.strictObject({
  version: z.number().int().positive(),
});
export type ClaimActivityInput = z.infer<typeof claimActivitySchema>;
export type EndActivityInput = z.infer<typeof endActivitySchema>;

export type ActivityPasswords = {
  passwords: {
    text: string;
    isClaimPassword: boolean;
    isSolved: boolean;
    isRegistrationPassword?: boolean;
  }[];
  hiddenCount: number;
  canSolve: boolean;
};
export type SolveResult = {
  outcome: "solved" | "incorrect" | "ended" | "archived";
  passwordMatched?: boolean | null;
  attemptCooldown?: AttemptCooldown;
};

export type ClaimSummary = {
  id: string;
  activity: ParticipationActivity;
  rewardType: "ldc";
  claimedAt: string;
  sourcePassword?: string;
  amount?: string;
  payment?: PaymentView;
};
export type ParticipationActivity = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  status: ActivityStatus;
  deadlineAt?: string | null;
  createdAt?: string;
  author?: ActivityAuthor;
  reward?: ActivityRewardSummary;
  draw?: DrawSummary;
};
export type ClaimDetail = Omit<ClaimSummary, "rewardType"> & {
  afterClaimInfo: string;
} & { rewardType: "ldc"; amount: string; payment: PaymentView };
export type ClaimResult = (
  | { result: "claimed" | "already_claimed"; claim: ClaimDetail }
  | {
      result: "registered" | "already_registered";
      registration: RegistrationDetail;
    }
  | { result: "incorrect" | "draft" | "ended" | "archived" }
) & { attemptCooldown?: AttemptCooldown; passwordMatched?: boolean | null };
export type ClaimList = { items: ClaimSummary[]; nextCursor: string | null };
export type RegistrationStatus = "registered" | "drawing" | "won" | "not_won";
export type RegistrationDetail = {
  id: string;
  activity: ParticipationActivity;
  registeredAt: string;
  status: RegistrationStatus;
  drawAt: string | null;
  claim: ClaimDetail | null;
  sourcePassword?: string;
};
export type ActivityParticipationResponse = {
  claim: ClaimDetail | null;
  registration: RegistrationDetail | null;
};
export type Participation =
  | { kind: "claim"; claim: ClaimSummary }
  | { kind: "registration"; registration: RegistrationDetail };
export type ParticipationList = {
  items: Participation[];
  nextCursor: string | null;
  total?: number;
  statusCounts?: ActivityStatusCounts;
};
export type AuthorRegistration = RegistrationDetail & {
  participant: ActivityAuthor;
};
export type AuthorRegistrationList = {
  items: AuthorRegistration[];
  nextCursor: string | null;
};
export type AuthorClaim = Omit<ClaimDetail, "afterClaimInfo"> & {
  claimant: ActivityAuthor;
} & { rewardType: "ldc"; amount: string; payment: PaymentView };
export type AuthorClaimList = {
  items: AuthorClaim[];
  nextCursor: string | null;
};
export type PublicRecipient = PublicUserProfile & {
  id: string;
  claimedAt?: string;
  amount?: string;
  title?: "highest" | "lowest";
};
export type PublicRecipientList = {
  enabled: boolean;
  items: PublicRecipient[];
  nextCursor: string | null;
  titles?: { highestClaimIds: string[]; lowestClaimIds: string[] };
};
export type PublicRegistration = PublicUserProfile & {
  id: string;
  registeredAt?: string;
};
export type PublicRegistrationList = {
  enabled: boolean;
  items: PublicRegistration[];
  nextCursor: string | null;
};

export type DiscoveryCard = Omit<
  PublicActivity,
  "beforeInfo" | "afterEndInfo"
> & {
  myClaim: { id: string; paymentState?: string } | null;
  myRegistration?: { id: string; status: RegistrationStatus } | null;
};
export type DiscoveryList = {
  items: DiscoveryCard[];
  nextCursor: string | null;
  total?: number;
};
export const globalRedemptionSchema = z.strictObject({
  submissionId: z.uuid(),
  password: passwordSchema,
});
export type GlobalRedemptionInput = z.infer<typeof globalRedemptionSchema>;
export type GlobalRedemptionResult = DiscoveryList & {
  id: string;
  claimSubmissionId: string;
  attemptCooldown?: AttemptCooldown;
  result: "none" | "single" | "multiple";
  selectedActivityId?: string;
  claimResult?: ClaimResult;
};
export const globalRedemptionDiscoverySchema = globalRedemptionSchema;
export type GlobalRedemptionDiscoveryResult = Omit<
  GlobalRedemptionResult,
  "claimResult"
>;
export type AttemptStatisticsRow = {
  password: string;
  attempts: number;
  uniqueUsers: number;
  matchedAttempts: number;
  unmatchedAttempts: number;
  successfulClaims: number;
};
export type ActivityStatistics = {
  totalAttempts: number;
  uniqueUsers: number;
  successfulClaims: number;
  registeredParticipants?: number;
  items: AttemptStatisticsRow[];
  validPasswords: { password: string; successfulClaims: number }[];
  nextCursor: string | null;
};
