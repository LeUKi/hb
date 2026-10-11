import {
  type ActivityPaymentList,
  type ActivityPaymentSummary,
  type ActivityPaymentTargetList,
  type ActivityStatus,
  formatAmount,
} from "@hb/contracts";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { activityNotFound, invalidActivity } from "../activities/errors";
import {
  activityListFields,
  activityListStatusSql,
} from "../activities/history-query";
import { projectActivitySummary } from "../activities/service";
import { ownedActivity } from "../activities/storage";
import { createDb } from "../db/client";
import { activities, claims, paymentTasks, users } from "../db/schema";
import type { ApiBindings } from "../env";

type Status = "all" | Exclude<ActivityStatus, "draft">;
type TargetStatus = "all" | "pending" | "confirmed";
type Cursor = { time: number; id: string; scope: string };

function cursor(value: string | undefined, scope: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      !Number.isSafeInteger(parsed.time) ||
      typeof parsed.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(parsed.id) ||
      parsed.scope !== scope
    )
      invalidActivity("分页标识无效");
    return parsed;
  } catch {
    invalidActivity("分页标识无效");
  }
}

const totals = {
  pendingMinor: sql<number>`COALESCE(SUM(CASE WHEN ${paymentTasks.status} <> 'confirmed' THEN ${paymentTasks.amountMinor} ELSE 0 END), 0)`,
  confirmedMinor: sql<number>`COALESCE(SUM(CASE WHEN ${paymentTasks.status} = 'confirmed' THEN ${paymentTasks.amountMinor} ELSE 0 END), 0)`,
  pendingCount: sql<number>`SUM(CASE WHEN ${paymentTasks.status} <> 'confirmed' THEN 1 ELSE 0 END)`,
  confirmedCount: sql<number>`SUM(CASE WHEN ${paymentTasks.status} = 'confirmed' THEN 1 ELSE 0 END)`,
  totalCount: sql<number>`COUNT(*)`,
};

type Totals = {
  pendingMinor: number;
  confirmedMinor: number;
  pendingCount: number;
  confirmedCount: number;
  totalCount: number;
};
function summary(row?: Totals): ActivityPaymentSummary {
  const pending = Number(row?.pendingMinor ?? 0);
  const confirmed = Number(row?.confirmedMinor ?? 0);
  return {
    pendingAmount: formatAmount(pending),
    confirmedAmount: formatAmount(confirmed),
    totalAmount: formatAmount(pending + confirmed),
    pendingCount: Number(row?.pendingCount ?? 0),
    confirmedCount: Number(row?.confirmedCount ?? 0),
    totalCount: Number(row?.totalCount ?? 0),
  };
}

/** Open LDC activities remain selectable before their first payment target exists. */
export async function listPaymentActivities(
  env: ApiBindings,
  authorId: string,
  status: Status = "all",
  cursorValue?: string,
): Promise<ActivityPaymentList> {
  const scope = `payment-activities:${authorId}:${status}`;
  const before = cursor(cursorValue, scope);
  const db = createDb(env.DB);
  const base = and(
    eq(activities.authorId, authorId),
    eq(activities.rewardType, "ldc"),
    isNull(activities.deletedAt),
    isNotNull(activities.openedAt),
    isNotNull(activities.merchantId),
    status === "all" ? undefined : sql`${activityListStatusSql()} = ${status}`,
  );
  const count = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(activities)
    .where(base)
    .get();
  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        base,
        before
          ? or(
              lt(activities.createdAt, before.time),
              and(
                eq(activities.createdAt, before.time),
                lt(activities.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const summary = projectActivitySummary(row);
      return {
        ...summary,
        ...activityListFields(row, summary.status),
        merchantId: row.merchantId ?? activityNotFound(),
      };
    }),
    total: Number(count?.count ?? 0),
    nextCursor:
      rows.length > 20 && last
        ? btoa(JSON.stringify({ time: last.createdAt, id: last.id, scope }))
        : null,
  };
}

export async function listActivityPayments(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  status: TargetStatus = "all",
  cursorValue?: string,
): Promise<ActivityPaymentTargetList> {
  const activity = await ownedActivity(env, activityId, authorId);
  if (
    activity.rewardType !== "ldc" ||
    activity.openedAt === null ||
    !activity.merchantId
  )
    activityNotFound();
  const scope = `activity-payments:${authorId}:${activityId}:${status}`;
  const before = cursor(cursorValue, scope);
  const db = createDb(env.DB);
  const base = and(
    eq(claims.activityId, activityId),
    eq(paymentTasks.source, "claim"),
    eq(paymentTasks.merchantId, activity.merchantId),
  );
  const aggregate = await db
    .select(totals)
    .from(paymentTasks)
    .innerJoin(claims, eq(claims.id, paymentTasks.claimId))
    .where(base)
    .get();
  const amounts = summary(aggregate);
  const rows = await db
    .select({
      payment: paymentTasks,
      claimId: claims.id,
      recipientProfile: {
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        accountTier: sql<
          "standard" | "lite"
        >`CASE WHEN ${users.officialConnectVerified}=1 THEN 'standard' ELSE 'lite' END`,
      },
    })
    .from(paymentTasks)
    .innerJoin(claims, eq(claims.id, paymentTasks.claimId))
    .innerJoin(users, eq(users.id, claims.userId))
    .where(
      and(
        base,
        status === "all"
          ? undefined
          : status === "confirmed"
            ? eq(paymentTasks.status, "confirmed")
            : sql`${paymentTasks.status} <> 'confirmed'`,
        before
          ? or(
              lt(paymentTasks.createdAt, before.time),
              and(
                eq(paymentTasks.createdAt, before.time),
                lt(paymentTasks.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(paymentTasks.createdAt), desc(paymentTasks.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1)?.payment;
  return {
    activityId,
    merchantId: activity.merchantId,
    items: page.map(({ payment, claimId, recipientProfile }) => ({
      id: payment.id,
      mode: payment.mode,
      status: payment.status,
      reason: payment.reason,
      confirmedAt:
        payment.confirmedAt === null
          ? null
          : new Date(payment.confirmedAt).toISOString(),
      amount: formatAmount(payment.amountMinor),
      businessNo: payment.businessNo,
      externalOrderId: payment.externalOrderId,
      createdAt: new Date(payment.createdAt).toISOString(),
      nextRunAt: new Date(payment.nextRunAt).toISOString(),
      source: "claim",
      claimId,
      activityId,
      acceptanceId: null,
      recipientProfile,
    })),
    total:
      status === "all"
        ? amounts.totalCount
        : status === "confirmed"
          ? amounts.confirmedCount
          : amounts.pendingCount,
    summary: amounts,
    nextCursor:
      rows.length > 20 && last
        ? btoa(JSON.stringify({ time: last.createdAt, id: last.id, scope }))
        : null,
  };
}
