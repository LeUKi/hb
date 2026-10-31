import {
  type ActivityRewardFilter,
  ARCHIVE_DELAY_MS,
  type ClaimResult,
  type DiscoveryCard,
  type DiscoveryList,
  type GlobalRedemptionInput,
  type GlobalRedemptionResult,
  type PublicActivity,
} from "@hb/contracts";
import { and, asc, desc, eq, gt, lt, or, type SQL, sql } from "drizzle-orm";
import { getClaimDetail } from "../activities/claim-queries";
import { submissionPasswordMatched } from "../activities/claim-service";
import { registrationStatus } from "../activities/draw-storage";
import { ActivityError, activityConflict } from "../activities/errors";
import {
  activityListFields,
  activityListStatusSql,
  rewardFilterSql,
} from "../activities/history-query";
import { databaseNow } from "../activities/lifecycle";
import { getRegistrationDetail } from "../activities/registration-queries";
import { projectPublicActivity } from "../activities/service";
import { type ActivityRow, findActivity } from "../activities/storage";
import { readBalanceSettings } from "../balance/settings";
import { createDb } from "../db/client";
import {
  activities,
  activityRegistrations,
  claims,
  globalRedemptions,
  paymentTasks,
  redemptionSubmissions,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import { withPoolQuantities } from "../judge/ledger";
import {
  AttemptCooldownError,
  assertAttemptAllowed,
  attemptWriteStatements,
  readAttemptCooldown,
} from "../runtime/attempt-cooldown";
import { activityObject } from "../runtime/objects";
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

/**
 * 即将开放 (docs/scheduled-opening-design.md §7): drafts timed to open,
 * nearest first; nothing else of a draft is ever listed.
 */
function upcoming() {
  return sql`${activities.rewardType} = 'ldc'
    AND ${activities.openedAt} IS NULL
    AND ${activities.deletedAt} IS NULL
    AND ${activities.scheduledOpenAt} IS NOT NULL`;
}

// A delayed lifecycle sweep must not keep expired archives discoverable.
function discoverable(now: number) {
  return sql`${activities.rewardType} = 'ldc'
    AND ${activities.openedAt} IS NOT NULL
    AND ${activities.deletedAt} IS NULL
    AND ${activities.archivedAt} IS NULL
    AND (${activities.drawState} IN ('waiting', 'settling')
      OR COALESCE(${activities.endedAt}, ${activities.deadline}) IS NULL
      OR COALESCE(${activities.endedAt}, ${activities.deadline}) > ${now - ARCHIVE_DELAY_MS})`;
}

function card(
  row: ActivityRow,
  activityAuthor: PublicActivity["author"],
  myClaim: DiscoveryCard["myClaim"],
): DiscoveryCard {
  // Its 附带网页 stays, for the card's tag (the switch is the list's).
  const {
    beforeInfo: _beforeInfo,
    afterEndInfo: _afterEndInfo,
    ...fields
  } = projectPublicActivity(row, activityAuthor);
  return {
    ...fields,
    ...activityListFields(row, fields.status, fields.quantity.mode === "exact"),
    myClaim,
  };
}

async function list(
  env: ApiBindings,
  filter: SQL,
  scope: string,
  viewerId?: string,
  cursorValue?: string,
  /** Opened ones newest first; 即将开放 by its time, nearest first. */
  order: "opened" | "scheduled" = "opened",
): Promise<DiscoveryList> {
  const cursor = parseCursor(cursorValue, scope);
  const db = createDb(env.DB);
  const scheduled = order === "scheduled";
  const base = and(scheduled ? upcoming() : discoverable(Date.now()), filter);
  const count = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(activities)
    .where(base)
    .get();
  const rows = await db
    .select({
      activity: activities,
      author: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      claimId: claims.id,
      paymentState: paymentTasks.status,
      registrationId: activityRegistrations.id,
    })
    .from(activities)
    .innerJoin(users, eq(users.id, activities.authorId))
    // A guest has no claim or registration: looked up as nobody (""), by
    // the index. ON 0 read every claim for each 红包 listed.
    .leftJoin(
      claims,
      and(
        eq(claims.activityId, activities.id),
        eq(claims.userId, viewerId ?? ""),
      ),
    )
    .leftJoin(paymentTasks, eq(paymentTasks.claimId, claims.id))
    .leftJoin(
      activityRegistrations,
      and(
        eq(activityRegistrations.activityId, activities.id),
        eq(activityRegistrations.userId, viewerId ?? ""),
      ),
    )
    .where(
      and(
        base,
        cursor
          ? scheduled
            ? or(
                gt(activities.scheduledOpenAt, cursor.time),
                and(
                  eq(activities.scheduledOpenAt, cursor.time),
                  gt(activities.id, cursor.id),
                ),
              )
            : or(
                lt(activities.openedAt, cursor.time),
                and(
                  eq(activities.openedAt, cursor.time),
                  lt(activities.id, cursor.id),
                ),
              )
          : undefined,
      ),
    )
    .orderBy(
      ...(scheduled
        ? [asc(activities.scheduledOpenAt), asc(activities.id)]
        : [desc(activities.openedAt), desc(activities.id)]),
    )
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1)?.activity;
  const items = page.map(
    ({ activity, author, claimId, paymentState, registrationId }) => ({
      ...card(
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
      ...(activity.drawState
        ? {
            myRegistration: registrationId
              ? {
                  id: registrationId,
                  status: registrationStatus(activity, Boolean(claimId)),
                }
              : null,
          }
        : {}),
    }),
  );
  return {
    total: Number(count?.total ?? 0),
    items: await withPoolQuantities(env, await withPageSwitches(env, items)),
    nextCursor:
      rows.length > PAGE_SIZE && last
        ? btoa(
            JSON.stringify({
              scope,
              time: scheduled ? last.scheduledOpenAt : last.openedAt,
              id: last.id,
            }),
          )
        : null,
  };
}

/**
 * The cards' 附带网页 only while the switch is on: read once, and only for
 * a page of cards where one has one.
 */
async function withPageSwitches(env: ApiBindings, items: DiscoveryCard[]) {
  if (!items.some((item) => item.page)) return items;
  if ((await readBalanceSettings(env)).pageEnabled) return items;
  return items.map(({ page: _page, ...item }) => item);
}

export function listSquare(
  env: ApiBindings,
  status: "all" | "upcoming" | "active" | "ended",
  viewerId?: string,
  cursor?: string,
  type: ActivityRewardFilter = "all",
) {
  if (status === "upcoming")
    return list(
      env,
      sql`${activities.joinSquare} = 1 AND ${rewardFilterSql(type)}`,
      type === "all" ? "square:upcoming" : `square:upcoming:${type}`,
      viewerId,
      cursor,
      "scheduled",
    );
  const state =
    status === "all" ? sql`1 = 1` : sql`${activityListStatusSql()} = ${status}`;
  // Not the ones ended early, by their sender or the 站长 (07 §2): they
  // stay in 红包记录 and open by their link.
  const kept = sql`COALESCE(${activities.endReason}, '') NOT IN ('manual', 'stopped')`;
  return list(
    env,
    sql`${activities.joinSquare} = 1 AND ${kept} AND ${state} AND ${rewardFilterSql(type)}`,
    type === "all" ? `square:${status}` : `square:${status}:${type}`,
    viewerId,
    cursor,
  );
}

/**
 * 用它的红包 (judge-square §8): the 红包 a 判定器 opened that their senders
 * listed in 红包广场, as the 红包广场 lists them.
 */
export function listJudgeActivities(
  env: ApiBindings,
  judgeId: string,
  viewerId?: string,
  cursor?: string,
) {
  const kept = sql`COALESCE(${activities.endReason}, '') NOT IN ('manual', 'stopped')`;
  return list(
    env,
    sql`${activities.joinSquare} = 1 AND ${kept} AND ${activities.id} IN
      (SELECT activity_id FROM activity_code WHERE judge_id = ${judgeId})`,
    `judge:${judgeId}`,
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
  await assertAttemptAllowed(env, userId, "home");
  const rowId = crypto.randomUUID();
  try {
    await env.DB.batch([
      ...attemptWriteStatements(env, userId, "home", rowId),
      env.DB.prepare(`INSERT INTO global_redemptions
      (id, user_id, submission_id, fingerprint, password_digest, candidate_ids, claim_submission_id, created_at)
      SELECT ?, ?, ?, ?, ?, (
        SELECT json_group_array(id) FROM (
          SELECT a.id FROM activity_passwords p JOIN activities a ON a.id = p.activity_id
          WHERE p.digest = ? AND a.reward_type='ldc' AND a.participation_mode='password' AND a.deleted_at IS NULL AND a.opened_at IS NOT NULL AND a.force_dedicated = 0 AND a.archived_at IS NULL
            AND (COALESCE(a.ended_at, a.deadline) IS NULL OR COALESCE(a.ended_at, a.deadline) > ${databaseNow} - ?)
          ORDER BY a.opened_at DESC, a.id DESC
        )
      ), ?, ${databaseNow}`).bind(
        rowId,
        userId,
        input.submissionId,
        fingerprint,
        passwordDigest,
        passwordDigest,
        ARCHIVE_DELAY_MS,
        crypto.randomUUID(),
      ),
    ]);
  } catch (error) {
    const winner = await findSubmission(env, userId, input.submissionId);
    if (winner) return verifyFingerprint(winner, fingerprint);
    await assertAttemptAllowed(env, userId, "home");
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
  if (
    (submission.purpose !== "claim" && submission.purpose !== "register") ||
    submission.outcome === "solved"
  )
    throw new Error("Global redemption has an invalid claim submission");
  if (
    submission.outcome === "claimed" ||
    submission.outcome === "already_claimed"
  ) {
    if (!submission.claimId)
      throw new Error("Completed submission has no claim");
    return {
      result: submission.outcome,
      passwordMatched: submissionPasswordMatched(submission),
      claim: await getClaimDetail(env, submission.claimId, row.userId),
    };
  }
  if (
    submission.outcome === "registered" ||
    submission.outcome === "already_registered"
  ) {
    if (!submission.registrationId)
      throw new Error("Completed registration has no entry");
    return {
      result: submission.outcome,
      passwordMatched: submissionPasswordMatched(submission),
      registration: await getRegistrationDetail(
        env,
        submission.registrationId,
        row.userId,
      ),
    };
  }
  return {
    result: submission.outcome,
    passwordMatched: submissionPasswordMatched(submission),
  };
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
  const selectedCandidateId =
    row.selectedActivityId ?? (ids.length === 1 ? ids[0] : undefined);
  const selectedLdcId = selectedCandidateId
    ? (await findActivity(env, selectedCandidateId))?.id
    : undefined;
  if (row.selectedActivityId && !selectedLdcId)
    throw new ActivityError(404, "ACTIVITY_NOT_FOUND", "红包不存在或已结束");
  const claimResult = selectedLdcId
    ? await savedClaimResult(env, row)
    : undefined;
  return {
    id: row.id,
    claimSubmissionId: row.claimSubmissionId,
    attemptCooldown: await readAttemptCooldown(env, row.userId),
    // The original decision never changes when a refreshed list shrinks.
    result:
      ids.length === 0 ? "none" : ids.length === 1 ? "single" : "multiple",
    ...page,
    ...(selectedLdcId ? { selectedActivityId: selectedLdcId } : {}),
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
    if (!(await findActivity(env, id)))
      throw new ActivityError(404, "ACTIVITY_NOT_FOUND", "红包不存在或已结束");
    const stub = activityObject(env, id);
    const response = await stub.fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          submissionId: row.claimSubmissionId,
          password: input.password,
          discoveryId: row.id,
        }),
      },
    );
    if (!response.ok) {
      const failure = (await response.json()) as {
        error: { code: string; message: string };
        attemptCooldown?: import("@hb/contracts").AttemptCooldown;
      };
      if (response.status === 429)
        throw new AttemptCooldownError(
          failure.attemptCooldown ?? (await readAttemptCooldown(env, userId)),
          "home",
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

export async function discoverGlobalRedemption(
  env: ApiBindings,
  userId: string,
  input: GlobalRedemptionInput,
): Promise<Omit<GlobalRedemptionResult, "claimResult">> {
  const row = await prepare(env, userId, input);
  const { claimResult: _claimResult, ...discovery } = await result(env, row);
  return discovery;
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
    throw new ActivityError(404, "REDEMPTION_NOT_FOUND", "未找到查找结果");
  return result(env, row, cursor);
}
