import {
  ARCHIVE_DELAY_MS,
  CLAIM_WINDOW_MS,
  type ClaimResult,
  DEFAULT_CLAIM_LIMIT,
  type DiscoveryCard,
  type DiscoveryList,
  type GlobalRedemptionInput,
  type GlobalRedemptionResult,
  type PublicActivity,
} from "@hb/contracts";
import { and, desc, eq, lt, or, type SQL, sql } from "drizzle-orm";
import { getClaimDetail } from "../activities/claim-queries";
import { ActivityError, activityConflict } from "../activities/errors";
import { databaseNow } from "../activities/lifecycle";
import { projectPublicActivity } from "../activities/service";
import type { ActivityRow } from "../activities/storage";
import { createDb } from "../db/client";
import {
  activities,
  claims,
  globalRedemptions,
  paymentTasks,
  redemptionSubmissions,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { digestPassword } from "../security/crypto";

type GlobalRow = typeof globalRedemptions.$inferSelect;
type Cursor = { scope: string; time: number; id: string };
const PAGE_SIZE = 20;

function invalidCursor(): never {
  throw new ActivityError(400, "INVALID_CURSOR", "分页标识无效");
}

function parseCursor(value: string | undefined, scope: string) {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(atob(value)) as Cursor;
    if (
      cursor.scope !== scope ||
      !Number.isSafeInteger(cursor.time) ||
      typeof cursor.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(cursor.id)
    )
      invalidCursor();
    return cursor;
  } catch {
    invalidCursor();
  }
}

// A delayed lifecycle sweep must not keep expired archives discoverable.
function discoverable(now: number) {
  return sql`${activities.openedAt} IS NOT NULL
    AND ${activities.deletedAt} IS NULL
    AND ${activities.archivedAt} IS NULL
    AND (COALESCE(${activities.endedAt}, ${activities.deadline}) IS NULL
      OR COALESCE(${activities.endedAt}, ${activities.deadline}) > ${now - ARCHIVE_DELAY_MS})`;
}

function card(
  row: ActivityRow,
  activityAuthor: PublicActivity["author"],
  myClaim: DiscoveryCard["myClaim"],
): DiscoveryCard {
  const {
    beforeInfo: _beforeInfo,
    afterEndInfo: _afterEndInfo,
    ...fields
  } = projectPublicActivity(row, activityAuthor);
  return { ...fields, myClaim };
}

async function list(
  env: ApiBindings,
  filter: SQL,
  scope: string,
  viewerId?: string,
  cursorValue?: string,
): Promise<DiscoveryList> {
  const cursor = parseCursor(cursorValue, scope);
  const rows = await createDb(env.DB)
    .select({
      activity: activities,
      author: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
      claimId: claims.id,
      paymentState: paymentTasks.status,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.authorId))
    .leftJoin(
      claims,
      viewerId
        ? and(eq(claims.activityId, activities.id), eq(claims.userId, viewerId))
        : sql`0`,
    )
    .leftJoin(paymentTasks, eq(paymentTasks.claimId, claims.id))
    .where(
      and(
        discoverable(Date.now()),
        filter,
        cursor
          ? or(
              lt(activities.openedAt, cursor.time),
              and(
                eq(activities.openedAt, cursor.time),
                lt(activities.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(activities.openedAt), desc(activities.id))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1)?.activity;
  return {
    items: page.map(({ activity, author, claimId, paymentState }) =>
      card(
        activity,
        author,
        claimId
          ? {
              id: claimId,
              ...(activity.rewardType === "ldc" && paymentState
                ? { paymentState }
                : {}),
            }
          : null,
      ),
    ),
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? btoa(JSON.stringify({ scope, time: last.openedAt, id: last.id }))
        : null,
  };
}

export function listSquare(
  env: ApiBindings,
  status: "all" | "active" | "ended",
  viewerId?: string,
  cursor?: string,
) {
  const now = Date.now();
  const state =
    status === "all"
      ? sql`1 = 1`
      : status === "active"
        ? sql`${activities.endedAt} IS NULL AND ${activities.deadline} > ${now} AND ${activities.claimedCount} < ${activities.totalCount}`
        : sql`(${activities.endedAt} IS NOT NULL OR ${activities.deadline} <= ${now} OR ${activities.claimedCount} >= ${activities.totalCount})`;
  return list(
    env,
    sql`${activities.joinSquare} = 1 AND ${state}`,
    `square:${status}`,
    viewerId,
    cursor,
  );
}

export function listTopic(
  env: ApiBindings,
  topicId: string,
  viewerId?: string,
  cursor?: string,
  postNumber = 1,
) {
  if (!/^[0-9]{1,19}$/.test(topicId) || BigInt(topicId) <= 0n)
    throw new ActivityError(400, "INVALID_TOPIC", "帖子标识无效");
  if (!Number.isSafeInteger(postNumber) || postNumber <= 0)
    throw new ActivityError(400, "INVALID_TOPIC", "回复楼层无效");
  const normalized = BigInt(topicId).toString();
  return list(
    env,
    sql`${activities.topicId} = ${normalized} AND ${activities.postNumber} = ${postNumber}`,
    `topic:${normalized}:${postNumber}`,
    viewerId,
    cursor,
  );
}

function globalLimit(env: ApiBindings) {
  const value = Number(env.GLOBAL_REDEMPTIONS_PER_MINUTE);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CLAIM_LIMIT;
}

export class GlobalRateLimitError extends ActivityError {
  constructor(public readonly retryAfter: number) {
    super(429, "GLOBAL_REDEMPTION_RATE_LIMITED", "提交过于频繁，请稍后重试");
  }
}

async function assertRateLimit(env: ApiBindings, userId: string) {
  const row =
    await env.DB.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest
    FROM global_redemptions WHERE user_id = ? AND created_at > ${databaseNow} - ?`)
      .bind(userId, CLAIM_WINDOW_MS)
      .first<{ count: number; oldest: number | null }>();
  if (row && row.count >= globalLimit(env))
    throw new GlobalRateLimitError(
      Math.max(
        1,
        Math.ceil(
          ((row.oldest ?? Date.now()) + CLAIM_WINDOW_MS - Date.now()) / 1000,
        ),
      ),
    );
}

async function findSubmission(
  env: ApiBindings,
  userId: string,
  submissionId: string,
) {
  return createDb(env.DB)
    .select()
    .from(globalRedemptions)
    .where(
      and(
        eq(globalRedemptions.userId, userId),
        eq(globalRedemptions.submissionId, submissionId),
      ),
    )
    .get();
}

function verifyFingerprint(row: GlobalRow, fingerprint: string) {
  if (row.fingerprint !== fingerprint)
    activityConflict("同一提交标识不能更换口令");
  return row;
}

async function prepare(
  env: ApiBindings,
  userId: string,
  input: GlobalRedemptionInput,
) {
  const [fingerprint, passwordDigest] = await Promise.all([
    digestPassword(
      `global-redemption:${input.password}`,
      env.PASSWORD_DIGEST_KEY,
    ),
    digestPassword(input.password, env.PASSWORD_DIGEST_KEY),
  ]);
  const previous = await findSubmission(env, userId, input.submissionId);
  if (previous) return verifyFingerprint(previous, fingerprint);
  await assertRateLimit(env, userId);
  try {
    // Snapshot selection and the rate guard share one write statement. A failed
    // NOT NULL guard aborts, including under concurrent submissions from Workers.
    await env.DB.prepare(`INSERT INTO global_redemptions
      (id, user_id, submission_id, fingerprint, password_digest, candidate_ids, claim_submission_id, created_at)
      SELECT ?, ?, ?, CASE WHEN (
        SELECT COUNT(*) FROM global_redemptions WHERE user_id = ? AND created_at > ${databaseNow} - ?
      ) < ? THEN ? ELSE NULL END, ?, (
        SELECT json_group_array(id) FROM (
          SELECT a.id FROM activity_passwords p JOIN activities a ON a.id = p.activity_id
          WHERE p.digest = ? AND a.deleted_at IS NULL AND a.opened_at IS NOT NULL AND a.force_dedicated = 0 AND a.archived_at IS NULL
            AND (COALESCE(a.ended_at, a.deadline) IS NULL OR COALESCE(a.ended_at, a.deadline) > ${databaseNow} - ?)
          ORDER BY a.opened_at DESC, a.id DESC
        )
      ), ?, ${databaseNow}`)
      .bind(
        crypto.randomUUID(),
        userId,
        input.submissionId,
        userId,
        CLAIM_WINDOW_MS,
        globalLimit(env),
        fingerprint,
        passwordDigest,
        passwordDigest,
        ARCHIVE_DELAY_MS,
        crypto.randomUUID(),
      )
      .run();
  } catch (error) {
    const winner = await findSubmission(env, userId, input.submissionId);
    if (winner) return verifyFingerprint(winner, fingerprint);
    await assertRateLimit(env, userId);
    throw error;
  }
  const row = await findSubmission(env, userId, input.submissionId);
  if (!row) throw new Error("Global redemption was not persisted");
  return row;
}

async function savedClaimResult(
  env: ApiBindings,
  row: GlobalRow,
): Promise<ClaimResult | undefined> {
  const submission = await createDb(env.DB)
    .select()
    .from(redemptionSubmissions)
    .where(
      and(
        eq(redemptionSubmissions.userId, row.userId),
        eq(redemptionSubmissions.submissionId, row.claimSubmissionId),
      ),
    )
    .get();
  if (!submission || submission.outcome === "pending") return undefined;
  if (submission.purpose !== "claim" || submission.outcome === "solved")
    throw new Error("Global redemption has an invalid claim submission");
  if (
    submission.outcome === "claimed" ||
    submission.outcome === "already_claimed"
  ) {
    if (!submission.claimId)
      throw new Error("Completed submission has no claim");
    return {
      result: submission.outcome,
      claim: await getClaimDetail(env, submission.claimId, row.userId),
    };
  }
  return { result: submission.outcome };
}

async function result(
  env: ApiBindings,
  row: GlobalRow,
  cursor?: string,
): Promise<GlobalRedemptionResult> {
  const ids = JSON.parse(row.candidateIds) as string[];
  const page = await list(
    env,
    sql`${activities.id} IN (SELECT value FROM json_each(${row.candidateIds}))`,
    `redemption:${row.id}`,
    row.userId,
    cursor,
  );
  const claimResult =
    ids.length === 1 ? await savedClaimResult(env, row) : undefined;
  return {
    id: row.id,
    // The original decision never changes when a refreshed list shrinks.
    result:
      ids.length === 0 ? "none" : ids.length === 1 ? "single" : "multiple",
    ...page,
    ...(ids.length === 1 ? { selectedActivityId: ids[0] } : {}),
    ...(claimResult ? { claimResult } : {}),
  };
}

export async function redeemGlobally(
  env: ApiBindings,
  userId: string,
  input: GlobalRedemptionInput,
): Promise<GlobalRedemptionResult> {
  const row = await prepare(env, userId, input);
  const ids = JSON.parse(row.candidateIds) as string[];
  if (ids.length === 1) {
    const id = ids[0];
    if (!id) throw new Error("Missing persisted candidate");
    const stub = env.ACTIVITY_DO.get(env.ACTIVITY_DO.idFromName(id));
    const response = await stub.fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          submissionId: row.claimSubmissionId,
          password: input.password,
        }),
      },
    );
    if (!response.ok) {
      const failure = (await response.json()) as {
        error: { code: string; message: string };
      };
      if (response.status === 429)
        throw new GlobalRateLimitError(
          Number(response.headers.get("Retry-After")) || 60,
        );
      throw new ActivityError(
        response.status === 403
          ? 403
          : response.status === 404
            ? 404
            : response.status === 400
              ? 400
              : response.status === 409
                ? 409
                : 503,
        failure.error.code,
        failure.error.message,
      );
    }
    const claimResult = (await response.json()) as ClaimResult;
    return { ...(await result(env, row)), claimResult };
  }
  return result(env, row);
}

export async function refreshGlobalResult(
  env: ApiBindings,
  id: string,
  userId: string,
  cursor?: string,
) {
  const row = await createDb(env.DB)
    .select()
    .from(globalRedemptions)
    .where(
      and(eq(globalRedemptions.id, id), eq(globalRedemptions.userId, userId)),
    )
    .get();
  if (!row)
    throw new ActivityError(404, "REDEMPTION_NOT_FOUND", "未找到兑换结果");
  return result(env, row, cursor);
}
