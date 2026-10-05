import {
  type ActivityInput,
  type AuthorClaimList,
  type ClaimDetail,
  type ClaimList,
  type ClaimSummary,
  formatAmount,
  type PublicRecipientList,
} from "@hb/contracts";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { createDb } from "../db/client";
import {
  activities,
  claims,
  paymentTasks,
  rewardInventory,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { activityNotFound, invalidActivity } from "./errors";
import { activityStatus } from "./service";
import {
  type ActivityRow,
  findActivity,
  ownedActivity,
  rewardAssociatedData,
} from "./storage";

type ClaimRow = typeof claims.$inferSelect;
type Cursor = { time: number; id: string };

function parseCursor(value?: string): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(atob(value)) as Cursor;
    if (
      !Number.isSafeInteger(parsed.time) ||
      typeof parsed.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(parsed.id)
    )
      invalidActivity("分页标识无效");
    return parsed;
  } catch {
    invalidActivity("分页标识无效");
  }
}

function encodeCursor(claim: ClaimRow) {
  return btoa(JSON.stringify({ time: claim.claimedAt, id: claim.id }));
}

function beforeCursor(cursor?: Cursor) {
  return cursor
    ? or(
        lt(claims.claimedAt, cursor.time),
        and(eq(claims.claimedAt, cursor.time), lt(claims.id, cursor.id)),
      )
    : undefined;
}

function summary(claim: ClaimRow, activity: ActivityRow): ClaimSummary {
  return {
    id: claim.id,
    activity: {
      id: activity.id,
      title: activity.title,
      status: activityStatus(activity),
    },
    rewardType: activity.rewardType,
    claimedAt: new Date(claim.claimedAt).toISOString(),
  };
}

export async function findUserClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const row = await createDb(env.DB)
    .select({ claim: claims })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.activityId, activityId),
        eq(claims.userId, userId),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  return row?.claim;
}

export async function getClaimDetail(
  env: ApiBindings,
  claimId: string,
  userId: string,
): Promise<ClaimDetail> {
  const row = await createDb(env.DB)
    .select({ claim: claims, activity: activities })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.userId, userId),
        isNull(activities.deletedAt),
      ),
    )
    .get();
  if (!row) activityNotFound();
  const config = JSON.parse(row.activity.config) as ActivityInput;
  return {
    ...summary(row.claim, row.activity),
    afterClaimInfo: config.afterClaimInfo,
    ...(await rewardDetail(env, row.claim, row.activity)),
  };
}

type RewardDetail =
  | Pick<Extract<ClaimDetail, { rewardType: "text" }>, "rewardType" | "text">
  | Pick<
      Extract<ClaimDetail, { rewardType: "ldc" }>,
      "rewardType" | "amount" | "payment"
    >;

async function rewardDetail(
  env: ApiBindings,
  claim: ClaimRow,
  activity: ActivityRow,
): Promise<RewardDetail> {
  if (activity.rewardType === "ldc") {
    const payment = await createDb(env.DB)
      .select()
      .from(paymentTasks)
      .where(eq(paymentTasks.claimId, claim.id))
      .get();
    if (!payment) throw new Error("LDC claim has no payment task");
    return {
      rewardType: "ldc",
      amount: formatAmount(payment.amountMinor),
      payment: {
        id: payment.id,
        mode: payment.mode,
        status: payment.status,
        reason: payment.reason,
        confirmedAt:
          payment.confirmedAt === null
            ? null
            : new Date(payment.confirmedAt).toISOString(),
      },
    };
  }
  const inventory = await createDb(env.DB)
    .select()
    .from(rewardInventory)
    .where(
      and(
        eq(rewardInventory.activityId, activity.id),
        eq(rewardInventory.id, claim.inventoryId),
      ),
    )
    .get();
  if (!inventory?.ciphertext || inventory.kind !== "text")
    throw new Error("Text claim has no private content");
  return {
    rewardType: "text",
    text: await decryptString(
      inventory.ciphertext,
      env,
      rewardAssociatedData(activity.id, claim.inventoryId),
    ),
  };
}

export async function getCurrentClaim(
  env: ApiBindings,
  activityId: string,
  userId: string,
) {
  const activity = await findActivity(env, activityId);
  if (!activity || (activity.openedAt === null && activity.authorId !== userId))
    activityNotFound();
  const claim = await findUserClaim(env, activityId, userId);
  return claim ? getClaimDetail(env, claim.id, userId) : null;
}

export async function listUserClaims(
  env: ApiBindings,
  userId: string,
  cursor?: string,
): Promise<ClaimList> {
  const rows = await createDb(env.DB)
    .select({ claim: claims, activity: activities })
    .from(claims)
    .innerJoin(activities, eq(activities.id, claims.activityId))
    .where(
      and(
        eq(claims.userId, userId),
        isNull(activities.deletedAt),
        beforeCursor(parseCursor(cursor)),
      ),
    )
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  return {
    items: page.map(({ claim, activity }) => summary(claim, activity)),
    nextCursor: rows.length > 20 && last ? encodeCursor(last.claim) : null,
  };
}

export async function listAuthorClaims(
  env: ApiBindings,
  activityId: string,
  authorId: string,
  cursor?: string,
): Promise<AuthorClaimList> {
  const activity = await ownedActivity(env, activityId, authorId);
  const rows = await createDb(env.DB)
    .select({
      claim: claims,
      claimant: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
    })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    .where(
      and(eq(claims.activityId, activityId), beforeCursor(parseCursor(cursor))),
    )
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  return {
    items: await Promise.all(
      page.map(async ({ claim, claimant }) => ({
        ...summary(claim, activity),
        claimant,
        ...(await rewardDetail(env, claim, activity)),
      })),
    ),
    nextCursor: rows.length > 20 && last ? encodeCursor(last.claim) : null,
  };
}

export async function listPublicRecipients(
  env: ApiBindings,
  activityId: string,
  viewerId?: string,
  cursor?: string,
): Promise<PublicRecipientList> {
  const activity = await findActivity(env, activityId);
  if (
    !activity ||
    (activity.openedAt === null && activity.authorId !== viewerId)
  )
    activityNotFound();
  const config = JSON.parse(activity.config) as ActivityInput;
  if (!config.showRecipientList)
    return { enabled: false, items: [], nextCursor: null };
  let before: Cursor | undefined;
  if (cursor) {
    try {
      before = parseCursor(
        await decryptString(atob(cursor), env, `recipients:${activityId}`),
      );
    } catch {
      invalidActivity("分页标识无效");
    }
  }
  const rows = await createDb(env.DB)
    .select({
      claim: claims,
      username: users.username,
      displayName: users.displayName,
      amountMinor: paymentTasks.amountMinor,
    })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    .leftJoin(paymentTasks, eq(paymentTasks.claimId, claims.id))
    .where(and(eq(claims.activityId, activityId), beforeCursor(before)))
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  return {
    enabled: true,
    items: page.map(({ claim, username, displayName, amountMinor }) => ({
      id: claim.id,
      username,
      displayName,
      ...(activity.rewardType === "ldc" && amountMinor !== null
        ? { amount: formatAmount(amountMinor) }
        : {}),
      claimedAt: new Date(claim.claimedAt).toISOString(),
    })),
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            await encryptString(
              encodeCursor(last.claim),
              env,
              `recipients:${activityId}`,
            ),
          )
        : null,
  };
}
