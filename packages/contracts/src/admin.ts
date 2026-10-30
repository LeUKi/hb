import { z } from "zod";
import type { ActivityAuthor, ActivitySummary } from "./index";
import {
  type MerchantPaymentDetail,
  paymentModeSchema,
  paymentStateSchema,
} from "./payments";

export const adminPageSize = 20;

export const adminActivityStatusSchema = z.enum([
  "all",
  "draft",
  "active",
  "ended",
  "archived",
]);
export type AdminActivityStatus = z.infer<typeof adminActivityStatusSchema>;
export const adminLifecycleSchema = adminActivityStatusSchema.exclude(["all"]);
export type AdminLifecycle = z.infer<typeof adminLifecycleSchema>;

export const adminRewardTypeSchema = z.enum(["all", "ldc"]);
export type AdminRewardType = z.infer<typeof adminRewardTypeSchema>;
export const adminActivityRewardTypeSchema = adminRewardTypeSchema.exclude([
  "all",
]);
export const adminPaymentModeSchema = z.enum(["all", "simulation", "real"]);
export type AdminPaymentMode = z.infer<typeof adminPaymentModeSchema>;
export const adminPaymentStatusSchema = z.enum([
  "all",
  "pending",
  "sending",
  "reconciling",
  "waiting",
  "confirmed",
  "attention",
  "failed",
]);
export type AdminPaymentStatus = z.infer<typeof adminPaymentStatusSchema>;
export const adminUserStateSchema = z.enum([
  "all",
  "active",
  "disabled",
  "silenced",
]);
export type AdminUserState = z.infer<typeof adminUserStateSchema>;
/** 用户's order: newest sign-up first (the default), or by what is read. */
export const adminUserSortSchema = z.enum([
  "created",
  "login",
  "idle",
  "fish",
  "level",
]);
export type AdminUserSort = z.infer<typeof adminUserSortSchema>;
/** 有🐟额: something available (or owed) or held; 没有🐟额: the rest. */
export const adminUserFishSchema = z.enum(["all", "has", "plus", "none"]);
export type AdminUserFish = z.infer<typeof adminUserFishSchema>;
/** Last seen within 7 or 30 days, or not for more than 30. */
export const adminUserLoginSchema = z.enum(["all", "week", "month", "away"]);
export type AdminUserLogin = z.infer<typeof adminUserLoginSchema>;
/** A 等级 to filter by: 0–4, or never read. */
export type AdminUserLevel = 0 | 1 | 2 | 3 | 4 | "unknown";
export const ADMIN_USER_LEVELS: readonly AdminUserLevel[] = [
  0,
  1,
  2,
  3,
  4,
  "unknown",
];
export const adminDrawAnomalySchema = z.enum(["overdue", "unpublished"]);
export const adminPaymentAnomalySchema = z.enum([
  "unknown",
  "attention",
  "overdue",
  "undelivered",
]);
export const adminAuditTypeSchema = z.enum([
  "all",
  "attempt_rate_limits",
  "balance_settings",
  /** 站长 stopped a 代码判定红包 (docs/programmable-hongbao-design.md §1). */
  "code_stop",
  /** 站长 stopped a 红包's 附带网页 (docs/attached-page-design.md). */
  "page_stop",
  /** 判定器设置 (redesign/07 §10). */
  "judge_settings",
  /** 判定器广场's 精选 and 撤下 (docs/judge-square-design.md §15.4). */
  "judge_square",
  /** 施工中's moves by the 站长 (docs/roadmap-design.md §4). */
  "roadmap",
]);
export type AdminAuditType = z.infer<typeof adminAuditTypeSchema>;

export type AdminListResponse<T> = {
  items: T[];
  nextCursor: string | null;
};

export type AdminCursorList<T> = AdminListResponse<T> & {
  readAt: number;
  /** How many match the filters; on the first page only. */
  total?: number;
};

export type AdminRuntimeFlag = {
  allowed: boolean;
  blockers: string[];
};

export type AdminOverview = {
  readAt: number;
  counts: {
    users: number;
    activities: number;
    /** Of the activities, those never opened. */
    drafts: number;
    payments: { total: number; unconfirmed: number };
  };
  runtime: {
    environment: string;
    realPayments: AdminRuntimeFlag;
    realActivityOpening: AdminRuntimeFlag;
    realClaims?: AdminRuntimeFlag;
    timedDraw: AdminRuntimeFlag;
  };
  paymentQueue: { backlog: "未接入"; note: string };
  warnings: {
    stalePayments: number;
    unknownPayments: number;
    attentionPayments: number;
    drawBacklog: number;
    undeliveredPaymentTasks: number;
    undeliveredPaymentTasksOverdue: number;
    staleMaintenance: number;
    /** 🐟额: 转入 with a flag or a refused key; 转出 held, unclear or slow. */
    balanceTopups: number;
    balanceWithdrawals: number;
  };
  paymentsByMode: {
    mode: "simulation" | "real";
    status: string;
    count: number;
    oldestAgeSeconds: number | null;
  }[];
  maintenance: {
    job: string;
    scheduledAt: number;
    startedAt: number;
    finishedAt: number | null;
    status: "running" | "succeeded" | "failed";
    reason: string | null;
    stale: boolean;
  }[];
};

export type AdminOverviewResponse = AdminOverview;

export type AdminUserListItem = {
  id: string;
  externalId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  active: boolean;
  /** On the deployment's admin list (ADMIN_LINUX_DO_IDS). */
  admin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /** LINUX DO 信任等级 as read at a sign-in, and when; null until one did. */
  trustLevel: number | null;
  silenced: boolean;
  profileSeenAt: number | null;
  /** 🐟额: null without an account. */
  fish: { availableMinor: number; lockedMinor: number } | null;
  plus: boolean;
};

export type AdminUserDetail = AdminUserListItem & {
  counts: {
    authoredActivities: number;
    claims: number;
    registrations: number;
    merchants: number;
    paymentTasks: number;
  };
  /** As /me adds them: 大家领到的 of this person's 红包, and what they got. */
  amounts: { sent: string; received: string };
};

export type AdminUserSummary = AdminUserListItem & {
  provider?: string;
  updatedAt?: number;
};

export type AdminActivityListItem = {
  id: string;
  title: string;
  authorId: string;
  authorDisplayName: string;
  participationMode: "password" | "direct" | "code";
  rewardType: "ldc";
  paymentMode: "simulation" | "real" | null;
  lifecycle: AdminLifecycle;
  totalCount: number;
  claimedCount: number;
  registeredCount: number;
  drawState: string | null;
  topicId: string | null;
  postNumber: number;
  createdAt: number;
  openedAt: number | null;
  endedAt: number | null;
  archivedAt: number | null;
  /** As the sender's own lists read it (status, reward, draw). */
  summary: ActivitySummary;
  author: ActivityAuthor;
};

export type AdminActivityDetail = AdminActivityListItem & {
  updatedAt: number;
  deadline: number | null;
  endReason: string | null;
  drawClosedAt: number | null;
  drawPublishedAt: number | null;
  /** How many 口令 it has (never the 口令 themselves). */
  passwordCount: number;
  /**
   * 代码判定红包 (docs/programmable-hongbao-design.md §1): its code's
   * fingerprint, whether failing code paused it, and the 站长's 停用 (never
   * the code or anyone's input).
   */
  code?: {
    fingerprint: string;
    failuresInRow: number;
    pausedAt: number | null;
    stoppedAt: number | null;
    stoppedBy: string | null;
  };
  /** 附带网页 (docs/attached-page-design.md): its address and the 站长's 停用. */
  page?: {
    url: string;
    stoppedAt: number | null;
    stoppedBy: string | null;
  };
  payments: {
    total: number;
    pending: number;
    confirmed: number;
    attention: number;
    unknown: number;
  };
};

export type AdminActivitySummary = AdminActivityListItem;

export type AdminPaymentListItem = {
  id: string;
  source: "claim" | "acceptance" | "withdrawal";
  mode: "simulation" | "real";
  status: z.infer<typeof paymentStateSchema>;
  reason: string | null;
  unknownOutcome: boolean;
  amount: string;
  businessNo: string;
  externalOrderId: string | null;
  activityId: string | null;
  activityTitle: string | null;
  merchantId: string;
  merchantLabel: string | null;
  recipientId: string;
  recipientUsername: string | null;
  currentRecipientUsername: string | null;
  /** The recipient's account here, as it reads now. */
  recipientDisplayName: string | null;
  recipientAvatarUrl: string | null;
  createdAt: number;
  nextRunAt: number;
};

export type AdminPaymentAttempt = {
  id: string;
  operation: "send" | "query";
  purpose: "recovery" | "probe";
  outcome: string;
  reason: string | null;
  httpStatus: number | null;
  credentialVersion: number;
  startedAt: number;
  finishedAt: number | null;
};

export type AdminPaymentDetail = AdminPaymentListItem & {
  /** The merchant's Client ID now (the order may predate a change). */
  merchantClientId: string | null;
  claimId: string | null;
  acceptanceId: string | null;
  /** A 🐟额 转出's own record (source "withdrawal"). */
  withdrawalId: string | null;
  attemptCount: number;
  reconciliationCount: number;
  nextAction: "query" | "send" | "none";
  nextSendAt: number | null;
  nextQueryAt: number | null;
  sendBlockReason: string | null;
  orderObservedAt: number | null;
  orderEvidence: "receipt" | "query" | "duplicate" | null;
  sendAcknowledgedAt: number | null;
  confirmedAt: number | null;
  attempts: AdminPaymentAttempt[];
  nextAttemptsCursor: string | null;
};

export type AdminPaymentSummary = AdminPaymentListItem;

/** One payment for 网站管理: its own fields, and what its sender sees. */
export type AdminPaymentDetailResponse = {
  payment: AdminPaymentDetail;
  /** Null when the sender's view cannot be read for this row. */
  view: MerchantPaymentDetail | null;
  /** Paid to a winner of a timed draw. */
  draw: boolean;
};

export type AdminAuditEntry = {
  id: string;
  type: Exclude<z.infer<typeof adminAuditTypeSchema>, "all">;
  actorUserId: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  createdAt: number;
  previousVersion: number;
  nextVersion: number;
  before: Record<string, boolean | number>;
  after: Record<string, boolean | number>;
  /** code_stop, page_stop: the 红包 stopped. */
  activity?: { id: string; title: string };
  /** judge_square: what was done to which 判定器 (its name then). */
  judge?: {
    id: string;
    name: string;
    action:
      | "take_down"
      | "restore"
      | "feature"
      | "unfeature"
      | "move"
      | "version";
    reason: string | null;
    n: number | null;
  };
  /** roadmap: what was done to which 施工中 item (its title then). */
  roadmap?: {
    id: string;
    title: string;
    action:
      | "create"
      | "start"
      | "note"
      | "done"
      | "decline"
      | "back"
      | "merge"
      | "hide"
      | "unhide"
      | "edit";
    /** 不做's reason, the line written, or the title it went into. */
    reason: string | null;
  };
};

/** 判定器's 用量 (redesign/07 §10): what the 份 were used for. */
export type AdminJudgeUsageCounts = {
  /** 份: 判定器 by UTC day, as Cloudflare bills Dynamic Workers. */
  rows: number;
  /** 部署新版本 and 重新跑测试. */
  deploys: number;
  reruns: number;
  /** Claims judged (paid or not). */
  claims: number;
  timeouts: number;
  /** Of the timeouts, those that moved on to a fresh sandbox (换了实例). */
  switches: number;
  /** 联网: requests judgments sent out (§9.7). */
  fetches: number;
};

/**
 * 网站管理 · 判定器's 用量 (docs/programmable-hongbao-design.md §7): today
 * and this month (UTC, as billed), the estimate past the free allowance,
 * the last 30 days, and this month's top people and 红包.
 */
export type AdminJudgeUsage = {
  readAt: number;
  /** The UTC day ("2026-10-25") and its month ("2026-10"). */
  day: string;
  month: string;
  today: AdminJudgeUsageCounts;
  thisMonth: AdminJudgeUsageCounts;
  /** 份 free a month, and the price of each past them, in USD. */
  freeRows: number;
  pricePerRow: number;
  /** max(0, thisMonth.rows − freeRows) × pricePerRow, in USD. */
  estimatedCost: number;
  /** 每月判定器上限 (判定器设置). */
  monthlyLimit: number;
  /** The last 30 UTC days, oldest first, today last; none used counts 0. */
  days: { day: string; rows: number }[];
  /** 部署最多的人: new versions deployed this month, and 份 on them. */
  people: { user: ActivityAuthor; deploys: number; rows: number }[];
  /** 占用最多的红包: 份 this month, and claims judged this month. */
  hongbao: {
    activity: {
      id: string;
      title: string;
      author: ActivityAuthor;
      status: AdminLifecycle;
      /** 站长 stopped it (停用). */
      stopped?: true;
    };
    rows: number;
    judgments: number;
  }[];
};

const adminCursorValueSchema = z
  .string()
  .max(512)
  .regex(/^(\d{1,16}):([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/i)
  .refine((value) => Number.isSafeInteger(Number(value.split(":", 1)[0])));

const adminAuditCursorValueSchema = z
  .string()
  .max(512)
  .regex(
    /^(\d{1,16}):(attempt_rate_limits|balance_settings|code_stop|judge_settings|judge_square|page_stop):([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/,
  )
  .refine((value) => Number.isSafeInteger(Number(value.split(":", 1)[0])));

export const adminCursorSchema = adminCursorValueSchema.optional();
export const adminAuditCursorSchema = adminAuditCursorValueSchema.optional();
export const adminActivitiesQuerySchema = z.strictObject({
  q: z.string().trim().max(2048).optional(),
  cursor: adminCursorSchema,
  authorId: z.string().trim().min(1).max(128).optional(),
  rewardType: adminRewardTypeSchema.optional(),
  status: adminActivityStatusSchema.optional(),
  drawException: z.enum(["0", "1"]).optional(),
});
/** The sort it was made for, its one or two keys, then the id. */
const adminUserCursorSchema = z
  .string()
  .max(512)
  .regex(
    /^(created|login|idle|fish|level)(:-?\d{1,16}){1,2}:([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/i,
  )
  .optional();
export const adminUsersQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  cursor: adminUserCursorSchema,
  state: adminUserStateSchema.optional(),
  sort: adminUserSortSchema.optional(),
  /** Comma-separated, any of 0–4 and unknown: "2,3,unknown". */
  level: z
    .string()
    .regex(/^([0-4]|unknown)(,([0-4]|unknown)){0,5}$/)
    .transform((value) =>
      ADMIN_USER_LEVELS.filter((level) =>
        value.split(",").includes(String(level)),
      ),
    )
    .optional(),
  fish: adminUserFishSchema.optional(),
  login: adminUserLoginSchema.optional(),
});
export const adminPaymentsQuerySchema = z.strictObject({
  q: z.string().trim().max(2048).optional(),
  cursor: adminCursorSchema,
  authorId: z.string().trim().min(1).max(128).optional(),
  activityId: z.uuid().optional(),
  merchantId: z.uuid().optional(),
  recipientId: z.string().trim().min(1).max(64).optional(),
  /** The recipient's account here (either payment mode). */
  recipientUserId: z.string().trim().min(1).max(128).optional(),
  mode: adminPaymentModeSchema.optional(),
  status: adminPaymentStatusSchema.optional(),
  exception: z.enum(["0", "1"]).optional(),
  anomaly: adminPaymentAnomalySchema.optional(),
});
export const adminPaymentDetailQuerySchema = z.strictObject({
  attemptsCursor: adminCursorSchema,
});
export const adminAuditQuerySchema = z.strictObject({
  cursor: adminAuditCursorSchema,
  type: adminAuditTypeSchema.optional(),
  actor: z.string().trim().min(1).max(128).optional(),
  actorUserId: z.string().trim().min(1).max(128).optional(),
  from: z.coerce.number().int().safe().optional(),
  to: z.coerce.number().int().safe().optional(),
});

export { paymentModeSchema, paymentStateSchema };
