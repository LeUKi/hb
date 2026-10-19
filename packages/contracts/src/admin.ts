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
export const adminUserStateSchema = z.enum(["all", "active", "disabled"]);
export type AdminUserState = z.infer<typeof adminUserStateSchema>;
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
};

export type AdminUserDetail = AdminUserListItem & {
  counts: {
    authoredActivities: number;
    claims: number;
    registrations: number;
    merchants: number;
    paymentTasks: number;
  };
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
  participationMode: "password" | "direct";
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
    /^(\d{1,16}):(attempt_rate_limits|balance_settings):([A-Za-z0-9_-][A-Za-z0-9_-]{0,100}|[a-f0-9-]{36})$/,
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
export const adminUsersQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  cursor: adminCursorSchema,
  state: adminUserStateSchema.optional(),
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
