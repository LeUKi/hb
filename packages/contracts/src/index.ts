import { z } from "zod";
import {
  amountToMinor,
  type LdcOpeningBlockedReason,
  type Merchant,
  type MerchantPayment,
  type MerchantPaymentDetail,
  moneySchema,
  type PaymentMode,
  type PaymentView,
} from "./payments";
import type { PublicUserProfile } from "./profile";
import type { AttemptCooldown } from "./rate-limits";
import type { RecipientSpeedTitle } from "./recipient-speed";

export * from "./activity-image";
export * from "./admin";
export * from "./balance";
export * from "./draw-proof";
export * from "./ecoji-v2";
export * from "./forum-emoji";
export * from "./payments";
export * from "./profile";
export * from "./random";
export * from "./rate-limits";
export * from "./recipient-speed";
export * from "./share-text";

export const ACTIVITY_LIMITS = {
  titleCharacters: 100,
  passwords: 5,
  /** One 口令: 6–32 汉字, letters or digits (32 since 2026-10-20). */
  passwordMinCharacters: 6,
  passwordMaxCharacters: 32,
  historicalPasswords: 100,
  rewards: 1000,
  infoCharacters: 10000,
  requestBytes: 1024 * 1024,
} as const;

export const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DRAW_COUNTDOWN_SECONDS = 180;
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
      characterCount(value) >= ACTIVITY_LIMITS.passwordMinCharacters &&
      characterCount(value) <= ACTIVITY_LIMITS.passwordMaxCharacters &&
      /^[\p{Script=Han}A-Za-z0-9]+$/u.test(value),
    "口令须为 6–32 个字符，仅限汉字、英文字母和数字",
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
    .min(1, "请填写红包标题")
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
    .max(ACTIVITY_LIMITS.historicalPasswords, "历史红包最多 100 个口令"),
  quantityVisibility: z.enum(["exact", "fuzzy", "availability", "hidden"]),
  // The roster is always public (redesign 06 §2). Older clients still send
  // these switches; they are accepted and ignored.
  showRecipientList: z.boolean().optional(),
  showRecipientUsername: z.boolean().optional(),
  showRecipientTime: z.boolean().optional(),
  showRecipientAmount: z.boolean().optional(),
  beforeInfo: infoSchema,
  afterClaimInfo: infoSchema,
  afterEndInfo: infoSchema,
  // Preserve the parsed shape of legacy creation requests for idempotency.
  participationMode: participationModeSchema.optional(),
  /**
   * 领取前人机验证: claiming or signing up first passes Cloudflare Turnstile
   * in a dialog. Optional (not defaulted) for the same reason as above.
   */
  humanCheck: z.boolean().optional(),
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
/**
 * Where a 红包's LDC comes from (docs/balance-design.md §14): the author's
 * Credit merchant app paying each claim (商户直发), or their 🐟额, locked
 * when it opens and credited to each claimant's 🐟额 on the spot.
 */
export const activityFundingSchema = z.enum(["merchant", "balance"]);
export type ActivityFunding = z.infer<typeof activityFundingSchema>;
/** Absent on everything saved before 🐟额红包: 商户直发. */
export function fundingOf(value: { funding?: ActivityFunding | null }) {
  return value.funding ?? "merchant";
}

const ldcActivitySchema = baseActivitySchema.extend({
  rewardType: z.literal("ldc"),
  // Optional (not defaulted) for the same reason as participationMode.
  funding: activityFundingSchema.optional(),
  /** The paying merchant; empty for a 🐟额红包. */
  merchantId: z.union([z.uuid(), z.literal("")]),
  money: ldcMoneySchema,
});

function validateActivity(
  activity: z.infer<typeof ldcActivitySchema>,
  context: z.RefinementCtx,
) {
  const balance = fundingOf(activity) === "balance";
  if (balance ? activity.merchantId !== "" : activity.merchantId === "")
    context.addIssue({
      code: "custom",
      path: ["merchantId"],
      message: balance ? "🐟额红包不用商户" : "请先配置 LDC 商户",
    });
  // 首页领取 off: it is found in 红包广场 (docs/redesign/07 §6).
  if (activity.forceDedicated && !activity.joinSquare)
    context.addIssue({
      code: "custom",
      path: ["joinSquare"],
      message: "关闭了首页领取的红包要加入红包广场",
    });
  if (activity.participationMode === "direct") {
    if (activity.passwords.length > 0)
      context.addIssue({
        code: "custom",
        path: ["passwords"],
        message: "无需口令的红包不能设置口令",
      });
    if (activity.forceDedicated)
      context.addIssue({
        code: "custom",
        path: ["forceDedicated"],
        message: "无需口令的红包不能关闭首页领取",
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
/**
 * A saved 红包's settings as they read back: the shape only. The rules
 * check what is written; one added later must not lock out a 红包 saved
 * before it (07 §5, 加入红包广场).
 */
export const storedActivitySchema = ldcActivitySchema;
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
  /** finished: ended or archived (已结束 includes 已归档). */
  status?: ActivityStatus | "all" | "finished";
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
  /** What everyone took from this account's 红包: claims and prizes. */
  sentAmount: string;
  /** What this account took: its claims and prizes. */
  receivedAmount: string;
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

/**
 * 开奖证明 (docs/draw-proof-design.md): on a v2 红包's public read, what
 * the roster dialog says. A 限时开奖 is drawn from one drand round after
 * closing; a 拼手气 (or 自定义 in random order) hands out a queue sealed at
 * opening. The full data is at GET /api/activities/:id/proof.
 */
export type DrawProof =
  | {
      kind: "draw";
      /** The round after closing; before then, the round after the deadline. */
      round: number;
      roundAt: string;
      /** From closing on: the frozen roster's 名单哈希. */
      rosterHash?: string;
    }
  | { kind: "queue"; commitment: string };

/** One sign-up of a 限时开奖's frozen roster, as anyone can see it. */
export type ProofRosterEntry = {
  ordinal: number;
  registrationId: string;
  registeredAt: string;
  user: PublicUserProfile;
};

/**
 * GET /api/activities/:id/proof: everything a v2 红包's random parts came
 * from, for the 🎲 page, the check in the browser and the verification
 * script (docs/draw-proof-design.md). Whatever is public at its stage is
 * here; the rest is null until it comes. Amounts are in 0.01 LDC.
 */
export type ActivityProofData =
  | {
      kind: "draw";
      version: 2;
      /**
       * registering: the roster is open; waiting: frozen, the round not
       * fetched yet; drawing: drawn, payments being made; drawn: published.
       */
      stage: "registering" | "waiting" | "drawing" | "drawn";
      activity: {
        id: string;
        title: string;
        author: PublicUserProfile;
        deadlineAt: string;
        /** Null while the roster is open. */
        closedAt: string | null;
        money: TimedDrawMoney;
      };
      drand: {
        chainHash: string;
        /** While the roster is open, the round after the deadline. */
        round: number;
        roundAt: string;
        /** Null until the round is fetched. */
        randomness: string | null;
        signature: string | null;
      };
      /** The sign-ups so far; the hash once closed. */
      roster: { hash: string | null; entries: ProofRosterEntry[] };
      seed: string | null;
      /**
       * Once drawn: the ordinals in the order they were picked, the prize
       * pool by position, and the prize each winner got.
       */
      result: {
        picked: number[];
        amounts: number[];
        winners: { ordinal: number; position: number; amountMinor: number }[];
      } | null;
    }
  | {
      kind: "queue";
      version: 2;
      stage: "running" | "ended";
      activity: {
        id: string;
        title: string;
        author: PublicUserProfile;
        openedAt: string;
        endedAt: string | null;
        money: Extract<LdcMoney, { mode: "random" | "custom" }>;
      };
      commitment: string;
      /** Null until the 红包 is over. */
      secret: string | null;
      /** The shares claimed so far, in order; once over, all of them. */
      queue: {
        position: number;
        amountMinor: number;
        claim: { user: PublicUserProfile; claimedAt: string } | null;
      }[];
    }
  /** Opened before v2, or nothing random about it. */
  | { kind: "none" };

export type ActivitySummary = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  rewardType: "ldc";
  /** Absent: 商户直发. */
  funding?: ActivityFunding;
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

/** One face on the 名单入口. */
export type RosterPreviewPerson = PublicUserProfile & { id: string };

export type PublicActivity = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  rewardType: "ldc";
  /** Absent: 商户直发. */
  funding?: ActivityFunding;
  status: ActivityStatus;
  author: ActivityAuthor;
  forceDedicated: boolean;
  topicUrl: string | null;
  openedAt: string | null;
  deadlineAt: string | null;
  quantity: PublicQuantity;
  reward?: ActivityRewardSummary;
  beforeInfo: string;
  afterEndInfo?: string;
  paymentMode?: PaymentMode;
  openingBlockedReason?: LdcOpeningBlockedReason;
  draw?: DrawSummary;
  drawProof?: DrawProof;
  /** Claiming or signing up first passes a human check (Turnstile). */
  humanCheck?: true;
  /**
   * Up to five people for the 名单入口, read with the rest so they match the
   * numbers: the latest claims; while a draw is open, the latest sign-ups;
   * once it is drawn, the biggest prizes. Only on a single 红包's read.
   */
  rosterPreview?: RosterPreviewPerson[];
};

/**
 * What a 红包's live channel pushes (`GET /api/activities/:id/live`,
 * signed-in viewers only). `activity`: its public read, the same for
 * everyone, as it is now; sent on connecting and after each change, a
 * burst as one. `mine`: something only this person sees there changed (a
 * payment of theirs; for the sender, one in their 名单, or their own edit
 * elsewhere), so the page reads its own part again. `viewers`: how many
 * people have its page open on the channel, each counted once however many
 * tabs; sent on connecting and whenever it changes.
 */
export type ActivityLiveMessage =
  | { type: "activity"; activity: PublicActivity }
  | { type: "mine" }
  | { type: "viewers"; count: number };

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
/** One payment of the account's 红包, across all of them (/payments). */
export type AccountPayment = ActivityPaymentTarget & { merchantId: string };
/** A 红包 heading its payments: what it is, and what it has paid out. */
export type AccountPaymentGroup = ActivitySummary & { confirmedAmount: string };
export type AccountPaymentSummary = {
  confirmedAmount: string;
  confirmedCount: number;
  /** Not confirmed yet (attention included). */
  openAmount: string;
  openCount: number;
  /** Sending paused (异常待处理). */
  attentionCount: number;
  /** Waiting for its sender to update the original order's key. */
  repairableCount: number;
  firstRepairableId: string | null;
};
export type AccountPaymentFilter = "all" | "open" | "confirmed";
/**
 * Payments grouped by 红包: the 红包 with the latest payment first, each
 * one's payments newest first, 20 at a time (a group may go on in the next
 * page). The summary covers every payment in scope, whatever the filter.
 */
export type AccountPaymentList = {
  items: AccountPayment[];
  activities: Record<string, AccountPaymentGroup>;
  summary: AccountPaymentSummary;
  total: number;
  nextCursor: string | null;
};
export type AccountPaymentDetail = {
  payment: MerchantPaymentDetail;
  merchant: Merchant;
  activity: { id: string; title: string; draw: boolean };
};
export type ActivityIssue = { path: string; message: string };
/** What the Turnstile widget needs for a 红包 that asks for a human check. */
export type HumanCheckChallenge = {
  siteKey: string;
  /** Turnstile `action`: what the token is for. */
  action: "claim" | "register";
  /** Turnstile `cData`: the 红包 it is for. */
  cData: string;
};
export type ActivityError = {
  error: { code: string; message: string; issues?: ActivityIssue[] };
  attemptCooldown?: AttemptCooldown;
  /** HUMAN_CHECK_REQUIRED: pass it, then send the same submission again. */
  humanCheck?: HumanCheckChallenge;
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
/** A Turnstile token, sent once the 红包 asked for it (HUMAN_CHECK_REQUIRED). */
const humanTokenSchema = z.string().min(1).max(2048).optional();
export const claimActivitySchema = z.union([
  z.strictObject({
    ...passwordSolveSchema.shape,
    humanToken: humanTokenSchema,
  }),
  z.strictObject({
    submissionId: z.uuid(),
    participationMode: z.literal("direct"),
    humanToken: humanTokenSchema,
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
  /** None for a 🐟额红包: the amount is in the claimant's 🐟额 already. */
  payment?: PaymentView;
};
export type ParticipationActivity = {
  participationMode?: ParticipationMode;
  id: string;
  title: string;
  /** Absent: 商户直发. */
  funding?: ActivityFunding;
  status: ActivityStatus;
  deadlineAt?: string | null;
  createdAt?: string;
  author?: ActivityAuthor;
  reward?: ActivityRewardSummary;
  draw?: DrawSummary;
};
export type ClaimDetail = Omit<ClaimSummary, "rewardType"> & {
  afterClaimInfo: string;
} & { rewardType: "ldc"; amount: string; payment?: PaymentView };
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
  speedTitle?: RecipientSpeedTitle;
  /** 手气王 / 手气亡, over the whole roster, as the public list has them. */
  title?: "highest" | "lowest";
} & { rewardType: "ldc"; amount: string; payment?: PaymentView };
export type AuthorClaimList = {
  items: AuthorClaim[];
  nextCursor: string | null;
};
export type PublicRecipient = PublicUserProfile & {
  id: string;
  claimedAt: string;
  amount?: string;
  title?: "highest" | "lowest";
  speedTitle?: RecipientSpeedTitle;
};
/** Always public (redesign 06 §2), oldest first (06 §3). */
export type PublicRecipientList = {
  items: PublicRecipient[];
  nextCursor: string | null;
  titles?: { highestClaimIds: string[]; lowestClaimIds: string[] };
};
export type PublicRegistration = PublicUserProfile & {
  id: string;
  registeredAt: string;
};
/** Always public (redesign 06 §2), oldest first (06 §3). */
export type PublicRegistrationList = {
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
  /** People whose attempt with this text matched (a draw's sign-ups). */
  matchedUsers: number;
  unmatchedAttempts: number;
  successfulClaims: number;
};
export type ActivityStatistics = {
  totalAttempts: number;
  uniqueUsers: number;
  /** Attempts that matched a 口令 when they were made. */
  matchedAttempts: number;
  successfulClaims: number;
  registeredParticipants?: number;
  items: AttemptStatisticsRow[];
  validPasswords: {
    password: string;
    successfulClaims: number;
    /** Sign-ups with this 口令 (timed draws). */
    registrations: number;
  }[];
  nextCursor: string | null;
};
